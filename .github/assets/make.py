#!/usr/bin/env python3
"""README 그림(배너, 작업 흐름도, 배지)을 readme-art.json 하나로 만든다.

문구는 readme-art.json(영어판)과 readme-art.ko.json(한국어판, ko/ 에 출력)에서만 바꾼다.

    python3 .github/assets/make.py --spec .github/assets/readme-art.ko.json   # 한국어판 그림

    python3 .github/assets/make.py             # .github/assets/*.svg 를 다시 만든다
    python3 .github/assets/make.py --preview   # 확인용 PNG 를 임시 폴더에 함께 만든다

글자는 rsvg-convert 로 윤곽선(path)으로 바꿔 넣는다. 보는 사람 컴퓨터에 글꼴이 없어도 같은 모양으로 보인다.
글꼴은 같은 폴더의 fonts/ (Freesentation, SIL OFL 1.1)를 쓴다. 따로 설치하지 않아도 된다.
배너와 흐름도는 GitHub 밝은 화면용(-light)과 어두운 화면용(-dark) 두 벌을 만든다.

필요한 것: rsvg-convert (macOS: brew install librsvg), Pillow (pip install pillow).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from html import escape
from pathlib import Path

try:
    from PIL import Image, ImageFont
except ImportError:
    sys.exit("Pillow 가 필요합니다: pip install pillow")

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

THEMES = {
    "light": {
        "bg": "#F6F6F4", "glow": "#FFFFFF", "border": "#E6E6E2",
        "ink": "#111111", "sub": "#5F6368", "muted": "#9AA0A6",
        "card": "#FFFFFF", "card_line": "#E3E3DF", "arrow": "#BFC3C8",
        "chip_solid": "#111111", "chip_solid_ink": "#FFFFFF",
        "chip_line": "#C8CBD0", "chip_soft": "#EEEEEA",
    },
    "dark": {
        "bg": "#15171A", "glow": "#20242A", "border": "#272B31",
        "ink": "#F2F3F5", "sub": "#A3A9B2", "muted": "#6F7781",
        "card": "#1A1D21", "card_line": "#2E3238", "arrow": "#4B515A",
        "chip_solid": "#F2F3F5", "chip_solid_ink": "#111111",
        "chip_line": "#4A5059", "chip_soft": "#2A2E34",
    },
}

BANNER_W, BANNER_H = 1000, 260
FLOW_W = 1000


# ── 설정 읽기 ────────────────────────────────────────────────────
def load_spec(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"{path} 가 없습니다. readme-art.json 을 참고해 만들어 주세요")
    spec = json.loads(path.read_text(encoding="utf-8"))
    errors = []
    for key in ("title", "subtitle"):
        if not str(spec.get(key, "")).strip():
            errors.append(f"{key} 가 비었습니다")
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


def width(s: str, size: int, weight: int, spacing: float = 0) -> float:
    key = (size, weight)
    if key not in _fonts:
        path = FONT_DIR / FONT_FILES[weight]
        if not path.exists():
            sys.exit(f"글꼴 파일이 없습니다: {path}")
        _fonts[key] = ImageFont.truetype(str(path), size)
    return _fonts[key].getlength(s) + spacing * max(len(s) - 1, 0)


def wrap(s: str, size: int, weight: int, max_w: float) -> list[str]:
    lines: list[str] = []
    # 보통 공백에서만 나눈다. str.split() 은 줄바꿈 없는 공백( )까지 나눠 "Claude Code" 가 갈라진다
    for word in (w for w in s.split(" ") if w):
        if lines and width(lines[-1] + " " + word, size, weight) <= max_w:
            lines[-1] += " " + word
        else:
            lines.append(word)
    return lines


# ── SVG 조각 ─────────────────────────────────────────────────────
def text(x: float, y: float, s: str, size: int, weight: int, fill: str,
         anchor: str = "start", spacing: float = 0) -> str:
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}" letter-spacing="{spacing}">{escape(s)}</text>')


def svg(w: float, h: float, body: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{w:.0f}" height="{h:.0f}" viewBox="0 0 {w:.0f} {h:.0f}">{body}</svg>')


# ── 배너 ─────────────────────────────────────────────────────────
def banner(spec: dict, t: dict[str, str]) -> str:
    w, h = BANNER_W, BANNER_H
    title, subtitle = spec["title"], spec["subtitle"]
    title_size = 54
    while width(title, title_size, 800, -1.5) > w - 160:
        title_size -= 1
    sub_size = 20
    while width(subtitle, sub_size, 500) > w - 120:
        sub_size -= 1
    if sub_size < 17:
        sys.exit(f"subtitle 이 너무 깁니다. 한 줄 45자 안으로 줄여 주세요: {subtitle}")
    # 제목 위 작은 글자 줄(eyebrow). 없으면 비워 둔다
    top = text(w / 2, 72, spec["eyebrow"], 14, 700, t["muted"], "middle", 3) if spec.get("eyebrow") else ""
    body = (
        '<defs><radialGradient id="g" cx="50%" cy="0%" r="75%">'
        f'<stop offset="0" stop-color="{t["glow"]}"/><stop offset="1" stop-color="{t["bg"]}"/>'
        '</radialGradient></defs>'
        f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="20" fill="url(#g)" stroke="{t["border"]}"/>'
        + top
        + text(w / 2, 162, title, title_size, 800, t["ink"], "middle", -1.5)
        + text(w / 2, 208, subtitle, sub_size, 500, t["sub"], "middle")
    )
    return svg(w, h, body)


# ── 작업 흐름도 ──────────────────────────────────────────────────
def chip_styles(steps: list[dict]) -> dict[str, str]:
    """처음 나온 주체는 꽉 찬 칩, 두 번째는 테두리 칩, 그 밖과 '함께'는 옅은 칩."""
    styles: dict[str, str] = {}
    order = ["solid", "line"]
    for s in steps:
        who = s["who"]
        if who in styles:
            continue
        styles[who] = s.get("chip") or ("soft" if who == "함께" or not order else order.pop(0))
    return styles


def chip(x_right: float, y: float, who: str, style: str, t: dict[str, str]) -> str:
    size, weight = 13, 600
    cw, ch = width(who, size, weight) + 20, 24
    x = x_right - cw
    fill, line, ink = {
        "solid": (t["chip_solid"], t["chip_solid"], t["chip_solid_ink"]),
        "line": (t["card"], t["chip_line"], t["ink"]),
    }.get(style, (t["chip_soft"], t["chip_soft"], t["ink"]))
    return (f'<rect x="{x:.1f}" y="{y:.1f}" width="{cw:.1f}" height="{ch}" rx="12" fill="{fill}" stroke="{line}"/>'
            + text(x + cw / 2, y + 16.5, who, size, weight, ink, "middle"))


def flow(steps: list[dict], t: dict[str, str]) -> str:
    n, pad = len(steps), 18
    gap = 30 if n >= 5 else 36
    cw = (FLOW_W - gap * (n - 1)) / n
    inner = cw - pad * 2
    desc_size, line_h = 15, 23
    wrapped = [wrap(s["desc"], desc_size, 500, inner) for s in steps]
    if max(len(x) for x in wrapped) > 4:
        sys.exit("steps 의 desc 가 너무 깁니다. 카드에서 네 줄을 넘지 않게 줄여 주세요")
    styles = chip_styles(steps)
    ch = 108 + (max(len(x) for x in wrapped) - 1) * line_h + pad + 4
    parts = []
    for i, (s, lines) in enumerate(zip(steps, wrapped)):
        x = i * (cw + gap)
        parts.append(f'<rect x="{x + 0.5:.1f}" y="1" width="{cw - 1:.1f}" height="{ch:.1f}" rx="14" '
                     f'fill="{t["card"]}" stroke="{t["card_line"]}"/>')
        parts.append(text(x + pad, 36, f"{i + 1:02d}", 15, 700, t["muted"]))
        parts.append(chip(x + cw - pad, 18, s["who"], styles[s["who"]], t))
        title_size = 21
        while width(s["title"], title_size, 800, -0.4) > inner:
            title_size -= 1
        parts.append(text(x + pad, 78, s["title"], title_size, 800, t["ink"], spacing=-0.4))
        for j, line in enumerate(lines):
            parts.append(text(x + pad, 108 + j * line_h, line, desc_size, 500, t["sub"]))
        if i < n - 1:
            ax, ay = x + cw + gap / 2, 1 + ch / 2
            parts.append(f'<path d="M {ax - 3:.1f} {ay - 7:.1f} L {ax + 4:.1f} {ay:.1f} L {ax - 3:.1f} {ay + 7:.1f}" '
                         f'fill="none" stroke="{t["arrow"]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')
    return svg(FLOW_W, ch + 2, "".join(parts))


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


def outline(src_svg: str, out: Path, work: Path, env: dict[str, str]) -> None:
    src = work / (out.stem + ".src.svg")
    src.write_text(src_svg, encoding="utf-8")
    subprocess.run(["rsvg-convert", "-f", "svg", str(src), "-o", str(out)], check=True, env=env)


def preview(names: list[str], out_dir: Path) -> Path:
    pdir = Path(tempfile.mkdtemp(prefix="readme-art-"))
    for name in names:
        subprocess.run(["rsvg-convert", "-z", "2", str(out_dir / f"{name}.svg"), "-o", str(pdir / f"{name}.png")], check=True)
    # GitHub 밝은 바탕과 어두운 바탕에 얹은 한 장짜리 화면
    badges = [Image.open(pdir / f"{n}.png").convert("RGBA") for n in names if n.startswith("badge-")]
    for theme, bg in (("light", (255, 255, 255)), ("dark", (13, 17, 23))):
        parts = [Image.open(pdir / f"banner-{theme}.png").convert("RGBA")]
        flow_png = pdir / f"flow-{theme}.png"
        w = parts[0].width + 80
        bh = max((b.height for b in badges), default=0)
        h = 40 + parts[0].height + (30 + bh if badges else 0) + 60
        if flow_png.exists():
            fl = Image.open(flow_png).convert("RGBA")
            h += fl.height + 40
        page = Image.new("RGBA", (w, h), bg + (255,))
        page.alpha_composite(parts[0], (40, 40))
        y = 40 + parts[0].height + 30
        if badges:
            x = (w - sum(b.width for b in badges) - 12 * (len(badges) - 1)) // 2
            for b in badges:
                page.alpha_composite(b, (x, y))
                x += b.width + 12
            y += bh + 60
        if flow_png.exists():
            page.alpha_composite(fl, (40, y))
        page.convert("RGB").save(pdir / f"page-{theme}.png")
    return pdir


def main() -> None:
    ap = argparse.ArgumentParser(description="README 그림 만들기")
    ap.add_argument("--spec", default=str(HERE / "readme-art.json"), help="설정 파일. 기본 .github/assets/readme-art.json")
    ap.add_argument("--preview", action="store_true", help="확인용 PNG 를 임시 폴더에 만든다")
    args = ap.parse_args()

    if not shutil.which("rsvg-convert"):
        sys.exit("rsvg-convert 가 필요합니다 (macOS: brew install librsvg)")
    spec = load_spec(Path(args.spec))
    steps = spec.get("steps") or []
    badges = spec.get("badges") or []

    # 이 저장소 사본만의 변경: out_dir 이 있으면 그 하위 폴더에 만든다 (한국어판 그림은 ko/)
    out_dir = HERE / spec.get("out_dir", "")
    out_dir.mkdir(exist_ok=True)
    rel = out_dir.relative_to(HERE.parents[1]).as_posix()

    jobs: dict[str, str] = {}
    for name, theme in THEMES.items():
        jobs[f"banner-{name}"] = banner(spec, theme)
        if steps:
            jobs[f"flow-{name}"] = flow(steps, theme)
    for b in badges:
        jobs[b["file"]] = badge(b)

    # 설정에서 빠진 그림은 지운다 (이름이 바뀐 배지, 흐름도를 뺀 경우)
    for old in list(out_dir.glob("badge-*.svg")) + list(out_dir.glob("flow-*.svg")):
        if old.stem not in jobs:
            old.unlink()
            print(f"지움: {rel}/{old.name}")

    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        env = fontconfig_env(work)
        for name, source in jobs.items():
            outline(source, out_dir / f"{name}.svg", work, env)
            print(f"{rel}/{name}.svg")

    if args.preview:
        print(f"미리보기: {preview(list(jobs), out_dir)}")


if __name__ == "__main__":
    main()
