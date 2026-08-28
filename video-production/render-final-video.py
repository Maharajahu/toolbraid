#!/usr/bin/env python3
"""Render the locked 162-second ToolBraid WebMCP Challenge master.

The compositor is deliberately self-contained: PyAV handles decoding/encoding,
Pillow/numpy handle motion graphics, and CairoSVG rasterizes the project SVGs.
No external ffmpeg executable or non-project stock media is used.
"""

from __future__ import annotations

import argparse
import atexit
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


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "render-config.json"
DEFAULT_OUTPUT = SCRIPT_DIR / "output" / "ToolBraid-WebMCP-Challenge-1080p.mp4"
DEFAULT_REPORT = SCRIPT_DIR / "output" / "ToolBraid-WebMCP-Challenge-1080p.render-report.json"
AV_TIME_BASE = int(av.time_base)


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
        # Preserve transparency for the ToolBraid mark; the diagram assets have
        # their own full-frame backgrounds and are converted to RGB at output.
        return image.convert("RGBA")


def fitted_zoom(
    image: Image.Image,
    width: int,
    height: int,
    zoom: float,
    focus: tuple[float, float] = (0.5, 0.5),
) -> tuple[Image.Image, tuple[float, float, float, float]]:
    """Crop and resize while retaining a normalized focal point.

    Returns the rendered frame and the source crop in source-pixel units so
    normalized highlight rectangles can be transformed consistently.
    """

    source_width, source_height = image.size
    zoom = max(1.0, zoom)
    crop_width = min(source_width, width / zoom * source_width / width)
    crop_height = min(source_height, height / zoom * source_height / height)
    focus_x = clamp(focus[0]) * source_width
    focus_y = clamp(focus[1]) * source_height
    left = clamp(focus_x - focus[0] * crop_width, 0.0, source_width - crop_width)
    top = clamp(focus_y - focus[1] * crop_height, 0.0, source_height - crop_height)
    crop = (left, top, left + crop_width, top + crop_height)
    rendered = image.crop(tuple(int(round(part)) for part in crop)).resize(
        (width, height), Image.Resampling.BICUBIC
    )
    return rendered, crop


@dataclass(frozen=True)
class Caption:
    start: float
    end: float
    text: str


