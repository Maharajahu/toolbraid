#!/usr/bin/env python3
"""Validate the final ToolBraid challenge master and create a visual contact sheet."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import av
import numpy as np
import pyloudnorm as pyln
from PIL import Image, ImageDraw, ImageFont
from scipy.signal import resample_poly


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = SCRIPT_DIR / "output" / "ToolBraid-WebMCP-Challenge-1080p.mp4"
DEFAULT_REPORT = SCRIPT_DIR / "work" / "final-video-validation.json"
DEFAULT_CONTACT_SHEET = SCRIPT_DIR / "work" / "final-video-contact-sheet.jpg"
DEFAULT_CONFIG = SCRIPT_DIR / "render-config.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return payload


def resolve_from_config(config_path: Path, value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = config_path.parent / path
    return path.resolve()


def is_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def normalize_approved_text(value: object) -> str:
    """Normalize presentation-only differences without hiding word substitutions."""
    if not isinstance(value, str):
        return ""
    text = unicodedata.normalize("NFKC", value).casefold().replace("’", "'")
    tokens = re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", text)
    return " ".join(tokens)


def same_path(value: object, expected: Path) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return Path(value).resolve() == expected.resolve()
    except (OSError, RuntimeError):
        return False


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def load_expectations(config_path: Path) -> dict[str, object]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config.get("format") != "toolbraid-final-render-config-v2":
        raise ValueError("Final validation requires toolbraid-final-render-config-v2")
    master = config["master"]
    width = int(master["width"])
    height = int(master["height"])
    fps = float(master["fps"])
    duration = float(master["durationSeconds"])
    sample_rate = int(master["sampleRate"])
    channels = int(master["channels"])
    frame_count_float = duration * fps
    if width <= 0 or height <= 0 or fps <= 0.0 or duration <= 0.0 or sample_rate <= 0:
        raise ValueError("Render config contains non-positive master values")
    if abs(frame_count_float - round(frame_count_float)) > 1e-6:
        raise ValueError("Configured duration and fps do not produce an integer frame count")

    validation = config.get("validation") or {}
    configured_samples = validation.get("sampleTimesSeconds")
    if configured_samples is not None:
        sample_times = tuple(float(value) for value in configured_samples)
        strategy = "config-explicit"
    else:
        sample_count = int(validation.get("sampleCount", 12))
        if sample_count < 2:
            raise ValueError("validation.sampleCount must be at least 2")
        scenes = config.get("scenes") or []
        if len(scenes) != 2:
            raise ValueError("Derived final QC samples require product and outro scenes")
        product_start = float(scenes[0]["start"])
        product_end = float(scenes[0]["end"])
        outro_start = float(scenes[1]["start"])
        outro_end = float(scenes[1]["end"])
        product_sample_count = sample_count - 1
        product_samples = tuple(
            product_start + (product_end - product_start) * (index + 0.5) / product_sample_count
            for index in range(product_sample_count)
        )
        sample_times = (*product_samples, (outro_start + outro_end) / 2.0)
        strategy = "config-scenes-product-centers-plus-outro"
    if not sample_times or any(value < 0.0 or value >= duration for value in sample_times):
        raise ValueError("Configured/derived sample times must fall inside the master duration")

    return {
        "configFormat": config["format"],
        "width": width,
        "height": height,
        "fps": fps,
        "durationSeconds": duration,
        "frameCount": int(round(frame_count_float)),
        "sampleRate": sample_rate,
        "channels": channels,
        "sampleTimesSeconds": sample_times,
        "sampleStrategy": strategy,
    }


def validate_locked_artifacts(
    config: dict[str, Any],
    config_path: Path,
    output_path: Path,
    render_report_path: Path,
) -> tuple[dict[str, bool], dict[str, Any], dict[str, Any]]:
    """Validate the complete sealed chain used to create the final MP4."""
    narration_checks = (
        "narrationSourceHashMatchesConfig",
        "narrationMasterHashMatchesConfig",
        "generationReportHashMatchesConfig",
        "generationReportAccepted",
        "generationReportPremasterHashMatches",
        "masteringReportHashMatchesConfig",
        "masteringReportAccepted",
        "masteringReportInputOutputHashesMatch",
        "masteringValidationPasses",
        "premiumDeclipRequirementSatisfied",
        "masteringDeclaredLimitsSane",
        "masteredLoudnessWithinDeclaredLimit",
        "masteredTruePeakWithinDeclaredLimit",
    )
    caption_checks = (
        "captionSourceHashMatchesMaster",
        "approvedCaptionTextMatchesGeneration",
        "burnedCaptionTextMatchesGeneration",
        "captionAlignmentDeclaresApprovedText",
        "captionTimingAndCoverageValid",
    )
    capture_checks = (
        "captureVideoHashMatchesConfig",
        "captureReportHashMatchesConfig",
        "captureTimelineHashMatchesConfig",
        "captureReportScenarioIsVerified",
        "captureReportVideoHashMatchesSource",
        "captureAuditSealIsValid",
        "captureCursorProvenanceIsValid",
        "captureTimelineIsValid",
        "capturePathsMatchSealedArtifacts",
    )
    render_checks = (
        "renderReportIsFullV2",
        "renderReportConfigHashMatchesFile",
        "renderReportOutputHashMatchesFile",
        "renderReportOutputPathAndSizeMatch",
        "renderReportCaptionHashMatchesFile",
        "renderReportProductHashMatchesConfigAndFile",
        "renderReportNarrationHashesMatchConfigAndFiles",
        "renderReportCaptureHashesMatchConfigAndFiles",
        "renderReportMasterMatchesConfig",
        "renderReportContentMatchesConfig",
        "renderReportCaptionsAreBurnedIn",
    )
    checks = {
        name: False
        for name in (*narration_checks, *caption_checks, *capture_checks, *render_checks)
    }
    evidence: dict[str, Any] = {}
    audio_limits: dict[str, Any] = {"available": False}

    inputs = config.get("inputs")
    if not isinstance(inputs, dict):
        evidence["configuration"] = {"error": "render config inputs must be an object"}
        return checks, evidence, audio_limits

    editing_policy = config.get("editingPolicy")
    required_policy = {
        "interactivePlayback": "linear-1x",
        "allowInteractiveReplay": False,
        "allowInteractiveZoom": False,
        "defaultSceneTransition": "cut",
        "repetitivePulse": False,
    }
    checks["naturalEditingPolicyLocked"] = (
        isinstance(editing_policy, dict)
        and all(editing_policy.get(key) == value for key, value in required_policy.items())
    )

    generation_payload: dict[str, Any] | None = None
    mastering_payload: dict[str, Any] | None = None
    generation_text = ""
    source_path: Path | None = None
    mastered_path: Path | None = None
    generation_report_path: Path | None = None
    mastering_report_path: Path | None = None
    source_hash: str | None = None
    mastered_hash: str | None = None
    generation_report_hash: str | None = None
    mastering_report_hash: str | None = None

    try:
        provenance = inputs.get("narrationProvenance")
        if not isinstance(provenance, dict):
            raise ValueError("inputs.narrationProvenance must be an object")
        source_path = resolve_from_config(config_path, str(inputs["narration"]))
        mastered_path = resolve_from_config(config_path, str(inputs["narrationFinal"]))
        generation_report_path = resolve_from_config(config_path, str(provenance["generationReport"]))
        mastering_report_path = resolve_from_config(config_path, str(provenance["masteringReport"]))

        source_hash = sha256_file(source_path)
        mastered_hash = sha256_file(mastered_path)
        generation_report_hash = sha256_file(generation_report_path)
        mastering_report_hash = sha256_file(mastering_report_path)
        expected_source_hash = provenance.get("sourceSha256")
        expected_mastered_hash = provenance.get("masteredSha256")
        expected_generation_hash = provenance.get("generationReportSha256")
        expected_mastering_hash = provenance.get("masteringReportSha256")
        checks["narrationSourceHashMatchesConfig"] = (
            is_sha256(expected_source_hash) and source_hash == expected_source_hash
        )
        checks["narrationMasterHashMatchesConfig"] = (
            is_sha256(expected_mastered_hash) and mastered_hash == expected_mastered_hash
        )
        checks["generationReportHashMatchesConfig"] = (
            is_sha256(expected_generation_hash) and generation_report_hash == expected_generation_hash
        )
        checks["masteringReportHashMatchesConfig"] = (
            is_sha256(expected_mastering_hash) and mastering_report_hash == expected_mastering_hash
        )

        generation_payload = load_json_object(generation_report_path)
        mastering_payload = load_json_object(mastering_report_path)
        generation_narration = generation_payload.get("narration")
        if isinstance(generation_narration, dict):
            generation_text = str(generation_narration.get("text", ""))
        generation_quality = generation_payload.get("qualityGates")
        checks["generationReportAccepted"] = (
            generation_payload.get("schemaVersion") == "toolbraid-indextts25-generation-v2"
            and generation_payload.get("status") in {"PASS", "PASS_REQUIRES_DECLIP"}
            and bool(normalize_approved_text(generation_text))
            and isinstance(generation_quality, dict)
            and generation_quality.get("durationPass") is True
            and generation_quality.get("pausesPass") is True
            and generation_quality.get("rawSourceClippingRepairable") is True
        )
        generation_outputs = generation_payload.get("outputs")
        checks["generationReportPremasterHashMatches"] = (
            isinstance(generation_outputs, dict)
            and generation_outputs.get("premasterSha256") == source_hash
            and generation_outputs.get("premasterSha256") == expected_source_hash
        )

        mastering_input = mastering_payload.get("input")
        mastering_output = mastering_payload.get("output")
        mastering_warnings = mastering_payload.get("warnings")
        checks["masteringReportAccepted"] = (
            mastering_payload.get("schemaVersion") == "1.0"
            and mastering_payload.get("status") == "PASS"
            and mastering_warnings == []
        )
        checks["masteringReportInputOutputHashesMatch"] = (
            isinstance(mastering_input, dict)
            and isinstance(mastering_output, dict)
            and mastering_input.get("sha256") == source_hash
            and mastering_input.get("sha256") == expected_source_hash
            and mastering_output.get("sha256") == mastered_hash
            and mastering_output.get("sha256") == expected_mastered_hash
        )
        mastering_validation = mastering_payload.get("validation")
        required_mastering_validation = (
            "sampleRatePreserved",
            "stereoPreserved",
            "frameCountPreserved",
            "loudnessWithinTolerance",
            "samplePeakWithinCeiling",
            "truePeakEstimateWithinCeiling",
        )
        checks["masteringValidationPasses"] = (
            isinstance(mastering_validation, dict)
            and all(mastering_validation.get(key) is True for key in required_mastering_validation)
        )

        voice_cleanup = mastering_payload.get("processing", {}).get("voiceCleanup", {})
        plugins = voice_cleanup.get("plugins", []) if isinstance(voice_cleanup, dict) else []
        plugin_names = {
            str(plugin.get("name")) for plugin in plugins if isinstance(plugin, dict)
        }
        declip_required = (
            generation_payload.get("status") == "PASS_REQUIRES_DECLIP"
            or (
                isinstance(generation_quality, dict)
                and generation_quality.get("premiumDeclipRequired") is True
            )
        )
        checks["premiumDeclipRequirementSatisfied"] = (
            not declip_required
            or (
                isinstance(voice_cleanup, dict)
                and voice_cleanup.get("mode") == "premium-vst3"
                and "iZotope RX 12 De-clip" in plugin_names
            )
        )

        target = mastering_payload.get("target")
        after = mastering_payload.get("after")
        if not isinstance(target, dict) or not isinstance(after, dict):
            raise ValueError("mastering report target/after must be objects")
        target_lufs = target.get("integratedLufs")
        loudness_tolerance = target.get("loudnessToleranceLu")
        true_peak_ceiling = target.get("peakCeilingDbfs")
        after_lufs = after.get("integratedLufs")
        after_sample_peak = after.get("samplePeakDbfs")
        after_true_peak = after.get("truePeakEstimateDbfs")
        limits_sane = (
            all(finite_number(value) for value in (target_lufs, loudness_tolerance, true_peak_ceiling))
            and -24.0 <= float(target_lufs) <= -10.0
            and 0.0 <= float(loudness_tolerance) <= 2.0
            and -6.0 <= float(true_peak_ceiling) <= -0.1
        )
        checks["masteringDeclaredLimitsSane"] = limits_sane
        checks["masteredLoudnessWithinDeclaredLimit"] = (
            limits_sane
            and finite_number(after_lufs)
            and abs(float(after_lufs) - float(target_lufs)) <= float(loudness_tolerance)
        )
        checks["masteredTruePeakWithinDeclaredLimit"] = (
            limits_sane
            and finite_number(after_sample_peak)
            and finite_number(after_true_peak)
            and float(after_sample_peak) <= float(true_peak_ceiling)
            and float(after_true_peak) <= float(true_peak_ceiling)
        )
        audio_limits = {
            "available": limits_sane,
            "integratedLufs": float(target_lufs),
            "loudnessToleranceLu": float(loudness_tolerance),
            "truePeakCeilingDbtp": float(true_peak_ceiling),
            "source": str(mastering_report_path),
        }
        evidence["narration"] = {
            "source": {"path": str(source_path), "sha256": source_hash},
            "mastered": {"path": str(mastered_path), "sha256": mastered_hash},
            "generationReport": {
                "path": str(generation_report_path),
                "sha256": generation_report_hash,
                "status": generation_payload.get("status"),
            },
            "masteringReport": {
                "path": str(mastering_report_path),
                "sha256": mastering_report_hash,
                "status": mastering_payload.get("status"),
            },
        }
    except (KeyError, OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        evidence["narration"] = {"error": f"{type(exc).__name__}: {exc}"}

    captions_path: Path | None = None
    captions_hash: str | None = None
    caption_count = 0
    try:
        if generation_payload is None or not generation_text:
            raise ValueError("approved generation narration is unavailable")
        if mastered_path is None or mastered_hash is None:
            raise ValueError("mastered narration provenance is unavailable")
        captions_path = resolve_from_config(config_path, str(inputs["captions"]))
        captions_hash = sha256_file(captions_path)
        captions_payload = load_json_object(captions_path)
        caption_source = captions_payload.get("source")
        checks["captionSourceHashMatchesMaster"] = (
            isinstance(caption_source, dict)
            and caption_source.get("sha256") == mastered_hash
            and caption_source.get("sha256")
            == inputs.get("narrationProvenance", {}).get("masteredSha256")
        )
        approved_text = captions_payload.get("approvedCaptionText")
        generation_normalized = normalize_approved_text(generation_text)
        approved_normalized = normalize_approved_text(approved_text)
        checks["approvedCaptionTextMatchesGeneration"] = (
            bool(generation_normalized) and approved_normalized == generation_normalized
        )

        caption_entries = captions_payload.get("captions")
        if not isinstance(caption_entries, list) or not caption_entries:
            raise ValueError("caption document has no captions array")
        caption_count = len(caption_entries)
        burned_text = " ".join(
            str(item.get("text", "")) for item in caption_entries if isinstance(item, dict)
        )
        checks["burnedCaptionTextMatchesGeneration"] = (
            normalize_approved_text(burned_text) == generation_normalized
        )
        alignment = captions_payload.get("alignment")
        narration_word_count = generation_payload.get("narration", {}).get("wordCount")
        checks["captionAlignmentDeclaresApprovedText"] = (
            isinstance(alignment, dict)
            and alignment.get("publishedTextIsApprovedNarration") is True
            and alignment.get("unmatchedSurfaceWordIndexes") == []
            and alignment.get("approvedSurfaceWordCount") == narration_word_count
            and captions_payload.get("wordCount") == narration_word_count
        )

        caption_duration = (
            float(caption_source.get("durationSeconds"))
            if isinstance(caption_source, dict) and finite_number(caption_source.get("durationSeconds"))
            else -1.0
        )
        previous_end = 0.0
        next_word_index = 0
        timing_valid = caption_duration > 0.0
        for position, item in enumerate(caption_entries, start=1):
            if not isinstance(item, dict):
                timing_valid = False
                break
            start = item.get("startSeconds")
            end = item.get("endSeconds")
            word_start = item.get("wordStartIndex")
            word_end = item.get("wordEndIndex")
            if not (
                item.get("index") == position
                and isinstance(item.get("text"), str)
                and bool(normalize_approved_text(item.get("text")))
                and finite_number(start)
                and finite_number(end)
                and float(start) >= previous_end - 1e-6
                and float(end) > float(start)
                and float(end) <= caption_duration + 0.05
                and isinstance(word_start, int)
                and isinstance(word_end, int)
                and word_start == next_word_index
                and word_end >= word_start
            ):
                timing_valid = False
                break
            previous_end = float(end)
            next_word_index = word_end + 1
        checks["captionTimingAndCoverageValid"] = (
            timing_valid
            and isinstance(narration_word_count, int)
            and next_word_index == narration_word_count
        )
        evidence["captions"] = {
            "path": str(captions_path),
            "sha256": captions_hash,
            "entries": caption_count,
            "approvedNormalizedSha256": hashlib.sha256(approved_normalized.encode("utf-8")).hexdigest(),
            "generationNormalizedSha256": hashlib.sha256(generation_normalized.encode("utf-8")).hexdigest(),
        }
    except (KeyError, OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        evidence["captions"] = {"error": f"{type(exc).__name__}: {exc}"}

    capture_video_path: Path | None = None
    capture_report_path: Path | None = None
    capture_timeline_path: Path | None = None
    capture_hashes: dict[str, str] = {}
    public_url = ""
    product_segment: dict[str, Any] | None = None
    try:
        product_segments = [
            segment
            for scene in config.get("scenes", [])
            if isinstance(scene, dict)
            for segment in scene.get("segments", [])
            if isinstance(segment, dict) and segment.get("kind") == "product"
        ]
        if len(product_segments) != 1:
            raise ValueError("render config must contain exactly one product segment")
        product_segment = product_segments[0]
        if product_segment.get("source") != "public-full":
            raise ValueError("the product segment must use public-full")
        public_url = str(product_segment.get("publicUrl", ""))
        configured_products = inputs.get("productVideos")
        provenance_root = inputs.get("productProvenance")
        if not isinstance(configured_products, dict) or not isinstance(provenance_root, dict):
            raise ValueError("productVideos/productProvenance must be objects")
        capture_provenance = provenance_root.get("public-full")
        if not isinstance(capture_provenance, dict):
            raise ValueError("productProvenance.public-full must be an object")
        capture_video_path = resolve_from_config(config_path, str(configured_products["public-full"]))
        capture_report_path = resolve_from_config(config_path, str(capture_provenance["report"]))
        capture_timeline_path = resolve_from_config(config_path, str(capture_provenance["timeline"]))
        cursor_trace_path = resolve_from_config(config_path, str(inputs["cursorTrace"]))
        capture_hashes = {
            "videoSha256": sha256_file(capture_video_path),
            "reportSha256": sha256_file(capture_report_path),
            "timelineSha256": sha256_file(capture_timeline_path),
        }
        checks["captureVideoHashMatchesConfig"] = (
            is_sha256(capture_provenance.get("videoSha256"))
            and capture_hashes["videoSha256"] == capture_provenance.get("videoSha256")
        )
        checks["captureReportHashMatchesConfig"] = (
            is_sha256(capture_provenance.get("reportSha256"))
            and capture_hashes["reportSha256"] == capture_provenance.get("reportSha256")
        )
        checks["captureTimelineHashMatchesConfig"] = (
            is_sha256(capture_provenance.get("timelineSha256"))
            and capture_hashes["timelineSha256"] == capture_provenance.get("timelineSha256")
            and cursor_trace_path == capture_timeline_path
        )

        capture_report = load_json_object(capture_report_path)
        capture_timeline = load_json_object(capture_timeline_path)
        expected_counts = {
            "providers": 6,
            "discoveredTools": 9,
            "quarantined": 1,
            "safeResults": 7,
            "approvals": 2,
        }
        checks["captureReportScenarioIsVerified"] = (
            capture_report.get("format") == "toolbraid-public-capture-report-v2"
            and capture_report.get("status") == "PASS"
            and capture_report.get("target") == "public-full"
            and capture_report.get("url") == public_url
            and capture_report.get("runtime") == "native"
            and capture_report.get("executionMode") == "public-sandbox-full"
            and capture_report.get("remoteDeployment") is True
            and capture_report.get("sandboxExecution") is True
            and capture_report.get("checkpoint") == "complete"
            and capture_report.get("publicSandboxExecution") is True
            and capture_report.get("mutationExecution") is True
            and capture_report.get("auditVerified") is True
            and capture_report.get("executionSurface") == "deployed-browser-sandbox"
            and capture_report.get("expectedProviderFailures") == 1
            and capture_report.get("unexpectedBrowserErrors") == 0
            and capture_report.get("counts") == expected_counts
        )
        capture_video = capture_report.get("video")
        checks["captureReportVideoHashMatchesSource"] = (
            isinstance(capture_video, dict)
            and capture_video.get("sha256") == capture_hashes["videoSha256"]
            and capture_video.get("bytes") == capture_video_path.stat().st_size
            and capture_video.get("width") == int(config["master"]["width"])
            and capture_video.get("height") == int(config["master"]["height"])
            and abs(float(capture_video.get("fps", 0.0)) - float(config["master"]["fps"])) < 0.001
        )
        final_outcome = capture_report.get("finalOutcome")
        audit_seal = final_outcome.get("auditSeal") if isinstance(final_outcome, dict) else None
        checks["captureAuditSealIsValid"] = (
            isinstance(final_outcome, dict)
            and final_outcome.get("activeReleaseId") == "release-1841"
            and final_outcome.get("noticeRevision") == "notice-r9"
            and isinstance(audit_seal, dict)
            and audit_seal.get("algorithm") == "sha256-chain-v1"
            and audit_seal.get("entries") == 54
            and is_sha256(audit_seal.get("head"))
        )
        cursor = capture_report.get("cursorTrace")
        pointer_trace = capture_timeline.get("pointerTrace")
        checks["captureCursorProvenanceIsValid"] = (
            isinstance(cursor, dict)
            and cursor.get("rawCaptureOverlay") is False
            and cursor.get("compositedAfterCapture") is True
            and cursor.get("cspBypassed") is False
            and cursor.get("clickPulse") is False
            and cursor.get("periodicWobble") is False
            and isinstance(pointer_trace, list)
            and len(pointer_trace) >= 100
            and cursor.get("sampleCount") == len(pointer_trace)
        )
        checks["captureTimelineIsValid"] = (
            capture_timeline.get("format") == "toolbraid-public-capture-timeline-v2"
            and capture_timeline.get("target") == "public-full"
            and capture_timeline.get("url") == public_url
            and capture_timeline.get("runtime") == "native"
            and capture_timeline.get("executionMode") == "public-sandbox-full"
            and capture_timeline.get("remoteDeployment") is True
            and capture_timeline.get("sandboxExecution") is True
            and capture_timeline.get("readOnly") is False
            and capture_timeline.get("fps") == int(config["master"]["fps"])
            and capture_timeline.get("resolution")
            == f"{int(config['master']['width'])}x{int(config['master']['height'])}"
        )
        capture_paths = capture_report.get("paths")
        checks["capturePathsMatchSealedArtifacts"] = (
            isinstance(capture_paths, dict)
            and same_path(capture_paths.get("output"), capture_video_path)
            and same_path(capture_paths.get("timeline"), capture_timeline_path)
            and same_path(capture_paths.get("report"), capture_report_path)
        )
        evidence["capture"] = {
            "video": str(capture_video_path),
            "report": str(capture_report_path),
            "timeline": str(capture_timeline_path),
            **capture_hashes,
            "auditSeal": audit_seal,
        }
    except (KeyError, OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        evidence["capture"] = {"error": f"{type(exc).__name__}: {exc}"}

    try:
        render_report = load_json_object(render_report_path)
        output_hash = sha256_file(output_path)
        artifact_hashes = render_report.get("artifactHashes")
        if not isinstance(artifact_hashes, dict):
            raise ValueError("render report artifactHashes must be an object")
        checks["renderReportIsFullV2"] = (
            render_report.get("format") == "toolbraid-final-render-report-v2"
            and render_report.get("smokeRender") is False
        )
        config_artifact = artifact_hashes.get("renderConfig")
        checks["renderReportConfigHashMatchesFile"] = (
            isinstance(config_artifact, dict)
            and same_path(config_artifact.get("path"), config_path)
            and config_artifact.get("sha256") == sha256_file(config_path)
        )
        output_artifact = artifact_hashes.get("output")
        checks["renderReportOutputHashMatchesFile"] = (
            isinstance(output_artifact, dict)
            and output_artifact.get("sha256") == output_hash
            and is_sha256(output_artifact.get("sha256"))
        )
        checks["renderReportOutputPathAndSizeMatch"] = (
            isinstance(output_artifact, dict)
            and same_path(render_report.get("output"), output_path)
            and same_path(output_artifact.get("path"), output_path)
            and output_artifact.get("bytes") == output_path.stat().st_size
        )
        caption_artifact = artifact_hashes.get("captions")
        render_captions = render_report.get("captions")
        checks["renderReportCaptionHashMatchesFile"] = (
            captions_path is not None
            and captions_hash is not None
            and isinstance(caption_artifact, dict)
            and caption_artifact.get("present") is True
            and same_path(caption_artifact.get("path"), captions_path)
            and caption_artifact.get("sha256") == captions_hash
            and isinstance(render_captions, dict)
            and render_captions.get("sha256") == captions_hash
        )
        product_artifacts = artifact_hashes.get("productVideos")
        product_artifact = (
            product_artifacts.get("public-full") if isinstance(product_artifacts, dict) else None
        )
        checks["renderReportProductHashMatchesConfigAndFile"] = (
            capture_video_path is not None
            and isinstance(product_artifact, dict)
            and same_path(product_artifact.get("path"), capture_video_path)
            and product_artifact.get("sha256") == capture_hashes.get("videoSha256")
            and product_artifact.get("sha256")
            == inputs.get("productProvenance", {}).get("public-full", {}).get("videoSha256")
        )
        audio_sources = render_report.get("audioSources")
        rendered_narration = (
            audio_sources.get("narrationProvenance") if isinstance(audio_sources, dict) else None
        )
        checks["renderReportNarrationHashesMatchConfigAndFiles"] = (
            isinstance(rendered_narration, dict)
            and rendered_narration.get("verified") is True
            and rendered_narration.get("sourceSha256") == source_hash
            and rendered_narration.get("masteredSha256") == mastered_hash
            and rendered_narration.get("generationReportSha256") == generation_report_hash
            and rendered_narration.get("masteringReportSha256") == mastering_report_hash
            and source_path is not None
            and mastered_path is not None
            and same_path(rendered_narration.get("source"), source_path)
            and same_path(rendered_narration.get("mastered"), mastered_path)
        )
        rendered_capture = render_report.get("captureProvenance")
        checks["renderReportCaptureHashesMatchConfigAndFiles"] = (
            isinstance(rendered_capture, dict)
            and rendered_capture.get("verified") is True
            and rendered_capture.get("videoSha256") == capture_hashes.get("videoSha256")
            and rendered_capture.get("reportSha256") == capture_hashes.get("reportSha256")
            and rendered_capture.get("timelineSha256") == capture_hashes.get("timelineSha256")
            and capture_video_path is not None
            and capture_report_path is not None
            and capture_timeline_path is not None
            and same_path(rendered_capture.get("video"), capture_video_path)
            and same_path(rendered_capture.get("report"), capture_report_path)
            and same_path(rendered_capture.get("timeline"), capture_timeline_path)
        )

        master = render_report.get("master")
        window = render_report.get("window")
        encoded = render_report.get("encoded")
        expected_frames = int(round(float(config["master"]["durationSeconds"]) * float(config["master"]["fps"])))
        checks["renderReportMasterMatchesConfig"] = (
            isinstance(master, dict)
            and isinstance(window, dict)
            and isinstance(encoded, dict)
            and master.get("width") == int(config["master"]["width"])
            and master.get("height") == int(config["master"]["height"])
            and float(master.get("fps", 0.0)) == float(config["master"]["fps"])
            and abs(float(master.get("durationSeconds", 0.0)) - float(config["master"]["durationSeconds"])) < 1e-6
            and abs(float(window.get("startSeconds", -1.0))) < 1e-6
            and abs(float(window.get("durationSeconds", 0.0)) - float(config["master"]["durationSeconds"])) < 1e-6
            and abs(float(window.get("endSeconds", 0.0)) - float(config["master"]["durationSeconds"])) < 1e-6
            and encoded.get("frameCount") == expected_frames
            and encoded.get("sampleRate") == int(config["master"]["sampleRate"])
            and encoded.get("channels") == int(config["master"]["channels"])
            and encoded.get("atomicReplace") is True
        )
        content = render_report.get("contentModel")
        checks["renderReportContentMatchesConfig"] = (
            isinstance(content, dict)
            and product_segment is not None
            and content.get("productSegments") == 1
            and content.get("outroSegments") == 1
            and content.get("productSource") == product_segment.get("source")
            and content.get("productPlayback") == product_segment.get("playback") == "linear-1x"
            and content.get("productProvenance") == product_segment.get("provenance") == "public-sandbox"
            and content.get("publicUrl") == public_url
            and content.get("generatedOutro") is True
            and content.get("reusesBrowserFrameForOutro") is False
        )
        checks["renderReportCaptionsAreBurnedIn"] = (
            isinstance(render_captions, dict)
            and render_captions.get("present") is True
            and render_captions.get("burnedIn") is True
            and render_captions.get("entries") == caption_count
            and captions_path is not None
            and same_path(render_captions.get("path"), captions_path)
        )
        evidence["renderReport"] = {
            "path": str(render_report_path),
            "outputSha256": output_hash,
            "reportedOutputSha256": output_artifact.get("sha256") if isinstance(output_artifact, dict) else None,
            "reportedConfigSha256": config_artifact.get("sha256") if isinstance(config_artifact, dict) else None,
        }
    except (KeyError, OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        evidence["renderReport"] = {"path": str(render_report_path), "error": f"{type(exc).__name__}: {exc}"}

    return checks, evidence, audio_limits


def peak_dbfs(audio: np.ndarray) -> float:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    return 20.0 * math.log10(max(peak, 1e-12))


def true_peak_dbfs(audio: np.ndarray, sample_rate: int) -> float:
    if not audio.size:
        return -240.0
    peak = 0.0
    block = sample_rate * 10
    for start in range(0, audio.shape[0], block):
        segment = audio[max(0, start - 64) : min(audio.shape[0], start + block + 64)]
        oversampled = resample_poly(segment, 4, 1, axis=0)
        peak = max(peak, float(np.max(np.abs(oversampled))))
    return 20.0 * math.log10(max(peak, 1e-12))


def frame_time(frame: av.VideoFrame, fallback_index: int, fps: float) -> float:
    if frame.pts is not None and frame.time_base is not None:
        return float(frame.pts * frame.time_base)
    return fallback_index / fps


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    fonts = Path(r"C:\Windows\Fonts")
    candidates = ("seguisb.ttf", "arialbd.ttf") if bold else ("segoeui.ttf", "arial.ttf")
    for name in candidates:
        path = fonts / name
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def make_contact_sheet(
    samples: list[dict[str, object]],
    destination: Path,
    *,
    width: int,
    height: int,
    fps: float,
) -> None:
    tile_width, tile_height = 480, 270
    label_height = 38
    header_height = 74
    columns = min(4, max(1, len(samples)))
    rows = max(1, math.ceil(len(samples) / columns))
    canvas = Image.new(
        "RGB",
        (tile_width * columns, header_height + (tile_height + label_height) * rows),
        "#020914",
    )
    draw = ImageDraw.Draw(canvas)
    draw.text((28, 18), "ToolBraid final master — visual QC", fill="#F4FAFF", font=font(30, bold=True))
    spec = f"{width}×{height} · {fps:g} FPS"
    spec_width = draw.textbbox((0, 0), spec, font=font(19, bold=True))[2]
    draw.text((tile_width * columns - spec_width - 28, 25), spec, fill="#63EFD1", font=font(19, bold=True))
    for index, sample in enumerate(samples):
        column, row = index % columns, index // columns
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


def decode_video(
    path: Path,
    *,
    fps: float,
    sample_times: tuple[float, ...],
) -> tuple[dict[str, object], list[dict[str, object]]]:
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
        targets = iter(sample_times)
        target = next(targets, None)
        decoded_frames = 0
        last_timestamp = 0.0
        for frame in container.decode(stream):
            timestamp = frame_time(frame, decoded_frames, fps)
            decoded_frames += 1
            last_timestamp = timestamp
            if target is not None and timestamp + (0.5 / fps) >= target:
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


def decode_audio(path: Path, *, sample_rate: int) -> tuple[dict[str, object], np.ndarray]:
    blocks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        source = {
            "codec": stream.codec_context.name,
            "sampleRate": stream.codec_context.sample_rate,
            "channels": stream.codec_context.channels,
            "layout": str(stream.codec_context.layout),
        }
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=sample_rate)
        for frame in container.decode(stream):
            for converted in resampler.resample(frame):
                blocks.append(converted.to_ndarray().astype(np.float32, copy=False))
        for converted in resampler.resample(None):
            blocks.append(converted.to_ndarray().astype(np.float32, copy=False))
    if not blocks:
        raise RuntimeError("No audio samples decoded")
    audio = np.concatenate(blocks, axis=1).T
    meter = pyln.Meter(sample_rate, block_size=0.400)
    source.update({
        "decodedSamplesPerChannel": int(audio.shape[0]),
        "decodedDurationSeconds": round(audio.shape[0] / sample_rate, 6),
        "integratedLufs": round(float(meter.integrated_loudness(audio)), 3),
        "samplePeakDbfs": round(peak_dbfs(audio), 3),
        "truePeakEstimateDbtp": round(true_peak_dbfs(audio, sample_rate), 3),
    })
    return source, audio


def validate(
    path: Path,
    report_path: Path,
    contact_sheet_path: Path,
    config_path: Path,
    render_report_path: Path | None = None,
) -> dict[str, object]:
    if not path.exists():
        raise FileNotFoundError(path)
    if not config_path.exists():
        raise FileNotFoundError(config_path)
    config = load_json_object(config_path)
    expected = load_expectations(config_path)
    expected_width = int(expected["width"])
    expected_height = int(expected["height"])
    expected_fps = float(expected["fps"])
    expected_duration = float(expected["durationSeconds"])
    expected_frames = int(expected["frameCount"])
    expected_sample_rate = int(expected["sampleRate"])
    expected_channels = int(expected["channels"])
    sample_times = tuple(float(value) for value in expected["sampleTimesSeconds"])
    with av.open(str(path)) as container:
        duration = float(container.duration or 0) / float(av.time_base)
        format_name = container.format.name
        stream_types = [stream.type for stream in container.streams]

    video, samples = decode_video(path, fps=expected_fps, sample_times=sample_times)
    audio, _ = decode_audio(path, sample_rate=expected_sample_rate)
    make_contact_sheet(
        samples,
        contact_sheet_path,
        width=expected_width,
        height=expected_height,
        fps=expected_fps,
    )

    duration_tolerance = max(0.05, 1.0 / expected_fps)
    if render_report_path is None:
        render_report_path = path.with_name(f"{path.stem}.render-report.json")
    locked_checks, artifact_evidence, audio_limits = validate_locked_artifacts(
        config,
        config_path,
        path,
        render_report_path,
    )
    limits_available = audio_limits.get("available") is True
    audio_loudness_within_limit = (
        limits_available
        and abs(float(audio["integratedLufs"]) - float(audio_limits["integratedLufs"]))
        <= float(audio_limits["loudnessToleranceLu"])
    )
    audio_true_peak_within_limit = (
        limits_available
        and float(audio["truePeakEstimateDbtp"]) <= float(audio_limits["truePeakCeilingDbtp"])
    )

    checks = {
        "containerIsMp4": "mp4" in format_name,
        "hasOneVideoAndOneAudioStream": stream_types.count("video") == 1 and stream_types.count("audio") == 1,
        "durationMatchesConfig": abs(duration - expected_duration) <= duration_tolerance,
        "videoDimensionsMatchConfig": (video["width"], video["height"]) == (expected_width, expected_height),
        "videoFpsMatchesConfig": abs(float(video["averageRate"]) - expected_fps) < 0.001,
        "videoIsH264": video["codec"] == "h264",
        "videoIsYuv420p": video["pixelFormat"] == "yuv420p",
        "decodedFrameCountMatchesConfig": video["decodedFrames"] == expected_frames,
        "audioIsAac": audio["codec"] == "aac",
        "audioFormatMatchesConfig": (
            audio["sampleRate"] == expected_sample_rate and audio["channels"] == expected_channels
        ),
        "audioDurationMatchesVideo": (
            abs(float(audio["decodedDurationSeconds"]) - duration) <= duration_tolerance
        ),
        "audioIsAudible": float(audio["integratedLufs"]) > -24.0,
        "audioLoudnessWithinMasteringTarget": audio_loudness_within_limit,
        "audioTruePeakWithinMasteringCeiling": audio_true_peak_within_limit,
        "allConfiguredVisualSamplesPresent": len(samples) == len(sample_times),
        "noBlankSampledFrames": all(
            float(sample["lumaMean"]) > 3.0 and float(sample["lumaStdDev"]) > 3.0
            for sample in samples
        ),
        **locked_checks,
    }
    failures = [name for name, passed in checks.items() if not passed]
    report: dict[str, object] = {
        "format": "toolbraid-final-video-validation-v2",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if not failures else "FAIL",
        "input": str(path.resolve()),
        "bytes": path.stat().st_size,
        "renderConfig": {
            "path": str(config_path.resolve()),
            "sha256": sha256_file(config_path),
            "format": expected["configFormat"],
        },
        "renderReport": str(render_report_path.resolve()),
        "expectations": {
            **expected,
            "sampleTimesSeconds": [round(value, 6) for value in sample_times],
        },
        "container": {"format": format_name, "durationSeconds": round(duration, 6), "streamTypes": stream_types},
        "video": video,
        "audio": audio,
        "masteringLimits": audio_limits,
        "artifactEvidence": artifact_evidence,
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
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument(
        "--render-report",
        default=None,
        help="Renderer report to verify; defaults to <input-stem>.render-report.json",
    )
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    parser.add_argument("--contact-sheet", default=str(DEFAULT_CONTACT_SHEET))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    render_report_path = Path(args.render_report).resolve() if args.render_report else None
    report = validate(
        Path(args.input).resolve(),
        Path(args.report).resolve(),
        Path(args.contact_sheet).resolve(),
        Path(args.config).resolve(),
        render_report_path,
    )
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
