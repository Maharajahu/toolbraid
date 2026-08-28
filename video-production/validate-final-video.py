#!/usr/bin/env python3
"""Validate the final ToolBraid challenge master and create a visual contact sheet."""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import av
import numpy as np
import pyloudnorm as pyln
from PIL import Image, ImageDraw, ImageFont
from scipy.signal import resample_poly


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = SCRIPT_DIR / "output" / "ToolBraid-WebMCP-Challenge-1080p.mp4"
DEFAULT_REPORT = SCRIPT_DIR / "work" / "final-video-validation.json"
DEFAULT_CONTACT_SHEET = SCRIPT_DIR / "work" / "final-video-contact-sheet.jpg"
EXPECTED_WIDTH = 1920
EXPECTED_HEIGHT = 1080
EXPECTED_FPS = 30.0
EXPECTED_DURATION = 162.0
EXPECTED_FRAMES = int(EXPECTED_DURATION * EXPECTED_FPS)
EXPECTED_SAMPLE_RATE = 48_000
FINAL_TRUE_PEAK_CEILING_DBTP = -1.0
SAMPLE_TIMES = (3.0, 12.0, 25.5, 41.0, 56.0, 72.0, 89.0, 105.0, 116.0, 130.0, 146.0, 159.0)


def peak_dbfs(audio: np.ndarray) -> float:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    return 20.0 * math.log10(max(peak, 1e-12))


def true_peak_dbfs(audio: np.ndarray) -> float:
    if not audio.size:
        return -240.0
    peak = 0.0
    block = EXPECTED_SAMPLE_RATE * 10
    for start in range(0, audio.shape[0], block):
        segment = audio[max(0, start - 64) : min(audio.shape[0], start + block + 64)]
        oversampled = resample_poly(segment, 4, 1, axis=0)
        peak = max(peak, float(np.max(np.abs(oversampled))))
    return 20.0 * math.log10(max(peak, 1e-12))


def frame_time(frame: av.VideoFrame, fallback_index: int) -> float:
    if frame.pts is not None and frame.time_base is not None:
        return float(frame.pts * frame.time_base)
    return fallback_index / EXPECTED_FPS


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    fonts = Path(r"C:\Windows\Fonts")
    candidates = ("seguisb.ttf", "arialbd.ttf") if bold else ("segoeui.ttf", "arial.ttf")
    for name in candidates:
        path = fonts / name
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def make_contact_sheet(samples: list[dict[str, object]], destination: Path) -> None:
    tile_width, tile_height = 480, 270
    label_height = 38
    header_height = 74
    canvas = Image.new("RGB", (tile_width * 4, header_height + (tile_height + label_height) * 3), "#020914")
    draw = ImageDraw.Draw(canvas)
    draw.text((28, 18), "ToolBraid final master — visual QC", fill="#F4FAFF", font=font(30, bold=True))
    draw.text((1515, 25), "1920×1080 · 30 FPS", fill="#63EFD1", font=font(19, bold=True))
    for index, sample in enumerate(samples):
        column, row = index % 4, index // 4
        x = column * tile_width
        y = header_height + row * (tile_height + label_height)
        frame = sample.pop("_image")
        assert isinstance(frame, Image.Image)
        canvas.paste(frame.resize((tile_width, tile_height), Image.Resampling.LANCZOS), (x, y))
        draw.rectangle((x, y + tile_height, x + tile_width, y + tile_height + label_height), fill="#071522")
        label = f"{float(sample['timestampSeconds']):06.2f}s  ·  mean {float(sample['lumaMean']):05.1f}  ·  detail {float(sample['lumaStdDev']):05.1f}"
        draw.text((x + 14, y + tile_height + 8), label, fill="#91A8BB", font=font(16))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, quality=92, subsampling=0)


def decode_video(path: Path) -> tuple[dict[str, object], list[dict[str, object]]]:
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        metadata: dict[str, object] = {
            "codec": stream.codec_context.name,
            "width": stream.codec_context.width,
            "height": stream.codec_context.height,
            "pixelFormat": stream.codec_context.pix_fmt,
            "averageRate": float(stream.average_rate or 0),
            "declaredFrames": stream.frames,
        }
        samples: list[dict[str, object]] = []
        targets = iter(SAMPLE_TIMES)
        target = next(targets, None)
        decoded_frames = 0
        last_timestamp = 0.0
        for frame in container.decode(stream):
            timestamp = frame_time(frame, decoded_frames)
            decoded_frames += 1
            last_timestamp = timestamp
            if target is not None and timestamp + (0.5 / EXPECTED_FPS) >= target:
                array = frame.to_ndarray(format="rgb24")
                luma = 0.2126 * array[..., 0] + 0.7152 * array[..., 1] + 0.0722 * array[..., 2]
                samples.append({
                    "timestampSeconds": round(timestamp, 3),
                    "lumaMean": round(float(np.mean(luma)), 3),
                    "lumaStdDev": round(float(np.std(luma)), 3),
                    "nearBlackPixelRatio": round(float(np.mean(luma < 4.0)), 6),
                    "_image": Image.fromarray(array, mode="RGB"),
                })
                target = next(targets, None)
        metadata["decodedFrames"] = decoded_frames
        metadata["lastFrameTimestampSeconds"] = round(last_timestamp, 6)
    return metadata, samples


