#!/usr/bin/env python3
"""Record the real ToolBraid recovery flow as a deterministic 1080p WebM.

The default path exercises Chrome's native ``document.modelContext`` surface
against the six cross-origin provider fixtures.  The recorder owns every
process it starts, records a clean 1920x1080 product plate, and normalises the
result to constant 30 fps for the final edit.

Examples:
    python scripts/record-demo-video.py
    python scripts/record-demo-video.py --pace 0.08 --output video-production/work/smoke.webm
    python scripts/record-demo-video.py --runtime harness
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from fractions import Fraction
from pathlib import Path
from typing import Any

try:
    from playwright.sync_api import Locator, Page, sync_playwright
except ImportError as exc:
    raise SystemExit(
        "Playwright is required. Install with: "
        "python -m pip install -r requirements-e2e.txt && "
        "python -m playwright install chromium"
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
NATIVE_PORTS = tuple(range(4173, 4180))
NATIVE_BASE_URL = "http://127.0.0.1:4173"
DEFAULT_CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
DEFAULT_OUTPUT = ROOT / "video-production" / "work" / "toolbraid-product-demo-1080p30.webm"
TIMELINE_OUTPUT = ROOT / "video-production" / "capture-timeline.json"
WIDTH = 1920
HEIGHT = 1080
FPS = 30


def choose_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((HOST, 0))
        return int(probe.getsockname()[1])


def wait_for_ports(ports: tuple[int, ...], timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    pending = set(ports)
    while pending and time.monotonic() < deadline:
        for port in tuple(pending):
            try:
                with socket.create_connection((HOST, port), timeout=0.2):
                    pending.remove(port)
            except OSError:
                pass
        if pending:
            time.sleep(0.1)
    if pending:
        raise RuntimeError(f"Server ports did not open: {sorted(pending)}")


def assert_ports_available(ports: tuple[int, ...]) -> None:
    occupied: list[int] = []
    for port in ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((HOST, port))
            except OSError:
                occupied.append(port)
    if occupied:
        raise RuntimeError(
            "Native demo ports are already occupied: "
            f"{occupied}. Stop the existing ToolBraid server and retry."
        )


def stop_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


@dataclass
class Timeline:
    runtime: str
    pace: float
    started: float = field(default_factory=time.monotonic)
    entries: list[dict[str, Any]] = field(default_factory=list)

    def mark(self, scene: str, note: str, page: Page | None = None) -> None:
        phase = None
        if page is not None:
            try:
                phase = page.evaluate("window.__TOOLBRAID_V2__?.getState?.().phase ?? null")
            except Exception:
                phase = None
        self.entries.append(
            {
                "timeSeconds": round(time.monotonic() - self.started, 3),
                "scene": scene,
                "phase": phase,
                "note": note,
            }
        )

    def write(self, *, output: Path, raw_output: Path, duration: float) -> None:
        TIMELINE_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "format": "toolbraid-capture-timeline-v1",
            "generatedAt": datetime.now(UTC).isoformat(),
            "runtime": self.runtime,
            "resolution": f"{WIDTH}x{HEIGHT}",
            "fps": FPS,
            "pace": self.pace,
            "durationSeconds": round(duration, 3),
            "output": str(output.relative_to(ROOT)),
            "rawOutput": str(raw_output.relative_to(ROOT)),
            "entries": self.entries,
        }
        TIMELINE_OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


class DemoDirector:
    def __init__(self, page: Page, timeline: Timeline, pace: float) -> None:
        self.page = page
        self.timeline = timeline
        self.pace = pace

    def hold(self, seconds: float) -> None:
        self.page.wait_for_timeout(max(50, round(seconds * self.pace * 1000)))

    def click(self, locator: Locator, scene: str, note: str) -> None:
        locator.scroll_into_view_if_needed()
        locator.hover()
        try:
            locator.focus()
        except Exception:
            pass
        self.hold(0.45)
        self.timeline.mark(f"{scene}-interaction", note, self.page)
        locator.click()

    def wait_for_phase(self, phase: str, timeout: float = 20.0) -> None:
        self.page.wait_for_function(
            "expected => window.__TOOLBRAID_V2__?.getState?.().phase === expected",
            arg=phase,
            timeout=timeout * 1000,
        )

    def run(self) -> None:
        page = self.page
        page.wait_for_function("() => Boolean(window.__TOOLBRAID_V2__)", timeout=15_000)
        initial = page.evaluate("window.__TOOLBRAID_V2__.getState()")
        if initial["phase"] != "idle":
            raise AssertionError(f"Expected idle phase, got {initial['phase']!r}")

        self.timeline.mark(
            "objective",
            "Human objective and read-first authority boundary are visible.",
            page,
        )
        self.hold(3.8)

        start = page.get_by_role("button", name="Start mission", exact=True)
        self.click(start, "discover", "Start cross-origin WebMCP discovery.")
        self.wait_for_phase("mapping")
        snapshot = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        if snapshot["mode"] != self.timeline.runtime:
            raise AssertionError(
                f"Expected {self.timeline.runtime!r} runtime, got {snapshot['mode']!r}"
            )
        if len(snapshot["discoveredTools"]) != 9:
            raise AssertionError("The demo did not discover all nine WebMCP tools.")
        if len(snapshot["normalization"]["quarantined"]) != 1:
            raise AssertionError("The adversarial tool was not quarantined.")
        self.timeline.mark(
            "normalized-topology",
            "Six origins, seven canonical mappings, and one quarantined tool are visible.",
            page,
        )
        self.hold(5.2)

        unsafe_node = page.locator(
            '[data-constellation] [data-node-id][data-capability="unsafe.override"]'
        )
        self.click(
            unsafe_node,
            "quarantine",
            "Inspect the unsafe approval-bypass tool excluded before semantic scoring.",
        )
        self.timeline.mark(
            "quarantine-inspector",
            "Inspector shows the quarantine decision and metadata security signals.",
            page,
        )
        self.hold(4.8)

        mapping_tab = page.locator('[data-panel-tab="mapping"]')
        self.click(mapping_tab, "mapping", "Open canonical capability mappings.")
        self.timeline.mark(
            "semantic-mapping",
            "The normalized capability pack and confidence bindings are visible.",
            page,
        )
        self.hold(4.8)

        evidence_tab = page.locator('[data-panel-tab="evidence"]')
        self.click(evidence_tab, "observe", "Return to live evidence inspection.")
        safe_reads = page.get_by_role("button", name="Run 4 safe reads", exact=True)
        self.click(safe_reads, "observe", "Run the four independent read-only evidence tools.")
        self.wait_for_phase("review")
        safe_snapshot = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        audit_events = [entry["event"] for entry in safe_snapshot["audit"]]
        if "tool.execution_failed" not in audit_events or "tool.failover_selected" not in audit_events:
            raise AssertionError("The deterministic fail-closed and failover path did not execute.")
        if safe_snapshot["plan"]["status"] != "approval_required":
            raise AssertionError("Safe reads did not stop at the approval checkpoint.")
        health_node = page.locator(
            '[data-constellation] [data-node-id][data-capability="service.health.read"]'
        )
        self.click(
            health_node,
            "failover",
            "Inspect evidence from the compatible read-only fallback provider.",
        )
        self.timeline.mark(
            "safe-evidence-ready",
            "Evidence is correlated; fallback is recorded; both mutations remain locked.",
            page,
        )
        self.hold(6.0)

        review = page.locator('[data-approval-dock] [data-action="review-approval"]')
        self.click(review, "authorize", "Open the exact-effect human authority checkpoint.")
        page.locator('[data-approval-dialog]').wait_for(state="visible")
        if "recovery-option-checkout-r3" not in page.locator(
            "[data-review-apply-arguments]"
        ).inner_text():
            raise AssertionError("The exact recovery arguments are not visible.")
        if "release-1842" not in page.locator("[data-review-publish-body]").inner_text():
            raise AssertionError("The evidence-derived customer update is not visible.")
        self.timeline.mark(
            "exact-effects",
            "Separate single-use approvals show exact origins, tools, schemas and arguments.",
            page,
        )
        self.hold(6.5)

        approve_apply = page.locator('[data-action="approve-apply"]')
        self.click(approve_apply, "approve-apply", "Grant only the recovery mutation scope.")
        page.wait_for_function(
            "() => window.__TOOLBRAID_V2__.getState().approvals.apply.granted"
        )
        self.timeline.mark(
            "recovery-approved",
            "Recovery scope is fingerprint-bound; publication is still locked.",
            page,
        )
        self.hold(3.2)

        approve_publish = page.locator('[data-action="approve-publish"]')
        self.click(approve_publish, "approve-publish", "Grant the separate publication scope.")
        self.wait_for_phase("approved")
        approved = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        if len(approved["approvals"]) != 2:
            raise AssertionError("Expected two separate approval envelopes.")
        self.timeline.mark(
            "authority-complete",
            "Both exact scopes are approved and ready for ordered execution.",
            page,
        )
        self.hold(3.2)

        execute = page.locator('[data-action="execute-approved"]')
        self.click(execute, "execute", "Execute only the two reviewed actions.")
        self.wait_for_phase("complete")
        page.wait_for_function(
            "() => Boolean(window.__TOOLBRAID_V2__.getEngineSnapshot().seal)",
            timeout=20_000,
        )
        final = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
        if final["plan"]["status"] != "completed" or not final["auditVerified"]:
            raise AssertionError("Mission did not complete with a verified audit chain.")
        if final["results"]["apply-recovery-option"]["activeReleaseId"] != "release-1841":
            raise AssertionError("The verified recovery result is missing.")
        if final["results"]["publish-status-update"]["noticeRevision"] != "notice-r9":
            raise AssertionError("The verified publication result is missing.")
        self.timeline.mark(
            "verified-outcome",
            "Checkout restored, customer update published, receipts present, audit sealed.",
            page,
        )
        self.hold(6.3)

        audit_tab = page.locator('[data-panel-tab="audit"]')
        self.click(audit_tab, "audit", "Open the full local integrity trail.")
        panel_hash = page.locator('[data-audit-panel-hash]').inner_text().strip()
        if panel_hash in {"", "Unsealed"}:
            raise AssertionError("The audit panel is not sealed.")
        self.timeline.mark(
            "audit-seal",
            "Ordered receipts and the verified SHA-256 chain close the demonstration.",
            page,
        )
        self.hold(7.0)


def ffmpeg_normalise(source: Path, destination: Path, ffmpeg: str) -> None:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vf",
        f"fps={FPS},scale={WIDTH}:{HEIGHT}:flags=lanczos",
        "-an",
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "20",
        "-b:v",
        "0",
        "-row-mt",
        "1",
        "-pix_fmt",
        "yuv420p",
        str(destination),
    ]
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"ffmpeg normalisation failed:\n{completed.stderr}")


def pyav_normalise(source: Path, destination: Path) -> None:
    try:
        import av
    except ImportError as exc:
        raise RuntimeError(
            "Neither ffmpeg nor PyAV is available to normalise the capture to 30 fps."
        ) from exc

    with av.open(str(source)) as input_container:
        input_stream = input_container.streams.video[0]
        input_rate = float(input_stream.average_rate or 25)
        inferred_frame_seconds = 1.0 / max(1.0, input_rate)
        with av.open(str(destination), mode="w", format="webm") as output_container:
            output_stream = output_container.add_stream("libvpx-vp9", rate=FPS)
            output_stream.width = WIDTH
            output_stream.height = HEIGHT
            output_stream.pix_fmt = "yuv420p"
            output_stream.bit_rate = 12_000_000
            output_stream.options = {
                "deadline": "good",
                "cpu-used": "5",
                "row-mt": "1",
            }

            next_pts = 0
            previous_rgb = None
            previous_time = 0.0
            last_time = 0.0

            def encode_rgb(rgb: Any, pts: int) -> None:
                frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
                if frame.width != WIDTH or frame.height != HEIGHT:
                    frame = frame.reformat(width=WIDTH, height=HEIGHT, format="yuv420p")
                else:
                    frame = frame.reformat(format="yuv420p")
                frame.pts = pts
                frame.time_base = Fraction(1, FPS)
                for packet in output_stream.encode(frame):
                    output_container.mux(packet)

            for frame in input_container.decode(input_stream):
                frame_time = float(frame.pts * frame.time_base) if frame.pts is not None else last_time
                if previous_rgb is None:
                    previous_rgb = frame.to_ndarray(format="rgb24")
                    previous_time = frame_time
                    last_time = frame_time
                    continue
                while next_pts / FPS < frame_time:
                    encode_rgb(previous_rgb, next_pts)
                    next_pts += 1
                previous_rgb = frame.to_ndarray(format="rgb24")
                previous_time = frame_time
                last_time = frame_time

            if previous_rgb is None:
                raise RuntimeError("Playwright produced an empty video.")

            if input_container.duration is not None:
                end_time = float(input_container.duration / av.time_base)
            elif input_stream.duration is not None and input_stream.time_base is not None:
                end_time = float(input_stream.duration * input_stream.time_base)
            else:
                end_time = previous_time + inferred_frame_seconds
            end_time = max(end_time, last_time + inferred_frame_seconds)
            while next_pts / FPS < end_time:
                encode_rgb(previous_rgb, next_pts)
                next_pts += 1
            for packet in output_stream.encode(None):
                output_container.mux(packet)


def normalise_video(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.stem}.normalising{destination.suffix}")
    temporary.unlink(missing_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        ffmpeg_normalise(source, temporary, ffmpeg)
    else:
        pyav_normalise(source, temporary)
    temporary.replace(destination)


def validate_video(path: Path) -> dict[str, Any]:
    try:
        import av
    except ImportError as exc:
        raise RuntimeError("PyAV is required for final capture validation.") from exc

    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        rate = float(stream.average_rate) if stream.average_rate else 0.0
        duration = (
            float(container.duration / av.time_base)
            if container.duration is not None
            else float(stream.duration * stream.time_base)
            if stream.duration is not None and stream.time_base is not None
            else 0.0
        )
        report = {
            "width": stream.width,
            "height": stream.height,
            "fps": round(rate, 3),
            "durationSeconds": round(duration, 3),
            "codec": stream.codec_context.name,
            "bytes": path.stat().st_size,
        }
    if report["width"] != WIDTH or report["height"] != HEIGHT:
        raise AssertionError(f"Unexpected video dimensions: {report}")
    if abs(report["fps"] - FPS) > 0.01:
        raise AssertionError(f"Capture is not constant {FPS} fps: {report}")
    if report["durationSeconds"] <= 0 or report["bytes"] <= 0:
        raise AssertionError(f"Capture is empty: {report}")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--runtime",
        choices=("native", "harness"),
        default="native",
        help="Use real Chrome WebMCP (default) or the deterministic local test harness.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Normalised 1080p30 WebM destination.",
    )
    parser.add_argument(
        "--pace",
        type=float,
        default=1.0,
        help="Scale deliberate scene holds; use a small value only for smoke tests.",
    )
    parser.add_argument(
        "--chrome",
        type=Path,
        default=Path(os.environ.get("TOOLBRAID_CHROME", DEFAULT_CHROME)),
        help="Chrome executable used by the native WebMCP recording path.",
    )
    parser.add_argument("--headed", action="store_true", help="Show the recording browser window.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.pace <= 0:
        raise SystemExit("--pace must be greater than zero.")

    output = args.output.resolve() if args.output.is_absolute() else (ROOT / args.output).resolve()
    try:
        output.relative_to(ROOT)
    except ValueError as exc:
        raise SystemExit("--output must stay inside the ToolBraid repository.") from exc
    output.parent.mkdir(parents=True, exist_ok=True)
    raw_output = output.with_name(f"{output.stem}-raw.webm")

    server: subprocess.Popen[str] | None = None
    browser = None
    browser_errors: list[str] = []
    expected_provider_errors: list[str] = []
    runtime = args.runtime
    timeline = Timeline(runtime=runtime, pace=args.pace)
    started = time.monotonic()

    if runtime == "native":
        if not args.chrome.is_file():
            raise SystemExit(f"Chrome executable not found: {args.chrome}")
        assert_ports_available(NATIVE_PORTS)
        ports = NATIVE_PORTS
        base_url = NATIVE_BASE_URL
        server_command = ["node", "scripts/serve-multi-origin.mjs"]
    else:
        port = choose_port()
        ports = (port,)
        base_url = f"http://{HOST}:{port}"
        server_command = ["node", "scripts/serve.mjs", str(port)]

    (ROOT / ".tmp").mkdir(parents=True, exist_ok=True)
    try:
        server = subprocess.Popen(
            server_command,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        wait_for_ports(ports)
        if server.poll() is not None:
            output_text = server.stdout.read() if server.stdout else ""
            raise RuntimeError(f"ToolBraid server exited before recording:\n{output_text}")

        with tempfile.TemporaryDirectory(prefix="toolbraid-video-", dir=ROOT / ".tmp") as video_dir:
            with sync_playwright() as playwright:
                launch: dict[str, Any] = {
                    "headless": not args.headed,
                    "args": ["--no-sandbox", "--disable-dev-shm-usage"],
                }
                if runtime == "native":
                    launch["executable_path"] = str(args.chrome)
                    launch["args"].extend(
                        [
                            "--enable-experimental-web-platform-features",
                            "--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport",
                        ]
                    )
                browser = playwright.chromium.launch(**launch)
                context = browser.new_context(
                    viewport={"width": WIDTH, "height": HEIGHT},
                    screen={"width": WIDTH, "height": HEIGHT},
                    device_scale_factor=1,
                    record_video_dir=video_dir,
                    record_video_size={"width": WIDTH, "height": HEIGHT},
                    color_scheme="dark",
                    reduced_motion="no-preference",
                )
                page = context.new_page()
                video = page.video
                page.set_default_timeout(15_000)

                def handle_page_error(error: Any) -> None:
                    message = str(error)
                    if message == "Primary health window is temporarily unavailable.":
                        expected_provider_errors.append(message)
                    else:
                        browser_errors.append(f"pageerror: {message}")

                page.on("pageerror", handle_page_error)
                page.on(
                    "console",
                    lambda message: browser_errors.append(
                        f"console.{message.type}: {message.text}"
                    )
                    if message.type == "error"
                    else None,
                )
                timeline.started = time.monotonic()
                timeline.mark("capture-start", "Browser capture begins before product load.")
                page.goto(base_url, wait_until="networkidle", timeout=30_000)

                if runtime == "native":
                    surface = page.evaluate(
                        """() => ({
                          registerTool: typeof document.modelContext?.registerTool,
                          getTools: typeof document.modelContext?.getTools,
                          executeTool: typeof document.modelContext?.executeTool,
                        })"""
                    )
                    if any(value != "function" for value in surface.values()):
                        raise AssertionError(f"Native WebMCP surface unavailable: {surface}")

                DemoDirector(page, timeline, args.pace).run()
                timeline.mark("capture-end", "Hold complete; close the recorded page.", page)
                page.close()
                if video is None:
                    raise RuntimeError("Playwright did not attach a video recorder.")
                raw_output.unlink(missing_ok=True)
                video.save_as(str(raw_output))
                context.close()
                browser.close()
                browser = None

        if browser_errors:
            raise AssertionError("Browser emitted errors:\n" + "\n".join(browser_errors))
        if runtime == "native" and len(expected_provider_errors) != 1:
            raise AssertionError(
                "Expected exactly one fail-closed primary provider error, got "
                f"{len(expected_provider_errors)}."
            )

        normalise_video(raw_output, output)
        report = validate_video(output)
        timeline.write(
            output=output,
            raw_output=raw_output,
            duration=report["durationSeconds"],
        )
        result = {
            "status": "PASS",
            "runtime": runtime,
            "output": str(output),
            "rawOutput": str(raw_output),
            "timeline": str(TIMELINE_OUTPUT),
            "video": report,
            "wallSeconds": round(time.monotonic() - started, 2),
        }
        print(json.dumps(result, indent=2))
        return 0
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        stop_process(server)


if __name__ == "__main__":
    raise SystemExit(main())
