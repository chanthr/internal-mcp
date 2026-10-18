#!/usr/bin/env python3
"""README.md 를 GitHub 변환기로 HTML 로 만들어 브라우저로 연다. 원격에 올리기 전에 모양을 본다.

    python3 .github/assets/preview_readme.py            # 임시 폴더에 만들고 연다
    python3 .github/assets/preview_readme.py --no-open  # 만들기만 한다

GitHub 마크다운 API(gh api markdown)를 쓰므로 gh 로그인이 필요하다. README 내용이 GitHub API 로 전송된다.
화면 모드(밝게, 어둡게)를 바꾸면 그림도 바뀐다. 이슈 양식과 PR 양식은 GitHub 에서만 보인다.
"""

from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

PAGE = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>README 미리보기</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown.min.css">
<style>
 body{margin:0;background:#fff}
 @media (prefers-color-scheme: dark){body{background:#0d1117}}
 .bar{font:13px -apple-system,sans-serif;padding:10px 16px;background:#fff8c5;color:#4d2d00;border-bottom:1px solid #d4a72c}
 .wrap{box-sizing:border-box;max-width:1012px;margin:0 auto;padding:32px 24px 80px}
 .box{border:1px solid #d0d7de;border-radius:6px;padding:32px}
 @media (prefers-color-scheme: dark){.box{border-color:#30363d}}
</style></head><body>
<div class="bar">로컬 미리보기입니다. 원격 저장소와는 상관없습니다. 화면 모드(밝게, 어둡게)를 바꾸면 그림도 바뀝니다.</div>
<div class="wrap"><div class="box"><article class="markdown-body">__BODY__</article></div></div>
<script>
// GitHub 처럼 제목에 아이디를 붙이고 #링크로 이동하게 한다
document.querySelectorAll('.markdown-body h1,.markdown-body h2,.markdown-body h3').forEach(e => {
  const s = e.textContent.trim().toLowerCase().replace(/[^\\p{L}\\p{N}\\s-]/gu, '').replace(/\\s/g, '-');
  if (s) e.id = 'user-content-' + s;
});
function go() {
  const h = decodeURIComponent(location.hash.slice(1)); if (!h) return;
  const el = document.getElementById('user-content-' + h) || document.getElementById(h);
  if (el) el.scrollIntoView();
}
addEventListener('hashchange', go); go();
</script></body></html>"""


def main() -> None:
    ap = argparse.ArgumentParser(description="README 로컬 미리보기")
    ap.add_argument("--readme", default=str(ROOT / "README.md"))
    ap.add_argument("--no-open", action="store_true", help="브라우저를 열지 않는다")
    args = ap.parse_args()

    if not shutil.which("gh"):
        sys.exit("gh 가 필요합니다 (macOS: brew install gh, 그다음 gh auth login)")
    readme = Path(args.readme)
    body = subprocess.run(["gh", "api", "markdown", "-f", "mode=gfm", "-F", f"text=@{readme}"],
                          check=True, capture_output=True, text=True).stdout

    out = Path(tempfile.mkdtemp(prefix="readme-preview-"))
    if (ROOT / ".github/assets").exists():
        shutil.copytree(ROOT / ".github/assets", out / ".github/assets",
                        ignore=shutil.ignore_patterns("fonts", "*.py", "*.json"))
    page = out / "README-preview.html"
    page.write_text(PAGE.replace("__BODY__", body), encoding="utf-8")
    print(page)

    if not args.no_open:
        opener = "open" if platform.system() == "Darwin" else "xdg-open"
        if shutil.which(opener):
            subprocess.run([opener, str(page)], check=False)


if __name__ == "__main__":
    main()
