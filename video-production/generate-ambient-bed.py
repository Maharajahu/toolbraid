#!/usr/bin/env python3
"""Generate ToolBraid's original, deterministic ambient UI bed.

The result is intentionally sparse: a wide low pad, filtered air, and soft
scene-boundary impulses.  The compositor attenuates and ducks it beneath the
narration, so it adds motion without competing with speech.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy.signal import butter, sosfilt


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "video-production" / "work" / "ambient-bed.wav"
REPORT = ROOT / "video-production" / "work" / "ambient-bed-report.json"
SAMPLE_RATE = 48_000
DURATION = 162.0
SCENE_BOUNDARIES = (8, 21, 36, 51, 68, 85, 103, 122, 140, 156)


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    samples = round(SAMPLE_RATE * DURATION)
    time = np.arange(samples, dtype=np.float32) / np.float32(SAMPLE_RATE)
    rng = np.random.default_rng(20_260_828)

    # A suspended C/G/D palette avoids a strong major/minor emotional claim.
    frequencies = (65.406, 97.999, 146.832)
    left = np.zeros(samples, dtype=np.float32)
    right = np.zeros(samples, dtype=np.float32)
    for index, frequency in enumerate(frequencies):
        drift = 0.045 * np.sin(2 * np.pi * (0.006 + index * 0.0017) * time + index)
        phase = 2 * np.pi * frequency * time + drift
        movement = 0.58 + 0.42 * np.sin(2 * np.pi * (0.010 + index * 0.003) * time + 1.3 * index)
        amplitude = (0.095, 0.060, 0.030)[index]
        left += (amplitude * movement * np.sin(phase + index * 0.21)).astype(np.float32)
        right += (amplitude * movement * np.sin(phase + 0.47 + index * 0.16)).astype(np.float32)

    # Filtered air gives the bed presence on laptop speakers without hiss.
    noise = rng.standard_normal((2, samples), dtype=np.float32)
    air_filter = butter(2, (650, 4_800), btype="bandpass", fs=SAMPLE_RATE, output="sos")
    left += np.float32(0.014) * sosfilt(air_filter, noise[0]).astype(np.float32)
    right += np.float32(0.014) * sosfilt(air_filter, noise[1]).astype(np.float32)

    # A soft braided pulse marks each editorial chapter without becoming a cue.
    pulse_length = round(1.25 * SAMPLE_RATE)
    pulse_time = np.arange(pulse_length, dtype=np.float32) / np.float32(SAMPLE_RATE)
    pulse_envelope = np.exp(-3.8 * pulse_time).astype(np.float32)
    for index, boundary in enumerate(SCENE_BOUNDARIES):
        start = round(boundary * SAMPLE_RATE)
        end = min(samples, start + pulse_length)
        length = end - start
        frequency = 174.614 if index % 2 == 0 else 195.998
        tone = (0.075 * pulse_envelope[:length] * np.sin(2 * np.pi * frequency * pulse_time[:length])).astype(np.float32)
        left[start:end] += tone
        right[start:end] += np.roll(tone, min(length - 1, 211))

    stereo = np.vstack((left, right))
    # Remove subsonic energy and leave headroom before the compositor's mix.
    highpass = butter(2, 38, btype="highpass", fs=SAMPLE_RATE, output="sos")
    stereo = sosfilt(highpass, stereo, axis=1).astype(np.float32)
    fade_samples = 3 * SAMPLE_RATE
    fade = np.ones(samples, dtype=np.float32)
    fade[:fade_samples] = np.sin(np.linspace(0, np.pi / 2, fade_samples, dtype=np.float32)) ** 2
    fade[-fade_samples:] = fade[:fade_samples][::-1]
    stereo *= fade

    rms = float(np.sqrt(np.mean(np.square(stereo), dtype=np.float64)))
    target_rms = 10 ** (-12.0 / 20.0)
    if rms > 0:
        stereo *= np.float32(target_rms / rms)
    peak = float(np.max(np.abs(stereo)))
    ceiling = 10 ** (-1.5 / 20.0)
    if peak > ceiling:
        stereo *= np.float32(ceiling / peak)

    sf.write(OUTPUT, stereo.T, SAMPLE_RATE, subtype="PCM_24")
    meter = pyln.Meter(SAMPLE_RATE)
    integrated = float(meter.integrated_loudness(stereo.T))
    final_peak = float(np.max(np.abs(stereo)))
    final_rms = float(np.sqrt(np.mean(np.square(stereo), dtype=np.float64)))
    report = {
        "status": "PASS",
        "path": str(OUTPUT.relative_to(ROOT)),
        "originalComposition": True,
        "durationSeconds": DURATION,
        "sampleRate": SAMPLE_RATE,
        "channels": 2,
        "integratedLufs": round(integrated, 3),
        "rmsDbfs": round(20 * math.log10(max(final_rms, 1e-12)), 3),
        "samplePeakDbfs": round(20 * math.log10(max(final_peak, 1e-12)), 3),
        "sceneBoundaryPulses": list(SCENE_BOUNDARIES),
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
