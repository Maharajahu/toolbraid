#!/usr/bin/env python3
"""Deterministic browser validation for the ToolBraid production-recovery product."""
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


def assert_desktop_viewport_stable(page: Any, label: str) -> None:
    metrics = page.evaluate(
        """() => ({
          scrollX: window.scrollX,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        })"""
    )
    if abs(metrics["scrollX"]) > 1 or metrics["overflow"] > 1:
        raise AssertionError(f"{label} desktop viewport shifted: {metrics}")


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
            page.set_default_timeout(10_000)
            page.on("pageerror", lambda error: browser_errors.append(f"pageerror: {error}"))
            page.on(
                "console",
                lambda message: browser_errors.append(f"console.{message.type}: {message.text}")
                if message.type == "error" else None,
            )

            page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
            page.wait_for_function("window.__TOOLBRAID_V2__", timeout=10_000)

            initial = page.evaluate("window.__TOOLBRAID_V2__.getState()")
            assert_equal(initial["phase"], "idle", "initial phase")
            if not page.locator("#mission-canvas").is_visible():
                raise AssertionError("mission canvas is not visible")

            page.keyboard.press("Tab")
            assert_equal(page.evaluate("document.activeElement?.classList.contains('skip-link')"), True, "skip-link focus")
            page.keyboard.press("Enter")
            assert_equal(page.evaluate("document.activeElement?.id"), "mission-canvas", "skip-link target")

            targets = page.evaluate(
                """() => Object.fromEntries(['edit-objective', 'copy-origin'].map(action => {
                  const element = document.querySelector(`[data-action="${action}"]`);
                  const rect = element.getBoundingClientRect();
                  return [action, { width: rect.width, height: rect.height }];
                }))"""
            )
            for action, size in targets.items():
                if size["width"] < 24 or size["height"] < 24:
                    raise AssertionError(f"{action} target is below 24px: {size}")

            command_trigger = page.get_by_role("button", name="Open command menu")
            command_trigger.click()
            page.wait_for_function("document.activeElement?.matches('[data-command-input]')")
            assert_equal(page.evaluate("document.activeElement?.matches('[data-command-input]')"), True, "command focus")
            page.locator('[data-command-input]').fill("reset")
            visible_commands = page.locator('[data-command-menu] [data-action]:visible')
            assert_equal(visible_commands.count(), 1, "filtered command count")
            assert_equal(visible_commands.first.get_attribute("data-action"), "reset", "filtered command")
            page.keyboard.press("Escape")
            assert_equal(page.locator('[data-command-menu]').is_hidden(), True, "command Escape close")
            page.wait_for_function("document.activeElement?.matches('[data-action=\"open-command\"]')")
            assert_equal(page.evaluate("document.activeElement?.matches('[data-action=\"open-command\"]')"), True, "command focus return")

            page.locator('[data-view="live"]').click()
            assert_equal(page.locator('[data-universal-view]').is_visible(), True, "live universal view")
            assert_equal(page.locator('[data-walkthrough-view]').is_hidden(), True, "walkthrough hidden in live view")
            assert_equal(page.locator('[data-view="live"]').get_attribute("aria-current"), "page", "live view current state")
            page.wait_for_function("document.activeElement?.matches('[data-universal-view]')")
            assert_equal(page.locator('[data-view][aria-current="page"]').count(), 1, "single current product view")
            if "does not read, mirror or simulate" not in page.locator('[data-universal-view]').inner_text():
                raise AssertionError("live universal view does not state its extension boundary")
            assert_desktop_viewport_stable(page, "live universal")
            page.locator('[data-view="evidence"]').click()
            assert_equal(page.locator('.evidence-panel').is_visible(), True, "evidence view")
            assert_equal(page.locator('[data-panel-content="evidence"]').is_visible(), True, "evidence content")
            assert_equal(page.locator('[data-view="evidence"]').get_attribute("aria-current"), "page", "evidence view current state")
            page.wait_for_function("document.activeElement?.matches('.evidence-panel')")
            page.locator('[data-view="audit"]').click()
            assert_equal(page.locator('.evidence-panel').is_visible(), True, "audit view")
            assert_equal(page.locator('[data-panel-content="audit"]').is_visible(), True, "audit content")
            assert_equal(page.locator('[data-view="audit"]').get_attribute("aria-current"), "page", "audit view current state")
            page.locator('[data-view="approvals"]').click()
            assert_equal(page.locator('[data-approvals-view]').is_visible(), True, "approvals view")
            assert_equal(page.locator('[data-approval-count]').is_hidden(), True, "idle approval badge hidden")
            assert_equal(page.locator('[data-view="approvals"]').get_attribute("aria-current"), "page", "approvals view current state")
            page.wait_for_function("document.activeElement?.matches('[data-approvals-view]')")
            page.locator('[data-view="help"]').click()
            assert_equal(page.locator('[data-help-drawer]').is_visible(), True, "help drawer")
            assert_equal(page.locator('[data-view="help"]').get_attribute("aria-current"), None, "help is a dialog, not a product view")
            assert_equal(page.locator('[data-view="help"]').get_attribute("aria-expanded"), "true", "help expanded state")
            assert_equal(page.locator('[data-view][aria-current="page"]').count(), 1, "single current view behind help dialog")
            page.wait_for_function("document.activeElement?.matches('[data-action=\"close-help\"]')")
            page.keyboard.press("Tab")
            assert_equal(page.evaluate("document.activeElement?.matches('[data-action=\"close-help\"]')"), True, "help focus trap")
            page.locator('[data-action="close-help"]').click()
            assert_equal(page.locator('[data-help-drawer]').is_hidden(), True, "help drawer close")
            assert_equal(page.locator('[data-view="help"]').get_attribute("aria-expanded"), "false", "help collapsed state")
            page.locator('[data-view="topology"]').click()
            assert_equal(page.locator('[data-walkthrough-view]').is_visible(), True, "walkthrough view restored")
            assert_equal(page.locator('[data-view="topology"]').get_attribute("aria-current"), "page", "walkthrough current state")

            first_tab = page.locator('[data-panel-tab]').first
            first_tab.focus()
            first_tab.press("ArrowRight")
            assert_equal(page.evaluate("document.activeElement?.getAttribute('data-panel-tab')"), "mapping", "tab arrow navigation")

            page.locator('[data-context-action]').click()
            page.wait_for_function("window.__TOOLBRAID_V2__.getState().phase === 'mapping'", timeout=10_000)
            discovered = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            assert_equal(discovered["mode"], "test", "local runtime mode")
            assert_equal(len(discovered["discoveredTools"]), 9, "discovered tool count")
            assert_equal(len(discovered["normalization"]["mappings"]), 7, "canonical mappings")
            assert_equal(len(discovered["normalization"]["quarantined"]), 1, "quarantined tool count")
            assert_equal(discovered["auditVerified"], True, "discovery audit integrity")
            if not discovered["plan"]["id"].startswith("recovery-"):
                raise AssertionError("mission plan does not use a unique recovery identity")

            graph_focus = page.locator('[data-constellation] [data-node-id][tabindex="0"]')
            assert_equal(graph_focus.count(), 1, "graph roving tabindex")
            selected_before = graph_focus.get_attribute("data-node-id")
            graph_focus.focus()
            graph_focus.press("ArrowRight")
            page.wait_for_function("document.activeElement?.matches('[data-constellation] [data-node-id][aria-pressed=\"true\"]')")
            selected_after = page.evaluate("document.activeElement?.getAttribute('data-node-id')")
            if not selected_after or selected_after == selected_before:
                raise AssertionError("graph arrow navigation did not move focus")
            assert_equal(page.evaluate("document.activeElement?.getAttribute('aria-pressed')"), "true", "graph selected state")

            page.get_by_role("button", name="Run 4 safe reads", exact=True).click()
            page.wait_for_function("window.__TOOLBRAID_V2__.getState().phase === 'review'", timeout=10_000)
            safe = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            assert_equal(safe["plan"]["status"], "approval_required", "phase after safe execution")
            assert_equal(safe["plan"]["mutationArgumentsFinalized"], True, "mutation arguments finalized")
            assert_equal(len(safe["results"]), 7, "safe result count")
            assert any(entry["event"] == "tool.execution_failed" for entry in safe["audit"])
            assert any(entry["event"] == "tool.failover_selected" for entry in safe["audit"])
            apply_node = next(node for node in safe["plan"]["nodes"] if node["id"] == "apply-recovery-option")
            publish_node = next(node for node in safe["plan"]["nodes"] if node["id"] == "publish-status-update")
            assert_equal(apply_node["arguments"]["recoveryOptionId"], "recovery-option-checkout-r3", "recovery option")
            assert_equal(apply_node["arguments"]["quoteRevision"], "quote-r3", "quote revision")
            assert_equal(publish_node["arguments"]["noticeRevision"], "notice-r8", "notice revision")
            if "release-1842" not in publish_node["arguments"]["body"]:
                raise AssertionError("customer update was not derived from correlated evidence")

            page.wait_for_timeout(4_300)
            assert_desktop_viewport_stable(page, "approval")
            page.locator('[data-view="approvals"]').click()
            assert_equal(page.locator('[data-approvals-view]').is_visible(), True, "review approvals view")
            assert_equal(page.locator('[data-approval-count]').is_visible(), True, "actionable approval badge")
            page.locator('[data-approvals-view] [data-action="review-approval"]').first.click()
            assert_equal(page.locator('[data-approval-dialog]').is_visible(), True, "approval dialog from approvals view")
            page.keyboard.press("Escape")
            assert_equal(page.locator('[data-approval-dialog]').is_hidden(), True, "approval view dialog close")
            page.locator('[data-view="topology"]').click()
            page.screenshot(path=str(SCREENSHOTS / "toolbraid-recovery-approval.png"), full_page=True)
            page.locator('[data-approval-dock] [data-action="review-approval"]').click()
            if not page.locator('[data-approval-dialog]').is_visible():
                raise AssertionError("approval dialog did not open")
            page.wait_for_function("document.activeElement?.matches('[data-action=\"close-approval\"]')")
            assert_equal(page.evaluate("document.activeElement?.matches('[data-action=\"close-approval\"]')"), True, "approval focus entry")
            page.keyboard.press("Shift+Tab")
            assert_equal(page.evaluate("document.activeElement?.matches('[data-action=\"approve-publish\"]')"), True, "approval focus trap")
            page.keyboard.press("Escape")
            assert_equal(page.locator('[data-approval-dialog]').is_hidden(), True, "approval Escape close")
            page.wait_for_function("document.activeElement?.matches('[data-approval-dock] [data-action=\"review-approval\"]')")
            assert_equal(page.evaluate("document.activeElement?.matches('[data-approval-dock] [data-action=\"review-approval\"]')"), True, "approval focus return")
            page.locator('[data-approval-dock] [data-action="review-approval"]').click()
            page.locator('[data-approval-review="apply"] .technical-details summary').click()
            if "recovery-option-checkout-r3" not in page.locator('[data-review-apply-arguments]').inner_text():
                raise AssertionError("exact recovery arguments are not visible")
            if "release-1842" not in page.locator('[data-review-publish-body]').inner_text():
                raise AssertionError("exact customer message is not visible")

            page.evaluate("document.querySelector('[data-action=\"approve-apply\"]').click()")
            synthetic = page.evaluate("window.__TOOLBRAID_V2__.getState()")
            assert_equal(synthetic["approvals"]["apply"]["granted"], False, "synthetic approval guard")

            page.locator('[data-action="approve-apply"]').click()
            page.wait_for_function("window.__TOOLBRAID_V2__.getState().approvals.apply.granted")
            page.locator('[data-action="approve-publish"]').click()
            page.wait_for_function("window.__TOOLBRAID_V2__.getState().phase === 'approved'")
            approved = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            assert_equal(len(approved["approvals"]), 2, "separate approval envelopes")
            assert all(len(envelope["fingerprint"]) == 64 for envelope in approved["approvals"].values())

            page.locator('[data-action="execute-approved"]').click()
            page.wait_for_function(
                "window.__TOOLBRAID_V2__.getState().phase === 'complete' && window.__TOOLBRAID_V2__.getEngineSnapshot().seal",
                timeout=10_000,
            )
            final = page.evaluate("window.__TOOLBRAID_V2__.getEngineSnapshot()")
            assert_equal(final["plan"]["status"], "completed", "final plan status")
            assert_equal(final["providerState"]["activeReleaseId"], "release-1841", "active release")
            assert_equal(final["providerState"]["noticeRevision"], "notice-r9", "published notice revision")
            assert_equal(final["providerState"]["appliedRequestCount"], 1, "recovery mutation count")
            assert_equal(final["providerState"]["publishedRequestCount"], 1, "publish mutation count")
            assert_equal(final["auditVerified"], True, "final audit integrity")
            assert_equal(final["seal"]["algorithm"], "sha256-chain-v1", "audit algorithm")
            assert_equal(len(final["seal"]["head"]), 64, "audit seal length")
            audit_events = final["audit"]
            apply_completed = next(
                index for index, entry in enumerate(audit_events)
                if entry["event"] == "node.completed" and entry["details"].get("nodeId") == "apply-recovery-option"
            )
            publish_started = next(
                index for index, entry in enumerate(audit_events)
                if entry["event"] == "node.started" and entry["details"].get("nodeId") == "publish-status-update"
            )
            assert apply_completed < publish_started, "publication started before recovery completed"
            first_mutation_started = min(
                index for index, entry in enumerate(audit_events)
                if entry["event"] == "node.started"
                and entry["details"].get("nodeId") in {"apply-recovery-option", "publish-status-update"}
            )
            claimed_before_execution = [
                entry for entry in audit_events[:first_mutation_started] if entry["event"] == "approval.claimed"
            ]
            assert_equal(len(claimed_before_execution), 2, "atomic approval-set claims")

            page.wait_for_timeout(4_300)
            assert_desktop_viewport_stable(page, "completed")
            dock_layout = page.evaluate(
                """() => {
                  const workspace = document.querySelector('.workspace').getBoundingClientRect();
                  const topology = document.querySelector('.topology-stage').getBoundingClientRect();
                  const inspector = document.querySelector('.evidence-panel').getBoundingClientRect();
                  const dock = document.querySelector('[data-approval-dock]').getBoundingClientRect();
                  return {
                    workspaceRight: workspace.right,
                    topologyRight: topology.right,
                    inspectorLeft: inspector.left,
                    dockLeft: dock.left,
                    dockRight: dock.right,
                  };
                }"""
            )
            if dock_layout["dockRight"] < dock_layout["workspaceRight"] - 20:
                raise AssertionError(f"approval dock does not reach the workspace edge: {dock_layout}")
            if dock_layout["dockRight"] <= dock_layout["inspectorLeft"] + 24:
                raise AssertionError(f"approval dock does not use the inspector-side space: {dock_layout}")
            if dock_layout["dockLeft"] >= dock_layout["topologyRight"]:
                raise AssertionError(f"approval dock lost its topology-side span: {dock_layout}")
            page.screenshot(path=str(SCREENSHOTS / "toolbraid-recovery-completed.png"), full_page=True)

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
            mobile_page.wait_for_function("window.__TOOLBRAID_V2__", timeout=10_000)
            mobile_page.evaluate("window.__TOOLBRAID_V2__.start()")
            mobile_page.wait_for_function("window.__TOOLBRAID_V2__.getState().phase === 'mapping'", timeout=10_000)
            mobile_page.evaluate("window.__TOOLBRAID_V2__.runSafeReads()")
            mobile_page.wait_for_function("window.__TOOLBRAID_V2__.getState().phase === 'review'", timeout=10_000)
            assert mobile_page.locator('[data-approval-dock] [data-action="review-approval"]').is_visible()
            overflow = mobile_page.evaluate(
                "document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            if overflow > 1:
                raise AssertionError(f"mobile horizontal overflow: {overflow}px")
            mobile_page.wait_for_timeout(4_300)
            mobile_page.screenshot(
                path=str(SCREENSHOTS / "toolbraid-recovery-mobile.png"),
                full_page=True,
            )
            mobile_context.close()

            narrow_context = browser.new_context(
                viewport={"width": 320, "height": 800},
                device_scale_factor=1,
                is_mobile=True,
            )
            narrow_page = narrow_context.new_page()
            narrow_page.on("pageerror", lambda error: browser_errors.append(f"narrow pageerror: {error}"))
            narrow_page.on(
                "console",
                lambda message: browser_errors.append(f"narrow console.{message.type}: {message.text}")
                if message.type == "error" else None,
            )
            narrow_page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
            narrow_page.wait_for_function("window.__TOOLBRAID_V2__", timeout=10_000)
            narrow_page.evaluate("window.__TOOLBRAID_V2__.start()")
            narrow_page.wait_for_function("window.__TOOLBRAID_V2__.getState().phase === 'mapping'", timeout=10_000)
            graph_metrics = narrow_page.evaluate(
                """() => {
                  const viewport = document.querySelector('[data-constellation-viewport]');
                  return { clientWidth: viewport.clientWidth, scrollWidth: viewport.scrollWidth, scrollLeft: viewport.scrollLeft };
                }"""
            )
            if graph_metrics["scrollWidth"] <= graph_metrics["clientWidth"]:
                raise AssertionError(f"narrow graph is not horizontally scrollable: {graph_metrics}")
            active_graph_node = narrow_page.locator('[data-constellation] [data-node-id][tabindex="0"]')
            active_graph_node.focus()
            active_graph_node.press("End")
            narrow_page.wait_for_timeout(50)
            assert_equal(
                narrow_page.locator('[data-constellation] [data-node-id][tabindex="0"]').count(),
                1,
                "narrow graph roving tabindex",
            )
            assert_equal(
                narrow_page.evaluate("document.activeElement?.getAttribute('aria-pressed')"),
                "true",
                "narrow graph focus visibility",
            )
            if narrow_page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") > 1:
                raise AssertionError("320px page has global horizontal overflow")
            overlaps = narrow_page.evaluate(
                """() => {
                  const labels = [...document.querySelectorAll('.tb-node__label')];
                  const pairs = [['Prepare recovery', 'Mirage Fixture'], ['Release history', 'GitHub Source']];
                  const rect = text => labels.find(node => node.textContent.trim() === text)?.getBoundingClientRect();
                  return pairs.map(([left, right]) => {
                    const a = rect(left); const b = rect(right);
                    if (!a || !b) return { pair: [left, right], missing: true };
                    return {
                      pair: [left, right],
                      overlap: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
                    };
                  });
                }"""
            )
            if any(result.get("missing") or result.get("overlap") for result in overlaps):
                raise AssertionError(f"narrow graph label overlap: {overlaps}")
            narrow_context.close()

            browser.close()
            browser = None

            if browser_errors:
                raise AssertionError("Browser emitted errors:\n" + "\n".join(browser_errors))

            report = {
                "status": "PASS",
                "runtime": final["mode"],
                "providers": len(final["providerDescriptors"]),
                "discoveredTools": len(final["discoveredTools"]),
                "quarantined": len(final["normalization"]["quarantined"]),
                "planNodes": len(final["plan"]["nodes"]),
                "activeRelease": final["providerState"]["activeReleaseId"],
                "noticeRevision": final["providerState"]["noticeRevision"],
                "audit": final["seal"],
                "screenshots": [
                    str((SCREENSHOTS / "toolbraid-recovery-approval.png").relative_to(ROOT)),
                    str((SCREENSHOTS / "toolbraid-recovery-completed.png").relative_to(ROOT)),
                    str((SCREENSHOTS / "toolbraid-recovery-mobile.png").relative_to(ROOT)),
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
