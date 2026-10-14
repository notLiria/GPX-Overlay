# GPX Overlay Studio

Local web app that renders telemetry overlays (speed, HR, cadence, elevation,
map, route, charts, and motorsport gauge styles) onto cycling videos using
GPX data. Runs on the LAN with no auth.

## Run

```sh
uv run --with fastapi --with "uvicorn[standard]" --with python-multipart \
  --with lxml --with pillow \
  python -m uvicorn app:app --host 0.0.0.0 --port 8765
```

Open `http://<host>:8765/`.

## Layout

- `app.py` — FastAPI backend (uploads, telemetry, render jobs, mux)
- `overlay.py` — server-side PIL compositor (classic styles; golden reference)
- `static/model.js` — canonical value math + `frameState()` frame contract
- `static/capture.js` — client capture renderer (DOM builder + Canvas2D
  painter; motorsport gauge `PAINTERS`: tach, ledbar, gearbox, delta, trace,
  ring, pillrow)
- `static/export_a.js` — fully client-side export (WebCodecs demux/decode,
  GLSL composite with exact HLG tone map + rotation, encode, mux)
- `tests/` — golden frame freeze/check + model parity (285 cases)

## Render targets

- **this device (client)** — client capture + server mux (default)
- **this device — full offline** — entire pipeline in the browser (WebCodecs)
- **server** — server PIL compositor (classic styles only)

## Tests

```sh
uv run --with pillow --with lxml python tests/golden_check.py
uv run --with pillow --with lxml python tests/test_model_parity.py
```
