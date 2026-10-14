/* GPX Overlay Studio — Phase 1 CSS capture renderer.
 *
 * Builds the overlay as deterministic inline-styled DOM (the same DOM the
 * editor shows) and rasterizes it losslessly via SVG foreignObject.
 * Layout math is a faithful port of overlay.py's PIL renderer: this is what
 * lets captured frames match the golden reference within tolerance.
 *
 * Determinism contract (matches static/model.js): every frame is a pure
 * function of (telemetry, widgets, t). No wall-clock, no random.
 */
"use strict";

const Capture = (() => {

  /* ------------------------------------------------------------- utils */
  // Python: max(6, int(n if n else d))
  const fs = (n, d) => Math.max(6, Math.trunc(n ? n : d));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function hexRGBA(hexstr, alpha = 1.0) {
    const h = (hexstr || "#ffffff").replace("#", "");
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
  }

  function family(ff) {
    return ff === "Orbitron" ? "Orbitron"
      : ff === "Rajdhani" ? "Rajdhani"
      : ff === "Inter" ? "Inter"
      : ff === "DSEG7" ? "DSEG7"
      : ff === "monospace" ? "monospace" : "sans-serif";
  }

  const _mctx = document.createElement("canvas").getContext("2d");
  function fontCSS(ff, size) {
    return `${Math.trunc(size)}px ${family(ff)}`;
  }
  function measure(txt, ff, size) {
    _mctx.font = fontCSS(ff, size);
    return _mctx.measureText(String(txt)).width;
  }

  // PIL draw_text shadow: 8 offset copies at radius shadow*0.7, alpha
  // (120 + shadow*12)/255. Approximated with a soft CSS halo of the same
  // radius and alpha.
  function textShadow(shadow) {
    if (!shadow) return "none";
    const a = Math.min(255, 120 + shadow * 12) / 255;
    return `0 0 ${Math.round(shadow * 1.4)}px rgba(0,0,0,${a.toFixed(3)})`;
  }

  function el(tag, style, text) {
    const e = document.createElement(tag);
    e.style.cssText = style;
    if (text != null) e.textContent = text;
    return e;
  }

  // Absolutely positioned text at a PIL-style anchor point.
  // anchors: lm (left/middle), mm, rm, lb (left/bottom), rb.
  function textNode(txt, ff, size, color, shadow, ax, ay, anchor) {
    let tr = "translate(0,-50%)";            // lm
    if (anchor === "mm") tr = "translate(-50%,-50%)";
    else if (anchor === "rm") tr = "translate(-100%,-50%)";
    else if (anchor === "lb") tr = "translate(0,-100%)";
    else if (anchor === "rb") tr = "translate(-100%,-100%)";
    return el("div",
      `position:absolute;left:${ax}px;top:${ay}px;transform:${tr};` +
      `font:${fontCSS(ff, size)};line-height:1;white-space:pre;color:${color};` +
      `text-shadow:${textShadow(shadow)}`,
      String(txt));
  }

  /* -------------------------------------------------------- font setup */
  let _fontCSSPromise = null;
  const FONT_FILES = [
    ["Orbitron", "/static/fonts/Orbitron.ttf", 400],
    ["Rajdhani", "/static/fonts/Rajdhani-SemiBold.ttf", 600],
    ["Rajdhani", "/static/fonts/Rajdhani-Bold.ttf", 700],
    ["Inter", "/static/fonts/Inter.ttf", 400],
    ["DSEG7", "/static/fonts/DSEG7Classic.ttf", 400],
  ];
  function fontFaceCSS() {
    // Embedded fonts (single-file offline build) win when present.
    const embed = document.getElementById("fonts-embed");
    if (embed) return Promise.resolve(embed.textContent);
    // Embed every UI font as a data URL so rasterized output has the exact
    // glyphs (Orbitron, Rajdhani, Inter, DSEG7 — gauge review fonts).
    if (!_fontCSSPromise) {
      _fontCSSPromise = Promise.all(FONT_FILES.map(([fam, url, wt]) =>
        fetch(url).then(r => r.arrayBuffer()).then(buf => {
          let bin = "";
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i += 8192)
            bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
          const b64 = btoa(bin);
          return `@font-face{font-family:'${fam}';` +
            `src:url(data:font/ttf;base64,${b64}) format('truetype');` +
            `font-weight:${wt};}`;
        })
      )).then(rules => rules.join("\n"));
    }
    return _fontCSSPromise;
  }

  /* ------------------------------------------------- map tiles + charts */
  const _tiles = new Map();
  function getTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (_tiles.has(key)) return _tiles.get(key);
    const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    const fetchTile = () =>
      fetch(url, { signal: AbortSignal.timeout(10000) })
        .then(r => r.ok ? r.blob() : null)
        .then(b => b ? createImageBitmap(b) : null)
        .catch(() => null);
    const p = (async () => {
      // Offline support: tiles are cached in Cache Storage on first use, so
      // later renders work with no network. Missing tiles render as gaps.
      try {
        if (typeof caches !== "undefined") {
          const cache = await caches.open("osm-tiles-v1");
          const hit = await cache.match(url);
          if (hit) return createImageBitmap(await hit.blob());
          const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (r.ok) {
            cache.put(url, r.clone()).catch(() => {});
            return createImageBitmap(await r.blob());
          }
          return null;
        }
      } catch (e) {}
      return fetchTile();
    })();
    _tiles.set(key, p);
    return p;
  }

  function deg2num(lat, lon, z) {
    const lat_r = lat * Math.PI / 180;
    const n = 2 ** z;
    return [(lon + 180) / 360 * n,
            (1 - Math.log(Math.tan(lat_r) + 1 / Math.cos(lat_r)) / Math.PI) / 2 * n];
  }

  async function drawMapCanvas(w, tel, t) {
    const pts = tel.points;
    const W = w.w, H = w.h;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    if (!pts.length) return cv;
    const pad = 14;
    const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
    let z = 18;
    while (z > 3) {
      const [x1, y1] = deg2num(Math.max(...lats), Math.min(...lons), z);
      const [x2, y2] = deg2num(Math.min(...lats), Math.max(...lons), z);
      if ((x2 - x1) * 256 <= W - 2 * pad && (y2 - y1) * 256 <= H - 2 * pad) break;
      z -= 1;
    }
    const [x1, y1] = deg2num(Math.max(...lats), Math.min(...lons), z);
    const [x2, y2] = deg2num(Math.min(...lats), Math.max(...lons), z);
    const origin_x = x1 * 256 - (W - (x2 - x1) * 256) / 2;
    const origin_y = y1 * 256 - (H - (y2 - y1) * 256) / 2;

    c.fillStyle = "rgb(238,238,232)";
    c.fillRect(0, 0, W, H);
    const tx0 = Math.trunc(origin_x / 256), ty0 = Math.trunc(origin_y / 256);
    const tx1 = Math.trunc((origin_x + W) / 256) + 1;
    const ty1 = Math.trunc((origin_y + H) / 256) + 1;
    const jobs = [];
    for (let tx = tx0; tx <= tx1; tx++)
      for (let ty = Math.max(0, ty0); ty <= Math.max(0, ty1) + 1; ty++)
        jobs.push(getTile(z, tx, ty).then(tile => {
          if (tile) c.drawImage(tile, tx * 256 - Math.trunc(origin_x),
                                     ty * 256 - Math.trunc(origin_y));
        }));
    await Promise.all(jobs);

    const proj = (p) => {
      const [xn, yn] = deg2num(p.lat, p.lon, z);
      return [xn * 256 - origin_x, yn * 256 - origin_y];
    };
    const line = pts.map(proj);
    c.lineJoin = "round"; c.lineCap = "butt";
    c.lineWidth = 4;
    c.strokeStyle = "rgba(0,0,0,0.51)";
    c.beginPath();
    line.forEach(([px, py], i) => i ? c.lineTo(px + 2, py + 2) : c.moveTo(px + 2, py + 2));
    c.stroke();
    c.strokeStyle = hexRGBA(w.primary_color || "#e8542a", 1);
    c.beginPath();
    line.forEach(([px, py], i) => i ? c.lineTo(px, py) : c.moveTo(px, py));
    c.stroke();

    const cur = pts.find(p => p.rel >= t) || pts[pts.length - 1];
    const [cx, cy] = proj(cur);
    const r = 7;
    c.fillStyle = "rgba(0,0,0,0.51)";
    c.beginPath(); c.arc(cx, cy, r + 2, 0, Math.PI * 2); c.fill();
    c.fillStyle = "rgb(30,120,230)";
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = "rgb(255,255,255)"; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, r - 2, 0, Math.PI * 2); c.stroke();

    c.font = "9px sans-serif";
    c.fillStyle = "rgba(60,60,60,0.86)";
    c.textAlign = "right"; c.textBaseline = "bottom";
    c.fillText("© OpenStreetMap", W - 8, H - 4);

    if (w.border) {
      c.strokeStyle = hexRGBA(w.border_color || "#000000", 1);
      c.lineWidth = Math.trunc(w.border);
      c.strokeRect(0, 0, W, H);
    }
    return cv;
  }

  function projFlat(pts, W, H, pad) {
    const lat0 = (Math.min(...pts.map(p => p.lat)) + Math.max(...pts.map(p => p.lat))) / 2;
    const kx = Math.cos(lat0 * Math.PI / 180);
    const xs = pts.map(p => p.lon * kx), ys = pts.map(p => -p.lat);
    const minx = Math.min(...xs), maxx = Math.max(...xs);
    const miny = Math.min(...ys), maxy = Math.max(...ys);
    const sc = Math.min((W - 2 * pad) / ((maxx - minx) || 1e-9),
                        (H - 2 * pad) / ((maxy - miny) || 1e-9));
    return (p) => [pad + (p.lon * kx - minx) * sc, pad + (-p.lat - miny) * sc];
  }

  function drawRouteCanvas(w, tel, t) {
    const pts = tel.points;
    const W = w.w, H = w.h;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    if (!pts.length) return cv;
    const proj = projFlat(pts, W, H, 18);
    const line = pts.map(proj);
    const lw = Math.trunc(w.gauge_width ?? 5);
    const col = hexRGBA(w.primary_color || "#ffffff", 1);
    c.lineJoin = "round"; c.lineCap = "butt"; c.lineWidth = lw;
    c.strokeStyle = "rgba(0,0,0,0.55)";
    c.beginPath();
    line.forEach(([px, py], i) => i ? c.lineTo(px + 2, py + 2) : c.moveTo(px + 2, py + 2));
    c.stroke();
    c.strokeStyle = col;
    c.beginPath();
    line.forEach(([px, py], i) => i ? c.lineTo(px, py) : c.moveTo(px, py));
    c.stroke();
    const cur = pts.find(p => p.rel >= t) || pts[pts.length - 1];
    const [cx, cy] = proj(cur);
    const r = 8;
    c.fillStyle = "rgba(0,0,0,0.55)";
    c.beginPath(); c.arc(cx, cy, r + 2, 0, Math.PI * 2); c.fill();
    c.fillStyle = col;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = "rgb(255,255,255)"; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, r - 2, 0, Math.PI * 2); c.stroke();
    return cv;
  }

  function drawTrackCanvas(w, tel, t) {
    const pts = tel.points;
    const W = w.w, H = w.h;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    if (!pts.length) return cv;
    if (w.bg_color) {
      c.fillStyle = hexRGBA(w.bg_color, w.bg_opacity ?? 0.2);
      c.fillRect(0, 0, W, H);
    }
    const eles = pts.map(p => p.ele);
    const mine = Math.min(...eles), maxe = Math.max(...eles);
    const span = (maxe - mine) || 1;
    const tspan = pts[pts.length - 1].rel || 1;
    const px = (p) => 8 + (p.rel / tspan) * (W - 16);
    const py = (p) => H - 14 - ((p.ele - mine) / span) * (H - 30);

    const poly = pts.map(p => [px(p), py(p)]);
    c.fillStyle = hexRGBA(w.primary_color || "#ffffff", 0.22);
    c.beginPath();
    c.moveTo(poly[0][0], poly[0][1]);
    poly.forEach(([x, y]) => c.lineTo(x, y));
    c.lineTo(poly[poly.length - 1][0], H - 8);
    c.lineTo(poly[0][0], H - 8);
    c.closePath(); c.fill();
    c.strokeStyle = hexRGBA(w.primary_color || "#ffffff", 1);
    c.lineWidth = 3; c.lineJoin = "round";
    c.beginPath();
    poly.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
    c.stroke();

    const cur = pts.find(p => p.rel >= t) || pts[pts.length - 1];
    const cx = px(cur);
    c.strokeStyle = hexRGBA(w.secondary_color || "#ff6b35", 1);
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(cx, 6); c.lineTo(cx, H - 6); c.stroke();
    c.fillStyle = hexRGBA(w.secondary_color || "#ff6b35", 1);
    c.beginPath(); c.arc(cx, py(cur), 5, 0, Math.PI * 2); c.fill();

    const size = Math.max(10, H * 0.11);
    const lbl = `${w.label || "ALT"}: ${Math.round(cur.ele)} ${Model.unitLabel(w)}`;
    c.font = fontCSS(w.font_family || "Orbitron", size);
    c.textAlign = "left"; c.textBaseline = "middle";
    c.shadowColor = "rgba(0,0,0,0.8)"; c.shadowBlur = 2;
    c.fillStyle = hexRGBA(w.label_color || "#ffffff", 1);
    c.fillText(lbl, 12, H * 0.16);
    c.shadowBlur = 0;

    if (w.border) {
      c.strokeStyle = hexRGBA(w.border_color || "#000000", 1);
      c.lineWidth = Math.trunc(w.border);
      c.strokeRect(0, 0, W, H);
    }
    return cv;
  }

  /* ------------------------------------------------- gauge style wiring
   * The seven approved motorsport styles (tach, ledbar, gearbox, delta,
   * trace, ring, pillrow) render through PAINTERS in BOTH the DOM editing
   * layer and the canvas painter — one implementation, exact parity. */

  const GAUGE_STYLES = new Set(
    ["tach", "ledbar", "gearbox", "delta", "trace", "ring", "pillrow"]);

  const PILL_ICON = {
    speed: "◉", avgspeed: "◉", maxspeed: "◉", heartrate: "♥",
    cadence: "⚙", power: "⚡", elevation: "▲", distance: "◈",
    grade: "⛰", temperature: "☀", verticalspeed: "↕", duration: "⏱",
    time: "🕒",
  };

  function gaugeData(w, tel, t, style, val) {
    const [mn, mx] = Model.rangeFor(w, tel);
    const num = parseFloat(val);
    const frac = Number.isFinite(num)
      ? clamp01((num - mn) / ((mx - mn) || 1)) : 0;
    const base = {
      frac, value: val,
      label: (w.label || w.type || "").toUpperCase(),
      unit: Model.unitLabel(w),
    };
    if (style === "delta") {
      base.signed = Number.isFinite(num)
        ? Math.max(-1, Math.min(1, (num - (mn + mx) / 2) / ((mx - mn) / 2 || 1)))
        : 0;
      if (num > 0) base.value = "+" + val;
    } else if (style === "ring") {
      base.sub = `of ${Math.round(mx * 10) / 10} ${base.unit}`;
    } else if (style === "trace") {
      const s = Model.rawSeries(w, tel);
      const dur = (tel && tel.points && tel.points.length)
        ? tel.points[tel.points.length - 1].rel : 1;
      const idx = Math.round(clamp01(t / (dur || 1)) * (s.length - 1));
      base.series = s.slice(Math.max(0, idx - 23), idx + 1)
        .map(v => clamp01((v - mn) / ((mx - mn) || 1)));
    } else if (style === "pillrow") {
      base.items = [{
        icon: PILL_ICON[w.type] || "•",
        value: val, unit: base.unit, frac,
      }];
    }
    return base;
  }

  /* ---------------------------------------------------- widget DOM build */

  function buildValueDOM(box, w, tel, t) {
    // Port of overlay.py render_widget() layouts.
    const x = 0, y = 0, W = w.w, H = w.h;   // widget-local coords
    const style = w.style || "text";
    const ff = w.font_family || "Orbitron";
    const shadow = w.shadow ?? 3;
    const val = Model.fmtVal(w, t, tel);
    const ul = Model.unitLabel(w);
    const c_lbl = hexRGBA(w.label_color || "#ffffff", 1);
    const c_val = hexRGBA(w.value_color || "#ffffff", 1);
    const c_uni = hexRGBA(w.unit_color || "#ffffffcc", 1);

    if (GAUGE_STYLES.has(style)) {
      // Editing-layer gauge = the export painter itself, on a canvas.
      const cv = document.createElement("canvas");
      const dpr = 2;
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.cssText =
        `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
      const g = cv.getContext("2d");
      g.scale(dpr, dpr);
      paintStyle(g, style, 0, 0, W, H, gaugeData(w, tel, t, style, val));
      box.appendChild(cv);
      return;
    }

    if (w.bg_color) {
      box.appendChild(el("div",
        `position:absolute;left:0;top:0;width:${W}px;height:${H}px;` +
        `background:${hexRGBA(w.bg_color, w.bg_opacity ?? 0.33)};` +
        `border-radius:${w.round_corner ?? 8}px`));
    }

    if (style === "arc") {
      const cx = x + W / 2, cy = y + H / 2;
      const gw = w.gauge_width ?? 14;
      const r = Math.min(W, H) / 2 - gw / 2 - 4;
      const a0 = 135, sweep = w.gauge_angle ?? 270;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", W); svg.setAttribute("height", H);
      svg.style.cssText = "position:absolute;left:0;top:0";
      const arcPath = (deg) => {
        const rad = (d) => d * Math.PI / 180;
        const x1 = cx + r * Math.cos(rad(a0)), y1 = cy + r * Math.sin(rad(a0));
        const x2 = cx + r * Math.cos(rad(a0 + deg)), y2 = cy + r * Math.sin(rad(a0 + deg));
        const large = deg > 180 ? 1 : 0;
        return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
      };
      const mkPath = (deg, col) => {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", arcPath(deg));
        p.setAttribute("stroke", col);
        p.setAttribute("stroke-width", gw);
        p.setAttribute("fill", "none");
        svg.appendChild(p);
      };
      mkPath(sweep, hexRGBA(w.secondary_color || "#ffffff55", 1));
      const [mn, mx] = Model.rangeFor(w, tel);
      const frac = clamp01((parseFloat(val) - mn) / ((mx - mn) || 1));
      if (frac > 0.001) mkPath(sweep * frac, hexRGBA(w.primary_color || "#ffffff", 1));
      box.appendChild(svg);

      const lines = [];
      if (w.show_label !== false && w.label)
        lines.push([w.label, fs(w.label_size, 16), c_lbl]);
      if (w.show_value !== false)
        lines.push([val, fs(w.value_size, 42), c_val]);
      if (w.show_unit !== false && ul)
        lines.push([ul, fs(w.unit_size, 18), c_uni]);
      const heights = lines.map(([, s]) => s * 1.18);
      let yy = cy - heights.reduce((a, b) => a + b, 0) / 2 - H * 0.022;
      lines.forEach(([txt, size, col], i) => {
        box.appendChild(textNode(txt, ff, size, col, shadow, cx, yy + heights[i] / 2, "mm"));
        yy += heights[i];
      });
      return;
    }

    if (style === "bar" || style === "barv") {
      const vert = style === "barv";
      const [mn, mx] = Model.rangeFor(w, tel);
      const frac = clamp01((parseFloat(val) - mn) / ((mx - mn) || 1));
      const padx = x + 10;
      const capSize = Math.trunc(fs(w.label_size, 16) * 0.8);
      const fitSize = (txt, size, maxW) => {
        while (size > 6 && measure(txt, ff, size) > maxW) size -= 1;
        return size;
      };
      const cap = (txt, ax, ay) =>
        box.appendChild(textNode(txt, ff, capSize, c_lbl, 0, ax, ay, "lm"));

      if (vert) {
        const bw = Math.max(10, Math.trunc(W * 0.18));
        const bx = x + W - bw - 12;
        const ty0 = y + 30, ty1 = y + H - 30;
        box.appendChild(el("div",
          `position:absolute;left:${bx}px;top:${ty0}px;width:${bw}px;height:${ty1 - ty0}px;` +
          `background:${hexRGBA(w.secondary_color || "#ffffff55", 1)};border-radius:${Math.trunc(bw / 2)}px`));
        const fillH = (ty1 - ty0) * frac;
        if (fillH > 1)
          box.appendChild(el("div",
            `position:absolute;left:${bx}px;top:${ty1 - fillH}px;width:${bw}px;height:${fillH}px;` +
            `background:${hexRGBA(w.primary_color || "#ffffff", 1)};border-radius:${Math.trunc(bw / 2)}px`));
        cap(String(Math.round(mx)), bx + bw / 2, ty0 - 6);
        cap(String(Math.round(mn)), bx + bw / 2, ty1 + 6);
        const avail = bx - padx - 8;
        let yy = y + 18;
        if (w.show_label !== false && w.label) {
          const s = fitSize(w.label, fs(w.label_size, 16), avail);
          box.appendChild(textNode(w.label, ff, s, c_lbl, shadow, padx, yy, "lm"));
          yy += fs(w.label_size, 16) * 1.3;
        }
        if (w.show_value !== false) {
          const s = fitSize(val, fs(w.value_size, 32), avail);
          box.appendChild(textNode(val, ff, s, c_val, shadow, padx, yy + s * 0.5, "lm"));
        }
        return;
      }

      const rowH = fs(w.value_size, 32);
      const rowMid = y + 16 + rowH * 0.5;
      const ufSize = fs(w.unit_size, 18);
      const ulw = (w.show_unit !== false && ul) ? measure(" " + ul, ff, ufSize) : 0;
      const vw = measure(val, ff, rowH);
      const right = x + W - 12;
      if (w.show_value !== false) {
        box.appendChild(textNode(val, ff, rowH, c_val, shadow, right - ulw, rowMid, "rm"));
        if (ulw)
          box.appendChild(textNode(ul, ff, ufSize, c_uni, shadow,
            right, rowMid + rowH * 0.12, "rm"));
      }
      if (w.show_label !== false && w.label) {
        const avail = Math.max(20, right - ulw - vw - padx - 16);
        const s = fitSize(w.label, fs(w.label_size, 16), avail);
        box.appendChild(textNode(w.label, ff, s, c_lbl, shadow, padx, rowMid, "lm"));
      }
      const barY = y + H - 26;
      const bh = Math.max(8, Math.trunc(H * 0.12));
      box.appendChild(el("div",
        `position:absolute;left:${padx}px;top:${barY}px;width:${right - padx}px;height:${bh}px;` +
        `background:${hexRGBA(w.secondary_color || "#ffffff55", 1)};border-radius:${Math.trunc(bh / 2)}px`));
      const fillW = (right - padx) * frac;
      if (fillW > 1)
        box.appendChild(el("div",
          `position:absolute;left:${padx}px;top:${barY}px;width:${fillW}px;height:${bh}px;` +
          `background:${hexRGBA(w.primary_color || "#ffffff", 1)};border-radius:${Math.trunc(bh / 2)}px`));
      cap(String(Math.round(mn)), padx, barY + bh + 8);
      box.appendChild(textNode(String(Math.round(mx)), ff, capSize, c_lbl, 0,
        right + 2, barY + bh + 8, "rm"));
      return;
    }

    // "big" and "text"
    const pad = 10;
    if (style === "big") {
      const colx = x + pad + ((w.value_align || "left") === "left" ? 0 : W / 2 - pad);
      let yy = y + H / 2;
      const vsize = fs(w.value_size, 42);
      if (w.show_unit !== false && ul) {
        yy -= vsize * 0.35;
        box.appendChild(textNode(ul, ff, fs(w.unit_size, 18), c_uni, shadow,
          colx, yy - vsize * 0.4, "lm"));
      }
      if (w.show_label !== false && w.label)
        box.appendChild(textNode(w.label, ff, fs(w.label_size, 16), c_lbl, shadow,
          colx, yy - vsize * 0.35, "lm"));
      if (w.show_value !== false)
        box.appendChild(textNode(val, ff, vsize, c_val, shadow,
          colx, yy + vsize * 0.25, "lm"));
      return;
    }

    const colx = x + pad;
    let yy = y + H * 0.3;
    const vsize = fs(w.value_size, 42);
    if (w.show_label !== false && w.label) {
      box.appendChild(textNode(w.label, ff, fs(w.label_size, 16), c_lbl, shadow, colx, yy, "lm"));
      yy += vsize * 0.62;
    }
    const rowY = y + H * 0.62;
    let xx = colx;
    if (w.show_value !== false) {
      box.appendChild(textNode(val, ff, vsize, c_val, shadow, xx, rowY, "lm"));
      xx += measure(val, ff, vsize) + 8;
    }
    if (w.show_unit !== false && ul)
      box.appendChild(textNode(ul, ff, fs(w.unit_size, 18), c_uni, shadow,
        xx, rowY + vsize * 0.12, "lm"));
  }

  async function buildOverlayDOM(tel, widgets, t, W, H) {
    const root = el("div",
      `position:relative;width:${W}px;height:${H}px;overflow:hidden;background:transparent`);
    for (const w of widgets) {
      if (w.display === false) continue;
      const box = el("div",
        `position:absolute;left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px`);
      box.dataset.widgetId = w.id || "";
      if (w.type === "gpx") {
        const cv = drawRouteCanvas(w, tel, t);
        box.appendChild(canvasImg(cv));
      } else if (w.type === "track") {
        const cv = drawTrackCanvas(w, tel, t);
        box.appendChild(canvasImg(cv));
      } else if (w.type === "map") {
        const cv = await drawMapCanvas(w, tel, t);
        box.appendChild(canvasImg(cv));
      } else {
        buildValueDOM(box, w, tel, t);
      }
      root.appendChild(box);
    }
    return root;
  }

  function canvasImg(cv) {
    const img = el("img", `position:absolute;left:0;top:0;width:${cv.width}px;height:${cv.height}px`);
    img.src = cv.toDataURL("image/png");
    return img;
  }

  /* ---------------------------------------------------------- rasterize */

  async function rasterize(root, W, H) {
    const fontCss = await fontFaceCSS();
    // XMLSerializer is required: innerHTML emits HTML-style unclosed <img>
    // tags, which the SVG image parser rejects as invalid XML.
    const inner = new XMLSerializer().serializeToString(root);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;` +
      `width:${W}px;height:${H}px;background:transparent">` +
      `<style>${fontCss}</style>${inner}</div></foreignObject></svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      cv.getContext("2d").drawImage(img, 0, 0);
      return cv;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* -------------------------------------- Canvas2D capture backend
   * Port of overlay.py's PIL renderer. This is THE capture backend: SVG
   * foreignObject rasterization taints canvases in Chromium (verified:
   * even text-only DOM), so it can never feed export. The DOM layer stays
   * the live editing surface; this painter produces the clean lossless
   * pixels. Both run the same layout math from the shared model. */

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // PIL draw_text port: 8 shadow copies at radius shadow*.7 + main text.
  // anchor: lm | mm | rm (vertical middle).
  function ptext(ctx, txt, x, y, ff, size, color, shadow, anchor = "lm") {
    ctx.font = fontCSS(ff, size);
    ctx.textBaseline = "middle";
    ctx.textAlign = anchor === "mm" ? "center" : anchor === "rm" ? "right" : "left";
    txt = String(txt);
    if (shadow) {
      const a = Math.min(255, 120 + shadow * 12) / 255;
      ctx.fillStyle = `rgba(0,0,0,${(a).toFixed(3)})`;
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1])
          if (dx || dy)
            ctx.fillText(txt, x + dx * shadow * 0.7, y + dy * shadow * 0.7);
    }
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  }

  function paintValue(ctx, w, tel, t) {
    const x = w.x, y = w.y, W = w.w, H = w.h;
    const style = w.style || "text";
    const ff = w.font_family || "Orbitron";
    const shadow = w.shadow ?? 3;
    const val = Model.fmtVal(w, t, tel);
    const ul = Model.unitLabel(w);
    const c_lbl = hexRGBA(w.label_color || "#ffffff", 1);
    const c_val = hexRGBA(w.value_color || "#ffffff", 1);
    const c_uni = hexRGBA(w.unit_color || "#ffffffcc", 1);

    if (GAUGE_STYLES.has(style)) {
      paintStyle(ctx, style, x, y, W, H, gaugeData(w, tel, t, style, val));
      return;
    }

    if (w.bg_color) {
      ctx.fillStyle = hexRGBA(w.bg_color, w.bg_opacity ?? 0.33);
      rr(ctx, x, y, W, H, w.round_corner ?? 8);
      ctx.fill();
    }

    if (style === "arc") {
      const cx = x + W / 2, cy = y + H / 2;
      const gw = w.gauge_width ?? 14;
      const r = Math.min(W, H) / 2 - gw / 2 - 4;
      const a0 = 135 * Math.PI / 180, sweep = (w.gauge_angle ?? 270) * Math.PI / 180;
      ctx.lineWidth = gw;
      ctx.lineCap = "butt";
      ctx.strokeStyle = hexRGBA(w.secondary_color || "#ffffff55", 1);
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + sweep); ctx.stroke();
      const [mn, mx] = Model.rangeFor(w, tel);
      const frac = clamp01((parseFloat(val) - mn) / ((mx - mn) || 1));
      if (frac > 0.001) {
        ctx.strokeStyle = hexRGBA(w.primary_color || "#ffffff", 1);
        ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + sweep * frac); ctx.stroke();
      }
      const lines = [];
      if (w.show_label !== false && w.label)
        lines.push([w.label, fs(w.label_size, 16), c_lbl]);
      if (w.show_value !== false)
        lines.push([val, fs(w.value_size, 42), c_val]);
      if (w.show_unit !== false && ul)
        lines.push([ul, fs(w.unit_size, 18), c_uni]);
      const heights = lines.map(([, s]) => s * 1.18);
      let yy = cy - heights.reduce((a, b) => a + b, 0) / 2 - H * 0.022;
      lines.forEach(([txt, size, col], i) => {
        ptext(ctx, txt, cx, yy + heights[i] / 2, ff, size, col, shadow, "mm");
        yy += heights[i];
      });
      return;
    }

    if (style === "bar" || style === "barv") {
      const vert = style === "barv";
      const [mn, mx] = Model.rangeFor(w, tel);
      const frac = clamp01((parseFloat(val) - mn) / ((mx - mn) || 1));
      const padx = x + 10;
      const capSize = Math.trunc(fs(w.label_size, 16) * 0.8);
      const fitSize = (txt, size, maxW) => {
        while (size > 6 && measure(txt, ff, size) > maxW) size -= 1;
        return size;
      };

      if (vert) {
        const bw = Math.max(10, Math.trunc(W * 0.18));
        const bx = x + W - bw - 12;
        const ty0 = y + 30, ty1 = y + H - 30;
        ctx.fillStyle = hexRGBA(w.secondary_color || "#ffffff55", 1);
        rr(ctx, bx, ty0, bw, ty1 - ty0, Math.trunc(bw / 2)); ctx.fill();
        const fillH = (ty1 - ty0) * frac;
        if (fillH > 1) {
          ctx.fillStyle = hexRGBA(w.primary_color || "#ffffff", 1);
          rr(ctx, bx, ty1 - fillH, bw, fillH, Math.trunc(bw / 2)); ctx.fill();
        }
        ptext(ctx, String(Math.round(mx)), bx + bw / 2, ty0 - 6, ff, capSize, c_lbl, 0);
        ptext(ctx, String(Math.round(mn)), bx + bw / 2, ty1 + 6, ff, capSize, c_lbl, 0);
        const avail = bx - padx - 8;
        let yy = y + 18;
        if (w.show_label !== false && w.label) {
          const s = fitSize(w.label, fs(w.label_size, 16), avail);
          ptext(ctx, w.label, padx, yy, ff, s, c_lbl, shadow);
          yy += fs(w.label_size, 16) * 1.3;
        }
        if (w.show_value !== false) {
          const s = fitSize(val, fs(w.value_size, 32), avail);
          ptext(ctx, val, padx, yy + s * 0.5, ff, s, c_val, shadow);
        }
        return;
      }

      const rowH = fs(w.value_size, 32);
      const rowMid = y + 16 + rowH * 0.5;
      const ufSize = fs(w.unit_size, 18);
      const ulw = (w.show_unit !== false && ul) ? measure(" " + ul, ff, ufSize) : 0;
      const vw = measure(val, ff, rowH);
      const right = x + W - 12;
      if (w.show_value !== false) {
        ptext(ctx, val, right - ulw, rowMid, ff, rowH, c_val, shadow, "rm");
        if (ulw)
          ptext(ctx, ul, right, rowMid + rowH * 0.12, ff, ufSize, c_uni, shadow, "rm");
      }
      if (w.show_label !== false && w.label) {
        const avail = Math.max(20, right - ulw - vw - padx - 16);
        const s = fitSize(w.label, fs(w.label_size, 16), avail);
        ptext(ctx, w.label, padx, rowMid, ff, s, c_lbl, shadow);
      }
      const barY = y + H - 26;
      const bh = Math.max(8, Math.trunc(H * 0.12));
      ctx.fillStyle = hexRGBA(w.secondary_color || "#ffffff55", 1);
      rr(ctx, padx, barY, right - padx, bh, Math.trunc(bh / 2)); ctx.fill();
      const fillW = (right - padx) * frac;
      if (fillW > 1) {
        ctx.fillStyle = hexRGBA(w.primary_color || "#ffffff", 1);
        rr(ctx, padx, barY, fillW, bh, Math.trunc(bh / 2)); ctx.fill();
      }
      ptext(ctx, String(Math.round(mn)), padx, barY + bh + 8, ff, capSize, c_lbl, 0);
      ptext(ctx, String(Math.round(mx)), right + 2, barY + bh + 8, ff, capSize, c_lbl, 0, "rm");
      return;
    }

    const pad = 10;
    if (style === "big") {
      const colx = x + pad + ((w.value_align || "left") === "left" ? 0 : W / 2 - pad);
      let yy = y + H / 2;
      const vsize = fs(w.value_size, 42);
      if (w.show_unit !== false && ul) {
        yy -= vsize * 0.35;
        ptext(ctx, ul, colx, yy - vsize * 0.4, ff, fs(w.unit_size, 18), c_uni, shadow);
      }
      if (w.show_label !== false && w.label)
        ptext(ctx, w.label, colx, yy - vsize * 0.35, ff, fs(w.label_size, 16), c_lbl, shadow);
      if (w.show_value !== false)
        ptext(ctx, val, colx, yy + vsize * 0.25, ff, vsize, c_val, shadow);
      return;
    }

    const colx = x + pad;
    let yy = y + H * 0.3;
    const vsize = fs(w.value_size, 42);
    if (w.show_label !== false && w.label) {
      ptext(ctx, w.label, colx, yy, ff, fs(w.label_size, 16), c_lbl, shadow);
      yy += vsize * 0.62;
    }
    const rowY = y + H * 0.62;
    let xx = colx;
    if (w.show_value !== false) {
      ptext(ctx, val, xx, rowY, ff, vsize, c_val, shadow);
      xx += measure(val, ff, vsize) + 8;
    }
    if (w.show_unit !== false && ul)
      ptext(ctx, ul, xx, rowY + vsize * 0.12, ff, fs(w.unit_size, 18), c_uni, shadow);
  }

  async function paintFrame(tel, widgets, t, W, H) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    for (const w of widgets) {
      if (w.display === false) continue;
      if (w.type === "gpx")
        ctx.drawImage(drawRouteCanvas(w, tel, t), w.x, w.y);
      else if (w.type === "track")
        ctx.drawImage(drawTrackCanvas(w, tel, t), w.x, w.y);
      else if (w.type === "map")
        ctx.drawImage(await drawMapCanvas(w, tel, t), w.x, w.y);
      else
        paintValue(ctx, w, tel, t);
    }
    return cv;
  }

  /* ------------------------------------------------- one-call frame shot */

  async function captureFrame(tel, widgets, t, W, H) {
    // Canvas2D capture (clean pixels). The DOM builder remains exported for
    // the live editing surface.
    return paintFrame(tel, widgets, t, W, H);
  }

  /* ------------------------------------------- gauge style painters
   * Motorsport-inspired styles (Forza/F1/Dirt Rally DNA, cycling metrics).
   * These are real engine painters: the sample sheets and the app's export
   * both draw through these functions. Zone ramp: Forza green -> amber ->
   * red (default, per product decision 2026-10-13). */

  function zoneColor(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [[0.00, 47, 214, 111], [0.55, 255, 210, 63],
                   [0.85, 255, 122, 47], [1.00, 255, 59, 48]];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++)
      if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    const f = (t - a[0]) / ((b[0] - a[0]) || 1);
    const c = (i) => Math.round(a[i] + (b[i] - a[i]) * f);
    return `rgb(${c(1)},${c(2)},${c(3)})`;
  }

  function rr2(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function shadowOn(ctx, blur = 8) {
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = 2;
  }
  function shadowOff(ctx) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  const PAINTERS = {
    /* Forza-style tachometer sweep with zone colors */
    tach(ctx, o) {
      const cx = o.x + o.w / 2, cy = o.y + o.h * 0.54;
      const r = Math.min(o.w, o.h) * 0.36;
      const lw = r * 0.17;
      const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
      ctx.lineCap = "butt";
      ctx.lineWidth = lw;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + sweep); ctx.stroke();
      const N = 56;
      ctx.lineCap = "round";
      for (let i = 0; i < N; i++) {
        const t0 = i / N, t1 = (i + 1) / N;
        if (t0 >= o.frac) break;
        const te = Math.min(t1, o.frac);
        ctx.strokeStyle = zoneColor(t0 + (te - t0) / 2);
        ctx.beginPath();
        ctx.arc(cx, cy, r, a0 + sweep * t0, a0 + sweep * te + 0.006);
        ctx.stroke();
      }
      // redline band tick
      const ar = a0 + sweep * 0.92;
      shadowOn(ctx, 6);
      ctx.fillStyle = "rgb(255,59,48)";
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ar) * (r + lw * 0.95),
              cy + Math.sin(ar) * (r + lw * 0.95), lw * 0.22, 0, 7);
      ctx.fill();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.font = `600 ${Math.round(r * 0.58)}px Rajdhani`;
      ctx.fillText(o.value, cx, cy - r * 0.02);
      ctx.font = `600 ${Math.round(r * 0.17)}px Rajdhani`;
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(o.unit, cx, cy + r * 0.34);
      ctx.font = `600 ${Math.round(r * 0.15)}px Rajdhani`;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText(o.label, cx, cy - r * 0.52);
      shadowOff(ctx);
    },

    /* F1/Forza LED shift-light strip */
    ledbar(ctx, o) {
      const pad = o.w * 0.07;
      shadowOn(ctx, 5);
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.round(o.h * 0.11)}px Rajdhani`;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(o.label, pad, o.y + o.h * 0.16);
      shadowOff(ctx);
      const N = 16, gap = o.w * 0.008;
      const segW = (o.w - pad * 2 - (N - 1) * gap) / N;
      const by = o.y + o.h * 0.38, bh = o.h * 0.20;
      for (let i = 0; i < N; i++) {
        const t = (i + 0.5) / N;
        const filled = t <= o.frac + 0.001;
        rr2(ctx, pad + i * (segW + gap), by, segW, bh, segW * 0.28);
        if (filled) {
          shadowOn(ctx, 10);
          ctx.fillStyle = zoneColor(t);
          ctx.fill();
          shadowOff(ctx);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.10)";
          ctx.fill();
        }
      }
      shadowOn(ctx, 8);
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.round(o.h * 0.30)}px Rajdhani`;
      ctx.fillStyle = "#fff";
      ctx.fillText(o.value, pad, o.y + o.h * 0.78);
      ctx.font = `600 ${Math.round(o.h * 0.11)}px Rajdhani`;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(o.unit, pad + ctx.measureText(o.value).width + o.h * 0.22, o.y + o.h * 0.80);
      shadowOff(ctx);
    },

    /* Gear-indicator cube with 7-segment digits */
    gearbox(ctx, o) {
      const bw = o.w * 0.62, bh = o.h * 0.72;
      const bx = o.x + (o.w - bw) / 2, by = o.y + o.h * 0.16;
      shadowOn(ctx, 12);
      rr2(ctx, bx, by, bw, bh, o.h * 0.05);
      ctx.fillStyle = "rgba(10,12,16,0.82)";
      ctx.fill();
      ctx.lineWidth = Math.max(2, o.h * 0.014);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.stroke();
      shadowOff(ctx);
      // zone accent bar at the box bottom
      rr2(ctx, bx + bw * 0.12, by + bh * 0.88, bw * 0.76, bh * 0.045, bh * 0.02);
      ctx.fillStyle = zoneColor(o.frac);
      ctx.fill();
      // label chip on the top border
      const cw = bw * 0.52, ch = o.h * 0.13;
      rr2(ctx, bx + (bw - cw) / 2, by - ch / 2, cw, ch, ch / 2);
      ctx.fillStyle = "rgba(10,12,16,0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = Math.max(1.5, o.h * 0.01);
      ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.round(ch * 0.58)}px Rajdhani`;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(o.label, bx + bw / 2, by + 1);
      // giant value in 7-segment face
      shadowOn(ctx, 10);
      ctx.fillStyle = "#fff";
      ctx.font = `${Math.round(bh * 0.52)}px DSEG7`;
      ctx.fillText(o.value, bx + bw / 2, by + bh * 0.47);
      shadowOff(ctx);
    },

    /* Racing delta bar, center-zero, green positive / red negative */
    delta(ctx, o) {
      const pad = o.w * 0.10;
      shadowOn(ctx, 6);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.round(o.h * 0.11)}px Rajdhani`;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText(o.label, o.x + o.w / 2, o.y + o.h * 0.16);
      ctx.font = `600 ${Math.round(o.h * 0.30)}px Rajdhani`;
      ctx.fillStyle = "#fff";
      ctx.fillText(o.value, o.x + o.w / 2, o.y + o.h * 0.42);
      shadowOff(ctx);
      const bx = pad, bw = o.w - pad * 2;
      const by = o.y + o.h * 0.62, bh = o.h * 0.11;
      rr2(ctx, bx, by, bw, bh, bh / 2);
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.fill();
      const cx = bx + bw / 2;
      const half = bw / 2;
      const mag = Math.min(1, Math.abs(o.signed));
      const fillW = half * mag;
      if (fillW > 1) {
        rr2(ctx, o.signed >= 0 ? cx : cx - fillW, by, fillW, bh, bh / 2);
        ctx.fillStyle = o.signed >= 0 ? zoneColor(0.25 + 0.7 * mag) : "rgb(255,59,48)";
        shadowOn(ctx, 8);
        ctx.fill();
        shadowOff(ctx);
      }
      // center marker + end ticks
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(cx - 1.5, by - bh * 0.35, 3, bh * 1.7);
      ctx.fillRect(bx, by - bh * 0.25, 3, bh * 1.5);
      ctx.fillRect(bx + bw - 3, by - bh * 0.25, 3, bh * 1.5);
      ctx.font = `600 ${Math.round(o.h * 0.085)}px Rajdhani`;
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.textAlign = "left";
      ctx.fillText(o.unit, bx, by + bh * 2.1);
      ctx.textAlign = "right";
      ctx.fillText("max", bx + bw, by + bh * 2.1);
    },

    /* Telemetry sparkline with live dot */
    trace(ctx, o) {
      const pad = o.w * 0.07;
      shadowOn(ctx, 5);
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.round(o.h * 0.11)}px Inter`;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(o.label, pad, o.y + o.h * 0.14);
      ctx.textAlign = "right";
      ctx.font = `600 ${Math.round(o.h * 0.22)}px Inter`;
      ctx.fillStyle = "#fff";
      ctx.fillText(o.value, o.w - pad, o.y + o.h * 0.14);
      ctx.font = `500 ${Math.round(o.h * 0.09)}px Inter`;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText(o.unit, o.w - pad, o.y + o.h * 0.28);
      shadowOff(ctx);
      const gx = pad, gy = o.y + o.h * 0.38, gw = o.w - pad * 2, gh = o.h * 0.46;
      const s = o.series || [];
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(gx, gy + gh / 2); ctx.lineTo(gx + gw, gy + gh / 2); ctx.stroke();
      ctx.setLineDash([]);
      if (s.length > 1) {
        const px = (i) => gx + (i / (s.length - 1)) * gw;
        const py = (v) => gy + gh - Math.max(0, Math.min(1, v)) * gh;
        const grad = ctx.createLinearGradient(0, gy, 0, gy + gh);
        grad.addColorStop(0, "rgba(255,255,255,0.22)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.beginPath();
        ctx.moveTo(px(0), py(s[0]));
        s.forEach((v, i) => ctx.lineTo(px(i), py(v)));
        ctx.lineTo(px(s.length - 1), gy + gh);
        ctx.lineTo(px(0), gy + gh);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        s.forEach((v, i) => i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)));
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = Math.max(2, o.h * 0.012);
        ctx.stroke();
        const lx = px(s.length - 1), ly = py(s[s.length - 1]);
        shadowOn(ctx, 10);
        ctx.fillStyle = zoneColor(s[s.length - 1]);
        ctx.beginPath(); ctx.arc(lx, ly, o.h * 0.028, 0, 7); ctx.fill();
        shadowOff(ctx);
      }
    },

    /* GT-style thin ring — used for PROGRESS semantics (completion, not
     * intensity): label in the gap, sub-line under the value. Accepts an
     * optional accent color (progress should not wear the zone ramp). */
    ring(ctx, o) {
      const cx = o.x + o.w / 2, cy = o.y + o.h * 0.46;
      const r = Math.min(o.w, o.h) * 0.36;
      const lw = r * 0.10;
      const a0 = Math.PI * 0.72, sweep = Math.PI * 1.56;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + sweep); ctx.stroke();
      if (o.frac > 0.003) {
        shadowOn(ctx, 8);
        ctx.strokeStyle = o.accent || zoneColor(o.frac);
        ctx.beginPath();
        ctx.arc(cx, cy, r, a0, a0 + sweep * o.frac);
        ctx.stroke();
        shadowOff(ctx);
      }
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      shadowOn(ctx, 8);
      ctx.fillStyle = "#fff";
      ctx.font = `500 ${Math.round(r * 0.50)}px Inter`;
      ctx.fillText(o.value, cx, cy - r * 0.12);
      ctx.font = `500 ${Math.round(r * 0.16)}px Inter`;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(o.sub || o.unit, cx, cy + r * 0.28);
      shadowOff(ctx);
      // label sits in the bottom gap
      ctx.font = `600 ${Math.round(r * 0.15)}px Inter`;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(o.label, cx, cy + r * 1.18);
    },

    /* Forza Horizon-style icon pills — symmetric padding (icon left-aligned
     * at padX, unit right-aligned at padX, value centered between) */
    pillrow(ctx, o) {
      const items = o.items || [];
      const gap = o.w * 0.035;
      const pw = (o.w - gap * (items.length - 1)) / items.length;
      const ph = o.h * 0.42, py = o.y + o.h * 0.30;
      items.forEach((it, i) => {
        const px = o.x + i * (pw + gap);
        shadowOn(ctx, 10);
        rr2(ctx, px, py, pw, ph, ph / 2);
        ctx.fillStyle = "rgba(10,12,16,0.78)";
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, o.h * 0.008);
        ctx.strokeStyle = zoneColor(it.frac ?? 0.3);
        ctx.stroke();
        shadowOff(ctx);
        const padX = ph * 0.32;
        ctx.textBaseline = "middle";
        // content = ONE centered cluster [icon][value][unit] (review
        // 2026-10-13: the icon-number gap must stay tight — no centering of
        // the text against the icon). Value and unit share size and family;
        // the whole cluster shrinks to fit if needed.
        let fs = ph * 0.30;
        const meas = (s) => {
          ctx.font = `500 ${Math.round(ph * 0.34)}px Inter`;
          const iw = ctx.measureText(it.icon).width;
          ctx.font = `600 ${Math.round(s)}px Inter`;
          const vw = ctx.measureText(it.value).width;
          ctx.font = `500 ${Math.round(s)}px Inter`;
          const uw = ctx.measureText(it.unit).width;
          return { iw, vw, uw, total: iw + s * 0.5 + vw + s * 0.28 + uw };
        };
        const avail = pw - padX * 2;
        let m = meas(fs);
        while (fs > ph * 0.16 && m.total > avail) {
          fs *= 0.92;
          m = meas(fs);
        }
        const sx = px + (pw - m.total) / 2;
        ctx.textAlign = "left";
        ctx.font = `500 ${Math.round(ph * 0.34)}px Inter`;
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillText(it.icon, sx, py + ph * 0.5);
        ctx.font = `600 ${Math.round(fs)}px Inter`;
        ctx.fillStyle = "#fff";
        ctx.fillText(it.value, sx + m.iw + fs * 0.5, py + ph * 0.5);
        ctx.font = `500 ${Math.round(fs)}px Inter`;
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(it.unit, sx + m.iw + fs * 0.5 + m.vw + fs * 0.28, py + ph * 0.52);
      });
    },
  };

  function paintStyle(ctx, style, x, y, w, h, data) {
    const fn = PAINTERS[style];
    if (fn) fn(ctx, Object.assign({ x, y, w, h }, data));
  }

  return { buildOverlayDOM, buildValueDOM, rasterize, captureFrame, paintFrame,
           paintStyle, zoneColor,
           drawMapCanvas, drawTrackCanvas, drawRouteCanvas,
           fontFaceCSS, measure };
})();
