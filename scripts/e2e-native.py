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
PUBLIC_BASE_URL = "https://toolbraid-webmcp.vercel.app"
TARGET_BASE_URL = os.environ.get("TOOLBRAID_NATIVE_BASE_URL", BASE_URL).rstrip("/")
TARGET_URL = f"{TARGET_BASE_URL}/live.html?mission=production-recovery&mode=guided"
READ_ONLY = os.environ.get("TOOLBRAID_NATIVE_READ_ONLY") == "1"
DEFAULT_CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
CHROME = Path(os.environ.get("TOOLBRAID_CHROME", DEFAULT_CHROME))

PUBLIC_PROVIDER_ORIGINS = sorted([
    "https://toolbraid-signals-webmcp.vercel.app",
    "https://toolbraid-pulse-webmcp.vercel.app",
    "https://toolbraid-source-webmcp.vercel.app",
    "https://toolbraid-deploy-webmcp.vercel.app",
    "https://toolbraid-status-webmcp.vercel.app",
    "https://toolbraid-mirage-webmcp.vercel.app",
])
SAFE_RESULT_IDS = sorted([
    "read-service-health",
    "read-release-history",
    "read-deployment-history",
    "read-status-notice",
    "correlate-evidence",
])
MUTATION_NODE_IDS = {"apply-recovery-option", "publish-status-update"}
MUTATION_AUDIT_EVENTS = {
    "node.started",
    "node.completed",
    "node.failed",
    "tool.execution_started",
    "tool.execution_failed",
}


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
    if READ_ONLY and TARGET_BASE_URL != PUBLIC_BASE_URL:
        raise SystemExit(
            "TOOLBRAID_NATIVE_READ_ONLY=1 is reserved for the exact public judge URL "
            f"({PUBLIC_BASE_URL})."
        )

    server = None
    if TARGET_BASE_URL == BASE_URL:
        server = subprocess.Popen(
            ["node", "scripts/serve-multi-origin.mjs"],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    browser = None
    try:
        if server is not None:
            wait_for_ports()
        errors: list[str] = []
        expected_provider_errors: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=str(CHROME),
                headless=os.environ.get("TOOLBRAID_NATIVE_HEADED") != "1",
                args=[
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
            page.goto(TARGET_URL, wait_until="networkidle", timeout=30_000)
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

            page.locator("[data-context-action]").click()
            wait_until(page, "() => window.__TOOLBRAID_V2__.getState().phase === 'mapping'")
            discovered = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            assert_equal(discovered["mode"], "native", "runtime mode")
            assert_equal(len(discovered["providerDescriptors"]), 6, "provider origins")
            assert_equal(len(discovered["discoveredTools"]), 9, "native tools")

            page.get_by_role("button", name="Map live capabilities", exact=True).click()
            wait_until(
                page,
                "() => Object.keys(window.__TOOLBRAID_V2__.getState().mappings).length === 7",
            )
            discovered = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            assert_equal(len(discovered["normalization"]["quarantined"]), 1, "native quarantine")

            page.get_by_role("button", name="Run 4 safe reads", exact=True).click()
            wait_until(page, "() => window.__TOOLBRAID_V2__.getState().phase === 'preparing'")
            if READ_ONLY:
                checkpoint = page.evaluate(
                    """() => ({
                      state: window.__TOOLBRAID_V2__.getState(),
                      engine: window.__TOOLBRAID_V2__.getEngineSnapshot(),
                    })"""
                )
                assert_equal(checkpoint["state"]["phase"], "preparing", "read-only checkpoint")
                assert_equal(checkpoint["engine"]["mode"], "native", "read-only runtime mode")
                result_ids = sorted(checkpoint["engine"]["results"])
                provider_origins = sorted(
                    provider["origin"] for provider in checkpoint["engine"]["providerDescriptors"]
                )
                mutation_audit = [
                    entry for entry in checkpoint["engine"]["audit"]
                    if entry["event"] in MUTATION_AUDIT_EVENTS
                    and entry.get("details", {}).get("nodeId") in MUTATION_NODE_IDS
                ]
                mutation_result_ids = sorted(MUTATION_NODE_IDS.intersection(result_ids))
                mutation_execution = bool(mutation_result_ids or mutation_audit)

                assert_equal(result_ids, SAFE_RESULT_IDS, "exact safe-stage result ids")
                assert_equal(provider_origins, PUBLIC_PROVIDER_ORIGINS, "public provider origins")
                assert_equal(mutation_result_ids, [], "mutation results before approval")
                assert_equal(mutation_audit, [], "mutation execution audit before approval")
                assert_equal(mutation_execution, False, "mutation execution before approval")
                assert_equal(len(expected_provider_errors), 0, "unexpected fixture-only provider failure")
                assert_equal(checkpoint["engine"]["auditVerified"], True, "read-only audit integrity")
                if errors:
                    raise AssertionError("Browser errors:\n" + "\n".join(errors))

                report = {
                    "status": "PASS",
                    "browser": surface["userAgent"],
                    "target": TARGET_URL,
                    "runtime": checkpoint["engine"]["mode"],
                    "checkpoint": checkpoint["state"]["phase"],
                    "providers": len(checkpoint["engine"]["providerDescriptors"]),
                    "providerOrigins": provider_origins,
                    "discoveredTools": len(checkpoint["engine"]["discoveredTools"]),
                    "quarantined": len(checkpoint["engine"]["normalization"]["quarantined"]),
                    "safeResults": len(result_ids),
                    "safeResultIds": result_ids,
                    "expectedProviderFailures": len(expected_provider_errors),
                    "mutationResultIds": mutation_result_ids,
                    "mutationAuditEvents": mutation_audit,
                    "mutationExecution": mutation_execution,
                    "auditVerified": checkpoint["engine"]["auditVerified"],
                }
                text = json.dumps(report, indent=2)
                (ROOT / "docs" / "native-public-readonly-validation.json").write_text(text + "\n", encoding="utf-8")
                print(text)
                browser.close()
                browser = None
                return 0

            page.get_by_role("button", name="Prepare 2 exact effects", exact=True).click()
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
        if server is not None:
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
