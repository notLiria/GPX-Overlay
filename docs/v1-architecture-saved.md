---
title: "GPX Overlay Studio: Client-Side Rendering Architecture"
subtitle: "Migration plan from server-side PIL/ffmpeg rendering to WebGPU-accelerated in-browser rendering"
author: "Prepared for Liria / fhu"
date: 2026-10-13
extrameta:
  - "Architecture only - no implementation in this document"
  - "Current system state verified as of 2026-10-13"
---

# Executive Summary

GPX Overlay Studio renders telemetry overlays today on the server: a Python
compositor draws every widget per frame, and ffmpeg burns them into the video.
This document architects the migration of that rendering to the browser, using
WebGPU where available. Nothing in the current system changes yet; this is the
plan.

The core recommendation is a **renderer interface with three interchangeable
backends**, so the widget model never changes and preview/export parity becomes
structural rather than aspirational:

1. **Canvas2D renderer (client)** - a direct port of the existing compositor
   logic to OffscreenCanvas. Simple, universally supported, already
   preview-shaped code. This alone enables client-side export.
2. **WebGPU renderer (client)** - the same widget model drawn with GPU
   pipelines and shaders. This is an *acceleration and quality* layer, not a
   correctness requirement: it unlocks 4K/60 export, crisp vector gauges at any
   scale, and hardware HDR tone mapping.
3. **Server renderer (existing)** - kept as the compatibility path and fallback
   for browsers without WebCodecs.

The pragmatic sequencing that de-risks the whole migration: **build the export
path on Canvas2D + WebCodecs first** (days, not weeks), then swap the drawing
backend to WebGPU behind the same interface. The server keeps one slim role:
audio muxing in v1, optional fallback rendering, and file storage.

The single biggest engineering risk is not the GPU work; it is the **media
plumbing**: demuxing MP4 in the browser (mp4box.js), feeding WebCodecs decoders
and encoders, and muxing the result back into an MP4 file. That risk gets its
own early spike in Phase 2.

# Goals and Non-Goals

## Goals

- **Pixel parity by construction.** Preview and export run the same renderer
  over the same model. Today the DOM preview and the server compositor are two
  implementations that must be kept in agreement by hand.
- **Interactive preview.** Scrubbing, style changes, and drags repaint instantly
  at full quality - no server round-trip, no "pixel preview" button needed.
- **Client-side export.** The finished MP4 is produced in the browser, on the
  user's GPU and hardware encoder, and downloaded directly. The server stops
  being the render farm.
- **Better quality ceiling.** WebGPU passes can draw arcs, bars, and text as
  resolution-independent vectors; the current raster compositor is limited by
  its per-frame CPU drawing.
- **Keep the model stable.** The layout state JSON (widgets, styles, themes,
  positions) and the telemetry structure are unchanged. The renderer is the
  only thing that moves.

## Non-Goals

- No change to the editing UX, widget vocabulary, or preset system.
- No real-time playback rendering (overlay burned into a live playing video as
  a filter). Export and paused-frame preview only. This can be revisited later;
  the renderer design does not preclude it.
- No mobile-app work; the browser is the platform.
- No removal of the server in this migration. The server-rendered path remains
  until client rendering is proven against it.

# Current Architecture

The system as it stands after the 2026-10-13 iteration:

- **Ingest** (`app.py`): video saved as uploaded; probe records display
  dimensions (rotation-aware), HDR flag, size, bitrate; GPX is normalized to a
  canonical form and parsed into `telemetry.json` (points with time, lat, lon,
  elevation, HR, speed, grade, cumulative distance).
- **Model**: layout state JSON lives in the browser (`app.js`) - widget list
  with type, style (text, big number, arc, bar, bar vertical), theme colors,
  geometry, and appearance flags. Preview math (`sampleAt`, `fmtVal`,
  `rangeFor`) is implemented in JavaScript for the preview and mirrored in
  Python (`overlay.py`) for rendering. This duplication is the parity problem.
- **Render** (`overlay.py` + ffmpeg): per frame, Python draws all widgets onto
  a transparent RGBA layer with Pillow (gauges via arc primitives, text with
  TrueType, map via cached OpenStreetMap tiles), pipes the layer sequence into
  ffmpeg, which overlays it on the source video and encodes H.264 at CRF 15.
  HDR source material is tone-mapped and graded inside the same single encode.
