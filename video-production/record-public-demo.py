#!/usr/bin/env python3
"""Record ToolBraid's native WebMCP judge flow at 1920x1080/30 fps.

The public target is deliberately read-only: it discovers, normalises, runs
safe evidence reads, opens the exact-effect review, and stops before either
approval.  The local target starts the existing six-provider native fixture
and completes the two human-approved mutations for deterministic fixture QA.

Examples:
    python video-production/record-public-demo.py public
    python video-production/record-public-demo.py public --headed --pace 0.8
    python video-production/record-public-demo.py local --pace 0.05
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
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
DEFAULT_CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
EXPECTED_PROVIDER_ERROR = "Primary health window is temporarily unavailable."
WIDTH = 1920
HEIGHT = 1080
FPS = 30
PUBLIC_PROVIDER_ORIGINS = sorted(
    f"https://toolbraid-{provider_id}-webmcp.vercel.app"
    for provider_id in ("signals", "pulse", "source", "deploy", "status", "mirage")
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

DEFAULT_OUTPUTS = {
    "public": WORK_DIR / "toolbraid-public-demo-1080p30.webm",
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


def install_capture_cursor(page: Page) -> None:
    """Install the only injected page artifact: a visible recording cursor."""
    page.evaluate(
        """() => {
          const prior = document.getElementById('__toolbraid_capture_cursor__');
          if (prior) prior.remove();

          const cursor = document.createElement('div');
          cursor.id = '__toolbraid_capture_cursor__';
          cursor.setAttribute('aria-hidden', 'true');
          cursor.style.cssText = [
            'position:fixed',
            'left:0',
            'top:0',
            'width:34px',
            'height:42px',
            'pointer-events:none',
            'z-index:2147483647',
            'transform:translate3d(960px,540px,0)',
            'transform-origin:4px 4px',
            'filter:drop-shadow(0 3px 7px rgba(0,0,0,.72))',
            'will-change:transform',
          ].join(';');
          cursor.innerHTML = `
            <svg width="34" height="42" viewBox="0 0 34 42" fill="none"
                 xmlns="http://www.w3.org/2000/svg">
              <path d="M4 3L4.3 31.2L11.9 24.9L17.3 37.5L23.1 34.9L17.7 22.7L27.3 22.2L4 3Z"
                    fill="#F7FBFF" stroke="#07101C" stroke-width="2.6"
                    stroke-linejoin="round"/>
              <circle data-capture-pulse cx="8" cy="7" r="5.5"
                      stroke="#59F6D2" stroke-width="2" opacity="0"/>
            </svg>`;
          document.documentElement.appendChild(cursor);

          const pulse = cursor.querySelector('[data-capture-pulse]');
          document.addEventListener('mousemove', (event) => {
            cursor.style.transform = `translate3d(${event.clientX}px,${event.clientY}px,0)`;
          }, true);
          document.addEventListener('mousedown', () => {
            pulse.animate(
              [
                { opacity: 0.95, transform: 'scale(.55)' },
                { opacity: 0, transform: 'scale(2.35)' },
              ],
              { duration: 360, easing: 'cubic-bezier(.2,.75,.25,1)' },
            );
          }, true);
        }"""
    )


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
        self.pointer = (WIDTH * 0.5, HEIGHT * 0.72)

    def wait(self, seconds: float, *, floor_ms: int = 55) -> None:
        self.page.wait_for_timeout(max(floor_ms, round(seconds * self.pace * 1000)))

    def wait_for_phase(self, phase: str, timeout: float = 30.0) -> None:
        self.page.wait_for_function(
            "expected => window.__TOOLBRAID_V2__?.getState?.().phase === expected",
            arg=phase,
            timeout=timeout * 1000,
        )

    @staticmethod
    def ease_in_out_cubic(value: float) -> float:
        if value < 0.5:
            return 4 * value * value * value
        return 1 - ((-2 * value + 2) ** 3) / 2

    def move_pointer(self, destination: tuple[float, float]) -> None:
        start_x, start_y = self.pointer
        target_x, target_y = destination
        distance = math.hypot(target_x - start_x, target_y - start_y)
        steps = max(8, min(34, round(distance / 42) + 7))
        total_ms = max(100, round((0.28 + min(distance, 900) / 1500) * self.pace * 1000))
        per_step_ms = max(3, round(total_ms / steps))
        for index in range(1, steps + 1):
            progress = self.ease_in_out_cubic(index / steps)
            x = start_x + (target_x - start_x) * progress
            y = start_y + (target_y - start_y) * progress
            self.page.mouse.move(x, y)
            self.page.wait_for_timeout(per_step_ms)
        self.pointer = destination

    def clickable_point(
        self,
        locator: Locator,
        event: str,
        timeout: float = 5.0,
    ) -> tuple[float, float]:
        """Find an unobscured point inside a locator, waiting out transient toasts."""
        deadline = time.monotonic() + timeout
        obstruction = "unknown"
        while time.monotonic() < deadline:
            probe = locator.evaluate(
                r"""(element) => {
                  const rect = element.getBoundingClientRect();
                  const fractions = [
                    [.50, .50], [.50, .32], [.50, .68],
                    [.28, .50], [.72, .50], [.28, .32],
                    [.72, .32], [.28, .68], [.72, .68],
                  ];
                  let obstruction = null;
                  for (const [fx, fy] of fractions) {
                    const x = rect.left + rect.width * fx;
                    const y = rect.top + rect.height * fy;
                    const hit = document.elementFromPoint(x, y);
                    if (hit && (hit === element || element.contains(hit))) {
                      return { point: { x, y }, obstruction: null };
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
                }"""
            )
            if probe["point"] is not None:
                return (float(probe["point"]["x"]), float(probe["point"]["y"]))
            obstruction = probe["obstruction"] or "unknown"
            self.page.wait_for_timeout(100)
        raise AssertionError(
            f"Pointer target for {event!r} stayed obscured by {obstruction}."
        )

    def click(self, locator: Locator, event: str, note: str) -> None:
        locator.wait_for(state="visible")
        locator.scroll_into_view_if_needed()
        self.wait(0.18, floor_ms=35)
        destination = self.clickable_point(locator, event)
        self.move_pointer(destination)
        self.wait(0.32, floor_ms=45)
        hit = locator.evaluate(
            """(element, point) => {
              const hit = document.elementFromPoint(point.x, point.y);
              return Boolean(hit && (hit === element || element.contains(hit)));
            }""",
            {"x": destination[0], "y": destination[1]},
        )
        if not hit:
            destination = self.clickable_point(locator, event)
            self.move_pointer(destination)
            self.wait(0.14, floor_ms=35)
        self.timeline.mark(event, note, self.page, destination)
        self.page.mouse.down(button="left")
        self.wait(0.075, floor_ms=42)
        self.page.mouse.up(button="left")
        self.wait(0.22, floor_ms=45)

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

    def run(self) -> dict[str, Any]:
        page = self.page
        page.wait_for_function("() => Boolean(window.__TOOLBRAID_V2__)", timeout=30_000)
        state = page.evaluate("window.__TOOLBRAID_V2__.getState()")
        if state["phase"] != "idle":
            raise AssertionError(f"Expected idle phase, got {state['phase']!r}.")

        install_capture_cursor(page)
        page.mouse.move(*self.pointer)
        self.timeline.mark(
            "objective",
            "Mission objective and the read-first human authority boundary are visible.",
            page,
            self.pointer,
        )
        self.wait(3.4)

        self.click(
            page.get_by_role("button", name="Start mission", exact=True),
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
        self.wait(4.4)

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
        self.wait(4.0)

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
        self.wait(4.1)

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
        self.wait(5.4)

        self.click(
            page.locator('[data-approval-dock] [data-action="review-approval"]'),
            "open-exact-effect-review",
            "Open the exact-effect human authority checkpoint.",
        )
        dialog = page.locator("[data-approval-dialog]")
        dialog.wait_for(state="visible")
        apply_arguments = page.locator("[data-review-apply-arguments]").inner_text()
        publish_body = page.locator("[data-review-publish-body]").inner_text()
        if "recovery-option-checkout-r3" not in apply_arguments:
            raise AssertionError("The reviewed recovery arguments are missing.")
        if "release-1842" not in publish_body:
            raise AssertionError("The evidence-derived customer update is missing.")
        self.timeline.mark(
            "exact-effects-visible",
            "Separate single-use scopes show exact origins, tools, schemas, arguments, and effects.",
            page,
            self.pointer,
        )
        self.wait(7.0)

        if self.target == "public":
            checkpoint_state = page.evaluate("window.__TOOLBRAID_V2__.getState()")
            checkpoint = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            if checkpoint_state["phase"] != "review":
                raise AssertionError("Public capture moved beyond the review checkpoint.")
            if len(checkpoint["approvals"]) != 0:
                raise AssertionError("Public capture unexpectedly created an approval.")
            provider_origins = sorted(
                provider["origin"] for provider in checkpoint["providerDescriptors"]
            )
            result_ids = sorted(checkpoint["results"])
            mutation_result_ids = sorted(MUTATION_NODE_IDS.intersection(result_ids))
            mutation_audit = [
                entry
                for entry in checkpoint["audit"]
                if entry["event"] in MUTATION_AUDIT_EVENTS
                and entry.get("details", {}).get("nodeId") in MUTATION_NODE_IDS
            ]
            mutation_execution = bool(mutation_result_ids or mutation_audit)
            if provider_origins != PUBLIC_PROVIDER_ORIGINS:
                raise AssertionError(
                    "Public capture resolved unexpected provider origins: "
                    f"{provider_origins}"
                )
            if result_ids != SAFE_RESULT_IDS:
                raise AssertionError(
                    f"Public capture produced unexpected safe-stage results: {result_ids}"
                )
            if mutation_result_ids:
                raise AssertionError(
                    f"Public capture unexpectedly produced mutation results: {mutation_result_ids}"
                )
            if mutation_audit:
                raise AssertionError(
                    f"Public capture unexpectedly recorded mutation execution: {mutation_audit}"
                )
            if mutation_execution:
                raise AssertionError("Public capture unexpectedly executed a mutation.")
            self.timeline.mark(
                "public-read-only-stop",
                "Capture stops with both external mutations unapproved and unexecuted.",
                page,
                self.pointer,
            )
            self.wait(2.2)
            return {
                "checkpoint": "exact-effect-review",
                "mutationExecution": mutation_execution,
                "counts": {**counts, "safeResults": safe_results},
                "providerOrigins": provider_origins,
                "safeResultIds": result_ids,
                "mutationResultIds": mutation_result_ids,
                "mutationAuditEvents": mutation_audit,
                "auditVerified": checkpoint["auditVerified"],
                "finalFixture": None,
            }

        self.click(
            page.locator('[data-action="approve-apply"]'),
            "approve-recovery",
            "Grant only the exact recovery mutation scope.",
        )
        page.wait_for_function(
            "() => window.__TOOLBRAID_V2__.getState().approvals.apply.granted"
        )
        self.timeline.mark(
            "recovery-scope-approved",
            "Recovery is fingerprint-bound while publication remains locked.",
            page,
            self.pointer,
        )
        self.wait(3.0)

        self.click(
            page.locator('[data-action="approve-publish"]'),
            "approve-publication",
            "Grant the separate evidence-derived publication scope.",
        )
        self.wait_for_phase("approved")
        approved = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        if len(approved["approvals"]) != 2:
            raise AssertionError("Expected two exact, separate approval envelopes.")
        self.timeline.mark(
            "local-authority-complete",
            "Both exact scopes are ready for ordered fixture execution.",
            page,
            self.pointer,
        )
        self.wait(3.0)

        self.click(
            page.locator('[data-action="execute-approved"]'),
            "execute-approved",
            "Execute only the two reviewed fixture mutations.",
        )
        self.wait_for_phase("complete")
        page.wait_for_function(
            "() => Boolean(window.__TOOLBRAID_V2__.getEngineSnapshot().seal)",
            timeout=30_000,
        )
        final = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        self.assert_native_counts(final)
        if final["plan"]["status"] != "completed" or not final["auditVerified"]:
            raise AssertionError("Local mission did not complete with a verified audit chain.")
        recovery = final["results"]["apply-recovery-option"]
        publication = final["results"]["publish-status-update"]
        if recovery["activeReleaseId"] != "release-1841":
            raise AssertionError("The local recovery fixture result is missing.")
        if publication["noticeRevision"] != "notice-r9":
            raise AssertionError("The local publication fixture result is missing.")
        self.timeline.mark(
            "verified-local-outcome",
            "Checkout is restored, the update is published, and the audit is sealed.",
            page,
            self.pointer,
        )
        self.wait(5.2)

        self.click(
            page.locator('[data-panel-tab="audit"]'),
            "open-audit",
            "Open the sealed local integrity trail.",
        )
        panel_hash = page.locator("[data-audit-panel-hash]").inner_text().strip()
        if panel_hash in {"", "Unsealed"}:
            raise AssertionError("The local audit panel is not sealed.")
        self.timeline.mark(
            "local-audit-seal",
            "Ordered receipts and the verified SHA-256 chain close the capture.",
            page,
            self.pointer,
        )
        self.wait(5.8)
        return {
            "checkpoint": "complete",
            "mutationExecution": True,
            "counts": {**counts, "safeResults": safe_results, "approvals": 2},
            "providerOrigins": sorted(
                provider["origin"] for provider in final["providerDescriptors"]
            ),
            "safeResultIds": SAFE_RESULT_IDS,
            "mutationResultIds": sorted(MUTATION_NODE_IDS.intersection(final["results"])),
            "mutationAuditEvents": [
                entry
                for entry in final["audit"]
                if entry["event"] in MUTATION_AUDIT_EVENTS
                and entry.get("details", {}).get("nodeId") in MUTATION_NODE_IDS
            ],
            "auditVerified": final["auditVerified"],
            "finalFixture": {
                "activeReleaseId": recovery["activeReleaseId"],
                "noticeRevision": publication["noticeRevision"],
                "auditSeal": final["seal"],
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
        choices=("public", "local"),
        nargs="?",
        default="public",
        help="Record the read-only public flow (default) or complete the local fixture.",
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
        help="Scale deliberate holds and pointer motion; use a small value for local smoke tests.",
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

    if args.target == "local":
        if args.url and validate_http_url(args.url) != LOCAL_URL:
            raise SystemExit("The local target owns its fixture URL; omit --url.")
        target_url = LOCAL_URL
    else:
        target_url = validate_public_url(args.url or PUBLIC_URL)

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
                    # This is used only for the capture cursor overlay installed above.
                    bypass_csp=True,
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
            if len(expected_provider_errors) != 1:
                raise AssertionError(
                    "Expected exactly one fail-closed primary provider error, got "
                    f"{len(expected_provider_errors)}."
                )

            video_report = normalise_atomically(raw_capture, output)

        generated_at = datetime.now(UTC).isoformat()
        timeline_payload = {
            "format": "toolbraid-public-capture-timeline-v1",
            "generatedAt": generated_at,
            "target": args.target,
            "url": target_url,
            "runtime": "native",
            "resolution": f"{WIDTH}x{HEIGHT}",
            "fps": FPS,
            "pace": args.pace,
            "readOnly": args.target == "public",
            "output": str(output.relative_to(ROOT)),
            "report": str(report_path.relative_to(ROOT)),
            "entries": timeline.entries,
        }
        report_payload = {
            "format": "toolbraid-public-capture-report-v1",
            "status": "PASS",
            "generatedAt": generated_at,
            "target": args.target,
            "url": target_url,
            "runtime": "native",
            "browser": surface["userAgent"],
            "checkpoint": flow["checkpoint"],
            "publicReadOnly": args.target == "public",
            "mutationExecution": flow["mutationExecution"],
            "counts": flow["counts"],
            "providerOrigins": flow["providerOrigins"],
            "safeResultIds": flow["safeResultIds"],
            "mutationResultIds": flow["mutationResultIds"],
            "mutationAuditEvents": flow["mutationAuditEvents"],
            "auditVerified": flow["auditVerified"],
            "finalFixture": flow["finalFixture"],
            "expectedProviderFailures": len(expected_provider_errors),
            "unexpectedBrowserErrors": len(browser_errors),
            "cursorOverlay": {
                "present": True,
                "pointerEvents": "trusted Playwright mouse",
                "bypassCspPurpose": "capture cursor overlay only",
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
