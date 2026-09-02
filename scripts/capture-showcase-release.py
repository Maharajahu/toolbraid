#!/usr/bin/env python3
"""Capture the approved ToolBraid showcase as 4K stills and a short 1.5x demo."""

from __future__ import annotations

import argparse
import math
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
FFMPEG = Path(r"C:\Claude Code Proiecte\Mastering audio\ffmpeg.exe")

CURSOR_SCRIPT = r"""
(() => {
  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after { cursor: none !important; }
    #release-cursor { position:fixed; inset:0 auto auto 0; z-index:2147483646; width:25px; height:31px; pointer-events:none; opacity:0; transform:translate3d(-100px,-100px,0); filter:drop-shadow(0 2px 5px rgba(0,0,0,.65)); }
    #release-cursor svg { display:block; width:100%; height:100%; }
    .release-click { position:fixed; z-index:2147483645; width:12px; height:12px; margin:-6px 0 0 -6px; pointer-events:none; border:2px solid rgba(100,232,255,.95); border-radius:50%; box-shadow:0 0 16px rgba(100,232,255,.7); animation:release-click 480ms cubic-bezier(.18,.8,.2,1) forwards; }
    @keyframes release-click { from{opacity:1;transform:scale(.55)} to{opacity:0;transform:scale(3.1)} }
  `;
  document.head.append(style);
  const cursor = document.createElement('div');
  cursor.id = 'release-cursor';
  cursor.innerHTML = `<svg viewBox="0 0 25 31" aria-hidden="true"><path d="M2.2 1.7 22 18.4l-9.2 1.5-4.9 8.7-5.7-26.9Z" fill="#f8fbff" stroke="#071019" stroke-width="2.2" stroke-linejoin="round"/><path d="m13 19.7 4.4 7.2" stroke="#071019" stroke-width="2.5" stroke-linecap="round"/></svg>`;
  document.body.append(cursor);
  addEventListener('pointermove', event => { cursor.style.opacity='1'; cursor.style.transform=`translate3d(${event.clientX-2}px,${event.clientY-2}px,0)`; }, {passive:true});
  addEventListener('pointerdown', event => { const ring=document.createElement('i'); ring.className='release-click'; ring.style.left=`${event.clientX}px`; ring.style.top=`${event.clientY}px`; document.body.append(ring); setTimeout(()=>ring.remove(),550); }, {passive:true});
})();
"""


class Pointer:
    def __init__(self, page: Page) -> None:
        self.page = page
        self.x = 1730.0
        self.y = 960.0
        page.mouse.move(self.x, self.y)

    def click(self, target: Locator, duration: float = 0.42) -> None:
        target.scroll_into_view_if_needed()
        box = target.bounding_box()
        if box is None:
            raise RuntimeError("Pointer target has no bounding box")
        end_x = float(box["x"] + box["width"] * 0.5)
        end_y = float(box["y"] + box["height"] * 0.5)
        distance = max(1.0, math.hypot(end_x - self.x, end_y - self.y))
        bend = min(58.0, distance * 0.09)
        px = -(end_y - self.y) / distance
        py = (end_x - self.x) / distance
        cx = (self.x + end_x) * 0.5 + px * bend
        cy = (self.y + end_y) * 0.5 + py * bend
        steps = max(20, round(duration * 60))
        for index in range(1, steps + 1):
            raw = index / steps
            eased = raw * raw * (3 - 2 * raw)
            inverse = 1 - eased
            x = inverse * inverse * self.x + 2 * inverse * eased * cx + eased * eased * end_x
            y = inverse * inverse * self.y + 2 * inverse * eased * cy + eased * eased * end_y
            self.page.mouse.move(x, y)
            time.sleep(duration / steps)
        self.x, self.y = end_x, end_y
        self.page.mouse.down()
        time.sleep(0.075)
        self.page.mouse.up()
        time.sleep(0.18)


def target(page: Page, selector: str, text: str | None = None) -> Locator:
    locator = page.locator(selector)
    if text is not None:
        locator = locator.filter(has_text=text)
    for index in range(locator.count()):
        candidate = locator.nth(index)
        if candidate.is_visible():
            return candidate
    raise RuntimeError(f"No visible target: {selector} {text or ''}")


def ready(page: Page, url: str) -> None:
    page.goto(url, wait_until="networkidle", timeout=30_000)
    page.wait_for_selector('[data-action="toggle-play"]', state="visible", timeout=10_000)
    page.evaluate("document.fonts.ready")


def set_time(page: Page, milliseconds: int) -> None:
    page.locator('[data-timeline]').evaluate(
        "(node, value) => { node.value=String(value); node.dispatchEvent(new Event('input',{bubbles:true})); }",
        milliseconds,
    )


def prepare_completed(page: Page) -> None:
    set_time(page, 32_300)
    page.locator('[data-action="toggle-play"]').first.click()
    page.wait_for_timeout(420)
    page.locator('[data-product-view="approvals"]').click()
    page.locator('[data-approval-record="rollback"]').click()
    page.locator('[data-approval-decision="approve"]').click()
    page.locator('[data-approval-record="publish"]').click()
    page.locator('[data-approval-decision="approve"]').click()
    page.locator('[data-product-panel="approvals"] [data-action="execute"]').click()
    page.wait_for_timeout(300)
    page.locator('[data-product-view="topology"]').click()
    set_time(page, 51_900)
    page.locator('[data-action="toggle-play"]').first.click()
    page.wait_for_timeout(300)


