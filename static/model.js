/* GPX Overlay Studio — canonical widget/telemetry model (Phase 0).
 *
 * This module is THE single definition of value math and the frame-at-time-t
 * contract. app.js delegates here for preview; the capture/export pipeline
 * will consume the same code. The Python Telemetry class in overlay.py is a
 * checked mirror (tests/test_model_parity.py enforces agreement) and is
 * feature-frozen.
 *
 * Determinism contract: every function is pure given (telemetry, widget, t).
 * No wall-clock reads, no Math.random, no DOM. frameState(t) is the export
 * entry point: the complete, order-stable description of what the overlay
 * shows at time t.
 */
"use strict";

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Model = factory();
})(typeof self !== "undefined" ? self : this, function () {

  const DEFAULT_UNITS = {
    speed: "kph", avgspeed: "kph", maxspeed: "kph", heartrate: "bpm",
    cadence: "trpermin", elevation: "m", distance: "km",
    temperature: "C", power: "watt", grade: "percent",
    verticalspeed: "meterperhour",
  };

  function hms(t) {
    t = Math.max(0, t);
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function unitLabel(w) {
    const map = { kph: "km/h", mph: "mph", mps: "m/s", bpm: "bpm",
      trpermin: "tr/min", m: "m", ft: "FT", km: "km", miles: "mi",
      C: "°C", F: "°F", watt: "W", percent: "%",
      meterperhour: "m/h", feetpermin: "ft/min" };
    return map[w.unit] || w.unit || "";
  }

  function sampleAt(tel, tSec) {
    const zero = { speed: 0, hr: 0, cad: 0, ele: 0, dist: 0, grade: 0 };
    const pts = tel ? tel.points : null;
    if (!pts || !pts.length) return zero;
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
      power: L(a.power, b.power), temp: L(a.temp, b.temp),
    };
  }

  function rawSeries(w, tel) {
    const pts = (tel && tel.points) || [];
    switch (w.type) {
      case "speed": case "avgspeed": case "maxspeed":
        return pts.map(p => p.speed * (w.unit === "mph" ? 2.236936 : w.unit === "mps" ? 1 : 3.6));
      case "heartrate": return pts.map(p => p.hr).filter(v => v != null);
      case "cadence": return pts.map(p => p.cad).filter(v => v != null);
      case "elevation": return pts.map(p => w.unit === "ft" ? p.ele * 3.28084 : p.ele);
      case "distance": return pts.map(p => w.unit === "miles" ? p.dist / 1609.344 : p.dist / 1000);
      case "grade": return pts.map(p => p.grade);
      case "verticalspeed": return pts.map(p =>
        (w.unit === "feetpermin" ? 196.85 : 3600) * p.speed * p.grade / 100);
      case "power": return pts.map(p => p.power).filter(v => v != null);
      case "temperature": return pts.map(p => p.temp).filter(v => v != null);
      default: return [];
    }
  }

  function rangeFor(w, tel) {
    if (!w.auto_range) return [Number(w.value_min) || 0, Number(w.value_max) || 100];
    const s = rawSeries(w, tel);
    if (!s.length) return [0, 1];
    let mn = Math.min(...s), mx = Math.max(...s);
    if (w.type === "heartrate") { mn = Math.min(mn, 80); mx = Math.max(mx, 180); }
    if (mx - mn < 1) mx = mn + 1;
    const pad = (mx - mn) * 0.15;
    return [Math.floor(mn - pad), Math.ceil(mx + pad)];
  }

  function fmtVal(w, t, tel) {
    const s = sampleAt(tel, t);
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
        const d = new Date(((tel ? tel.t0 : 0) + t) * 1000);
        return d.toTimeString().slice(0, 8);
      }
      case "grade": return (s.grade || 0).toFixed(1);
      case "verticalspeed": {
        const vms = (s.speed || 0) * (s.grade || 0) / 100;
        return (w.unit === "feetpermin" ? vms * 196.85 : vms * 3600).toFixed(0);
      }
      case "temperature": return s.temp != null ? String(Math.round(s.temp)) : "--";
      case "power": return s.power != null ? String(Math.round(s.power)) : "--";
      default: return "0";
    }
  }

  /* The frame-at-time-t contract. Pure and order-stable: same inputs, same
   * output. Export renders exactly this; preview paints exactly this. */
  function frameState(tel, widgets, tSec) {
    const out = [];
    for (const w of widgets) {
      if (w.display === false) continue;
      const value = fmtVal(w, tSec, tel);
      const [mn, mx] = rangeFor(w, tel);
      const num = parseFloat(value);
      const frac = Number.isFinite(num)
        ? Math.max(0, Math.min(1, (num - mn) / (mx - mn || 1))) : 0;
      out.push({
        id: w.id, type: w.type, style: w.style || "",
        x: w.x, y: w.y, w: w.w, h: w.h,
        value, unit: unitLabel(w), range: [mn, mx], frac,
      });
    }
    return out;
  }

  return {
    DEFAULT_UNITS, hms, unitLabel,
    sampleAt, rawSeries, rangeFor, fmtVal, frameState,
  };
});
