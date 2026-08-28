#!/usr/bin/env python3
"""Generate ToolBraid narration locally with pinned Resemble AI Chatterbox.

The owner-authorized voice reference never leaves the machine. Public model
weights are prepared separately at exact Hugging Face revisions; synthesis and
ASR quality control then use only local paths. Candidate selection fails closed
on timing, word error rate, and exact critical-phrase recognition.
"""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import math
import random
import re
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel
from huggingface_hub import snapshot_download
from scipy.signal import resample_poly


ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / ".private" / "voice"
WORK = ROOT / "video-production" / "work"
MODELS = ROOT / "video-production" / "models"
REFERENCE_AUDIO = PRIVATE / "reference-11s-mono-24k.wav"
REFERENCE_TEXT = PRIVATE / "reference.txt"
MASTER = WORK / "narration-master.wav"
CAPTIONS = WORK / "narration-captions.json"
SRT = WORK / "ToolBraid-WebMCP-Challenge.en.srt"
QC_REPORT = WORK / "narration-qc.json"

CHATTERBOX_REPOSITORY = "https://github.com/resemble-ai/chatterbox"
CHATTERBOX_CODE_REVISION = "5de7a54aa4e5e2baadb0182dde554908b48b85c2"
CHATTERBOX_MODEL_ID = "ResembleAI/chatterbox"
CHATTERBOX_MODEL_REVISION = "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18"
CHATTERBOX_MODEL_DIR = MODELS / f"chatterbox-{CHATTERBOX_MODEL_REVISION[:12]}"
CHATTERBOX_FILES = (
    "ve.safetensors",
    "t3_cfg.safetensors",
    "s3gen.safetensors",
    "tokenizer.json",
    "conds.pt",
)

ASR_MODEL_ID = "Systran/faster-whisper-medium.en"
ASR_MODEL_REVISION = "a29b04bd15381511a9af671baec01072039215e3"
ASR_MODEL_DIR = MODELS / f"faster-whisper-medium-en-{ASR_MODEL_REVISION[:12]}"
PINNED_CHATTERBOX_FILE_SHA256 = {
    "conds.pt": "6552d70568833628ba019c6b03459e77fe71ca197d5c560cef9411bee9d87f4e",
    "s3gen.safetensors": "2b78103c654207393955e4900aac14a12de8ef25f4b09424f1ef91941f161d4e",
    "t3_cfg.safetensors": "914cb1696f47527fe8852ca8f1fe1fa63cb34f76f9c715e84e067b744dd0da81",
    "tokenizer.json": "d71e3a44eabb1784df9a68e9f95b251ecbf1a7af6a9f50835856b2ca9d8c14a5",
    "ve.safetensors": "f0921cab452fa278bc25cd23ffd59d36f816d7dc5181dd1bef9751a7fb61f63c",
}
PINNED_ASR_FILE_SHA256 = {
    ".gitattributes": "db7c0371f46f0840b8f25794c1e3321c9b5820a8cb6ba9694a46fc64b8fae5a6",
    "README.md": "ab3ddd3b6af4ea0ef353cb80004f26613ba33217f81652fc13738d3b098c7675",
    "config.json": "4a1848ebabe7938d9797c15a2e8e4ce1d36e6fd4a43d096ae5955257c67c7962",
    "model.bin": "11b220779aea4c6f3ce9d2549c8a95ea869ed84066864b999531ef53e594fe5b",
    "tokenizer.json": "929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df",
    "vocabulary.txt": "ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf",
}

MASTER_SR = 48_000
MASTER_SECONDS = 162.0
MAX_WER = 0.06
MAX_STRETCH_RATE = 1.02
MIN_CANDIDATES = 2
TRIM_TOP_DB = 48
TRIM_MARGIN_SECONDS = 0.10
ASR_SETTINGS = {
    "language": "en",
    "beamSize": 5,
    "vadFilter": True,
    "conditionOnPreviousText": False,
}


@dataclass(frozen=True)
class NarrationBlock:
    number: int
    start: float
    end: float
    text: str
    required_phrases: tuple[str, ...]

    @property
    def available_seconds(self) -> float:
        return self.end - self.start - 0.36


@dataclass(frozen=True)
class InferenceControls:
    seed: int
    repetition_penalty: float
    min_p: float
    top_p: float
    exaggeration: float
    cfg_weight: float
    temperature: float


