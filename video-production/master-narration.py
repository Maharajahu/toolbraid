#!/usr/bin/env python3
"""Master the final ToolBraid narration to a conservative video voice target.

The default input and output are kept inside ``video-production/work``.  The
premium path uses FabFilter Pro-L 2 through Spotify Pedalboard, calibrated in
two passes to approximately -16 LUFS with a -1 dBTP ceiling.  If that VST3
cannot be loaded, the script records the failure and uses a deliberately
simple, safe limiter fallback.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy.signal import resample_poly

try:
    import pedalboard
    from pedalboard import Pedalboard, load_plugin
except ImportError:  # pragma: no cover - exercised only on an incomplete host
    pedalboard = None
    Pedalboard = load_plugin = None


ROOT = Path(__file__).resolve().parents[1]
VIDEO_DIR = ROOT / "video-production"
DEFAULT_INPUT = VIDEO_DIR / "work" / "narration-master.wav"
DEFAULT_OUTPUT = VIDEO_DIR / "work" / "narration-master-final.wav"
DEFAULT_REPORT = VIDEO_DIR / "work" / "audio-mastering-report.json"
DEFAULT_RENDER_CONFIG = VIDEO_DIR / "render-config.json"

PRO_Q_4 = Path(
    r"C:\Program Files\Common Files\VST3\FabFilter\FabFilter Pro-Q 4.vst3"
)
PRO_DS = Path(
    r"C:\Program Files\Common Files\VST3\FabFilter\FabFilter Pro-DS.vst3"
)
RX_DE_CLIP = Path(
    r"C:\Program Files\Common Files\VST3\iZotope\RX 12 De-clip.vst3"
)
SOOTHE_2 = Path(
    r"C:\Program Files\Common Files\VST3\oeksound\soothe2_x64.vst3"
)
PRO_L_2 = Path(
    r"C:\Program Files\Common Files\VST3\FabFilter\FabFilter Pro-L 2.vst3"
)
EXPECTED_SAMPLE_RATE = 48_000
EXPECTED_CHANNELS = 2
DEFAULT_TARGET_LUFS = -16.0
DEFAULT_CEILING_DBFS = -1.0
MAX_TOTAL_GAIN_DB = 24.0
LOUDNESS_TOLERANCE_LU = 0.75


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def seal_render_config(
    config_path: Path,
    input_path: Path,
    output_path: Path,
    source_sha256: str,
    mastered_sha256: str,
) -> dict[str, Any]:
    """Atomically lock a successful source/master hash pair into render config."""

    config_path = config_path.resolve()
    if not config_path.is_file():
        raise FileNotFoundError(config_path)
    original = config_path.read_bytes().decode("utf-8")
    payload = json.loads(original)
    inputs = payload.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError(f"Render config has no inputs object: {config_path}")
    configured_source = (config_path.parent / str(inputs.get("narration", ""))).resolve()
    configured_mastered = (config_path.parent / str(inputs.get("narrationFinal", ""))).resolve()
    if configured_source != input_path.resolve():
        raise ValueError(
            f"Render config narration path {configured_source} does not match mastered input {input_path.resolve()}"
        )
    if configured_mastered != output_path.resolve():
        raise ValueError(
            f"Render config narrationFinal path {configured_mastered} does not match mastered output {output_path.resolve()}"
        )

    provenance_pattern = re.compile(
        r'("narrationProvenance"\s*:\s*\{\s*"sourceSha256"\s*:\s*")'
        r'[0-9a-fA-F]{64}'
        r'("\s*,\s*"masteredSha256"\s*:\s*")'
        r'[0-9a-fA-F]{64}'
        r'("\s*\})'
    )
    sealed, replacement_count = provenance_pattern.subn(
        lambda match: (
            f"{match.group(1)}{source_sha256}"
            f"{match.group(2)}{mastered_sha256}{match.group(3)}"
        ),
        original,
    )
    if replacement_count != 1:
        raise ValueError(
            "Render config must contain exactly one narrationProvenance object with "
            "sourceSha256 followed by masteredSha256."
        )
    staged = config_path.with_name(f".{config_path.name}.sealing-{os.getpid()}.tmp")
    try:
        staged.write_bytes(sealed.encode("utf-8"))
        staged.replace(config_path)
    finally:
        staged.unlink(missing_ok=True)
    return {
        "path": str(config_path),
        "sourceSha256": source_sha256,
        "masteredSha256": mastered_sha256,
        "configSha256": sha256_file(config_path),
        "atomicReplace": True,
    }


def db_to_gain(value_db: float) -> float:
    return 10.0 ** (value_db / 20.0)


def peak_dbfs(audio: np.ndarray) -> float:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    return 20.0 * math.log10(max(peak, 1e-12))


def true_peak_dbfs(audio: np.ndarray, oversample: int = 4) -> float:
    """Estimate inter-sample peak using a four-times polyphase resample."""
    if not audio.size:
        return -240.0
    oversampled = resample_poly(audio, oversample, 1, axis=0)
    return peak_dbfs(np.asarray(oversampled, dtype=np.float32))


def integrated_loudness(audio: np.ndarray, sample_rate: int) -> float:
    meter = pyln.Meter(sample_rate, block_size=0.400)
    value = float(meter.integrated_loudness(audio))
    if not math.isfinite(value):
        raise ValueError("Integrated loudness is not finite; the source may be silent.")
    return value


def measure(audio: np.ndarray, sample_rate: int) -> dict[str, float]:
    return {
        "integratedLufs": round(integrated_loudness(audio, sample_rate), 3),
        "samplePeakDbfs": round(peak_dbfs(audio), 3),
        "truePeakEstimateDbfs": round(true_peak_dbfs(audio), 3),
    }


def set_vst_parameter(plugin: Any, name: str, value: Any) -> dict[str, Any]:
    if name not in plugin.parameters:
        raise KeyError(f"VST3 parameter is unavailable: {name}")
    setattr(plugin, name, value)
    parameter = plugin.parameters[name]
    return {
        "requested": value,
        "rawValue": round(float(parameter.raw_value), 8),
        "descriptor": repr(parameter),
    }


def process_voice_cleanup_vst(
    audio: np.ndarray,
    sample_rate: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Apply a restrained, deterministic studio cleanup chain for narration."""
    if load_plugin is None or Pedalboard is None:
        raise RuntimeError("pedalboard is not installed")
    for plugin_path in (RX_DE_CLIP, PRO_Q_4, SOOTHE_2, PRO_DS):
        if not plugin_path.exists():
            raise FileNotFoundError(plugin_path)

    declipper = load_plugin(str(RX_DE_CLIP))
    equalizer = load_plugin(str(PRO_Q_4))
    resonance = load_plugin(str(SOOTHE_2))
    deesser = load_plugin(str(PRO_DS))

    declipper_settings = {
        "clipping_threshold": -0.75,
        "positive_threshold": -0.75,
        "negative_threshold": -0.75,
        "quality": "High",
        "post_limiter": False,
        "input_gain_db": 6.0,
        "output_gain_db": -6.0,
        "makeup_gain": 0.0,
        "global_bypass": False,
        "enable_asymmetric": False,
    }
    equalizer_settings = {
        "band_1_used": "Used",
        "band_1_enabled": True,
        "band_1_frequency": 72.0,
        "band_1_gain": 0.0,
        "band_1_q": 0.707,
        "band_1_shape": "Low Cut",
        "band_1_slope": "24 dB/oct",
        "processing_mode": "Zero Latency",
        "auto_gain": False,
        "output_level": 0.0,
    }
    soothe_settings = {
        "mode": "soft",
        "depth": 1.35,
        "sharpness": 3.2,
        "selectivity": 3.0,
        "low_cut_freq_hz": "1k8",
        "high_cut_freq_hz": "10k",
        "stereo_link": 100.0,
        "mix": 60.0,
    }
    deesser_settings = {
        "mode": "Single Vocal",
        "threshold": -30.0,
        "range": 3.0,
        "lookahead": 8.0,
        "lookahead_enabled": True,
        "high_pass_frequency": 4500.0,
        "low_pass_frequency": 13000.0,
        "oversampling": "2x",
        "output_level": 0.0,
    }
    configured = {
        "iZotope RX 12 De-clip": {
            name: set_vst_parameter(declipper, name, value)
            for name, value in declipper_settings.items()
        },
        "FabFilter Pro-Q 4": {
            name: set_vst_parameter(equalizer, name, value)
            for name, value in equalizer_settings.items()
        },
        "oeksound soothe2": {
            name: set_vst_parameter(resonance, name, value)
            for name, value in soothe_settings.items()
        },
        "FabFilter Pro-DS": {
            name: set_vst_parameter(deesser, name, value)
            for name, value in deesser_settings.items()
        },
    }
    board = Pedalboard([declipper, equalizer, resonance, deesser])
    processed = board(
        audio.T,
        sample_rate=sample_rate,
        buffer_size=8192,
        reset=True,
    )
    output = np.asarray(processed, dtype=np.float32).T
    if output.shape != audio.shape:
        raise RuntimeError(
            f"Voice cleanup changed the audio shape from {audio.shape} to {output.shape}."
        )
    return output, {
        "mode": "premium-vst3",
        "purpose": "subsonic cleanup, restrained resonance control, and de-essing",
        "plugins": [
            {
                "name": "iZotope RX 12 De-clip",
                "path": str(RX_DE_CLIP),
                "parameters": configured["iZotope RX 12 De-clip"],
            },
            {
                "name": "FabFilter Pro-Q 4",
                "path": str(PRO_Q_4),
                "parameters": configured["FabFilter Pro-Q 4"],
            },
            {
                "name": "oeksound soothe2",
                "path": str(SOOTHE_2),
                "parameters": configured["oeksound soothe2"],
            },
            {
                "name": "FabFilter Pro-DS",
                "path": str(PRO_DS),
                "parameters": configured["FabFilter Pro-DS"],
            },
        ],
    }


