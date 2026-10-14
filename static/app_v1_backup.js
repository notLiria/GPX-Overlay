/* GPX Overlay Studio — frontend */
"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  meta: null, telemetry: null, widgets: [], selected: null,
  t: 6.5, syncOffsetMs: 0, jobId: null, pollTimer: null,
};

const GLYPH = {
  speed: "◉", heartrate: "♥", cadence: "⚙", duration: "⏱",
  elevation: "⛰", distance: "↔", time: "◷", avgspeed: "⇶",
  grade: "⊿", maxspeed: "⇱", temperature: "❄", power: "⚡",
};

const DEFAULT_UNITS = {
  speed: "kph", avgspeed: "kph", maxspeed: "kph", heartrate: "bpm",
  cadence: "trpermin", elevation: "m", distance: "km",
  temperature: "C", power: "watt",
};
const UNIT_OPTIONS = {
  speed: ["kph", "mph", "mps"], avgspeed: ["kph", "mph", "mps"],
  maxspeed: ["kph", "mph", "mps"], heartrate: ["bpm"],
  cadence: ["trpermin"], elevation: ["m", "ft"], distance: ["km", "miles"],
  temperature: ["C", "F"], power: ["watt"],
};
const VALUE_TYPES = ["speed", "heartrate", "cadence", "duration",
  "elevation", "distance", "time", "avgspeed", "grade", "maxspeed",
  "temperature", "power"];

function widget(type, over = {}) {
  const w = {
    id: "w" + Math.random().toString(36).slice(2, 8),
    type, label: (type === "map" ? "MAP" : type === "track" ? "TRACK" : type.toUpperCase()),
    display: true, x: 20, y: 20, w: 320, h: 90,
    margin: 12, padding: 6,
    unit: DEFAULT_UNITS[type] || "", format: "",
    label_size: 15, value_size: 32, unit_size: 18, value_weight: "bold",
    label_color: "#ffffff", value_color: "#ffffff", unit_color: "#ffffff",
    icon_color: "#ffffff", bg_color: "#000000", bg_opacity: 0.33,
    round_corner: 10, shadow: 3, value_align: "left",
    show_label: true, show_value: true, show_unit: true, show_icon: true,
    source: 1, zoom: 13, factor: 2, border: 3, border_color: "#000000",
  };
  return Object.assign(w, over);
}

const PRESETS = {
  ride() {
    const W = vid().w, H = vid().h;
    return [
      widget("speed", { x: 20, y: Math.round(H * .23), w: 320, h: 90 }),
      widget("heartrate", { x: 20, y: Math.round(H * .23) + 100, w: 320, h: 90 }),
      widget("cadence", { x: 20, y: Math.round(H * .23) + 200, w: 320, h: 90 }),
      widget("duration", { x: W - 340, y: Math.round(H * .23), w: 320, h: 90 }),
      widget("elevation", { x: W - 340, y: Math.round(H * .23) + 100, w: 320, h: 90 }),
      widget("distance", { x: W - 340, y: Math.round(H * .23) + 200, w: 320, h: 90 }),
      widget("track", { x: 50, y: 20, w: W - 100, h: 110 }),
      widget("map", { x: Math.round((W - 340) / 2), y: H - 360, w: 340, h: 340 }),
    ];
  },
  pills() {
    const W = vid().w, H = vid().h;
    const bw = Math.round((W - 45) / 4), y = H - 110;
    const mk = (t, i) => widget(t, {
      x: 15 + i * (bw + 5), y, w: bw, h: 84, show_label: false,
      value_align: "center", show_icon: false, value_size: 30, unit_size: 15,
    });
    return [
      mk("speed", 0), mk("heartrate", 1), mk("duration", 2), mk("distance", 3),
      widget("map", { x: 15, y: H - 440, w: 300, h: 300 }),
      widget("track", { x: 15, y: 20, w: W - 30, h: 90 }),
    ];
  },
  corners() {
    const W = vid().w, H = vid().h;
    return [
      widget("speed", { x: 20, y: 30, w: 300, h: 88 }),
      widget("heartrate", { x: 20, y: 130, w: 300, h: 88 }),
      widget("elevation", { x: W - 320, y: 30, w: 300, h: 88 }),
      widget("distance", { x: W - 320, y: 130, w: 300, h: 88 }),
      widget("map", { x: 20, y: H - 340, w: 300, h: 300 }),
    ];
  },
  minimal() {
    const W = vid().w, H = vid().h;
    return [
      widget("speed", {
        x: 30, y: 40, w: 300, h: 84, bg_color: "", show_label: false,
        show_icon: false, value_size: 44,
      }),
      widget("track", {
        x: Math.round(W * .07), y: H - 140, w: Math.round(W * .86), h: 110,
      }),
    ];
  },
};

