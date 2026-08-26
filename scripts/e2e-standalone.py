#!/usr/bin/env python3
"""End-to-end test for the exact self-contained deployment artifact."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = Path(os.environ.get("TOOLBRAID_E2E_FILE", ROOT / "dist" / "index.html")).resolve()
CHROMIUM = os.environ.get("E2E_CHROMIUM") or None
SCREENSHOT_DIR = ROOT / "docs" / "screenshots"
REPORT_PATH = ROOT / "docs" / "e2e-standalone-validation.json"


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def load_artifact(page) -> dict[str, Any]:
    html = ARTIFACT.read_text(encoding="utf-8")
    chunk_files = sorted(ARTIFACT.parent.glob("c*.txt"))
    if chunk_files and "fetch('/c" in html:
        # Exercise the exact multi-file deployment bootstrap without navigating
        # through the administrator-managed browser network policy.
        html = html.replace("<head>", '<head><base href="http://toolbraid.local/">', 1)

        def serve_chunk(route) -> None:
            name = route.request.url.rsplit("/", 1)[-1]
            candidate = ARTIFACT.parent / name
            if candidate.exists():
                route.fulfill(status=200, body=candidate.read_bytes(), content_type="text/plain")
            else:
                route.fulfill(status=404, body="missing")

        page.route("http://toolbraid.local/**", serve_chunk)
    page.set_content(html, wait_until="load", timeout=30_000)
    page.wait_for_function("window.ToolBraidApp && window.__toolbraidReady", timeout=15_000)
    page.evaluate("() => window.__toolbraidReady")
    return page.evaluate("() => window.ToolBraidApp.snapshot()")


def run_flow(page, prefix: str) -> dict[str, Any]:
    initial = load_artifact(page)
    assert_equal(initial["phase"], "idle", f"{prefix} initial phase")
    assert_equal(len(initial["providers"]), 4, f"{prefix} provider count")
    assert_equal(initial["discoveredToolCount"], 6, f"{prefix} discovered tools")
    assert_equal(sum(1 for item in initial["capabilityMappings"] if item["quarantined"]), 1, f"{prefix} quarantine count")

    planned = page.evaluate("() => window.ToolBraidApp.planMission({})")
    assert_equal(planned["phase"], "planned", f"{prefix} planned phase")
    assert_equal(len(planned["plan"]["nodes"]), 7, f"{prefix} plan node count")

    safe = page.evaluate("() => window.ToolBraidApp.runSafeSteps('e2e-safe')")
    assert_equal(safe["phase"], "approval_required", f"{prefix} approval phase")
    assert_equal(sum(1 for node in safe["plan"]["nodes"] if node["status"] == "completed"), 5, f"{prefix} safe completed nodes")
    assert_equal(safe["recommendation"]["total"], 184.9, f"{prefix} recommendation total")
    assert_equal(safe["recommendation"]["walkingMinutes"], 13, f"{prefix} walking minutes")
    assert_equal(safe["holds"]["travel"], None, f"{prefix} travel hold before approval")
    assert_equal(safe["holds"]["stay"], None, f"{prefix} stay hold before approval")

    blocked = page.evaluate("() => window.ToolBraidApp.runApprovedActions('webmcp-agent')")
    assert_equal(blocked["status"], "approval_required", f"{prefix} agent self-approval guard")
    assert_equal(blocked["holds"]["travel"], None, f"{prefix} no agent-created travel hold")

    approve = page.locator('[data-action="approve"]')
    if not approve.is_visible():
        raise AssertionError(f"{prefix} human approval button is not visible")
    approve.click()
    page.wait_for_function("window.ToolBraidApp.snapshot().phase === 'approved'", timeout=10_000)
    approved = page.evaluate("() => window.ToolBraidApp.snapshot()")
    assert_equal(approved["humanApproval"]["source"], "human", f"{prefix} approval source")
    assert_equal(len(approved["humanApproval"]["actionIds"]), 2, f"{prefix} approved actions")
    assert_equal(len(approved["humanApproval"]["planFingerprint"]), 64, f"{prefix} plan fingerprint")
    assert_equal(len(approved["humanApproval"]["actionFingerprints"]), 2, f"{prefix} action fingerprints")
    assert_equal(approved["humanApproval"]["consumedAt"], None, f"{prefix} approval initially unconsumed")

    final = page.evaluate("() => window.ToolBraidApp.runApprovedActions('e2e-approved')")
    assert_equal(final["phase"], "completed", f"{prefix} final phase")
    assert_equal(sum(1 for node in final["plan"]["nodes"] if node["status"] == "completed"), 7, f"{prefix} completed nodes")
    if not final["holds"]["travel"]["holdId"].startswith("VR-HOLD-"):
        raise AssertionError(f"{prefix} invalid travel hold")
    if not final["holds"]["stay"]["holdId"].startswith("NS-HOLD-"):
        raise AssertionError(f"{prefix} invalid stay hold")
    if not final["humanApproval"]["consumedAt"]:
        raise AssertionError(f"{prefix} approval record was not consumed")

    replay = page.evaluate("() => window.ToolBraidApp.runApprovedActions('e2e-replay')")
    assert_equal(replay["status"], "approval_replay_blocked", f"{prefix} replay guard")
    assert_equal(replay["phase"], "completed", f"{prefix} phase preserved after replay")
    return final


def main() -> int:
    if not ARTIFACT.exists():
        raise FileNotFoundError(f"Standalone artifact not found: {ARTIFACT}")
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    with sync_playwright() as playwright:
        launch = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if CHROMIUM:
            launch["executable_path"] = CHROMIUM
        browser = playwright.chromium.launch(**launch)

        desktop_context = browser.new_context(viewport={"width": 1600, "height": 1100})
        desktop = desktop_context.new_page()
        desktop.on("pageerror", lambda error: errors.append(f"desktop pageerror: {error}"))
        desktop.on("console", lambda message: errors.append(f"desktop console.{message.type}: {message.text}") if message.type == "error" else None)
        final = run_flow(desktop, "desktop")
        desktop.screenshot(path=str(SCREENSHOT_DIR / "toolbraid-completed.png"), full_page=True)
        desktop_context.close()

        mobile_context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        mobile = mobile_context.new_page()
        mobile.on("pageerror", lambda error: errors.append(f"mobile pageerror: {error}"))
        mobile.on("console", lambda message: errors.append(f"mobile console.{message.type}: {message.text}") if message.type == "error" else None)
        mobile_initial = load_artifact(mobile)
        assert_equal(mobile_initial["phase"], "idle", "mobile initial phase")
        mobile.evaluate("() => window.ToolBraidApp.planMission({})")
        mobile_safe = mobile.evaluate("() => window.ToolBraidApp.runSafeSteps('mobile-safe')")
        assert_equal(mobile_safe["phase"], "approval_required", "mobile approval phase")
        if not mobile.locator('[data-action="approve"]').is_visible():
            raise AssertionError("mobile approval button is not visible")
        overflow = mobile.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        if overflow > 1:
            raise AssertionError(f"mobile horizontal overflow: {overflow}px")
        mobile.screenshot(path=str(SCREENSHOT_DIR / "toolbraid-mobile-approval.png"), full_page=True)
        mobile_context.close()
        browser.close()

    if errors:
        raise AssertionError("Browser emitted errors:\n" + "\n".join(errors))

    report = {
        "status": "PASS",
        "artifact": str(ARTIFACT),
        "artifactBytes": ARTIFACT.stat().st_size,
        "runtimeMode": final["runtimeMode"],
        "providers": len(final["providers"]),
        "discoveredTools": final["discoveredToolCount"],
        "quarantinedTools": sum(1 for item in final["capabilityMappings"] if item["quarantined"]),
        "planNodes": len(final["plan"]["nodes"]),
        "completedNodes": sum(1 for node in final["plan"]["nodes"] if node["status"] == "completed"),
        "recommendation": final["recommendation"],
        "holds": final["holds"],
        "approval": {
            "source": final["humanApproval"]["source"],
            "planFingerprint": final["humanApproval"]["planFingerprint"],
            "actionFingerprintCount": len(final["humanApproval"]["actionFingerprints"]),
            "consumedAt": final["humanApproval"]["consumedAt"],
            "replayBlocked": True,
        },
        "desktopViewport": {"width": 1600, "height": 1100},
        "mobileViewport": {"width": 390, "height": 844},
        "browserErrors": 0,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