def configure_pro_l_2(
    plugin: Any,
    gain_db: float,
    target_lufs: float,
    ceiling_dbfs: float,
) -> dict[str, dict[str, Any]]:
    """Apply the conservative voice-master settings verified on this host."""
    settings: dict[str, Any] = {
        "gain": round(max(0.0, gain_db), 3),
        "style": "Transparent",
        "lookahead": 1.0,
        "attack": 250.0,
        "release": 350.0,
        "channel_link_transients": 100.0,
        "channel_link_release": 100.0,
        "oversampling": "4x",
        "true_peak_limiting": True,
        "filter_dc_offset": True,
        "dithering": "Off",
        "output_level": ceiling_dbfs,
        "lock_output": "Locked",
        "true_peak_metering": "Show True Peaks",
        "loudness_meter_target": target_lufs,
        "bypass": "Not Bypassed",
    }
    return {name: set_vst_parameter(plugin, name, value) for name, value in settings.items()}


def process_with_pro_l_2(
    audio: np.ndarray,
    sample_rate: int,
    target_lufs: float,
    ceiling_dbfs: float,
) -> tuple[np.ndarray, dict[str, Any]]:
    if load_plugin is None or Pedalboard is None:
        raise RuntimeError("pedalboard is not installed")
    if not PRO_L_2.exists():
        raise FileNotFoundError(PRO_L_2)

    plugin = load_plugin(str(PRO_L_2))
    pre_lufs = integrated_loudness(audio, sample_rate)
    total_gain_db = float(np.clip(target_lufs - pre_lufs, -MAX_TOTAL_GAIN_DB, MAX_TOTAL_GAIN_DB))
    iterations: list[dict[str, float]] = []
    configured: dict[str, dict[str, Any]] = {}
    output = audio

    for iteration in range(1, 4):
        pre_attenuation_db = min(total_gain_db, 0.0)
        limiter_gain_db = max(total_gain_db, 0.0)
        configured = configure_pro_l_2(
            plugin,
            limiter_gain_db,
            target_lufs,
            ceiling_dbfs,
        )
        staged = audio * np.float32(db_to_gain(pre_attenuation_db))
        board = Pedalboard([plugin])
        processed = board(
            staged.T,
            sample_rate=sample_rate,
            buffer_size=8192,
            reset=True,
        )
        output = np.asarray(processed, dtype=np.float32).T
        if output.shape != audio.shape:
            raise RuntimeError(
                f"FabFilter changed the audio shape from {audio.shape} to {output.shape}."
            )
        measured_lufs = integrated_loudness(output, sample_rate)
        error_lu = target_lufs - measured_lufs
        iterations.append(
            {
                "iteration": iteration,
                "totalGainDb": round(total_gain_db, 3),
                "preAttenuationDb": round(pre_attenuation_db, 3),
                "limiterGainDb": round(limiter_gain_db, 3),
                "measuredLufs": round(measured_lufs, 3),
                "errorLu": round(error_lu, 3),
            }
        )
        if abs(error_lu) <= 0.15:
            break
        total_gain_db = float(
            np.clip(total_gain_db + error_lu, -MAX_TOTAL_GAIN_DB, MAX_TOTAL_GAIN_DB)
        )

    return output, {
        "mode": "premium-vst3",
        "plugins": [
            {
                "name": "FabFilter Pro-L 2",
                "format": "VST3",
                "path": str(PRO_L_2),
                "parameterCount": len(plugin.parameters),
                "parameters": configured,
            }
        ],
        "calibrationIterations": iterations,
    }


