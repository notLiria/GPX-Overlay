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
  temperature: "C", power: "watt", grade: "percent", verticalspeed: "meterperhour",
};
const UNIT_OPTIONS = {
  speed: ["kph", "mph", "mps"], avgspeed: ["kph", "mph", "mps"],
  maxspeed: ["kph", "mph", "mps"], heartrate: ["bpm"],
  cadence: ["trpermin"], elevation: ["m", "ft"], distance: ["km", "miles"],
  temperature: ["C", "F"], power: ["watt"], grade: ["percent"],
  verticalspeed: ["meterperhour", "feetpermin"],
};
const VALUE_TYPES = ["speed", "heartrate", "cadence", "duration",
  "elevation", "distance", "time", "avgspeed", "grade", "maxspeed",
  "temperature", "power"];
const STYLE_OPTIONS = [
  ["text", "text (label + value)"],
  ["big", "big number (unit above)"],
  ["arc", "arc gauge"],
  ["bar", "bar (horizontal)"],
  ["barv", "bar (vertical)"],
  ["tach", "gauge · tach (zone sweep)"],
  ["ledbar", "gauge · LED bar (shift lights)"],
  ["gearbox", "gauge · gear cube (7-seg)"],
  ["delta", "gauge · delta bar (center zero)"],
  ["trace", "gauge · trace (sparkline)"],
  ["ring", "gauge · ring (progress)"],
  ["pillrow", "gauge · pill (icon cluster)"],
];
/* What the gpx2video engine can actually draw per widget type
   (verified from its source; anything else falls back to text). */
const ENGINE_SHAPES = {
  speed: ["text", "arc"], time: ["text", "arc"],
  distance: ["text", "bar"], elevation: ["text", "bar", "chart"],
  verticalspeed: ["text", "bar"],
};
const STYLE_SHAPE = { text: "text", big: "text", arc: "arc", bar: "bar", barv: "bar", chart: "chart" };
function stylesFor(type) {
  // The compositor (overlay.py) draws every style for every metric;
  // the ENGINE_SHAPES map above is kept for documentation only.
  return STYLE_OPTIONS;
}
const THEMES = {
  white:  { primary: "#ffffff", secondary: "#ffffff55", label: "#e8eaf0",
            value: "#ffffff", unit: "#ffffffcc", icon: "#ffffff" },
  strava: { primary: "#fc4c02", secondary: "#fc4c0266", label: "#ffd9c7",
            value: "#ffffff", unit: "#ffb394", icon: "#fc4c02" },
  cyan:   { primary: "#22d3ee", secondary: "#22d3ee55", label: "#b6f0fa",
            value: "#ffffff", unit: "#9ee8f5", icon: "#22d3ee" },
  lime:   { primary: "#a3e635", secondary: "#a3e63555", label: "#e2f7c3",
            value: "#ffffff", unit: "#d3f296", icon: "#a3e635" },
  gold:   { primary: "#fbbf24", secondary: "#fbbf2455", label: "#fce8b2",
            value: "#ffffff", unit: "#f8d477", icon: "#fbbf24" },
};

function widget(type, over = {}) {
  const isSpecial = ["map", "track", "gpx"].includes(type);
  const t = THEMES.white;
  const w = {
    id: "w" + Math.random().toString(36).slice(2, 8),
    type,
    label: (type === "map" ? "MAP" : type === "track" ? "ELEVATION"
      : type === "gpx" ? "ROUTE" : type.toUpperCase()),
    display: true, x: 20, y: 20, w: 300, h: 100,
    margin: 12, padding: 6,
    style: isSpecial ? "" : "text",
    theme: "white",
    font_family: "Orbitron",
    unit: DEFAULT_UNITS[type] || "", format: "",
    label_size: 16, value_size: 42, unit_size: 18, value_weight: "bold",
    label_color: t.label, value_color: t.value, unit_color: t.unit,
    icon_color: t.icon, primary_color: t.primary, secondary_color: t.secondary,
    bg_color: "", bg_opacity: 0.33,
    round_corner: 10, shadow: 3, value_align: "left",
    show_label: true, show_value: true, show_unit: true, show_icon: false,
    gauge_width: 14, gauge_angle: 270, gauge_rotation: 0,
    auto_range: true, value_min: 0, value_max: 100,
    source: 1, zoom: 13, factor: 2, border: 3, border_color: "#000000",
  };
  return Object.assign(w, over);
}

