#!/usr/bin/env python3
"""Record ToolBraid's native WebMCP judge flow at 1920x1080/30 fps.

The public target is deliberately read-only: it discovers, normalises, runs
safe evidence reads, opens the exact-effect review, and stops before either
approval. The public-full target completes the same flow against the deployed,
browser-isolated WebMCP sandbox. The local target keeps deterministic fixture QA.

Examples:
    python video-production/record-public-demo.py public
    python video-production/record-public-demo.py public-full --headed
    python video-production/record-public-demo.py local --pace 0.05
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import av
    from playwright.sync_api import Locator, Page, sync_playwright
except ImportError as exc:
    raise SystemExit(
        "Playwright and PyAV are required. Install the repository's "
        "requirements-e2e.txt and video-production/requirements.txt files."
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
WORK_DIR = ROOT / "video-production" / "work"
SOURCE_RECORDER = ROOT / "scripts" / "record-demo-video.py"
PUBLIC_URL = "https://toolbraid-webmcp.vercel.app"
LOCAL_URL = "http://127.0.0.1:4173"
LOCAL_PORTS = tuple(range(4173, 4180))
PUBLIC_TARGETS = frozenset(("public", "public-full"))
DEFAULT_CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
EXPECTED_PROVIDER_ERROR = "Primary health window is temporarily unavailable."
WIDTH = 1920
HEIGHT = 1080
FPS = 30
PUBLIC_PROVIDER_ORIGINS = sorted(
    f"https://toolbraid-{provider_id}-webmcp.vercel.app"
    for provider_id in ("signals", "pulse", "source", "deploy", "status", "mirage")
)
LOCAL_PROVIDER_ORIGINS = sorted(
    f"http://127.0.0.1:{port}"
    for port in range(4174, 4180)
)
SAFE_RESULT_IDS = sorted(
    (
        "read-service-health",
        "read-release-history",
        "read-deployment-history",
        "read-status-notice",
        "correlate-evidence",
        "prepare-recovery-option",
        "draft-status-update",
    )
)
MUTATION_NODE_IDS = {"apply-recovery-option", "publish-status-update"}
MUTATION_AUDIT_EVENTS = {
    "node.started",
    "node.completed",
    "node.failed",
    "tool.execution_started",
    "tool.execution_failed",
}
EXPECTED_MUTATION_AUDIT_ORDER = [
    ("node.started", "apply-recovery-option"),
    ("tool.execution_started", "apply-recovery-option"),
    ("node.completed", "apply-recovery-option"),
    ("node.started", "publish-status-update"),
    ("tool.execution_started", "publish-status-update"),
    ("node.completed", "publish-status-update"),
]
EXPECTED_AUDIT_ENTRY_COUNT = 54

DEFAULT_OUTPUTS = {
    "public": WORK_DIR / "toolbraid-public-demo-1080p30.webm",
    "public-full": WORK_DIR / "toolbraid-public-full-demo-1080p30.webm",
    "local": WORK_DIR / "toolbraid-local-fixture-1080p30.webm",
}


def load_source_helpers() -> Any:
    """Load the proven server/normalisation helpers without editing them."""
    spec = importlib.util.spec_from_file_location(
        "_toolbraid_record_demo_helpers",
        SOURCE_RECORDER,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load capture helpers from {SOURCE_RECORDER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


HELPERS = load_source_helpers()


def resolve_repo_path(path: Path, *, label: str) -> Path:
    resolved = path.resolve() if path.is_absolute() else (ROOT / path).resolve()
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise SystemExit(f"{label} must stay inside the ToolBraid repository.") from exc
    return resolved


def resolve_work_json(path: Path, *, label: str) -> Path:
    resolved = resolve_repo_path(path, label=label)
    try:
        resolved.relative_to(WORK_DIR.resolve())
    except ValueError as exc:
        raise SystemExit(f"{label} must stay inside video-production/work.") from exc
    if resolved.suffix.lower() != ".json":
        raise SystemExit(f"{label} must use a .json extension.")
    return resolved


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(f".{path.name}.writing-{os.getpid()}")
    staged.unlink(missing_ok=True)
    try:
        staged.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        staged.replace(path)
    finally:
        staged.unlink(missing_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_http_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit("--url must be an absolute http:// or https:// URL.")
    return value.rstrip("/")


def validate_public_url(value: str) -> str:
    normalized = validate_http_url(value)
    parsed = urlparse(normalized)
    if (
        normalized != PUBLIC_URL
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit(
            f"The public recorder is locked to the validated deployment origin {PUBLIC_URL}."
        )
    return PUBLIC_URL


@dataclass
class CaptureTimeline:
    target: str
    url: str
    pace: float
    started: float = field(default_factory=time.monotonic)
    entries: list[dict[str, Any]] = field(default_factory=list)
    pointer_trace: list[dict[str, float]] = field(default_factory=list)

    def trace_pointer(self, x: float, y: float) -> None:
        self.pointer_trace.append(
            {
                "timeSeconds": round(time.monotonic() - self.started, 4),
                "x": round(x, 2),
                "y": round(y, 2),
            }
        )

    def mark(
        self,
        event: str,
        note: str,
        page: Page | None = None,
        pointer: tuple[float, float] | None = None,
    ) -> None:
        phase = None
        if page is not None:
            try:
                phase = page.evaluate("window.__TOOLBRAID_V2__?.getState?.().phase ?? null")
            except Exception:
                phase = None
        entry: dict[str, Any] = {
            "timeSeconds": round(time.monotonic() - self.started, 3),
            "event": event,
            "phase": phase,
            "note": note,
        }
        if pointer is not None:
            entry["pointer"] = {
                "x": round(pointer[0], 1),
                "y": round(pointer[1], 1),
            }
        self.entries.append(entry)


class DemoDirector:
    def __init__(
        self,
        page: Page,
        timeline: CaptureTimeline,
        pace: float,
        target: str,
    ) -> None:
        self.page = page
        self.timeline = timeline
        self.pace = pace
        self.target = target
        self.motion_seed = {
            "public": 20_260_828_01,
            "public-full": 20_260_828_02,
            "local": 20_260_828_03,
        }[target]
        self.rng = random.Random(self.motion_seed)
        self.pointer = (WIDTH * 0.86, HEIGHT * 0.82)

    def wait(self, seconds: float, *, floor_ms: int = 55) -> None:
        self.page.wait_for_timeout(max(floor_ms, round(seconds * self.pace * 1000)))

    def wait_for_phase(self, phase: str, timeout: float = 30.0) -> None:
        self.page.wait_for_function(
            "expected => window.__TOOLBRAID_V2__?.getState?.().phase === expected",
            arg=phase,
            timeout=timeout * 1000,
        )

    def pause(self, low: float, high: float, *, floor_ms: int = 45) -> None:
        self.wait(self.rng.uniform(low, high), floor_ms=floor_ms)

    @staticmethod
    def minimum_jerk(value: float) -> float:
        value = max(0.0, min(1.0, value))
        return value**3 * (10.0 - 15.0 * value + 6.0 * value * value)

    @staticmethod
    def cubic_bezier(
        start: tuple[float, float],
        control_a: tuple[float, float],
        control_b: tuple[float, float],
        end: tuple[float, float],
        value: float,
    ) -> tuple[float, float]:
        inverse = 1.0 - value
        x = (
            inverse**3 * start[0]
            + 3.0 * inverse * inverse * value * control_a[0]
            + 3.0 * inverse * value * value * control_b[0]
            + value**3 * end[0]
        )
        y = (
            inverse**3 * start[1]
            + 3.0 * inverse * inverse * value * control_a[1]
            + 3.0 * inverse * value * value * control_b[1]
            + value**3 * end[1]
        )
        return x, y

    def _curve_pointer(
        self,
        destination: tuple[float, float],
        duration: float,
    ) -> None:
        start_x, start_y = self.pointer
        target_x, target_y = destination
        distance = math.hypot(target_x - start_x, target_y - start_y)
        if distance < 0.5:
            return

        direction_x = (target_x - start_x) / distance
        direction_y = (target_y - start_y) / distance
        normal_x, normal_y = -direction_y, direction_x
        side = -1.0 if self.rng.random() < 0.5 else 1.0
        bend = side * min(20.0, max(2.0, distance * self.rng.uniform(0.012, 0.022)))
        first_anchor = self.rng.uniform(0.27, 0.34)
        second_anchor = self.rng.uniform(0.66, 0.74)
        control_a = (
            start_x + (target_x - start_x) * first_anchor + normal_x * bend,
            start_y + (target_y - start_y) * first_anchor + normal_y * bend,
        )
        control_b = (
            start_x + (target_x - start_x) * second_anchor + normal_x * bend * self.rng.uniform(0.62, 0.82),
            start_y + (target_y - start_y) * second_anchor + normal_y * bend * self.rng.uniform(0.62, 0.82),
        )
        movement_duration = max(0.065, duration)
        steps = max(6, min(42, round(movement_duration * 60)))
        per_step_ms = max(5, round(movement_duration * 1000 / steps))
        for index in range(1, steps + 1):
            progress = self.minimum_jerk(index / steps)
            x, y = self.cubic_bezier(
                (start_x, start_y),
                control_a,
                control_b,
                destination,
                progress,
            )
            self.page.mouse.move(x, y)
            self.timeline.trace_pointer(x, y)
            self.page.wait_for_timeout(per_step_ms)
        self.pointer = destination

    def move_pointer(
        self,
        destination: tuple[float, float],
        *,
        target_width: float = 72.0,
    ) -> None:
        start_x, start_y = self.pointer
        distance = math.hypot(destination[0] - start_x, destination[1] - start_y)
        width = max(20.0, min(260.0, target_width))
        difficulty = math.log2(distance / width + 1.0)
        duration = max(
            0.18,
            min(0.65, 0.14 + 0.09 * difficulty + self.rng.uniform(-0.018, 0.035)),
        )
        self._curve_pointer(destination, duration)

    def _scroll_target_into_view(self, locator: Locator, event: str) -> None:
        margin = 72.0
        for attempt in range(5):
            rect = locator.evaluate(
                """element => {
                  const bounds = element.getBoundingClientRect();
                  return {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom,
                    width: bounds.width,
                    height: bounds.height,
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                  };
                }"""
            )
            fits_vertically = rect["height"] <= rect["viewportHeight"] - margin * 2
            if fits_vertically:
                visible = rect["top"] >= margin and rect["bottom"] <= rect["viewportHeight"] - margin
            else:
                center_y = (rect["top"] + rect["bottom"]) * 0.5
                visible = margin <= center_y <= rect["viewportHeight"] - margin
            if visible:
                return

            if attempt == 0:
                approach = (
                    max(margin, min(rect["viewportWidth"] - margin, (rect["left"] + rect["right"]) * 0.5)),
                    max(margin, min(rect["viewportHeight"] - margin, (rect["top"] + rect["bottom"]) * 0.5)),
                )
                self.move_pointer(approach, target_width=max(40.0, rect["width"]))

            if rect["top"] < margin:
                delta = rect["top"] - margin - self.rng.uniform(18.0, 42.0)
            else:
                delta = rect["bottom"] - (rect["viewportHeight"] - margin) + self.rng.uniform(18.0, 42.0)
            steps = max(2, min(7, round(abs(delta) / 150.0) + 1))
            previous = 0.0
            for index in range(1, steps + 1):
                progress = self.minimum_jerk(index / steps)
                amount = delta * (progress - previous)
                previous = progress
                self.page.mouse.wheel(0, amount)
                self.pause(0.045, 0.095, floor_ms=30)
            self.pause(0.16, 0.31)

        raise AssertionError(f"Pointer target for {event!r} could not be brought into view with wheel scrolling.")

    def clickable_target(
        self,
        locator: Locator,
        event: str,
        timeout: float = 5.0,
    ) -> dict[str, float]:
        """Find an unobscured point inside a locator, waiting out transient toasts."""
        deadline = time.monotonic() + timeout
        obstruction = "unknown"
        while time.monotonic() < deadline:
            fractions = [
                [
                    max(0.30, min(0.70, 0.5 + self.rng.uniform(-0.13, 0.13))),
                    max(0.28, min(0.72, 0.5 + self.rng.uniform(-0.15, 0.15))),
                ],
                [.43, .46], [.57, .54], [.48, .61], [.62, .42],
                [.36, .56], [.54, .35], [.68, .58], [.32, .38],
            ]
            probe = locator.evaluate(
                r"""(element, fractions) => {
                  const rect = element.getBoundingClientRect();
                  let obstruction = null;
                  for (const [fx, fy] of fractions) {
                    const x = rect.left + rect.width * fx;
                    const y = rect.top + rect.height * fy;
                    const hit = document.elementFromPoint(x, y);
                    if (hit && (hit === element || element.contains(hit))) {
                      return {
                        point: { x, y },
                        width: rect.width,
                        height: rect.height,
                        obstruction: null,
                      };
                    }
                    obstruction = hit
                      ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}${
                          typeof hit.className === 'string' && hit.className
                            ? `.${hit.className.trim().split(/\s+/).join('.')}`
                            : ''
                        }`
                      : 'none';
                  }
                  return { point: null, obstruction };
                }""",
                fractions,
            )
            if probe["point"] is not None:
                return {
                    "x": float(probe["point"]["x"]),
                    "y": float(probe["point"]["y"]),
                    "width": float(probe["width"]),
                    "height": float(probe["height"]),
                }
            obstruction = probe["obstruction"] or "unknown"
            self.page.wait_for_timeout(100)
        raise AssertionError(
            f"Pointer target for {event!r} stayed obscured by {obstruction}."
        )

    def hover(
        self,
        locator: Locator,
        event: str,
        note: str,
        *,
        dwell: tuple[float, float] = (0.75, 1.25),
    ) -> None:
        locator.wait_for(state="visible")
        self._scroll_target_into_view(locator, event)
        target = self.clickable_target(locator, event)
        destination = (target["x"], target["y"])
        self.move_pointer(
            destination,
            target_width=max(24.0, min(target["width"], target["height"])),
        )
        self.timeline.mark(event, note, self.page, destination)
        self.pause(*dwell)

    def click(self, locator: Locator, event: str, note: str) -> None:
        locator.wait_for(state="visible")
        self._scroll_target_into_view(locator, event)
        self.pause(0.10, 0.24, floor_ms=35)
        target = self.clickable_target(locator, event)
        destination = (target["x"], target["y"])
        self.move_pointer(
            destination,
            target_width=max(24.0, min(target["width"], target["height"])),
        )
        deliberate = any(token in event for token in ("approve", "review", "execute"))
        self.pause(0.42, 0.78, floor_ms=45) if deliberate else self.pause(0.17, 0.43, floor_ms=45)
        hit = locator.evaluate(
            """(element, point) => {
              const hit = document.elementFromPoint(point.x, point.y);
              return Boolean(hit && (hit === element || element.contains(hit)));
            }""",
            {"x": destination[0], "y": destination[1]},
        )
        if not hit:
            raise AssertionError(f"Pointer target for {event!r} moved before the click.")
        self.timeline.mark(event, note, self.page, destination)
        self.page.mouse.down(button="left")
        self.pause(0.065, 0.118, floor_ms=42)
        self.page.mouse.up(button="left")
        self.pause(0.48, 0.90, floor_ms=45) if deliberate else self.pause(0.32, 0.72, floor_ms=45)

    @staticmethod
    def assert_native_counts(snapshot: dict[str, Any]) -> dict[str, int]:
        counts = {
            "providers": len(snapshot["providerDescriptors"]),
            "discoveredTools": len(snapshot["discoveredTools"]),
            "quarantined": len(snapshot["normalization"]["quarantined"]),
        }
        expected = {"providers": 6, "discoveredTools": 9, "quarantined": 1}
        if counts != expected:
            raise AssertionError(f"Unexpected native WebMCP counts: {counts}")
        if snapshot["mode"] != "native":
            raise AssertionError(f"Expected native runtime, got {snapshot['mode']!r}.")
        return counts

    def expected_provider_origins(self) -> list[str]:
        return (
            PUBLIC_PROVIDER_ORIGINS
            if self.target in PUBLIC_TARGETS
            else LOCAL_PROVIDER_ORIGINS
        )

    @staticmethod
    def mutation_audit_entries(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            entry
            for entry in snapshot["audit"]
            if entry["event"] in MUTATION_AUDIT_EVENTS
            and entry.get("details", {}).get("nodeId") in MUTATION_NODE_IDS
        ]

    @staticmethod
    def assert_valid_final_seal(snapshot: dict[str, Any]) -> dict[str, Any]:
        seal = snapshot.get("seal")
        audit = snapshot.get("audit")
        if not isinstance(seal, dict):
            raise AssertionError("Completed execution is missing its audit seal.")
        if not isinstance(audit, list) or len(audit) != EXPECTED_AUDIT_ENTRY_COUNT:
            raise AssertionError(
                f"Expected {EXPECTED_AUDIT_ENTRY_COUNT} audit entries, got "
                f"{len(audit) if isinstance(audit, list) else 'invalid audit data'}."
            )
        if seal.get("algorithm") != "sha256-chain-v1":
            raise AssertionError(f"Unexpected audit seal algorithm: {seal.get('algorithm')!r}.")
        if seal.get("entries") != EXPECTED_AUDIT_ENTRY_COUNT:
            raise AssertionError(f"Unexpected sealed entry count: {seal.get('entries')!r}.")
        head = seal.get("head")
        lowercase_hex = set("0123456789abcdef")
        if (
            not isinstance(head, str)
            or len(head) != 64
            or any(character not in lowercase_hex for character in head)
        ):
            raise AssertionError(f"Audit head is not a lowercase SHA-256 digest: {head!r}.")
        if audit[-1].get("hash") != head:
            raise AssertionError("Audit seal head does not match the final audit entry.")
        return seal

    def run(self) -> dict[str, Any]:
        page = self.page
        page.wait_for_function("() => Boolean(window.__TOOLBRAID_V2__)", timeout=30_000)
        state = page.evaluate("window.__TOOLBRAID_V2__.getState()")
        if state["phase"] != "idle":
            raise AssertionError(f"Expected idle phase, got {state['phase']!r}.")

        self.timeline.trace_pointer(*self.pointer)
        page.mouse.move(*self.pointer)
        self.timeline.mark(
            "objective",
            "Mission objective and the read-first human authority boundary are visible.",
            page,
            self.pointer,
        )
        self.pause(1.15, 1.75)

        self.click(
            page.locator('[data-context-action][data-action="start-mission"]'),
            "start-discovery",
            "Start native cross-origin WebMCP discovery.",
        )
        self.wait_for_phase("mapping")
        discovered = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        counts = self.assert_native_counts(discovered)
        self.timeline.mark(
            "native-topology",
            "Six provider origins, nine live tools, and one quarantined tool are visible.",
            page,
            self.pointer,
        )
        self.pause(3.8, 4.7)

        self.click(
            page.locator(
                '[data-constellation] [data-node-id][data-capability="unsafe.override"]'
            ),
            "inspect-quarantine",
            "Inspect the hostile approval-bypass metadata excluded before scoring.",
        )
        self.timeline.mark(
            "quarantine-visible",
            "The inspector explains why hostile metadata cannot enter the plan.",
            page,
            self.pointer,
        )
        self.pause(3.45, 4.35)

        self.click(
            page.locator('[data-panel-tab="mapping"]'),
            "open-mappings",
            "Open canonical capability mappings.",
        )
        self.timeline.mark(
            "semantic-normalisation",
            "Provider-specific contracts are bound to canonical capabilities.",
            page,
            self.pointer,
        )
        self.pause(3.5, 4.45)

        self.click(
            page.locator('[data-panel-tab="evidence"]'),
            "return-to-evidence",
            "Return to the live evidence panel.",
        )
        self.click(
            page.get_by_role("button", name="Run 4 safe reads", exact=True),
            "run-safe-reads",
            "Run only the independent read-only evidence tools.",
        )
        self.wait_for_phase("review")
        safe_snapshot = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        self.assert_native_counts(safe_snapshot)
        safe_results = len(safe_snapshot["results"])
        if safe_results != 7:
            raise AssertionError(f"Expected seven safe-stage results, got {safe_results}.")
        if safe_snapshot["plan"]["status"] != "approval_required":
            raise AssertionError("Safe reads did not stop at the approval checkpoint.")
        if not safe_snapshot["auditVerified"]:
            raise AssertionError("Read-only audit integrity failed.")

        self.click(
            page.locator(
                '[data-constellation] [data-node-id][data-capability="service.health.read"]'
            ),
            "inspect-failover",
            "Inspect the compatible read-only fallback evidence.",
        )
        self.timeline.mark(
            "safe-evidence-ready",
            "Evidence is correlated, failover is recorded, and both mutations remain locked.",
            page,
            self.pointer,
        )
        self.pause(4.7, 5.8)

        self.click(
            page.locator('[data-approval-dock] [data-action="review-approval"]'),
            "open-exact-effect-review",
            "Open the exact-effect human authority checkpoint.",
        )
        dialog = page.locator("[data-approval-dialog]")
        dialog.wait_for(state="visible")
        apply_arguments = (page.locator("[data-review-apply-arguments]").text_content() or "").strip()
        publish_body = (page.locator("[data-review-publish-body]").text_content() or "").strip()
        apply_plan = next(
            node for node in safe_snapshot["plan"]["nodes"]
            if node["id"] == "apply-recovery-option"
        )
        publish_plan = next(
            node for node in safe_snapshot["plan"]["nodes"]
            if node["id"] == "publish-status-update"
        )
        if json.loads(apply_arguments) != apply_plan["arguments"]:
            raise AssertionError("The reviewed recovery arguments drifted from the live plan.")
        if publish_body != publish_plan["arguments"]["body"]:
            raise AssertionError("The reviewed customer update drifted from the live plan.")
        self.timeline.mark(
            "exact-effects-visible",
            "Separate single-use scopes show exact origins, tools, schemas, arguments, and effects.",
            page,
            self.pointer,
        )
        self.click(
            page.locator('[data-approval-review="apply"] .technical-details summary'),
            "open-technical-binding",
            "Reveal the exact live binding and canonical recovery arguments.",
        )
        self.hover(
            page.locator("[data-review-apply-arguments]"),
            "read-recovery-effect",
            "Read the exact recovery arguments before any approval.",
            dwell=(0.24, 0.38),
        )
        self.hover(
            page.locator("[data-review-publish-body]"),
            "read-publication-effect",
            "Read the evidence-derived publication body as a separate scope.",
            dwell=(0.26, 0.42),
        )
        self.pause(0.06, 0.12)

        checkpoint_state = page.evaluate("window.__TOOLBRAID_V2__.getState()")
        checkpoint = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        if checkpoint_state["phase"] != "review":
            raise AssertionError(
                f"Capture moved beyond the review checkpoint: {checkpoint_state['phase']!r}."
            )
        if len(checkpoint["approvals"]) != 0:
            raise AssertionError("Capture unexpectedly created an approval before review.")
        provider_origins = sorted(
            provider["origin"] for provider in checkpoint["providerDescriptors"]
        )
        result_ids = sorted(checkpoint["results"])
        mutation_result_ids = sorted(MUTATION_NODE_IDS.intersection(result_ids))
        mutation_audit = self.mutation_audit_entries(checkpoint)
        mutation_execution = bool(mutation_result_ids or mutation_audit)
        if provider_origins != self.expected_provider_origins():
            raise AssertionError(
                "Capture resolved unexpected provider origins: "
                f"{provider_origins}"
            )
        if result_ids != SAFE_RESULT_IDS:
            raise AssertionError(f"Capture produced unexpected safe-stage results: {result_ids}")
        if mutation_result_ids:
            raise AssertionError(
                f"Capture unexpectedly produced mutation results: {mutation_result_ids}"
            )
        if mutation_audit:
            raise AssertionError(
                f"Capture unexpectedly recorded mutation execution: {mutation_audit}"
            )
        if mutation_execution:
            raise AssertionError("Capture unexpectedly executed a mutation before approval.")
        if not checkpoint["auditVerified"]:
            raise AssertionError("Review-checkpoint audit integrity failed.")

        if self.target == "public":
            self.timeline.mark(
                "public-read-only-stop",
                "Capture stops with both external mutations unapproved and unexecuted.",
                page,
                self.pointer,
            )
            self.pause(1.8, 2.65)
            return {
                "checkpoint": "exact-effect-review",
                "mutationExecution": mutation_execution,
                "counts": {**counts, "safeResults": safe_results},
                "providerOrigins": provider_origins,
                "safeResultIds": result_ids,
                "mutationResultIds": mutation_result_ids,
                "mutationAuditEvents": mutation_audit,
                "auditVerified": checkpoint["auditVerified"],
                "executionSurface": "deployed-browser-read-only",
                "finalOutcome": None,
            }

        self.click(
            page.locator('[data-action="approve-apply"]'),
            "approve-recovery",
            "Grant only the exact recovery mutation scope.",
        )
        page.wait_for_function(
            "() => window.__TOOLBRAID_V2__.getState().approvals.apply.granted"
        )
        recovery_approved_state = page.evaluate("window.__TOOLBRAID_V2__.getState()")
        recovery_approved = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        if (
            recovery_approved_state["phase"] != "review"
            or not recovery_approved_state["approvals"]["apply"]["granted"]
            or recovery_approved_state["approvals"]["publish"]["granted"]
        ):
            raise AssertionError(
                "Recovery approval did not leave publication independently locked."
            )
        if sorted(recovery_approved["approvals"]) != ["apply-recovery-option"]:
            raise AssertionError("Recovery approval created an unexpected approval envelope set.")
        self.timeline.mark(
            "recovery-scope-approved",
            "Recovery is fingerprint-bound while publication remains locked.",
            page,
            self.pointer,
        )
        self.pause(1.45, 1.95)

        self.click(
            page.locator('[data-action="approve-publish"]'),
            "approve-publication",
            "Grant the separate evidence-derived publication scope.",
        )
        self.wait_for_phase("approved")
        approved_state = page.evaluate("window.__TOOLBRAID_V2__.getState()")
        approved = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        if (
            approved_state["phase"] != "approved"
            or not approved_state["approvals"]["apply"]["granted"]
            or not approved_state["approvals"]["publish"]["granted"]
        ):
            raise AssertionError("Both exact approval scopes were not granted independently.")
        if sorted(approved["approvals"]) != sorted(MUTATION_NODE_IDS):
            raise AssertionError("Expected two exact, separate approval envelopes.")
        self.timeline.mark(
            "authority-complete",
            "Both exact scopes are ready for ordered execution.",
            page,
            self.pointer,
        )
        self.pause(0.28, 0.48)

        self.click(
            page.locator('[data-action="execute-approved"]'),
            "execute-approved",
            "Execute only the two reviewed mutations.",
        )
        self.wait_for_phase("complete")
        page.wait_for_function(
            "() => Boolean(window.__TOOLBRAID_V2__.getEngineSnapshot().seal)",
            timeout=30_000,
        )
        final_state = page.evaluate("window.__TOOLBRAID_V2__.getState()")
        final = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        self.assert_native_counts(final)
        if final_state["phase"] != "complete":
            raise AssertionError(f"Mission ended in unexpected phase: {final_state['phase']!r}.")
        if final["plan"]["status"] != "completed" or not final["auditVerified"]:
            raise AssertionError("Mission did not complete with a verified audit chain.")
        expected_result_ids = sorted((*SAFE_RESULT_IDS, *MUTATION_NODE_IDS))
        final_result_ids = sorted(final["results"])
        if final_result_ids != expected_result_ids:
            raise AssertionError(f"Mission produced unexpected final results: {final_result_ids}")
        recovery = final["results"]["apply-recovery-option"]
        publication = final["results"]["publish-status-update"]
        if recovery["activeReleaseId"] != "release-1841":
            raise AssertionError("The verified recovery result is missing.")
        if publication["noticeRevision"] != "notice-r9":
            raise AssertionError("The verified publication result is missing.")
        final_origins = sorted(
            provider["origin"] for provider in final["providerDescriptors"]
        )
        if final_origins != self.expected_provider_origins():
            raise AssertionError(
                "Full capture resolved unexpected provider origins: "
                f"{final_origins}"
            )
        mutation_audit = self.mutation_audit_entries(final)
        mutation_failures = [
            entry
            for entry in mutation_audit
            if entry["event"] in {"node.failed", "tool.execution_failed"}
        ]
        if mutation_failures:
            raise AssertionError(f"Mutation execution recorded failures: {mutation_failures}")
        mutation_audit_order = [
            (entry["event"], entry["details"]["nodeId"])
            for entry in mutation_audit
        ]
        if mutation_audit_order != EXPECTED_MUTATION_AUDIT_ORDER:
            raise AssertionError(
                "Mutation execution audit order drifted: "
                f"{mutation_audit_order}"
            )
        seal = self.assert_valid_final_seal(final)
        execution_surface = (
            "deployed-browser-sandbox"
            if self.target == "public-full"
            else "local-deterministic-fixture"
        )
        self.timeline.mark(
            "verified-outcome",
            "Checkout is restored, the update is published, and the audit is sealed.",
            page,
            self.pointer,
        )
        self.pause(4.35, 4.85)

        self.click(
            page.locator('[data-panel-tab="audit"]'),
            "open-audit",
            "Open the sealed integrity trail.",
        )
        panel_hash = page.locator("[data-audit-panel-hash]").inner_text().strip()
        if panel_hash in {"", "Unsealed"}:
            raise AssertionError("The audit panel is not sealed.")
        self.timeline.mark(
            "audit-seal",
            "Ordered receipts and the verified SHA-256 chain close the capture.",
            page,
            self.pointer,
        )
        self.hover(
            page.locator("[data-audit-list]"),
            "inspect-audit-events",
            "Follow the ordered mutation receipts in the integrity trail.",
            dwell=(3.0, 3.5),
        )
        self.hover(
            page.locator("[data-audit-panel-hash]"),
            "verify-audit-hash",
            "Verify the final SHA-256 chain head.",
            dwell=(2.5, 3.0),
        )
        self.pause(3.35, 3.65)
        return {
            "checkpoint": "complete",
            "mutationExecution": True,
            "counts": {**counts, "safeResults": safe_results, "approvals": 2},
            "providerOrigins": final_origins,
            "safeResultIds": SAFE_RESULT_IDS,
            "mutationResultIds": sorted(MUTATION_NODE_IDS),
            "mutationAuditEvents": mutation_audit,
            "auditVerified": final["auditVerified"],
            "executionSurface": execution_surface,
            "finalOutcome": {
                "activeReleaseId": recovery["activeReleaseId"],
                "noticeRevision": publication["noticeRevision"],
                "auditSeal": seal,
            },
        }


def validate_video(path: Path) -> dict[str, Any]:
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise AssertionError("Normalised capture has no video stream.")
        stream = container.streams.video[0]
        rate = float(stream.average_rate or 0)
        duration = (
            float(container.duration / av.time_base)
            if container.duration is not None
            else float(stream.duration * stream.time_base)
            if stream.duration is not None and stream.time_base is not None
            else 0.0
        )
        decoded_frames = sum(1 for _ in container.decode(stream))
        pixel_format = stream.codec_context.format.name if stream.codec_context.format else None
        report = {
            "container": container.format.name,
            "codec": stream.codec_context.name,
            "pixelFormat": pixel_format,
            "width": stream.width,
            "height": stream.height,
            "fps": round(rate, 3),
            "durationSeconds": round(duration, 3),
            "decodedFrames": decoded_frames,
            "expectedFrames": round(duration * FPS),
            "bytes": path.stat().st_size,
        }

    if "webm" not in report["container"]:
        raise AssertionError(f"Unexpected capture container: {report}")
    if report["codec"] != "vp9":
        raise AssertionError(f"Capture is not VP9: {report}")
    if report["pixelFormat"] != "yuv420p":
        raise AssertionError(f"Capture is not yuv420p: {report}")
    if (report["width"], report["height"]) != (WIDTH, HEIGHT):
        raise AssertionError(f"Unexpected capture dimensions: {report}")
    if abs(report["fps"] - FPS) > 0.01:
        raise AssertionError(f"Capture is not constant {FPS} fps: {report}")
    if report["durationSeconds"] <= 0 or report["bytes"] <= 0:
        raise AssertionError(f"Capture is empty: {report}")
    if abs(report["decodedFrames"] - report["expectedFrames"]) > 2:
        raise AssertionError(f"Decoded frame count does not match runtime: {report}")
    return report


def normalise_atomically(raw_capture: Path, output: Path) -> dict[str, Any]:
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = output.with_name(f".{output.stem}.recording-{os.getpid()}{output.suffix}")
    helper_stage = staged.with_name(f"{staged.stem}.normalising{staged.suffix}")
    staged.unlink(missing_ok=True)
    helper_stage.unlink(missing_ok=True)
    try:
        HELPERS.normalise_video(raw_capture, staged)
        validation = validate_video(staged)
        validation["sha256"] = sha256_file(staged)
        validation["atomicReplace"] = True
        staged.replace(output)
        return validation
    finally:
        staged.unlink(missing_ok=True)
        helper_stage.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "target",
        choices=("public", "public-full", "local"),
        nargs="?",
        default="public",
        help=(
            "Record the read-only public flow (default), the complete deployed "
            "browser sandbox, or the local deterministic fixture."
        ),
    )
    parser.add_argument(
        "--url",
        help=f"Public mission-control URL (default: {PUBLIC_URL}).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Atomic VP9 WebM destination inside the repository.",
    )
    parser.add_argument(
        "--timeline",
        type=Path,
        help="Timeline JSON destination under video-production/work.",
    )
    parser.add_argument(
        "--pace",
        type=float,
        default=1.0,
        help="Scale deliberate holds; pointer travel keeps its natural duration.",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Show the installed Chrome window while recording.",
    )
    parser.add_argument(
        "--chrome",
        type=Path,
        default=Path(os.environ.get("TOOLBRAID_CHROME", DEFAULT_CHROME)),
        help="Installed Chrome executable used with native WebMCP flags.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.pace <= 0:
        raise SystemExit("--pace must be greater than zero.")
    if not args.chrome.is_file():
        raise SystemExit(f"Chrome executable not found: {args.chrome}")

    output = resolve_repo_path(
        args.output or DEFAULT_OUTPUTS[args.target],
        label="--output",
    )
    if output.suffix.lower() != ".webm":
        raise SystemExit("--output must use a .webm extension.")
    timeline_path = resolve_work_json(
        args.timeline or WORK_DIR / f"{output.stem}.timeline.json",
        label="--timeline",
    )
    report_path = resolve_work_json(
        WORK_DIR / f"{output.stem}.report.json",
        label="report path",
    )

    if args.target in PUBLIC_TARGETS:
        target_url = validate_public_url(args.url or PUBLIC_URL)
    elif args.target == "local":
        if args.url and validate_http_url(args.url) != LOCAL_URL:
            raise SystemExit("The local target owns its fixture URL; omit --url.")
        target_url = LOCAL_URL
    else:
        raise SystemExit(f"Unsupported capture target: {args.target!r}.")

    execution_mode = {
        "public": "public-read-only",
        "public-full": "public-sandbox-full",
        "local": "local-fixture-full",
    }[args.target]
    remote_deployment = args.target in PUBLIC_TARGETS
    sandbox_execution = args.target in {"public-full", "local"}

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    (ROOT / ".tmp").mkdir(parents=True, exist_ok=True)
    server: subprocess.Popen[str] | None = None
    browser = None
    browser_errors: list[str] = []
    expected_provider_errors: list[str] = []
    timeline = CaptureTimeline(target=args.target, url=target_url, pace=args.pace)
    wall_started = time.monotonic()

    try:
        if args.target == "local":
            HELPERS.assert_ports_available(LOCAL_PORTS)
            server = subprocess.Popen(
                ["node", "scripts/serve-multi-origin.mjs"],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            HELPERS.wait_for_ports(LOCAL_PORTS)
            if server.poll() is not None:
                server_output = server.stdout.read() if server.stdout else ""
                raise RuntimeError(f"Native fixture exited before capture:\n{server_output}")

        with tempfile.TemporaryDirectory(prefix="toolbraid-public-capture-", dir=ROOT / ".tmp") as temp:
            capture_dir = Path(temp)
            raw_capture = capture_dir / "raw-playwright.webm"
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    executable_path=str(args.chrome),
                    headless=not args.headed,
                    args=[
                        "--disable-dev-shm-usage",
                        "--enable-experimental-web-platform-features",
                        "--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport",
                    ],
                )
                context = browser.new_context(
                    viewport={"width": WIDTH, "height": HEIGHT},
                    screen={"width": WIDTH, "height": HEIGHT},
                    device_scale_factor=1,
                    record_video_dir=capture_dir,
                    record_video_size={"width": WIDTH, "height": HEIGHT},
                    color_scheme="dark",
                    reduced_motion="no-preference",
                    locale="en-GB",
                    timezone_id="Europe/London",
                    bypass_csp=False,
                )
                page = context.new_page()
                video = page.video
                page.set_default_timeout(20_000)

                def on_page_error(error: Any) -> None:
                    message = str(error)
                    if message == EXPECTED_PROVIDER_ERROR:
                        expected_provider_errors.append(message)
                    else:
                        browser_errors.append(f"pageerror: {message}")

                def on_console(message: Any) -> None:
                    if message.type == "error":
                        browser_errors.append(f"console.error: {message.text}")

                page.on("pageerror", on_page_error)
                page.on("console", on_console)
                timeline.started = time.monotonic()
                timeline.mark("capture-start", "Capture begins before mission-control load.")
                page.goto(target_url, wait_until="networkidle", timeout=60_000)

                surface = page.evaluate(
                    """() => ({
                      registerTool: typeof document.modelContext?.registerTool,
                      getTools: typeof document.modelContext?.getTools,
                      executeTool: typeof document.modelContext?.executeTool,
                      userAgent: navigator.userAgent,
                    })"""
                )
                required = {"registerTool", "getTools", "executeTool"}
                if any(surface[name] != "function" for name in required):
                    raise AssertionError(f"Native WebMCP surface unavailable: {surface}")

                director = DemoDirector(page, timeline, args.pace, args.target)
                flow = director.run()
                timeline.mark(
                    "capture-end",
                    "The deterministic hold is complete; close the recorded page.",
                    page,
                    director.pointer,
                )
                page.close()
                if video is None:
                    raise RuntimeError("Playwright did not attach a video recorder.")
                video.save_as(str(raw_capture))
                context.close()
                browser.close()
                browser = None

            if browser_errors:
                raise AssertionError("Browser emitted unexpected errors:\n" + "\n".join(browser_errors))
            expected_provider_error_count = 1 if args.target == "local" else 0
            if len(expected_provider_errors) != expected_provider_error_count:
                raise AssertionError(
                    "Unexpected fail-closed primary provider error count: "
                    f"expected {expected_provider_error_count}, got {len(expected_provider_errors)}."
                )

            video_report = normalise_atomically(raw_capture, output)

        generated_at = datetime.now(UTC).isoformat()
        timeline_payload = {
            "format": "toolbraid-public-capture-timeline-v2",
            "generatedAt": generated_at,
            "target": args.target,
            "url": target_url,
            "runtime": "native",
            "executionMode": execution_mode,
            "remoteDeployment": remote_deployment,
            "sandboxExecution": sandbox_execution,
            "resolution": f"{WIDTH}x{HEIGHT}",
            "fps": FPS,
            "pace": args.pace,
            "readOnly": args.target == "public",
            "output": str(output.relative_to(ROOT)),
            "report": str(report_path.relative_to(ROOT)),
            "entries": timeline.entries,
            "pointerTrace": timeline.pointer_trace,
        }
        report_payload = {
            "format": "toolbraid-public-capture-report-v2",
            "status": "PASS",
            "generatedAt": generated_at,
            "target": args.target,
            "url": target_url,
            "runtime": "native",
            "executionMode": execution_mode,
            "remoteDeployment": remote_deployment,
            "sandboxExecution": sandbox_execution,
            "browser": surface["userAgent"],
            "checkpoint": flow["checkpoint"],
            "publicReadOnly": args.target == "public",
            "publicSandboxExecution": args.target == "public-full",
            "mutationExecution": flow["mutationExecution"],
            "counts": flow["counts"],
            "providerOrigins": flow["providerOrigins"],
            "safeResultIds": flow["safeResultIds"],
            "mutationResultIds": flow["mutationResultIds"],
            "mutationAuditEvents": flow["mutationAuditEvents"],
            "auditVerified": flow["auditVerified"],
            "executionSurface": flow.get("executionSurface"),
            "finalOutcome": flow.get("finalOutcome"),
            "expectedProviderFailures": len(expected_provider_errors),
            "unexpectedBrowserErrors": len(browser_errors),
            "cursorTrace": {
                "rawCaptureOverlay": False,
                "compositedAfterCapture": True,
                "style": "system-arrow-26px",
                "clickPulse": False,
                "pointerEvents": "trusted Playwright mouse",
                "trajectory": "seeded-smooth-cubic-bezier",
                "durationModel": "pace-independent-fitts-law",
                "periodicWobble": False,
                "overshoot": False,
                "microCorrection": False,
                "motionSeed": director.motion_seed,
                "sampleCount": len(timeline.pointer_trace),
                "cspBypassed": False,
            },
            "video": video_report,
            "paths": {
                "output": str(output),
                "timeline": str(timeline_path),
                "report": str(report_path),
            },
            "wallSeconds": round(time.monotonic() - wall_started, 2),
        }
        atomic_write_json(timeline_path, timeline_payload)
        atomic_write_json(report_path, report_payload)
        print(json.dumps(report_payload, indent=2))
        return 0
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        HELPERS.stop_process(server)


if __name__ == "__main__":
    raise SystemExit(main())