def process_with_fallback(
    audio: np.ndarray,
    sample_rate: int,
    target_lufs: float,
    ceiling_dbfs: float,
    reason: str,
) -> tuple[np.ndarray, dict[str, Any]]:
    pre_lufs = integrated_loudness(audio, sample_rate)
    gain_db = float(np.clip(target_lufs - pre_lufs, -MAX_TOTAL_GAIN_DB, MAX_TOTAL_GAIN_DB))
    staged = audio * np.float32(db_to_gain(gain_db))

    output, fallback_attenuation_db = enforce_true_peak_ceiling(staged, ceiling_dbfs)
    output = np.asarray(output, dtype=np.float32)
    fallback_name = "NumPy linear gain with true-peak safety attenuation"

    return output, {
        "mode": "safe-fallback",
        "fallbackReason": reason,
        "plugins": [{"name": fallback_name}],
        "calibrationIterations": [
            {
                "iteration": 1,
                "totalGainDb": round(gain_db, 3),
                "safetyAttenuationDb": round(fallback_attenuation_db, 3),
                "measuredLufs": round(integrated_loudness(output, sample_rate), 3),
            }
        ],
    }


def enforce_true_peak_ceiling(
    audio: np.ndarray, ceiling_dbfs: float
) -> tuple[np.ndarray, float]:
    estimated = true_peak_dbfs(audio)
    if estimated <= ceiling_dbfs:
        return audio, 0.0
    attenuation_db = ceiling_dbfs - estimated - 0.02
    return audio * np.float32(db_to_gain(attenuation_db)), attenuation_db