const PRESETS = {
  gpxoverlay() {
    const W = vid().w, H = vid().h, k = W / 720;
    return [
      widget("gpx", { x: 40 * k, y: 50 * k, w: 420 * k, h: 150 * k,
        gauge_width: 5 }),
      widget("speed", { x: 40 * k, y: 250 * k, w: 300 * k, h: 90 * k,
        style: "text", label: "KPH", value_size: 64, label_size: 18 }),
      widget("grade", { x: 40 * k, y: 360 * k, w: 300 * k, h: 90 * k,
        style: "text", label: "% GRADE", unit: "", value_size: 56 }),
      widget("heartrate", { x: 40 * k, y: 470 * k, w: 300 * k, h: 90 * k,
        style: "text", label: "HR", unit: "", value_size: 56 }),
      widget("elevation", { x: 370 * k, y: 240 * k, w: 110 * k, h: 300 * k,
        style: "barv", label: "ELEV", unit: "m", value_size: 26, show_icon: false }),
      widget("verticalspeed", { x: 370 * k, y: 580 * k, w: 310 * k, h: 110 * k,
        style: "bar", label: "CLIMB", unit: "meterperhour", value_size: 36 }),
      widget("speed", { x: 480 * k, y: 70 * k, w: 230 * k, h: 230 * k,
        style: "arc", label: "KPH", unit: "kph", value_size: 54,
        show_icon: false }),
      widget("speed", { x: 480 * k, y: 340 * k, w: 230 * k, h: 230 * k,
        style: "arc", label: "MPH", unit: "mph", value_size: 50,
        show_icon: false }),
      widget("track", { x: 40 * k, y: 760 * k, w: 560 * k, h: 240 * k }),
    ];
  },
  ride() {
    const W = vid().w, H = vid().h;
    return [
      widget("speed", { x: 20, y: Math.round(H * .23), w: 320, h: 90, style: "text" }),
      widget("heartrate", { x: 20, y: Math.round(H * .23) + 100, w: 320, h: 90, style: "text" }),
      widget("cadence", { x: 20, y: Math.round(H * .23) + 200, w: 320, h: 90, style: "text" }),
      widget("duration", { x: W - 340, y: Math.round(H * .23), w: 320, h: 90, style: "text" }),
      widget("elevation", { x: W - 340, y: Math.round(H * .23) + 100, w: 320, h: 90, style: "text" }),
      widget("distance", { x: W - 340, y: Math.round(H * .23) + 200, w: 320, h: 90, style: "text" }),
      widget("track", { x: 50, y: 20, w: W - 100, h: 110 }),
      widget("map", { x: Math.round((W - 340) / 2), y: H - 360, w: 340, h: 340 }),
    ];
  },
  pills() {
    const W = vid().w, H = vid().h;
    const bw = Math.round((W - 45) / 4), y = H - 110;
    const mk = (t, i) => widget(t, {
      x: 15 + i * (bw + 5), y, w: bw, h: 84, style: "big", show_label: false,
      value_align: "center", value_size: 40, unit_size: 15,
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
      widget("speed", { x: 20, y: 30, w: 280, h: 280, style: "arc", label: "KPH", unit: "" }),
      widget("heartrate", { x: 20, y: 330, w: 280, h: 280, style: "arc", label: "HR", unit: "" }),
      widget("elevation", { x: W - 300, y: 30, w: 280, h: 90, style: "text" }),
      widget("distance", { x: W - 300, y: 130, w: 280, h: 90, style: "text" }),
      widget("map", { x: 20, y: H - 340, w: 300, h: 300 }),
    ];
  },
  minimal() {
    const W = vid().w, H = vid().h;
    return [
      widget("speed", {
        x: 30, y: 40, w: 300, h: 90, style: "big", show_label: false,
        show_unit: true, value_size: 56, bg_color: "",
      }),
      widget("track", {
        x: Math.round(W * .07), y: H - 150, w: Math.round(W * .86), h: 120,
      }),
    ];
  },
  /* ---- motorsport gauge presets (approved sample styles, 2026-10-13) ---- */
  motorsport() {
    const W = vid().w, H = vid().h, k = W / 720;
    return [
      widget("cadence", {
        x: Math.round(W / 2 - 200 * k), y: 26, w: 400 * k, h: 140 * k,
        style: "ledbar", label: "CADENCE", unit: "trpermin",
        font_family: "Rajdhani",
      }),
      widget("heartrate", {
        x: 30, y: H - 300 * k - 30, w: 300 * k, h: 300 * k,
        style: "gearbox", label: "HR", font_family: "DSEG7", show_icon: false,
      }),
      widget("speed", {
        x: W - 300 * k - 30, y: H - 300 * k - 30, w: 300 * k, h: 300 * k,
        style: "tach", label: "SPEED", unit: "kph",
        font_family: "Rajdhani", show_icon: false,
      }),
    ];
  },
  rally() {
    const W = vid().w, H = vid().h, k = W / 720;
    const bw = Math.round((W - 60) / 3);
    const mk = (t, i) => widget(t, {
      x: 20 + i * (bw + 10), y: H - 150, w: bw, h: 120,
      style: "pillrow", font_family: "Inter",
    });
    return [
      widget("grade", {
        x: 20, y: 30, w: 320 * k, h: 150 * k, style: "delta",
        label: "GRADE", unit: "percent", font_family: "Rajdhani",
      }),
      widget("speed", {
        x: W - 340 * k - 20, y: 30, w: 340 * k, h: 150 * k,
        style: "trace", label: "SPEED", unit: "kph", font_family: "Inter",
      }),
      mk("speed", 0), mk("heartrate", 1), mk("cadence", 2),
    ];
  },
  gtclean() {
    const W = vid().w, H = vid().h, k = W / 720;
    return [
      widget("track", { x: 20, y: 20, w: W - 40, h: 110 }),
      widget("distance", {
        x: W - 280 * k - 24, y: H - 300 * k - 40, w: 280 * k, h: 280 * k,
        style: "ring", label: "DISTANCE", unit: "km", font_family: "Inter",
        auto_range: false, value_min: 0, value_max: 30,
      }),
      widget("speed", {
        x: 20, y: H - 150, w: 240 * k, h: 120,
        style: "pillrow", font_family: "Inter",
      }),
      widget("heartrate", {
        x: 40 + 240 * k, y: H - 150, w: 240 * k, h: 120,
        style: "pillrow", font_family: "Inter",
      }),
    ];
  },
  racetelem() {
    // Default preset (Liria 2026-10-14): grade delta top-left,
    // HR shift bar top-right, speed tach sweep center-bottom.
    const W = vid().w, H = vid().h, k = W / 720;
    return [
      widget("grade", {
        x: 20, y: 30, w: 330 * k, h: 150 * k, style: "delta",
        label: "GRADE", unit: "percent", font_family: "Rajdhani",
      }),
      widget("heartrate", {
        x: W - 350 * k - 20, y: 30, w: 350 * k, h: 150 * k,
        style: "ledbar", label: "HR", unit: "bpm", font_family: "Rajdhani",
      }),
      widget("speed", {
        x: Math.round(W / 2 - 160 * k), y: H - 330 * k, w: 320 * k, h: 320 * k,
        style: "tach", label: "SPEED", unit: "kph",
        font_family: "Rajdhani", show_icon: false,
      }),
    ];
  },
  cinematic() {
    const W = vid().w, H = vid().h, k = W / 720;
    return [
      widget("distance", {
        x: W - 240 * k - 24, y: 26, w: 240 * k, h: 240 * k,
        style: "ring", label: "DISTANCE", unit: "km", font_family: "Inter",
        auto_range: false, value_min: 0, value_max: 30,
      }),
      widget("speed", {
        x: 30, y: H - 170, w: W - 60, h: 140 * k,
        style: "trace", label: "SPEED", unit: "kph", font_family: "Inter",
      }),
    ];
  },
};

const vid = () => (state.meta && state.meta.video) || { w: 720, h: 1280, duration: 10 };

/* -------------------------------------------- model (canonical: model.js)
   Phase 0: value math lives in static/model.js and is shared by preview
   and export. These are thin adapters binding the shared model to the
   editor's global state; do not add math here. */
const sampleAt = (tSec) => Model.sampleAt(state.telemetry, tSec);
const rawSeries = (w) => Model.rawSeries(w, state.telemetry);
const rangeFor = (w) => Model.rangeFor(w, state.telemetry);
const fmtVal = (w, t) => Model.fmtVal(w, t, state.telemetry);
const hms = (t) => Model.hms(t);
const unitLabel = (w) => Model.unitLabel(w);

/* ---------------------------------------------------------- stage render */
function stageScale() {
  return $("stage").clientWidth / vid().w;
}

function widgetInner(w, scale) {
  const inner = document.createElement("div");
  inner.className = "inner";
  if (w.bg_color) {
    const alpha = Math.round((w.bg_opacity ?? 0.33) * 255).toString(16).padStart(2, "0");
    inner.style.background = w.bg_color + alpha;
    inner.style.borderRadius = (w.round_corner || 0) * scale + "px";
  }
  const sh = `text-shadow:0 0 ${Math.max(1, w.shadow * scale)}px rgba(0,0,0,.9)`;
  const val = fmtVal(w, state.t);
  const uL = unitLabel(w);

  if (w.style === "arc") {
    const cv = document.createElement("canvas");
    const px = Math.max(40, w.h * scale);
    cv.width = px; cv.height = px;
    cv.style.cssText = `width:${px}px;height:${px}px`;
    const [mn, mx] = rangeFor(w);
    const frac = Math.max(0, Math.min(1, (parseFloat(val) - mn) / (mx - mn || 1)));
    const ctx = cv.getContext("2d");
    const lw = (w.gauge_width || 14) * scale * (px / (w.h * scale));
    const r = px / 2 - lw / 2 - 2;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.lineCap = "round";
    ctx.strokeStyle = w.secondary_color;
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(px / 2, px / 2, r, a0, a1); ctx.stroke();
    ctx.strokeStyle = w.primary_color;
    ctx.beginPath(); ctx.arc(px / 2, px / 2, r, a0, a0 + (a1 - a0) * frac); ctx.stroke();
    const center = document.createElement("div");
    center.className = "arc-center";
    if (w.show_label && w.label) {
      const l = document.createElement("div");
      l.className = "lbl";
      l.textContent = w.label;
      l.style.cssText = `font-size:${Math.max(7, w.label_size * scale)}px;color:${w.label_color};${sh}`;
      center.appendChild(l);
    }
    const v = document.createElement("div");
    v.className = "val";
    v.textContent = val;
    v.style.cssText = `font-size:${Math.max(10, w.value_size * scale)}px;font-weight:${w.value_weight};color:${w.value_color};${sh}`;
    center.appendChild(v);
    if (w.show_unit && uL) {
      const u = document.createElement("div");
      u.className = "un";
      u.textContent = uL;
      u.style.cssText = `font-size:${Math.max(7, w.unit_size * scale)}px;color:${w.unit_color};${sh}`;
      center.appendChild(u);
    }
    inner.appendChild(cv);
    inner.appendChild(center);
    return inner;
  }

  if (w.style === "bar" || w.style === "barv") {
    const vert = w.style === "barv";
    inner.classList.add(vert ? "barv-layout" : "bar-layout");
    const head = document.createElement("div");
    head.className = "bar-head";
    if (w.show_label && w.label) {
      const l = document.createElement("div");
      l.className = "lbl";
      l.textContent = w.label;
      l.style.cssText = `font-size:${Math.max(7, w.label_size * scale)}px;color:${w.label_color};${sh}`;
      head.appendChild(l);
    }
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:baseline;gap:4px";
    if (w.show_value) {
      const v = document.createElement("span");
      v.className = "val";
      v.textContent = val;
      v.style.cssText = `font-size:${Math.max(10, w.value_size * scale)}px;font-weight:${w.value_weight};color:${w.value_color};${sh}`;
      row.appendChild(v);
    }
    if (w.show_unit && uL) {
      const u = document.createElement("span");
      u.className = "un";
      u.textContent = uL;
      u.style.cssText = `font-size:${Math.max(7, w.unit_size * scale)}px;color:${w.unit_color};${sh}`;
      row.appendChild(u);
    }
    head.appendChild(row);
    const [mn, mx] = rangeFor(w);
    const frac = Math.max(0, Math.min(1, (parseFloat(val) - mn) / (mx - mn || 1)));
    const barWrap = document.createElement("div");
    barWrap.className = vert ? "bar-v-wrap" : "bar-h-wrap";
    const track = document.createElement("div");
    track.className = vert ? "bar-v-track" : "bar-h-track";
    track.style.background = w.secondary_color;
    const fill = document.createElement("div");
    fill.className = vert ? "bar-v-fill" : "bar-h-fill";
    fill.style.background = w.primary_color;
    if (vert) fill.style.height = frac * 100 + "%";
    else fill.style.width = frac * 100 + "%";
    track.appendChild(fill);
    const lo = document.createElement("span");
    const hi = document.createElement("span");
    lo.className = hi.className = "hint bar-cap";
    lo.textContent = String(Math.round(mn));
    hi.textContent = String(Math.round(mx));
    lo.style.cssText = hi.style.cssText =
      `font-size:${Math.max(7, 11 * scale)}px;color:${w.label_color}`;
    if (vert) {
      const col = document.createElement("div");
      col.className = "bar-v-col";
      col.append(hi, track, lo);
      barWrap.appendChild(col);
      inner.append(head, barWrap);
    } else {
      barWrap.appendChild(track);
      const caps = document.createElement("div");
      caps.className = "bar-caps";
      caps.append(lo, hi);
      barWrap.appendChild(caps);
      inner.append(head, barWrap);
    }
    return inner;
  }

  if (w.style === "big") {
    inner.classList.add("big-layout");
    const col = document.createElement("div");
    if (w.show_unit && uL) {
      const u = document.createElement("div");
      u.className = "un";
      u.textContent = uL;
      u.style.cssText = `font-size:${Math.max(7, w.unit_size * scale)}px;color:${w.unit_color};${sh}`;
      col.appendChild(u);
    }
    if (w.show_label && w.label) {
      const l = document.createElement("div");
      l.className = "lbl";
      l.textContent = w.label;
      l.style.cssText = `font-size:${Math.max(7, w.label_size * scale)}px;color:${w.label_color};${sh}`;
      col.appendChild(l);
    }
    if (w.show_value) {
      const v = document.createElement("div");
      v.className = "val";
      v.textContent = val;
      v.style.cssText = `font-size:${Math.max(12, w.value_size * scale)}px;font-weight:${w.value_weight};color:${w.value_color};${sh}`;
      col.appendChild(v);
    }
    inner.appendChild(col);
    return inner;
  }

  // "text": label small on top, big value + unit below
  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;align-items:" +
    (w.value_align === "center" ? "center" : w.value_align === "right" ? "flex-end" : "flex-start") +
    ";min-width:0";
  if (w.show_label && w.label) {
    const l = document.createElement("div");
    l.className = "lbl";
    l.textContent = w.label;
    l.style.cssText = `font-size:${Math.max(7, w.label_size * scale)}px;color:${w.label_color};${sh}`;
    col.appendChild(l);
  }
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:baseline;gap:5px";
  if (w.show_icon) {
    const ic = document.createElement("span");
    ic.textContent = GLYPH[w.type] || "•";
    ic.style.cssText = `font-size:${w.value_size * scale * .7}px;color:${w.icon_color};${sh}`;
    row.appendChild(ic);
  }
  if (w.show_value) {
    const v = document.createElement("span");
    v.className = "val";
    v.textContent = val;
    v.style.cssText = `font-size:${Math.max(12, w.value_size * scale)}px;font-weight:${w.value_weight};color:${w.value_color};${sh}`;
    row.appendChild(v);
  }
  if (w.show_unit && uL) {
    const u = document.createElement("span");
    u.className = "un";
    u.textContent = uL;
    u.style.cssText = `font-size:${Math.max(7, w.unit_size * scale)}px;color:${w.unit_color};${sh}`;
    row.appendChild(u);
  }
  col.appendChild(row);
  inner.appendChild(col);
  return inner;
}

function renderStage() {
  const stage = $("stage");
  stage.querySelectorAll(".wbox, .special-canvas, .resize").forEach(el => el.remove());
  const scale = stageScale();
  for (const w of state.widgets) {
    if (["map", "track", "gpx"].includes(w.type)) {
      const cv = document.createElement("canvas");
      cv.className = "special-canvas";
      cv.width = w.w; cv.height = w.h;
      cv.style.cssText =
        `left:${w.x * scale}px;top:${w.y * scale}px;width:${w.w * scale}px;height:${w.h * scale}px`;
      if (!w.display) cv.style.display = "none";
      if (state.selected === w.id) cv.classList.add("selected-canvas");
      cv.addEventListener("pointerdown", (e) => startDrag(e, w, cv));
      stage.appendChild(cv);
      // Same painters as the true frame: the editing layer and the capture
      // layer must never diverge (single visual source).
      const tel = state.telemetry || { points: [] };
      const tt = state.t + (state.syncOffsetMs || 0) / 1000;
      if (w.type === "map")
        Capture.drawMapCanvas(w, tel, tt).then(src => cv.getContext("2d").drawImage(src, 0, 0));
      else if (w.type === "track")
        cv.getContext("2d").drawImage(Capture.drawTrackCanvas(w, tel, tt), 0, 0);
      else
        cv.getContext("2d").drawImage(Capture.drawRouteCanvas(w, tel, tt), 0, 0);
      const rz = document.createElement("div");
      rz.className = "resize";
      rz.style.left = (w.x + w.w) * scale - 6 + "px";
      rz.style.top = (w.y + w.h) * scale - 6 + "px";
      if (!w.display) rz.style.display = "none";
      cv.dataset.wid = w.id;
      cv.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "touch") return;   // touch uses touchstart below
        if (inResizeZone(e, cv)) startResize(e, w, cv);
        else startDrag(e, w, cv);
      });
      cv.addEventListener("touchstart", (e) => {
        if (e.touches && e.touches.length > 1) return;  // pinch: stage-level
        if (inResizeZone(e, cv)) startResize(e, w, cv);
        else startDrag(e, w, cv);
      }, { passive: false });
      stage.appendChild(rz);
      continue;
    }
    const box = document.createElement("div");
    box.className = "wbox" + (state.selected === w.id ? " selected" : "") +
      (w.display ? "" : " hidden-widget");
    box.style.cssText =
      `left:${w.x * scale}px;top:${w.y * scale}px;width:${w.w * scale}px;height:${w.h * scale}px`;
    // Visuals come from the capture renderer's DOM builder (same layout
    // math as the true frame); the box stays for drag/resize/selection.
    const inner = document.createElement("div");
    inner.style.cssText = `position:absolute;left:0;top:0;width:${w.w}px;height:${w.h}px;` +
      `transform:scale(${scale});transform-origin:0 0`;
    Capture.buildValueDOM(inner, w, state.telemetry || { points: [] },
      state.t + (state.syncOffsetMs || 0) / 1000);
    box.appendChild(inner);
    const rz = document.createElement("div");
    rz.className = "resize";
    box.appendChild(rz);
    box.dataset.wid = w.id;
    // Gesture routing: the bottom-right corner zone resizes, everything
    // else drags. A separate hit target fails on small widgets (its
    // 44px touch area swallows the whole box — audit 2026-10-14).
    const down = (e) => {
      if (e.touches && e.touches.length > 1) return;  // pinch: stage-level
      if (inResizeZone(e, box)) startResize(e, w, box);
      else startDrag(e, w, box);
    };
    box.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;   // touch uses touchstart below
      down(e);
    });
    box.addEventListener("touchstart", down, { passive: false });
    stage.appendChild(box);
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