const vid = () => (state.meta && state.meta.video) || { w: 720, h: 1280, duration: 10 };

/* ---------------------------------------------------------- telemetry */
function sampleAt(tSec) {
  const pts = state.telemetry ? state.telemetry.points : null;
  if (!pts || !pts.length) return { speed: 0, hr: 0, cad: 0, ele: 0, dist: 0, grade: 0 };
  const t = Math.max(0, Math.min(tSec, pts[pts.length - 1].rel));
  let i = pts.findIndex(p => p.rel >= t);
  if (i <= 0) i = 1;
  if (i >= pts.length) i = pts.length - 1;
  const a = pts[i - 1], b = pts[i];
  const f = b.rel > a.rel ? (t - a.rel) / (b.rel - a.rel) : 0;
  const L = (x, y) => (x == null || y == null) ? (x ?? y) : x + (y - x) * f;
  return {
    speed: L(a.speed, b.speed), hr: L(a.hr, b.hr), cad: L(a.cad, b.cad),
    ele: L(a.ele, b.ele), dist: L(a.dist, b.dist), grade: L(a.grade, b.grade),
  };
}

function fmtVal(w, t) {
  const s = sampleAt(t);
  switch (w.type) {
    case "speed": case "avgspeed": case "maxspeed": {
      const v = w.type === "avgspeed" ? (t > 0.2 ? s.dist / t : 0) : s.speed;
      const f = w.unit === "mph" ? 2.236936 : w.unit === "mps" ? 1 : 3.6;
      return (v * f).toFixed(1);
    }
    case "heartrate": return String(Math.round(s.hr || 0));
    case "cadence": return String(Math.round(s.cad || 0));
    case "elevation": return String(Math.round(w.unit === "ft" ? s.ele * 3.28084 : s.ele));
    case "distance": {
      const v = w.unit === "miles" ? s.dist / 1609.344 : s.dist / 1000;
      return v.toFixed(2);
    }
    case "duration": return hms(t);
    case "time": {
      const d = new Date((state.telemetry.t0 + t) * 1000);
      return d.toTimeString().slice(0, 8);
    }
    case "grade": return (s.grade || 0).toFixed(1);
    case "temperature": return s.temp != null ? String(Math.round(s.temp)) : "--";
    case "power": return s.power != null ? String(Math.round(s.power)) : "--";
    default: return "0";
  }
}
function hms(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function unitLabel(w) {
  const map = { kph: "km/h", mph: "mph", mps: "m/s", bpm: "bpm", trpermin: "tr/min",
    m: "m", ft: "ft", km: "km", miles: "mi", C: "°C", F: "°F", watt: "W" };
  return map[w.unit] || w.unit || "";
}

/* ---------------------------------------------------------- stage render */
function stageScale() {
  return $("stage").clientWidth / vid().w;
}
function renderStage() {
  const stage = $("stage");
  const V = vid();
  stage.querySelectorAll(".wbox").forEach(el => el.remove());
  const scale = stageScale();
  for (const w of state.widgets) {
    const box = document.createElement("div");
    box.className = "wbox" + (state.selected === w.id ? " selected" : "") +
      (w.display ? "" : " hidden-widget");
    box.style.cssText =
      `left:${w.x * scale}px;top:${w.y * scale}px;width:${w.w * scale}px;height:${w.h * scale}px`;
    if (w.type === "map" || w.type === "track") {
      box.style.borderStyle = "solid";
    } else {
      const inner = document.createElement("div");
      inner.className = "inner";
      const alpha = Math.round((w.bg_opacity ?? 0.33) * 255).toString(16).padStart(2, "0");
      inner.style.background = w.bg_color ? w.bg_color + alpha : "transparent";
      inner.style.borderRadius = (w.round_corner || 0) * scale + "px";
      inner.style.color = w.value_color || "#fff";
      const fs = Math.max(8, w.value_size * scale);
      if (w.show_icon) {
        const ic = document.createElement("span");
        ic.className = "ic";
        ic.textContent = GLYPH[w.type] || "•";
        ic.style.cssText = `background:none;font-size:${fs * .8}px;color:${w.icon_color}`;
        inner.appendChild(ic);
      }
      const col = document.createElement("div");
      col.style.cssText = "display:flex;flex-direction:column;align-items:" +
        (w.value_align === "center" ? "center" : w.value_align === "right" ? "flex-end" : "flex-start") +
        ";min-width:0";
      if (w.show_label && w.label) {
        const l = document.createElement("div");
        l.className = "lbl";
        l.textContent = w.label;
        l.style.cssText = `font-size:${Math.max(7, w.label_size * scale)}px;color:${w.label_color};text-shadow:0 0 ${w.shadow * scale}px #000`;
        col.appendChild(l);
      }
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:baseline;gap:4px";
      if (w.show_value) {
        const v = document.createElement("span");
        v.className = "val";
        v.textContent = fmtVal(w, state.t);
        v.style.cssText = `font-size:${fs}px;font-weight:${w.value_weight};text-shadow:0 0 ${w.shadow * scale}px #000`;
        row.appendChild(v);
      }
      if (w.show_unit && w.unit) {
        const u = document.createElement("span");
        u.className = "un";
        u.textContent = unitLabel(w);
        u.style.cssText = `font-size:${Math.max(7, w.unit_size * scale)}px;color:${w.unit_color};text-shadow:0 0 ${w.shadow * scale}px #000`;
        row.appendChild(u);
      }
      col.appendChild(row);
      inner.appendChild(col);
      box.appendChild(inner);
    }
    const rz = document.createElement("div");
    rz.className = "resize";
    box.appendChild(rz);
    box.addEventListener("pointerdown", (e) => startDrag(e, w, box));
    rz.addEventListener("pointerdown", (e) => startResize(e, w, box));
    stage.appendChild(box);
  }
  positionOverlayCanvas();
  drawMap();
  drawTrack();
}

function positionOverlayCanvas() {
  const scale = stageScale();
  for (const w of state.widgets) {
    const el = $(w.type === "map" ? "mapCanvas" : w.type === "track" ? "trackCanvas" : null);
    if (!el) continue;
    el.style.left = w.x * scale + "px";
    el.style.top = w.y * scale + "px";
    el.style.width = w.w * scale + "px";
    el.style.height = w.h * scale + "px";
    el.style.display = w.display ? "block" : "none";
    el.width = w.w; el.height = w.h;
    el.dataset.wid = w.id;
  }
}

function drawMap() {
  const w = state.widgets.find(q => q.type === "map" && q.display);
  const cv = $("mapCanvas");
  if (!w || !state.telemetry) { cv.style.display = "none"; return; }
  const ctx = cv.getContext("2d");
  const pts = state.telemetry.points;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "rgba(240,240,235,.9)";
  ctx.fillRect(0, 0, cv.width, cv.height);
  const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map(p => p.lon * kx), ys = pts.map(p => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 14;
  const sc = Math.min((cv.width - 2 * pad) / (maxX - minX || 1e-9),
    (cv.height - 2 * pad) / (maxY - minY || 1e-9));
  const px = p => pad + (p.lon * kx - minX) * sc;
  const py = p => pad + (-p.lat - minY) * sc;
  ctx.strokeStyle = "#e8542a"; ctx.lineWidth = 4; ctx.lineJoin = "round";
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(px(p), py(p)) : ctx.moveTo(px(p), py(p)));
  ctx.stroke();
  const cur = samplePointAt(state.t);
  if (cur) {
    ctx.fillStyle = "#1a73e8";
    ctx.beginPath(); ctx.arc(px(cur), py(cur), 7, 0, 7); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
  }
  if (w.border) {
    ctx.strokeStyle = w.border_color || "#000"; ctx.lineWidth = w.border;
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2,
      cv.width - ctx.lineWidth, cv.height - ctx.lineWidth);
  }
}
function samplePointAt(tSec) {
  const pts = state.telemetry ? state.telemetry.points : null;
  if (!pts || !pts.length) return null;
  const t = Math.max(0, Math.min(tSec, pts[pts.length - 1].rel));
  let i = pts.findIndex(p => p.rel >= t);
  if (i < 0) i = pts.length - 1;
  return pts[i];
}

