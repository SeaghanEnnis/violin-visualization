"""
Render an .abc file to a PDF of the plain staff notation, for pieces that
don't have a scanned/purchased PDF of their own (see sheets/).

Uses abcjs (the standard ABC -> engraved-notation renderer: proper beams,
slurs, ties, key/time signatures) via a headless Chromium, since our own
hand-rolled matplotlib renderer (visualizer-traditional.py) was never
finished. The output is dropped in sheets/<tune>.pdf, which the Flask app
already picks up automatically for any ABC file with a same-named PDF.

Usage:
    python utilities/abc_to_pdf.py largo
    python utilities/abc_to_pdf.py abc/largo.abc
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT       = Path(__file__).parent.parent
ABC_DIR    = ROOT / "abc"
SHEETS_DIR = ROOT / "sheets"

ABCJS_URL = "https://cdn.jsdelivr.net/npm/abcjs@6.7.1/dist/abcjs-basic-min.js"

# This project's own %%sync / %%syncpage playback-sync directives (see
# sheet_music_reader.py) — abcjs doesn't know them and they carry no
# engraving information, so they're stripped before rendering.
_SYNC_DIRECTIVE_RE = re.compile(r"^%%sync(page)?\b", re.IGNORECASE)

_HTML_TEMPLATE = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script src="{abcjs_url}"></script>
<style>
  body {{ margin: 0; padding: 28px; background: #fff; }}
</style>
</head>
<body>
  <div id="paper"></div>
  <script>
    window.renderDone = false;
    ABCJS.renderAbc("paper", {abc_json}, {{ staffwidth: 680 }});
    window.renderDone = true;
  </script>
</body>
</html>
"""


def resolve_abc_path(arg: str) -> Path:
    p = Path(arg)
    if p.suffix == ".abc" and p.exists():
        return p
    candidate = ABC_DIR / f"{arg}.abc"
    if candidate.exists():
        return candidate
    raise FileNotFoundError(f"Couldn't find an .abc file for '{arg}'")


def render_pdf(abc_path: Path, out_path: Path) -> None:
    abc_text = abc_path.read_text(encoding="utf-8")
    # Blank lines are tune separators in real ABC (unlike our own lenient
    # parser) — a blank line right after the header makes abcjs think the
    # tune ends there with zero notes, so drop them along with our own
    # %%sync directives before handing the text to abcjs.
    abc_text = "\n".join(
        line for line in abc_text.splitlines()
        if line.strip() and not _SYNC_DIRECTIVE_RE.match(line.strip())
    )

    html = _HTML_TEMPLATE.format(abcjs_url=ABCJS_URL, abc_json=json.dumps(abc_text))
    html_path = out_path.with_suffix(".render.html")
    html_path.write_text(html, encoding="utf-8")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(html_path.as_uri())
            page.wait_for_function("window.renderDone === true")
            page.wait_for_timeout(200)  # let SVG layout settle
            out_path.parent.mkdir(parents=True, exist_ok=True)
            page.pdf(path=str(out_path), format="Letter", print_background=True)
            browser.close()
    finally:
        html_path.unlink(missing_ok=True)

    print(f"Wrote {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python utilities/abc_to_pdf.py <name-or-path.abc>")
        sys.exit(1)
    src = resolve_abc_path(sys.argv[1])
    render_pdf(src, SHEETS_DIR / f"{src.stem}.pdf")
