#!/usr/bin/env python3
"""Generate and QC the final ToolBraid narration with an owner-authorized clone.

The script keeps the private reference and all generated audio under ignored
workspace paths.  It uses Qwen3-TTS' transcript-conditioned clone prompt,
generates deterministic candidates per scene, applies declared pronunciation
overrides after ASR/content and duration scoring, then assembles a 162-second 48 kHz
master plus caption timing data for the final compositor.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

# Numba otherwise tries to create its cache beside the shared system librosa
# installation on Windows, which can stall for minutes under antivirus. Keep
# that cache inside ToolBraid's ignored private workspace instead.
_ROOT_HINT = Path(__file__).resolve().parents[1]
os.environ.setdefault("NUMBA_CACHE_DIR", str(_ROOT_HINT / ".private" / "numba-cache"))

import librosa
import numpy as np
import pyloudnorm as pyln
import soundfile as sf
import torch
from faster_whisper import WhisperModel
from pedalboard import Compressor, HighpassFilter, Limiter, Pedalboard
from qwen_tts import Qwen3TTSModel
from scipy.signal import butter, resample_poly, sosfiltfilt


ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / ".private" / "voice"
WORK = ROOT / "video-production" / "work"
MODEL = ROOT / "video-production" / "models" / "Qwen3-TTS-12Hz-1.7B-Base"
REFERENCE_SOURCE = PRIVATE / "reference.wav"
REFERENCE_CLIP = PRIVATE / "reference-11s-mono-24k.wav"
REFERENCE_TEXT_PATH = PRIVATE / "reference.txt"
MASTER = WORK / "narration-master.wav"
CAPTIONS = WORK / "narration-captions.json"
SRT = WORK / "ToolBraid-WebMCP-Challenge.en.srt"
QC_REPORT = WORK / "narration-qc.json"

MASTER_SR = 48_000
MASTER_SECONDS = 162.0
REFERENCE_START = 154.18
REFERENCE_END = 165.14
# Scene 11 candidate 3 pronounces the product name correctly. The explicit
# policy keeps the final selection reproducible instead of relying on a manual
# file copy after automated ASR scoring.
SCENE_CANDIDATE_OVERRIDES = {11: 3}


@dataclass(frozen=True)
class Scene:
    number: int
    start: float
    end: float
    text: str
    tts_text: str

    @property
    def duration(self) -> float:
        return self.end - self.start


SCENES = [
    Scene(
        1,
        0,
        8,
        "One objective. Six provider origins. Nine tools. Two actions that require human approval.",
        "One objective. Six provider origins. Nine tools. Two actions that require human approval.",
    ),
    Scene(
        2,
        8,
        21,
        "Our control plane builds one visible graph for the cross-site objective: restore checkout, prepare the customer update, and keep production and public communication locked.",
        "Our control plane builds one visible graph for the cross-site objective: restore checkout, prepare the customer update, and keep production and public communication locked.",
    ),
    Scene(
        3,
        21,
        36,
        "Each provider registers its capability through WebMCP from its own origin. The control plane discovers only live registrations from an explicit allowlist and executes those opaque tools, never private provider code.",
        "Each provider registers its capability through Web M C P from its own origin. The control plane discovers only live registrations from an explicit allow list, and executes those opaque tools, never private provider code.",
    ),
    Scene(
        4,
        36,
        51,
        "Discovery finds nine heterogeneous tools. Before any capability scoring, ToolBraid treats their metadata as untrusted. An instruction-like override attempt is detected, quarantined, and kept out of the plan.",
        "Discovery finds nine heterogeneous tools. Before any capability scoring, Tool Braid treats their metadata as untrusted. An instruction-like override attempt is detected, quarantined, and kept out of the plan.",
    ),
    Scene(
        5,
        51,
        68,
        "Provider contracts use different names, schemas, and result shapes. A replaceable recovery ontology maps them to seven canonical capabilities. Confidence and evidence stay visible. The provider-neutral engine then builds a nine-node dependency graph.",
        "Provider contracts use different names, schemas, and result shapes. A replaceable recovery ontology maps them to seven canonical capabilities. Confidence and evidence stay visible. The provider-neutral engine then builds a nine-node dependency graph.",
    ),
    Scene(
        6,
        68,
        85,
        "Four independent evidence reads run concurrently. When the primary health provider fails, ToolBraid selects a differently shaped read-only fallback without changing the planner. Fallback is allowed for evidence; external mutations still fail closed.",
        "Four independent evidence reads run concurrently. When the primary health provider fails, Tool Braid selects a differently shaped read-only fallback without changing the planner. Fallback is allowed for evidence. External mutations still fail closed.",
    ),
    Scene(
        7,
        85,
        103,
        "Only after the evidence converges does ToolBraid finalize concrete effects: the prepared recovery option, its quote revision, the current notice revision, and the exact customer message. The agent can prepare and explain; it cannot grant authority.",
        "Only after the evidence converges does Tool Braid finalize concrete effects: the prepared recovery option, its quote revision, the current notice revision, and the exact customer message. The agent can prepare and explain. It cannot grant authority.",
    ),
    Scene(
        8,
        103,
        122,
        "Two separate approval packets go to the human. Each binds the plan revision, origin, live tool, schema, arguments, effect, risk, expiry, and a single-use token. One approval cannot authorize the other action, and synthetic clicks are rejected.",
        "Two separate approval packets go to the human. Each binds the plan revision, origin, live tool, schema, arguments, effect, risk, expiry, and a single-use token. One approval cannot authorize the other action, and synthetic clicks are rejected.",
    ),
    Scene(
        9,
        122,
        140,
        "Before execution, the control plane refreshes the registry, rescans metadata, and atomically claims both approvals. Any identity, schema, argument, or plan drift stops the sequence. Recovery finishes first; only then can the customer update publish.",
        "Before execution, the control plane refreshes the registry, re-scans metadata, and atomically claims both approvals. Any identity, schema, argument, or plan drift stops the sequence. Recovery finishes first. Only then can the customer update publish.",
    ),
    Scene(
        10,
        140,
        156,
        "Completion restores release eighteen forty-one, publishes notice revision nine, records both receipts, and seals fifty-four local events in a cryptographic integrity chain. These deterministic fixtures change no real production or status page.",
        "Completion restores release eighteen forty-one, publishes notice revision nine, records both receipts, and seals fifty-four local events in a cryptographic integrity chain. These deterministic fixtures change no real production or status page.",
    ),
    Scene(
        11,
        156,
        162,
        "ToolBraid keeps humans in control across WebMCP sites.",
        "Tool Braid keeps humans in control across Web M C P sites.",
    ),
]


def ensure_inputs() -> None:
    missing = [
        path
        for path in (REFERENCE_SOURCE, REFERENCE_TEXT_PATH, MODEL / "model.safetensors")
        if not path.is_file()
    ]
    if missing:
        raise FileNotFoundError("Missing narration input(s): " + ", ".join(map(str, missing)))
    PRIVATE.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)


def load_reference_text() -> str:
    text = REFERENCE_TEXT_PATH.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"Voice-reference transcript is empty: {REFERENCE_TEXT_PATH}")
    return text


def prepare_reference(reference_text: str) -> dict[str, float | int | str]:
    audio, sr = sf.read(REFERENCE_SOURCE, always_2d=True, dtype="float32")
    start = round(REFERENCE_START * sr)
    end = round(REFERENCE_END * sr)
    mono = audio[start:end].mean(axis=1)
    mono -= float(np.mean(mono))
    highpass = butter(2, 65, btype="highpass", fs=sr, output="sos")
    mono = sosfiltfilt(highpass, mono).astype(np.float32)
    if sr != 24_000:
        divisor = math.gcd(sr, 24_000)
        mono = resample_poly(mono, 24_000 // divisor, sr // divisor).astype(np.float32)
    peak = float(np.max(np.abs(mono)))
    if peak > 0:
        mono *= np.float32((10 ** (-3 / 20)) / peak)
    fade = min(round(0.025 * 24_000), len(mono) // 4)
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)
        mono[:fade] *= ramp
        mono[-fade:] *= ramp[::-1]
    sf.write(REFERENCE_CLIP, mono, 24_000, subtype="PCM_24")
    return {
        "source": str(REFERENCE_SOURCE.relative_to(ROOT)),
        "clip": str(REFERENCE_CLIP.relative_to(ROOT)),
        "startSeconds": REFERENCE_START,
        "endSeconds": REFERENCE_END,
        "durationSeconds": len(mono) / 24_000,
        "sampleRate": 24_000,
        "transcriptSource": str(REFERENCE_TEXT_PATH.relative_to(ROOT)),
        "transcript": reference_text,
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def reused_scene_report(scene: Scene) -> dict:
    selected_path = WORK / f"narration-scene-{scene.number:02d}.wav"
    if not selected_path.is_file():
        raise FileNotFoundError(selected_path)
    selected_hash = sha256_file(selected_path)
    matches = []
    for candidate in range(1, 4):
        candidate_path = WORK / f"narration-scene-{scene.number:02d}-candidate-{candidate}.wav"
        if candidate_path.is_file() and sha256_file(candidate_path) == selected_hash:
            matches.append(candidate)
    selected_candidate = matches[0] if len(matches) == 1 else None
    override = SCENE_CANDIDATE_OVERRIDES.get(scene.number)
    if override is not None and selected_candidate != override:
        raise ValueError(
            f"Scene {scene.number} must reuse candidate {override}, "
            f"but selected audio matches {selected_candidate!r}."
        )
    return {
        "scene": scene.number,
        "start": scene.start,
        "end": scene.end,
        "text": scene.text,
        "ttsText": scene.tts_text,
        "selectedCandidate": selected_candidate,
        "selectionMethod": (
            "explicit-pronunciation-override"
            if override is not None
            else "reused-candidate-content-match"
            if selected_candidate is not None
            else "reused-selected-scene"
        ),
        "selectedSha256": selected_hash,
        "selectedPath": str(selected_path.relative_to(ROOT)),
        "candidates": [],
    }


def normalise_words(text: str) -> list[str]:
    replacements = {
        "toolbraid": "tool braid",
        "webmcp": "web m c p",
        "mcp": "m c p",
        "sha": "s h a",
        "allowlist": "allow list",
    }
    value = text.lower()
    for source, target in replacements.items():
        value = value.replace(source, target)
    words = re.findall(r"[a-z0-9]+", value)
    spoken_numbers = {
        "1841": ["eighteen", "forty", "one"],
        "9": ["nine"],
        "54": ["fifty", "four"],
        "256": ["two", "fifty", "six"],
    }
    return [part for word in words for part in spoken_numbers.get(word, [word])]


def word_error_rate(reference: str, hypothesis: str) -> float:
    ref = normalise_words(reference)
    hyp = normalise_words(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    previous = list(range(len(hyp) + 1))
    for i, left in enumerate(ref, 1):
        current = [i]
        for j, right in enumerate(hyp, 1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (left != right),
                )
            )
        previous = current
    return previous[-1] / len(ref)


def trim_speech(audio: np.ndarray, sr: int) -> np.ndarray:
    mono = np.asarray(audio, dtype=np.float32).reshape(-1)
    trimmed, index = librosa.effects.trim(mono, top_db=48, frame_length=2048, hop_length=256)
    if not len(trimmed):
        return mono
    margin = round(0.12 * sr)
    left = max(0, int(index[0]) - margin)
    right = min(len(mono), int(index[1]) + margin)
    return mono[left:right]


def transcribe(asr: WhisperModel, path: Path) -> str:
    segments, _ = asr.transcribe(
        str(path),
        language="en",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


def generate_candidates(
    model: Qwen3TTSModel,
    prompt: object,
    asr: WhisperModel,
    candidates: int,
    scenes: list[Scene] | None = None,
) -> list[dict]:
    reports: list[dict] = []
    for scene in scenes or SCENES:
        target_speech = max(1.0, scene.duration - 0.8)
        scene_reports: list[dict] = []
        candidate_count = max(candidates, SCENE_CANDIDATE_OVERRIDES.get(scene.number, 0))
        for candidate in range(candidate_count):
            seed = 20_260_827 + scene.number * 100 + candidate
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            started = time.perf_counter()
            wavs, sr = model.generate_voice_clone(
                text=scene.tts_text,
                language="English",
                voice_clone_prompt=prompt,
                max_new_tokens=2048,
                do_sample=True,
                temperature=0.82 + candidate * 0.04,
                top_p=0.92,
                top_k=50,
            )
            wave = trim_speech(np.asarray(wavs[0]), sr)
            path = WORK / f"narration-scene-{scene.number:02d}-candidate-{candidate + 1}.wav"
            sf.write(path, wave, sr, subtype="PCM_24")
            transcript = transcribe(asr, path)
            wer = word_error_rate(scene.tts_text, transcript)
            duration = len(wave) / sr
            length_penalty = abs(math.log(max(duration, 0.1) / target_speech))
            overflow_penalty = max(0.0, duration - (scene.duration - 0.2)) * 2.0
            score = wer * 4.0 + length_penalty + overflow_penalty
            scene_reports.append(
                {
                    "candidate": candidate + 1,
                    "seed": seed,
                    "path": str(path.relative_to(ROOT)),
                    "durationSeconds": round(duration, 3),
                    "generationSeconds": round(time.perf_counter() - started, 3),
                    "transcript": transcript,
                    "wer": round(wer, 4),
                    "selectionScore": round(score, 4),
                }
            )
        override = SCENE_CANDIDATE_OVERRIDES.get(scene.number)
        selected = (
            next(item for item in scene_reports if item["candidate"] == override)
            if override is not None
            else min(scene_reports, key=lambda item: item["selectionScore"])
        )
        chosen = WORK / f"narration-scene-{scene.number:02d}.wav"
        shutil.copy2(ROOT / selected["path"], chosen)
        reports.append(
            {
                "scene": scene.number,
                "start": scene.start,
                "end": scene.end,
                "text": scene.text,
                "ttsText": scene.tts_text,
                "selectedCandidate": selected["candidate"],
                "selectionMethod": (
                    "explicit-pronunciation-override"
                    if override is not None
                    else "automatic-asr-duration-score"
                ),
                "selectedSha256": sha256_file(chosen),
                "selectedPath": str(chosen.relative_to(ROOT)),
                "candidates": scene_reports,
            }
        )
        print(
            f"scene {scene.number:02d}: candidate {selected['candidate']} "
            f"duration={selected['durationSeconds']}s wer={selected['wer']}",
            flush=True,
        )
    return reports


def audit_selected_scenes(asr: WhisperModel, scene_reports: list[dict]) -> dict:
    audits = []
    for scene, report in zip(SCENES, scene_reports, strict=True):
        path = ROOT / report["selectedPath"]
        info = sf.info(path)
        transcript = transcribe(asr, path)
        audit = {
            "durationSeconds": round(info.frames / info.samplerate, 3),
            "transcript": transcript,
            "wer": round(word_error_rate(scene.tts_text, transcript), 4),
        }
        report["selectedAudit"] = audit
        audits.append(audit)
        print(
            f"audit {scene.number:02d}: duration={audit['durationSeconds']}s wer={audit['wer']}",
            flush=True,
        )
    return {
        "meanWer": round(float(np.mean([audit["wer"] for audit in audits])), 4),
        "maxWer": round(float(np.max([audit["wer"] for audit in audits])), 4),
    }


def caption_chunks(text: str, maximum_words: int = 11) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks: list[str] = []
    for sentence in sentences:
        words = sentence.split()
        while words:
            take = min(maximum_words, len(words))
            if len(words) > maximum_words and take > 6:
                punctuation = [i + 1 for i, word in enumerate(words[:take]) if word.endswith((",", ":", ";"))]
                if punctuation and punctuation[-1] >= 6:
                    take = punctuation[-1]
            chunks.append(" ".join(words[:take]))
            words = words[take:]
    return chunks


def assemble_master(scene_reports: list[dict]) -> tuple[np.ndarray, list[dict], dict]:
    master = np.zeros(round(MASTER_SECONDS * MASTER_SR), dtype=np.float32)
    captions: list[dict] = []
    scene_mix: list[dict] = []
    for scene, report in zip(SCENES, scene_reports, strict=True):
        audio, sr = sf.read(ROOT / report["selectedPath"], dtype="float32")
        audio = np.asarray(audio).reshape(-1)
        if sr != MASTER_SR:
            common = math.gcd(sr, MASTER_SR)
            audio = resample_poly(audio, MASTER_SR // common, sr // common).astype(np.float32)
        available = scene.duration - 0.45
        original_duration = len(audio) / MASTER_SR
        stretch_rate = 1.0
        if original_duration > available:
            stretch_rate = original_duration / available
            if stretch_rate > 1.18:
                raise RuntimeError(
                    f"Scene {scene.number} needs excessive time compression ({stretch_rate:.3f}x)."
                )
            audio = librosa.effects.time_stretch(audio, rate=stretch_rate).astype(np.float32)
        rms = float(np.sqrt(np.mean(audio * audio))) if len(audio) else 0.0
        if rms > 0:
            audio *= np.float32(10 ** ((-22.0 - 20 * math.log10(rms)) / 20))
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        if peak > 0.92:
            audio *= np.float32(0.92 / peak)
        lead = min(0.32, max(0.12, (scene.duration - len(audio) / MASTER_SR) * 0.3))
        start_sample = round((scene.start + lead) * MASTER_SR)
        end_sample = min(len(master), start_sample + len(audio))
        master[start_sample:end_sample] += audio[: end_sample - start_sample]
        speech_start = start_sample / MASTER_SR
        speech_end = end_sample / MASTER_SR
        chunks = caption_chunks(scene.text)
        weights = np.asarray([max(1, len(normalise_words(chunk))) for chunk in chunks], dtype=float)
        durations = (speech_end - speech_start) * weights / weights.sum()
        cursor = speech_start
        for chunk, duration in zip(chunks, durations, strict=True):
            captions.append(
                {
                    "start": round(cursor, 3),
                    "end": round(cursor + float(duration), 3),
                    "text": chunk,
                    "scene": scene.number,
                }
            )
            cursor += float(duration)
        scene_mix.append(
            {
                "scene": scene.number,
                "sourceDurationSeconds": round(original_duration, 3),
                "stretchRate": round(stretch_rate, 4),
                "placedStart": round(speech_start, 3),
                "placedEnd": round(speech_end, 3),
            }
        )

    board = Pedalboard(
        [
            HighpassFilter(cutoff_frequency_hz=70),
            Compressor(threshold_db=-24, ratio=2.2, attack_ms=12, release_ms=100),
            Limiter(threshold_db=-1.5, release_ms=80),
        ]
    )
    mastered = np.asarray(board(master, MASTER_SR), dtype=np.float32)
    meter = pyln.Meter(MASTER_SR)
    loudness = float(meter.integrated_loudness(mastered))
    target_lufs = -16.0
    mastered *= np.float32(10 ** ((target_lufs - loudness) / 20))
    peak = float(np.max(np.abs(mastered)))
    max_peak = 10 ** (-1.0 / 20)
    if peak > max_peak:
        mastered *= np.float32(max_peak / peak)
    final_lufs = float(meter.integrated_loudness(mastered))
    final_peak = float(np.max(np.abs(mastered)))
    return mastered, captions, {
        "targetLufs": target_lufs,
        "integratedLufs": round(final_lufs, 3),
        "samplePeakDbfs": round(20 * math.log10(max(final_peak, 1e-12)), 3),
        "sceneMix": scene_mix,
    }


def srt_time(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_outputs(master: np.ndarray, captions: list[dict], report: dict) -> None:
    stereo = np.column_stack((master, master))
    sf.write(MASTER, stereo, MASTER_SR, subtype="PCM_24")
    CAPTIONS.write_text(json.dumps(captions, indent=2) + "\n", encoding="utf-8")
    srt_parts = []
    for index, cue in enumerate(captions, 1):
        srt_parts.extend(
            [
                str(index),
                f"{srt_time(cue['start'])} --> {srt_time(cue['end'])}",
                cue["text"],
                "",
            ]
        )
    SRT.write_text("\n".join(srt_parts), encoding="utf-8")
    QC_REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=int, default=2, choices=(1, 2, 3))
    parser.add_argument("--reuse-scenes", action="store_true", help="Skip TTS and reassemble existing scene WAVs.")
    parser.add_argument("--smoke-test", action="store_true", help="Generate one short local voice-clone sample and exit.")
    parser.add_argument(
        "--scenes",
        help="Comma-separated scene numbers to regenerate; all other selected scene WAVs are reused.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    ensure_inputs()
    reference_text = load_reference_text()
    reference = prepare_reference(reference_text)
    started = time.perf_counter()

    if args.reuse_scenes:
        scene_reports = [reused_scene_report(scene) for scene in SCENES]
        asr = WhisperModel(
            "base",
            device="cuda",
            compute_type="float16",
            download_root=str(Path.home() / ".cache" / "huggingface" / "hub"),
        )
        asr_report = audit_selected_scenes(asr, scene_reports)
        del asr
        torch.cuda.empty_cache()
    else:
        requested_scenes = set(range(1, len(SCENES) + 1))
        if args.scenes:
            try:
                requested_scenes = {int(value.strip()) for value in args.scenes.split(",") if value.strip()}
            except ValueError as error:
                raise ValueError("--scenes must contain comma-separated integers.") from error
            invalid = requested_scenes.difference(range(1, len(SCENES) + 1))
            if invalid:
                raise ValueError(f"Unknown scene number(s): {sorted(invalid)}")
        print("Loading Qwen3-TTS 1.7B Base on CUDA (BF16 + SDPA)...", flush=True)
        model = Qwen3TTSModel.from_pretrained(
            str(MODEL),
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
        )
        print(
            f"Model loaded; CUDA allocated={torch.cuda.memory_allocated() / 1024**3:.2f} GiB",
            flush=True,
        )
        prompt = model.create_voice_clone_prompt(
            ref_audio=str(REFERENCE_CLIP),
            ref_text=reference_text,
            x_vector_only_mode=False,
        )
        if args.smoke_test:
            wavs, sr = model.generate_voice_clone(
                text="Tool Braid turns one objective into a visible execution graph.",
                language="English",
                voice_clone_prompt=prompt,
                max_new_tokens=320,
                do_sample=True,
                temperature=0.82,
                top_p=0.92,
                top_k=50,
            )
            smoke_path = WORK / "voice-clone-smoke-test.wav"
            sf.write(smoke_path, trim_speech(np.asarray(wavs[0]), sr), sr, subtype="PCM_24")
            print(f"Smoke test written: {smoke_path}", flush=True)
            return 0
        asr = WhisperModel(
            "base",
            device="cuda",
            compute_type="float16",
            download_root=str(Path.home() / ".cache" / "huggingface" / "hub"),
        )
        generated = generate_candidates(
            model,
            prompt,
            asr,
            args.candidates,
            [scene for scene in SCENES if scene.number in requested_scenes],
        )
        generated_by_scene = {report["scene"]: report for report in generated}
        scene_reports = []
        for scene in SCENES:
            if scene.number in generated_by_scene:
                scene_reports.append(generated_by_scene[scene.number])
                continue
            scene_reports.append(reused_scene_report(scene))
        asr_report = audit_selected_scenes(asr, scene_reports)
        del asr, prompt, model
        torch.cuda.empty_cache()

    master, captions, mix_report = assemble_master(scene_reports)
    report = {
        "status": "PASS",
        "model": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "runtime": {
            "qwenTts": "0.1.1",
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
            "device": torch.cuda.get_device_name(0),
            "dtype": "bfloat16",
            "attention": "sdpa",
        },
        "reference": reference,
        "asr": asr_report,
        "master": {
            "path": str(MASTER.relative_to(ROOT)),
            "durationSeconds": MASTER_SECONDS,
            "sampleRate": MASTER_SR,
            "channels": 2,
            **mix_report,
        },
        "captions": {
            "json": str(CAPTIONS.relative_to(ROOT)),
            "srt": str(SRT.relative_to(ROOT)),
            "cueCount": len(captions),
        },
        "scenes": scene_reports,
        "wallSeconds": round(time.perf_counter() - started, 3),
    }
    write_outputs(master, captions, report)
    print(json.dumps({"status": "PASS", "master": str(MASTER), "qc": str(QC_REPORT)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