function drawMapOn(cv, w) {
  const ctx = cv.getContext("2d");
  const pts = (state.telemetry && state.telemetry.points) || [];
  if (!pts.length) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "rgba(240,240,235,.92)";
  ctx.fillRect(0, 0, cv.width, cv.height);
  const proj = routeProj(pts, cv.width, cv.height, 14);
  ctx.strokeStyle = w.primary_color || "#e8542a"; ctx.lineWidth = 4; ctx.lineJoin = "round";
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = proj(p);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  drawMarker(ctx, proj, state.t);
  borderOn(ctx, cv, w);
}

function drawRouteOn(cv, w) {
  const ctx = cv.getContext("2d");
  const pts = (state.telemetry && state.telemetry.points) || [];
  if (!pts.length) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const proj = routeProj(pts, cv.width, cv.height, 18);
  ctx.strokeStyle = w.primary_color || "#ffffff";
  ctx.lineWidth = (w.gauge_width || 5);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.shadowColor = "rgba(0,0,0,.7)"; ctx.shadowBlur = 6;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = proj(p);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 12;
  drawMarker(ctx, proj, state.t, w.primary_color || "#ffffff");
  ctx.shadowBlur = 0;
}

function drawMarker(ctx, proj, t, color) {
  const cur = samplePointAt(t);
  if (!cur) return;
  const [x, y] = proj(cur);
  ctx.fillStyle = color || "#1a73e8";
  ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
}