def validate_source(audio: np.ndarray, sample_rate: int, input_path: Path) -> None:
    if sample_rate != EXPECTED_SAMPLE_RATE:
        raise ValueError(
            f"Expected {EXPECTED_SAMPLE_RATE} Hz input, got {sample_rate} Hz: {input_path}"
        )
    if audio.ndim != 2 or audio.shape[1] != EXPECTED_CHANNELS:
        channels = audio.shape[1] if audio.ndim == 2 else 1
        raise ValueError(f"Expected stereo input, got {channels} channel(s): {input_path}")
    if len(audio) < sample_rate:
        raise ValueError("Narration input must be at least one second long.")
    if not np.all(np.isfinite(audio)):
        raise ValueError("Narration input contains NaN or infinite samples.")
    if float(np.max(np.abs(audio))) <= 1e-8:
        raise ValueError("Narration input is silent.")


def master_file(
    input_path: Path,
    output_path: Path,
    report_path: Path,
    target_lufs: float,
    ceiling_dbfs: float,
) -> dict[str, Any]:
    input_path = input_path.resolve()
    output_path = output_path.resolve()
    report_path = report_path.resolve()
    if input_path == output_path:
        raise ValueError("Input and output paths must be different.")
    if not input_path.is_file():
        raise FileNotFoundError(input_path)

    info = sf.info(input_path)
    audio, sample_rate = sf.read(input_path, always_2d=True, dtype="float32")
    audio = np.asarray(audio, dtype=np.float32)
    validate_source(audio, sample_rate, input_path)
    before = measure(audio, sample_rate)
    warnings: list[str] = []

    cleaned = audio
    try:
        cleaned, cleanup_processing = process_voice_cleanup_vst(audio, sample_rate)
    except Exception as exc:
        reason = f"{type(exc).__name__}: {exc}"
        warnings.append(f"Premium voice cleanup unavailable; source passed unchanged. {reason}")
        cleanup_processing = {
            "mode": "bypassed",
            "bypassReason": reason,
            "plugins": [],
        }

    try:
        processed, limiter_processing = process_with_pro_l_2(
            cleaned, sample_rate, target_lufs, ceiling_dbfs
        )
    except Exception as exc:
        reason = f"{type(exc).__name__}: {exc}"
        warnings.append(f"Premium limiter unavailable; used safe fallback. {reason}")
        processed, limiter_processing = process_with_fallback(
            cleaned, sample_rate, target_lufs, ceiling_dbfs, reason
        )

    processing = {
        "voiceCleanup": cleanup_processing,
        "finalLimiter": limiter_processing,
    }

    processed, safety_attenuation_db = enforce_true_peak_ceiling(processed, ceiling_dbfs)
    processing["digitalSafetyAttenuationDb"] = round(safety_attenuation_db, 3)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, processed, sample_rate, subtype="PCM_24")

    # Measure the actual encoded output rather than the pre-write float buffer.
    encoded, encoded_rate = sf.read(output_path, always_2d=True, dtype="float32")
    encoded = np.asarray(encoded, dtype=np.float32)
    after = measure(encoded, encoded_rate)
    if after["truePeakEstimateDbfs"] > ceiling_dbfs + 0.01:
        correction = ceiling_dbfs - after["truePeakEstimateDbfs"] - 0.02
        processed *= np.float32(db_to_gain(correction))
        processing["digitalSafetyAttenuationDb"] = round(
            processing["digitalSafetyAttenuationDb"] + correction, 3
        )
        sf.write(output_path, processed, sample_rate, subtype="PCM_24")
        encoded, encoded_rate = sf.read(output_path, always_2d=True, dtype="float32")
        encoded = np.asarray(encoded, dtype=np.float32)
        after = measure(encoded, encoded_rate)

    lufs_pass = abs(after["integratedLufs"] - target_lufs) <= LOUDNESS_TOLERANCE_LU
    peak_pass = after["samplePeakDbfs"] <= ceiling_dbfs + 0.01
    true_peak_pass = after["truePeakEstimateDbfs"] <= ceiling_dbfs + 0.01
    format_pass = (
        encoded_rate == sample_rate
        and encoded.shape[1] == audio.shape[1]
        and encoded.shape[0] == audio.shape[0]
    )
    validation_pass = lufs_pass and peak_pass and true_peak_pass and format_pass

    report: dict[str, Any] = {
        "schemaVersion": "1.0",
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if validation_pass else "FAIL",
        "input": {
            "path": str(input_path),
            "sha256": sha256_file(input_path),
            "sampleRate": sample_rate,
            "channels": audio.shape[1],
            "frames": audio.shape[0],
            "durationSeconds": round(audio.shape[0] / sample_rate, 3),
            "subtype": info.subtype,
        },
        "output": {
            "path": str(output_path),
            "sha256": sha256_file(output_path),
            "sampleRate": encoded_rate,
            "channels": encoded.shape[1],
            "frames": encoded.shape[0],
            "durationSeconds": round(encoded.shape[0] / encoded_rate, 3),
            "subtype": sf.info(output_path).subtype,
        },
        "target": {
            "integratedLufs": target_lufs,
            "peakCeilingDbfs": ceiling_dbfs,
            "loudnessToleranceLu": LOUDNESS_TOLERANCE_LU,
        },
        "before": before,
        "after": after,
        "processing": processing,
        "runtime": {
            "python": platform.python_version(),
            "pedalboard": getattr(pedalboard, "__version__", None),
            "numpy": np.__version__,
            "soundfile": sf.__version__,
        },
        "validation": {
            "sampleRatePreserved": encoded_rate == sample_rate,
            "stereoPreserved": encoded.shape[1] == EXPECTED_CHANNELS,
            "frameCountPreserved": encoded.shape[0] == audio.shape[0],
            "loudnessWithinTolerance": lufs_pass,
            "samplePeakWithinCeiling": peak_pass,
            "truePeakEstimateWithinCeiling": true_peak_pass,
        },
        "warnings": warnings,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def synthetic_voice_like_audio(sample_rate: int = EXPECTED_SAMPLE_RATE) -> np.ndarray:
    """Create a deterministic speech-shaped smoke signal without using private audio."""
    seconds = 6.0
    time_axis = np.arange(round(seconds * sample_rate), dtype=np.float32) / sample_rate
    fundamental = 125.0 + 7.0 * np.sin(2.0 * np.pi * 0.7 * time_axis)
    phase = 2.0 * np.pi * np.cumsum(fundamental, dtype=np.float64) / sample_rate
    source = (
        np.sin(phase)
        + 0.42 * np.sin(2.0 * phase)
        + 0.20 * np.sin(3.0 * phase)
        + 0.10 * np.sin(5.0 * phase)
    )
    syllables = 0.28 + 0.72 * np.square(np.sin(2.0 * np.pi * 2.4 * time_axis))
    fade = np.minimum(np.clip(time_axis / 0.08, 0.0, 1.0), np.clip((seconds - time_axis) / 0.08, 0.0, 1.0))
    mono = (0.055 * source * syllables * fade).astype(np.float32)
    return np.column_stack((mono, mono)).astype(np.float32)


def run_smoke_test(target_lufs: float, ceiling_dbfs: float) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="toolbraid-master-smoke-") as temp_dir:
        directory = Path(temp_dir)
        source = directory / "smoke-input.wav"
        output = directory / "smoke-output.wav"
        report = directory / "smoke-report.json"
        sf.write(source, synthetic_voice_like_audio(), EXPECTED_SAMPLE_RATE, subtype="PCM_24")
        result = master_file(source, output, report, target_lufs, ceiling_dbfs)
        result["smokeTest"] = True
        return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--target-lufs", type=float, default=DEFAULT_TARGET_LUFS)
    parser.add_argument("--ceiling-dbfs", type=float, default=DEFAULT_CEILING_DBFS)
    parser.add_argument(
        "--seal-config",
        type=Path,
        metavar="PATH",
        help=(
            "After a PASS, atomically update inputs.narrationProvenance in this render config "
            f"(normally {DEFAULT_RENDER_CONFIG})."
        ),
    )
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="Master a generated, non-private voice-like signal in a temporary directory.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not -24.0 <= args.target_lufs <= -12.0:
        raise ValueError("--target-lufs must be between -24 and -12 LUFS.")
    if not -6.0 <= args.ceiling_dbfs <= -1.0:
        raise ValueError("--ceiling-dbfs must be between -6 and -1 dBFS.")

    if args.smoke_test:
        if args.seal_config is not None:
            raise ValueError("--seal-config cannot be combined with --smoke-test.")
        result = run_smoke_test(args.target_lufs, args.ceiling_dbfs)
    else:
        result = master_file(
            args.input,
            args.output,
            args.report,
            args.target_lufs,
            args.ceiling_dbfs,
        )
        if result["status"] == "PASS" and args.seal_config is not None:
            result["renderConfigSeal"] = seal_render_config(
                args.seal_config,
                args.input,
                args.output,
                str(result["input"]["sha256"]),
                str(result["output"]["sha256"]),
            )
            report_path = args.report.resolve()
            staged_report = report_path.with_name(
                f".{report_path.name}.sealing-{os.getpid()}.tmp"
            )
            try:
                staged_report.write_text(
                    json.dumps(result, indent=2) + "\n",
                    encoding="utf-8",
                )
                staged_report.replace(report_path)
            finally:
                staged_report.unlink(missing_ok=True)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
