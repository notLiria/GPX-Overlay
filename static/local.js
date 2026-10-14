/* GPX Overlay Studio — local file ingest (100% client-side).
 *
 * This replaces the old server flow (POST /api/projects → parse_gpx +
 * ffprobe). Values are ported 1:1 from app.py's parse_gpx so telemetry
 * matches what the server used to produce:
 *   haversine R = 6371000 m; speed = Δd/Δt (0 when Δt ≤ 0);
 *   grade = 100·Δe/Δd when Δd > 1 else 0; dist = cumulative Δd;
 *   rel = t − t0; points sorted by timestamp.
 *
 * Parsing is namespace-tolerant (match on localName), so odd prefixes and
 * older/broken GPX files that the server had to normalize just work.
 */
"use strict";

(function (root) {
  const Local = {};

  /* ------------------------------------------------- GPX / TCX parsing */

  function allEls(el, local) {
    const out = [];
    for (const c of el.getElementsByTagName("*"))
      if (c.localName === local) out.push(c);
    return out;
  }

  function firstText(el, names) {
    for (const n of names) {
      const found = allEls(el, n);
      for (const f of found) {
        const t = (f.textContent || "").trim();
        if (t) return t;
      }
    }
    return null;
  }

  function parsePoint(p, isTcx) {
    let lat = null, lon = null;
    if (p.hasAttribute && p.hasAttribute("lat")) {
      lat = parseFloat(p.getAttribute("lat"));
      lon = parseFloat(p.getAttribute("lon"));
    } else {
      const la = firstText(p, ["LatitudeDegrees"]);
      const lo = firstText(p, ["LongitudeDegrees"]);
      lat = la != null ? parseFloat(la) : null;
      lon = lo != null ? parseFloat(lo) : null;
    }
    const t = firstText(p, ["time", "Time"]);
    if (t == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const ts = Date.parse(t);
    if (!Number.isFinite(ts)) return null;
    const num = (v, d) => {
      const x = parseFloat(v);
      return Number.isFinite(x) ? x : d;
    };
    // Garmin gpxtpx: hr / cad / power / atemp; TCX: HeartRateBpm/Value,
    // Cadence, Watts, Temperature.
    const hrT = firstText(p, ["hr", "HeartRateBpm"]);
    const hr = hrT != null
      ? parseInt((firstText(allEls(p, "HeartRateBpm")[0] || p, ["Value"]) || hrT), 10)
      : null;
    return {
      t: ts / 1000,
      lat, lon,
      ele: num(firstText(p, ["ele", "AltitudeMeters"]), 0),
      hr: Number.isFinite(hr) ? hr : null,
      cad: (() => {
        const c = parseInt(firstText(p, ["cad", "Cadence"]) || "", 10);
        return Number.isFinite(c) ? c : null;
      })(),
      power: (() => {
        const v = firstText(p, ["power", "Watts"]);
        if (v == null) return null;
        const f = parseFloat(v);
        return Number.isFinite(f) ? f : null;
      })(),
      temp: (() => {
        const v = firstText(p, ["atemp", "Temperature"]);
        if (v == null) return null;
        const f = parseFloat(v);
        return Number.isFinite(f) ? f : null;
      })(),
    };
  }

  const R = 6371000.0;
  function hav(a, b) {
    const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180;
    const dp = (b.lat - a.lat) * Math.PI / 180;
    const dl = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.pow(Math.sin(dp / 2), 2) +
      Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* GPX or TCX text in → telemetry dict out (same shape as the old
   * /api/projects/{id}/telemetry). */
  Local.parseTrack = function (text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length)
      throw new Error("not valid XML — is this really a GPX/TCX file?");
    const isTcx = allEls(doc.documentElement, "Trackpoint").length > 0;
    const raw = isTcx
      ? allEls(doc.documentElement, "Trackpoint").map(p => parsePoint(p, true))
      : allEls(doc.documentElement, "trkpt").map(p => parsePoint(p, false));
    const pts = raw.filter(Boolean);
    if (!pts.length) throw new Error("GPX has no timestamped trackpoints");
    pts.sort((a, b) => a.t - b.t);
    const t0 = pts[0].t;
    let cum = 0.0;
    pts.forEach((q, i) => {
      if (i) {
        const d = hav(pts[i - 1], q);
        cum += d;
        const dt = q.t - pts[i - 1].t;
        q.speed = dt > 0 ? d / dt : 0.0;
        const de = q.ele - pts[i - 1].ele;
        q.grade = d > 1 ? 100.0 * de / d : 0.0;
      } else {
        q.speed = 0.0;
        q.grade = 0.0;
      }
      q.rel = q.t - t0;
      q.dist = cum;
    });
    return {
      t0,
      duration: pts[pts.length - 1].rel,
      points: pts.map(q => ({
        rel: q.rel, lat: q.lat, lon: q.lon, ele: q.ele,
        hr: q.hr, cad: q.cad, power: q.power, temp: q.temp,
        speed: q.speed, grade: q.grade, dist: q.dist,
      })),
      has: {
        hr: pts.some(q => q.hr),
        cad: pts.some(q => q.cad),
        power: pts.some(q => q.power),
        temp: pts.some(q => q.temp),
      },
    };
  };

  /* ------------------------------------------------------ video probing */

  function refineWithMp4(file, out) {
    return new Promise((resolve) => {
      if (typeof MP4Box === "undefined") return resolve(out);
      file.arrayBuffer().then((buf) => {
        try {
          const f = MP4Box.createFile();
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(out); } };
          f.onError = finish;
          f.onReady = (info) => {
            try {
              const vt = (info.videoTracks || [])[0];
              if (vt) {
                const durSec = vt.timescale ? vt.duration / vt.timescale : 0;
                if (durSec > 0 && vt.nb_samples)
                  out.fps = Math.round((vt.nb_samples / durSec) * 1000) / 1000;
                out.frames = vt.nb_samples || out.frames;
                // rotation from the tkhd matrix (same rule as export_a.js)
                try {
                  const trak = f.moov.traks.find(t => t.tkhd && t.tkhd.track_id === vt.id)
                            || f.moov.traks[0];
                  const m = trak.tkhd.matrix;
                  const rot = Math.abs(Math.round(
                    Math.atan2(m[1], m[0]) * 180 / Math.PI)) % 360;
                  out.rotation = [0, 90, 180, 270].reduce(
                    (best, a) => Math.abs(a - rot) < Math.abs(best - rot) ? a : best, 0);
                } catch (e) {}
                // HDR (HLG/PQ) from the sample description's colr box
                try {
                  const entry = f.moov.traks[0].mdia.minf.stbl.stsd.entries[0];
                  const colr = (entry && (entry.colr ||
                    (entry.avcC && entry.avcC.colr) || (entry.hvcC && entry.hvcC.colr))) || null;
                  const tc = colr && (colr.transfer_characteristics ??
                                      colr.colour_transfer_characteristics);
                  if (tc === 18 || tc === 16 || colr?.transfer === "hlg") out.hdr = true;
                } catch (e) {}
              }
              if (out.duration > 0)
                out.bit_rate = Math.round(out.size * 8 / out.duration);
            } catch (e) {}
            finish();
          };
          buf.fileStart = 0;
          f.appendBuffer(buf);
          f.flush();
          setTimeout(finish, 3000);   // never hang the load on a parse quirk
        } catch (e) { resolve(out); }
      }).catch(() => resolve(out));
    });
  }

  /* File → {name, w, h, duration, fps, frames, size, bit_rate, hdr,
   * rotation} — display dimensions from the video element (post-rotation),
   * fps/rotation/HDR refined from the mp4 boxes when parseable. */
  Local.probeVideo = function (file) {
    return new Promise((resolve) => {
      const out = {
        name: file.name, w: 0, h: 0,
        duration: 0, fps: 30, frames: 0,
        hdr: false, hdr_filter: "",
        size: file.size, bit_rate: 0, profile: "", rotation: 0,
      };
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      const done = () => {
        URL.revokeObjectURL(url);
        refineWithMp4(file, out).then(() => {
          out.hdr_filter = out.hdr ? "hlg" : "";
          resolve(out);
        });
      };
      v.onloadedmetadata = () => {
        out.w = v.videoWidth; out.h = v.videoHeight;
        out.duration = (isFinite(v.duration) && v.duration > 0) ? v.duration : 0;
        if (!out.duration) {
          // some webm/mkv containers don't report duration to the element
          v.currentTime = 1e6;
          v.ontimeupdate = () => {
            v.ontimeupdate = null;
            out.duration = v.duration > 0 ? v.duration : 0;
            done();
          };
        } else done();
      };
      v.onerror = done;
      v.src = url;
    });
  };

  /* probeVideo + capture metadata (creation date / GPS) for ride matching */
  Local.probeVideoWithMeta = function (file) {
    return Local.probeVideo(file).then(async (out) => {
      try {
        const buf = await file.arrayBuffer();
        const qtm = Local.extractQuickTimeMeta(buf);
        out.creationdate = qtm.creationdate;
        out.location = qtm.location;
        out.locationAccuracy = qtm.locationAccuracy;
      } catch (e) {}
      return out;
    });
  };

  /* ------------------------------------ clip-to-ride time matching */

  function parseISO8601(s) {
    // iOS writes -0400; normalize to -04:00 for every engine
    const norm = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const ms = Date.parse(norm);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }

  function winToStr(bytes, start, len) {
    let s = "";
    const end = Math.min(bytes.length, start + len);
    for (let i = start; i < end; i += 8192)
      s += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
    return s;
  }

  /* QuickTime mdta: com.apple.quicktime.creationdate and
   * ...location.ISO6709 live in moov/udta/meta keys+ilst. The keys table
   * and the values are NOT adjacent atoms, so scan the whole file for the
   * distinctive VALUE patterns instead (verified on iPhone .mov,
   * 2026-10-14; an ISO-8601 wall-clock string in a .mov is the capture
   * date — box timestamps are binary). */
  Local.extractQuickTimeMeta = function (buf) {
    const bytes = new Uint8Array(buf);
    const out = { creationdate: null, location: null, locationAccuracy: null };
    const s = winToStr(bytes, 0, bytes.length);
    const ts = s.match(/20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:[+-]\d{2}:?\d{2}|Z)/);
    if (ts) out.creationdate = parseISO8601(ts[0]);
    const lm = s.match(/([+-]\d{2,3}\.\d+)([+-]\d{2,3}\.\d+)([+-]\d+\.\d+)?/);
    if (lm) out.location = {
      lat: parseFloat(lm[1]), lon: parseFloat(lm[2]),
      alt: lm[3] ? parseFloat(lm[3]) : null,
    };
    return out;
  };

  /* Match a clip to a ride: where does the video fall on the GPX timeline?
   * Tier 1: the capture timestamp (high confidence).
   * Tier 2: the clip's GPS point nearest to the route (cross-check or
   *         fallback — loops can alias, so time wins when both exist).
   * Tier 3: file mtime (a flagged guess when metadata was stripped). */
  Local.matchClipToRide = function (tel, video, fileLastMs) {
    const out = {
      matched: false, method: "none", confidence: "low",
      clipStartRel: 0, note: "",
      locationStartRel: null, locationAgrees: null,
    };
    const t0 = tel.t0, tEnd = tel.t0 + tel.duration;
    const margin = 30;
    if (video.creationdate &&
        video.creationdate >= t0 - margin && video.creationdate <= tEnd + margin) {
      out.matched = true;
      out.method = "creationdate";
      out.clipStartRel = Math.max(0, video.creationdate - t0);
      out.confidence = "high";
    }
    if (video.location && tel.points.length > 1) {
      let best = null;
      for (const p of tel.points) {
        const d = hav(p, video.location);
        if (!best || d < best.d) best = { d, rel: p.rel };
      }
      out.locationStartRel = best.rel;
      if (out.matched && out.method === "creationdate") {
        out.locationAgrees = Math.abs(best.rel - out.clipStartRel) <= 60;
        if (!out.locationAgrees) {
          out.confidence = "low";
          out.note = "GPS places the clip elsewhere on the ride — check the start";
        }
      } else if (!out.matched) {
        out.matched = true;
        out.method = "location";
        out.clipStartRel = best.rel;
        out.confidence = "low";
        out.note = "matched by GPS only — on looped routes this can land on the wrong lap";
      }
    }
    if (!out.matched && fileLastMs) {
      const ft = fileLastMs / 1000;
      if (ft >= t0 - margin && ft <= tEnd + margin) {
        out.matched = true;
        out.method = "file-time";
        out.clipStartRel = Math.max(0, ft - t0);
        out.confidence = "low";
        out.note = "video metadata is missing — file time is a guess";
      }
    }
    return out;
  };

  root.Local = Local;
})(typeof self !== "undefined" ? self : this);