function routeProj(pts, W, H, pad) {
  const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map(p => p.lon * kx), ys = pts.map(p => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sc = Math.min((W - 2 * pad) / (maxX - minX || 1e-9),
    (H - 2 * pad) / (maxY - minY || 1e-9));
  return (p) => [pad + (p.lon * kx - minX) * sc, pad + (-p.lat - minY) * sc];
}

function drawTrackOn(cv, w) {
  const ctx = cv.getContext("2d");
  const pts = (state.telemetry && state.telemetry.points) || [];
  if (!pts.length) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (w.bg_color) {
    ctx.fillStyle = w.bg_color + Math.round((w.bg_opacity ?? .2) * 255).toString(16).padStart(2, "0");
    ctx.fillRect(0, 0, cv.width, cv.height);
  }
  const eles = pts.map(p => p.ele);
  const minE = Math.min(...eles), maxE = Math.max(...eles);
  const span = (maxE - minE) || 1;
  const px = p => 8 + (p.rel / (pts[pts.length - 1].rel || 1)) * (cv.width - 16);
  const py = p => cv.height - 14 - ((p.ele - minE) / span) * (cv.height - 30);
  ctx.beginPath();
  ctx.moveTo(px(pts[0]), cv.height - 8);
  pts.forEach(p => ctx.lineTo(px(p), py(p)));
  ctx.lineTo(px(pts[pts.length - 1]), cv.height - 8);
  ctx.closePath();
  ctx.fillStyle = (w.primary_color || "#ffffff") + "33";
  ctx.fill();
  ctx.strokeStyle = w.primary_color || "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = px(p), y = py(p);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  const cur = samplePointAt(state.t);
  if (cur) {
    const x = px(cur);
    ctx.strokeStyle = w.secondary_color || "#ff6b35"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, cv.height - 6); ctx.stroke();
    ctx.fillStyle = w.secondary_color || "#ff6b35";
    ctx.beginPath(); ctx.arc(x, py(cur), 5, 0, 7); ctx.fill();
    ctx.fillStyle = w.label_color || "#fff";
    ctx.font = `bold ${Math.round(cv.height * .12)}px Orbitron, sans-serif`;
    const unitTxt = unitLabel(w);
    const e = sampleAt(state.t).ele;
    ctx.fillText(`${w.label || "ALT"}: ${Math.round(w.unit === "ft" ? e * 3.28084 : e)} ${unitTxt}`,
      12, cv.height * .18);
  }
  borderOn(ctx, cv, w);
}
function borderOn(ctx, cv, w) {
  if (w.border) {
    ctx.strokeStyle = w.border_color || "#000"; ctx.lineWidth = w.border;
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2,
      cv.width - ctx.lineWidth, cv.height - ctx.lineWidth);
  }
}