function drawTrack() {
  const w = state.widgets.find(q => q.type === "track" && q.display);
  const cv = $("trackCanvas");
  if (!w || !state.telemetry) { cv.style.display = "none"; return; }
  const ctx = cv.getContext("2d");
  const pts = state.telemetry.points;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillRect(0, 0, cv.width, cv.height);
  const eles = pts.map(p => p.ele);
  const minE = Math.min(...eles), maxE = Math.max(...eles);
  const span = (maxE - minE) || 1;
  const px = p => 8 + (p.rel / (pts[pts.length - 1].rel || 1)) * (cv.width - 16);
  const py = p => cv.height - 12 - ((p.ele - minE) / span) * (cv.height - 26);
  ctx.beginPath();
  ctx.moveTo(px(pts[0]), cv.height - 8);
  pts.forEach(p => ctx.lineTo(px(p), py(p)));
  ctx.lineTo(px(pts[pts.length - 1]), cv.height - 8);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,.28)"; ctx.fill();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(px(p), py(p)) : ctx.moveTo(px(p), py(p)));
  ctx.stroke();
  const cur = samplePointAt(state.t);
  if (cur) {
    const x = px(cur);
    ctx.strokeStyle = "#ff6b35"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, cv.height - 6); ctx.stroke();
    ctx.fillStyle = "#ff6b35";
    ctx.beginPath(); ctx.arc(x, py(cur), 5, 0, 7); ctx.fill();
  }
  if (w.border) {
    ctx.strokeStyle = w.border_color || "#000"; ctx.lineWidth = w.border;
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2,
      cv.width - ctx.lineWidth, cv.height - ctx.lineWidth);
  }
}