- **Preview**: the editor shows a `<video>` under DOM/Canvas mockups of the
  widgets; a "pixel preview" endpoint renders one true frame server-side.

Two generations of truth for the widget math, two drawing implementations, a
server round trip for every preview, and a CPU-bound render farm are the
frictions this migration removes.

# Target Architecture

```
+--------------------------- BROWSER ----------------------------+
|                                                                |
|  Model (unchanged)                                             |
|  - layout state JSON     - telemetry points (parsed locally)   |
|  - value math (sampleAt / fmtVal / rangeFor) -- ONE copy        |
|                                                                |
|  Renderer interface: renderFrame(ctx, widgets, telemetry, t)    |
|       |                       |                    |           |
|  Canvas2DRenderer      GpuRenderer (WebGPU)   (future)          |
|  - OffscreenCanvas     - WGSL pipelines        effects          |
|  - 2D primitives       - glyph atlas (SDF)                     |
|                        - tone-map shader                       |
|       |                       |                                |
|  Export pipeline: VideoDecoder --> render --> VideoEncoder      |
|  (WebCodecs + mp4box.js demux, mp4-muxer container)             |
|                                                                |
|  Preview = the same renderer on a <canvas> at time t            |
+----------------------------------------------------------------+
            |                              ^
            v (uploads, fallback)          | tiles (CORS cache)
+--------------------------- SERVER -----------------------------+
|  file store + GPX parse   |  audio mux helper (v1)              |
|  optional: fallback render (existing pipeline, kept)            |
+---------------------------------------------------------------+
```

## Component responsibilities

**Model layer.** Owns the widget list, telemetry, and value mathematics. It is
already mostly client-side. The one migration task is to *delete the Python
mirror*: the JS implementation becomes the single definition, and the server
renderer (while it lives) consumes a rendered layer stream from the client or
stays frozen at its current feature set.

**Renderer interface.** One method family: draw all visible widgets for time
`t` into a target (canvas or texture). Inputs are the model plus a `MediaFrame`
(whatever the video backend hands over). Both preview and export call this.

**Canvas2DRenderer.** A line-for-line port of `overlay.py` to OffscreenCanvas
drawing calls. Pillow arc, rounded-rectangle, and text primitives all have
direct 2D canvas equivalents. This backend requires no GPU features and works
everywhere WebCodecs does.

**GpuRenderer.** Widget types become GPU pipelines over an RGBA target:

- *Arc gauge*: a signed-distance-field ring fragment shader - distance to a
  circle, masked by sweep angle, rounded caps, track color and value color
  blended by the value fraction. One draw per widget, resolution independent.
- *Bars*: rounded-rectangle SDF track plus fill, same shader family.
- *Text and big numbers*: glyph atlas rendered once per (font, size) from an
  OffscreenCanvas, uploaded as a texture, drawn as SDF or premultiplied quads
  with a soft shadow pass. Values are formatted on the CPU (same code as
  preview) and only the glyphs go to the GPU.
- *Track / route / map*: route polyline and elevation area are tessellated once
  per model change (stroke expansion and triangulation on the CPU), then drawn
  as static geometry with a moving marker; map tiles are blitted from a tile
  atlas texture fetched client-side.

**Export pipeline.** MP4 in, MP4 out, entirely in the tab: demux with
mp4box.js, decode with WebCodecs `VideoDecoder`, draw each `VideoFrame` into
the renderer as an external texture (or through `copyExternalImageToTexture`
for the Canvas2D path via `VideoFrame` from canvas), encode with
`VideoEncoder`, mux with mp4-muxer. Progress is frames-in over
frames-total; cancellation aborts the decode loop.

**Server (post-migration).** File storage and validation, GPX parsing (or pure
client parsing with the server as dumb store), audio muxing in v1 (the client
renders a silent overlay video; the server muxes the original audio track with
one ffmpeg call), and the existing renderer as an explicit fallback button.

# The Rendering Core

## Color and HDR

