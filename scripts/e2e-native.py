#!/usr/bin/env python3
"""Native WebMCP validation against the real Chrome document.modelContext API."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
PORTS = range(4173, 4180)
BASE_URL = "http://127.0.0.1:4173"
DEFAULT_CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
CHROME = Path(os.environ.get("TOOLBRAID_CHROME", DEFAULT_CHROME))


def wait_for_ports(timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    pending = set(PORTS)
    while pending and time.monotonic() < deadline:
        for port in list(pending):
            try:
                with socket.create_connection((HOST, port), timeout=0.2):
                    pending.remove(port)
            except OSError:
                pass
        if pending:
            time.sleep(0.1)
    if pending:
        raise RuntimeError(f"Multi-origin server ports did not open: {sorted(pending)}")


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def wait_until(page: Any, expression: str, timeout: float = 15.0) -> None:
    """Poll through the browser protocol without requiring page-side eval."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.evaluate(expression):
            return
        time.sleep(0.05)
    diagnostics = page.evaluate(
        """() => ({
          phase: window.__TOOLBRAID_V2__?.getState?.().phase ?? null,
          busy: window.__TOOLBRAID_V2__?.getState?.().busy ?? null,
          error: window.__TOOLBRAID_V2__?.getState?.().error ?? null,
          status: document.querySelector('[data-mission-status]')?.textContent?.trim() ?? null,
          toast: document.querySelector('[data-toast]')?.textContent?.trim() ?? null,
        })"""
    )
    raise TimeoutError(f"Timed out waiting for: {expression}; diagnostics={json.dumps(diagnostics, sort_keys=True)}")


def main() -> int:
    if not CHROME.is_file():
        raise SystemExit(f"Chrome executable not found: {CHROME}")

    server = subprocess.Popen(
        ["node", "scripts/serve-multi-origin.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    browser = None
    try:
        wait_for_ports()
        errors: list[str] = []
        expected_provider_errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=str(CHROME),
                headless=os.environ.get("TOOLBRAID_NATIVE_HEADED") != "1",
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--enable-experimental-web-platform-features",
                    "--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport",
                ],
            )
            context = browser.new_context(viewport={"width": 1600, "height": 1100})
            page = context.new_page()
            page.set_default_timeout(15_000)
            def handle_page_error(error: Any) -> None:
                message = str(error)
                if message == "Primary health window is temporarily unavailable.":
                    expected_provider_errors.append(message)
                else:
                    errors.append(f"pageerror: {message}")

            page.on("pageerror", handle_page_error)
            page.on(
                "console",
                lambda message: errors.append(f"console.{message.type}: {message.text}")
                if message.type == "error" else None,
            )
            page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
            wait_until(page, "() => Boolean(window.__TOOLBRAID_V2__)")

            surface = page.evaluate(
                """() => ({
                  registerTool: typeof document.modelContext?.registerTool,
                  getTools: typeof document.modelContext?.getTools,
                  executeTool: typeof document.modelContext?.executeTool,
                  userAgent: navigator.userAgent,
                })"""
            )
            required = {"registerTool": "function", "getTools": "function", "executeTool": "function"}
            for field, expected in required.items():
                assert_equal(surface[field], expected, f"native {field}")

            page.get_by_role("button", name="Start mission", exact=True).click()
            wait_until(page, "() => window.__TOOLBRAID_V2__.getState().phase === 'mapping'")
            discovered = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            assert_equal(discovered["mode"], "native", "runtime mode")
            assert_equal(len(discovered["providerDescriptors"]), 6, "provider origins")
            assert_equal(len(discovered["discoveredTools"]), 9, "native tools")
            assert_equal(len(discovered["normalization"]["quarantined"]), 1, "native quarantine")

            page.get_by_role("button", name="Run 4 safe reads", exact=True).click()
            wait_until(page, "() => window.__TOOLBRAID_V2__.getState().phase === 'review'")
            page.locator('[data-approval-dock] [data-action="review-approval"]').click()
            page.locator('[data-action="approve-apply"]').click()
            wait_until(page, "() => window.__TOOLBRAID_V2__.getState().approvals.apply.granted")
            page.locator('[data-action="approve-publish"]').click()
            wait_until(page, "() => window.__TOOLBRAID_V2__.getState().phase === 'approved'")
            page.locator('[data-action="execute-approved"]').click()
            wait_until(
                page,
                "() => window.__TOOLBRAID_V2__.getState().phase === 'complete' && Boolean(window.__TOOLBRAID_V2__.getEngineSnapshot().seal)",
                timeout=20.0,
            )
            final = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            assert_equal(final["providerState"], None, "native fixture state stays provider-owned")
            assert_equal(final["results"]["apply-recovery-option"]["activeReleaseId"], "release-1841", "native recovery")
            assert_equal(final["results"]["publish-status-update"]["noticeRevision"], "notice-r9", "native publication")
            assert_equal(final["auditVerified"], True, "native audit integrity")
            assert_equal(len(expected_provider_errors), 1, "expected primary-provider failure")

            if errors:
                raise AssertionError("Browser errors:\n" + "\n".join(errors))

            report = {
                "status": "PASS",
                "browser": surface["userAgent"],
                "runtime": final["mode"],
                "providers": len(final["providerDescriptors"]),
                "discoveredTools": len(final["discoveredTools"]),
                "quarantined": len(final["normalization"]["quarantined"]),
                "activeRelease": final["results"]["apply-recovery-option"]["activeReleaseId"],
                "noticeRevision": final["results"]["publish-status-update"]["noticeRevision"],
                "expectedProviderFailures": len(expected_provider_errors),
                "audit": final["seal"],
            }
            text = json.dumps(report, indent=2)
            (ROOT / "docs" / "native-e2e-validation.json").write_text(text + "\n", encoding="utf-8")
            print(text)
            browser.close()
            browser = None
            return 0
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
        if server.returncode not in (0, -15, None):
            output = server.stdout.read() if server.stdout else ""
            print(output, file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