/* ---------------------------------------------------------- drag & resize */
function startDrag(e, w, box) {
  e.preventDefault();
  selectWidget(w.id);
  const scale = stageScale();
  const sx = e.clientX, sy = e.clientY, ox = w.x, oy = w.y;
  const move = (ev) => {
    w.x = snap(ox + (ev.clientX - sx) / scale);
    w.y = snap(oy + (ev.clientY - sy) / scale);
    const V = vid();
    w.x = Math.max(0, Math.min(w.x, V.w - w.w));
    w.y = Math.max(0, Math.min(w.y, V.h - w.h));
    box.style.left = w.x * scale + "px";
    box.style.top = w.y * scale + "px";
    positionOverlayCanvas(); drawMap(); drawTrack();
    updatePosFields(w);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    renderAll();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
function startResize(e, w, box) {
  e.preventDefault(); e.stopPropagation();
  selectWidget(w.id);
  const scale = stageScale();
  const sx = e.clientX, sy = e.clientY, ow = w.w, oh = w.h;
  const move = (ev) => {
    w.w = Math.max(60, snap(ow + (ev.clientX - sx) / scale));
    w.h = Math.max(40, snap(oh + (ev.clientY - sy) / scale));
    box.style.width = w.w * scale + "px";
    box.style.height = w.h * scale + "px";
    positionOverlayCanvas(); drawMap(); drawTrack();
    updatePosFields(w);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    renderAll();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
const snap = (v) => Math.round(v / 10) * 10;

/* ---------------------------------------------------------- widget list */
function renderWidgetList() {
  const ul = $("widgetList");
  ul.innerHTML = "";
  const has = (state.telemetry && state.telemetry.has) || {};
  for (const w of state.widgets) {
    const li = document.createElement("li");
    if (state.selected === w.id) li.className = "selected";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!w.display;
    cb.addEventListener("change", () => { w.display = cb.checked; renderAll(); });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = w.label || w.type;
    let note = "";
    if (w.type === "heartrate" && has.hr === false) note = "no data";
    if (w.type === "cadence" && has.cad === false) note = "no data";
    if (w.type === "power" && has.power === false) note = "no data";
    const nd = document.createElement("span");
    nd.className = "no-data"; nd.textContent = note;
    const order = document.createElement("span");
    order.className = "order";
    const up = document.createElement("button"); up.textContent = "▲";
    const dn = document.createElement("button"); dn.textContent = "▼";
    up.addEventListener("click", (e) => { e.stopPropagation(); moveWidget(w.id, -1); });
    dn.addEventListener("click", (e) => { e.stopPropagation(); moveWidget(w.id, 1); });
    order.append(up, dn);
    li.append(cb, name, nd, order);
    li.addEventListener("click", () => selectWidget(w.id));
    ul.appendChild(li);
  }
}
function moveWidget(id, dir) {
  const i = state.widgets.findIndex(w => w.id === id);
  const j = i + dir;
  if (j < 0 || j >= state.widgets.length) return;
  [state.widgets[i], state.widgets[j]] = [state.widgets[j], state.widgets[i]];
  renderAll();
}
function selectWidget(id) {
  state.selected = id;
  renderAll();
}

/* ---------------------------------------------------------- appearance panel */
function renderAppt() {
  const w = state.widgets.find(q => q.id === state.selected);
  const body = $("apptBody");
  $("apptTitle").textContent = w ? `Appearance · ${w.label || w.type}` : "Appearance";
  if (!w) {
    body.innerHTML = '<p class="hint">Select a widget to edit its appearance and position.</p>';
    return;
  }
  const field = (label, inner) =>
    `<div class="field"><label>${label}</label>${inner}</div>`;
  const num = (key, val, step = 1) =>
    `<input type="number" data-k="${key}" value="${val}" step="${step}">`;
  const color = (key, val) =>
    `<div class="swatch-row"><input type="color" data-k="${key}" value="${val || "#ffffff"}">` +
    `<span class="hint mono">${val || "none"}</span></div>`;
  const sel = (key, val, opts) =>
    `<select data-k="${key}">${opts.map(o =>
      `<option value="${o}" ${o === val ? "selected" : ""}>${o}</option>`).join("")}</select>`;

  let html = "";
  if (w.type === "map") {
    html += field("Map source", sel("source", String(w.source),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]));
    html += `<div class="hint" style="margin:-4px 0 8px">1=OSM 3=OpenCycle 4=Topo 6-8=Google 9-11=VirtualEarth 12=IGN</div>`;
    html += `<div class="row2">${field("Zoom", num("zoom", w.zoom))}${field("Factor", num("factor", w.factor, 0.5))}</div>`;
    html += `<div class="row2">${field("Border", num("border", w.border))}${field("Border color", color("border_color", w.border_color))}</div>`;
  } else if (w.type === "track") {
    html += `<div class="row2">${field("Border", num("border", w.border))}${field("Border color", color("border_color", w.border_color))}</div>`;
    html += field("Background", color("bg_color", w.bg_color)) +
      field("Background opacity", `<input type="range" data-k="bg_opacity" min="0" max="1" step="0.05" value="${w.bg_opacity}">`);
  } else {
    html += field("Label text", `<input type="text" data-k="label" value="${w.label}">`);
    html += `<div class="row2">${field("Unit", sel("unit", w.unit, UNIT_OPTIONS[w.type] || [w.unit]))}${field("Value format", `<input type="text" data-k="format" placeholder="e.g. 0.0" value="${w.format || ""}">`)}</div>`;
    html += `<div class="field check">
      <label><input type="checkbox" data-k="show_label" ${w.show_label ? "checked" : ""}> label</label>
      <label><input type="checkbox" data-k="show_value" ${w.show_value ? "checked" : ""}> value</label>
      <label><input type="checkbox" data-k="show_unit" ${w.show_unit ? "checked" : ""}> unit</label>
      <label><input type="checkbox" data-k="show_icon" ${w.show_icon ? "checked" : ""}> icon</label>
    </div>`;
    html += `<div class="row4">
      ${field("Value px", num("value_size", w.value_size))}
      ${field("Label px", num("label_size", w.label_size))}
      ${field("Unit px", num("unit_size", w.unit_size))}
      ${field("Weight", sel("value_weight", w.value_weight, ["normal", "bold"]))}
    </div>`;
    html += `<div class="row2">
      ${field("Value color", color("value_color", w.value_color))}
      ${field("Label color", color("label_color", w.label_color))}
    </div>`;
    html += `<div class="row2">
      ${field("Unit color", color("unit_color", w.unit_color))}
      ${field("Icon color", color("icon_color", w.icon_color))}
    </div>`;
    html += field("Value align", sel("value_align", w.value_align, ["left", "center", "right"]));
    html += field("Text shadow", `<input type="range" data-k="shadow" min="0" max="10" step="1" value="${w.shadow}">`);
    html += field("Background", color("bg_color", w.bg_color)) +
      field("Background opacity", `<input type="range" data-k="bg_opacity" min="0" max="1" step="0.05" value="${w.bg_opacity}">`) +
      field("Corner radius", num("round_corner", w.round_corner));
  }
  html += `<div class="sep"></div><div class="hint">— position & size —</div>`;
  html += `<div class="row4">
    ${field("x", num("x", w.x))}${field("y", num("y", w.y))}
    ${field("width", num("w", w.w))}${field("height", num("h", w.h))}
  </div>`;
  html += `<div class="row2">
    ${field("Margin", num("margin", w.margin))}${field("Padding", num("padding", w.padding))}
  </div>`;
  html += `<div class="appt-actions">
    <button class="ghost" data-act="reset">reset widget</button>
    <button class="ghost" data-act="duplicate">duplicate</button>
    <button class="ghost" data-act="delete">delete</button>
  </div>`;
  body.innerHTML = html;

  body.querySelectorAll("input,select").forEach(el => {
    const handler = () => {
      const k = el.dataset.k;
      if (!k) return;
      let v = el.type === "checkbox" ? el.checked :
        el.type === "number" || el.type === "range" ? parseFloat(el.value) : el.value;
      if (el.type === "color") {
        w[k] = v;
        el.parentElement.querySelector(".hint").textContent = v;
      } else {
        w[k] = v;
      }
      renderStage(); renderWidgetList();
    };
    el.addEventListener(el.type === "range" || el.type === "color" ? "input" : "change", handler);
    if (el.type === "text" || el.type === "number") el.addEventListener("input", handler);
  });
  body.querySelectorAll("[data-act]").forEach(b => {
    b.addEventListener("click", () => {
      const act = b.dataset.act;
      const i = state.widgets.findIndex(q => q.id === w.id);
      if (act === "reset") state.widgets[i] = widget(w.type, { id: w.id });
      if (act === "duplicate") {
        const copy = JSON.parse(JSON.stringify(w));
        copy.id = "w" + Math.random().toString(36).slice(2, 8);
        copy.x += 30; copy.y += 30;
        state.widgets.splice(i + 1, 0, copy);
        state.selected = copy.id;
      }
      if (act === "delete") {
        state.widgets.splice(i, 1);
        state.selected = null;
      }
      renderAll();
    });
  });
}
function updatePosFields(w) {
  for (const k of ["x", "y", "w", "h"]) {
    const el = document.querySelector(`#apptBody [data-k="${k}"]`);
    if (el) el.value = Math.round(w[k]);
  }
}

/* ---------------------------------------------------------- upload & render */
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}

async function uploadFiles() {
  const vf = $("videoInput").files[0], gf = $("gpxInput").files[0];
  if (!vf || !gf) return toast("Pick both a video and a GPX file first");
  const fd = new FormData();
  fd.append("video", vf);
  fd.append("gpx", gf);
  $("fileStatus").textContent = "uploading & parsing…";
  try {
    const r = await fetch("/api/projects", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    state.meta = await r.json();
    const tr = await fetch(`/api/projects/${state.meta.id}/telemetry`);
    state.telemetry = await tr.json();
    $("poster").src = `/api/projects/${state.meta.id}/poster?t=${Date.now()}`;
    $("fileStatus").textContent =
      `${state.meta.video.name} · ${state.meta.video.w}×${state.meta.video.h} · ` +
      `${state.meta.video.duration.toFixed(1)}s · ${state.meta.gpx.points} pts`;
    state.widgets = PRESETS[$("presetSelect").value]();
    state.selected = null;
    fitStage();
    renderAll();
  } catch (e) {
    $("fileStatus").textContent = "upload failed";
    toast("Upload failed: " + e.message);
  }
}

function fitStage() {
  const V = vid();
  const wrap = document.querySelector(".preview-wrap");
  const maxW = Math.min(wrap.clientWidth || 560, 560);
  const scale = maxW / V.w;
  const stage = $("stage");
  stage.style.width = maxW + "px";
  stage.style.height = Math.round(V.h * scale) + "px";
}

function currentLayout() {
  return { widgets: state.widgets.map(w => ({ ...w })) };
}

async function doRender() {
  if (!state.meta) return toast("Load a video + GPX first");
  const r = await fetch(`/api/projects/${state.meta.id}/render`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout: currentLayout(), sync_offset_ms: state.syncOffsetMs }),
  });
  const d = await r.json();
  if (!r.ok) return toast("Render failed to start: " + (d.detail || r.status));
  state.jobId = d.job;
  $("renderBar").classList.remove("hidden");
  $("resultRow").classList.add("hidden");
  pollJob();
}

