#!/usr/bin/env python3
"""Phase 0: freeze golden overlay frames from the current renderer.

Renders deterministic overlay layers (overlay.render_overlay) with a
style-covering widget fixture for each real project x time, and records
sha256 hashes in tests/golden/manifest.json.

These frames are the migration's visual reference: the CSS capture renderer
(Phase 1) must reproduce them within tolerance.

Run: python3 tests/golden_freeze.py
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "golden"
FRAMES = GOLDEN / "frames"
sys.path.insert(0, str(ROOT))
import overlay as ov  # noqa: E402

# Mirrors the widget() factory defaults in static/app.js (canonical model).
BASE = dict(
    display=True, margin=12, padding=6, theme="white", font_family="Orbitron",
    unit="", format="", label_size=16, value_size=42, unit_size=18,
    value_weight="bold", label_color="#e8eaf0", value_color="#ffffff",
    unit_color="#ffffffcc", icon_color="#ffffff", primary_color="#ffffff",
    secondary_color="#ffffff55", bg_color="", bg_opacity=0.33,
    round_corner=10, shadow=3, value_align="left", show_label=True,
    show_value=True, show_unit=True, show_icon=False, gauge_width=14,
    gauge_angle=270, gauge_rotation=0, auto_range=True, value_min=0,
    value_max=100, source=1, zoom=13, factor=2, border=3,
    border_color="#000000",
)


def W(wid, typ, x, y, w, h, **over):
    d = dict(BASE, id=wid, type=typ, x=x, y=y, w=w, h=h,
             label=typ.upper() if typ not in ("map", "track", "gpx")
             else {"map": "MAP", "track": "ELEVATION", "gpx": "ROUTE"}[typ],
             style="" if typ in ("map", "track", "gpx") else "text")
    d.update(over)
    return d


def fixture(Wp, Hp):
    """Style-covering widget set: every style, key types, unit variants.
    Laid out as a tidy non-overlapping board so the frame is reviewable."""
    return [
        W("f1", "speed", 20, 20, 300, 100, label="KPH"),
        W("f2", "speed", 20, 130, 240, 240, style="arc", label="KPH", unit="kph"),
        W("f3", "speed", 280, 130, 240, 240, style="arc", label="MPH", unit="mph"),
        W("f4", "heartrate", 560, 130, 300, 100, style="big", unit="bpm"),
        W("f5", "cadence", 560, 240, 300, 90, style="bar", unit="trpermin"),
        W("f6", "elevation", 900, 130, 120, 300, style="barv", unit="m"),
        W("f7", "distance", 20, 400, 300, 90, unit="km"),
        W("f8", "distance", 20, 500, 300, 90, unit="miles"),
        W("f9", "duration", 340, 400, 300, 90),
        W("f10", "time", 340, 500, 300, 90),
        W("f11", "grade", 660, 450, 300, 90, unit="percent"),
        W("f12", "verticalspeed", 660, 550, 300, 90, style="bar",
          unit="meterperhour"),
        W("f13", "avgspeed", 20, 600, 300, 90, unit="kph"),
        W("f14", "gpx", 20, 720, 420, 160, gauge_width=5),
        W("f15", "track", 20, 910, Wp - 40, 180),
        W("f16", "map", Wp - 340, Hp - 360, 320, 320),
    ]


CASES = [
    ("9ce4e775fa81", 1080, 1920, [1.0, 3.75, 6.5]),
    ("8196117eec07", 1080, 1920, [1.0, 3.75]),
    ("0b47ca38a6da", 720, 1280, [2.0, 5.0]),
]


def render_case(pid, Wp, Hp, t):
    tel = ov.Telemetry(json.loads(
        (ROOT / "projects" / pid / "telemetry.json").read_text()))
    return ov.render_overlay(Wp, Hp, fixture(Wp, Hp), tel, t)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    FRAMES.mkdir(parents=True, exist_ok=True)
    manifest = {"cases": []}
    for pid, Wp, Hp, times in CASES:
        if not (ROOT / "projects" / pid / "telemetry.json").exists():
            print(f"[skip] {pid}: no telemetry.json")
            continue
        for t in times:
            img = render_case(pid, Wp, Hp, t)
            name = f"{pid}_t{t:.2f}.png"
            img.save(FRAMES / name)
            manifest["cases"].append({
                "project": pid, "w": Wp, "h": Hp, "t": t,
                "file": name, "sha256": sha256(FRAMES / name),
            })
            print(f"froze {name}  ({img.size[0]}x{img.size[1]})")
    (GOLDEN / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"\ngolden frames frozen: {len(manifest['cases'])} frames in tests/golden/frames/")


if __name__ == "__main__":
    main()
