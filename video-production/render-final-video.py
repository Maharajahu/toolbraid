#!/usr/bin/env python3
"""Render the ToolBraid WebMCP Challenge master from its locked config.

The compositor is deliberately self-contained: PyAV handles decoding/encoding,
Pillow/numpy handle the deterministic outro, and CairoSVG rasterizes the logo.
No external ffmpeg executable or non-project stock media is used.
"""

from __future__ import annotations

import argparse
import atexit
import bisect
import hashlib
import io
import json
import math
import os
import random
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable

import av
import cairosvg
import numpy as np
from av.audio.resampler import AudioResampler
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy.signal import resample_poly


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "render-config.json"
DEFAULT_OUTPUT = SCRIPT_DIR / "output" / "ToolBraid-WebMCP-Challenge-1080p.mp4"
DEFAULT_REPORT = SCRIPT_DIR / "output" / "ToolBraid-WebMCP-Challenge-1080p.render-report.json"
AV_TIME_BASE = int(av.time_base)
MIX_TRUE_PEAK_TARGET_DBTP = -1.5


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def lerp(a: float, b: float, amount: float) -> float:
    return a + (b - a) * amount


def smoothstep(value: float) -> float:
    value = clamp(value)
    return value * value * (3.0 - 2.0 * value)


def ease_out_cubic(value: float) -> float:
    return 1.0 - (1.0 - clamp(value)) ** 3


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    if len(value) != 6:
        raise ValueError(f"Expected six-digit color, got {value!r}")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]


def parse_time(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        raise TypeError(f"Unsupported timestamp: {value!r}")
    bits = value.strip().replace(",", ".").split(":")
    if len(bits) == 1:
        return float(bits[0])
    if len(bits) == 2:
        return float(bits[0]) * 60.0 + float(bits[1])
    if len(bits) == 3:
        return float(bits[0]) * 3600.0 + float(bits[1]) * 60.0 + float(bits[2])
    raise ValueError(f"Unsupported timestamp: {value!r}")


def resolve_from_config(config_path: Path, value: str) -> Path:
    return (config_path.parent / value).resolve()


def svg_to_image(path: Path, width: int, height: int) -> Image.Image:
    png = cairosvg.svg2png(
        url=str(path),
        output_width=width,
        output_height=height,
    )
    with Image.open(io.BytesIO(png)) as image:
        # Preserve transparency for the ToolBraid mark.
        return image.convert("RGBA")


@dataclass(frozen=True)
class Caption:
    start: float
    end: float
    text: str


class CaptionTrack:
    def __init__(self, path: Path | None, offset_seconds: float = 0.0) -> None:
        self.path = path
        self.captions: list[Caption] = []
        if path is not None and path.exists():
            self.captions = [
                Caption(
                    caption.start + offset_seconds,
                    caption.end + offset_seconds,
                    caption.text,
                )
                for caption in self._load(path)
            ]

    @staticmethod
    def _first(entry: dict[str, Any], keys: Iterable[str]) -> Any:
        for key in keys:
            if key in entry:
                return entry[key]
        return None

    @classmethod
    def _group_words(cls, words: list[dict[str, Any]]) -> list[Caption]:
        grouped: list[Caption] = []
        buffer: list[str] = []
        start = 0.0
        end = 0.0
        for index, word_entry in enumerate(words):
            text = str(cls._first(word_entry, ("word", "text", "token")) or "").strip()
            if not text:
                continue
            word_start = parse_time(cls._first(word_entry, ("start", "startSeconds", "from")) or 0.0)
            word_end = parse_time(cls._first(word_entry, ("end", "endSeconds", "to")) or word_start + 0.2)
            if not buffer:
                start = word_start
            buffer.append(text)
            end = word_end
            closes_phrase = text.endswith((".", "!", "?", ";", ":"))
            if closes_phrase or len(buffer) >= 9 or end - start >= 2.9 or index == len(words) - 1:
                grouped.append(Caption(start, max(end, start + 0.2), " ".join(buffer)))
                buffer = []
        return grouped

    @classmethod
    def _load(cls, path: Path) -> list[Caption]:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            entries = payload
        elif isinstance(payload, dict):
            if isinstance(payload.get("captions"), list):
                entries = payload["captions"]
            elif isinstance(payload.get("segments"), list):
                entries = payload["segments"]
            elif isinstance(payload.get("words"), list):
                return cls._group_words(payload["words"])
            else:
                raise ValueError(f"No captions, segments, or words array in {path}")
        else:
            raise ValueError(f"Unsupported captions document in {path}")

        normalized: list[Caption] = []
        word_entries: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            text = str(cls._first(entry, ("text", "caption", "sentence")) or "").strip()
            if not text and cls._first(entry, ("word", "token")):
                word_entries.append(entry)
                continue
            if not text:
                continue
            start_value = cls._first(entry, ("start", "startSeconds", "from", "begin"))
            end_value = cls._first(entry, ("end", "endSeconds", "to", "finish"))
            if start_value is None or end_value is None:
                continue
            start = parse_time(start_value)
            end = max(start + 0.12, parse_time(end_value))
            normalized.append(Caption(start, end, text))
        if word_entries and not normalized:
            normalized = cls._group_words(word_entries)
        return sorted(normalized, key=lambda item: (item.start, item.end))

    def at(self, timestamp: float) -> Caption | None:
        # A few hundred subtitle entries make the straightforward scan cheap and
        # deterministic; no mutable cursor means partial renders remain exact.
        for caption in self.captions:
            if caption.start <= timestamp < caption.end:
                return caption
            if caption.start > timestamp:
                break
        return None


class CursorTrace:
    def __init__(self, path: Path) -> None:
        payload = json.loads(path.read_text(encoding="utf-8"))
        entries = payload.get("pointerTrace")
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"Cursor trace is missing or empty: {path}")
        self.samples = [
            (float(entry["timeSeconds"]), float(entry["x"]), float(entry["y"]))
            for entry in entries
        ]
        if any(current[0] < previous[0] for previous, current in zip(self.samples, self.samples[1:])):
            raise ValueError(f"Cursor trace timestamps are not monotonic: {path}")
        self.times = [sample[0] for sample in self.samples]

    def position(self, timestamp: float) -> tuple[float, float]:
        index = bisect.bisect_right(self.times, timestamp)
        if index <= 0:
            return self.samples[0][1], self.samples[0][2]
        if index >= len(self.samples):
            return self.samples[-1][1], self.samples[-1][2]
        previous = self.samples[index - 1]
        following = self.samples[index]
        gap = following[0] - previous[0]
        if gap > 0.12 or gap <= 0.0:
            return previous[1], previous[2]
        amount = clamp((timestamp - previous[0]) / gap)
        return lerp(previous[1], following[1], amount), lerp(previous[2], following[2], amount)


class FontBook:
    def __init__(self) -> None:
        windows = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
        self._paths = {
            "regular": self._pick(windows, ("segoeui.ttf", "aptos.ttf", "arial.ttf")),
            "semibold": self._pick(windows, ("seguisb.ttf", "segoeuib.ttf", "arialbd.ttf")),
            "bold": self._pick(windows, ("segoeuib.ttf", "arialbd.ttf")),
            "mono": self._pick(windows, ("consola.ttf", "cour.ttf")),
        }
        self._cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}

    @staticmethod
    def _pick(root: Path, names: Iterable[str]) -> Path:
        for name in names:
            candidate = root / name
            if candidate.exists():
                return candidate
        return Path(ImageFont.__file__).parent / "DejaVuSans.ttf"

    def get(self, role: str, size: int) -> ImageFont.FreeTypeFont:
        key = (role, size)
        if key not in self._cache:
            self._cache[key] = ImageFont.truetype(str(self._paths[role]), size=size)
        return self._cache[key]