def capture_stills(browser, url: str, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    context = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=2)
    page = context.new_page()
    ready(page, url)
    set_time(page, 18_600)
    page.screenshot(path=output / "toolbraid-living-braid-4k.png")

    page.locator('[data-product-view="live"]').click()
    page.locator('[data-action="refresh-bridge"]').click()
    page.wait_for_timeout(820)
    page.screenshot(path=output / "toolbraid-live-bridge-4k.png")

    page.locator('[data-product-view="topology"]').click()
    set_time(page, 32_300)
    page.locator('[data-action="toggle-play"]').first.click()
    page.wait_for_timeout(420)
    page.locator('[data-product-view="approvals"]').click()
    page.wait_for_timeout(360)
    page.screenshot(path=output / "toolbraid-exact-approval-4k.png")

    page.locator('[data-approval-record="rollback"]').click()
    page.locator('[data-approval-decision="approve"]').click()
    page.locator('[data-approval-record="publish"]').click()
    page.locator('[data-approval-decision="approve"]').click()
    page.locator('[data-product-panel="approvals"] [data-action="execute"]').click()
    page.wait_for_timeout(300)
    page.locator('[data-product-view="topology"]').click()
    set_time(page, 51_900)
    page.locator('[data-action="toggle-play"]').first.click()
    page.wait_for_timeout(300)
    page.locator('[data-product-view="audit"]').click()
    page.locator('[data-action="toggle-audit"]').click()
    page.wait_for_timeout(360)
    page.screenshot(path=output / "toolbraid-sealed-audit-4k.png")
    context.close()

    mobile = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3)
    page = mobile.new_page()
    ready(page, url)
    set_time(page, 18_600)
    page.screenshot(path=output / "toolbraid-living-braid-mobile.png")
    mobile.close()


def record_demo(browser, url: str, output: Path, temp_root: Path) -> Path:
    video_dir = temp_root / "video"
    video_dir.mkdir(parents=True, exist_ok=True)
    context = browser.new_context(
        viewport={"width": 1920, "height": 1080},
        device_scale_factor=2,
        record_video_dir=video_dir,
        record_video_size={"width": 3840, "height": 2160},
    )
    page = context.new_page()
    ready(page, url)
    page.evaluate(CURSOR_SCRIPT)
    pointer = Pointer(page)
    page.wait_for_timeout(650)

    pointer.click(target(page, '[data-action="toggle-play"]'))
    page.wait_for_timeout(3_800)
    pointer.click(target(page, '[data-product-view="live"]'))
    page.wait_for_timeout(900)
    pointer.click(target(page, '[data-action="refresh-bridge"]'))
    page.wait_for_timeout(1_450)
    pointer.click(target(page, '[data-product-view="topology"]'))
    page.wait_for_timeout(600)
    pointer.click(target(page, '[data-chapter-nav] button', 'Evidence'))
    pointer.click(target(page, '[data-action="toggle-play"]'))
    page.wait_for_timeout(2_500)
    pointer.click(target(page, '[data-product-view="evidence"]'))
    pointer.click(target(page, '[data-action="analyze-evidence"]'))
    page.wait_for_timeout(1_450)
    pointer.click(target(page, '[data-product-view="topology"]'))
    pointer.click(target(page, '[data-chapter-nav] button', 'Prepare'))
    pointer.click(target(page, '[data-action="toggle-play"]'))
    page.wait_for_timeout(2_100)
    pointer.click(target(page, '[data-product-view="approvals"]'))
    pointer.click(target(page, '[data-approval-record="rollback"]'))
    pointer.click(target(page, '[data-approval-decision="approve"]'))
    pointer.click(target(page, '[data-approval-record="publish"]'))
    pointer.click(target(page, '[data-approval-decision="approve"]'))
    pointer.click(target(page, '[data-product-panel="approvals"] [data-action="execute"]'))
    page.wait_for_timeout(1_000)
    pointer.click(target(page, '[data-product-view="topology"]'))
    set_time(page, 51_900)
    page.wait_for_timeout(550)
    pointer.click(target(page, '[data-product-view="audit"]'))
    pointer.click(target(page, '[data-action="toggle-audit"]'))
    page.wait_for_timeout(1_200)

    video = page.video
    context.close()
    if video is None:
        raise RuntimeError("Playwright did not create a release video")
    raw = temp_root / "toolbraid-showcase.webm"
    video.save_as(raw)
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(FFMPEG), "-y", "-hide_banner", "-loglevel", "warning", "-i", str(raw),
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(output),
    ]
    subprocess.run(command, check=True)
    return output


def make_gif(video: Path, output: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="toolbraid-gif-") as directory:
        palette = Path(directory) / "palette.png"
        filters = "fps=12,scale=1280:-1:flags=lanczos"
        subprocess.run([str(FFMPEG), "-y", "-hide_banner", "-loglevel", "warning", "-t", "16", "-i", str(video), "-vf", f"{filters},palettegen=max_colors=160:stats_mode=diff", str(palette)], check=True)
        subprocess.run([str(FFMPEG), "-y", "-hide_banner", "-loglevel", "warning", "-t", "16", "-i", str(video), "-i", str(palette), "-lavfi", f"{filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0", str(output)], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:43173/")
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "screenshots")
    parser.add_argument("--stills-only", action="store_true")
    args = parser.parse_args()
    if not CHROME.exists() or not FFMPEG.exists():
        raise FileNotFoundError("Chrome or FFmpeg is unavailable")
    with tempfile.TemporaryDirectory(prefix="toolbraid-release-") as directory:
        temp_root = Path(directory)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=str(CHROME), headless=True)
            capture_stills(browser, args.url, args.output)
            if not args.stills_only:
                video = record_demo(browser, args.url, args.output / "toolbraid-living-braid-4k.mp4", temp_root)
            browser.close()
        if not args.stills_only:
            make_gif(video, args.output / "toolbraid-live-mission.gif")
    print(f"Captured ToolBraid release media in {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
