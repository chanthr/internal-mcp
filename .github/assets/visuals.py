#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["pillow", "numpy"]
# ///
"""README 본문 그림(타일, 카드, 그래프)을 visuals.json 하나로 만든다.

배너와 흐름도(make.py, 물결 판)와 달리 투명 바탕, 흑백, 가는 선으로 그린다. 표 대신 넣는 그림이다.

    uv run .github/assets/visuals.py                                   # visuals.json 의 그림을 다시 만든다
    uv run .github/assets/visuals.py --spec .github/assets/visuals.ko.json   # 한국어판 (out_dir: "ko")
    uv run .github/assets/visuals.py --preview                         # 확인용 PNG 를 임시 폴더에 만든다

그림마다 밝은 판(<이름>-light.svg)과 어두운 판(<이름>-dark.svg)을 만든다. README 에서는 이렇게 넣는다.

    <picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/<이름>-dark.svg">
    <img alt="..." src=".github/assets/<이름>-light.svg" width="100%"></picture>

그림 종류 (visuals.json 의 figures[].type)
1. hero    프로필 첫 화면: 작은 글자 줄, 큰 이름, 타이핑되는 소개, 물결 선
2. tiles   아이콘 타일 격자. header(선택), cols, tiles[{icon, title, desc, tag}]
3. label   구역 이름과 가는 줄
4. card    프로젝트 카드 (480 폭, README 에서 두 장씩)
5. facts   짧은 사실 칸들 (예: 학교, 지역, 도구)
6. curve   꺾은선 그래프. 선이 그려지며 나타난다
7. paper   PDF 첫 쪽 미리보기와 소개
8. bars    가로 막대 그래프. 막대가 자라며 나타난다

애니메이션은 한 번만 돌고 멈춘다. 멈춘 상태가 완성본이라, 움직임 줄이기 설정이나 애니메이션을 돌리지 않는 곳에서도 같은 그림이다.
글꼴, 글자 폭, 윤곽선, 물결 색은 같은 폴더 make.py 를 쓴다. 아이콘은 src/icons.json (Lucide, ISC, src/LUCIDE-LICENSE.txt).
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import make as M  # noqa: E402  (같은 폴더의 그림 도구: 글꼴, 글자 폭, 윤곽선, 물결 색)

from PIL import Image  # noqa: E402

ICONS = json.loads((HERE / "src/icons.json").read_text(encoding="utf-8"))
W = 1000
EASE = "cubic-bezier(.22,1,.36,1)"  # 튀지 않는 스프링에 가까운 감속

# GitHub 화면 색 (글자, 흐린 글자, 선, 카드 바탕)
PAL = {
    "light": {"ink": "#1F2328", "muted": "#59636E", "line": "#D1D9E0", "fill": "#F6F8FA"},
    "dark": {"ink": "#F0F6FC", "muted": "#9198A1", "line": "#3D444D", "fill": "#151B23"},
}
MODES = tuple(PAL)

BASE_CSS = (
    f".rise{{animation:rise .9s {EASE} both}}"
    "@keyframes rise{from{opacity:0;transform:translateY(12px)}}"
    ".type{animation:type 2s linear both}"
    "@keyframes type{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}"  # 끝을 적어야 보간된다
    f".draw{{stroke-dasharray:1;animation:draw 1.4s {EASE} both}}"
    "@keyframes draw{from{stroke-dashoffset:1}}"
    f".grow{{transform-box:fill-box;transform-origin:0 50%;animation:grow 1.1s {EASE} both}}"
    "@keyframes grow{from{transform:scaleX(0)}}"
    ".caret{opacity:0}"
    "@media (prefers-reduced-motion:reduce){.rise,.type,.draw,.grow,.caret{animation:none}}"
)


def accent(wave, mode: str) -> str:
    """선과 점 색을 고른다. 물결 색 이름이면 밝은 화면은 가운데 색, 어두운 화면은 밝은 색.
    {"light": "#..", "dark": "#.."} 로 화면마다 따로 줄 수 있고, "#RRGGBB" 는 두 화면에 같은 색이다."""
    if isinstance(wave, dict):
        return wave[mode]
    if wave.startswith("#"):
        return wave
    _, mid, hi = M.WAVES[wave]
    return mid if mode == "light" else hi


# ── 조각과 합치기 ────────────────────────────────────────────────
class Layer:
    """애니메이션 조각 하나. text=True 면 rsvg-convert 로 글자를 윤곽선으로 바꾼다(선 그리기 조각은 그대로 둔다)."""

    def __init__(self, cls: str, delay: float, body: str, text: bool = True, dur: float | None = None):
        self.cls, self.delay, self.body, self.text, self.dur = cls, delay, body, text, dur

    def style(self) -> str:
        s = f"animation-delay:{self.delay:.2f}s"
        return s + (f";animation-duration:{self.dur:.2f}s" if self.dur else "")


class Figure:
    def __init__(self, w: float, h: float, layers: list[Layer], css: str = "", defs: str = ""):
        self.w, self.h, self.layers, self.css, self.defs = w, h, layers, css, defs


def _inner(outlined: str) -> str:
    """rsvg-convert 결과에서 바깥 <svg> 를 벗긴다. 좌표계가 같아서 그대로 넣을 수 있다."""
    start = outlined.index(">", outlined.index("<svg")) + 1
    return outlined[start:outlined.rindex("</svg>")]


def compose(name: str, fig: Figure, work: Path, env: dict) -> str:
    parts = []
    for i, ly in enumerate(fig.layers):
        body = _inner(M.outline(f"{name}-{i}", M.svg(fig.w, fig.h, ly.body), work, env)) if ly.text else ly.body
        parts.append(f'<g class="{ly.cls}" style="{ly.style()}">{body}</g>')
    return M.svg(fig.w, fig.h, f"<style>{BASE_CSS}{fig.css}</style>{fig.defs}" + "".join(parts))


def text(x: float, y: float, s: str, size: float, weight: int, fill: str, spacing: float = 0, anchor: str = "start") -> str:
    return M.text(x, y, s, size, weight, fill=fill, anchor=anchor, spacing=spacing)


def eyebrow(x: float, y: float, s: str, fill: str, size: float = 13) -> str:
    return text(x, y, s, size, 700, fill, spacing=0.2 * size)


def fit(s: str, size: float, weight: int, max_w: float, floor: float, what: str) -> float:
    while M.width(s, size, weight, -0.03 * size) > max_w:
        size -= 0.5
    if size < floor:
        sys.exit(f"{what} '{s}' 이 너무 깁니다. 줄여 주세요")
    return size


def wrap(s: str, size: float, max_w: float, max_lines: int, what: str) -> list[str]:
    lines = M.wrap(s, size, 500, max_w)
    if len(lines) > max_lines:
        sys.exit(f"{what} 가 {max_lines}줄을 넘습니다. 줄여 주세요: {s}")
    return lines


def chip(x: float, y: float, label: str, p: dict, size: float = 12.5, h: float = 23) -> tuple[str, float]:
    w = M.width(label, size, 600) + 20
    return (f'<rect x="{x:.1f}" y="{y + .5:.1f}" width="{w:.1f}" height="{h}" rx="{h / 2}" fill="none" stroke="{p["line"]}"/>'
            + text(x + w / 2, y + h / 2 + size * 0.36 + .5, label, size, 600, p["muted"], anchor="middle")), w


# ── 아이콘: 모든 도형을 path 로 바꿔 pathLength=1 선 그리기가 어디서나 같게 보이게 한다 ──
def _shape_d(tag: str, a: dict) -> str:
    def f(k: str, d: float = 0.0) -> float:
        return float(a.get(k, d))
    if tag == "path":
        return a["d"]
    if tag == "line":
        return f"M{f('x1')} {f('y1')}L{f('x2')} {f('y2')}"
    if tag in ("polyline", "polygon"):
        pts = re.findall(r"-?[\d.]+", a["points"])
        xy = [f"{pts[i]} {pts[i + 1]}" for i in range(0, len(pts), 2)]
        return "M" + "L".join(xy) + ("Z" if tag == "polygon" else "")
    if tag in ("circle", "ellipse"):
        cx, cy = f("cx"), f("cy")
        rx = f("r") if tag == "circle" else f("rx")
        ry = f("r") if tag == "circle" else f("ry")
        return f"M{cx - rx} {cy}a{rx} {ry} 0 1 0 {2 * rx} 0a{rx} {ry} 0 1 0 {-2 * rx} 0"
    if tag == "rect":
        x, y, w, h = f("x"), f("y"), f("width"), f("height")
        rx = f("rx", f("ry", 0))
        ry = f("ry", rx)
        if not rx:
            return f"M{x} {y}h{w}v{h}h{-w}Z"
        return (f"M{x + rx} {y}h{w - 2 * rx}a{rx} {ry} 0 0 1 {rx} {ry}v{h - 2 * ry}a{rx} {ry} 0 0 1 {-rx} {ry}"
                f"h{-(w - 2 * rx)}a{rx} {ry} 0 0 1 {-rx} {-ry}v{-(h - 2 * ry)}a{rx} {ry} 0 0 1 {rx} {-ry}Z")
    sys.exit(f"아이콘 도형 {tag} 를 모릅니다")


def icon(name: str, x: float, y: float, size: float, color: str, stroke: float = 1.7, draw: bool = False) -> str:
    if name not in ICONS:
        sys.exit(f"아이콘 '{name}' 이 src/icons.json 에 없습니다. 있는 것: {', '.join(ICONS)}")
    s = size / 24
    extra = ' pathLength="1"' if draw else ""
    paths = "".join(f'<path d="{_shape_d(t, a)}"{extra}/>' for t, a in ICONS[name])
    return (f'<g transform="translate({x:.1f} {y:.1f}) scale({s:.4f})" fill="none" stroke="{color}" '
            f'stroke-width="{stroke / s:.2f}" stroke-linecap="round" stroke-linejoin="round">{paths}</g>')


# ── 1. hero ──────────────────────────────────────────────────────
def hero(f: dict, mode: str, index: int) -> Figure:
    p, h = PAL[mode], 300
    x, top = 2.0, ""
    for i, lab in enumerate(f["labels"]):
        if i:
            top += f'<rect x="{x:.1f}" y="27" width="1.2" height="15" fill="{p["line"]}"/>'
            x += 19
        top += eyebrow(x, 40, lab, p["muted"], 14)
        x += M.width(lab, 14, 700, 0.2 * 14) + 19
    name_size = fit(f["title"], 96, 800, W - 8, 48, "hero title")
    name = text(0, 140, f["title"], name_size, 800, p["ink"], spacing=-0.03 * name_size)

    tag_w = M.width(f["tagline"], 28, 500, -0.3)
    if tag_w > W - 20:
        sys.exit("hero tagline 이 너무 깁니다")
    tagline = text(2, 198, f["tagline"], 28, 500, p["muted"], spacing=-0.3)
    type_delay, type_dur = 0.75, max(1.2, 0.032 * len(f["tagline"]))
    caret = f'<rect x="{2 + tag_w + 4:.1f}" y="172" width="2.4" height="33" rx="1" fill="{p["ink"]}"/>'
    css = (f".caret{{animation:caret {type_dur + 0.6:.2f}s linear both}}"
           f"@keyframes caret{{0%{{opacity:1;transform:translateX(-{tag_w:.1f}px)}}"
           f"{type_dur / (type_dur + 0.6) * 100:.1f}%{{opacity:1;transform:translateX(0)}}"
           "100%{opacity:0;transform:translateX(0)}}"
           "@media (prefers-reduced-motion:reduce){.caret{animation:none}}")

    waves = f.get("waves", ["midnight", "indigo", "teal"])
    stops = "".join(f'<stop offset="{i / max(1, len(waves) - 1):.2f}" stop-color="{accent(wv, mode)}"/>' for i, wv in enumerate(waves))
    defs = f'<defs><linearGradient id="wv-{mode}" x1="0" x2="1">{stops}</linearGradient></defs>'
    lines = []
    for k, op in enumerate((0.95, 0.55, 0.3)):
        pts = []
        for i in range(251):
            xx = W * i / 250
            env = 0.35 + 0.65 * math.sin(math.pi * xx / W)
            yy = 262 + k * 10 + 11 * env * math.sin(2 * math.pi * xx / 290 + k * 0.7) + 4 * math.sin(2 * math.pi * xx / 97 + k)
            pts.append(f"{xx:.1f} {yy:.1f}")
        lines.append(Layer("draw", 0.45 + k * 0.18,
                           f'<path d="M{"L".join(pts)}" pathLength="1" fill="none" stroke="url(#wv-{mode})" '
                           f'stroke-opacity="{op}" stroke-width="1.6" stroke-linecap="round"/>', text=False, dur=2.4))
    layers = [Layer("rise", 0.05, top), Layer("rise", 0.15, name), Layer("type", type_delay, tagline, dur=type_dur),
              Layer("caret", type_delay, caret, text=False)] + lines
    return Figure(W, h, layers, css, defs)


# ── 2. tiles ─────────────────────────────────────────────────────
def tiles(f: dict, mode: str, index: int) -> Figure:
    p = PAL[mode]
    items, cols, gap, row_gap = f["tiles"], f.get("cols", len(f["tiles"])), 28, 36
    cw = (W - gap * (cols - 1)) / cols
    size, lh = f.get("text_size", 16), f.get("text_size", 16) * 1.375
    layers, y = [], 4
    if f.get("header"):
        hd = f["header"]
        body = eyebrow(2, 22, hd["eyebrow"], p["muted"]) if hd.get("eyebrow") else ""
        ts = fit(hd["title"], 32, 800, W, 22, "tiles header title")
        body += text(0, 64, hd["title"], ts, 800, p["ink"], spacing=-0.03 * ts)
        if hd.get("subtitle"):
            body += text(2, 95, hd["subtitle"], 17, 500, p["muted"])
        layers += [Layer("rise", 0.05, body),
                   Layer("grow", 0.25, f'<rect x="0" y="122" width="{W}" height="1" fill="{p["line"]}"/>', text=False)]
        y = 146
    delay = 0.45 if f.get("header") else 0.1
    for r in range(0, len(items), cols):
        row = items[r:r + cols]
        wrapped = [wrap(t["desc"], size, cw - 4, f.get("max_lines", 4), f"tile '{t['title']}' desc") for t in row]
        for c, (t, lines) in enumerate(zip(row, wrapped)):
            x = c * (cw + gap)
            d = delay + (r + c) * 0.1
            if t.get("icon"):
                layers.append(Layer("draw", d, icon(t["icon"], x, y, 26, p["ink"], draw=True), text=False, dur=1.3))
            body = ""
            if t.get("tag"):
                tw = M.width(t["tag"], 12, 600) + 18
                body += (f'<rect x="{x + cw - tw:.1f}" y="{y + 1.5:.1f}" width="{tw:.1f}" height="22" rx="11" fill="none" '
                         f'stroke="{accent(t.get("tag_color", "slate"), mode) if t.get("tag_color") else p["line"]}"/>'
                         + text(x + cw - tw / 2, y + 16.8, t["tag"], 12, 600, p["muted"], anchor="middle"))
            tsz = fit(t["title"], 19, 700, cw - (M.width(t.get("tag", ""), 12, 600) + 26 if t.get("tag") else 0), 14, "tile title")
            body += text(x, y + 60, t["title"], tsz, 700, p["ink"])
            body += "".join(text(x, y + 86 + j * lh, line, size, 500, p["muted"]) for j, line in enumerate(lines))
            layers.append(Layer("rise", d + 0.05, body))
        y += 86 + (max(len(x) for x in wrapped) - 1) * lh + row_gap
    return Figure(W, round(y - row_gap + 14), layers)


# ── 3. label ─────────────────────────────────────────────────────
def label(f: dict, mode: str, index: int) -> Figure:
    p = PAL[mode]
    return Figure(W, 46, [Layer("rise", 0.05, eyebrow(2, 22, f["text"], p["muted"])),
                          Layer("grow", 0.15, f'<rect x="0" y="40" width="{W}" height="1" fill="{p["line"]}"/>', text=False)])


# ── 4. card ──────────────────────────────────────────────────────
CARD_W, CARD_H = 480, 190


def card(f: dict, mode: str, index: int) -> Figure:
    p, pad = PAL[mode], 24
    inner = CARD_W - pad * 2
    size = fit(f["title"], 24, 800, inner - 30, 17, "card title")
    lines = wrap(f["desc"], 16, inner, 2, f"card '{f['title']}' desc")
    body = (f'<rect x=".5" y=".5" width="{CARD_W - 1}" height="{CARD_H - 1}" rx="14" fill="{p["fill"]}" stroke="{p["line"]}"/>'
            f'<circle cx="{pad + 4}" cy="39.5" r="4.5" fill="{accent(f["wave"], mode)}"/>'
            + eyebrow(pad + 17, 44, f["eyebrow"], p["muted"], 12)
            + icon("arrow-up-right", CARD_W - pad - 19, 26, 19, p["muted"])
            + text(pad, 84, f["title"], size, 800, p["ink"], spacing=-0.03 * size)
            + "".join(text(pad, 112 + j * 21.5, line, 16, 500, p["muted"]) for j, line in enumerate(lines)))
    x = pad
    for s in f.get("stack", []):
        b, w = chip(x, 146, s, p)
        body += b
        x += w + 7
    if x - 7 > CARD_W - pad:
        sys.exit(f"카드 '{f['title']}' stack 칩이 넘칩니다. 줄여 주세요")
    return Figure(CARD_W, CARD_H, [Layer("rise", 0.08 + f.get("order", index) * 0.07, body)])


# ── 5. facts ─────────────────────────────────────────────────────
def facts(f: dict, mode: str, index: int) -> Figure:
    p, gap = PAL[mode], 28
    items = f["items"]
    cw = (W - gap * (len(items) - 1)) / len(items)
    wrapped = [wrap(it["text"], 16, cw - 4, 4, f"facts '{it['label']}'") for it in items]
    layers = []
    for i, (it, lines) in enumerate(zip(items, wrapped)):
        x = i * (cw + gap)
        layers.append(Layer("rise", 0.1 + i * 0.1, eyebrow(x + 2, 14, it["label"], p["muted"], 12)
                            + "".join(text(x, 40 + j * 22, line, 16, 500, p["ink"]) for j, line in enumerate(lines))))
    return Figure(W, 26 + max(len(x) for x in wrapped) * 22 + 10, layers)


# ── 6. curve ─────────────────────────────────────────────────────
def curve(f: dict, mode: str, index: int) -> Figure:
    """꺾은선 그래프. series 마다 points [[x, y], ...]. 축 범위는 x, y 로 정한다."""
    p = PAL[mode]
    h = f.get("height", 360)
    left, right, top, bottom = 64, 24, 92, 58
    legend_y = 22
    (x0, x1), (y0, y1) = f["x"]["range"], f["y"]["range"]
    pw, ph = W - left - right, h - top - bottom

    def X(v: float) -> float:
        return left + (v - x0) / (x1 - x0) * pw

    def Y(v: float) -> float:
        return top + ph - (v - y0) / (y1 - y0) * ph

    grid = ""
    for v in f["y"]["ticks"]:
        grid += f'<rect x="{left}" y="{Y(v):.1f}" width="{pw}" height="1" fill="{p["line"]}" fill-opacity="{1 if v == y0 else .55}"/>'
    labels = "".join(text(left - 12, Y(v) + 5, f["y"].get("fmt", "{}").format(v), 13, 600, p["muted"], anchor="end")
                     for v in f["y"]["ticks"])
    labels += "".join(text(X(v), h - bottom + 26, f["x"].get("fmt", "{}").format(v), 13, 600, p["muted"], anchor="middle")
                      for v in f["x"]["ticks"])
    labels += text(left + pw, h - 8, f["x"]["title"], 13, 600, p["muted"], anchor="end")
    labels += text(0, top - 30, f["y"]["title"], 13, 600, p["muted"]) if f["y"].get("title") else ""
    layers = [Layer("rise", 0.05, grid, text=False), Layer("rise", 0.1, labels)]

    # 표시선 (예: 안전장치 105°C)
    for mk in f.get("markers", []):
        mx = X(mk["x"])
        layers.append(Layer("rise", 0.2, f'<path d="M{mx:.1f} {top}V{top + ph}" stroke="{p["muted"]}" stroke-width="1.2" '
                                         f'stroke-dasharray="4 4" fill="none"/>', text=False))
        layers.append(Layer("rise", 0.25, text(mx - 8, top + 16, mk["label"], 13, 600, p["muted"], anchor="end")))

    # 범례와 선
    lx = 0
    for i, s in enumerate(f["series"]):
        color = accent(s["color"], mode) if s.get("color") else p["ink"]
        dash = ""
        lw = M.width(s["name"], 14, 600) + 34
        layers.append(Layer("rise", 0.15 + i * 0.08,
                            f'<rect x="{lx:.1f}" y="{legend_y - 6:.1f}" width="18" height="3" rx="1.5" fill="{color}"/>'
                            + text(lx + 26, legend_y, s["name"], 14, 600, p["ink"])))
        lx += lw + 14
        d = "M" + "L".join(f"{X(a):.1f} {Y(b):.1f}" for a, b in s["points"])
        layers.append(Layer("draw", 0.35 + i * 0.22, f'<path d="{d}" pathLength="1" fill="none" stroke="{color}" '
                                                     f'stroke-width="{s.get("width", 2.6)}" stroke-linejoin="round" '
                                                     f'stroke-linecap="round"{dash}/>', text=False, dur=1.6))
        for a, b in s.get("dots", []):
            layers.append(Layer("rise", 1.2 + i * 0.22, f'<circle cx="{X(a):.1f}" cy="{Y(b):.1f}" r="4" fill="{color}"/>',
                                text=False))
    return Figure(W, h, layers)


# ── 7. paper ─────────────────────────────────────────────────────
_THUMBS: dict[str, str] = {}


def _thumb(pdf: Path, height: int) -> str:
    """PDF 첫 쪽을 JPEG data URI 로. macOS sips 가 첫 쪽을 그린다."""
    key = f"{pdf}:{height}"
    if key not in _THUMBS:
        if not shutil.which("sips"):
            sys.exit("paper 그림은 PDF 첫 쪽을 그리려고 macOS sips 를 씁니다")
        with tempfile.TemporaryDirectory() as td:
            png = Path(td) / "p.png"
            subprocess.run(["sips", "-s", "format", "png", "-Z", str(height * 2), str(pdf), "--out", str(png)],
                           check=True, capture_output=True)
            rgba = Image.open(png).convert("RGBA")  # sips 는 종이 바탕을 투명으로 둔다. 흰 종이 위에 얹는다
            img = Image.new("RGB", rgba.size, (255, 255, 255))
            img.paste(rgba, (0, 0), rgba)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=82, optimize=True)
        _THUMBS[key] = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    return _THUMBS[key]


def paper(f: dict, mode: str, index: int) -> Figure:
    p = PAL[mode]
    h, th = 250, 226
    pdf = (HERE.parents[1] / f["pdf"]).resolve()
    tw = round(th * 0.707)
    uri = _thumb(pdf, th)
    thumb = (f'<defs><clipPath id="pg-{index}"><rect x="12" y="12" width="{tw}" height="{th}" rx="6"/></clipPath></defs>'
             f'<image x="12" y="12" width="{tw}" height="{th}" clip-path="url(#pg-{index})" preserveAspectRatio="xMidYMin slice" '
             f'xlink:href="{uri}"/>'
             f'<rect x="12.5" y="12.5" width="{tw - 1}" height="{th - 1}" rx="6" fill="none" stroke="{p["line"]}"/>')
    x = 12 + tw + 32
    inner = W - x - 24
    ts = 26
    tlines = M.wrap(f["title"], ts, 800, inner)
    while len(tlines) > 2:
        ts -= 1
        tlines = M.wrap(f["title"], ts, 800, inner)
    body = eyebrow(x + 1, 40, f["eyebrow"], p["muted"], 12)
    y = 78
    for line in tlines:
        body += text(x, y, line, ts, 800, p["ink"], spacing=-0.02 * ts)
        y += ts * 1.2
    y += 6
    for line in wrap(f["desc"], 16, inner, 3, f"paper '{f['title']}' desc"):
        body += text(x, y, line, 16, 500, p["muted"])
        y += 22
    cx = x
    for s in f.get("meta", []):
        b, w = chip(cx, h - 50, s, p)
        body += b
        cx += w + 7
    layers = [Layer("rise", 0.05 + index * 0.1, thumb, text=False), Layer("rise", 0.15 + index * 0.1, body)]
    return Figure(W, h, layers)


# ── 8. bars ──────────────────────────────────────────────────────
def bars(f: dict, mode: str, index: int) -> Figure:
    """가로 막대. rows[{label, values:[...]}], series[{name, color}], max, fmt. 막대 끝에 값을 적는다."""
    p = PAL[mode]
    series, rows = f["series"], f["rows"]
    label_w = f.get("label_width", 280)
    bar_h, gap_in, gap_row = 16, 6, 22
    title_h = 40 if f.get("title") else 0  # 그래프 제목 줄(선택). 그래프 두 장이 이어질 때 구분된다
    top = (50 if len(series) > 1 else 14) + title_h
    vmax = f.get("max", 100)
    fmt = f.get("fmt", "{:.1f}%")
    plot_w = W - label_w - 80
    layers, y = [], top
    if f.get("title"):
        layers.append(Layer("rise", 0.02, eyebrow(2, 18, f["title"], p["muted"], 12.5)))
    if len(series) > 1:
        lx = label_w
        for i, s in enumerate(series):
            c = accent(s["color"], mode) if s.get("color") else p["muted"]  # 막대와 같은 색
            layers.append(Layer("rise", 0.05 + i * 0.06, f'<rect x="{lx}" y="{14 + title_h}" width="12" height="12" rx="3" fill="{c}"/>'
                                + text(lx + 20, 25 + title_h, s["name"], 14, 600, p["ink"])))
            lx += M.width(s["name"], 14, 600) + 48
    for r, row in enumerate(rows):
        n = len(row["values"])
        block = n * bar_h + (n - 1) * gap_in
        lines = M.wrap(row["label"], 15, 600, label_w - 20)
        # 줄 높이 = 막대 묶음과 글자(이름 + 설명) 중 큰 쪽. 글자가 길어도 다음 줄이나 그림 밖으로 넘치지 않게 한다
        text_h = len(lines) * 18 + (17 if row.get("note") else 0)
        row_h = max(block, text_h)
        ly = y + (row_h - text_h) / 2 + 13
        bar_y = y + (row_h - block) / 2
        weight = 800 if row.get("color") else 600
        lab = "".join(text(0, ly + j * 18, line, 15, weight, p["ink"]) for j, line in enumerate(lines))
        if row.get("note"):
            lab += text(0, ly + (len(lines) - 1) * 18 + 17, row["note"], 12.5, 500, p["muted"])
        layers.append(Layer("rise", 0.1 + r * 0.06, lab))
        for i, v in enumerate(row["values"]):
            if v is None:
                continue
            # 줄 색(row.color)이 있으면 그 줄을 강조한다. 없으면 계열 색, 그것도 없으면 흐린 색
            if row.get("color") and len(series) == 1:
                c = accent(row["color"], mode)
            elif series[i].get("color"):
                c = accent(series[i]["color"], mode)
            else:
                c = p["muted"]
            by = bar_y + i * (bar_h + gap_in)
            bw = max(2, v / vmax * plot_w)
            layers.append(Layer("grow", 0.2 + r * 0.06 + i * 0.05,
                                f'<rect x="{label_w}" y="{by:.1f}" width="{bw:.1f}" height="{bar_h}" rx="4" fill="{c}"/>', text=False))
            layers.append(Layer("rise", 0.7 + r * 0.06 + i * 0.05, text(label_w + bw + 8, by + 13, fmt.format(v), 13.5, 700, p["ink"])))
        y += row_h + gap_row
    layers.insert(0, Layer("rise", 0.05, f'<rect x="{label_w}" y="{top - 6}" width="1" height="{y - gap_row - top + 12:.1f}" '
                                         f'fill="{p["line"]}"/>', text=False))
    return Figure(W, round(y - gap_row + 12), layers)


KINDS = {"hero": hero, "tiles": tiles, "label": label, "card": card, "facts": facts,
         "curve": curve, "paper": paper, "bars": bars}


# ── 실행 ─────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser(description="README 본문 그림 만들기")
    ap.add_argument("--spec", default=str(HERE / "visuals.json"))
    ap.add_argument("--preview", action="store_true", help="확인용 PNG 를 임시 폴더에 만든다")
    args = ap.parse_args()
    if not shutil.which("rsvg-convert"):
        sys.exit("rsvg-convert 가 필요합니다 (macOS: brew install librsvg)")
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    out = HERE / spec.get("out_dir", "")
    out.mkdir(exist_ok=True)

    made = []
    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        env = M.fontconfig_env(work)
        for i, fig_spec in enumerate(spec["figures"]):
            kind = KINDS.get(fig_spec["type"])
            if not kind:
                sys.exit(f"그림 종류 '{fig_spec['type']}' 를 모릅니다. {', '.join(KINDS)} 중에서 고릅니다")
            for mode in MODES:
                fig = kind(fig_spec, mode, i)
                path = out / f"{fig_spec['name']}-{mode}.svg"
                path.write_text(compose(f"{fig_spec['name']}-{mode}", fig, work, env), encoding="utf-8")
                made.append(path)
    names = {p.name for p in made}
    for old in out.glob("*-light.svg"):
        if old.name not in names and (out / old.name.replace("-light", "-dark")).exists():
            print(f"설정에 없는 그림이 남아 있습니다: {old.name} (지우려면 직접 지웁니다)")
    print(f"그림 {len(made)}장 ({out.relative_to(HERE.parents[1])})")

    if args.preview:
        pdir = Path(tempfile.mkdtemp(prefix="readme-visuals-"))
        for f in made:
            subprocess.run(["rsvg-convert", "-z", "2", str(f), "-o", str(pdir / f"{f.stem}.png")], check=True)
        print(f"미리보기: {pdir}")


if __name__ == "__main__":
    main()