The current tuned HLG-to-SDR chain (linearize, hable tone map, BT.709 matrix,
contrast 1.32, saturation 1.45, brightness -0.09, gamma 0.93) is a known-good
recipe measured against our source material. It ports directly to a WGSL
fragment shader applied when importing each `VideoFrame`: read YUV (or let
WebCodecs deliver RGBA with color-space metadata), convert, tone map, grade.
Golden-frame tests (Phase 0) pin the shader to the server output within a small
PSNR tolerance. The same shader also guarantees the preview shows final colors
instead of raw HLG.

## Text strategy

Text is the only widget family with no natural GPU primitive. The plan is
two-stage: stage one draws text through a per-frame OffscreenCanvas layer that
is composited as a texture (identical output to today, near-zero risk); stage
two replaces it with an SDF glyph atlas for crisper scaling and lower per-frame
cost. Stage two is polish, and the architecture does not depend on it.

## Preview and export share one path

Preview repaint calls `renderFrame` into a visible canvas at scrub time. Export
calls the same `renderFrame` into an offscreen target per decoded frame. The
former "pixel preview" button becomes unnecessary; the preview *is* the render.

# Media Pipeline

This is the riskiest subsystem and gets a dedicated spike.

- **Demux**: mp4box.js reads the MP4 progressively and emits encoded chunks
  with timestamps. A keyframe index enables seeking for preview scrubbing.
- **Decode**: `VideoDecoder` produces `VideoFrame` objects. For export the
  stream is decoded sequentially (frame-exact). For preview seeks, decode from
  the nearest keyframe and drop frames until the target time - standard
  behavior, fine for an editing canvas.
- **Encode**: `VideoEncoder` with H.264 (hardware) where supported, else VP9 or
  AV1. Codec support must be probed with `VideoEncoder.isConfigSupported` and
  the pipeline falls back accordingly.
- **Mux**: mp4-muxer writes the container. The video track is complete in v1;
  audio is handled by the server muxing the source audio (single ffmpeg remux,
  no re-encode). A later phase can carry audio through `AudioData` and
  `AudioEncoder` for fully offline export.
- **Memory**: frames flow through the pipeline and are released; nothing holds
  the whole decode. The overlay layer is one reused texture.

# Map Tiles and Telemetry

- **Tiles**: fetched in the browser from the same OpenStreetMap sources, stored
  in the Cache API, assembled with the same Web-Mercator projection code that
  `overlay.py` uses (the math ports directly). OSM tile policy is respected by
  keeping tile counts small, caching aggressively, and keeping attribution in
  the render. An optional server tile proxy can be added if policy or CORS
  becomes a problem; OpenStreetMap tiles currently serve CORS headers.
- **Telemetry**: parsing moves to the browser (GPX is small; DOMParser plus the
  same normalization rules). The server keeps a parse endpoint as fallback and
  to serve the existing renderer. The value-math module is shared verbatim
  between preview and renderer.

# Migration Phases

Each phase has an explicit exit criterion; nothing proceeds on vibes.

**Phase 0 - Unify the model (preparation).**
Extract the widget model and value math into one shared TypeScript module;
define the `Renderer` interface; freeze a golden test set: N frames from real
projects, rendered by the current server pipeline, with reference PNGs and
per-widget value assertions. Exit: golden set committed, server output
reproducible.

**Phase 1 - Canvas2D renderer on the client.**
Port `overlay.py` to the interface. Wire the editor preview to it (full-quality
repaint on every change). Exit: side-by-side frames match the golden set within
tolerance and the preview is pixel-true with the server offline.

**Phase 2 - Media spike (the risk burn-down).**
Demux-decode-render-encode-mux round trip in the browser for one short clip,
no widgets. Exit: a client-produced MP4 plays correctly with correct duration,
framing, and color. This phase answers the loud questions (codec support matrix,
seek behavior, memory profile) before UI work depends on them.

**Phase 3 - Client export on Canvas2D.**
Full export with widgets, progress UI, cancellation, and server audio mux.
Exit: an exported clip is byte-for-byte sane (PSNR-checked against the server
render) and Liria signs off on quality and speed on her machine.

**Phase 4 - WebGPU renderer.**
Implement the GpuRenderer behind the same interface: tone-map shader first,
then arc/bar geometry, then glyph atlas. Preview switches automatically since
it consumes the interface. Exit: golden frames match within tolerance at 4K
and 1080p, export wall-clock beats the Canvas2D path measurably.

