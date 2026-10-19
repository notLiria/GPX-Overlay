/* Node smoke test for static/clipscan.js — synthetic ride with a known
 * structure: flat, climb (+4%), fast descent, stop, speed surge, flat.
 * Run: node tests/test_clipscan_node.js
 */
"use strict";
const ClipScan = require("../static/clipscan.js");

function buildRide() {
  const pts = [];
  let rel = 0, dist = 0, ele = 200, lat = 44.0, lon = -79.0;
  const segs = [
    { dur: 300, speed: 5, grade: 0 },      // flat
    { dur: 300, speed: 3, grade: 4 },      // climb +120 m
    { dur: 120, speed: 12, grade: -5 },    // fast descent
    { dur: 60, speed: 0, grade: 0 },       // stop
    { dur: 60, speed: 11, grade: 0 },      // surge
    { dur: 300, speed: 5, grade: 0 },      // flat home
  ];
  for (const s of segs) {
    for (let t = 0; t < s.dur; t += 2) {
      const d = s.speed * 2;
      dist += d;
      ele += (s.grade / 100) * d;
      lon += d / 80000;                    // rough eastward drift
      rel += 2;
      pts.push({
        rel, lat, lon, ele,
        hr: s.speed === 3 ? 165 : s.speed === 12 ? 150 : s.speed === 0 ? 110 : 135,
        speed: s.speed, grade: s.grade, dist,
      });
    }
  }
  return { t0: 1700000000, duration: rel, points: pts, has: { hr: true } };
}

const tel = buildRide();
const cands = ClipScan.findCandidates(tel);
console.log("ride:", JSON.stringify(ClipScan.rideSummary(tel)));
console.log("candidates:", cands.length);
for (const c of cands) {
  console.log(`  #${c.rank} [${c.kind}] ${c.title} @ ${ClipScan.fmtTime(c.t0)}-${ClipScan.fmtTime(c.t1)} score=${c.score.toFixed(0)}`);
  for (const r of c.reasons) console.log("      · " + r);
}

const kinds = new Set(cands.map(c => c.kind));
const expect = ["climb", "descent", "stop", "sprint"];
const missing = expect.filter(k => !kinds.has(k));
if (missing.length) {
  console.error("FAIL: missing kinds:", missing.join(", "));
  process.exit(1);
}
if (cands.some(c => c.t1 <= c.t0)) {
  console.error("FAIL: empty window");
  process.exit(1);
}
console.log("PASS: all expected kinds found:", expect.join(", "));