BLOCKS = [
    NarrationBlock(
        1,
        0.0,
        18.0,
        "Let me show you how ToolBraid handles a real cross-site run. I start the "
        "mission, and it discovers nine tools across six separate WebMCP origins.",
        ("nine tools across six separate WebMCP origins",),
    ),
    NarrationBlock(
        2,
        18.0,
        34.0,
        "One tool hides an instruction-like override in its metadata, so ToolBraid "
        "quarantines it before scoring. The remaining contracts use different names, "
        "schemas, and result shapes.",
        ("quarantines it before scoring",),
    ),
    NarrationBlock(
        3,
        34.0,
        50.0,
        "ToolBraid maps them to seven canonical capabilities and builds a visible "
        "dependency graph with nine nodes. I can see which provider supports each "
        "step, the mapping confidence, and why a tool was included or rejected.",
        (
            "seven canonical capabilities",
            "dependency graph with nine nodes",
        ),
    ),
    NarrationBlock(
        4,
        50.0,
        69.0,
        "Now it runs four safe reads in parallel. The primary health check fails. "
        "ToolBraid chooses another read-only provider with a different schema, without "
        "changing the planner. That provider can gather evidence, but it can never "
        "change state.",
        ("can never change state",),
    ),
    NarrationBlock(
        5,
        69.0,
        87.0,
        "When the reads converge, ToolBraid finalizes the prepared recovery and the "
        "customer notice. The exact arguments, current versions, and concrete effects "
        "become visible.",
        ("concrete effects become visible",),
    ),
    NarrationBlock(
        6,
        87.0,
        103.0,
        "Both actions remain locked. The agent can collect evidence, build the plan, "
        "and explain what will happen. It cannot approve anything by itself.",
        (
            "both actions remain locked",
            "cannot approve anything by itself",
        ),
    ),
    NarrationBlock(
        7,
        103.0,
        123.0,
        "I open the review. Recovery and publication each receive a separate "
        "exact-effect approval: plan revision, live origin and tool, bound arguments, "
        "risk, expiry, and a one-use token. I read and approve them one at a time. One "
        "click cannot authorize both.",
        ("one click cannot authorize both",),
    ),
    NarrationBlock(
        8,
        123.0,
        140.0,
        "Before execution, ToolBraid refreshes discovery, revalidates bindings, and "
        "claims both approvals in one indivisible step. Any drift stops the run. "
        "Recovery completes before the customer update publishes.",
        (
            "one indivisible step",
            "any drift stops the run",
            "recovery completes before the customer update publishes",
        ),
    ),
    NarrationBlock(
        9,
        140.0,
        156.0,
        "Release eighteen forty one is active, notice revision nine is published, with "
        "two receipts and fifty four cryptographically chained audit events. This "
        "fixture changes no real system or status page.",
        (
            "release eighteen forty one is active",
            "notice revision nine is published",
            "fifty four cryptographically chained audit events",
            "changes no real system or status page",
        ),
    ),
    NarrationBlock(
        10,
        156.0,
        162.0,
        "That is ToolBraid: one plan, with the human in control.",
        ("human in control",),
    ),
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, payload: dict | list) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def snapshot_marker(path: Path) -> Path:
    return path / ".toolbraid-snapshot.json"


def snapshot_file_hashes(path: Path) -> dict[str, str]:
    files = sorted(
        item
        for item in path.rglob("*")
        if item.is_file()
        and item != snapshot_marker(path)
        and ".cache" not in item.relative_to(path).parts
    )
    return {
        item.relative_to(path).as_posix(): sha256_file(item)
        for item in files
    }


