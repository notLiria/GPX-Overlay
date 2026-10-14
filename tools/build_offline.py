#!/usr/bin/env python3
"""Build the single-file offline app: dist/gpx-overlay-studio.html.

Inlines style.css, every script (vendor + app), and all fonts as base64
@font-face rules (id="fonts-embed", which capture.js fontFaceCSS() prefers).
The output runs from file:// with no server, no projects/ dir, and no
network (map tiles need network on first view; they cache for later).

Usage:  python tools/build_offline.py
"""
import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
OUT = ROOT / "dist" / "gpx-overlay-studio.html"

FONTS = [
    ("Orbitron", "Orbitron.ttf", 400, "400 900"),
    ("Rajdhani", "Rajdhani-SemiBold.ttf", 600, "600"),
    ("Rajdhani", "Rajdhani-Bold.ttf", 700, "700"),
    ("Inter", "Inter.ttf", 400, "normal"),
    ("DSEG7", "DSEG7Classic.ttf", 400, "normal"),
]

SCRIPTS = [
    "/static/vendor/mp4box.js",
    "/static/vendor/mp4-muxer.js",
    "/static/model.js",
    "/static/capture.js",
    "/static/export_a.js",
    "/static/local.js",
    "/static/app.js",
]


def fonts_css() -> str:
    rules = []
    for fam, fname, wt, csswt in FONTS:
        b64 = base64.b64encode((STATIC / "fonts" / fname).read_bytes()).decode()
        rules.append(
            f"@font-face{{font-family:'{fam}';"
            f"src:url(data:font/ttf;base64,{b64}) format('truetype');"
            f"font-weight:{csswt};}}"
        )
    return "\n".join(rules)


def main() -> None:
    html = (STATIC / "index.html").read_text()

    # inline stylesheet (drop its @font-face blocks — fonts-embed owns fonts)
    css = (STATIC / "style.css").read_text()
    css = re.sub(r"@font-face\s*\{[^}]*\}", "", css)
    html, n = re.subn(
        r'<link rel="stylesheet" href="/static/style\.css(?:\?[^"]*)?">',
        lambda m: "<style>\n" + css + "\n</style>", html, count=1)
    assert n == 1, "missing stylesheet link"

    # inline fonts
    embed = ('<style id="fonts-embed">\n' + fonts_css() + "\n</style>")
    html = html.replace("<style>\n" + css + "\n</style>",
                        embed + "\n<style>\n" + css + "\n</style>")

    # inline scripts in order (allow cache-buster query suffixes)
    for path in SCRIPTS:
        js = (ROOT / path.lstrip("/")).read_text()
        pat = re.compile(r'<script src="' + re.escape(path) + r'(?:\?[^"]*)?"></script>')
        html, n = pat.subn(lambda m: "<script>\n" + js + "\n</script>", html, count=1)
        assert n == 1, f"missing script tag: {path}"

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(html)
    mb = OUT.stat().st_size / 1048576
    print(f"wrote {OUT} ({mb:.1f} MB) — open it directly, no server needed")


if __name__ == "__main__":
    main()