function pollJob() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    const r = await fetch(`/api/jobs/${state.jobId}`);
    if (!r.ok) return;
    const j = await r.json();
    const pct = j.total ? Math.round(100 * j.frames / j.total) : 0;
    $("renderFill").style.width = pct + "%";
    $("renderText").textContent =
      j.status === "running" ? `rendering ${pct}% · frame ${j.frames}/${j.total}` :
      j.status === "done" ? "done ✓" : `${j.status} — ${j.error || ""}`;
    if (j.status === "done" || j.status === "failed") {
      clearInterval(state.pollTimer);
      if (j.status === "done") {
        const url = `/api/jobs/${state.jobId}/result?t=${Date.now()}`;
        $("resultVideo").src = url;
        $("resultDownload").href = url + "&download=1";
        $("resultRow").classList.remove("hidden");
      } else {
        toast("Render failed: " + j.error);
      }
    }
  }, 700);
}

async function doPixelPreview() {
  if (!state.meta) return toast("Load a video + GPX first");
  toast("Rendering pixel-true preview…");
  const r = await fetch(`/api/projects/${state.meta.id}/frame`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      layout: currentLayout(),
      t_ms: Math.round(state.t * 1000),
      sync_offset_ms: state.syncOffsetMs,
    }),
  });
  if (!r.ok) return toast("Preview failed: " + await r.text());
  const blob = await r.blob();
  $("pixelImg").src = URL.createObjectURL(blob);
  $("pixelPreview").classList.remove("hidden");
}

