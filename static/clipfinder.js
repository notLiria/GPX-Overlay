/* GPX Overlay Studio — Clip Finder page glue.
 *
 * Flow: pick GPX and/or video → candidates from ClipScan (GPX signals) →
 * if video, evaluate each candidate window with VideoScan (shot boundaries,
 * footage quality, CLIP-embedding uniqueness) → ranked cards that say WHY
 * each window might make a good clip.
 *
 * Video ↔ ride time mapping reuses Local.matchClipToRide (creation date →
 * GPS location → file mtime). When nothing matches, the video is assumed to
 * start at the ride start and the cards say so.
 */
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const state = {
    gpxFile: null, videoFile: null,
    tel: null, probe: null, match: null,
    cands: [], shots: null, previewUrl: null,
    vidOffset: 0, vidAligned: false,
  };

  function status(msg) { $("status").textContent = msg || ""; }
  function setProgress(frac) {
    const p = $("progress");
    if (frac == null) { p.classList.add("hidden"); return; }
    p.classList.remove("hidden");
    $("progressFill").style.width = Math.round(100 * frac) + "%";
  }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    setTimeout(() => t.classList.add("hidden"), 4000);
  }
  const fmt = ClipScan.fmtTime;

  /* ------------------------------------------------------ file pickers */

  function refreshFileStatus() {
    const g = state.gpxFile ? state.gpxFile.name : "no GPX";
    const v = state.videoFile ? state.videoFile.name : "no video";
    $("fileStatus").textContent = g + " · " + v;
    $("btnAnalyze").disabled = !(state.gpxFile || state.videoFile);
  }

  $("gpxInput").addEventListener("change", (e) => {
    state.gpxFile = e.target.files[0] || null;
    refreshFileStatus();
  });
  $("videoInput").addEventListener("change", (e) => {
    state.videoFile = e.target.files[0] || null;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = state.videoFile ? URL.createObjectURL(state.videoFile) : null;
    refreshFileStatus();
  });
  $("btnClear").addEventListener("click", () => {
    state.gpxFile = state.videoFile = null;
    state.tel = state.probe = state.match = null;
    state.cands = [];
    $("gpxInput").value = ""; $("videoInput").value = "";
    $("results").innerHTML = "";
    $("rideSummary").textContent = "";
    $("routeMap").classList.add("hidden");
    $("previewWrap").classList.add("hidden");
    $("syncNote").classList.add("hidden");
    refreshFileStatus();
  });
  $("btnAnalyze").addEventListener("click", () => analyze());

  /* ----------------------------------------------------------- analyze */

  async function analyze() {
    $("btnAnalyze").disabled = true;
    $("results").innerHTML = "";
    try {
      /* ---- 1. GPX: ride story */
      if (state.gpxFile) {
        status("parsing GPX…");
        const text = await state.gpxFile.text();
        state.tel = Local.parseTrack(text);
        state.cands = ClipScan.findCandidates(state.tel);
        renderSummary();
        renderMap();
      } else {
        state.tel = null;
        state.cands = [];
      }

      /* ---- 2. video probe + ride sync */
      state.vidAligned = false;
      state.vidOffset = 0;
      if (state.videoFile) {
        status("probing video…");
        const f = state.videoFile;
        state.probe = f.size < 300e6
          ? await Local.probeVideoWithMeta(f)
          : await Local.probeVideo(f);
        const note = $("syncNote");
        if (state.tel) {
          state.match = Local.matchClipToRide(state.tel, state.probe, f.lastModified);
          // manual override (also the test hook): window.CF.forceOffset
          // pins where the video sits on the ride timeline
          if (window.CF && Number.isFinite(window.CF.forceOffset)) {
            state.match = {
              matched: true, method: "manual offset",
              confidence: "manual", clipStartRel: window.CF.forceOffset,
              note: "placement forced by sync override",
            };
          }
          if (state.match.matched) {
            state.vidAligned = true;
            state.vidOffset = state.match.clipStartRel;
            const at = ClipScan.fmtTime(state.match.clipStartRel);
            note.textContent = `video ↔ ride matched via ${state.match.method} (${state.match.confidence} confidence) — `
              + `this clip covers ${at}–${ClipScan.fmtTime(state.match.clipStartRel + (state.probe.duration || 0))} of the ride.`
              + (state.match.note ? " " + state.match.note : "");
          } else {
            note.textContent = "could not place the video on the ride timeline — assuming the video starts at the ride start (adjust later with the sync offset).";
          }
          note.classList.remove("hidden");
        } else {
          note.textContent = "video-only mode: candidates come from shot structure and footage quality, with no ride context.";
          note.classList.remove("hidden");
        }
      }

      /* ---- 3. video evaluation */
      if (state.videoFile) await analyzeVideo();
      else if (state.cands.length) status(`found ${state.cands.length} candidate${state.cands.length > 1 ? "s" : ""} from the GPX`);

      /* ---- 4. cards */
      renderCards();
      if (!state.cands.length)
        status("no clip candidates found — this ride may be too short or too uniform");
    } catch (e) {
      console.error(e);
      toast("analysis failed: " + e.message);
      status("analysis failed: " + e.message);
    } finally {
      setProgress(null);
      refreshFileStatus();
    }
  }

  /* ------------------------------------------------- video evaluation */

  async function analyzeVideo() {
    const f = state.videoFile;
    const dur = state.probe.duration || 0;
    if (!dur) throw new Error("video duration unknown");

    /* shot structure: low-rate scan of the whole video */
    const dt = Math.min(2, Math.max(0.35, dur / 450));
    const times = [];
    for (let t = 0; t < dur; t += dt) times.push(t);
    status(`scanning video for shot boundaries (0/${times.length} frames)…`);
    const scanSamples = await VideoScan.sampleFrames(f, times, { rgb: false }, (i, n) => {
      setProgress(0.15 * i / n);
      if (i % 20 === 0 || i === n) status(`scanning video for shot boundaries (${i}/${n} frames)…`);
    });
    const shot = VideoScan.detectShots(scanSamples);
    state.shots = shot.boundaries;
    if (!state.cands.length) state.cands = candidatesFromShots(shot, scanSamples, dur);

    /* candidate windows in VIDEO time */
    const windows = [];
    for (const c of state.cands) {
      const off = state.vidAligned ? state.vidOffset : 0;
      const v0 = c.t0 - off, v1 = c.t1 - off;
      if (v1 < 0 || v0 > dur) { c.outsideVideo = true; continue; }
      c.outsideVideo = false;
      windows.push({ c, v0: Math.max(0, v0), v1: Math.min(dur, Math.max(v1, v0 + 2)) });
    }

    /* sample each window: 4 frames with RGB + thumbnails */
    const allFrames = [];
    let done = 0;
    for (const w of windows) {
      const span = w.v1 - w.v0;
      const ts = [0.15, 0.4, 0.65, 0.88].map(p => w.v0 + span * p);
      status(`sampling frames for ${windows.length} candidates (${done + 1}/${windows.length})…`);
      const frames = await VideoScan.sampleFrames(f, ts, { rgb: true, thumb: true });
      w.frames = frames;
      allFrames.push(...frames);
      done++;
      setProgress(0.2 + 0.35 * done / windows.length);
    }

    /* embeddings → uniqueness (falls back to color histograms) */
    if (allFrames.length) {
      status("computing frame embeddings…");
      const { vecs, method } = await VideoScan.embedFrames(allFrames, (m) => {
        status(m);
        setProgress(0.6);
      });
      setProgress(0.85);
      let k = 0;
      for (const w of windows) {
        w.vecs = vecs.slice(k, k + w.frames.length);
        k += w.frames.length;
      }
      for (const w of windows) {
        w.intraSim = VideoScan.intraSim(w.vecs);
        w.crossSim = Math.max(0, ...windows.filter(o => o !== w)
          .map(o => VideoScan.crossSim(w.vecs, o.vecs)));
        w.embedMethod = method;
      }
    }

    /* fold evidence into candidates */
    const sharpMed = windows.length
      ? [...windows.map(w => VideoScan.windowQuality(w.frames).sharp)].sort((a, b) => a - b)[Math.floor(windows.length / 2)]
      : 0;
    for (const w of windows) {
      const q = VideoScan.windowQuality(w.frames);
      w.q = q;
      const c = w.c;
      c.video = {
        v0: w.v0, v1: w.v1,
        footage: footageScore(q, sharpMed),
        uniq: w.crossSim != null ? Math.round(100 * (1 - w.crossSim)) : null,
        embedMethod: w.embedMethod || null,
        thumbs: w.frames.map(fr => fr.thumb).filter(Boolean),
      };
      /* reasons from footage */
      const rel = sharpMed > 0 ? q.sharp / sharpMed : 1;
      if (rel >= 1.25) c.reasons.push("Footage quality: among the sharpest in this video.");
      else if (rel <= 0.6) c.reasons.push("Footage quality: softer than the rest — may need stabilization or a tighter crop.");
      for (const n of q.notes) c.reasons.push("Footage note: " + n);
      if (w.crossSim != null) {
        const other = windows.find(o => o !== w && VideoScan.crossSim(w.vecs, o.vecs) === w.crossSim);
        if (w.crossSim > 0.8 && other)
          c.reasons.push(`Visually very similar to the candidate at ${fmt(other.c.t0)} — likely keep only one.`);
        else if (w.crossSim < 0.5)
          c.reasons.push("Visually distinct from the other candidates — good variety for a reel.");
      }
      /* snap to shot boundaries */
      const snap = snapToShots(w.v0, w.v1, shot.boundaries);
      if (snap.changed) {
        c.reasons.push(`Clean cut points: trim to ${fmt(snap.v0)}–${fmt(snap.v1)} in the video to land on shot boundaries.`);
        c.video.v0 = snap.v0; c.video.v1 = snap.v1;
      }
      /* final blend */
      c.finalScore = 0.6 * (c.score || 50) + 0.25 * (c.video.footage || 50) + 0.15 * (c.video.uniq || 50);
    }
    for (const c of state.cands) {
      if (!c.video) {
        c.reasons.push("Not covered by this video (the clip does not reach this part of the ride).");
        c.finalScore = (c.score || 50) * 0.7;
      }
    }
    status(`done — ${state.cands.length} candidates, ${shot.boundaries.length} shot boundaries detected`);
  }

  function footageScore(q, sharpMed) {
    let s = 55;
    if (sharpMed > 0) {
      const rel = q.sharp / sharpMed;
      if (rel >= 1.25) s += 25; else if (rel >= 1) s += 12; else if (rel < 0.6) s -= 25; else s -= 8;
    }
    s += (q.exposure - 0.8) * 40;
    return Math.max(0, Math.min(100, Math.round(s)));
  }

  function snapToShots(v0, v1, bounds) {
    let s = v0, e = v1, changed = false;
    for (const b of bounds) {
      if (b.t > v0 - 1.5 && b.t < v0 + 1.5 && Math.abs(b.t - v0) < Math.abs(s - v0)) { s = b.t; changed = true; }
      if (b.t > v1 - 1.5 && b.t < v1 + 1.5 && Math.abs(b.t - v1) < Math.abs(e - v1)) { e = b.t; changed = true; }
    }
    return { v0: s, v1: Math.max(e, s + 1), changed };
  }

  /* video-only: shots + quality become candidates */
  function candidatesFromShots(shot, samples, dur) {
    const marks = [0, ...shot.boundaries.map(b => b.t), dur];
    const out = [];
    for (let i = 0; i < marks.length - 1; i++) {
      const t0 = marks[i], t1 = marks[i + 1];
      const seg = t1 - t0;
      if (seg < 5 || seg > 120) continue;
      out.push({
        kind: "scene", title: `Shot segment · ${fmt(seg)}`,
        t0, t1, score: 45 + Math.min(20, seg / 2),
        reasons: [`Stands alone as one continuous shot of ${fmt(seg)}.`],
        metrics: { dur: seg },
      });
    }
    return out.slice(0, 12);
  }

  /* ------------------------------------------------------------ render */

  function renderSummary() {
    const s = ClipScan.rideSummary(state.tel);
    $("rideSummary").innerHTML =
      `<b>Ride:</b> ${(s.dist / 1000).toFixed(1)} km · ${fmt(s.duration)} moving · `
      + `+${Math.round(s.gain)} m climbing · avg ${(s.avgSpeed * 3.6).toFixed(1)} km/h · `
      + `max ${(s.maxSpeed * 3.6).toFixed(1)} km/h`;
  }

  function renderMap() {
    const cv = $("routeMap");
    cv.classList.remove("hidden");
    const ctx = cv.getContext("2d");
    const pts = state.tel.points;
    let loLat = 90, hiLat = -90, loLon = 180, hiLon = -180;
    for (const p of pts) {
      loLat = Math.min(loLat, p.lat); hiLat = Math.max(hiLat, p.lat);
      loLon = Math.min(loLon, p.lon); hiLon = Math.max(hiLon, p.lon);
    }
    const pad = 30;
    const sx = (cv.width - 2 * pad) / Math.max(1e-6, hiLon - loLon);
    const sy = (cv.height - 2 * pad) / Math.max(1e-6, hiLat - loLat);
    const s = Math.min(sx, sy);
    const X = (lon) => pad + (lon - loLon) * s;
    const Y = (lat) => cv.height - pad - (lat - loLat) * s;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#3d4657";
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(X(p.lon), Y(p.lat)) : ctx.moveTo(X(p.lon), Y(p.lat)));
    ctx.stroke();
    const sorted = [...state.cands].sort((a, b) => (b.finalScore || b.score) - (a.finalScore || a.score));
    sorted.forEach((c, i) => {
      const mid = state.tel.points.reduce((best, p) =>
        Math.abs(p.rel - (c.t0 + c.t1) / 2) < Math.abs(best.rel - (c.t0 + c.t1) / 2) ? p : best);
      ctx.beginPath();
      ctx.arc(X(mid.lon), Y(mid.lat), 15, 0, Math.PI * 2);
      ctx.fillStyle = i < 3 ? "#4da3ff" : "#7a8699";
      ctx.fill();
      ctx.fillStyle = "#10141c";
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), X(mid.lon), Y(mid.lat) + 1);
    });
    cv._map = { X, Y };
  }

  function meter(label, val) {
    if (val == null) return "";
    return `<div class="cf-meter">${label} <div class="bar"><div style="width:${Math.round(val)}%"></div></div> ${Math.round(val)}</div>`;
  }

  function renderCards() {
    const box = $("results");
    box.innerHTML = "";
    const sorted = [...state.cands].sort((a, b) => (b.finalScore || b.score) - (a.finalScore || a.score));
    sorted.forEach((c, i) => {
      const card = document.createElement("div");
      card.className = "cf-card";
      const rideT = `ride ${fmt(c.t0)}–${fmt(c.t1)}`;
      const vidT = c.video ? ` · video ${fmt(c.video.v0)}–${fmt(c.video.v1)}` : "";
      const thumbs = (c.video && c.video.thumbs || []);
      card.innerHTML = `
        <h3><span class="cf-rank">#${i + 1}</span> <span class="cf-kind">${c.kind}</span> ${c.title}</h3>
        <div class="cf-times">${rideT}${vidT} · ${fmt(c.t1 - c.t0)} long</div>
        <div class="cf-meters">
          ${meter("ride signal", c.score)}
          ${c.video ? meter("footage", c.video.footage) : ""}
          ${c.video && c.video.uniq != null ? meter("uniqueness", c.video.uniq) : ""}
        </div>
        <ul class="cf-why">${c.reasons.map(r => `<li>${r}</li>`).join("")}</ul>
        <div class="cf-thumbs"></div>
        ${c.video && !c.outsideVideo ? `<button class="ghost cf-preview-btn">▶ preview</button>` : ""}
      `;
      const thumbBox = card.querySelector(".cf-thumbs");
      for (const t of thumbs) {
        const img = document.createElement("img");
        img.src = t;
        img.style.height = "64px";
        img.style.borderRadius = "6px";
        thumbBox.appendChild(img);
      }
      const btn = card.querySelector(".cf-preview-btn");
      if (btn) btn.addEventListener("click", () => preview(c));
      box.appendChild(card);
    });
    if (sorted.length) status(`${sorted.length} clip candidate${sorted.length > 1 ? "s" : ""} — top pick is #1`);
  }

  function preview(c) {
    if (!state.previewUrl || !c.video) return;
    const v = $("preview");
    $("previewWrap").classList.remove("hidden");
    if (v.src !== state.previewUrl) v.src = state.previewUrl;
    v.currentTime = c.video.v0;
    v.ontimeupdate = () => {
      if (v.currentTime >= c.video.v1) { v.pause(); v.ontimeupdate = null; }
    };
    v.play().catch(() => {});
    v.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  refreshFileStatus();

  /* debugging / manual sync override hook */
  window.CF = { state };
})();
