/* GPX Overlay Studio — Clip Finder: GPX candidate detection (pure logic).
 *
 * Input: telemetry dict from Local.parseTrack (same derive math as the
 * overlay: haversine R=6371000, speed=Δd/Δt, grade=100·Δe/Δd).
 * Output: ranked clip candidates — time window, kind, score (0-100), and
 * human-readable "why this might make a good clip" reasons with concrete
 * numbers (km/h, %, meters, bpm).
 *
 * No DOM dependencies so it runs in node for tests as well as the browser.
 */
"use strict";

(function (root) {
  const ClipScan = {};

  /* ------------------------------------------------------- statistics */

  function quantile(arr, q) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const i = (s.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  }

  function median(arr) { return quantile(arr, 0.5); }

  function mean(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(mean(arr.map(x => (x - m) * (x - m))));
  }

  /* centered moving average, window w (odd) */
  function smooth(arr, w) {
    const half = Math.floor(w / 2);
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
        sum += arr[j]; n++;
      }
      out[i] = n ? sum / n : arr[i];
    }
    return out;
  }

  /* --------------------------------------------------------- formatting */

  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function kmh(mps) { return mps * 3.6; }

  ClipScan.fmtTime = function (s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), sec = s % 60;
    return m + ":" + String(sec).padStart(2, "0");
  };

  function fmtDur(s) {
    if (s < 90) return Math.round(s) + " s";
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return m + " min" + (sec ? " " + sec + " s" : "");
  }

  /* ------------------------------------------------------------ geometry */

  function bearing(a, b) {
    const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180;
    const dl = (b.lon - a.lon) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  function angDiff(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* ------------------------------------------------------------- runs */

  /* indices where pred holds continuously → [{i0, i1}] inclusive.
   * tol: tolerated consecutive false points inside a run (GPS noise makes
   * a per-point predicate flicker; without tolerance sustained climbs
   * shatter into 10-second fragments). */
  function runs(pts, pred, tol) {
    tol = tol || 0;
    const out = [];
    let i0 = -1, lastTrue = -1, falseCount = 0;
    const close = () => {
      if (i0 >= 0) out.push({ i0, i1: lastTrue });
      i0 = -1; lastTrue = -1; falseCount = 0;
    };
    for (let i = 0; i < pts.length; i++) {
      const dt = i > 0 ? pts[i].rel - pts[i - 1].rel : 0;
      const gap = dt > 30;                 // auto-pause / recording gap breaks runs
      if (gap) { close(); continue; }
      if (pred(i)) {
        if (i0 < 0) { i0 = i; falseCount = 0; }
        lastTrue = i; falseCount = 0;
      } else if (i0 >= 0 && falseCount < tol) {
        falseCount++;
      } else {
        close();
      }
    }
    close();
    return out;
  }

  function winOf(pts, r) {
    return { t0: pts[r.i0].rel, t1: pts[r.i1].rel };
  }

  /* ===================================================== ride summary */

  ClipScan.rideSummary = function (tel) {
    const pts = tel.points;
    let gain = 0, maxSp = 0;
    for (let i = 1; i < pts.length; i++) {
      const de = pts[i].ele - pts[i - 1].ele;
      if (de > 0) gain += de;
      if (pts[i].speed > maxSp) maxSp = pts[i].speed;
    }
    return {
      duration: tel.duration,
      dist: pts[pts.length - 1].dist,
      gain,
      avgSpeed: tel.duration > 0 ? pts[pts.length - 1].dist / tel.duration : 0,
      maxSpeed: maxSp,
    };
  };

  /* ==================================================== GPX candidates */

  ClipScan.findCandidates = function (tel, opts) {
    const pts = tel.points;
    if (pts.length < 10) return [];
    opts = opts || {};
    const maxOut = opts.max || 12;

    const speedS = smooth(pts.map(p => p.speed), 5);
    const gradeS = smooth(pts.map(p => p.grade), 11);
    const eleS = smooth(pts.map(p => p.ele), 7);
    const speedAll = pts.map(p => p.speed);
    const spP50 = median(speedAll);
    const spP90 = quantile(speedAll, 0.9);
    const hrVals = pts.filter(p => p.hr).map(p => p.hr);
    const hrMax = hrVals.length ? Math.max(...hrVals) : 0;

    const cands = [];
    const push = (c) => {
      if (c.t1 > c.t0) cands.push(c);
    };

    /* ---- climbs: sustained positive grade with real gain */
    for (const r of runs(pts, i => gradeS[i] > 1.2, 8)) {
      const w = winOf(pts, r);
      const dur = w.t1 - w.t0;
      const gain = pts[r.i1].ele - pts[r.i0].ele;
      const dist = pts[r.i1].dist - pts[r.i0].dist;
      if (dur < 30 || gain < 8 || dist < 100) continue;
      const avgGrade = dist > 0 ? 100 * gain / dist : 0;
      const maxGrade = Math.max(...gradeS.slice(r.i0, r.i1 + 1));
      const reasons = [
        `Sustained climb: +${Math.round(gain)} m over ${f1(dist / 1000)} km, averaging ${f1(avgGrade)}% (max ${f1(maxGrade)}%).`,
        "Effort footage — and the crest makes a natural payoff frame.",
      ];
      if (hrVals.length) {
        const hrAvg = mean(pts.slice(r.i0, r.i1 + 1).map(p => p.hr).filter(Boolean));
        if (hrAvg > 0.85 * hrMax)
          reasons.push(`Hard effort: heart rate averaged ${Math.round(hrAvg)} bpm — near the ride's peak (${hrMax}).`);
      }
      push({
        kind: "climb",
        title: `Climb · +${Math.round(gain)} m`,
        t0: w.t0, t1: w.t1,
        score: Math.min(95, 45 + gain * 0.35 + Math.min(25, dur / 12)),
        reasons,
        metrics: { gain, dist, avgGrade, maxGrade, dur },
      });
    }

    /* ---- descents: negative grade + moving at pace */
    for (const r of runs(pts, i => gradeS[i] < -1.2 && speedS[i] > Math.max(2.5, 0.6 * spP50), 8)) {
      const w = winOf(pts, r);
      const dur = w.t1 - w.t0;
      const drop = pts[r.i0].ele - pts[r.i1].ele;
      const dist = pts[r.i1].dist - pts[r.i0].dist;
      if (dur < 20 || drop < 5 || dist < 80) continue;
      const seg = speedS.slice(r.i0, r.i1 + 1);
      const avgSp = mean(seg), maxSp = Math.max(...seg);
      const avgGrade = dist > 0 ? -100 * drop / dist : 0;
      push({
        kind: "descent",
        title: `Fast descent · ${f1(kmh(maxSp))} km/h peak`,
        t0: w.t0, t1: w.t1,
        score: Math.min(97, 50 + kmh(avgSp) * 0.9 + Math.min(15, drop * 0.15)),
        reasons: [
          `Descent: ${f1(dist / 1000)} km dropping ${Math.round(drop)} m (avg ${f1(avgGrade)}%).`,
          `Speed: ${f1(kmh(avgSp))} km/h average, peaking at ${f1(kmh(maxSp))} km/h.`,
          "Forward-camera descents are the classic payoff clip.",
        ],
        metrics: { drop, dist, avgSpeed: avgSp, maxSpeed: maxSp, dur },
      });
    }

    /* ---- speed surges: the fast flat stretches */
    // threshold must beat ordinary cruising by a clear margin; a plain
    // p90 fails on rides where fast stretches are ≥10% of the time
    const surgeThr = Math.max(3.5, spP50 + 1.2 * std(speedAll), 1.25 * spP50);
    for (const r of runs(pts, i => speedS[i] > surgeThr && gradeS[i] > -1.5 && gradeS[i] < 1.5, 3)) {
      const w = winOf(pts, r);
      const dur = w.t1 - w.t0;
      if (dur < 6) continue;
      const seg = speedS.slice(r.i0, r.i1 + 1);
      const maxSp = Math.max(...seg);
      push({
        kind: "sprint",
        title: `Speed surge · ${f1(kmh(maxSp))} km/h`,
        t0: w.t0, t1: w.t1,
        score: Math.min(90, 35 + kmh(maxSp) * 1.1 + Math.min(15, dur / 4)),
        reasons: [
          `Fast stretch: peaks at ${f1(kmh(maxSp))} km/h, held for ${fmtDur(dur)}.`,
          `That is above ${Math.round(100 * (1 - (speedAll.filter(x => x > surgeThr).length / speedAll.length)))}% of the ride's recorded seconds.`,
        ],
        metrics: { maxSpeed: maxSp, avgSpeed: mean(seg), dur },
      });
    }

    /* ---- winding sections: sustained curvature (not noise, not grid).
     * Bearings from smoothed coords; only while moving; score is average
     * TURN PER MOVING POINT — intersections (rare 90° jolts) and GPS
     * jitter (smoothing removes it) both read low, a winding road reads
     * high because EVERY point bends. */
    {
      const latS = smooth(pts.map(p => p.lat), 7);
      const lonS = smooth(pts.map(p => p.lon), 7);
      const turn = new Array(pts.length).fill(0);
      const at = (i) => ({ lat: latS[i], lon: lonS[i] });
      for (let i = 2; i < pts.length; i++)
        turn[i] = angDiff(bearing(at(i - 2), at(i - 1)), bearing(at(i - 1), at(i)));
      let i0 = 0;
      while (i0 < pts.length - 5) {
        let j = i0, sum = 0, n = 0;
        while (j < pts.length && pts[j].rel - pts[i0].rel < 40) {
          if (speedS[j] > 2) { sum += turn[j]; n++; }
          j++;
        }
        const avgTurn = n > 12 ? sum / n : 0;
        if (avgTurn > 9) {
          let k = j, extSum = sum, extN = n;
          while (k < pts.length && pts[k].rel - pts[i0].rel < 180) {
            if (speedS[k] > 2) { extSum += turn[k]; extN++; }
            if (extN > 5 && extSum / extN < 6) break;
            k++;
          }
          const w = { t0: pts[i0].rel, t1: pts[k - 1].rel };
          const dist = pts[k - 1].dist - pts[i0].dist;
          if (w.t1 - w.t0 >= 15 && dist > 100) {
            push({
              kind: "twisty",
              title: `Winding section · ${Math.round(extSum)}° of turning`,
              t0: w.t0, t1: w.t1,
              score: Math.min(78, 35 + avgTurn * 3),
              reasons: [
                `Sustained curvature: ${Math.round(extSum)}° of turning over ${f1(dist / 1000)} km of continuous bending.`,
                "Sweeping-camera potential: bends read as motion on video.",
              ],
              metrics: { totalTurn: extSum, avgTurn, dur: w.t1 - w.t0 },
            });
          }
          i0 = k;
        } else i0 = Math.max(i0 + 1, j);
      }
    }

    /* ---- stops: speed below 0.5 m/s */
    for (const r of runs(pts, i => speedS[i] < 0.5, 3)) {
      const w = winOf(pts, r);
      const dur = w.t1 - w.t0;
      if (dur < 20) continue;
      push({
        kind: "stop",
        title: `Stop · ${fmtDur(dur)}`,
        t0: w.t0, t1: w.t1,
        score: Math.min(80, 30 + Math.min(35, dur / 6)),
        reasons: [
          `Paused for ${fmtDur(dur)} — lookout, snack, regroup.`,
          "Natural talk-to-camera or companion moment.",
        ],
        metrics: { dur },
      });
    }
    for (let i = 1; i < pts.length; i++) {
      const dt = pts[i].rel - pts[i - 1].rel;
      if (dt > 30) {
        push({
          kind: "stop",
          title: `Pause in the recording · ${fmtDur(dt)}`,
          t0: pts[i - 1].rel, t1: pts[i].rel,
          score: 45,
          reasons: [
            `No trackpoints for ${fmtDur(dt)} (auto-pause or stopped recording).`,
            "Whatever happened here was worth stopping for.",
          ],
          metrics: { dur: dt, gap: true },
        });
      }
    }

    /* ---- high point of the ride */
    {
      let hi = 0;
      for (let i = 1; i < eleS.length; i++) if (eleS[i] > eleS[hi]) hi = i;
      const prominence = eleS[hi] - Math.min(quantile(eleS, 0.1), eleS[hi] - 1);
      if (prominence > 10) {
        const t0 = Math.max(0, pts[hi].rel - 45), t1 = Math.min(tel.duration, pts[hi].rel + 45);
        push({
          kind: "peak",
          title: `High point · ${Math.round(eleS[hi])} m`,
          t0, t1,
          score: Math.min(85, 40 + prominence * 0.3),
          reasons: [
            `Highest ground of the ride at ${Math.round(eleS[hi])} m.`,
            "Summit views and the top-of-climb moment land here.",
          ],
          metrics: { ele: eleS[hi], prominence },
        });
      }
    }

    /* ---- sustained top-zone heart rate not already covered */
    if (hrVals.length && hrMax > 0) {
      const thr = 0.88 * hrMax;
      for (const r of runs(pts, i => pts[i].hr && pts[i].hr > thr, 5)) {
        const w = winOf(pts, r);
        const dur = w.t1 - w.t0;
        if (dur < 45) continue;
        const hrAvg = mean(pts.slice(r.i0, r.i1 + 1).map(p => p.hr).filter(Boolean));
        push({
          kind: "effort",
          title: `Hardest effort · ${Math.round(hrAvg)} bpm avg`,
          t0: w.t0, t1: w.t1,
          score: Math.min(85, 40 + (hrAvg / hrMax) * 35),
          reasons: [
            `Heart rate ${Math.round(Math.min(...pts.slice(r.i0, r.i1 + 1).map(p => p.hr).filter(Boolean)))}–${Math.round(Math.max(...pts.slice(r.i0, r.i1 + 1).map(p => p.hr).filter(Boolean)))} bpm for ${fmtDur(dur)}.`,
            "This is where the ride was hardest — effort reads on camera.",
          ],
          metrics: { hrAvg, dur },
        });
      }
    }

    /* -------------------------------------------- merge + rank + space */

    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of cands) {
      const dur = c.t1 - c.t0;
      let target = null;
      for (const p of picked) {
        const pd = p.t1 - p.t0;
        const ov = Math.min(c.t1, p.t1) - Math.max(c.t0, p.t0);
        // merge only genuine overlaps — touching windows (climb then
        // descent) are distinct moments and must stay separate cards
        if (ov > 0 && ov > 0.3 * Math.min(dur, pd)) { target = p; break; }
      }
      if (target) {
        target.t0 = Math.min(target.t0, c.t0);
        target.t1 = Math.max(target.t1, c.t1);
        if (c.score > target.score) {
          target.score = Math.min(99, c.score + 3);
          target.title = c.title;
          target.kind = c.kind;
        }
        for (const r of c.reasons)
          if (!target.reasons.includes(r)) target.reasons.push(r);
        Object.assign(target.metrics, c.metrics);
      } else {
        picked.push({ ...c, reasons: [...c.reasons] });
      }
    }
    // rank by score with per-kind caps — one noisy detector must not
    // fill the board (twisty once took all 12 slots on a city ride)
    const CAP = { twisty: 2, stop: 2, effort: 2, scene: 3 };
    const counts = {};
    const out = [];
    for (const c of picked.sort((a, b) => b.score - a.score)) {
      const cap = CAP[c.kind] != null ? CAP[c.kind] : 3;
      if ((counts[c.kind] || 0) >= cap) continue;
      counts[c.kind] = (counts[c.kind] || 0) + 1;
      out.push(c);
      if (out.length >= maxOut) break;
    }
    out.forEach((c, i) => { c.rank = i + 1; });
    return out;
  };

  root.ClipScan = ClipScan;
  if (typeof module !== "undefined" && module.exports) module.exports = ClipScan;
})(typeof globalThis !== "undefined" ? globalThis : this);