**Phase 5 - Cutover and fallback.**
Feature detection routes browsers: WebGPU when available, Canvas2D otherwise,
server render as a manual fallback button. Telemetry parsing client-side.
Exit: the server render path is unreferenced in the default flow and can be
archived.

# Risks and Mitigations

| Risk | Impact | Mitigation |
| - | - | - |
| WebCodecs codec support varies by browser (H.264 encode especially) | Export unavailable for some users | Probe at startup; fall back to VP9/AV1; Canvas2D+server-mux hybrid; keep server render button |
| Media pipeline is the unknown unknowns | Schedule slip | Phase 2 spike before any UI depends on it; time-boxed with explicit exit criterion |
| Color drift between shader tone map and server output | Preview lies about final colors | Golden-frame PSNR tests in CI; port the exact tuned constants |
| WebGPU not available (older Safari/Firefox) | Feature gap | Canvas2D renderer is the baseline everywhere; WebGPU is acceleration only |
| Text quality on GPU (blurry glyphs) | Visual regression | Stage-one OffscreenCanvas text keeps today's output; SDF atlas is optional polish |
| OSM tile policy or CORS change | Map widget breaks | Cache-first; server tile proxy as fallback; attribution always drawn |
| Long exports on mobile hardware (thermals, memory) | User-visible failure | Streaming pipeline with bounded memory; advisory duration limits; server fallback |
| Preview/export divergence if two code paths linger | Trust erosion | One renderer interface, two backends, one model - divergence becomes structurally impossible |

# Alternatives Considered

| Option | Verdict | Why |
| - | - | - |
| ffmpeg.wasm (whole render in WASM) | Rejected as primary, kept as curiosity | Same filter semantics for free, but CPU-bound WASM, 5-20x slower, 4K impractical |
| Canvas2D-only, no WebGPU | Adopted as Phase 1-3 path | Most of the win, a fraction of the risk; WebGPU then layers in |
| Keep server render, client preview only | Rejected | Leaves the parity problem and the render farm in place; adopted only as fallback |
| WebGPU-first, skip Canvas2D export | Rejected | Couples the schedule to the riskiest work; the interface makes the reorder cheap later |
| Real-time overlay during playback (MediaStream) | Deferred | Different product surface; architecture does not block it later |

# Open Questions for Review

1. **Audio in v1**: is a server-side audio mux acceptable for the first
   client-rendered exports (one extra server call per export), or is fully
   offline export (WebCodecs AudioEncoder) a launch requirement?
2. **Fallback priority**: for browsers without WebCodecs, is a
   server-rendered export acceptable, or should we invest in an
   ffmpeg.wasm fallback?
3. **Quality bar**: are the current CRF 15 server encodes the target to match,
   or should client export default to a higher-quality master (CRF-equivalent
   ~12-14, larger files)?
4. **4K support**: is 4K/60 export a real requirement (drives WebGPU priority
   and encoder choices), or is 1080p the sweet spot for social clips?

# Rough Effort Estimate

Estimates are for focused implementation time, not calendar elapsed.

| Phase | Scope | Estimate |
| - | - | - |
| Phase 0 | Model unification, renderer interface, golden tests | 1-2 days |
| Phase 1 | Canvas2D renderer and client preview | 2-3 days |
| Phase 2 | Media spike: demux, decode, encode, mux | 2-3 days |
| Phase 3 | Client export with progress, cancellation, audio mux | 2-3 days |
| Phase 4 | WebGPU renderer (tone map, gauges, glyphs) | 3-5 days |
| Phase 5 | Feature detection, cutover, fallback polish | 1-2 days |
| **Total** | | **11-18 days** |

The critical path runs through Phase 2. If the media spike reveals a hard
blocker (for example, no viable encoder on a target browser), the fallback
position is Canvas2D rendering with server-side final encode - which still
delivers the parity and preview wins while keeping today's export path.

# Summary

Move rendering behind a renderer interface with one model. Ship the
Canvas2D-plus-WebCodecs export first to bank the parity and preview wins,
burn down the media-pipeline risk in a dedicated spike, then swap in WebGPU as
an acceleration layer with shader tone mapping and vector gauges. The server
slims to file store, audio mux, and fallback. This ordering delivers value in
the first week and does not bet the schedule on GPU work.