class ProductVideoReader:
    """Forward-optimized frame reader with safe backward-seek recovery."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.container: av.container.InputContainer | None = None
        self.stream: av.video.stream.VideoStream | None = None
        self.iterator: Any = None
        self.current_time = -1.0
        self.current_image: Image.Image | None = None
        self.source_fps = 30.0
        self._open(0.0)

    def _open(self, seek_to: float) -> None:
        if self.container is not None:
            self.container.close()
        self.container = av.open(str(self.path))
        self.stream = self.container.streams.video[0]
        if self.stream.average_rate:
            self.source_fps = float(self.stream.average_rate)
        if seek_to > 0.25:
            self.container.seek(
                int(max(0.0, seek_to - 1.0) * AV_TIME_BASE),
                any_frame=False,
                backward=True,
            )
        self.iterator = self.container.decode(self.stream)
        self.current_time = -1.0
        self.current_image = None

    @staticmethod
    def _frame_time(frame: av.VideoFrame) -> float:
        if frame.pts is None or frame.time_base is None:
            return 0.0
        return float(frame.pts * frame.time_base)

    def get(self, timestamp: float) -> Image.Image:
        timestamp = max(0.0, timestamp)
        if self.current_image is None or timestamp < self.current_time - (1.5 / self.source_fps):
            self._open(timestamp)

        half_frame = 0.5 / self.source_fps
        while self.current_image is None or self.current_time < timestamp - half_frame:
            try:
                frame = next(self.iterator)
            except StopIteration:
                if self.current_image is None:
                    raise RuntimeError(f"No frames decoded from {self.path}")
                break
            self.current_time = self._frame_time(frame)
            self.current_image = Image.fromarray(frame.to_ndarray(format="rgb24"), mode="RGB")
        assert self.current_image is not None
        return self.current_image

    def close(self) -> None:
        if self.container is not None:
            self.container.close()


class ToolBraidCompositor:
    def __init__(self, config: dict[str, Any], config_path: Path, captions: CaptionTrack) -> None:
        self.config = config
        self.config_path = config_path
        master = config["master"]
        self.width = int(master["width"])
        self.height = int(master["height"])
        self.fps = int(master["fps"])
        self.colors = {key: hex_rgb(value) for key, value in config["palette"].items()}
        self.fonts = FontBook()
        self.captions = captions
        self.scenes: list[dict[str, Any]] = config["scenes"]
        cursor_trace_path = resolve_from_config(config_path, str(config["inputs"]["cursorTrace"]))
        self.cursor_trace = CursorTrace(cursor_trace_path)
        configured_products = config["inputs"].get("productVideos")
        if isinstance(configured_products, dict) and configured_products:
            self.products = {
                str(key): ProductVideoReader(resolve_from_config(config_path, str(value)))
                for key, value in configured_products.items()
            }
            self.default_product_key = str(
                config["inputs"].get("defaultProductVideo", next(iter(self.products)))
            )
            if self.default_product_key not in self.products:
                raise ValueError(
                    f"Unknown defaultProductVideo {self.default_product_key!r}; "
                    f"available sources are {sorted(self.products)}"
                )
        else:
            product_path = resolve_from_config(config_path, config["inputs"]["productVideo"])
            self.default_product_key = "default"
            self.products = {self.default_product_key: ProductVideoReader(product_path)}
        self.background = self._build_background()
        logo_path = resolve_from_config(config_path, config["inputs"]["logo"])
        self.logo = svg_to_image(logo_path, 180, 180).convert("RGBA")
        rng = random.Random(24958)
        self.particles = [
            (rng.random(), rng.random(), rng.uniform(0.25, 0.9), rng.uniform(0.4, 1.4))
            for _ in range(52)
        ]

    def _build_background(self) -> Image.Image:
        yy, xx = np.mgrid[0 : self.height, 0 : self.width]
        base = np.zeros((self.height, self.width, 3), dtype=np.float32)
        base[:] = self.colors["background"]
        distance = np.sqrt(((xx - self.width * 0.5) / self.width) ** 2 + ((yy - self.height * 0.42) / self.height) ** 2)
        glow = np.clip(1.0 - distance / 0.72, 0.0, 1.0) ** 2
        cyan = np.asarray(self.colors["cyan"], dtype=np.float32)
        base += glow[..., None] * cyan * 0.045
        vertical = np.clip(1.0 - yy / self.height, 0.0, 1.0)[..., None]
        base += vertical * np.asarray(self.colors["blue"], dtype=np.float32) * 0.018
        image = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), mode="RGB")
        draw = ImageDraw.Draw(image)
        grid_color = (*self.colors["cyan"], 18)
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        grid = ImageDraw.Draw(overlay)
        for x in range(0, self.width, 64):
            grid.line((x, 0, x, self.height), fill=grid_color, width=1)
        for y in range(0, self.height, 64):
            grid.line((0, y, self.width, y), fill=grid_color, width=1)
        return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")

    def _scene_at(self, timestamp: float) -> tuple[int, dict[str, Any]]:
        for index, scene in enumerate(self.scenes):
            if float(scene["start"]) <= timestamp < float(scene["end"]):
                return index, scene
        return len(self.scenes) - 1, self.scenes[-1]

    @staticmethod
    def _segment_at(scene: dict[str, Any], timestamp: float) -> dict[str, Any]:
        segments = scene["segments"]
        for segment in segments:
            if float(segment["start"]) <= timestamp < float(segment["end"]):
                return segment
        return segments[-1]

    def _animated_particles(self, image: Image.Image, timestamp: float, opacity: int = 85) -> None:
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        for px, py, size, speed in self.particles:
            x = (px * self.width + timestamp * 8.0 * speed) % self.width
            y = py * self.height + math.sin(timestamp * 0.35 * speed + px * 10.0) * 12.0
            radius = max(1.0, size * 1.8)
            # Keep the field alive through drift, without the repetitive
            # brightness pulse that made every scene feel mechanically looped.
            alpha = int(opacity * (0.55 + 0.35 * size))
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*self.colors["cyan"], alpha))
        image.alpha_composite(overlay)

    def _braid(self, image: Image.Image, timestamp: float, reveal: float, outro: bool = False) -> None:
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        glow_draw = ImageDraw.Draw(glow)
        center = self.height * (0.52 if not outro else 0.70)
        span_left, span_right = 80, self.width - 80
        samples = 220
        reveal_alpha = smoothstep(clamp(reveal))
        if reveal_alpha <= 0.001:
            return
        visible = samples
        colors = (self.colors["mint"], self.colors["blue"], self.colors["amber"])
        for path_index, color in enumerate(colors):
            points: list[tuple[float, float]] = []
            phase = path_index * (math.tau / 3.0)
            for index in range(visible):
                amount = index / (samples - 1)
                x = lerp(span_left, span_right, amount)
                envelope = math.sin(math.pi * amount) ** 0.72
                amplitude = (108 if not outro else 74) * envelope
                y = center + math.sin(amount * math.tau * 2.05 + phase + timestamp * 0.45) * amplitude
                points.append((x, y))
            if len(points) > 1:
                glow_draw.line(
                    points,
                    fill=(*color, int(90 * reveal_alpha)),
                    width=18,
                    joint="curve",
                )
                draw.line(
                    points,
                    fill=(*color, int(225 * reveal_alpha)),
                    width=4,
                    joint="curve",
                )
        image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(14)))
        image.alpha_composite(overlay)

    def _render_outro(self, timestamp: float, segment: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
        local = timestamp - float(segment["start"])
        duration = float(segment["end"]) - float(segment["start"])
        # The outro is generated independently. Reusing the last browser frame
        # would make the capture appear to freeze and repeat at the cut.
        image = self.background.copy().convert("RGBA")
        self._animated_particles(image, timestamp, opacity=48)
        if local >= 0.14:
            self._braid(image, timestamp, smoothstep((local - 0.14) / 1.26), outro=True)
        logo_size = 132
        logo = self.logo.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
        image.alpha_composite(logo, ((self.width - logo_size) // 2, 178))
        end_fade = smoothstep((duration - local) / 0.85)
        if end_fade < 1.0:
            black = Image.new("RGBA", image.size, (*self.colors["background"], int(255 * (1.0 - end_fade))))
            image = Image.alpha_composite(image, black)
        return image.convert("RGB"), {"kind": "outro"}

    def _draw_cursor(self, image: Image.Image, source_time: float) -> None:
        x, y = self.cursor_trace.position(source_time)
        points = [
            (2.0, 1.5),
            (2.2, 24.2),
            (8.1, 19.3),
            (12.5, 29.4),
            (17.2, 27.3),
            (12.8, 17.4),
            (20.5, 17.0),
        ]
        translated = [(x + px, y + py) for px, py in points]
        shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow)
        shadow_draw.polygon([(px + 2.5, py + 3.0) for px, py in translated], fill=(0, 0, 0, 188))
        shadow = shadow.filter(ImageFilter.GaussianBlur(2.1))
        image.alpha_composite(shadow)
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        draw.polygon(translated, fill=(247, 251, 255, 255), outline=(7, 16, 28, 255))
        draw.line((*translated, translated[0]), fill=(7, 16, 28, 255), width=2, joint="curve")
        image.alpha_composite(overlay)

    def _render_product(self, timestamp: float, segment: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
        start, end = float(segment["start"]), float(segment["end"])
        # Interactive footage is documentary evidence. Advance it at exactly
        # one source second per timeline second; easing here used to retime the
        # cursor, pause at both ends, and make genuine interaction look staged.
        elapsed = clamp(timestamp - start, 0.0, end - start)
        source_time = min(float(segment["sourceEnd"]), float(segment["sourceStart"]) + elapsed)
        source_key = str(segment.get("source", self.default_product_key))
        if source_key not in self.products:
            raise ValueError(
                f"Unknown product source {source_key!r}; available sources are {sorted(self.products)}"
            )
        source = self.products[source_key].get(source_time)
        # Full-frame documentary capture: no crop, spatial transform, vignette,
        # or speed change is applied to the deployed product recording.
        image = source.resize((self.width, self.height), Image.Resampling.BICUBIC).convert("RGBA")
        self._draw_cursor(image, source_time)
        return image.convert("RGB"), {
            "kind": "product",
            "sourceTime": source_time,
            "sourceKey": source_key,
            "playback": "linear-1x",
            "provenance": segment.get("provenance"),
            "publicUrl": segment.get("publicUrl"),
        }

    def _render_base(self, timestamp: float, segment: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
        kind = segment["kind"]
        if kind == "outro":
            return self._render_outro(timestamp, segment)
        if kind == "product":
            return self._render_product(timestamp, segment)
        raise ValueError(f"Unsupported segment kind: {kind}")

    def _draw_outro_titles(self, image: Image.Image, timestamp: float, scene: dict[str, Any]) -> None:
        local = timestamp - float(scene["start"])
        duration = float(scene["end"]) - float(scene["start"])
        opacity = int(255 * min(ease_out_cubic(local / 1.0), smoothstep((duration - local) / 0.9)))
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        center = self.width // 2
        draw.text((center, 342), str(scene["kicker"]), anchor="ma", font=self.fonts.get("bold", 74), fill=(*self.colors["text"], opacity))
        draw.text((center, 451), str(scene["headline"]), anchor="ma", font=self.fonts.get("semibold", 39), fill=(*self.colors["text"], opacity))
        draw.text((center, 517), str(scene["subhead"]), anchor="ma", font=self.fonts.get("mono", 19), fill=(*self.colors["mint"], opacity))
        draw.text((center, 608), "WebMCP Challenge 2026", anchor="ma", font=self.fonts.get("regular", 19), fill=(*self.colors["muted"], opacity))
        image.alpha_composite(overlay)

    def _wrap_text(self, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
        words = text.split()
        lines: list[str] = []
        current: list[str] = []
        probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
        for word in words:
            candidate = " ".join((*current, word))
            width = probe.textbbox((0, 0), candidate, font=font)[2]
            if current and width > max_width:
                lines.append(" ".join(current))
                current = [word]
            else:
                current.append(word)
        if current:
            lines.append(" ".join(current))
        if len(lines) > 2:
            lines = [lines[0], " ".join(lines[1:])]
        return lines

    def _draw_caption(self, image: Image.Image, timestamp: float, scene: dict[str, Any]) -> None:
        caption = self.captions.at(timestamp)
        if caption is None:
            return
        font = self.fonts.get("semibold", 31)
        lines = self._wrap_text(caption.text, font, 1280)
        line_height = 40
        box_height = 24 + line_height * len(lines)
        measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
        text_width = max(measure.textbbox((0, 0), line, font=font)[2] for line in lines)
        box_width = min(1400, max(620, text_width + 84))
        x1 = (self.width - box_width) // 2
        position = scene.get("captionPosition", "bottom")
        y1 = 92 if position == "top" else self.height - 78 - box_height
        opacity = min(
            smoothstep((timestamp - caption.start) / 0.12),
            smoothstep((caption.end - timestamp) / 0.12),
        )
        alpha = int(232 * opacity)
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        draw.rounded_rectangle(
            (x1, y1, x1 + box_width, y1 + box_height),
            radius=18,
            fill=(1, 8, 15, int(alpha * 0.90)),
            outline=(*self.colors["cyan"], int(alpha * 0.25)),
            width=2,
        )
        for index, line in enumerate(lines):
            draw.text(
                (self.width // 2, y1 + 12 + index * line_height),
                line,
                anchor="ma",
                font=font,
                fill=(*self.colors["text"], alpha),
                stroke_width=1,
                stroke_fill=(0, 5, 10, alpha),
            )
        image.alpha_composite(overlay)

    def _draw_product_provenance(
        self,
        image: Image.Image,
        timestamp: float,
        metadata: dict[str, Any],
    ) -> None:
        provenance = metadata.get("provenance")
        if metadata.get("kind") != "product" or provenance != "public-sandbox":
            return
        text = (
            "PUBLIC DEPLOYMENT  ·  NATIVE WEBMCP  ·  DETERMINISTIC BROWSER SANDBOX  ·  "
            "NO EXTERNAL SYSTEM CHANGED"
        )
        color = self.colors["green"]
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        font = self.fonts.get("mono", 14)
        bbox = draw.textbbox((0, 0), text, font=font)
        width = bbox[2] - bbox[0] + 38
        x = 32
        y = self.height - 40
        draw.rounded_rectangle(
            (x, y, x + width, y + 28),
            radius=9,
            fill=(1, 8, 15, 226),
            outline=(*color, 130),
            width=1,
        )
        draw.text((x + 19, y + 6), text, font=font, fill=(*color, 236))
        image.alpha_composite(overlay)

    def _apply_scene_transition(self, image: Image.Image, timestamp: float, scene: dict[str, Any]) -> None:
        transition = str(
            scene.get(
                "transition",
                self.config.get("editingPolicy", {}).get("defaultSceneTransition", "cut"),
            )
        )
        if transition == "cut":
            return
        local = timestamp - float(scene["start"])
        remaining = float(scene["end"]) - timestamp
        if transition == "fade-from-black":
            visibility = smoothstep(local / 0.34)
        elif transition == "fade-to-black":
            visibility = smoothstep(remaining / 0.30)
        else:
            raise ValueError(f"Unsupported scene transition {transition!r} in {scene['id']}")
        if visibility >= 0.999:
            return
        shade = Image.new("RGBA", image.size, (*self.colors["background"], int(255 * (1.0 - visibility))))
        image.alpha_composite(shade)

    def render(self, timestamp: float) -> Image.Image:
        _, scene = self._scene_at(timestamp)
        segment = self._segment_at(scene, timestamp)
        base, metadata = self._render_base(timestamp, segment)
        image = base.convert("RGBA")
        if metadata.get("kind") == "outro":
            self._draw_outro_titles(image, timestamp, scene)
        self._draw_caption(image, timestamp, scene)
        self._draw_product_provenance(image, timestamp, metadata)
        self._apply_scene_transition(image, timestamp, scene)
        return image.convert("RGB")

    def close(self) -> None:
        for product in self.products.values():
            product.close()


def resampled_audio(path: Path, sample_rate: int) -> np.ndarray:
    chunks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise ValueError(f"No audio stream in {path}")
        stream = container.streams.audio[0]
        resampler = AudioResampler(format="fltp", layout="stereo", rate=sample_rate)
        for frame in container.decode(stream):
            converted = resampler.resample(frame)
            converted_frames = converted if isinstance(converted, list) else [converted]
            for output_frame in converted_frames:
                if output_frame is None:
                    continue
                array = output_frame.to_ndarray()
                if array.ndim == 1:
                    array = array.reshape(1, -1)
                if array.shape[0] == 1:
                    array = np.repeat(array, 2, axis=0)
                chunks.append(array[:2].astype(np.float32, copy=False))
        flushed = resampler.resample(None)
        flushed_frames = flushed if isinstance(flushed, list) else [flushed]
        for output_frame in flushed_frames:
            if output_frame is not None:
                array = output_frame.to_ndarray()
                if array.ndim == 1:
                    array = array.reshape(1, -1)
                if array.shape[0] == 1:
                    array = np.repeat(array, 2, axis=0)
                chunks.append(array[:2].astype(np.float32, copy=False))
    if not chunks:
        raise ValueError(f"No audio samples decoded from {path}")
    return np.nan_to_num(np.concatenate(chunks, axis=1), copy=False)


def fit_audio(audio: np.ndarray, samples: int, start_sample: int = 0) -> np.ndarray:
    start_sample = max(0, start_sample)
    sliced = audio[:, start_sample : start_sample + samples]
    if sliced.shape[1] < samples:
        sliced = np.pad(sliced, ((0, 0), (0, samples - sliced.shape[1])))
    return sliced.astype(np.float32, copy=False)


def true_peak_dbfs_planar(
    audio: np.ndarray,
    sample_rate: int,
    oversample: int = 4,
) -> float:
    """Estimate inter-sample peak for channel-first audio without a huge allocation."""

    if not audio.size:
        return -240.0
    peak = 0.0
    block_samples = max(1, sample_rate * 10)
    overlap_samples = 256
    for start in range(0, audio.shape[1], block_samples):
        end = min(audio.shape[1], start + block_samples)
        read_start = max(0, start - overlap_samples)
        read_end = min(audio.shape[1], end + overlap_samples)
        segment = audio[:, read_start:read_end]
        oversampled = resample_poly(segment, oversample, 1, axis=1)
        trim_start = (start - read_start) * oversample
        trim_end = trim_start + (end - start) * oversample
        measured = oversampled[:, trim_start:trim_end]
        if measured.size:
            peak = max(peak, float(np.max(np.abs(measured))))
    return 20.0 * math.log10(max(peak, 1e-12))


def build_audio_mix(
    narration_path: Path | None,
    ambient_path: Path | None,
    sample_rate: int,
    start: float,
    duration: float,
    narration_offset_seconds: float = 0.0,
) -> tuple[np.ndarray, dict[str, Any]]:
    sample_count = int(round(duration * sample_rate))
    start_sample = int(round(start * sample_rate))
    if narration_path is not None and narration_path.exists():
        source = resampled_audio(narration_path, sample_rate)
        narration = np.zeros((2, sample_count), dtype=np.float32)
        offset_sample = int(round(narration_offset_seconds * sample_rate))
        source_start = max(0, start_sample - offset_sample)
        destination_start = max(0, offset_sample - start_sample)
        copy_count = min(source.shape[1] - source_start, sample_count - destination_start)
        if copy_count > 0:
            narration[:, destination_start : destination_start + copy_count] = source[
                :, source_start : source_start + copy_count
            ]
        narration_present = True
    else:
        narration = np.zeros((2, sample_count), dtype=np.float32)
        narration_present = False

    ambient_present = ambient_path is not None and ambient_path.exists()
    if ambient_present:
        ambient_source = resampled_audio(ambient_path, sample_rate)
        if ambient_source.shape[1] == 0:
            ambient = np.zeros_like(narration)
        else:
            required = start_sample + sample_count
            repeats = int(math.ceil(required / ambient_source.shape[1]))
            tiled = np.tile(ambient_source, (1, max(1, repeats)))
            ambient = tiled[:, start_sample : start_sample + sample_count]
        # The bed sits roughly 25 dB below full scale and ducks a little further
        # while speech is present. It is texture, never a competing music cue.
        voice_level = np.max(np.abs(narration), axis=0)
        window = max(1, int(sample_rate * 0.045))
        # O(n) centered moving average. A direct convolution over the locked
        # 7.8-million-sample master would do billions of unnecessary multiplies.
        left_pad = window // 2
        right_pad = window - 1 - left_pad
        padded = np.pad(voice_level, (left_pad, right_pad), mode="edge")
        cumulative = np.concatenate((np.zeros(1, dtype=np.float64), np.cumsum(padded, dtype=np.float64)))
        envelope = ((cumulative[window:] - cumulative[:-window]) / window).astype(np.float32)
        duck = np.where(envelope > 0.012, 0.42, 1.0).astype(np.float32)
        ambient_gain = 10.0 ** (-25.0 / 20.0)
        fade_samples = min(sample_count // 2, sample_rate)
        fade = np.ones(sample_count, dtype=np.float32)
        if fade_samples > 0:
            fade[:fade_samples] = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
            fade[-fade_samples:] = np.linspace(1.0, 0.0, fade_samples, dtype=np.float32)
        mix = narration + ambient * (ambient_gain * duck * fade)[None, :]
    else:
        mix = narration

    peak_before = float(np.max(np.abs(mix))) if mix.size else 0.0
    limiter_gain = 1.0 if peak_before <= 0.96 else 0.96 / peak_before
    mix = np.clip(mix * limiter_gain, -1.0, 1.0).astype(np.float32)
    true_peak_before = true_peak_dbfs_planar(mix, sample_rate)
    true_peak_gain_db = 0.0
    if true_peak_before > MIX_TRUE_PEAK_TARGET_DBTP:
        true_peak_gain_db = MIX_TRUE_PEAK_TARGET_DBTP - true_peak_before - 0.02
        mix *= np.float32(10.0 ** (true_peak_gain_db / 20.0))
    true_peak_after = true_peak_dbfs_planar(mix, sample_rate)
    if true_peak_after > MIX_TRUE_PEAK_TARGET_DBTP + 0.005:
        correction_db = MIX_TRUE_PEAK_TARGET_DBTP - true_peak_after - 0.02
        true_peak_gain_db += correction_db
        mix *= np.float32(10.0 ** (correction_db / 20.0))
        true_peak_after = true_peak_dbfs_planar(mix, sample_rate)
    peak_after = float(np.max(np.abs(mix))) if mix.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(mix), dtype=np.float64))) if mix.size else 0.0
    metadata = {
        "narrationPresent": narration_present,
        "ambientPresent": ambient_present,
        "sampleRate": sample_rate,
        "channels": 2,
        "sampleCount": sample_count,
        "narrationOffsetSeconds": narration_offset_seconds,
        "peakBeforeLimiter": round(peak_before, 7),
        "limiterGain": round(limiter_gain, 7),
        "peak": round(peak_after, 7),
        "truePeakTargetDbtp": MIX_TRUE_PEAK_TARGET_DBTP,
        "truePeakBeforeControlDbtp": round(true_peak_before, 3),
        "truePeakControlGainDb": round(true_peak_gain_db, 3),
        "truePeakAfterControlDbtp": round(true_peak_after, 3),
        "rmsDbfs": round(20.0 * math.log10(max(rms, 1e-12)), 2),
    }
    return mix, metadata


def configure_video_stream(
    stream: av.video.stream.VideoStream,
    codec: str,
    width: int,
    height: int,
    fps: int,
    bit_rate: int,
) -> None:
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuv420p"
    stream.bit_rate = bit_rate
    stream.codec_context.gop_size = fps * 2
    stream.codec_context.max_b_frames = 2
    if codec == "h264_nvenc":
        stream.codec_context.options = {
            "preset": "p6",
            "tune": "hq",
            "rc": "vbr",
            "maxrate": str(round(bit_rate * 1.08)),
            "bufsize": str(bit_rate * 2),
            "multipass": "fullres",
            "spatial-aq": "1",
            "temporal-aq": "1",
            "rc-lookahead": "32",
            "profile": "high",
        }
    else:
        stream.codec_context.options = {
            "preset": "medium",
            "crf": "17",
            "tune": "film",
            "profile": "high",
        }


def codec_preflight(
    codec: str,
    width: int,
    height: int,
    fps: int,
    bit_rate: int,
    output_dir: Path,
) -> tuple[bool, str | None]:
    probe_path = output_dir / f".toolbraid-{codec}-{os.getpid()}-probe.mp4"
    try:
        with av.open(str(probe_path), mode="w", format="mp4") as container:
            stream = container.add_stream(codec, rate=fps)
            configure_video_stream(stream, codec, width, height, fps, bit_rate)
            frame = av.VideoFrame.from_ndarray(np.zeros((height, width, 3), dtype=np.uint8), format="rgb24")
            frame.pts = 0
            frame.time_base = Fraction(1, fps)
            for packet in stream.encode(frame):
                container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        return True, None
    except Exception as error:  # codec availability depends on host driver state
        return False, f"{type(error).__name__}: {error}"
    finally:
        probe_path.unlink(missing_ok=True)


def choose_codec(
    requested: str,
    width: int,
    height: int,
    fps: int,
    bit_rate: int,
    output_dir: Path,
) -> tuple[str, dict[str, Any]]:
    candidates = [requested] if requested != "auto" else ["h264_nvenc", "libx264"]
    checks: dict[str, Any] = {}
    for codec in candidates:
        ok, error = codec_preflight(codec, width, height, fps, bit_rate, output_dir)
        checks[codec] = {"available": ok, "error": error}
        if ok:
            return codec, checks
    raise RuntimeError(f"No usable H.264 encoder. Preflight: {checks}")


def encode_audio(container: av.container.OutputContainer, stream: av.audio.stream.AudioStream, audio: np.ndarray, sample_rate: int) -> None:
    block_size = 4096
    for start in range(0, audio.shape[1], block_size):
        block = np.ascontiguousarray(audio[:, start : start + block_size], dtype=np.float32)
        frame = av.AudioFrame.from_ndarray(block, format="fltp", layout="stereo")
        frame.sample_rate = sample_rate
        frame.pts = start
        frame.time_base = Fraction(1, sample_rate)
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)


def probe_output(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"path": str(path.resolve()), "bytes": path.stat().st_size, "streams": []}
    with av.open(str(path)) as container:
        result["containerDurationSeconds"] = round(float(container.duration or 0) / AV_TIME_BASE, 6)
        result["format"] = container.format.name
        for stream in container.streams:
            item: dict[str, Any] = {
                "index": stream.index,
                "type": stream.type,
                "codec": stream.codec_context.name,
                "timeBase": str(stream.time_base),
            }
            if stream.duration is not None and stream.time_base is not None:
                item["durationSeconds"] = round(float(stream.duration * stream.time_base), 6)
            if stream.type == "video":
                item.update({
                    "width": stream.codec_context.width,
                    "height": stream.codec_context.height,
                    "averageRate": str(stream.average_rate),
                    "pixelFormat": stream.codec_context.pix_fmt,
                    "frames": stream.frames,
                })
            elif stream.type == "audio":
                item.update({
                    "sampleRate": stream.codec_context.sample_rate,
                    "channels": stream.codec_context.channels,
                    "layout": str(stream.codec_context.layout),
                })
            result["streams"].append(item)
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_narration_provenance(
    config: dict[str, Any],
    config_path: Path,
    *,
    allow_absent: bool = False,
) -> dict[str, Any]:
    inputs = config["inputs"]
    source = resolve_from_config(config_path, str(inputs["narration"]))
    mastered = resolve_from_config(config_path, str(inputs["narrationFinal"]))
    source_present = source.is_file()
    mastered_present = mastered.is_file()
    if allow_absent and not source_present and not mastered_present:
        return {
            "source": str(source),
            "mastered": str(mastered),
            "verified": False,
            "skipped": True,
            "reason": "Narration source and mastered audio are both absent; omission was explicitly allowed.",
        }

    provenance = inputs.get("narrationProvenance")
    if not isinstance(provenance, dict):
        raise ValueError(
            "inputs.narrationProvenance is required; refusing to use a mastered narration "
            "without a locked source/master hash pair"
        )

    for label, path in (("source", source), ("mastered", mastered)):
        if not path.exists():
            raise FileNotFoundError(f"Narration provenance {label} file is missing: {path}")

    expected_source = str(provenance.get("sourceSha256", "")).lower()
    expected_mastered = str(provenance.get("masteredSha256", "")).lower()
    for label, value in (("sourceSha256", expected_source), ("masteredSha256", expected_mastered)):
        if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
            raise ValueError(f"inputs.narrationProvenance.{label} must be a lowercase SHA-256 digest")

    actual_source = sha256_file(source)
    actual_mastered = sha256_file(mastered)
    if actual_source != expected_source:
        raise RuntimeError(
            "narration-master.wav changed after the locked mastering pass; refusing to render "
            "with a potentially stale narration-master-final.wav. Rerun master-narration.py "
            "and update narrationProvenance with the new verified hash pair."
        )
    if actual_mastered != expected_mastered:
        raise RuntimeError(
            "narration-master-final.wav does not match its locked mastering provenance; "
            "refusing to render. Rerun master-narration.py and update narrationProvenance."
        )

    generation_report = resolve_from_config(config_path, str(provenance["generationReport"]))
    mastering_report = resolve_from_config(config_path, str(provenance["masteringReport"]))
    for label, path, hash_field in (
        ("generationReport", generation_report, "generationReportSha256"),
        ("masteringReport", mastering_report, "masteringReportSha256"),
    ):
        expected_hash = str(provenance.get(hash_field, "")).lower()
        if len(expected_hash) != 64 or any(character not in "0123456789abcdef" for character in expected_hash):
            raise ValueError(f"inputs.narrationProvenance.{hash_field} must be a lowercase SHA-256 digest")
        if not path.is_file() or sha256_file(path) != expected_hash:
            raise RuntimeError(f"Narration provenance {label} does not match its sealed hash")

    generation_payload = json.loads(generation_report.read_text(encoding="utf-8"))
    mastering_payload = json.loads(mastering_report.read_text(encoding="utf-8"))
    if generation_payload.get("status") not in {"PASS", "PASS_REQUIRES_DECLIP"}:
        raise RuntimeError("IndexTTS generation report is not accepted")
    if mastering_payload.get("status") != "PASS":
        raise RuntimeError("Narration mastering report is not PASS")
    if mastering_payload.get("input", {}).get("sha256") != actual_source:
        raise RuntimeError("Mastering report input hash does not match narration-master.wav")
    if mastering_payload.get("output", {}).get("sha256") != actual_mastered:
        raise RuntimeError("Mastering report output hash does not match narration-master-final.wav")
    if generation_payload.get("qualityGates", {}).get("premiumDeclipRequired"):
        plugins = mastering_payload.get("processing", {}).get("voiceCleanup", {}).get("plugins", [])
        names = {str(plugin.get("name")) for plugin in plugins if isinstance(plugin, dict)}
        if "iZotope RX 12 De-clip" not in names:
            raise RuntimeError("Raw IndexTTS clipping requires the sealed premium de-clip stage")
    return {
        "source": str(source),
        "sourceSha256": actual_source,
        "mastered": str(mastered),
        "masteredSha256": actual_mastered,
        "generationReport": str(generation_report),
        "generationReportSha256": sha256_file(generation_report),
        "masteringReport": str(mastering_report),
        "masteringReportSha256": sha256_file(mastering_report),
        "verified": True,
    }


def validate_capture_provenance(
    config: dict[str, Any],
    config_path: Path,
    product_paths: dict[str, Path],
) -> dict[str, Any]:
    inputs = config["inputs"]
    provenance_root = inputs.get("productProvenance")
    if not isinstance(provenance_root, dict):
        raise ValueError("inputs.productProvenance is required")
    provenance = provenance_root.get("public-full")
    if not isinstance(provenance, dict):
        raise ValueError("inputs.productProvenance.public-full is required")
    video = product_paths["public-full"]
    report = resolve_from_config(config_path, str(provenance["report"]))
    timeline = resolve_from_config(config_path, str(provenance["timeline"]))
    cursor_trace = resolve_from_config(config_path, str(inputs["cursorTrace"]))
    if cursor_trace != timeline:
        raise ValueError("inputs.cursorTrace must be the sealed public-full capture timeline")

    actual_hashes = {
        "videoSha256": sha256_file(video),
        "reportSha256": sha256_file(report),
        "timelineSha256": sha256_file(timeline),
    }
    for field, actual in actual_hashes.items():
        expected = str(provenance.get(field, "")).lower()
        if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
            raise ValueError(f"inputs.productProvenance.public-full.{field} must be a SHA-256 digest")
        if expected != actual:
            raise RuntimeError(f"Public capture provenance mismatch for {field}: {actual} != {expected}")

    report_payload = json.loads(report.read_text(encoding="utf-8"))
    timeline_payload = json.loads(timeline.read_text(encoding="utf-8"))
    expected_fields = {
        "status": "PASS",
        "target": "public-full",
        "url": "https://toolbraid-webmcp.vercel.app",
        "runtime": "native",
        "executionMode": "public-sandbox-full",
        "publicSandboxExecution": True,
        "mutationExecution": True,
        "auditVerified": True,
        "unexpectedBrowserErrors": 0,
    }
    mismatches = {
        field: {"expected": expected, "actual": report_payload.get(field)}
        for field, expected in expected_fields.items()
        if report_payload.get(field) != expected
    }
    if mismatches:
        raise RuntimeError(f"Public capture report failed provenance checks: {mismatches}")
    if report_payload.get("video", {}).get("sha256") != actual_hashes["videoSha256"]:
        raise RuntimeError("Public capture report video hash does not match the source file")
    cursor = report_payload.get("cursorTrace", {})
    if cursor.get("cspBypassed") is not False or cursor.get("rawCaptureOverlay") is not False:
        raise RuntimeError("Public capture must preserve production CSP and composite its cursor afterward")
    expected_counts = {
        "providers": 6,
        "discoveredTools": 9,
        "quarantined": 1,
        "safeResults": 7,
        "approvals": 2,
    }
    if report_payload.get("counts") != expected_counts:
        raise RuntimeError("Public capture report counts drifted from the judge scenario")
    if timeline_payload.get("target") != "public-full" or timeline_payload.get("url") != expected_fields["url"]:
        raise RuntimeError("Public capture timeline target or URL is invalid")
    pointer_trace = timeline_payload.get("pointerTrace")
    if not isinstance(pointer_trace, list) or len(pointer_trace) < 100:
        raise RuntimeError("Public capture pointer trace is missing or implausibly short")
    return {
        "video": str(video),
        "report": str(report),
        "timeline": str(timeline),
        **actual_hashes,
        "verified": True,
        "cspBypassed": False,
        "pointerTraceSamples": len(pointer_trace),
    }


def validate_config(
    config: dict[str, Any],
    config_path: Path,
    *,
    allow_missing_audio: bool = False,
) -> dict[str, Any]:
    if config.get("format") != "toolbraid-final-render-config-v2":
        raise ValueError("Render config must use toolbraid-final-render-config-v2")

    master = config["master"]
    width = int(master["width"])
    height = int(master["height"])
    fps = int(master["fps"])
    master_duration = float(master["durationSeconds"])
    sample_rate = int(master["sampleRate"])
    channels = int(master["channels"])
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise ValueError("Master dimensions must be positive even integers")
    if fps <= 0 or sample_rate <= 0 or channels != 2:
        raise ValueError("Master fps/sample rate must be positive and channels must equal 2")
    if master_duration <= 3.0:
        raise ValueError("Master duration must leave room for product capture plus outro")
    expected_frames = master_duration * fps
    if abs(expected_frames - round(expected_frames)) > 1e-6:
        raise ValueError("master.durationSeconds * master.fps must produce an integer frame count")

    narration_offset = float(config["inputs"].get("narrationOffsetSeconds", 0.0))
    if narration_offset < 0.0 or narration_offset > 2.0:
        raise ValueError("inputs.narrationOffsetSeconds must be between 0 and 2 seconds")

    editing_policy = config.get("editingPolicy") or {}
    required_policy = {
        "interactivePlayback": "linear-1x",
        "allowInteractiveReplay": False,
        "allowInteractiveZoom": False,
        "defaultSceneTransition": "cut",
        "repetitivePulse": False,
    }
    policy_mismatches = {
        key: {"expected": expected, "actual": editing_policy.get(key)}
        for key, expected in required_policy.items()
        if editing_policy.get(key) != expected
    }
    if policy_mismatches:
        raise ValueError(f"editingPolicy violates the locked natural-edit policy: {policy_mismatches}")

    configured_products = config["inputs"].get("productVideos")
    if isinstance(configured_products, dict) and configured_products:
        product_paths = {
            str(key): resolve_from_config(config_path, str(value))
            for key, value in configured_products.items()
        }
        default_key = str(config["inputs"].get("defaultProductVideo", "public-full"))
    else:
        product_paths = {}
        default_key = "public-full"
    if "public-full" not in product_paths:
        raise ValueError("inputs.productVideos must declare the public-full deployed capture")
    if default_key != "public-full":
        raise ValueError("inputs.defaultProductVideo must be public-full")
    logo = resolve_from_config(config_path, config["inputs"]["logo"])
    for required in (*product_paths.values(), logo):
        if not required.exists():
            raise FileNotFoundError(required)

    source_durations: dict[str, float] = {}
    for source_key, product_path in product_paths.items():
        with av.open(str(product_path)) as container:
            source_durations[source_key] = float(container.duration or 0) / AV_TIME_BASE
            if not container.streams.video:
                raise ValueError(f"Product source has no video stream: {product_path}")
            stream = container.streams.video[0]
            source_width = int(stream.codec_context.width)
            source_height = int(stream.codec_context.height)
            source_fps = float(stream.average_rate or 0.0)
            if (source_width, source_height) != (width, height):
                raise ValueError(
                    f"Product source {source_key!r} must match master dimensions exactly: "
                    f"{source_width}x{source_height} != {width}x{height}"
                )
            if abs(source_fps - fps) > 1e-6:
                raise ValueError(
                    f"Product source {source_key!r} must match master fps exactly: "
                    f"{source_fps:g} != {fps}"
                )

    scenes = config["scenes"]
    if len(scenes) != 2:
        raise ValueError(f"Expected exactly two scenes (public capture + outro), got {len(scenes)}")
    flattened_segments: list[tuple[dict[str, Any], dict[str, Any]]] = []
    cursor = 0.0
    for scene in scenes:
        start, end = float(scene["start"]), float(scene["end"])
        if abs(start - cursor) > 1e-6 or end <= start:
            raise ValueError(f"Scene timeline is not contiguous at {scene['id']}")
        transition = str(scene.get("transition", editing_policy["defaultSceneTransition"]))
        if transition != "cut":
            raise ValueError(f"Scene {scene['id']} must use a hard cut; got {transition!r}")
        if scene.get("highlights"):
            raise ValueError(f"Scene {scene['id']} cannot overlay synthetic highlight animation")

        segment_cursor = start
        segments = scene["segments"]
        if len(segments) != 1:
            raise ValueError(f"Scene {scene['id']} must contain exactly one continuous segment")
        for segment in segments:
            segment_start, segment_end = float(segment["start"]), float(segment["end"])
            if abs(segment_start - segment_cursor) > 1e-6 or segment_end <= segment_start:
                raise ValueError(f"Segment timeline is not contiguous in {scene['id']} at {segment_start}")
            segment_cursor = segment_end
            flattened_segments.append((scene, segment))
        if abs(segment_cursor - end) > 1e-6:
            raise ValueError(f"Segment timeline in {scene['id']} ends at {segment_cursor}, expected {end}")
        cursor = end

    if abs(cursor - master_duration) > 1e-6:
        raise ValueError(f"Scene timeline ends at {cursor}, expected master duration {master_duration}")

    product_scene, product = flattened_segments[0]
    outro_scene, outro = flattened_segments[1]
    if product.get("kind") != "product" or outro.get("kind") != "outro":
        raise ValueError("Timeline must be exactly one product segment followed by one generated outro")
    if float(product["start"]) != 0.0 or float(product["end"]) != float(outro["start"]):
        raise ValueError("The public product capture must be one uninterrupted segment from 0s to the outro")
    if float(outro["end"]) != master_duration:
        raise ValueError("The outro must end exactly at master.durationSeconds")
    outro_duration = float(outro["end"]) - float(outro["start"])
    if outro_duration <= 0.0 or outro_duration > 3.0:
        raise ValueError(f"Generated outro duration must be >0 and <=3 seconds; got {outro_duration}")
    for field in ("kicker", "headline", "subhead"):
        if not str(outro_scene.get(field, "")).strip():
            raise ValueError(f"Outro scene requires non-empty {field}")

    forbidden_fields = {
        "asset",
        "effect",
        "loop",
        "motion",
        "rate",
        "replay",
        "retime",
        "reverse",
        "speed",
        "timeScale",
        "zoom",
    }
    forbidden = forbidden_fields.intersection(product)
    if forbidden:
        raise ValueError(f"Public capture declares forbidden transforms: {sorted(forbidden)}")
    outro_forbidden = forbidden_fields.intersection(outro)
    if outro_forbidden:
        raise ValueError(f"Outro declares forbidden source/motion fields: {sorted(outro_forbidden)}")
    source_key = str(product.get("source", default_key))
    if source_key != "public-full":
        raise ValueError("The continuous product segment must use source='public-full'")
    if product.get("playback") != "linear-1x":
        raise ValueError("The continuous product segment must declare playback='linear-1x'")
    if product.get("provenance") != "public-sandbox":
        raise ValueError("The deployed capture must declare provenance='public-sandbox'")
    expected_public_url = "https://toolbraid-webmcp.vercel.app"
    if product.get("publicUrl") != expected_public_url:
        raise ValueError(f"The deployed capture must declare publicUrl={expected_public_url!r}")

    source_start = float(product["sourceStart"])
    source_end = float(product["sourceEnd"])
    timeline_duration = float(product["end"]) - float(product["start"])
    source_duration = source_end - source_start
    if source_start < 0.0 or source_end <= source_start:
        raise ValueError(f"Invalid public-full source interval: {source_start}..{source_end}")
    if abs(timeline_duration - source_duration) > 1e-6:
        raise ValueError(
            "Public capture must remain strictly 1x: "
            f"timeline={timeline_duration:.6f}s, source={source_duration:.6f}s"
        )
    if source_end > source_durations[source_key] + (1.0 / fps):
        raise ValueError(
            f"Public capture exceeds its source duration ({source_end:.3f}s > "
            f"{source_durations[source_key]:.3f}s)"
        )

    return {
        "narration": validate_narration_provenance(
            config,
            config_path,
            allow_absent=allow_missing_audio,
        ),
        "capture": validate_capture_provenance(config, config_path, product_paths),
    }


def render_master(args: argparse.Namespace) -> dict[str, Any]:
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    allow_missing_audio = bool(args.smoke or args.allow_missing_audio)
    provenance = validate_config(
        config,
        config_path,
        allow_missing_audio=allow_missing_audio,
    )
    master = config["master"]
    width, height, fps = int(master["width"]), int(master["height"]), int(master["fps"])
    full_duration = float(master["durationSeconds"])
    sample_rate = int(master["sampleRate"])
    video_bit_rate = int(master.get("videoBitrate", 16_000_000))

    smoke = bool(args.smoke)
    start = float(args.start if args.start is not None else 0.0)
    duration = float(args.duration if args.duration is not None else (min(4.0, full_duration) if smoke else full_duration))
    if start < 0.0 or duration <= 0.0 or start + duration > full_duration + 1e-6:
        raise ValueError(f"Invalid render window start={start}, duration={duration}, master={full_duration}")

    output = Path(args.output).resolve() if args.output else (SCRIPT_DIR / "work" / "compositor-smoke-1080p.mp4" if smoke else DEFAULT_OUTPUT)
    report_path = Path(args.report).resolve() if args.report else (SCRIPT_DIR / "work" / "compositor-smoke-report.json" if smoke else DEFAULT_REPORT)
    output.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    narration_fallback = resolve_from_config(config_path, config["inputs"]["narration"])
    narration_final_value = config["inputs"].get("narrationFinal", "work/narration-master-final.wav")
    narration_final = resolve_from_config(config_path, narration_final_value)
    narration = narration_final if narration_final.exists() else narration_fallback
    captions_path = resolve_from_config(config_path, config["inputs"]["captions"])
    ambient = resolve_from_config(config_path, config["inputs"]["ambientBed"])
    if not allow_missing_audio and not narration.exists():
        raise FileNotFoundError(f"Narration master is required for this render: {narration}")
    if not smoke and not captions_path.exists():
        raise FileNotFoundError(f"Caption timings are required for a full render: {captions_path}")

    narration_offset = float(config["inputs"].get("narrationOffsetSeconds", 0.0))
    captions = CaptionTrack(
        captions_path if captions_path.exists() else None,
        offset_seconds=narration_offset,
    )
    audio, audio_report = build_audio_mix(
        narration if narration.exists() else None,
        None if args.no_ambient else (ambient if ambient.exists() else None),
        sample_rate,
        start,
        duration,
        narration_offset,
    )

    codec, codec_checks = choose_codec(
        args.codec,
        width,
        height,
        fps,
        video_bit_rate,
        output.parent,
    )
    frame_count = int(round(duration * fps))
    compositor = ToolBraidCompositor(config, config_path, captions)
    staged_output = output.with_name(f".{output.stem}.rendering-{os.getpid()}{output.suffix}")
    # Recover from an earlier hard process termination that could not execute
    # Python finally/atexit handlers. Only sibling staging files for this exact
    # destination name are eligible; the validated destination is untouched.
    for stale_stage in output.parent.glob(f".{output.stem}.rendering-*{output.suffix}"):
        stale_stage.unlink(missing_ok=True)
    staged_output.unlink(missing_ok=True)
    cleanup_staged_output = lambda: staged_output.unlink(missing_ok=True)
    atexit.register(cleanup_staged_output)
    print(f"Rendering {frame_count} frames ({duration:.3f}s) at {width}x{height}/{fps} using {codec}", flush=True)
    started_at = datetime.now(timezone.utc)
    try:
        try:
            # Encode beside the destination. The previously validated master is
            # never truncated by an interrupted render; only a closed, probed
            # MP4 can atomically replace it on the same filesystem.
            with av.open(str(staged_output), mode="w", format="mp4", options={"movflags": "+faststart"}) as container:
                video_stream = container.add_stream(codec, rate=fps)
                configure_video_stream(
                    video_stream,
                    codec,
                    width,
                    height,
                    fps,
                    video_bit_rate,
                )
                audio_stream = container.add_stream("aac", rate=sample_rate)
                audio_stream.layout = "stereo"
                audio_stream.bit_rate = 192_000

                report_every = max(fps, fps * 5)
                for index in range(frame_count):
                    global_time = start + index / fps
                    image = compositor.render(global_time)
                    frame = av.VideoFrame.from_ndarray(np.asarray(image, dtype=np.uint8), format="rgb24")
                    frame.pts = index
                    frame.time_base = Fraction(1, fps)
                    for packet in video_stream.encode(frame):
                        container.mux(packet)
                    if index % report_every == 0 or index == frame_count - 1:
                        print(f"  frame {index + 1:>4}/{frame_count}  timeline {global_time:06.2f}s", flush=True)
                for packet in video_stream.encode():
                    container.mux(packet)
                encode_audio(container, audio_stream, audio, sample_rate)
        finally:
            compositor.close()

        staged_probe = probe_output(staged_output)
        staged_video = next((item for item in staged_probe["streams"] if item["type"] == "video"), None)
        staged_audio = next((item for item in staged_probe["streams"] if item["type"] == "audio"), None)
        if (
            staged_probe["containerDurationSeconds"] != round(duration, 6)
            or staged_video is None
            or staged_audio is None
            or staged_video.get("width") != width
            or staged_video.get("height") != height
            or staged_video.get("frames") != frame_count
            or staged_audio.get("sampleRate") != sample_rate
        ):
            raise RuntimeError(f"Staged MP4 failed structural validation: {staged_probe}")
        staged_output.replace(output)
        atexit.unregister(cleanup_staged_output)
    except BaseException:
        staged_output.unlink(missing_ok=True)
        atexit.unregister(cleanup_staged_output)
        raise

    probe = probe_output(output)
    finished_at = datetime.now(timezone.utc)
    render_seconds = (finished_at - started_at).total_seconds()
    configured_video_sources = (
        config["inputs"].get("productVideos")
        if isinstance(config["inputs"].get("productVideos"), dict)
        else {"default": config["inputs"]["productVideo"]}
    )
    video_source_paths = {
        str(key): resolve_from_config(config_path, str(value))
        for key, value in configured_video_sources.items()
    }
    artifact_hashes = {
        "renderConfig": {
            "path": str(config_path),
            "sha256": sha256_file(config_path),
        },
        "captions": {
            "path": str(captions_path),
            "present": captions_path.is_file(),
            "sha256": sha256_file(captions_path) if captions_path.is_file() else None,
        },
        "productVideos": {
            key: {"path": str(path), "sha256": sha256_file(path)}
            for key, path in video_source_paths.items()
        },
        "output": {
            "path": str(output),
            "bytes": output.stat().st_size,
            "sha256": sha256_file(output),
        },
    }
    report = {
        "format": "toolbraid-final-render-report-v2",
        "generatedAt": finished_at.isoformat(),
        "output": str(output),
        "smokeRender": smoke,
        "window": {"startSeconds": start, "durationSeconds": duration, "endSeconds": start + duration},
        "master": {
            "width": width,
            "height": height,
            "fps": fps,
            "durationSeconds": full_duration,
            "sceneCount": len(config["scenes"]),
        },
        "contentModel": {
            "productSegments": 1,
            "outroSegments": 1,
            "productSource": "public-full",
            "productPlayback": "linear-1x",
            "productProvenance": "public-sandbox",
            "publicUrl": "https://toolbraid-webmcp.vercel.app",
            "disclosure": (
                "Public deployment; native WebMCP executes in a deterministic browser sandbox; "
                "no external system is changed."
            ),
            "generatedOutro": True,
            "reusesBrowserFrameForOutro": False,
        },
        "encoded": {
            "videoCodec": codec,
            "videoBitrate": video_bit_rate,
            "audioCodec": "aac",
            "pixelFormat": "yuv420p",
            "frameCount": frame_count,
            "sampleRate": sample_rate,
            "channels": 2,
            "renderWallSeconds": round(render_seconds, 3),
            "atomicReplace": True,
        },
        "codecPreflight": codec_checks,
        "audio": audio_report,
        "audioSources": {
            "narration": str(narration),
            "preferredFinalPresent": narration_final.exists(),
            "ambient": str(ambient) if ambient.exists() and not args.no_ambient else None,
            "narrationProvenance": provenance["narration"],
            "narrationOffsetSeconds": narration_offset,
        },
        "videoSources": {
            key: str(path) for key, path in video_source_paths.items()
        },
        "captureProvenance": provenance["capture"],
        "captions": {
            "path": str(captions_path),
            "present": captions_path.exists(),
            "sha256": artifact_hashes["captions"]["sha256"],
            "entries": len(captions.captions),
            "burnedIn": captions_path.exists(),
        },
        "artifactHashes": artifact_hashes,
        "probe": probe,
    }
    staged_report = report_path.with_name(f".{report_path.name}.writing-{os.getpid()}.tmp")
    try:
        staged_report.write_text(json.dumps(report, indent=2), encoding="utf-8")
        staged_report.replace(report_path)
    finally:
        staged_report.unlink(missing_ok=True)
    print(f"Wrote {output}", flush=True)
    print(f"Report {report_path}", flush=True)
    return report


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="Render configuration JSON")
    parser.add_argument("--output", help="MP4 destination")
    parser.add_argument("--report", help="JSON report destination")
    parser.add_argument("--codec", choices=("auto", "h264_nvenc", "libx264"), default="auto")
    parser.add_argument("--start", type=float, help="Global timeline start in seconds")
    parser.add_argument("--duration", type=float, help="Partial render duration in seconds")
    parser.add_argument("--smoke", action="store_true", help="Render a four-second partial with silence when masters are absent")
    parser.add_argument("--allow-missing-audio", action="store_true", help="Allow a silent non-smoke render")
    parser.add_argument("--no-ambient", action="store_true", help="Do not mix the optional ambient bed")
    parser.add_argument("--validate-only", action="store_true", help="Validate config and imports without encoding")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    validate_config(
        config,
        config_path,
        allow_missing_audio=bool(args.smoke or args.allow_missing_audio),
    )
    if args.validate_only:
        master = config["master"]
        print(
            "ToolBraid compositor validation passed: "
            f"2 scenes, {int(master['width'])}x{int(master['height'])}/"
            f"{int(master['fps'])}, {float(master['durationSeconds']):.3f} seconds."
        )
        return 0
    render_master(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