def combined_file_sha256(file_sha256: dict[str, str]) -> str:
    encoded = json.dumps(
        file_sha256,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def require_pinned_file_hashes(
    path: Path,
    actual: dict[str, str],
    expected: dict[str, str],
) -> None:
    if actual != expected:
        missing = sorted(set(expected) - set(actual))
        unexpected = sorted(set(actual) - set(expected))
        changed = sorted(
            name
            for name in set(actual) & set(expected)
            if actual[name] != expected[name]
        )
        raise RuntimeError(
            f"Pinned snapshot byte verification failed at {path}; "
            f"missing={missing}, unexpected={unexpected}, changed={changed}."
        )


def prepare_models() -> None:
    MODELS.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=CHATTERBOX_MODEL_ID,
        revision=CHATTERBOX_MODEL_REVISION,
        local_dir=CHATTERBOX_MODEL_DIR,
        allow_patterns=list(CHATTERBOX_FILES),
    )
    chatterbox_file_sha256 = snapshot_file_hashes(CHATTERBOX_MODEL_DIR)
    require_pinned_file_hashes(
        CHATTERBOX_MODEL_DIR,
        chatterbox_file_sha256,
        PINNED_CHATTERBOX_FILE_SHA256,
    )
    write_json(
        snapshot_marker(CHATTERBOX_MODEL_DIR),
        {
            "repoId": CHATTERBOX_MODEL_ID,
            "revision": CHATTERBOX_MODEL_REVISION,
            "fileSha256": chatterbox_file_sha256,
        },
    )
    snapshot_download(
        repo_id=ASR_MODEL_ID,
        revision=ASR_MODEL_REVISION,
        local_dir=ASR_MODEL_DIR,
    )
    asr_file_sha256 = snapshot_file_hashes(ASR_MODEL_DIR)
    require_pinned_file_hashes(
        ASR_MODEL_DIR,
        asr_file_sha256,
        PINNED_ASR_FILE_SHA256,
    )
    write_json(
        snapshot_marker(ASR_MODEL_DIR),
        {
            "repoId": ASR_MODEL_ID,
            "revision": ASR_MODEL_REVISION,
            "fileSha256": asr_file_sha256,
        },
    )
    print(json.dumps({
        "chatterbox": str(CHATTERBOX_MODEL_DIR),
        "asr": str(ASR_MODEL_DIR),
    }, indent=2))


def verify_snapshot(
    path: Path,
    repo_id: str,
    revision: str,
    pinned_file_sha256: dict[str, str],
) -> dict[str, str]:
    marker = snapshot_marker(path)
    if not marker.is_file():
        raise FileNotFoundError(
            f"Missing pinned snapshot marker: {marker}. Run --prepare-models first."
        )
    data = json.loads(marker.read_text(encoding="utf-8"))
    if data.get("repoId") != repo_id or data.get("revision") != revision:
        raise RuntimeError(
            f"Snapshot marker mismatch at {path}; expected {repo_id}@{revision}."
        )
    expected = data.get("fileSha256")
    if (
        not isinstance(expected, dict)
        or not expected
        or any(
            not isinstance(name, str)
            or not isinstance(digest, str)
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
            for name, digest in expected.items()
        )
    ):
        raise RuntimeError(
            f"Snapshot marker at {marker} has no valid per-file SHA-256 manifest. "
            "Run --prepare-models first."
        )
    if expected != pinned_file_sha256:
        raise RuntimeError(
            f"Snapshot marker hash manifest mismatch at {path}; "
            "run --prepare-models from the pinned revisions."
        )
    actual = snapshot_file_hashes(path)
    require_pinned_file_hashes(path, actual, pinned_file_sha256)
    return actual


def verify_local_models() -> tuple[dict[str, str], dict[str, str]]:
    chatterbox_file_sha256 = verify_snapshot(
        CHATTERBOX_MODEL_DIR,
        CHATTERBOX_MODEL_ID,
        CHATTERBOX_MODEL_REVISION,
        PINNED_CHATTERBOX_FILE_SHA256,
    )
    missing = [name for name in CHATTERBOX_FILES if not (CHATTERBOX_MODEL_DIR / name).is_file()]
    if missing:
        raise FileNotFoundError("Incomplete Chatterbox snapshot: " + ", ".join(missing))
    asr_file_sha256 = verify_snapshot(
        ASR_MODEL_DIR,
        ASR_MODEL_ID,
        ASR_MODEL_REVISION,
        PINNED_ASR_FILE_SHA256,
    )
    if not (ASR_MODEL_DIR / "model.bin").is_file():
        raise FileNotFoundError(f"Incomplete ASR snapshot: {ASR_MODEL_DIR / 'model.bin'}")
    return chatterbox_file_sha256, asr_file_sha256


