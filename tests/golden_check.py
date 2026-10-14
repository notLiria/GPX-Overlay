#!/usr/bin/env python3
"""Phase 0: verify golden frames are reproducible.

Re-renders every frozen case and compares sha256 against the manifest.
Deterministic inputs must give byte-identical frames; any drift means the
renderer or inputs changed under us.

Run: python3 tests/golden_check.py
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "golden"
sys.path.insert(0, str(ROOT))
from golden_freeze import render_case  # noqa: E402


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def main():
    manifest = json.loads((GOLDEN / "manifest.json").read_text())
    fails = 0
    for c in manifest["cases"]:
        img = render_case(c["project"], c["w"], c["h"], c["t"])
        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        got = sha256_bytes(buf.getvalue())
        ok = got == c["sha256"]
        print(f"{'PASS' if ok else 'FAIL'}  {c['file']}")
        if not ok:
            fails += 1
            print(f"      expected {c['sha256'][:16]}... got {got[:16]}...")
    total = len(manifest["cases"])
    print(f"\n{total - fails}/{total} golden frames reproduce byte-exactly")
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
