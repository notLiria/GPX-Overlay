#!/usr/bin/env python3
"""Phase 0: model parity + golden value freeze.

The canonical value math is static/model.js (JS). This script:
  1. computes golden values with node + Model (canonical),
  2. computes the same grid with overlay.Telemetry (the Python mirror),
  3. fails on any divergence,
  4. freezes tests/golden/values.json.

Run: python3 tests/test_model_parity.py
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "golden"
sys.path.insert(0, str(ROOT))
import overlay as ov  # noqa: E402

# Widget grid: every value type x relevant unit variants.
GRID = []
for typ, units in [
    ("speed", ["kph", "mph", "mps"]),
    ("avgspeed", ["kph"]),
    ("maxspeed", ["mph"]),
    ("heartrate", ["bpm"]),
    ("cadence", ["trpermin"]),
    ("elevation", ["m", "ft"]),
    ("distance", ["km", "miles"]),
    ("duration", [""]),
    ("time", [""]),
    ("grade", ["percent"]),
    ("verticalspeed", ["meterperhour", "feetpermin"]),
    ("temperature", ["C", "F"]),
    ("power", ["watt"]),
]:
    for u in units:
        GRID.append({"type": typ, "unit": u, "auto_range": True,
                     "value_min": 0, "value_max": 100})

PROJECTS = ["9ce4e775fa81", "8196117eec07", "0b47ca38a6da"]
TIMES = [0.0, 1.0, 3.75, 6.5, 99.0]


def load_tel(pid):
    return json.loads((ROOT / "projects" / pid / "telemetry.json").read_text())


def js_values(cases):
    """Canonical golden values from static/model.js via node."""
    script = r"""
const Model = require(process.argv[2]);
const fs = require('fs');
const cases = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = [];
for (const c of cases) {
  const tel = JSON.parse(fs.readFileSync(c.telPath, 'utf8'));
  out.push(Model.fmtVal(c.w, c.t, tel));
}
process.stdout.write(JSON.stringify(out));
"""
    case_file = GOLDEN / "_cases.json"
    case_file.write_text(json.dumps(cases))
    js_file = GOLDEN / "_parity.js"
    js_file.write_text(script)
    res = subprocess.run(
        ["node", str(js_file), str(ROOT / "static" / "model.js"), str(case_file)],
        capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        raise SystemExit(f"node failed: {res.stderr}")
    return json.loads(res.stdout)


def main():
    GOLDEN.mkdir(parents=True, exist_ok=True)
    cases, py_expect = [], []
    for pid in PROJECTS:
        tel_path = ROOT / "projects" / pid / "telemetry.json"
        if not tel_path.exists():
            print(f"[skip] {pid}: no telemetry.json")
            continue
        tel = load_tel(pid)
        for t in TIMES:
            for w in GRID:
                cases.append({"telPath": str(tel_path), "w": w, "t": t})
                py_expect.append(ov.Telemetry(tel).value(w, t))

    js_out = js_values(cases)
    fails = [(c, j, p) for c, j, p in zip(cases, js_out, py_expect) if j != p]

    golden = {
        "projects": PROJECTS,
        "times": TIMES,
        "grid": GRID,
        "values": js_out,
    }
    (GOLDEN / "values.json").write_text(json.dumps(golden, indent=1))

    print(f"grid: {len(cases)} cases "
          f"({len(PROJECTS)} projects x {len(TIMES)} times x {len(GRID)} widgets)")
    if fails:
        print(f"PARITY FAIL: {len(fails)} divergences (JS canonical vs Python mirror)")
        for c, j, p in fails[:15]:
            print(f"  t={c['t']} {c['w']['type']}/{c['w']['unit']}: js={j!r} py={p!r}")
        print("\nPython mirror must be fixed to match static/model.js (canonical).")
        raise SystemExit(1)
    print("PARITY OK: Python mirror matches static/model.js on the full grid")
    print(f"golden values frozen: tests/golden/values.json ({len(js_out)} values)")


if __name__ == "__main__":
    main()