def find_git_checkout(source: Path) -> Path | None:
    for candidate in (source, *source.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def verify_chatterbox_code_revision(chatterbox_class: type) -> Path:
    module_path = Path(inspect.getfile(chatterbox_class)).resolve()
    checkout = find_git_checkout(module_path.parent)
    if checkout is None:
        raise RuntimeError(
            "Chatterbox must be installed editable from the pinned official Git checkout."
        )
    result = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    revision = result.stdout.strip().lower()
    if revision != CHATTERBOX_CODE_REVISION:
        raise RuntimeError(
            f"Chatterbox code revision mismatch: {revision}; "
            f"expected {CHATTERBOX_CODE_REVISION}."
        )
    status = subprocess.run(
        ["git", "-C", str(checkout), "status", "--porcelain=v1", "--untracked-files=all"],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if status.stdout.strip():
        raise RuntimeError(
            "Chatterbox checkout has local changes; generation requires a clean pinned checkout:\n"
            + status.stdout.rstrip()
        )
    return checkout


def controls_for(block: NarrationBlock, candidate: int) -> InferenceControls:
    profiles = (
        (0.62, 0.38, 0.76, 1.20, 0.05, 1.00),
        (0.72, 0.30, 0.82, 1.24, 0.06, 0.98),
        (0.56, 0.44, 0.72, 1.18, 0.04, 1.00),
        (0.68, 0.34, 0.79, 1.22, 0.05, 0.96),
    )
    exaggeration, cfg_weight, temperature, repetition, min_p, top_p = profiles[
        (candidate - 1) % len(profiles)
    ]
    return InferenceControls(
        seed=20_260_828 + block.number * 100 + candidate * 13,
        repetition_penalty=repetition,
        min_p=min_p,
        top_p=top_p,
        exaggeration=exaggeration,
        cfg_weight=cfg_weight,
        temperature=temperature,
    )


def candidate_request_sha256(
    block: NarrationBlock,
    controls: InferenceControls,
    reference_audio_sha256: str,
    reference_text_sha256: str,
    tts_device: str,
    model_file_sha256: dict[str, str],
) -> str:
    payload = {
        "schemaVersion": "chatterbox-candidate-request-v2",
        "engine": {
            "repository": CHATTERBOX_REPOSITORY,
            "codeRevision": CHATTERBOX_CODE_REVISION,
            "model": CHATTERBOX_MODEL_ID,
            "modelRevision": CHATTERBOX_MODEL_REVISION,
            "modelFileSha256": model_file_sha256,
            "modelSnapshotSha256": combined_file_sha256(model_file_sha256),
        },
        "text": block.text,
        "requiredPhrases": list(block.required_phrases),
        "inferenceControls": asdict(controls),
        "device": tts_device,
        "referenceAudioSha256": reference_audio_sha256,
        "referenceTextSha256": reference_text_sha256,
        "postProcessing": {
            "trimTopDb": TRIM_TOP_DB,
            "trimMarginSeconds": TRIM_MARGIN_SECONDS,
            "container": "wav",
            "subtype": "PCM_24",
        },
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def normalise_words(text: str) -> list[str]:
    value = text.lower()
    # Only typography and proper-name spelling are canonicalized. There are no
    # phonetic substitutions (for example, "note" must never become "node").
    value = re.sub(r"\btool[\s-]*braid\b", "tool braid", value)
    value = re.sub(r"\bweb[\s-]*m\s*c\s*p\b", "web m c p", value)
    number_words = {
        "1": ["one"],
        "2": ["two"],
        "4": ["four"],
        "6": ["six"],
        "7": ["seven"],
        "9": ["nine"],
        "54": ["fifty", "four"],
        "1841": ["eighteen", "forty", "one"],
    }
    return [
        part
        for word in re.findall(r"[a-z0-9]+", value)
        for part in number_words.get(word, [word])
    ]


def strict_phrase_tokens(text: str) -> list[str]:
    value = text.lower()
    # Treat only proper-name spacing as typography so "WebMCP" and
    # "web M C P" remain the same critical phrase.
    value = re.sub(r"\btool[\s-]*braid\b", "tool braid", value)
    value = re.sub(r"\bweb[\s-]*m\s*c\s*p\b", "web m c p", value)
    number_words = {
        "1": ["one"],
        "2": ["two"],
        "4": ["four"],
        "6": ["six"],
        "7": ["seven"],
        "9": ["nine"],
        "54": ["fifty", "four"],
        "1841": ["eighteen", "forty", "one"],
    }
    return [
        part
        for word in re.findall(r"[a-z0-9]+", value)
        for part in number_words.get(word, [word])
    ]


def contains_contiguous_phrase(transcript: str, phrase: str) -> bool:
    words = strict_phrase_tokens(transcript)
    required = strict_phrase_tokens(phrase)
    width = len(required)
    return any(words[index:index + width] == required for index in range(len(words) - width + 1))


def missing_required_phrases(block: NarrationBlock, transcript: str) -> list[str]:
    return [
        phrase
        for phrase in block.required_phrases
        if not contains_contiguous_phrase(transcript, phrase)
    ]


def word_error_rate(reference: str, hypothesis: str) -> float:
    expected = normalise_words(reference)
    actual = normalise_words(hypothesis)
    previous = list(range(len(actual) + 1))
    for row, left in enumerate(expected, 1):
        current = [row]
        for column, right in enumerate(actual, 1):
            current.append(min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + (left != right),
            ))
        previous = current
    return previous[-1] / max(1, len(expected))


def trim_speech(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    mono = np.asarray(audio, dtype=np.float32).reshape(-1)
    _, bounds = librosa.effects.trim(
        mono,
        top_db=TRIM_TOP_DB,
        frame_length=2048,
        hop_length=256,
    )
    margin = round(TRIM_MARGIN_SECONDS * sample_rate)
    left = max(0, int(bounds[0]) - margin)
    right = min(len(mono), int(bounds[1]) + margin)
    return mono[left:right]


def seed_inference(controls: InferenceControls, torch_module: object) -> None:
    random.seed(controls.seed)
    np.random.seed(controls.seed)
    torch_module.manual_seed(controls.seed)
    if torch_module.cuda.is_available():
        torch_module.cuda.manual_seed_all(controls.seed)


def synthesize(model: object, block: NarrationBlock, controls: InferenceControls, path: Path) -> None:
    import torch

    seed_inference(controls, torch)
    with torch.inference_mode():
        waveform = model.generate(
            block.text,
            repetition_penalty=controls.repetition_penalty,
            min_p=controls.min_p,
            top_p=controls.top_p,
            audio_prompt_path=str(REFERENCE_AUDIO),
            exaggeration=controls.exaggeration,
            cfg_weight=controls.cfg_weight,
            temperature=controls.temperature,
        )
    audio = waveform.detach().cpu().numpy().reshape(-1).astype(np.float32)
    audio = trim_speech(audio, model.sr)
    sf.write(path, audio, model.sr, subtype="PCM_24")


def transcribe(asr: WhisperModel, path: Path) -> str:
    segments, _ = asr.transcribe(
        str(path),
        language=ASR_SETTINGS["language"],
        beam_size=ASR_SETTINGS["beamSize"],
        vad_filter=ASR_SETTINGS["vadFilter"],
        condition_on_previous_text=ASR_SETTINGS["conditionOnPreviousText"],
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


def acoustic_report(audio: np.ndarray, sample_rate: int) -> dict[str, float]:
    frame = max(1, round(sample_rate * 0.02))
    frame_count = max(1, len(audio) // frame)
    framed = audio[:frame_count * frame].reshape(frame_count, frame)
    rms = np.sqrt(np.mean(framed * framed, axis=1) + 1e-12)
    peak_rms = float(np.max(rms))
    voiced = rms > peak_rms * 0.025
    if not np.any(voiced):
        return {"dynamicRangeDb": 0.0, "silenceRatio": 1.0, "energyMotion": 0.0}
    dynamic = 20.0 * math.log10(
        (float(np.percentile(rms[voiced], 90)) + 1e-9)
        / (float(np.percentile(rms[voiced], 10)) + 1e-9)
    )
    log_rms = 20.0 * np.log10(rms + 1e-9)
    return {
        "dynamicRangeDb": round(dynamic, 3),
        "silenceRatio": round(float(np.mean(rms < peak_rms * 0.025)), 4),
        "energyMotion": round(float(np.mean(np.abs(np.diff(log_rms)))), 3),
    }


def generate_candidates(
    model: object,
    asr: WhisperModel,
    candidate_count: int,
    regenerate_blocks: set[int],
    tts_device: str,
    model_file_sha256: dict[str, str],
) -> list[dict]:
    reference_audio_sha256 = sha256_file(REFERENCE_AUDIO)
    reference_text_sha256 = sha256_file(REFERENCE_TEXT)
    reports: list[dict] = []
    for block in BLOCKS:
        candidates: list[dict] = []
        for candidate in range(1, candidate_count + 1):
            controls = controls_for(block, candidate)
            path = WORK / f"chatterbox-block-{block.number:02d}-candidate-{candidate}.wav"
            cache_path = path.with_suffix(".cache.json")
            request_sha256 = candidate_request_sha256(
                block,
                controls,
                reference_audio_sha256,
                reference_text_sha256,
                tts_device,
                model_file_sha256,
            )
            started = time.perf_counter()
            cache: dict = {}
            if cache_path.is_file():
                try:
                    cache = json.loads(cache_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    cache = {}
            reused = (
                block.number not in regenerate_blocks
                and path.is_file()
                and path.stat().st_size > 44
                and cache.get("requestSha256") == request_sha256
                and cache.get("audioSha256") == sha256_file(path)
            )
            if not reused:
                synthesize(model, block, controls, path)
                write_json(cache_path, {
                    "schemaVersion": "chatterbox-candidate-cache-v2",
                    "requestSha256": request_sha256,
                    "audioSha256": sha256_file(path),
                })
            audio, sample_rate = sf.read(path, dtype="float32")
            audio = np.asarray(audio, dtype=np.float32).reshape(-1)
            transcript = transcribe(asr, path)
            duration = len(audio) / sample_rate
            wer = word_error_rate(block.text, transcript)
            missing_phrases = missing_required_phrases(block, transcript)
            stretch_rate = max(1.0, duration / block.available_seconds)
            acoustics = acoustic_report(audio, sample_rate)
            fit_penalty = abs(duration - block.available_seconds * 0.90) / max(
                1.0, block.available_seconds
            )
            overflow_penalty = max(0.0, stretch_rate - MAX_STRETCH_RATE) * 25.0
            dynamics_penalty = abs(acoustics["dynamicRangeDb"] - 20.0) / 80.0
            phrase_penalty = len(missing_phrases) * 100.0
            score = wer * 8.0 + fit_penalty + overflow_penalty + dynamics_penalty + phrase_penalty
            candidates.append({
                "candidate": candidate,
                "controls": asdict(controls),
                "path": str(path.relative_to(ROOT)),
                "sha256": sha256_file(path),
                "durationSeconds": round(duration, 3),
                "requiredStretchRate": round(stretch_rate, 4),
                "transcript": transcript,
                "wer": round(wer, 4),
                "missingRequiredPhrases": missing_phrases,
                "acoustics": acoustics,
                "selectionScore": round(score, 4),
                "generationSeconds": round(time.perf_counter() - started, 3),
                "reusedExistingCandidate": reused,
                "cacheRequestSha256": request_sha256,
            })
            print(
                f"block {block.number} candidate {candidate}: {duration:.2f}s "
                f"WER={wer:.4f} missing_phrases={len(missing_phrases)} "
                f"stretch={stretch_rate:.4f}",
                flush=True,
            )
        valid = [
            item for item in candidates
            if item["wer"] <= MAX_WER
            and not item["missingRequiredPhrases"]
            and item["requiredStretchRate"] <= MAX_STRETCH_RATE
        ]
        if not valid:
            raise RuntimeError(
                f"No valid Chatterbox candidate for block {block.number}; inspect {candidates!r}"
            )
        selected = min(valid, key=lambda item: item["selectionScore"])
        selected_path = WORK / f"chatterbox-block-{block.number:02d}.wav"
        shutil.copy2(ROOT / selected["path"], selected_path)
        reports.append({
            "block": block.number,
            "start": block.start,
            "end": block.end,
            "text": block.text,
            "requiredPhrases": list(block.required_phrases),
            "selectedCandidate": selected["candidate"],
            "selectedPath": str(selected_path.relative_to(ROOT)),
            "selectedSha256": sha256_file(selected_path),
            "candidates": candidates,
        })
    return reports


def caption_chunks(text: str, maximum_words: int = 10) -> list[str]:
    chunks: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        words = sentence.split()
        while words:
            take = min(maximum_words, len(words))
            punctuation = [
                index + 1
                for index, word in enumerate(words[:take])
                if word.endswith((",", ":", ";"))
            ]
            if len(words) > maximum_words and punctuation and punctuation[-1] >= 5:
                take = punctuation[-1]
            chunks.append(" ".join(words[:take]))
            words = words[take:]
    return chunks


def assemble_master(block_reports: list[dict]) -> tuple[np.ndarray, list[dict], list[dict]]:
    master = np.zeros(round(MASTER_SECONDS * MASTER_SR), dtype=np.float32)
    captions: list[dict] = []
    placements: list[dict] = []
    for block, report in zip(BLOCKS, block_reports, strict=True):
        audio, sample_rate = sf.read(ROOT / report["selectedPath"], dtype="float32")
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        if sample_rate != MASTER_SR:
            divisor = math.gcd(sample_rate, MASTER_SR)
            audio = resample_poly(
                audio,
                MASTER_SR // divisor,
                sample_rate // divisor,
            ).astype(np.float32)
        source_duration = len(audio) / MASTER_SR
        stretch_rate = max(1.0, source_duration / block.available_seconds)
        if stretch_rate > MAX_STRETCH_RATE:
            raise RuntimeError(
                f"Block {block.number} requires {stretch_rate:.4f}x time compression."
            )
        if stretch_rate > 1.0:
            audio = librosa.effects.time_stretch(audio, rate=stretch_rate).astype(np.float32)
        rms = float(np.sqrt(np.mean(audio * audio))) if len(audio) else 0.0
        if rms > 0:
            audio *= np.float32(10 ** ((-22.0 - 20.0 * math.log10(rms)) / 20.0))
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        if peak > 0.92:
            audio *= np.float32(0.92 / peak)
        placed_start = block.start + 0.18
        start_sample = round(placed_start * MASTER_SR)
        end_sample = min(len(master), start_sample + len(audio))
        master[start_sample:end_sample] += audio[:end_sample - start_sample]
        placed_end = end_sample / MASTER_SR
        chunks = caption_chunks(block.text)
        weights = np.asarray([len(normalise_words(chunk)) for chunk in chunks], dtype=float)
        durations = (placed_end - placed_start) * weights / weights.sum()
        cursor = placed_start
        for chunk, duration in zip(chunks, durations, strict=True):
            captions.append({
                "start": round(cursor, 3),
                "end": round(cursor + float(duration), 3),
                "text": chunk,
                "block": block.number,
            })
            cursor += float(duration)
        placements.append({
            "block": block.number,
            "sourceDurationSeconds": round(source_duration, 3),
            "stretchRate": round(stretch_rate, 4),
            "placedStart": round(placed_start, 3),
            "placedEnd": round(placed_end, 3),
        })
    return master, captions, placements


def srt_time(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_outputs(
    master: np.ndarray,
    captions: list[dict],
    block_reports: list[dict],
    placements: list[dict],
    elapsed_seconds: float,
    code_checkout: Path,
    asr_device: str,
    model_file_sha256: dict[str, str],
    asr_file_sha256: dict[str, str],
) -> dict:
    stereo = np.column_stack((master, master))
    sf.write(MASTER, stereo, MASTER_SR, subtype="PCM_24")
    write_json(CAPTIONS, captions)
    srt_lines: list[str] = []
    for index, cue in enumerate(captions, 1):
        srt_lines.extend([
            str(index),
            f"{srt_time(cue['start'])} --> {srt_time(cue['end'])}",
            cue["text"],
            "",
        ])
    SRT.write_text("\n".join(srt_lines), encoding="utf-8")
    selected = [
        candidate
        for block in block_reports
        for candidate in block["candidates"]
        if candidate["candidate"] == block["selectedCandidate"]
    ]
    report = {
        "schemaVersion": "3.1",
        "status": "PASS",
        "engine": {
            "name": "Resemble AI Chatterbox (original English)",
            "repository": CHATTERBOX_REPOSITORY,
            "codeRevision": CHATTERBOX_CODE_REVISION,
            "codeCheckout": str(code_checkout),
            "model": CHATTERBOX_MODEL_ID,
            "modelRevision": CHATTERBOX_MODEL_REVISION,
            "modelPath": str(CHATTERBOX_MODEL_DIR.relative_to(ROOT)),
            "modelFileSha256": model_file_sha256,
            "modelSnapshotSha256": combined_file_sha256(model_file_sha256),
            "license": "MIT",
            "generationNetworkMode": "local-only",
            "perthWatermark": True,
        },
        "asr": {
            "model": ASR_MODEL_ID,
            "revision": ASR_MODEL_REVISION,
            "modelPath": str(ASR_MODEL_DIR.relative_to(ROOT)),
            "modelFileSha256": asr_file_sha256,
            "modelSnapshotSha256": combined_file_sha256(asr_file_sha256),
            "device": asr_device,
            **ASR_SETTINGS,
        },
        "reference": {
            "audioPath": str(REFERENCE_AUDIO.relative_to(ROOT)),
            "audioSha256": sha256_file(REFERENCE_AUDIO),
            "textPath": str(REFERENCE_TEXT.relative_to(ROOT)),
            "textSha256": sha256_file(REFERENCE_TEXT),
            "ownerAuthorized": True,
            "uploadedToHostedService": False,
        },
        "qualityGates": {
            "maxWer": MAX_WER,
            "maxStretchRate": MAX_STRETCH_RATE,
            "minimumCandidatesPerBlock": MIN_CANDIDATES,
            "requiredPhrasesMustBeContiguous": True,
        },
        "master": {
            "path": str(MASTER.relative_to(ROOT)),
            "sha256": sha256_file(MASTER),
            "sampleRate": MASTER_SR,
            "channels": 2,
            "durationSeconds": MASTER_SECONDS,
        },
        "meanWer": round(float(np.mean([item["wer"] for item in selected])), 4),
        "maxWer": round(float(np.max([item["wer"] for item in selected])), 4),
        "maxStretchRate": round(max(item["stretchRate"] for item in placements), 4),
        "missingRequiredPhrases": sorted({
            phrase
            for item in selected
            for phrase in item["missingRequiredPhrases"]
        }),
        "placements": placements,
        "blocks": block_reports,
        "elapsedSeconds": round(elapsed_seconds, 3),
    }
    if (
        report["maxWer"] > MAX_WER
        or report["maxStretchRate"] > MAX_STRETCH_RATE
        or report["missingRequiredPhrases"]
    ):
        report["status"] = "FAIL"
    write_json(QC_REPORT, report)
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--prepare-models",
        action="store_true",
        help="Download only public model assets at their pinned revisions, then exit.",
    )
    parser.add_argument("--candidates", type=int, default=2)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--asr-device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument(
        "--regenerate-block",
        action="append",
        type=int,
        default=[],
        choices=tuple(block.number for block in BLOCKS),
        help="Regenerate every candidate for this block instead of reusing its cache.",
    )
    args = parser.parse_args()
    if args.candidates < MIN_CANDIDATES or args.candidates > 4:
        parser.error(f"--candidates must be between {MIN_CANDIDATES} and 4")
    return args


def main() -> int:
    args = parse_args()
    if args.prepare_models:
        prepare_models()
        return 0
    missing = [path for path in (REFERENCE_AUDIO, REFERENCE_TEXT) if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing private voice input(s): " + ", ".join(map(str, missing)))
    model_file_sha256, asr_file_sha256 = verify_local_models()
    from chatterbox.tts import ChatterboxTTS

    code_checkout = verify_chatterbox_code_revision(ChatterboxTTS)
    WORK.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    model = ChatterboxTTS.from_local(CHATTERBOX_MODEL_DIR, device=args.device)
    asr_compute_type = "float16" if args.asr_device == "cuda" else "int8"
    asr = WhisperModel(
        str(ASR_MODEL_DIR),
        device=args.asr_device,
        compute_type=asr_compute_type,
    )
    block_reports = generate_candidates(
        model,
        asr,
        args.candidates,
        set(args.regenerate_block),
        args.device,
        model_file_sha256,
    )
    master, captions, placements = assemble_master(block_reports)
    report = write_outputs(
        master,
        captions,
        block_reports,
        placements,
        time.perf_counter() - started,
        code_checkout,
        args.asr_device,
        model_file_sha256,
        asr_file_sha256,
    )
    print(json.dumps({
        "status": report["status"],
        "master": str(MASTER),
        "meanWer": report["meanWer"],
        "maxWer": report["maxWer"],
        "maxStretchRate": report["maxStretchRate"],
        "missingRequiredPhrases": report["missingRequiredPhrases"],
    }, indent=2))
    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
