#!/usr/bin/env python3
"""Transcribe the locked narration master and build word-level captions offline.

Run this only after ``work/narration-master-final.wav`` is the final mastered
IndexTTS 2.5 take. The pinned faster-whisper snapshot is loaded exclusively from
the local project model directory; no network fallback is permitted.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"

import soundfile as sf  # noqa: E402
import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
VIDEO = ROOT / "video-production"
WORK = VIDEO / "work"
MASTER = WORK / "narration-master-final.wav"
GENERATION_REPORT = WORK / "indextts25-generation-report.json"
WORD_TIMESTAMPS = WORK / "narration-word-timestamps.json"
SRT_OUTPUT = WORK / "ToolBraid-WebMCP-Challenge.en.srt"
TRANSCRIPTION_REPORT = WORK / "narration-transcription-report.json"

MODEL_ID = "Systran/faster-whisper-medium.en"
MODEL_REVISION = "a29b04bd15381511a9af671baec01072039215e3"
MODEL_DIR = VIDEO / "models" / f"faster-whisper-medium-en-{MODEL_REVISION[:12]}"
PINNED_MODEL_SHA256 = {
    ".gitattributes": "db7c0371f46f0840b8f25794c1e3321c9b5820a8cb6ba9694a46fc64b8fae5a6",
    "README.md": "ab3ddd3b6af4ea0ef353cb80004f26613ba33217f81652fc13738d3b098c7675",
    "config.json": "4a1848ebabe7938d9797c15a2e8e4ce1d36e6fd4a43d096ae5955257c67c7962",
    "model.bin": "11b220779aea4c6f3ce9d2549c8a95ea869ed84066864b999531ef53e594fe5b",
    "tokenizer.json": "929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df",
    "vocabulary.txt": "ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf",
}

MAX_WER = 0.08
MAX_SEGMENT_WER = 0.08
MAX_CONSECUTIVE_ERRORS = 2
MAX_CUE_WORDS = 9
MAX_CUE_SECONDS = 2.8
MAX_WORD_CUE_SECONDS = 1.2
PAUSE_BOUNDARY_SECONDS = 0.55
MAX_PAUSES_750MS = 1
MAX_PAUSES_1500MS = 0
TERMINAL_PUNCTUATION = re.compile(r"[.!?][\"')\]]*$")


@dataclass(frozen=True)
class TimedWord:
    index: int
    segment_index: int
    text: str
    start: float
    end: float
    probability: float | None


@dataclass(frozen=True)
class CaptionCue:
    index: int
    text: str
    start: float
    end: float
    word_start_index: int
    word_end_index: int


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def atomic_write_text(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(content, encoding="utf-8", newline="\n")
    os.replace(temporary, path)


def verify_local_model() -> dict[str, str]:
    if not MODEL_DIR.is_dir():
        raise FileNotFoundError(f"Pinned local ASR model is missing: {MODEL_DIR}")
    actual: dict[str, str] = {}
    for relative, expected in PINNED_MODEL_SHA256.items():
        path = MODEL_DIR / relative
        if not path.is_file():
            raise FileNotFoundError(f"Incomplete pinned ASR snapshot: {path}")
        digest = sha256_file(path)
        if digest != expected:
            raise RuntimeError(
                f"Pinned ASR model hash mismatch for {relative}: {digest} != {expected}"
            )
        actual[relative] = digest
    return actual


def load_expected_narration() -> tuple[str, dict[str, Any]]:
    if not GENERATION_REPORT.is_file():
        raise FileNotFoundError(GENERATION_REPORT)
    report = json.loads(GENERATION_REPORT.read_text(encoding="utf-8"))
    if report.get("status") not in {"PASS", "PASS_REQUIRES_DECLIP"}:
        raise RuntimeError("IndexTTS generation report is not an accepted status")
    narration = report.get("narration")
    if not isinstance(narration, dict):
        raise ValueError("Generation report has no narration object")
    text = narration.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Generation report narration.text is empty")
    return text.strip(), report


def validate_master() -> dict[str, Any]:
    if not MASTER.is_file():
        raise FileNotFoundError(
            f"Final narration master does not exist yet: {MASTER}. "
            "Do not run this script until picture-lock narration is finalized."
        )
    info = sf.info(MASTER)
    if info.frames <= 0 or info.samplerate <= 0 or info.channels <= 0:
        raise ValueError(f"Invalid narration master: {info}")
    return {
        "path": str(MASTER.relative_to(ROOT)),
        "sha256": sha256_file(MASTER),
        "durationSeconds": info.frames / info.samplerate,
        "sampleRate": info.samplerate,
        "channels": info.channels,
        "format": info.format,
        "subtype": info.subtype,
    }


def normalized_words(text: str) -> list[str]:
    value = text.lower().replace("’", "'")
    value = re.sub(r"\btool[\s-]*braid\b", "tool braid", value)
    value = re.sub(r"\bweb[\s-]*m\s*c\s*p\b", "web m c p", value)
    value = re.sub(r"\bs\s*h\s*a[\s-]*(?:2|two)[\s-]*(?:56|fifty[\s-]*six)\b", "s h a two fifty six", value)
    value = re.sub(r"\bs\s*h\s*a\b", "s h a", value)
    replacements = {
        "54": "fifty four",
        "1841": "eighteen forty one",
        "256": "two fifty six",
        "9": "nine",
    }
    for number, spoken in replacements.items():
        value = re.sub(rf"\b{number}\b", spoken, value)
    value = re.sub(r"\bfifty[\s-]*four\b", "fifty four", value)
    value = re.sub(r"\beighteen[\s-]*forty[\s-]*one\b", "eighteen forty one", value)
    value = re.sub(r"\btwo[\s-]*fifty[\s-]*six\b", "two fifty six", value)
    return re.findall(r"[a-z0-9]+", value)


def word_error_report(reference_text: str, hypothesis_text: str) -> tuple[float, int, int]:
    reference = normalized_words(reference_text)
    hypothesis = normalized_words(hypothesis_text)
    rows = len(reference) + 1
    columns = len(hypothesis) + 1
    matrix = [[0] * columns for _ in range(rows)]
    for row in range(rows):
        matrix[row][0] = row
    for column in range(columns):
        matrix[0][column] = column
    for row in range(1, rows):
        for column in range(1, columns):
            substitution = matrix[row - 1][column - 1] + (
                reference[row - 1] != hypothesis[column - 1]
            )
            matrix[row][column] = min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                substitution,
            )
    operations: list[str] = []
    row = len(reference)
    column = len(hypothesis)
    while row or column:
        if (
            row
            and column
            and matrix[row][column]
            == matrix[row - 1][column - 1]
            + (reference[row - 1] != hypothesis[column - 1])
        ):
            operations.append("match" if reference[row - 1] == hypothesis[column - 1] else "sub")
            row -= 1
            column -= 1
        elif row and matrix[row][column] == matrix[row - 1][column] + 1:
            operations.append("del")
            row -= 1
        else:
            operations.append("ins")
            column -= 1
    longest_error_run = 0
    active_run = 0
    for operation in reversed(operations):
        if operation == "match":
            longest_error_run = max(longest_error_run, active_run)
            active_run = 0
        else:
            active_run += 1
    longest_error_run = max(longest_error_run, active_run)
    edits = matrix[-1][-1]
    return edits / max(1, len(reference)), edits, longest_error_run


def align_expected_words(
    expected_text: str,
    asr_words: list[TimedWord],
) -> tuple[list[TimedWord], dict[str, Any]]:
    """Bind approved surface text to ASR timings without publishing ASR spelling errors."""
    surface_tokens = expected_text.split()
    reference_units: list[str] = []
    reference_to_surface: list[int] = []
    for surface_index, token in enumerate(surface_tokens):
        units = normalized_words(token)
        if not units:
            continue
        reference_units.extend(units)
        reference_to_surface.extend([surface_index] * len(units))

    hypothesis_units: list[str] = []
    hypothesis_to_word: list[int] = []
    for word_index, word in enumerate(asr_words):
        units = normalized_words(word.text)
        hypothesis_units.extend(units)
        hypothesis_to_word.extend([word_index] * len(units))

    rows = len(reference_units) + 1
    columns = len(hypothesis_units) + 1
    matrix = [[0] * columns for _ in range(rows)]
    for row in range(rows):
        matrix[row][0] = row
    for column in range(columns):
        matrix[0][column] = column
    for row in range(1, rows):
        for column in range(1, columns):
            substitution = matrix[row - 1][column - 1] + (
                reference_units[row - 1] != hypothesis_units[column - 1]
            )
            matrix[row][column] = min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                substitution,
            )

    unit_mapping: dict[int, int] = {}
    row = len(reference_units)
    column = len(hypothesis_units)
    while row or column:
        if row and column:
            substitution_cost = reference_units[row - 1] != hypothesis_units[column - 1]
            if matrix[row][column] == matrix[row - 1][column - 1] + substitution_cost:
                unit_mapping[row - 1] = column - 1
                row -= 1
                column -= 1
                continue
        if row and matrix[row][column] == matrix[row - 1][column] + 1:
            row -= 1
        else:
            column -= 1

    surface_to_asr: list[list[int]] = [[] for _ in surface_tokens]
    for reference_index, hypothesis_index in unit_mapping.items():
        surface_index = reference_to_surface[reference_index]
        word_index = hypothesis_to_word[hypothesis_index]
        if word_index not in surface_to_asr[surface_index]:
            surface_to_asr[surface_index].append(word_index)

    aligned: list[TimedWord] = []
    unmatched: list[int] = []
    for surface_index, token in enumerate(surface_tokens):
        mapped = sorted(surface_to_asr[surface_index])
        if mapped:
            source = [asr_words[index] for index in mapped]
            probabilities = [word.probability for word in source if word.probability is not None]
            aligned.append(
                TimedWord(
                    index=surface_index,
                    segment_index=source[0].segment_index,
                    text=f" {token}",
                    start=min(word.start for word in source),
                    end=max(word.end for word in source),
                    probability=(sum(probabilities) / len(probabilities)) if probabilities else None,
                )
            )
            continue

        unmatched.append(surface_index)
        previous_end = aligned[-1].end if aligned else asr_words[0].start
        next_mapped = next(
            (indices for indices in surface_to_asr[surface_index + 1 :] if indices),
            None,
        )
        next_start = asr_words[min(next_mapped)].start if next_mapped else asr_words[-1].end
        start = min(previous_end, next_start)
        end = max(start + 0.12, next_start)
        aligned.append(
            TimedWord(
                index=surface_index,
                segment_index=aligned[-1].segment_index if aligned else 0,
                text=f" {token}",
                start=start,
                end=end,
                probability=None,
            )
        )

    return aligned, {
        "method": "minimum-edit-approved-text-to-asr-timings",
        "approvedSurfaceWordCount": len(surface_tokens),
        "asrWordCount": len(asr_words),
        "normalizedReferenceUnits": len(reference_units),
        "normalizedHypothesisUnits": len(hypothesis_units),
        "unmatchedSurfaceWordIndexes": unmatched,
        "publishedTextIsApprovedNarration": True,
    }


def transcribe_words(model: WhisperModel) -> tuple[list[TimedWord], str, dict[str, Any]]:
    segments, info = model.transcribe(
        str(MASTER),
        language="en",
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        word_timestamps=True,
    )
    words: list[TimedWord] = []
    segment_text: list[str] = []
    for segment_index, segment in enumerate(segments):
        segment_text.append(segment.text.strip())
        if segment.words is None:
            raise RuntimeError(f"Segment {segment_index} returned no word timestamps")
        for source_word in segment.words:
            if source_word.start is None or source_word.end is None:
                raise RuntimeError(
                    f"Word {len(words)} in segment {segment_index} has an incomplete timestamp"
                )
            start = float(source_word.start)
            end = float(source_word.end)
            if start < 0.0 or end < start:
                raise RuntimeError(
                    f"Invalid word timestamp at index {len(words)}: {start}..{end}"
                )
            probability = (
                float(source_word.probability)
                if source_word.probability is not None
                else None
            )
            words.append(
                TimedWord(
                    index=len(words),
                    segment_index=segment_index,
                    text=source_word.word,
                    start=start,
                    end=end,
                    probability=probability,
                )
            )
    if not words:
        raise RuntimeError("ASR returned no word timestamps")
    transcript = " ".join(part for part in segment_text if part).strip()
    metadata = {
        "language": info.language,
        "languageProbability": float(info.language_probability),
        "durationSeconds": float(info.duration),
        "durationAfterVadSeconds": float(info.duration_after_vad),
        "segmentCount": len(segment_text),
    }
    return words, transcript, metadata


def transcribe_text(model: WhisperModel, path: Path) -> str:
    segments, _ = model.transcribe(
        str(path),
        language="en",
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        word_timestamps=False,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


def audio_pause_metrics(path: Path) -> dict[str, float | int]:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    mono = np.mean(audio, axis=1, dtype=np.float64)
    frame_seconds = 0.02
    frame_samples = max(1, round(frame_seconds * sample_rate))
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
        "pausesAtLeast750ms": int(sum(value >= 0.75 for value in internal)),
        "pausesAtLeast1500ms": int(sum(value >= 1.5 for value in internal)),
        "longestInternalPauseSeconds": round(max(internal, default=0.0), 3),
    }


def render_cue_text(words: list[TimedWord]) -> str:
    text = "".join(word.text for word in words).strip()
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\s+", " ", text)
    return text


def cue_word_end(word: TimedWord, master_duration: float) -> float:
    return min(word.end, word.start + MAX_WORD_CUE_SECONDS, master_duration)


def build_cues(
    words: list[TimedWord],
    master_duration: float,
) -> tuple[list[CaptionCue], list[dict[str, float | int]]]:
    grouped: list[list[TimedWord]] = []
    active: list[TimedWord] = []

    def close_active() -> None:
        nonlocal active
        if active:
            grouped.append(active)
            active = []

    for word in words:
        if active:
            pause = word.start - cue_word_end(active[-1], master_duration)
            proposed_duration = cue_word_end(word, master_duration) - active[0].start
            if (
                pause > PAUSE_BOUNDARY_SECONDS
                or len(active) >= MAX_CUE_WORDS
                or proposed_duration > MAX_CUE_SECONDS
            ):
                close_active()
        active.append(word)
        if TERMINAL_PUNCTUATION.search(word.text.strip()):
            close_active()
    close_active()

    # ASR can assign a punctuation-bearing final word an effectively zero-length
    # timestamp. Rebalance that orphan with the tail of the previous cue so the
    # approved phrase remains readable instead of flashing for one frame.
    for index in range(1, len(grouped)):
        group = grouped[index]
        previous = grouped[index - 1]
        previous_end = cue_word_end(previous[-1], master_duration)
        duration = cue_word_end(group[-1], master_duration) - max(
            group[0].start,
            previous_end,
        )
        if duration >= 0.35:
            continue
        if len(previous) + len(group) <= MAX_CUE_WORDS:
            grouped[index - 1] = previous + group
            grouped[index] = []
            continue
        transferable = min(4, len(previous) - 1, MAX_CUE_WORDS - len(group))
        if transferable > 0:
            grouped[index - 1] = previous[:-transferable]
            grouped[index] = previous[-transferable:] + group
    grouped = [group for group in grouped if group]

    cues: list[CaptionCue] = []
    adjustments: list[dict[str, float | int]] = []
    previous_end = 0.0
    for group in grouped:
        start = min(max(group[0].start, previous_end), master_duration)
        raw_end = group[-1].end
        effective_end = cue_word_end(group[-1], master_duration)
        end = max(effective_end, start + 0.001)
        if end - start > MAX_CUE_SECONDS:
            end = start + MAX_CUE_SECONDS
        if raw_end != effective_end:
            adjustments.append(
                {
                    "wordIndex": group[-1].index,
                    "rawStartSeconds": group[-1].start,
                    "rawEndSeconds": raw_end,
                    "captionEndSeconds": effective_end,
                }
            )
        cue = CaptionCue(
            index=len(cues) + 1,
            text=render_cue_text(group),
            start=start,
            end=end,
            word_start_index=group[0].index,
            word_end_index=group[-1].index,
        )
        if not cue.text:
            raise RuntimeError(f"Caption cue {cue.index} has no text")
        if cue.end - cue.start > MAX_CUE_SECONDS + 1e-9:
            raise RuntimeError(
                f"Caption cue {cue.index} exceeds {MAX_CUE_SECONDS}s: "
                f"{cue.end - cue.start:.3f}s"
            )
        if cue.word_end_index - cue.word_start_index + 1 > MAX_CUE_WORDS:
            raise RuntimeError(f"Caption cue {cue.index} exceeds {MAX_CUE_WORDS} words")
        if cues and cue.start < cues[-1].end:
            raise RuntimeError(f"Caption cues overlap at index {cue.index}")
        cues.append(cue)
        previous_end = cue.end
    return cues, adjustments


def srt_timestamp(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def render_srt(cues: list[CaptionCue]) -> tuple[str, list[dict[str, Any]]]:
    lines: list[str] = []
    serialized: list[dict[str, Any]] = []
    previous_end_ms = 0
    for cue in cues:
        start_ms = max(round(cue.start * 1000), previous_end_ms)
        end_ms = max(round(cue.end * 1000), start_ms + 1)
        if end_ms - start_ms > round(MAX_CUE_SECONDS * 1000):
            raise RuntimeError(f"Rounded SRT cue {cue.index} exceeds duration limit")
        lines.extend(
            [
                str(cue.index),
                f"{srt_timestamp(start_ms)} --> {srt_timestamp(end_ms)}",
                cue.text,
                "",
            ]
        )
        serialized.append(
            {
                "index": cue.index,
                "text": cue.text,
                "startSeconds": cue.start,
                "endSeconds": cue.end,
                "startMilliseconds": start_ms,
                "endMilliseconds": end_ms,
                "wordStartIndex": cue.word_start_index,
                "wordEndIndex": cue.word_end_index,
            }
        )
        previous_end_ms = end_ms
    return "\n".join(lines), serialized


def main() -> int:
    expected_text, generation_report = load_expected_narration()
    master = validate_master()
    model_hashes = verify_local_model()
    model = WhisperModel(
        str(MODEL_DIR),
        device="cuda",
        compute_type="float16",
        local_files_only=True,
    )
    asr_words, transcript, asr_metadata = transcribe_words(model)
    wer, edit_distance, longest_error_run = word_error_report(expected_text, transcript)
    segment_quality: list[dict[str, Any]] = []
    generation_segments = generation_report.get("segments")
    if not isinstance(generation_segments, list) or not generation_segments:
        raise ValueError("Generation report has no passage-level segment provenance")
    for source_segment in generation_segments:
        raw_value = source_segment.get("rawPath")
        segment_text = source_segment.get("text")
        if not isinstance(raw_value, str) or not isinstance(segment_text, str):
            raise ValueError("Generation segment is missing rawPath or text")
        raw_path = ROOT / raw_value
        if not raw_path.is_file():
            raise FileNotFoundError(raw_path)
        segment_transcript = transcribe_text(model, raw_path)
        segment_wer, segment_edits, segment_error_run = word_error_report(
            segment_text,
            segment_transcript,
        )
        segment_quality.append(
            {
                "segment": int(source_segment["segment"]),
                "sourcePath": raw_value,
                "sourceSha256": sha256_file(raw_path),
                "expectedText": segment_text,
                "hypothesisText": segment_transcript,
                "wer": round(segment_wer, 6),
                "editDistance": segment_edits,
                "longestConsecutiveErrorRun": segment_error_run,
                "pass": segment_wer <= MAX_SEGMENT_WER
                and segment_error_run <= MAX_CONSECUTIVE_ERRORS,
            }
        )
    pause_metrics = audio_pause_metrics(MASTER)
    words, alignment_report = align_expected_words(expected_text, asr_words)
    cues, timestamp_adjustments = build_cues(words, float(master["durationSeconds"]))
    srt, serialized_cues = render_srt(cues)

    word_document = {
        "schemaVersion": "toolbraid-word-timestamps-v1",
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "source": master,
        "model": {
            "id": MODEL_ID,
            "revision": MODEL_REVISION,
            "path": str(MODEL_DIR.relative_to(ROOT)),
        },
        "settings": {
            "language": "en",
            "beamSize": 5,
            "vadFilter": True,
            "vadParameters": {"minSilenceDurationMs": 500},
            "conditionOnPreviousText": False,
            "wordTimestamps": True,
            "networkMode": "local-only",
        },
        "asr": asr_metadata,
        "transcript": transcript,
        "approvedCaptionText": expected_text,
        "wordCount": len(words),
        "words": [
            {
                "index": word.index,
                "segmentIndex": word.segment_index,
                "text": word.text,
                "startSeconds": word.start,
                "endSeconds": word.end,
                "probability": word.probability,
            }
            for word in words
        ],
        "captions": serialized_cues,
        "alignment": alignment_report,
    }
    semantic_pass = (
        wer <= MAX_WER
        and longest_error_run <= MAX_CONSECUTIVE_ERRORS
        and all(bool(segment["pass"]) for segment in segment_quality)
    )
    pauses_pass = (
        int(pause_metrics["pausesAtLeast750ms"]) <= MAX_PAUSES_750MS
        and int(pause_metrics["pausesAtLeast1500ms"]) <= MAX_PAUSES_1500MS
    )
    status = "PASS" if semantic_pass and pauses_pass else "FAIL"
    transcription_report = {
        "schemaVersion": "toolbraid-narration-transcription-v1",
        "status": status,
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "privacy": {
            "networkMode": "local-only",
            "hfHubOffline": os.environ["HF_HUB_OFFLINE"] == "1",
            "transformersOffline": os.environ["TRANSFORMERS_OFFLINE"] == "1",
        },
        "source": master,
        "generationReport": {
            "path": str(GENERATION_REPORT.relative_to(ROOT)),
            "sha256": sha256_file(GENERATION_REPORT),
            "schemaVersion": generation_report.get("schemaVersion"),
        },
        "expected": {
            "text": expected_text,
            "sha256": sha256_text(expected_text),
            "normalizedWordCount": len(normalized_words(expected_text)),
        },
        "hypothesis": {
            "text": transcript,
            "sha256": sha256_text(transcript),
            "normalizedWordCount": len(normalized_words(transcript)),
        },
        "quality": {
            "wer": round(wer, 6),
            "editDistance": edit_distance,
            "longestConsecutiveErrorRun": longest_error_run,
            "maxWer": MAX_WER,
            "maxSegmentWer": MAX_SEGMENT_WER,
            "maxConsecutiveErrors": MAX_CONSECUTIVE_ERRORS,
            "semanticPass": semantic_pass,
            "segmentQuality": segment_quality,
            "wordTimestampCount": len(words),
            "rawAsrWordTimestampCount": len(asr_words),
            "captionCueCount": len(cues),
            "captionAlignment": alignment_report,
            "allWordsTimestamped": True,
            "captionsMonotonic": True,
            "captionOverlaps": 0,
            "maxCueWords": MAX_CUE_WORDS,
            "maxCueSeconds": MAX_CUE_SECONDS,
            "maxWordCueSeconds": MAX_WORD_CUE_SECONDS,
            "pauseBoundarySeconds": PAUSE_BOUNDARY_SECONDS,
            "timestampAdjustments": timestamp_adjustments,
            "pauseMetrics": pause_metrics,
            "maximumPausesAtLeast750ms": MAX_PAUSES_750MS,
            "maximumPausesAtLeast1500ms": MAX_PAUSES_1500MS,
            "pausesPass": pauses_pass,
        },
        "model": {
            "id": MODEL_ID,
            "revision": MODEL_REVISION,
            "path": str(MODEL_DIR.relative_to(ROOT)),
            "fileSha256": model_hashes,
            "device": "cuda",
            "computeType": "float16",
        },
        "outputs": {
            "wordTimestamps": str(WORD_TIMESTAMPS.relative_to(ROOT)),
            "srt": str(SRT_OUTPUT.relative_to(ROOT)),
            "report": str(TRANSCRIPTION_REPORT.relative_to(ROOT)),
            "published": status == "PASS",
        },
        "captions": serialized_cues,
    }

    if status == "PASS":
        atomic_write_text(WORD_TIMESTAMPS, json.dumps(word_document, indent=2) + "\n")
        atomic_write_text(SRT_OUTPUT, srt)
    atomic_write_text(
        TRANSCRIPTION_REPORT,
        json.dumps(transcription_report, indent=2) + "\n",
    )
    print(
        json.dumps(
            {
                "status": status,
                "wer": round(wer, 6),
                "wordTimestamps": len(words),
                "captionCues": len(cues),
                "report": str(TRANSCRIPTION_REPORT),
            },
            indent=2,
        )
    )
    return 0 if status == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