/* ---------------------------------------------------------- drag & resize */
function inResizeZone(e, box) {
  const r = box.getBoundingClientRect();
  const zone = Math.max(22, Math.min(44, r.width * 0.38, r.height * 0.5));
  return (r.right - e.clientX) <= zone && (r.bottom - e.clientY) <= zone;
}

/* Gesture start must NOT rebuild the stage: iOS pins touch events to the
 * touchstart target (and touch pointers implicitly capture it), so
 * removing that element mid-gesture — as selectWidget()/renderAll() did —
 * kills every following touchmove. Selection renders at gesture end. */
function selectWidgetNoStage(id, box) {
  state.selected = id;
  renderWidgetList();
  renderAppt();
  document.querySelectorAll(".wbox.selected, .special-canvas.selected-canvas")
    .forEach(el => el.classList.remove("selected", "selected-canvas"));
  if (box) box.classList.add(box.tagName === "CANVAS" ? "selected-canvas" : "selected");
}

function gesturePoint(ev) {
  return ev.touches && ev.touches.length ? ev.touches[0]
       : ev.changedTouches && ev.changedTouches.length ? ev.changedTouches[0]
       : ev;
}

function widgetForBoxEl(boxEl) {
  return state.widgets.find(x => x.id === boxEl.dataset.wid) || null;
}

function selectedWidgetAndBox() {
  const w = state.widgets.find(x => x.id === state.selected);
  if (!w) return null;
  const box = document.querySelector(
    ".wbox.selected, .special-canvas.selected-canvas");
  return box ? { w, box } : null;
}

/* Selection-governed pinch (Liria 2026-10-15): tap a widget to select it,
 * it stays selected, then pinch ANYWHERE on the preview to resize it. The
 * second finger no longer has to hit the widget — requiring both fingers
 * on a small target made recognition flaky. A two-finger grab that starts
 * directly on a widget still targets that widget. */
function dispatchPinch(e) {
  if (!e.touches || e.touches.length < 2) return;
  const t0 = e.touches[0];
  const el = document.elementFromPoint(t0.clientX, t0.clientY);
  const boxEl = el && el.closest ? el.closest(".wbox, .special-canvas") : null;
  let target = null;
  if (boxEl) {
    const w = widgetForBoxEl(boxEl);
    if (w) target = { w, box: boxEl };
  }
  if (!target) target = selectedWidgetAndBox();
  if (!target) return;
  e.preventDefault();
  if (target.w.id !== state.selected) selectWidgetNoStage(target.w.id, target.box);
  startPinch(e, target.w, target.box);
}

function bindGesture(endEl, move, up) {
  // Dual pipeline: native touch events (passive:false — the definitive
  // iOS scroll/callout killer) plus pointer events for mouse/pen.
  endEl.addEventListener("touchmove", move, { passive: false });
  endEl.addEventListener("touchend", up);
  endEl.addEventListener("touchcancel", up);
  endEl.addEventListener("pointermove", move, { passive: false });
  endEl.addEventListener("pointerup", up);
  endEl.addEventListener("pointercancel", up);
  return () => {
    endEl.removeEventListener("touchmove", move);
    endEl.removeEventListener("touchend", up);
    endEl.removeEventListener("touchcancel", up);
    endEl.removeEventListener("pointermove", move);
    endEl.removeEventListener("pointerup", up);
    endEl.removeEventListener("pointercancel", up);
  };
}

/* One gesture at a time: a second finger mid-drag hands off to pinch.
 * cancel() unbinds WITHOUT a re-render — the gesture target must stay
 * alive for iOS (the same trap as renderStage mid-gesture). */
let activeGesture = null;
let gestureWidget = null;   // { w, box } — pinch continues the drag's widget
function setGesture(g) {
  if (activeGesture && activeGesture.cancel) activeGesture.cancel();
  activeGesture = g;
}

function startPinch(e, w, box) {
  e.preventDefault();
  selectWidgetNoStage(w.id, box);
  const scale = stageScale();
  const [a, b] = [e.touches[0], e.touches[1]];
  const d0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
  const ow = w.w, oh = w.h;
  const move = (ev) => {
    if (ev.cancelable) ev.preventDefault();
    if (!ev.touches || ev.touches.length < 2) return;   // one finger lifts
    const [p, q] = [ev.touches[0], ev.touches[1]];
    const f = Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY) / d0;
    w.w = Math.max(60, Math.min(4000, snap(ow * f)));
    w.h = Math.max(40, Math.min(4000, snap(oh * f)));
    box.style.width = w.w * scale + "px";
    box.style.height = w.h * scale + "px";
    updatePosFields(w);
  };
  let done = false;
  const unbind = () => {
    window.removeEventListener("touchmove", move);
    window.removeEventListener("touchend", up);
    window.removeEventListener("touchcancel", up);
  };
  const up = () => {
    if (done) return;
    done = true;
    unbind();
    activeGesture = null;
    renderAll();
  };
  window.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", up);
  window.addEventListener("touchcancel", up);
  setGesture({ cancel: () => { done = true; unbind(); } });
}