/* ---------------------------------------------------------- wiring */
function renderAll() {
  renderStage();
  renderWidgetList();
  renderAppt();
}

window.addEventListener("DOMContentLoaded", () => {
  state.widgets = PRESETS.ride();
  fitStage();
  renderAll();

  $("videoInput").addEventListener("change", uploadFiles);
  $("gpxInput").addEventListener("change", uploadFiles);
  $("presetSelect").addEventListener("change", () => {
    if (!state.meta) return;
    state.widgets = PRESETS[$("presetSelect").value]();
    state.selected = null;
    renderAll();
  });
  $("btnAddWidget").addEventListener("click", () => {
    const types = [...VALUE_TYPES, "map", "track"];
    const t = prompt("Widget type:\n" + types.join(", "), "heartrate");
    if (!t) return;
    const w = widget(t.trim());
    w.x = 40; w.y = 40;
    state.widgets.push(w);
    selectWidget(w.id);
  });
  $("scrub").addEventListener("input", () => {
    state.t = ($("scrub").value / 1000) * (vid().duration || 10);
    $("scrubTime").textContent = `t = ${state.t.toFixed(2)}s`;
    renderStage();
  });
  $("btnBack").addEventListener("click", () => {
    state.t = Math.max(0, state.t - 0.5);
    $("scrub").value = 1000 * state.t / (vid().duration || 10);
    $("scrubTime").textContent = `t = ${state.t.toFixed(2)}s`;
    renderStage();
  });
  $("btnFwd").addEventListener("click", () => {
    state.t = Math.min(vid().duration || 10, state.t + 0.5);
    $("scrub").value = 1000 * state.t / (vid().duration || 10);
    $("scrubTime").textContent = `t = ${state.t.toFixed(2)}s`;
    renderStage();
  });
  $("syncOffset").addEventListener("input", () => {
    state.syncOffsetMs = parseInt($("syncOffset").value || "0", 10);
    renderStage();
  });
  $("btnRender").addEventListener("click", doRender);
  $("btnFrame").addEventListener("click", doPixelPreview);
  $("btnClosePixel").addEventListener("click", () => $("pixelPreview").classList.add("hidden"));
  $("btnNewJob").addEventListener("click", () => {
    $("resultRow").classList.add("hidden");
    $("renderBar").classList.add("hidden");
  });
  window.addEventListener("resize", () => { fitStage(); renderStage(); });
});
