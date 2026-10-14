# GPX Overlay Studio

Local web app that renders telemetry overlays (speed, HR, cadence, elevation,
map, route, charts, and motorsport gauge styles) onto cycling videos using
GPX data. **100% client-side: files are picked in the browser, parsed in the
browser, rendered in the browser, and downloaded from the browser.** No
uploads, no projects/ dir, no server-side rendering.

## Use it offline (recommended)

Open `dist/gpx-overlay-studio.html` — one self-contained file (JS, CSS and
fonts embedded). Works by double-clicking (file://), no server, no network.
Map tiles need network the first time a map widget draws; they cache for
later offline runs.

Rebuild it after changing source:

```sh
python tools/build_offline.py
```

## Serve from the LAN (optional)

```sh
uv run --with fastapi --with "uvicorn[standard]" --with python-multipart \
  --with lxml --with pillow \
  python -m uvicorn app:app --host 0.0.0.0 --port 8765
```

Open `http://<host>:8765/`. The app itself never calls the API; app.py keeps
legacy endpoints for tests and debugging only.

## Layout

- `static/local.js` — in-browser GPX/TCX parsing (namespace-tolerant) and
  video probing (mp4box: fps/rotation/HDR; element: display dims)
- `static/model.js` — canonical value math + `frameState()` frame contract
- `static/capture.js` — capture renderer (DOM builder + Canvas2D painter;
  motorsport gauge `PAINTERS`: tach, ledbar, gearbox, delta, trace, ring,
  pillrow; cached OSM tiles)
- `static/export_a.js` — full client-side export (mp4box demux, WebCodecs
  decode/encode, GLSL composite with exact HLG tone map + container rotation,
  mp4-muxer → Blob download)
- `app.py` / `overlay.py` — legacy server (static host, test/debug API, PIL
  golden-reference compositor)
- `tests/` — golden frame freeze/check + model parity (285 cases)

## Tests

```sh
uv run --with pillow --with lxml python tests/golden_check.py
uv run --with pillow --with lxml python tests/test_model_parity.py
```