class CaptionTrack:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.captions: list[Caption] = []
        if path is not None and path.exists():
            self.captions = self._load(path)

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
        self.duration = float(master["durationSeconds"])
        self.colors = {key: hex_rgb(value) for key, value in config["palette"].items()}
        self.fonts = FontBook()
        self.captions = captions
        self.scenes: list[dict[str, Any]] = config["scenes"]
        product_path = resolve_from_config(config_path, config["inputs"]["productVideo"])
        self.product = ProductVideoReader(product_path)
        self.diagram_cache: dict[Path, Image.Image] = {}
        self.background = self._build_background()
        self.vignette = self._build_vignette()
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

    def _build_vignette(self) -> Image.Image:
        yy, xx = np.mgrid[0 : self.height, 0 : self.width]
        nx = (xx - self.width / 2) / (self.width / 2)
        ny = (yy - self.height / 2) / (self.height / 2)
        radius = np.sqrt(nx * nx + ny * ny)
        alpha = np.clip((radius - 0.55) / 0.65, 0.0, 1.0) ** 1.7 * 122
        rgba = np.zeros((self.height, self.width, 4), dtype=np.uint8)
        rgba[..., 3] = alpha.astype(np.uint8)
        return Image.fromarray(rgba, mode="RGBA")

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
            alpha = int(opacity * (0.45 + 0.55 * math.sin(timestamp * speed + px * 20.0) ** 2))
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*self.colors["cyan"], alpha))
        image.alpha_composite(overlay)

    def _braid(self, image: Image.Image, timestamp: float, reveal: float, outro: bool = False) -> None:
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        glow_draw = ImageDraw.Draw(glow)
        center = self.height * (0.52 if not outro else 0.48)
        span_left, span_right = 80, self.width - 80
        samples = 220
        visible = max(2, int(samples * clamp(reveal)))
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
                glow_draw.line(points, fill=(*color, 90), width=18, joint="curve")
                draw.line(points, fill=(*color, 225), width=4, joint="curve")
        image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(14)))
        image.alpha_composite(overlay)

    def _render_intro(self, timestamp: float, segment: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
        local = timestamp - float(segment["start"])
        duration = float(segment["end"]) - float(segment["start"])
        image = self.background.copy().convert("RGBA")
        self._animated_particles(image, timestamp, opacity=70)
        self._braid(image, timestamp, ease_out_cubic(local / 2.8))
        logo_scale = 0.72 + 0.28 * ease_out_cubic(local / 1.6)
        logo_size = int(150 * logo_scale)
        logo = self.logo.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
        glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
        glow.alpha_composite(logo, ((self.width - logo_size) // 2, 170))
        image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(24)))
        image.alpha_composite(logo, ((self.width - logo_size) // 2, 170))
        fade = smoothstep((duration - local) / 0.75)
        if fade < 1.0:
            image.putalpha(int(255 * fade))
        return image.convert("RGB"), {"kind": "intro"}

    def _render_outro(self, timestamp: float, segment: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
        local = timestamp - float(segment["start"])
        duration = float(segment["end"]) - float(segment["start"])
        if self.product.current_image is not None:
            backdrop = self.product.current_image.resize((self.width, self.height), Image.Resampling.BICUBIC)
            backdrop = backdrop.filter(ImageFilter.GaussianBlur(12)).convert("RGBA")
            shade = Image.new("RGBA", backdrop.size, (*self.colors["background"], 218))
            image = Image.alpha_composite(backdrop, shade)
        else:
            image = self.background.copy().convert("RGBA")
        self._animated_particles(image, timestamp, opacity=48)
        self._braid(image, timestamp, smoothstep(local / 1.4), outro=True)
        logo_size = 132
        logo = self.logo.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
        image.alpha_composite(logo, ((self.width - logo_size) // 2, 178))
        end_fade = smoothstep((duration - local) / 0.85)
        if end_fade < 1.0:
            black = Image.new("RGBA", image.size, (*self.colors["background"], int(255 * (1.0 - end_fade))))
            image = Image.alpha_composite(image, black)
        return image.convert("RGB"), {"kind": "outro"}

    def _diagram(self, asset_value: str) -> Image.Image:
        path = resolve_from_config(self.config_path, asset_value)
        if path not in self.diagram_cache:
            self.diagram_cache[path] = svg_to_image(path, self.width, self.height)
        return self.diagram_cache[path]

    def _render_diagram(self, timestamp: float, segment: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
        start, end = float(segment["start"]), float(segment["end"])
        progress = clamp((timestamp - start) / max(0.001, end - start))
        source = self._diagram(segment["asset"])
        motion = str(segment.get("motion", "scan"))
        focus = {
            "radial": (0.57, 0.52),
            "scan": (0.52, 0.52),
            "flow": (0.62, 0.52),
            "authority": (0.50, 0.48),
            "execute": (0.67, 0.58),
        }.get(motion, (0.5, 0.5))
        zoom = 1.0 + 0.055 * smoothstep(progress)
        image, crop = fitted_zoom(source, self.width, self.height, zoom, focus)
        image = image.convert("RGBA")
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        pulse = 0.5 + 0.5 * math.sin(timestamp * math.tau * 0.9)

        if motion == "radial":
            center = (int(self.width * 0.50), int(self.height * 0.49))
            destinations = [
                (0.25, 0.27), (0.25, 0.50), (0.25, 0.72),
                (0.75, 0.27), (0.75, 0.50), (0.75, 0.72),
            ]
            for index, (dx, dy) in enumerate(destinations):
                phase = (progress * 1.4 + index * 0.13) % 1.0
                x = lerp(center[0], dx * self.width, phase)
                y = lerp(center[1], dy * self.height, phase)
                radius = 6 + pulse * 5
                draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*self.colors["cyan"], 210))
            # The architecture includes Mission Control plus six provider
            # documents. The locked judge-facing count is the provider count,
            # so replace the SVG's total-origin chip with an explicit label.
            chip = (1450, 55, 1842, 110)
            draw.rounded_rectangle(
                chip,
                radius=28,
                fill=(*self.colors["background"], 246),
                outline=(*self.colors["cyan"], 105),
                width=2,
            )
            draw.text(
                ((chip[0] + chip[2]) // 2, chip[1] + 17),
                "6 PROVIDER ORIGINS  ·  PORTS 4174–4179",
                anchor="ma",
                font=self.fonts.get("mono", 15),
                fill=(*self.colors["muted"], 240),
            )
        elif motion in {"scan", "flow"}:
            scan_x = int(lerp(100, self.width - 100, progress))
            draw.rounded_rectangle((scan_x - 3, 92, scan_x + 3, self.height - 92), radius=3, fill=(*self.colors["cyan"], 130))
            glow = overlay.filter(ImageFilter.GaussianBlur(18))
            image.alpha_composite(glow)
        else:
            path_y = int(self.height * (0.58 if motion == "execute" else 0.49))
            x = int(lerp(self.width * 0.20, self.width * 0.82, (progress * 1.6) % 1.0))
            draw.ellipse((x - 13, path_y - 13, x + 13, path_y + 13), outline=(*self.colors["mint"], 235), width=4)
            draw.ellipse((x - 26 - pulse * 10, path_y - 26 - pulse * 10, x + 26 + pulse * 10, path_y + 26 + pulse * 10), outline=(*self.colors["cyan"], 110), width=3)

        image.alpha_composite(overlay)
        image.alpha_composite(self.vignette)
        return image.convert("RGB"), {"kind": "diagram", "crop": crop}

    def _render_product(self, timestamp: float, segment: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
        start, end = float(segment["start"]), float(segment["end"])
        progress = smoothstep((timestamp - start) / max(0.001, end - start))
        source_time = lerp(float(segment["sourceStart"]), float(segment["sourceEnd"]), progress)
        source = self.product.get(source_time)
        zoom_start, zoom_end = segment.get("zoom", [1.0, 1.04])
        zoom = lerp(float(zoom_start), float(zoom_end), progress)
        focus_values = segment.get("focus", [0.5, 0.5])
        image, crop = fitted_zoom(source, self.width, self.height, zoom, (float(focus_values[0]), float(focus_values[1])))
        image = image.convert("RGBA")
        # The UI remains legible while the edges receive a restrained cinematic
        # falloff. This is deliberately lighter than a stylized mockup treatment.
        image.alpha_composite(self.vignette)
        return image.convert("RGB"), {
            "kind": "product",
            "crop": crop,
            "sourceSize": source.size,
            "sourceTime": source_time,
        }

    def _render_base(self, timestamp: float, segment: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
        kind = segment["kind"]
        if kind == "intro":
            return self._render_intro(timestamp, segment)
        if kind == "outro":
            return self._render_outro(timestamp, segment)
        if kind == "diagram":
            return self._render_diagram(timestamp, segment)
        if kind == "product":
            return self._render_product(timestamp, segment)
        raise ValueError(f"Unsupported segment kind: {kind}")

    def _transform_source_rect(
        self,
        rect: list[float],
        crop: tuple[float, float, float, float],
        source_size: tuple[int, int],
    ) -> tuple[int, int, int, int]:
        left, top, right, bottom = crop
        crop_width, crop_height = right - left, bottom - top
        source_width, source_height = source_size
        x1 = (rect[0] * source_width - left) / crop_width * self.width
        y1 = (rect[1] * source_height - top) / crop_height * self.height
        x2 = (rect[2] * source_width - left) / crop_width * self.width
        y2 = (rect[3] * source_height - top) / crop_height * self.height
        return tuple(int(round(value)) for value in (x1, y1, x2, y2))  # type: ignore[return-value]

    def _draw_highlights(self, image: Image.Image, timestamp: float, scene: dict[str, Any], metadata: dict[str, Any]) -> None:
        if metadata.get("kind") != "product":
            return
        active = [
            item for item in scene.get("highlights", [])
            if float(item["start"]) <= timestamp < float(item["end"])
        ]
        if not active:
            return
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        glow_draw = ImageDraw.Draw(glow)
        for item in active:
            rect = self._transform_source_rect(item["rect"], metadata["crop"], metadata["sourceSize"])
            color = self.colors.get(item.get("color", "cyan"), self.colors["cyan"])
            pulse = 0.5 + 0.5 * math.sin(timestamp * math.tau * 1.6)
            width = 3 + int(pulse * 2)
            radius = 16
            glow_draw.rounded_rectangle(rect, radius=radius, outline=(*color, 160), width=14)
            draw.rounded_rectangle(rect, radius=radius, outline=(*color, 225), width=width)
            corner = 22
            x1, y1, x2, y2 = rect
            for x, y, sx, sy in (
                (x1, y1, 1, 1), (x2, y1, -1, 1), (x1, y2, 1, -1), (x2, y2, -1, -1)
            ):
                draw.line((x, y, x + sx * corner, y), fill=(*color, 255), width=5)
                draw.line((x, y, x, y + sy * corner), fill=(*color, 255), width=5)
        image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(18)))
        image.alpha_composite(overlay)

    def _draw_scene_label(self, image: Image.Image, timestamp: float, index: int, scene: dict[str, Any]) -> None:
        if scene["id"] in {"01-intro", "11-outro"}:
            return
        local = timestamp - float(scene["start"])
        duration = float(scene["end"]) - float(scene["start"])
        enter = ease_out_cubic(local / 0.65)
        leave = smoothstep((duration - local) / 0.55)
        opacity = int(220 * min(enter, leave))
        if opacity <= 0:
            return
        expanded = local < 3.8
        expansion = smoothstep(min(local / 0.65, (4.0 - local) / 0.65)) if expanded else 0.0
        panel_width = int(290 + 450 * max(0.0, expansion))
        panel_height = 104 if expanded else 48
        # Offset from the application's left rail so the real mission card and
        # its exact objective remain unobscured during the opening product shot.
        x = int(340 - (1.0 - enter) * 90)
        y = 82
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        draw.rounded_rectangle(
            (x, y, x + panel_width, y + panel_height),
            radius=16,
            fill=(*self.colors["surface"], int(opacity * 0.92)),
            outline=(*self.colors["cyan"], int(opacity * 0.45)),
            width=2,
        )
        draw.rounded_rectangle((x, y, x + 6, y + panel_height), radius=3, fill=(*self.colors["cyan"], opacity))
        index_text = f"{index + 1:02d} / {len(self.scenes):02d}"
        draw.text((x + 22, y + 14), index_text, font=self.fonts.get("mono", 14), fill=(*self.colors["muted"], opacity))
        draw.text((x + 108, y + 13), str(scene["kicker"]), font=self.fonts.get("bold", 15), fill=(*self.colors["cyan"], opacity))
        if expanded:
            draw.text((x + 22, y + 47), str(scene["headline"]), font=self.fonts.get("semibold", 30), fill=(*self.colors["text"], opacity))
            draw.text((x + 24, y + 83), str(scene["subhead"]), font=self.fonts.get("mono", 13), fill=(*self.colors["muted"], opacity))
        image.alpha_composite(overlay)

    def _draw_intro_titles(self, image: Image.Image, timestamp: float, scene: dict[str, Any]) -> None:
        local = timestamp - float(scene["start"])
        enter = ease_out_cubic((local - 0.65) / 1.25)
        leave = smoothstep((float(scene["end"]) - timestamp) / 0.85)
        opacity = int(255 * min(enter, leave))
        if opacity <= 0:
            return
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        center_x = self.width // 2
        kicker = str(scene["kicker"])
        headline = str(scene["headline"])
        subhead = str(scene["subhead"])
        draw.text((center_x, 358), "TOOLBRAID", anchor="ma", font=self.fonts.get("bold", 76), fill=(*self.colors["text"], opacity))
        draw.rounded_rectangle(
            (475, 434, 1445, 565),
            radius=28,
            fill=(*self.colors["background"], int(opacity * 0.70)),
        )
        draw.text(
            (center_x, 455),
            headline,
            anchor="ma",
            font=self.fonts.get("semibold", 42),
            fill=(*self.colors["text"], opacity),
            stroke_width=2,
            stroke_fill=(*self.colors["background"], opacity),
        )
        draw.text((center_x, 526), subhead, anchor="ma", font=self.fonts.get("mono", 20), fill=(*self.colors["cyan"], opacity))
        line_width = int(500 * smoothstep((local - 1.0) / 1.2))
        draw.line((center_x - line_width, 571, center_x + line_width, 571), fill=(*self.colors["cyan"], int(opacity * 0.50)), width=2)
        draw.text((center_x, 608), kicker, anchor="ma", font=self.fonts.get("bold", 15), fill=(*self.colors["muted"], opacity))
        image.alpha_composite(overlay)

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
        font = self.fonts.get("semibold", 38)
        lines = self._wrap_text(caption.text, font, 1450)
        line_height = 49
        box_height = 34 + line_height * len(lines)
        box_width = 1560
        x1 = (self.width - box_width) // 2
        position = scene.get("captionPosition", "bottom")
        y1 = 118 if position == "top" else self.height - 78 - box_height
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
                (self.width // 2, y1 + 17 + index * line_height),
                line,
                anchor="ma",
                font=font,
                fill=(*self.colors["text"], alpha),
                stroke_width=1,
                stroke_fill=(0, 5, 10, alpha),
            )
        image.alpha_composite(overlay)

    def _draw_disclosure(self, image: Image.Image, timestamp: float, scene: dict[str, Any]) -> None:
        if scene["id"] != "10-sealed-outcome" or timestamp < 147.0:
            return
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        text = "DETERMINISTIC FIXTURE DEMO  ·  NO PRODUCTION SYSTEM OR PUBLIC STATUS PAGE CHANGED"
        font = self.fonts.get("mono", 15)
        bbox = draw.textbbox((0, 0), text, font=font)
        width = bbox[2] - bbox[0] + 42
        x = self.width - width - 42
        y = self.height - 46
        draw.rounded_rectangle((x, y, x + width, y + 30), radius=10, fill=(1, 8, 15, 224), outline=(*self.colors["amber"], 105), width=1)
        draw.text((x + 21, y + 7), text, font=font, fill=(*self.colors["amber"], 230))
        image.alpha_composite(overlay)

    def _draw_master_chrome(self, image: Image.Image, timestamp: float, scene_index: int) -> None:
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        progress = clamp(timestamp / self.duration)
        draw.rectangle((0, 0, self.width, 4), fill=(7, 21, 34, 230))
        draw.rectangle((0, 0, int(self.width * progress), 4), fill=(*self.colors["cyan"], 235))
        image.alpha_composite(overlay)

    def _apply_scene_transition(self, image: Image.Image, timestamp: float, scene: dict[str, Any]) -> None:
        local = timestamp - float(scene["start"])
        remaining = float(scene["end"]) - timestamp
        visibility = min(smoothstep(local / 0.34), smoothstep(remaining / 0.30))
        if visibility >= 0.999:
            return
        shade = Image.new("RGBA", image.size, (*self.colors["background"], int(255 * (1.0 - visibility))))
        image.alpha_composite(shade)

    def render(self, timestamp: float) -> Image.Image:
        scene_index, scene = self._scene_at(timestamp)
        segment = self._segment_at(scene, timestamp)
        base, metadata = self._render_base(timestamp, segment)
        image = base.convert("RGBA")
        self._draw_highlights(image, timestamp, scene, metadata)
        if scene["id"] == "01-intro":
            self._draw_intro_titles(image, timestamp, scene)
        elif scene["id"] == "11-outro":
            self._draw_outro_titles(image, timestamp, scene)
        elif metadata.get("kind") != "diagram" and scene.get("captionPosition") != "top":
            # Top-caption scenes deliberately move subtitles away from exact
            # approvals, receipts, and the audit seal clear. Their diagram/UI
            # already carries the chapter context, so a second top label would
            # create competing typography and can physically overlap captions.
            self._draw_scene_label(image, timestamp, scene_index, scene)
        self._draw_disclosure(image, timestamp, scene)
        self._draw_caption(image, timestamp, scene)
        self._draw_master_chrome(image, timestamp, scene_index)
        self._apply_scene_transition(image, timestamp, scene)
        return image.convert("RGB")

    def close(self) -> None:
        self.product.close()


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


def build_audio_mix(
    narration_path: Path | None,
    ambient_path: Path | None,
    sample_rate: int,
    start: float,
    duration: float,
) -> tuple[np.ndarray, dict[str, Any]]:
    sample_count = int(round(duration * sample_rate))
    start_sample = int(round(start * sample_rate))
    if narration_path is not None and narration_path.exists():
        narration = fit_audio(resampled_audio(narration_path, sample_rate), sample_count, start_sample)
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
    peak_after = float(np.max(np.abs(mix))) if mix.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(mix), dtype=np.float64))) if mix.size else 0.0
    metadata = {
        "narrationPresent": narration_present,
        "ambientPresent": ambient_present,
        "sampleRate": sample_rate,
        "channels": 2,
        "sampleCount": sample_count,
        "peakBeforeLimiter": round(peak_before, 7),
        "limiterGain": round(limiter_gain, 7),
        "peak": round(peak_after, 7),
        "rmsDbfs": round(20.0 * math.log10(max(rms, 1e-12)), 2),
    }
    return mix, metadata


def configure_video_stream(stream: av.video.stream.VideoStream, codec: str, width: int, height: int, fps: int) -> None:
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuv420p"
    stream.bit_rate = 16_000_000
    stream.codec_context.gop_size = fps * 2
    stream.codec_context.max_b_frames = 2
    if codec == "h264_nvenc":
        stream.codec_context.options = {
            "preset": "p6",
            "tune": "hq",
            "rc": "vbr",
            "cq": "18",
            "profile": "high",
        }
    else:
        stream.codec_context.options = {
            "preset": "medium",
            "crf": "17",
            "tune": "film",
            "profile": "high",
        }


def codec_preflight(codec: str, width: int, height: int, fps: int, output_dir: Path) -> tuple[bool, str | None]:
    probe_path = output_dir / f".toolbraid-{codec}-{os.getpid()}-probe.mp4"
    try:
        with av.open(str(probe_path), mode="w", format="mp4") as container:
            stream = container.add_stream(codec, rate=fps)
            configure_video_stream(stream, codec, width, height, fps)
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


def choose_codec(requested: str, width: int, height: int, fps: int, output_dir: Path) -> tuple[str, dict[str, Any]]:
    candidates = [requested] if requested != "auto" else ["h264_nvenc", "libx264"]
    checks: dict[str, Any] = {}
    for codec in candidates:
        ok, error = codec_preflight(codec, width, height, fps, output_dir)
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


def validate_config(config: dict[str, Any], config_path: Path) -> None:
    master = config["master"]
    if (int(master["width"]), int(master["height"]), int(master["fps"])) != (1920, 1080, 30):
        raise ValueError("The challenge master is locked to 1920x1080 at 30 fps")
    if float(master["durationSeconds"]) != 162.0:
        raise ValueError("The challenge master duration is locked to exactly 162 seconds")
    scenes = config["scenes"]
    if len(scenes) != 11:
        raise ValueError(f"Expected exactly 11 scenes, got {len(scenes)}")
    cursor = 0.0
    for scene in scenes:
        start, end = float(scene["start"]), float(scene["end"])
        if abs(start - cursor) > 1e-6 or end <= start:
            raise ValueError(f"Scene timeline is not contiguous at {scene['id']}")
        cursor = end
        for segment in scene["segments"]:
            kind = segment["kind"]
            if kind == "diagram":
                asset = resolve_from_config(config_path, segment["asset"])
                if not asset.exists():
                    raise FileNotFoundError(asset)
    if abs(cursor - 162.0) > 1e-6:
        raise ValueError(f"Scene timeline ends at {cursor}, expected 162")
    product = resolve_from_config(config_path, config["inputs"]["productVideo"])
    logo = resolve_from_config(config_path, config["inputs"]["logo"])
    for required in (product, logo):
        if not required.exists():
            raise FileNotFoundError(required)


def render_master(args: argparse.Namespace) -> dict[str, Any]:
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    validate_config(config, config_path)
    master = config["master"]
    width, height, fps = int(master["width"]), int(master["height"]), int(master["fps"])
    full_duration = float(master["durationSeconds"])
    sample_rate = int(master["sampleRate"])

    smoke = bool(args.smoke)
    start = float(args.start if args.start is not None else (21.0 if smoke else 0.0))
    duration = float(args.duration if args.duration is not None else (4.0 if smoke else full_duration))
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
    if not smoke and not args.allow_missing_audio:
        if not narration.exists():
            raise FileNotFoundError(f"Narration master is required for a full render: {narration}")
        if not captions_path.exists():
            raise FileNotFoundError(f"Caption timings are required for a full render: {captions_path}")

    captions = CaptionTrack(captions_path if captions_path.exists() else None)
    audio, audio_report = build_audio_mix(
        narration if narration.exists() else None,
        None if args.no_ambient else (ambient if ambient.exists() else None),
        sample_rate,
        start,
        duration,
    )

    codec, codec_checks = choose_codec(args.codec, width, height, fps, output.parent)
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
                configure_video_stream(video_stream, codec, width, height, fps)
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
    report = {
        "format": "toolbraid-final-render-report-v1",
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
        "encoded": {
            "videoCodec": codec,
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
        },
        "captions": {
            "path": str(captions_path),
            "present": captions_path.exists(),
            "entries": len(captions.captions),
            "burnedIn": captions_path.exists(),
        },
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
    validate_config(config, config_path)
    if args.validate_only:
        print("ToolBraid compositor validation passed: 11 scenes, 1920x1080/30, 162 seconds.")
        return 0
    render_master(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