def decode_audio(path: Path) -> tuple[dict[str, object], np.ndarray]:
    blocks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        source = {
            "codec": stream.codec_context.name,
            "sampleRate": stream.codec_context.sample_rate,
            "channels": stream.codec_context.channels,
            "layout": str(stream.codec_context.layout),
        }
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=EXPECTED_SAMPLE_RATE)
        for frame in container.decode(stream):
            for converted in resampler.resample(frame):
                blocks.append(converted.to_ndarray().astype(np.float32, copy=False))
        for converted in resampler.resample(None):
            blocks.append(converted.to_ndarray().astype(np.float32, copy=False))
    if not blocks:
        raise RuntimeError("No audio samples decoded")
    audio = np.concatenate(blocks, axis=1).T
    meter = pyln.Meter(EXPECTED_SAMPLE_RATE, block_size=0.400)
    source.update({
        "decodedSamplesPerChannel": int(audio.shape[0]),
        "decodedDurationSeconds": round(audio.shape[0] / EXPECTED_SAMPLE_RATE, 6),
        "integratedLufs": round(float(meter.integrated_loudness(audio)), 3),
        "samplePeakDbfs": round(peak_dbfs(audio), 3),
        "truePeakEstimateDbtp": round(true_peak_dbfs(audio), 3),
    })
    return source, audio


def validate(path: Path, report_path: Path, contact_sheet_path: Path) -> dict[str, object]:
    if not path.exists():
        raise FileNotFoundError(path)
    with av.open(str(path)) as container:
        duration = float(container.duration or 0) / float(av.time_base)
        format_name = container.format.name
        stream_types = [stream.type for stream in container.streams]

    video, samples = decode_video(path)
    audio, _ = decode_audio(path)
    make_contact_sheet(samples, contact_sheet_path)

    checks = {
        "containerIsMp4": "mp4" in format_name,
        "hasOneVideoAndOneAudioStream": stream_types.count("video") == 1 and stream_types.count("audio") == 1,
        "durationIs162Seconds": abs(duration - EXPECTED_DURATION) <= 0.05,
        "videoIs1920x1080": (video["width"], video["height"]) == (EXPECTED_WIDTH, EXPECTED_HEIGHT),
        "videoIs30Fps": abs(float(video["averageRate"]) - EXPECTED_FPS) < 0.001,
        "videoIsH264": video["codec"] == "h264",
        "videoIsYuv420p": video["pixelFormat"] == "yuv420p",
        "decodedAll4860Frames": video["decodedFrames"] == EXPECTED_FRAMES,
        "audioIsAac": audio["codec"] == "aac",
        "audioIs48kStereo": audio["sampleRate"] == EXPECTED_SAMPLE_RATE and audio["channels"] == 2,
        "audioDurationMatchesVideo": abs(float(audio["decodedDurationSeconds"]) - duration) <= 0.05,
        "audioIsAudible": float(audio["integratedLufs"]) > -24.0,
        "audioTruePeakWithinCeiling": (
            float(audio["truePeakEstimateDbtp"]) <= FINAL_TRUE_PEAK_CEILING_DBTP
        ),
        "allVisualSamplesPresent": len(samples) == len(SAMPLE_TIMES),
        "noBlankSampledFrames": all(
            float(sample["lumaMean"]) > 3.0 and float(sample["lumaStdDev"]) > 3.0
            for sample in samples
        ),
    }
    failures = [name for name, passed in checks.items() if not passed]
    report: dict[str, object] = {
        "format": "toolbraid-final-video-validation-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if not failures else "FAIL",
        "input": str(path.resolve()),
        "bytes": path.stat().st_size,
        "container": {"format": format_name, "durationSeconds": round(duration, 6), "streamTypes": stream_types},
        "video": video,
        "audio": audio,
        "visualSamples": samples,
        "contactSheet": str(contact_sheet_path.resolve()),
        "checks": checks,
        "failures": failures,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    parser.add_argument("--contact-sheet", default=str(DEFAULT_CONTACT_SHEET))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = validate(Path(args.input).resolve(), Path(args.report).resolve(), Path(args.contact_sheet).resolve())
    print(json.dumps({
        "status": report["status"],
        "input": report["input"],
        "durationSeconds": report["container"]["durationSeconds"],
        "decodedFrames": report["video"]["decodedFrames"],
        "integratedLufs": report["audio"]["integratedLufs"],
        "truePeakEstimateDbtp": report["audio"]["truePeakEstimateDbtp"],
        "contactSheet": report["contactSheet"],
        "failures": report["failures"],
    }, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
