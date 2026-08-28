#!/usr/bin/env python3
"""Generate a fluid multi-passage ToolBraid narration with local IndexTTS 2.5.

The owner-authorized reference voice never leaves this machine. The narration
is generated as three long causal passages and joined with a short equal-power
crossfade: no scene windows, no time-stretching, and no fixed waits for visuals.
"""
from __future__ import annotations

import gc
import hashlib
import json
import math
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import librosa
import numpy as np
import pyloudnorm as pyln
import soundfile as sf
import torch
from scipy.signal import resample_poly


ROOT = Path(__file__).resolve().parents[1]
VIDEO_DIR = ROOT / "video-production"
WORK_DIR = VIDEO_DIR / "work"
PRIVATE_DIR = ROOT / ".private" / "voice"
INDEXTTS_DIR = VIDEO_DIR / "models" / "index-tts-src"
CHECKPOINT_DIR = INDEXTTS_DIR / "checkpoints"

REFERENCE_AUDIO = PRIVATE_DIR / "reference-11s-mono-24k.wav"
RAW_OUTPUT = WORK_DIR / "narration-indextts25-raw.wav"
PREMASTER_OUTPUT = WORK_DIR / "narration-master.wav"
REPORT_OUTPUT = WORK_DIR / "indextts25-generation-report.json"

INDEXTTS_CODE_REVISION = "ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c"
INDEXTTS_MODEL_REVISION = "c39ce5ba981572cb187443877ff559dfb246ce63"
PINNED_CHECKPOINT_FILES = ("config.yaml", "gpt.pth", "codec.pth", "s2mel.pth")
SEED = 20_260_828_25
OUTPUT_SAMPLE_RATE = 48_000
PREMASTER_PEAK_DBFS = -6.0
CROSSFADE_MILLISECONDS = 120
MIN_DURATION_SECONDS = 60.0
MAX_DURATION_SECONDS = 67.0
MAX_REPAIRABLE_SOURCE_CLIPPING_SAMPLES = 256
MAX_PAUSES_750MS = 1
MAX_PAUSES_1500MS = 0

PASSAGES = (
    (
        "I start one real mission on ToolBraid's public deployment. Six independent "
        "origins return nine native tools, and one suspicious tool is immediately "
        "quarantined. Its metadata tries to bypass approval, so ToolBraid excludes it "
        "before scoring or planning. The remaining contracts use different names and "
        "schemas, but map into one canonical capability graph without hiding their origins."
    ),
    (
        "Now four safe checks run in parallel without changing state. When a primary "
        "health query fails, only a compatible non-mutating fallback may continue. "
        "With evidence assembled, "
        "ToolBraid pauses at an exact-effect review that shows each origin, tool, argument, "
        "risk, and expiry. I approve recovery first; publication stays locked under its "
        "own single-use scope."
    ),
    (
        "Then I approve publication separately. ToolBraid keeps execution disabled while "
        "the browser verifies both single-use scopes. Once the confirmation clears, I execute. "
        "The browser claims the approved scopes atomically, restores release eighteen "
        "forty-one, publishes revision nine, and records both receipts. Finally, a verified "
        "audit chain records fifty-four events and seals them with S H A two fifty-six. "
        "The agent prepared "
        "everything; the human remained final. That is the boundary ToolBraid enforces."
    ),
)
NARRATION_TEXT = " ".join(PASSAGES)

