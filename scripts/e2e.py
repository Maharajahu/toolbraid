#!/usr/bin/env python3
"""Deterministic browser validation for the ToolBraid challenge demo."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

try:
    from playwright.sync_api import sync_playwright
except ImportError as exc:
    raise SystemExit(
        "Playwright is required for E2E validation. Install with: "
        "python -m pip install -r requirements-e2e.txt && python -m playwright install chromium"
    ) from exc

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("E2E_HOST", "127.0.0.1")

def choose_port() -> int:
    configured = os.environ.get("E2E_PORT")
    if configured:
        return int(configured)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((HOST, 0))
        return int(probe.getsockname()[1])

PORT = choose_port()
BASE_URL = os.environ.get("E2E_BASE_URL", f"http://{HOST}:{PORT}")
CHROMIUM = os.environ.get("E2E_CHROMIUM")
SCREENSHOTS = ROOT / "docs" / "screenshots"


def wait_for_server(host: str, port: int, timeout: float = 12.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"Static server did not become available at {host}:{port}")


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def main() -> int:
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen(
        ["node", "scripts/serve.mjs", str(PORT)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    browser = None
    try:
        wait_for_server(HOST, PORT)
        if server.poll() is not None:
            output = server.stdout.read() if server.stdout else ""
            raise RuntimeError(f"Static server exited before validation:\n{output}")
        browser_errors: list[str] = []
        with sync_playwright() as playwright:
            launch: dict[str, Any] = {
                "headless": True,
                "args": ["--no-sandbox", "--disable-dev-shm-usage"],
            }
            if CHROMIUM:
                launch["executable_path"] = CHROMIUM
            browser = playwright.chromium.launch(**launch)
            context = browser.new_context(viewport={"width": 1600, "height": 1100}, device_scale_factor=1)
            page = context.new_page()
            page.on("pageerror", lambda error: browser_errors.append(f"pageerror: {error}"))
            page.on(
                "console",
                lambda message: browser_errors.append(f"console.{message.type}: {message.text}")
                if message.type == "error" else None,
            )

            page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
            page.wait_for_function("window.ToolBraidApp && window.__toolbraidReady", timeout=10_000)
            page.evaluate("window.__toolbraidReady")

            initial = page.evaluate("window.ToolBraidApp.snapshot()")
            assert_equal(initial["phase"], "idle", "initial phase")
            assert_equal(len(initial["providers"]), 4, "provider count")
            assert_equal(initial["discoveredToolCount"], 6, "provider tool count")
            assert_equal(sum(1 for item in initial["capabilityMappings"] if item["quarantined"]), 1, "quarantined tool count")
            capabilities = {
                item["capability"] for item in initial["capabilityMappings"]
                if item["capability"] and not item["quarantined"]
            }
            assert_equal(
                capabilities,
                {"travel.search", "travel.hold", "accommodation.search", "accommodation.hold", "location.distance"},
                "normalized capability set",
            )

            page.evaluate("window.ToolBraidApp.planMission({})")
            safe = page.evaluate("window.ToolBraidApp.runSafeSteps('e2e')")
            assert_equal(safe["phase"], "approval_required", "phase after safe execution")
            assert_equal(len(safe["plan"]["nodes"]), 7, "plan node count")
            assert_equal(sum(1 for node in safe["plan"]["nodes"] if node["status"] == "completed"), 5, "completed safe nodes")
            assert_equal(sum(1 for node in safe["plan"]["nodes"] if node["approvalRequired"] and node["status"] == "pending"), 2, "approval gates")
            assert safe["recommendation"] is not None
            assert safe["recommendation"]["total"] <= safe["mission"]["budget"]
            assert_equal(safe["recommendation"]["stay"]["id"], "NS-POINT-A", "selected accommodation")
            assert_equal(safe["recommendation"]["total"], 184.9, "recommended total")

            page.screenshot(path=str(SCREENSHOTS / "toolbraid-approval.png"), full_page=True)

            blocked = page.evaluate("window.ToolBraidApp.runApprovedActions('webmcp-agent')")
            assert_equal(blocked["phase"], "approval_required", "agent self-approval guard")
            assert_equal(blocked["humanApproval"], None, "human approval remains absent")
            assert_equal(blocked["holds"]["travel"], None, "travel hold blocked before approval")
            assert_equal(blocked["holds"]["stay"], None, "stay hold blocked before approval")

            page.locator('[data-action="approve"]').click()
            page.wait_for_function("window.ToolBraidApp.snapshot().phase === 'approved'")
            approved = page.evaluate("window.ToolBraidApp.snapshot()")
            assert_equal(approved["phase"], "approved", "phase after human approval")
            assert_equal(approved["humanApproval"]["source"], "human", "approval source")
            assert_equal(approved["humanApproval"]["channel"], "human-ui", "approval channel")
            assert_equal(len(approved["humanApproval"]["actionIds"]), 2, "approved action count")

            final = page.evaluate("window.ToolBraidApp.runApprovedActions('e2e')")
            assert_equal(final["phase"], "completed", "final phase")
            assert_equal(sum(1 for node in final["plan"]["nodes"] if node["status"] == "completed"), 7, "completed plan nodes")
            assert final["holds"]["travel"]["holdId"].startswith("VR-HOLD-")
            assert final["holds"]["stay"]["holdId"].startswith("NS-HOLD-")
            assert_equal(final["recommendation"]["walkingMinutes"], 13, "walking minutes")
            assert_equal(final["recommendation"]["savings"], 65.1, "budget remaining")

            page.screenshot(path=str(SCREENSHOTS / "toolbraid-completed.png"), full_page=True)

            mobile_context = browser.new_context(
                viewport={"width": 390, "height": 844},
                device_scale_factor=1,
                is_mobile=True,
            )
            mobile_page = mobile_context.new_page()
            mobile_page.on("pageerror", lambda error: browser_errors.append(f"mobile pageerror: {error}"))
            mobile_page.on(
                "console",
                lambda message: browser_errors.append(f"mobile console.{message.type}: {message.text}")
                if message.type == "error" else None,
            )
            mobile_page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
            mobile_page.wait_for_function("window.ToolBraidApp && window.__toolbraidReady", timeout=10_000)
            mobile_page.evaluate("window.__toolbraidReady")
            mobile_page.evaluate("window.ToolBraidApp.planMission({})")
            mobile_safe = mobile_page.evaluate("window.ToolBraidApp.runSafeSteps('e2e-mobile')")
            assert_equal(mobile_safe["phase"], "approval_required", "mobile approval phase")
            assert mobile_page.locator('[data-action="approve"]').is_visible()
            overflow = mobile_page.evaluate(
                "document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            if overflow > 1:
                raise AssertionError(f"mobile horizontal overflow: {overflow}px")
            mobile_page.screenshot(
                path=str(SCREENSHOTS / "toolbraid-mobile-approval.png"),
                full_page=True,
            )
            mobile_context.close()

            browser.close()
            browser = None

            if browser_errors:
                raise AssertionError("Browser emitted errors:\n" + "\n".join(browser_errors))

            report = {
                "status": "PASS",
                "runtime": final["runtimeMode"],
                "providers": len(final["providers"]),
                "discoveredTools": final["discoveredToolCount"],
                "quarantined": sum(1 for item in final["capabilityMappings"] if item["quarantined"]),
                "planNodes": len(final["plan"]["nodes"]),
                "recommendation": final["recommendation"],
                "holds": final["holds"],
                "humanApproval": final["humanApproval"],
                "screenshots": [
                    str((SCREENSHOTS / "toolbraid-approval.png").relative_to(ROOT)),
                    str((SCREENSHOTS / "toolbraid-completed.png").relative_to(ROOT)),
                    str((SCREENSHOTS / "toolbraid-mobile-approval.png").relative_to(ROOT)),
                ],
            }
            report_text = json.dumps(report, indent=2)
            (ROOT / "docs" / "e2e-validation.json").write_text(report_text + "\n", encoding="utf-8")
            print(report_text)
            return 0
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        server.terminate()
        try:
            server.wait(timeout=4)
        except subprocess.TimeoutExpired:
            server.kill()
        if server.returncode not in (0, -15, None):
            output = server.stdout.read() if server.stdout else ""
            print(output, file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