function startDrag(e, w, box) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  selectWidgetNoStage(w.id, box);
  const scale = stageScale();
  const p0 = gesturePoint(e);
  const sx = p0.clientX, sy = p0.clientY, ox = w.x, oy = w.y;
  const move = (ev) => {
    const p = gesturePoint(ev);
    if (ev.cancelable) ev.preventDefault();
    w.x = snap(ox + (p.clientX - sx) / scale);
    w.y = snap(oy + (p.clientY - sy) / scale);
    const V = vid();
    w.x = Math.max(0, Math.min(w.x, V.w - w.w));
    w.y = Math.max(0, Math.min(w.y, V.h - w.h));
    box.style.left = w.x * scale + "px";
    box.style.top = w.y * scale + "px";
    updatePosFields(w);
  };
  let done = false;
  const unbind = bindGesture(window, move, up);
  gestureWidget = { w, box };
  setGesture({ cancel: () => { done = true; unbind(); } });
  function up() {
    if (done) return;
    done = true;
    unbind();
    activeGesture = null;
    renderAll();
  }
}
function startResize(e, w, box) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  selectWidgetNoStage(w.id, box);
  const scale = stageScale();
  const p0 = gesturePoint(e);
  const sx = p0.clientX, sy = p0.clientY, ow = w.w, oh = w.h;
  const move = (ev) => {
    const p = gesturePoint(ev);
    if (ev.cancelable) ev.preventDefault();
    w.w = Math.max(60, snap(ow + (p.clientX - sx) / scale));
    w.h = Math.max(40, snap(oh + (p.clientY - sy) / scale));
    box.style.width = w.w * scale + "px";
    box.style.height = w.h * scale + "px";
    updatePosFields(w);
  };
  let done = false;
  const unbind = bindGesture(window, move, up);
  gestureWidget = { w, box };
  setGesture({ cancel: () => { done = true; unbind(); } });
  function up() {
    if (done) return;
    done = true;
    unbind();
    activeGesture = null;
    renderAll();
  }
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
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      w.display = cb.checked;
      renderStage();
      renderWidgetList();
    });
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
    `<select data-k="${key}">${opts.map(o => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return `<option value="${v}" ${String(v) === String(val) ? "selected" : ""}>${t}</option>`;
    }).join("")}</select>`;

  let html = "";
  if (w.type === "map") {
    html += field("Map source", sel("source", w.source,
      [["1", "1 · OpenStreetMap"], ["3", "3 · OpenCycleMap"], ["4", "4 · OpenTopoMap"],
       ["6", "6 · Google Maps"], ["7", "7 · Google Satellite"], ["8", "8 · Google Hybrid"],
       ["9", "9 · VirtualEarth"], ["12", "12 · IGN"]]));
    html += `<div class="row2">${field("Zoom", num("zoom", w.zoom))}${field("Factor", num("factor", w.factor, 0.5))}</div>`;
    html += `<div class="row2">${field("Border", num("border", w.border))}${field("Border color", color("border_color", w.border_color))}</div>`;
  } else if (w.type === "track") {
    html += field("Theme color", color("primary_color", w.primary_color));
    html += `<div class="row2">${field("Border", num("border", w.border))}${field("Border color", color("border_color", w.border_color))}</div>`;
    html += field("Background", color("bg_color", w.bg_color)) +
      field("Background opacity", `<input type="range" data-k="bg_opacity" min="0" max="1" step="0.05" value="${w.bg_opacity}">`);
  } else if (w.type === "gpx") {
    html += field("Route color", color("primary_color", w.primary_color));
    html += field("Line width", `<input type="range" data-k="gauge_width" min="2" max="12" step="1" value="${w.gauge_width}">`);
    html += field("Background", color("bg_color", w.bg_color));
  } else {
    html += field("Widget style", sel("style", w.style, stylesFor(w.type)));
    html += field("Color theme", sel("theme", w.theme,
      [["white", "white"], ["strava", "strava orange"], ["cyan", "cyan"],
       ["lime", "lime"], ["gold", "gold"], ["custom", "custom"]]));
    html += `<div class="row2">
      ${field("Primary / gauge", color("primary_color", w.primary_color))}
      ${field("Secondary / track", color("secondary_color", w.secondary_color))}
    </div>`;
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
      ${field("Font", sel("font_family", w.font_family, ["Orbitron", "sans-serif", "monospace"]))}
    </div>`;
    html += field("Value align", sel("value_align", w.value_align, ["left", "center", "right"]));
    if (w.style === "arc" || w.style === "bar" || w.style === "barv") {
      html += field("Gauge thickness", `<input type="range" data-k="gauge_width" min="4" max="30" step="1" value="${w.gauge_width}">`);
      html += `<div class="row2">${field("Sweep angle °", num("gauge_angle", w.gauge_angle))}${field("Rotation °", num("gauge_rotation", w.gauge_rotation))}</div>`;
      html += `<div class="field check"><label><input type="checkbox" data-k="auto_range" ${w.auto_range ? "checked" : ""}> auto value range</label></div>`;
      if (!w.auto_range) {
        html += `<div class="row2">${field("Range min", num("value_min", w.value_min))}${field("Range max", num("value_max", w.value_max))}</div>`;
      }
    }
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
      if (k === "theme") {
        w.theme = v;
        if (THEMES[v]) Object.assign(w, {
          primary_color: THEMES[v].primary, secondary_color: THEMES[v].secondary,
          label_color: THEMES[v].label, value_color: THEMES[v].value,
          unit_color: THEMES[v].unit, icon_color: THEMES[v].icon,
        });
        renderAll();
        return;
      }
      if (el.type === "color") {
        w[k] = v;
        el.parentElement.querySelector(".hint").textContent = v;
      } else {
        w[k] = v;
      }
      if (k === "style" || k === "auto_range") { renderAll(); return; }
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
function openLightbox(kind, src) {
  const lb = $("lightbox");
  const v = $("lbVideo"), img = $("lbImg");
  v.classList.toggle("hidden", kind !== "video");
  img.classList.toggle("hidden", kind !== "image");
  if (kind === "video") {
    v.src = src;
    v.play().catch(() => {});
  } else {
    img.src = src;
  }
  lb.classList.remove("hidden");
}
function closeLightbox() {
  const v = $("lbVideo");
  try { v.pause(); } catch (e) {}
  $("lightbox").classList.add("hidden");
}

function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}

let _videoObjectUrl = null;
function loadLocal(meta, tel, file) {
  state.meta = meta;
  state.telemetry = tel;
  state.videoFile = file;
  const vidEl = $("poster");
  if (_videoObjectUrl) URL.revokeObjectURL(_videoObjectUrl);
  _videoObjectUrl = URL.createObjectURL(file);
  vidEl.src = _videoObjectUrl;
  const mb = ((meta.video.size || 0) / 1048576).toFixed(1);
  const mbps = ((meta.video.bit_rate || 0) / 1e6).toFixed(1);
  $("fileStatus").textContent =
    `${meta.video.name} · ${meta.video.w}×${meta.video.h} · ` +
    `${meta.video.duration.toFixed(1)}s · ${mb} MB · ${mbps} Mbps · ` +
    `${meta.gpx.points} pts`;
  state.widgets = PRESETS[$("presetSelect").value]();
  state.selected = null;
  fitStage();
  renderAll();
}

function clearFiles() {
  pending.video = pending.gpx = null;
  $("videoInput").value = "";
  $("gpxInput").value = "";
  state.meta = null;
  state.telemetry = null;
  const v = $("poster");
  try { v.pause(); } catch (e) {}
  v.removeAttribute("src");
  v.load();
  state.widgets = PRESETS[$("presetSelect").value]();
  state.selected = null;
  state.t = 0;
  $("scrub").value = 0;
  $("scrubTime").textContent = "t = 0.00s";
  $("resultRow").classList.add("hidden");
  $("pixelPreview").classList.add("hidden");
  $("renderBar").classList.add("hidden");
  $("fileStatus").textContent = "cleared — drop or pick video + gpx";
  renderAll();
  toast("Files cleared — ready for a fresh upload");
}

const pending = { video: null, gpx: null };

function filesFromDrop(e) {
  const out = [];
  const dt = e.dataTransfer;
  if (!dt) return out;
  if (dt.files && dt.files.length) {
    out.push(...dt.files);
  } else if (dt.items) {
    for (const it of dt.items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

function classifyFiles(files) {
  let recognized = 0;
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (n.endsWith(".gpx") || n.endsWith(".tcx")) {
      pending.gpx = f;
      recognized++;
      toast(`📍 GPX received: ${f.name} — ${pending.video ? "uploading…" : "now drop the video"}`);
    } else if ((f.type || "").startsWith("video/") ||
               /\.(mov|mp4|m4v|avi|mkv|webm|hevc)$/.test(n)) {
      pending.video = f;
      recognized++;
      toast(`🎞 Video received: ${f.name} — ${pending.gpx ? "uploading…" : "now drop the GPX"}`);
    }
  }
  return recognized;
}

function pendingStatus() {
  if (pending.video && !pending.gpx)
    return `✓ video ready (${pending.video.name}) — waiting for GPX`;
  if (pending.gpx && !pending.video)
    return `✓ gpx ready (${pending.gpx.name}) — waiting for video`;
  return "no files loaded — drop or pick video + gpx";
}

async function tryUpload() {
  if (!pending.video || !pending.gpx) {
    $("fileStatus").textContent = pendingStatus();
    return;
  }
  const vf = pending.video, gf = pending.gpx;
  $("fileStatus").textContent =
    `reading ${vf.name} + ${gf.name} (in this browser — nothing is uploaded)…`;
  try {
    const text = await gf.text();
    const tel = Local.parseTrack(text);
    const video = await Local.probeVideo(vf);
    if (!video.w || !video.h) throw new Error("could not read video dimensions");
    if (!video.duration) video.duration = tel.duration || 10;
    pending.video = pending.gpx = null;
    // reset pickers so re-selecting the same filename fires 'change' again
    $("videoInput").value = "";
    $("gpxInput").value = "";
    loadLocal({ video, gpx: {
      name: gf.name, points: tel.points.length,
      duration: tel.duration, has: tel.has } }, tel, vf);
    const mb = ((video.size || 0) / 1048576).toFixed(1);
    toast(`✓ Loaded ${video.name} (${mb} MB) + ${gf.name} — fully in-browser`, 5000);
  } catch (e) {
    $("fileStatus").textContent = "load failed";
    toast("Load failed: " + e.message);
  }
}

async function uploadFiles() {
  const vf = $("videoInput").files[0], gf = $("gpxInput").files[0];
  if (vf && vf !== pending.video) {
    pending.video = vf;
    toast(`🎞 Video received: ${vf.name} — ${pending.gpx ? "uploading…" : "now drop the GPX"}`);
  }
  if (gf && gf !== pending.gpx) {
    pending.gpx = gf;
    toast(`📍 GPX received: ${gf.name} — ${pending.video ? "uploading…" : "now drop the video"}`);
  }
  await tryUpload();
}

function wireDropZone() {
  const hint = $("dropHint");
  const over = (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
    if (hint) hint.classList.remove("hidden");
  };
  const leave = (e) => {
    if (e.relatedTarget === null || !document.body.contains(e.relatedTarget)) {
      document.body.classList.remove("dragging");
      if (hint) hint.classList.add("hidden");
    }
  };
  window.addEventListener("dragover", over);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    if (hint) hint.classList.add("hidden");
    const files = filesFromDrop(e);
    if (!files.length) {
      toast("That drop carried no files the browser could read — try dragging the file from a folder / Files app");
      return;
    }
    if (!classifyFiles(files)) {
      toast("Dropped file isn't a video or GPX — accepted: mov/mp4/… and gpx/tcx");
      return;
    }
    tryUpload();
  });
}

function seekVideo() {
  const v = $("poster");
  if (v && v.readyState >= 1 && isFinite(v.duration) && v.duration > 0) {
    v.currentTime = Math.max(0, Math.min(state.t, v.duration - 0.05));
  }
}

function fitStage() {
  const V = vid();
  const wrap = document.querySelector(".preview-wrap");
  const header = document.querySelector("header");
  const tl = document.querySelector(".timeline-row");
  const act = document.querySelector(".action-row");
  const chrome = (header ? header.offsetHeight : 50) +
    (tl ? tl.offsetHeight : 40) + (act ? act.offsetHeight : 40) + 30;
  const availW = wrap.clientWidth || 760;
  const availH = Math.max(240, window.innerHeight - chrome);
  const scale = Math.min(availW / V.w, availH / V.h);
  const stage = $("stage");
  stage.style.width = Math.round(V.w * scale) + "px";
  stage.style.height = Math.round(V.h * scale) + "px";
}

function currentLayout() {
  return { widgets: state.widgets.map(w => ({ ...w })) };
}

/* ---- Mode A: fully client-side export (no server rendering calls) ---- */
async function doModeARender() {
  if (!state.meta) return toast("Load a video + GPX first");
  $("renderBar").classList.remove("hidden");
  $("resultRow").classList.add("hidden");
  $("renderFill").style.width = "0%";
  try {
    const probe = await ExportA.probeModeA(state.meta.video.w, state.meta.video.h);
    if (!probe.webgl2) throw new Error("WebGL2 is not available in this browser");
    $("renderText").textContent = "preparing source file…";
    const videoBlob = state.videoFile;
    if (!videoBlob) throw new Error("no video loaded");
    const blob = await ExportA.exportModeA({
      videoBlob, telemetry: state.telemetry,
      widgets: state.widgets.map(w => ({ ...w })),
      meta: state.meta, syncOffsetMs: state.syncOffsetMs || 0,
      onProgress: (msg) => {
        $("renderText").textContent = msg;
        const m = msg.match(/composited (\d+)\/(\d+)/);
        if (m) $("renderFill").style.width = (85 * (+m[1]) / (+m[2])) + "%";
      },
    });
    $("renderFill").style.width = "100%";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.meta.video.name || "overlay").replace(/\.[^.]+$/, "") + "_overlay.mp4";
    a.click();
    $("renderText").textContent = `done ✓ — ${Math.round(blob.size / 1048576)} MB (fully client-side)`;
    $("resultRow").classList.remove("hidden");
    $("resultRow").innerHTML =
      `<a href="${url}" download>⬇ download result (client render, ${Math.round(blob.size / 1048576)} MB)</a>`;
  } catch (e) {
    $("renderText").textContent = "Mode A failed: " + e.message;
    toast("Mode A export failed: " + e.message + " — try client+server or server mode");
  }
}

/* ---- render: 100% client-side (single path) ---- */
async function doRender() {
  return doModeARender();
}

/* ---------------------------------------- true-frame preview (Phase 1)
   The DOM layer stays live for editing (drag/resize/config); the capture
   painter produces the truth canvas shown on top. This replaces the old
   server-side pixel-preview button. */
let _tfTimer = null;
function scheduleTrueFrame() {
  clearTimeout(_tfTimer);
  _tfTimer = setTimeout(refreshTrueFrame, 250);
}
function setStageMode(trueMode) {
  // The stage has two layers of the same widgets: the DOM layer (live
  // editing) and the true-frame canvas (captured truth). Exactly one may be
  // visible at a time — both together look like doubled/overlapping glyphs.
  const stage = $("stage");
  stage.querySelectorAll(".wbox, .special-canvas, .resize")
    .forEach(el => { el.style.opacity = trueMode ? "0" : ""; });
  const cvEl = $("trueFrame");
  if (cvEl) cvEl.style.display = trueMode ? "" : "none";
}
let _tfSeq = 0;
async function refreshTrueFrame() {
  const cvEl = $("trueFrame");
  if (!cvEl || !state.meta || !state.telemetry) return;
  const seq = ++_tfSeq;
  try {
    const W = vid().w, H = vid().h;
    const off = (state.syncOffsetMs || 0) / 1000;
    const cv = await Capture.paintFrame(state.telemetry, state.widgets,
                                        state.t + off, W, H);
    if (seq !== _tfSeq) return;   // a newer paint is in flight; drop this one
    cvEl.width = W; cvEl.height = H;
    cvEl.getContext("2d").drawImage(cv, 0, 0);
    cvEl.classList.remove("hidden");
    setStageMode(true);
  } catch (e) {
    console.warn("true-frame preview failed", e);
  }
}

/* ---------------------------------------------------------- wiring */
function renderAll() {
  renderStage();
  renderWidgetList();
  renderAppt();
}

window.addEventListener("DOMContentLoaded", () => {
  state.widgets = PRESETS[$("presetSelect").value]();
  fitStage();
  renderAll();
  wireDropZone();

  // Selection-governed pinch: second finger may land anywhere on the
  // preview; the selected widget (or the one under the first finger) resizes.
  $("stage").addEventListener("touchstart", dispatchPinch, { passive: false });

  // 100% client-side: no auto-load from a server — files come from the
  // pickers / drag-and-drop and stay in this browser.

  $("videoInput").addEventListener("change", uploadFiles);
  $("gpxInput").addEventListener("change", uploadFiles);
  $("btnClear").addEventListener("click", clearFiles);
  $("presetSelect").addEventListener("change", () => {
    if (!state.meta) return;
    state.widgets = PRESETS[$("presetSelect").value]();
    state.selected = null;
    renderAll();
  });
  $("btnAddWidget").addEventListener("click", () => {
    const types = [...VALUE_TYPES, "map", "track", "gpx"];
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
    seekVideo();
    renderStage();
  });
  $("btnBack").addEventListener("click", () => {
    state.t = Math.max(0, state.t - 0.5);
    $("scrub").value = 1000 * state.t / (vid().duration || 10);
    $("scrubTime").textContent = `t = ${state.t.toFixed(2)}s`;
    seekVideo();
    renderStage();
  });
  $("btnFwd").addEventListener("click", () => {
    state.t = Math.min(vid().duration || 10, state.t + 0.5);
    $("scrub").value = 1000 * state.t / (vid().duration || 10);
    $("scrubTime").textContent = `t = ${state.t.toFixed(2)}s`;
    seekVideo();
    renderStage();
  });
  $("syncOffset").addEventListener("input", () => {
    state.syncOffsetMs = parseInt($("syncOffset").value || "0", 10);
    renderStage();
  });
  $("btnRender").addEventListener("click", doRender);
  // Phase 1: the pixel-preview button is dead; true frames paint on top of
  // the stage automatically whenever the DOM layer changes or scrubbing ends.
  const _renderStageOrig = renderStage;
  renderStage = function () {
    _renderStageOrig();
    // Strict invariant: never both layers. Any change shows the live DOM
    // layer immediately (fresh .wbox elements come back visible, so the
    // canvas must hide at once), and the true frame takes over when painted.
    setStageMode(false);
    scheduleTrueFrame();
  };
  $("stage").addEventListener("pointerup", scheduleTrueFrame);
  $("stage").addEventListener("pointerdown", () => setStageMode(false));
  $("scrub").addEventListener("input", scheduleTrueFrame);
  $("btnClosePixel").addEventListener("click", () => $("pixelPreview").classList.add("hidden"));
  $("lbClose").addEventListener("click", closeLightbox);
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox")) closeLightbox();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });
  $("btnNewJob").addEventListener("click", () => {
    $("resultRow").classList.add("hidden");
    $("renderBar").classList.add("hidden");
  });
  window.addEventListener("resize", () => { fitStage(); renderStage(); });
});

/* Preload gauge fonts so canvas painters never draw with fallbacks;
   repaint once they arrive. */
["400 16px Orbitron", "600 16px Rajdhani", "700 16px Rajdhani",
 "400 16px Inter", "400 16px DSEG7"].forEach(f => {
  try { document.fonts.load(f).catch(() => {}); } catch (e) {}
});
if (document.fonts) {
  document.fonts.ready.then(() => {
    try { renderStage(); } catch (e) {}
  });
}