# [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
# A small amount of warmth and discovery keeps the delivery conversational while
# calm remains dominant. The vector is deterministic and deliberately restrained.
EMOTION_VECTOR = [0.10, 0.0, 0.0, 0.0, 0.0, 0.0, 0.06, 0.50]
EMOTION_ALPHA = 0.72
GENERATION = {
    "lang": "EN",
    "durationFactor": 0.98,
    "maxTextTokensPerSegment": 240,
    "intervalSilenceMs": 100,
    "doSample": True,
    "topP": 0.8,
    "topK": 30,
    "temperature": 0.72,
    "numBeams": 3,
    "repetitionPenalty": 10.0,
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_revision(path: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        text=True,
    ).strip()


def verify_checkpoint_revision() -> dict[str, str]:
    metadata_root = CHECKPOINT_DIR / ".cache" / "huggingface" / "download"
    verified: dict[str, str] = {}
    for filename in PINNED_CHECKPOINT_FILES:
        checkpoint = CHECKPOINT_DIR / filename
        metadata = metadata_root / f"{filename}.metadata"
        if not checkpoint.is_file() or not metadata.is_file():
            raise FileNotFoundError(
                f"Pinned checkpoint or Hugging Face provenance is missing: {filename}"
            )
        lines = metadata.read_text(encoding="utf-8").splitlines()
        if not lines or lines[0].strip() != INDEXTTS_MODEL_REVISION:
            actual = lines[0].strip() if lines else "missing"
            raise RuntimeError(
                f"Checkpoint {filename} came from revision {actual}, "
                f"expected {INDEXTTS_MODEL_REVISION}"
            )
        verified[filename] = lines[0].strip()
    return verified


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def trim_and_resample(path: Path) -> tuple[np.ndarray, dict[str, float | int]]:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    source_clipping_samples = int(np.count_nonzero(np.abs(audio) >= 0.999))
    source_duration = len(audio) / sample_rate
    mono = np.mean(audio, axis=1, dtype=np.float64)
    _, bounds = librosa.effects.trim(
        mono,
        top_db=48,
        frame_length=2048,
        hop_length=256,
    )
    margin = round(0.08 * sample_rate)
    left = max(0, int(bounds[0]) - margin)
    right = min(len(mono), int(bounds[1]) + margin)
    mono = mono[left:right]
    if sample_rate != OUTPUT_SAMPLE_RATE:
        divisor = math.gcd(sample_rate, OUTPUT_SAMPLE_RATE)
        mono = resample_poly(
            mono,
            OUTPUT_SAMPLE_RATE // divisor,
            sample_rate // divisor,
        )
    mono = np.asarray(mono, dtype=np.float32)
    mono -= float(np.mean(mono))
    return mono, {
        "sourceDurationSeconds": round(source_duration, 3),
        "trimmedDurationSeconds": round(len(mono) / OUTPUT_SAMPLE_RATE, 3),
        "sourceSampleRate": sample_rate,
        "sourceChannels": int(audio.shape[1]),
        "sourceClippingSamples": source_clipping_samples,
    }


def equal_power_join(segments: list[np.ndarray]) -> tuple[np.ndarray, list[dict[str, float | int]]]:
    if not segments:
        raise ValueError("At least one narration passage is required")
    crossfade_samples = round(CROSSFADE_MILLISECONDS * OUTPUT_SAMPLE_RATE / 1000)
    joined = np.asarray(segments[0], dtype=np.float32).copy()
    placements: list[dict[str, float | int]] = [
        {
            "segment": 1,
            "startSeconds": 0.0,
            "endSeconds": round(len(joined) / OUTPUT_SAMPLE_RATE, 6),
            "crossfadeInMilliseconds": 0,
        }
    ]
    for index, segment in enumerate(segments[1:], 2):
        segment = np.asarray(segment, dtype=np.float32)
        overlap = min(crossfade_samples, len(joined), len(segment))
        if overlap < round(0.08 * OUTPUT_SAMPLE_RATE):
            raise RuntimeError(f"Passage {index} is too short for the locked crossfade")
        start_sample = len(joined) - overlap
        phase = np.linspace(0.0, math.pi / 2.0, overlap, endpoint=True)
        fade_out = np.cos(phase).astype(np.float32)
        fade_in = np.sin(phase).astype(np.float32)
        blended = joined[-overlap:] * fade_out + segment[:overlap] * fade_in
        joined = np.concatenate((joined[:-overlap], blended, segment[overlap:]))
        placements.append(
            {
                "segment": index,
                "startSeconds": round(start_sample / OUTPUT_SAMPLE_RATE, 6),
                "endSeconds": round(len(joined) / OUTPUT_SAMPLE_RATE, 6),
                "crossfadeInMilliseconds": round(overlap * 1000 / OUTPUT_SAMPLE_RATE),
            }
        )
    return joined, placements


def build_premaster(mono: np.ndarray) -> np.ndarray:
    mono = np.asarray(mono, dtype=np.float32).copy()
    peak = float(np.max(np.abs(mono))) if len(mono) else 0.0
    if peak > 0.0:
        mono *= np.float32((10.0 ** (PREMASTER_PEAK_DBFS / 20.0)) / peak)
    fade_samples = min(round(0.015 * OUTPUT_SAMPLE_RATE), len(mono) // 2)
    if fade_samples:
        phase = np.linspace(0.0, math.pi / 2.0, fade_samples, endpoint=True)
        fade = (np.sin(phase) ** 2).astype(np.float32)
        mono[:fade_samples] *= fade
        mono[-fade_samples:] *= fade[::-1]
    return np.column_stack((mono, mono)).astype(np.float32)


def pause_metrics(audio: np.ndarray) -> dict[str, float | int]:
    mono = np.mean(audio, axis=1, dtype=np.float64)
    frame_seconds = 0.02
    frame_samples = round(frame_seconds * OUTPUT_SAMPLE_RATE)
    frame_count = len(mono) // frame_samples
    framed = mono[: frame_count * frame_samples].reshape(frame_count, frame_samples)
    rms = np.sqrt(np.mean(framed * framed, axis=1) + 1e-15)
    silent = 20.0 * np.log10(rms + 1e-12) < -45.0
    padded = np.pad(silent.astype(np.int8), (1, 1))
    edges = np.diff(padded)
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    internal = [
        (end - start) * frame_seconds
        for start, end in zip(starts, ends, strict=True)
        if start > 0 and end < len(silent)
    ]
    return {
        "silenceThresholdDbfs": -45.0,
        "silenceRatio": round(float(np.mean(silent)), 4),
        "speechDutyCycle": round(float(np.mean(~silent)), 4),
        "internalPauseCount": len(internal),
        "pausesAtLeast750ms": int(sum(value >= 0.75 for value in internal)),
        "pausesAtLeast1500ms": int(sum(value >= 1.5 for value in internal)),
        "longestInternalPauseSeconds": round(max(internal, default=0.0), 3),
    }


def basic_metrics(audio: np.ndarray) -> dict[str, float | int]:
    mono = np.mean(audio, axis=1, dtype=np.float64)
    meter = pyln.Meter(OUTPUT_SAMPLE_RATE)
    peak = float(np.max(np.abs(mono))) if len(mono) else 0.0
    return {
        "durationSeconds": round(len(mono) / OUTPUT_SAMPLE_RATE, 3),
        "sampleRate": OUTPUT_SAMPLE_RATE,
        "channels": int(audio.shape[1]),
        "integratedLufs": round(float(meter.integrated_loudness(mono)), 3),
        "samplePeakDbfs": round(20.0 * math.log10(max(peak, 1e-12)), 3),
        "clippingSamples": int(np.count_nonzero(np.abs(audio) >= 0.999)),
        **pause_metrics(audio),
    }


def main() -> int:
    for required in (
        REFERENCE_AUDIO,
        CHECKPOINT_DIR / "config.yaml",
        CHECKPOINT_DIR / "gpt.pth",
        CHECKPOINT_DIR / "codec.pth",
        CHECKPOINT_DIR / "s2mel.pth",
    ):
        if not required.is_file():
            raise FileNotFoundError(required)
    revision = git_revision(INDEXTTS_DIR)
    if revision != INDEXTTS_CODE_REVISION:
        raise RuntimeError(f"Unexpected IndexTTS revision: {revision}")
    checkpoint_revisions = verify_checkpoint_revision()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the locked IndexTTS narration run.")

    sys.path.insert(0, str(INDEXTTS_DIR))
    from indextts.infer_v2_5 import IndexTTS2

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    tts = IndexTTS2(
        cfg_path=str(CHECKPOINT_DIR / "config.yaml"),
        model_dir=str(CHECKPOINT_DIR),
        use_bf16=True,
        use_qwen_emo=False,
    )
    prepared_segments: list[np.ndarray] = []
    segment_reports: list[dict] = []
    for index, passage in enumerate(PASSAGES, 1):
        segment_seed = SEED + index * 1009
        seed_everything(segment_seed)
        segment_path = WORK_DIR / f"narration-indextts25-segment-{index:02d}-raw.wav"
        segment_started = time.perf_counter()
        tts.infer(
            spk_audio_prompt=str(REFERENCE_AUDIO),
            text=passage,
            output_path=str(segment_path),
            lang=GENERATION["lang"],
            emo_vector=EMOTION_VECTOR,
            emo_alpha=EMOTION_ALPHA,
            use_random=False,
            interval_silence=GENERATION["intervalSilenceMs"],
            max_text_tokens_per_segment=GENERATION["maxTextTokensPerSegment"],
            duration_factor=GENERATION["durationFactor"],
            text_normalization=True,
            verbose=True,
            do_sample=GENERATION["doSample"],
            top_p=GENERATION["topP"],
            top_k=GENERATION["topK"],
            temperature=GENERATION["temperature"],
            num_beams=GENERATION["numBeams"],
            repetition_penalty=GENERATION["repetitionPenalty"],
        )
        if not segment_path.is_file():
            raise RuntimeError(f"IndexTTS did not create passage {index}: {segment_path}")
        prepared, source_metrics = trim_and_resample(segment_path)
        prepared_segments.append(prepared)
        segment_reports.append(
            {
                "segment": index,
                "text": passage,
                "wordCount": len(passage.split()),
                "seed": segment_seed,
                "rawPath": str(segment_path.relative_to(ROOT)),
                "rawSha256": sha256_file(segment_path),
                **source_metrics,
                "generationSeconds": round(time.perf_counter() - segment_started, 3),
            }
        )

    stitched, placements = equal_power_join(prepared_segments)
    stitched_stereo = np.column_stack((stitched, stitched)).astype(np.float32)
    sf.write(RAW_OUTPUT, stitched_stereo, OUTPUT_SAMPLE_RATE, subtype="FLOAT")
    premaster = build_premaster(stitched)
    sf.write(PREMASTER_OUTPUT, premaster, OUTPUT_SAMPLE_RATE, subtype="PCM_24")
    metrics = basic_metrics(premaster)
    for segment, placement in zip(segment_reports, placements, strict=True):
        segment["placement"] = placement
    duration_pass = MIN_DURATION_SECONDS <= float(metrics["durationSeconds"]) <= MAX_DURATION_SECONDS
    pauses_pass = (
        int(metrics["pausesAtLeast750ms"]) <= MAX_PAUSES_750MS
        and int(metrics["pausesAtLeast1500ms"]) <= MAX_PAUSES_1500MS
    )
    raw_source_clipping = sum(
        int(segment["sourceClippingSamples"]) for segment in segment_reports
    )
    raw_clipping_repairable = raw_source_clipping <= MAX_REPAIRABLE_SOURCE_CLIPPING_SAMPLES
    status = (
        "PASS_REQUIRES_DECLIP" if raw_source_clipping else "PASS"
    ) if (
        metrics["clippingSamples"] == 0
        and duration_pass
        and pauses_pass
        and raw_clipping_repairable
    ) else "FAIL"
    report = {
        "schemaVersion": "toolbraid-indextts25-generation-v2",
        "status": status,
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "privacy": {
            "generationMode": "local-only",
            "referenceUploaded": False,
            "referenceAudioSha256": sha256_file(REFERENCE_AUDIO),
        },
        "engine": {
            "name": "IndexTTS 2.5",
            "codeRevision": revision,
            "modelRevision": INDEXTTS_MODEL_REVISION,
            "checkpointRevisionEvidence": checkpoint_revisions,
            "precision": "BF16",
            "device": torch.cuda.get_device_name(0),
            "seed": SEED,
            "emotionVector": EMOTION_VECTOR,
            "emotionAlpha": EMOTION_ALPHA,
            "generation": GENERATION,
        },
        "narration": {
            "text": NARRATION_TEXT,
            "wordCount": len(NARRATION_TEXT.split()),
            "structure": "three-long-causal-passages-equal-power-crossfade",
            "passageCount": len(PASSAGES),
            "crossfadeMilliseconds": CROSSFADE_MILLISECONDS,
            "sceneWindows": False,
            "timeStretch": False,
            "fixedWaits": False,
        },
        "segments": segment_reports,
        "qualityGates": {
            "minimumDurationSeconds": MIN_DURATION_SECONDS,
            "maximumDurationSeconds": MAX_DURATION_SECONDS,
            "maximumPausesAtLeast750ms": MAX_PAUSES_750MS,
            "maximumPausesAtLeast1500ms": MAX_PAUSES_1500MS,
            "maximumRepairableSourceClippingSamples": MAX_REPAIRABLE_SOURCE_CLIPPING_SAMPLES,
            "durationPass": duration_pass,
            "pausesPass": pauses_pass,
            "rawSourceClippingRepairable": raw_clipping_repairable,
            "premiumDeclipRequired": raw_source_clipping > 0,
        },
        "outputs": {
            "raw": str(RAW_OUTPUT.relative_to(ROOT)),
            "rawSha256": sha256_file(RAW_OUTPUT),
            "rawSourceClippingSamples": raw_source_clipping,
            "premaster": str(PREMASTER_OUTPUT.relative_to(ROOT)),
            "premasterSha256": sha256_file(PREMASTER_OUTPUT),
            "metrics": metrics,
        },
        "elapsedSeconds": round(time.perf_counter() - started, 3),
    }
    REPORT_OUTPUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))

    del tts
    gc.collect()
    torch.cuda.empty_cache()
    return 0 if report["status"] in {"PASS", "PASS_REQUIRES_DECLIP"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
