#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["pillow", "numpy"]
# ///
"""README 그림(배너, 작업 흐름도, 배지)을 readme-art.json 하나로 만든다.

README 머리 그림(배너, 흐름도, 배지)을 만드는 도구다.
저장소마다 readme-art.json 의 문구와 물결 색(wave)만 바꾸고 이 파일은 그대로 쓴다.

    uv run .github/assets/make.py             # .github/assets/*.svg 를 다시 만든다
    uv run .github/assets/make.py --preview   # 확인용 PNG 를 임시 폴더에 함께 만든다
    uv run .github/assets/make.py --waves     # 물결 색 후보를 한 장에 모아 임시 폴더에 만든다

uv 는 위 머리의 dependencies 를 읽어 Pillow 와 numpy 를 알아서 받는다. uv 가 없으면 둘을 설치하고 python3 로 돌린다.

배너와 흐름도 배경은 GLSL 물결 셰이더를 numpy 로 옮겨 그린다.
물결은 JPEG 로 SVG 안에 넣는다. rsvg-convert 를 거치면 JPEG 가 PNG 로 풀려 4MB 가 넘으므로, 글자와 카드만 rsvg-convert 로
윤곽선(path)으로 바꾸고 물결은 그 뒤에 끼운다. 보는 사람 컴퓨터에 글꼴이 없어도 같은 모양으로 보인다.
글꼴은 같은 폴더의 fonts/ (Freesentation, SIL OFL 1.1)를 쓴다. 따로 설치하지 않아도 된다.
배너와 흐름도는 GitHub 밝은 화면과 어두운 화면에 같은 그림 하나를 쓴다. 물결 판이 어두워 두 바탕 모두에서 읽힌다.

필요한 것: rsvg-convert (macOS: brew install librsvg), Pillow, numpy.

선택 칸:
    "eyebrow": "..."   배너 제목 위 작은 글자 줄. 없으면 src/logo.png 가 있을 때 그 로고를 넣는다
    "out_dir": "ko"    그림을 .github/assets/ko/ 에 만든다 (한국어판 README 용, --spec readme-art.ko.json)
    "animate": true    배너와 흐름도에 SVG 애니메이션을 넣는다. 글자와 카드는 한 번 떠오르고 멈춘다.
                       배너 물결만 40초 주기로 아주 느리게 흐른다. 움직임 줄이기 설정이면 멈춘 완성본을 보여 준다.
                       멈춘 상태가 완성본이라, 애니메이션을 돌리지 않는 곳(rsvg 미리보기 PNG 등)에서도 같은 그림이다.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from html import escape
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    sys.exit("Pillow 와 numpy 가 필요합니다: uv run .github/assets/make.py 로 돌리거나 pip install pillow numpy")

HERE = Path(__file__).resolve().parent
FONT = "Freesentation"
FONT_DIR = HERE / "fonts"
FONT_FILES = {500: "FREESENTATION-5MEDIUM.TTF", 600: "FREESENTATION-6SEMIBOLD.TTF",
              700: "FREESENTATION-7BOLD.TTF", 800: "FREESENTATION-8EXTRABOLD.TTF"}

# 배지 색 이름. readme-art.json 에는 이름이나 #RRGGBB 를 쓴다
BADGE_COLORS = {
    "claude": "#C15F3C",   # 작업 도구가 Claude Code 일 때
    "live": "#1A7F37",     # 운영 중, 배포됨
    "info": "#0969DA",     # 방법, 범위, 문서
    "warn": "#9A6700",     # 준비 중, 실험
    "neutral": "#6E7781",  # 저장소 공개 범위 같은 사실
    "ink": "#111111",
}
BADGE_LABEL_BG = "#3B4048"

# 물결 색. 명암(0~1)을 어두운 곳, 가운데, 밝은 곳 세 색에 차례로 입힌다
WAVES = {
    "midnight": ("#03050D", "#2B3A66", "#CFDCFF"),  # 기본. 미드나잇 블루
    "indigo": ("#06040F", "#3D2A73", "#E1D6FF"),    # 인디고 바이올렛
    "teal": ("#020A0C", "#1D5157", "#C6F3EA"),      # 딥 틸
    "aurora": ("#04061A", "#4B2F86", "#9FF0D8"),    # 남색, 보라, 민트
    "sunset": ("#0A0820", "#6A2C5C", "#FFC9A3"),    # 남색, 자주, 살구
    "copper": ("#0B0705", "#6B4026", "#FFE2C2"),    # 갈색, 구리, 샴페인
    "slate": ("#05070A", "#45505E", "#E6EDF5"),     # 차가운 청회색
    "mono": ("#000000", "#808080", "#FFFFFF"),      # 흑백
}
DEFAULT_WAVE = "midnight"

INK = "#FFFFFF"            # 물결 위 글자는 모두 흰색이고, 위계는 투명도로 나눈다
BANNER_W, BANNER_H = 1000, 318
FLOW_W = 1000
PLATE_R = 22               # 배너와 흐름도 판 모서리
SCALE = 2                  # 물결 그림 해상도. 화면 1px 에 2px (레티나에서 흐리지 않게)
WAVE_TIME = 40             # 셰이더의 한 장면(uTime). 같은 값이면 언제 만들어도 같은 무늬다
BANNER_SEED, FLOW_SEED = 3, 11
JPEG_QUALITY = 86


# ── 설정 읽기 ────────────────────────────────────────────────────
def load_spec(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"{path} 가 없습니다. title, subtitle, wave, steps, badges 를 적은 JSON 을 만들어 주세요")
    spec = json.loads(path.read_text(encoding="utf-8"))
    errors = []
    for key in ("title", "subtitle"):
        if not str(spec.get(key, "")).strip():
            errors.append(f"{key} 가 비었습니다")
    if spec.get("wave", DEFAULT_WAVE) not in WAVES:
        errors.append(f"wave '{spec.get('wave')}' 를 모릅니다. {', '.join(WAVES)} 중에서 고릅니다")
    steps = spec.get("steps") or []
    if steps and not 3 <= len(steps) <= 5:
        errors.append(f"steps 는 3~5개입니다 (지금 {len(steps)}개). 흐름이 없으면 비워 두세요")
    for i, s in enumerate(steps, 1):
        for key in ("who", "title", "desc"):
            if not str(s.get(key, "")).strip():
                errors.append(f"steps {i}번의 {key} 가 비었습니다")
    badges = spec.get("badges") or []
    if badges and not 2 <= len(badges) <= 4:
        errors.append(f"badges 는 2~4개입니다 (지금 {len(badges)}개)")
    for b in badges:
        color = b.get("color", "")
        if color not in BADGE_COLORS and not (color.startswith("#") and len(color) == 7):
            errors.append(f"배지 '{b.get('label')}' 색 '{color}' 를 모릅니다. {', '.join(BADGE_COLORS)} 또는 #RRGGBB")
        if not str(b.get("file", "")).startswith("badge-"):
            errors.append(f"배지 '{b.get('label')}' 의 file 은 badge- 로 시작합니다")
    if errors:
        sys.exit("readme-art.json 을 고쳐 주세요:\n  " + "\n  ".join(errors))
    return spec


# ── 글자 폭 재기 ─────────────────────────────────────────────────
_fonts: dict[tuple[int, int], ImageFont.FreeTypeFont] = {}


def font(size: float, weight: int) -> ImageFont.FreeTypeFont:
    key = (round(size), weight)
    if key not in _fonts:
        path = FONT_DIR / FONT_FILES[weight]
        if not path.exists():
            sys.exit(f"글꼴 파일이 없습니다: {path}")
        _fonts[key] = ImageFont.truetype(str(path), key[0])
    return _fonts[key]


def width(s: str, size: float, weight: int, spacing: float = 0) -> float:
    return font(size, weight).getlength(s) * size / round(size) + spacing * max(len(s) - 1, 0)


def wrap(s: str, size: float, weight: int, max_w: float) -> list[str]:
    lines: list[str] = []
    # 보통 공백에서만 나눈다. str.split() 은 줄바꿈 없는 공백( )까지 나눠 "Claude Code" 가 갈라진다
    for word in (w for w in s.split(" ") if w):
        if lines and width(lines[-1] + " " + word, size, weight) <= max_w:
            lines[-1] += " " + word
        else:
            lines.append(word)
    return lines


# ── 물결 ─────────────────────────────────────────────────────────
# WaveField.tsx 의 FRAG 셰이더를 그대로 옮겼다. 셰이더를 고치면 여기도 같이 고친다.
def _fract(x):
    return x - np.floor(x)


def _hash(x, y):
    # GPU 와 같은 32비트 소수로 계산한다. 64비트로 하면 같은 seed 에서 다른 무늬가 나온다
    f = np.float32
    x, y = _fract(x.astype(f) * f(123.34)), _fract(y.astype(f) * f(456.21))
    d = x * (x + f(45.32)) + y * (y + f(45.32))
    return _fract((x + d) * (y + d)).astype(np.float64)


def _noise(x, y):
    ix, iy = np.floor(x), np.floor(y)
    fx, fy = x - ix, y - iy
    ux, uy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _hash(ix, iy), _hash(ix + 1, iy)
    c, d = _hash(ix, iy + 1), _hash(ix + 1, iy + 1)
    top, bottom = a + (b - a) * ux, c + (d - c) * ux
    return top + (bottom - top) * uy


def _fbm(x, y):
    v, a = 0.0, 0.5
    for _ in range(3):
        v = v + a * _noise(x, y)
        x, y = 1.6 * x - 1.2 * y, 1.2 * x + 1.6 * y
        a *= 0.5
    return v / 0.875


def _smooth(e0: float, e1: float, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _rgb(hex_color: str) -> np.ndarray:
    return np.array([int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)])


def wave(w: int, h: int, seed: float, colors: tuple[str, str, str]) -> np.ndarray:
    """물결 한 장을 (h, w, 3) 배열(0~1)로 그린다. 밝은 판(uTone=1), 잔물결 세기 1 이다."""
    gx = np.arange(w, dtype=np.float64)[None, :] + 0.5
    gy = (h - np.arange(h, dtype=np.float64))[:, None] - 0.5  # 셰이더 좌표는 아래에서 위로 간다
    gx, gy = np.broadcast_to(gx, (h, w)), np.broadcast_to(gy, (h, w))
    ux, uy = gx / h, gy / h
    t = WAVE_TIME * 0.02
    sx, sy = seed * 1.7, seed * 3.1
    # 느리게 흐르는 왜곡장, 큰 빛과 그림자, 왜곡장을 따라 휘는 잔물결
    wx = _fbm(ux * 0.55 + sx + t, uy * 0.55 + sy + t) - 0.5
    wy = _fbm(ux * 0.55 + sx + 7.3 - t, uy * 0.55 + sy + 2.1 - t) - 0.5
    light = _smooth(0.32, 0.72, _fbm(ux * 0.85 + wx * 1.4 + sx * 0.7, uy * 0.85 + wy * 1.4 + sy * 0.7))
    n = np.hypot(0.55, 1.0)
    phase = (ux * 0.55 / n + uy / n + wx * 0.9 + wy * 0.45) * 58.0 + WAVE_TIME * 0.3
    crest = (0.5 + 0.5 * np.sin(phase)) ** 2.5
    mask = _smooth(0.46, 0.7, _fbm(ux * 0.7 + sx * 1.9 - t, uy * 0.7 + sy * 1.9 + t))
    v = 0.18 + 0.62 * light + (crest - 0.42) * 0.36 * mask * (0.35 + light)
    cx, cy = gx / w - 0.5, gy / h - 0.5
    v = v * (1.0 - (cx * cx + cy * cy) * 0.55)
    v = v + (_hash(np.floor(gx), np.floor(gy)) - 0.5) * 0.085  # 고정 입자
    k = np.clip(v, 0, 1)[..., None]
    lo, mid, hi = (_rgb(c) for c in colors)
    return np.where(k < 0.5, lo + (mid - lo) * (k * 2), mid + (hi - mid) * (k * 2 - 1))


def shade(rgb: np.ndarray, color: str, alpha) -> np.ndarray:
    """물결 위에 어두운 막을 덮는다. alpha 는 숫자나 (h, w) 배열"""
    a = np.asarray(alpha, dtype=np.float64)
    if a.ndim == 2:
        a = a[..., None]
    return rgb * (1 - a) + _rgb(color) * a


def to_image(rgb: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")


def jpeg_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


# ── SVG 조각 ─────────────────────────────────────────────────────
def text(x: float, y: float, s: str, size: float, weight: int, fill: str = INK,
         anchor: str = "start", spacing: float = 0, opacity: float = 1) -> str:
    alpha = f' fill-opacity="{opacity}"' if opacity < 1 else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{size:.1f}" font-weight="{weight}" '
            f'fill="{fill}"{alpha} text-anchor="{anchor}" letter-spacing="{spacing:.2f}">{escape(s)}</text>')


def wordmark(color: str, height: float) -> tuple[str, float]:
    """로고(src/logo.png)를 원하는 색으로 칠해 data URI 로 돌려준다. (href, 너비)"""
    src = Image.open(HERE / "src/logo.png").convert("RGBA")
    src = src.crop(src.getchannel("A").getbbox())
    rgb = tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))
    out = Image.new("RGBA", src.size, rgb + (0,))
    out.putalpha(src.getchannel("A"))
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(), height * src.width / src.height


def svg(w: float, h: float, body: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{w:.0f}" height="{h:.0f}" viewBox="0 0 {w:.0f} {h:.0f}">{body}</svg>')


class Art:
    """물결 판 그림 하나. 글자와 카드(vector)는 rsvg-convert 로 윤곽선이 되고, 물결(plate)은 마지막에 밑에 깔린다.

    layers 는 애니메이션용으로 같은 내용을 조각낸 것이다. [(지연 초, svg 조각), ...] 조각마다 따로 윤곽선을 만들어
    <g class="rise"> 로 감싸고 차례로 떠오르게 한다. drift 가 참이면 물결 판이 아주 느리게 흐른다.
    """

    def __init__(self, w: float, h: float, vector: str, plate: Image.Image,
                 layers: list[tuple[float, str]] | None = None, drift: bool = False):
        self.w, self.h, self.vector, self.plate = w, h, vector, plate
        self.layers, self.drift = layers or [], drift

    def _plate(self, inner: str, animated: bool = False) -> str:
        cls = ' class="pl"' if animated and self.drift else ""
        style = ANIM_CSS if animated else ""
        return svg(self.w, self.h,
                   f'{style}<defs><clipPath id="wave-plate"><rect width="{self.w:.0f}" height="{self.h:.0f}" rx="{PLATE_R}"/>'
                   '</clipPath></defs><g clip-path="url(#wave-plate)">'
                   f'<image{cls} width="{self.w:.0f}" height="{self.h:.0f}" preserveAspectRatio="none" '
                   f'xlink:href="{jpeg_uri(self.plate)}"/>{inner}</g>')

    def compose(self, outlined: str) -> str:
        inner = outlined[outlined.index("<svg"):]  # rsvg-convert 결과의 XML 머리를 떼고 안쪽 svg 로 넣는다
        return self._plate(inner)

    def compose_animated(self, name: str, work: Path, env: dict[str, str]) -> str:
        parts = []
        for i, (delay, body) in enumerate(self.layers):
            out = outline(f"{name}-{i}", svg(self.w, self.h, body), work, env)
            parts.append(f'<g class="rise" style="animation-delay:{delay:.2f}s">{out[out.index("<svg"):]}</g>')
        return self._plate("".join(parts), animated=True)


# 애니메이션. 바탕 상태가 완성본이고, 키프레임은 시작(from)만 적는다. 감속은 튀지 않는 스프링에 가까운 곡선
EASE = "cubic-bezier(.22,1,.36,1)"
ANIM_CSS = ("<style>"
            f".rise{{animation:rise .9s {EASE} both}}"
            "@keyframes rise{from{opacity:0;transform:translateY(14px)}}"
            ".pl{animation:drift 40s ease-in-out infinite alternate;transform-box:fill-box;transform-origin:50% 50%}"
            "@keyframes drift{from{transform:scale(1.07) translateX(-1.2%)}to{transform:scale(1.07) translateX(1.2%)}}"
            "@media (prefers-reduced-motion:reduce){.rise,.pl{animation:none}}"
            "</style>")


# ── 배너 ─────────────────────────────────────────────────────────
def banner(spec: dict, colors: tuple[str, str, str]) -> Art:
    w, h = BANNER_W, BANNER_H
    title, subtitle = spec["title"], spec["subtitle"]
    title_size = 85
    while width(title, title_size, 800, -0.045 * title_size) > w - 160:
        title_size -= 1
    sub_size = 25
    while width(subtitle, sub_size, 500, -0.5) > w - 120:
        sub_size -= 1
    if sub_size < 17:
        sys.exit(f"subtitle 이 너무 깁니다. 한 줄 45자 안으로 줄여 주세요: {subtitle}")
    if spec.get("eyebrow"):
        # 개인 저장소 사본: 워드마크 자리(세로 63~99)에 글자 줄을 둔다
        top = text(w / 2, 89, spec["eyebrow"], 17, 700, anchor="middle", spacing=3.4, opacity=0.72)
    elif (HERE / "src/logo.png").exists():
        href, logo_w = wordmark(INK, 36)
        top = f'<image x="{(w - logo_w) / 2:.1f}" y="63" width="{logo_w:.1f}" height="36" xlink:href="{href}"/>'
    else:
        top = ""
    layers = [(0.15, top),
              (0.30, text(w / 2, 192, title, title_size, 800, anchor="middle", spacing=-0.045 * title_size)),
              (0.48, text(w / 2, 249, subtitle, sub_size, 500, anchor="middle", spacing=-0.5, opacity=0.82))]
    vector = "".join(body for _, body in layers)

    # 가운데를 눌러 글자가 읽히게 한다. 가운데 62%, 가장자리 12% 의 타원 막(가로 65%, 세로 75%)
    pw, ph = w * SCALE, h * SCALE
    rgb = wave(pw, ph, BANNER_SEED, colors)
    yy, xx = np.mgrid[0:ph, 0:pw] + 0.5
    dist = np.clip(np.hypot((xx - pw * 0.5) / (pw * 0.65), (yy - ph * 0.52) / (ph * 0.75)), 0, 1)
    rgb = shade(rgb, colors[0], 0.62 + (0.12 - 0.62) * dist)
    return Art(w, h, svg(w, h, vector), to_image(rgb), layers=layers, drift=True)


# ── 작업 흐름도 ──────────────────────────────────────────────────
def chip_styles(steps: list[dict]) -> dict[str, str]:
    """처음 나온 주체는 흰 칩, 두 번째는 테두리 칩, 그 밖과 '함께'는 옅은 칩."""
    styles: dict[str, str] = {}
    order = ["solid", "line"]
    for s in steps:
        who = s["who"]
        if who in styles:
            continue
        styles[who] = s.get("chip") or ("soft" if who == "함께" or not order else order.pop(0))
    return styles


def chip(x_right: float, y: float, who: str, style: str, size: float, h: float, pad: float, dark: str) -> str:
    cw = width(who, size, 600) + pad * 2
    x = x_right - cw
    shape = {
        "solid": f'fill="{INK}"',
        "line": f'fill="none" stroke="{INK}" stroke-opacity="0.55" stroke-width="1.15"',
    }.get(style, f'fill="{INK}" fill-opacity="0.14"')
    ink = dark if style == "solid" else INK
    return (f'<rect x="{x:.1f}" y="{y:.1f}" width="{cw:.1f}" height="{h:.1f}" rx="{h / 2:.1f}" {shape}/>'
            + text(x + cw / 2, y + h / 2 + 0.35 * size, who, size, 600, ink, "middle"))


def flow(steps: list[dict], colors: tuple[str, str, str]) -> Art:
    n, outer = len(steps), 32
    k = 0.86 if n >= 5 else 1.0          # 다섯 단계면 카드가 좁아 글자를 한 단 줄인다
    slot = 26 if n >= 5 else 34          # 카드 사이 화살표 자리
    cw = (FLOW_W - outer * 2 - slot * (n - 1)) / n
    pad = 19.5 * k
    inner = cw - pad * 2
    num_size, chip_size, chip_h, chip_pad = 19 * k, 16 * k, 28 * k, 11 * k
    title_max, desc_size, line_h = 26 * k, 18 * k, 26.4 * k
    wrapped = [wrap(s["desc"], desc_size, 500, inner) for s in steps]
    if max(len(x) for x in wrapped) > 4:
        sys.exit("steps 의 desc 가 너무 깁니다. 카드에서 네 줄을 넘지 않게 줄여 주세요")
    for s in steps:
        if width(s["who"], chip_size, 600) + chip_pad * 2 + width("00", num_size, 600) + 8 > inner:
            sys.exit(f"steps 의 who '{s['who']}' 가 카드에 비해 깁니다. 줄여 주세요")
    styles = chip_styles(steps)
    ch = 129.5 * k + (max(len(x) for x in wrapped) - 1) * line_h + 24 * k
    h = round(outer * 2 + ch)

    parts, cards, layers = [], [], []
    for i, (s, lines) in enumerate(zip(steps, wrapped)):
        start = len(parts)
        x, y = outer + i * (cw + slot), outer
        cards.append((x, y))
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{cw:.1f}" height="{ch:.1f}" rx="16" fill="{INK}" '
                     f'fill-opacity="0.08" stroke="{INK}" stroke-opacity="0.16" stroke-width="1.15"/>')
        parts.append(text(x + pad, y + 42 * k, f"{i + 1:02d}", num_size, 600, opacity=0.6))
        parts.append(chip(x + cw - pad, y + 21 * k, s["who"], styles[s["who"]], chip_size, chip_h, chip_pad, colors[0]))
        title_size = title_max
        while width(s["title"], title_size, 800, -0.03 * title_size) > inner:
            title_size -= 0.5
        if title_size < 16 * k:
            sys.exit(f"steps 의 title '{s['title']}' 이 카드에 비해 깁니다. 8자 안으로 줄여 주세요")
        parts.append(text(x + pad, y + 94 * k, s["title"], title_size, 800, spacing=-0.03 * title_size))
        for j, line in enumerate(lines):
            parts.append(text(x + pad, y + 129.5 * k + j * line_h, line, desc_size, 500, opacity=0.78))
        # 카드는 왼쪽부터 차례로, 화살표는 앞 카드가 자리 잡은 뒤 나타난다
        layers.append((0.15 + i * 0.14, "".join(parts[start:])))
        if i < n - 1:
            ax, ay = x + cw + slot / 2, y + ch / 2
            arrow = (f'<path d="M {ax - 2.5:.1f} {ay - 6:.1f} L {ax + 3.5:.1f} {ay:.1f} L {ax - 2.5:.1f} {ay + 6:.1f}" '
                     f'fill="none" stroke="{INK}" stroke-opacity="0.5" stroke-width="1.8" '
                     'stroke-linecap="round" stroke-linejoin="round"/>')
            parts.append(arrow)
            layers.append((0.32 + i * 0.14, arrow))

    # 물결에 45% 막을 덮고, 카드 밑은 흐리게 해 반투명 유리처럼 보이게 한다
    pw, ph = FLOW_W * SCALE, h * SCALE
    plate = to_image(shade(wave(pw, ph, FLOW_SEED, colors), colors[0], 0.45))
    under = Image.new("L", plate.size, 0)
    draw = ImageDraw.Draw(under)
    for x, y in cards:
        draw.rounded_rectangle([x * SCALE, y * SCALE, (x + cw) * SCALE, (y + ch) * SCALE], radius=16 * SCALE, fill=255)
    plate.paste(plate.filter(ImageFilter.GaussianBlur(7)), (0, 0), under)
    return Art(FLOW_W, h, svg(FLOW_W, h, "".join(parts)), plate, layers=layers)


# ── 배지 ─────────────────────────────────────────────────────────
def _rounded(x: float, w: float, h: float, r: float, left: bool, right: bool, fill: str) -> str:
    lr, rr = (r if left else 0), (r if right else 0)
    d = (f"M {x + lr} 0 H {x + w - rr} "
         + (f"Q {x + w} 0 {x + w} {rr} " if rr else "")
         + f"V {h - rr} "
         + (f"Q {x + w} {h} {x + w - rr} {h} " if rr else "")
         + f"H {x + lr} "
         + (f"Q {x} {h} {x} {h - lr} " if lr else "")
         + f"V {lr} "
         + (f"Q {x} 0 {x + lr} 0 " if lr else "")
         + "Z")
    return f'<path d="{d}" fill="{fill}"/>'


def badge(b: dict) -> str:
    size, weight, pad, h = 12, 600, 8, 22
    color = BADGE_COLORS.get(b["color"], b["color"])
    lw = width(b["label"], size, weight) + pad * 2
    mw = width(b["message"], size, weight) + pad * 2
    body = (_rounded(0, lw, h, 5, True, False, BADGE_LABEL_BG)
            + _rounded(lw, mw, h, 5, False, True, color)
            + text(lw / 2, 15.2, b["label"], size, weight, "#FFFFFF", "middle")
            + text(lw + mw / 2, 15.2, b["message"], size, weight, "#FFFFFF", "middle"))
    return svg(lw + mw, h, body)


# ── 실행 ─────────────────────────────────────────────────────────
def fontconfig_env(work: Path) -> dict[str, str]:
    """rsvg-convert 가 저장소에 넣어 둔 글꼴을 찾도록 fontconfig 설정을 임시로 만든다.

    macOS 의 rsvg-convert 는 기본으로 시스템 글꼴(CoreText)만 보고 FONTCONFIG_FILE 을 무시한다.
    PANGOCAIRO_BACKEND=fc 로 fontconfig 를 쓰게 해야 fonts/ 의 글꼴이 잡힌다.
    """
    includes = "".join(f'<include ignore_missing="yes">{p}</include>'
                       for p in ("/etc/fonts/fonts.conf", "/opt/homebrew/etc/fonts/fonts.conf",
                                 "/usr/local/etc/fonts/fonts.conf"))
    conf = work / "fonts.conf"
    conf.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>'
                    f"{includes}<dir>{escape(str(FONT_DIR))}</dir><cachedir>{escape(str(work / 'fc'))}</cachedir>"
                    "</fontconfig>", encoding="utf-8")
    return {**os.environ, "FONTCONFIG_FILE": str(conf), "PANGOCAIRO_BACKEND": "fc"}


def outline(name: str, src_svg: str, work: Path, env: dict[str, str]) -> str:
    src, out = work / f"{name}.src.svg", work / f"{name}.out.svg"
    src.write_text(src_svg, encoding="utf-8")
    subprocess.run(["rsvg-convert", "-f", "svg", str(src), "-o", str(out)], check=True, env=env)
    return out.read_text(encoding="utf-8")


def preview(names: list[str], out: Path = HERE) -> Path:
    pdir = Path(tempfile.mkdtemp(prefix="readme-art-"))
    for name in names:
        subprocess.run(["rsvg-convert", "-z", "2", str(out / f"{name}.svg"), "-o", str(pdir / f"{name}.png")], check=True)
    # GitHub 밝은 바탕과 어두운 바탕에 얹은 한 장짜리 화면. 배너와 흐름도는 두 화면에 같은 그림이다
    badges = [Image.open(pdir / f"{n}.png").convert("RGBA") for n in names if n.startswith("badge-")]
    top = Image.open(pdir / "banner.png").convert("RGBA")
    fl = Image.open(pdir / "flow.png").convert("RGBA") if (pdir / "flow.png").exists() else None
    for theme, bg in (("light", (255, 255, 255)), ("dark", (13, 17, 23))):
        w = top.width + 80
        bh = max((b.height for b in badges), default=0)
        h = 40 + top.height + (30 + bh if badges else 0) + 60 + (fl.height + 40 if fl else 0)
        page = Image.new("RGBA", (w, h), bg + (255,))
        page.alpha_composite(top, (40, 40))
        y = 40 + top.height + 30
        if badges:
            x = (w - sum(b.width for b in badges) - 12 * (len(badges) - 1)) // 2
            for b in badges:
                page.alpha_composite(b, (x, y))
                x += b.width + 12
            y += bh + 60
        if fl:
            page.alpha_composite(fl, (40, y))
        page.convert("RGB").save(pdir / f"page-{theme}.png")
    return pdir


def wave_sheet(spec: dict) -> Path:
    """물결 색 후보를 배너 모양으로 한 장에 모은다. 저장소에 맞는 색을 고를 때 본다."""
    pdir = Path(tempfile.mkdtemp(prefix="readme-waves-"))
    tw, th, gap = 640, 204, 24
    names = list(WAVES)
    cols = 2
    rows = (len(names) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw + (cols + 1) * gap, rows * (th + 44) + gap), (255, 255, 255))
    label = font(22, 600)
    current = spec.get("wave", DEFAULT_WAVE)
    for i, name in enumerate(names):
        colors = WAVES[name]
        rgb = wave(tw, th, BANNER_SEED, colors)
        yy, xx = np.mgrid[0:th, 0:tw] + 0.5
        dist = np.clip(np.hypot((xx - tw * 0.5) / (tw * 0.65), (yy - th * 0.52) / (th * 0.75)), 0, 1)
        tile = to_image(shade(rgb, colors[0], 0.62 + (0.12 - 0.62) * dist))
        mask = Image.new("L", tile.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, tw - 1, th - 1], radius=16, fill=255)
        x, y = gap + (i % cols) * (tw + gap), gap + (i // cols) * (th + 44)
        sheet.paste(tile, (x, y + 36), mask)
        mark = "  (지금 설정)" if name == current else ("  (기본)" if name == DEFAULT_WAVE else "")
        ImageDraw.Draw(sheet).text((x + 2, y + 4), f'"wave": "{name}"{mark}', font=label, fill=(17, 17, 17))
    sheet.save(pdir / "waves.png")
    return pdir


def main() -> None:
    ap = argparse.ArgumentParser(description="README 그림 만들기")
    ap.add_argument("--spec", default=str(HERE / "readme-art.json"), help="설정 파일. 기본 .github/assets/readme-art.json")
    ap.add_argument("--preview", action="store_true", help="확인용 PNG 를 임시 폴더에 만든다")
    ap.add_argument("--waves", action="store_true", help="물결 색 후보를 한 장에 모아 임시 폴더에 만들고 끝낸다")
    args = ap.parse_args()

    spec = load_spec(Path(args.spec))
    if args.waves:
        print(f"물결 색 후보: {wave_sheet(spec) / 'waves.png'}")
        return
    if not shutil.which("rsvg-convert"):
        sys.exit("rsvg-convert 가 필요합니다 (macOS: brew install librsvg)")
    colors = WAVES[spec.get("wave", DEFAULT_WAVE)]
    steps = spec.get("steps") or []
    badges = spec.get("badges") or []

    arts: dict[str, Art] = {"banner": banner(spec, colors)}
    if steps:
        arts["flow"] = flow(steps, colors)
    plain = {b["file"]: badge(b) for b in badges}
    names = list(arts) + list(plain)

    # 개인 저장소 사본: out_dir 이 있으면 그 하위 폴더에 만든다 (한국어판 그림은 ko/)
    out = HERE / spec.get("out_dir", "")
    out.mkdir(exist_ok=True)
    rel = out.relative_to(HERE.parents[1]).as_posix()

    # 설정에서 빠진 그림은 지운다 (이름이 바뀐 배지, 흐름도를 뺀 경우)
    for old in list(out.glob("badge-*.svg")) + list(out.glob("flow.svg")):
        if old.stem not in names:
            old.unlink()
            print(f"지움: {rel}/{old.name}")

    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        env = fontconfig_env(work)
        for name, art in arts.items():
            body = (art.compose_animated(name, work, env) if spec.get("animate")
                    else art.compose(outline(name, art.vector, work, env)))
            (out / f"{name}.svg").write_text(body, encoding="utf-8")
            print(f"{rel}/{name}.svg")
        for name, source in plain.items():
            (out / f"{name}.svg").write_text(outline(name, source, work, env), encoding="utf-8")
            print(f"{rel}/{name}.svg")

    # 밝은 화면용과 어두운 화면용 두 벌을 쓰던 예전 그림. README 가 새 그림을 가리키는지 본 뒤 지운다
    legacy = [p.name for p in sorted(out.glob("*.svg")) if p.stem in ("banner-light", "banner-dark", "flow-light", "flow-dark")]
    if legacy:
        print("예전 그림이 남아 있습니다: " + ", ".join(legacy))
        print("  README 가 banner.svg, flow.svg 를 가리키게 바꾼 뒤 지워 주세요")

    if args.preview:
        print(f"미리보기: {preview(names, out)}")


if __name__ == "__main__":
    main()
