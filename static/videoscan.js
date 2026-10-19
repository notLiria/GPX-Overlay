/* GPX Overlay Studio — Clip Finder: video-side evaluation (client-side).
 *
 * Everything runs in the browser on the picked File — the video never
 * leaves the device (same contract as the rest of the studio).
 *
 *   sampleFrames  — seek-based frame grab at low rate (gray + optional RGB)
 *   detectShots   — shot boundaries from frame-to-frame differences
 *   windowQuality — sharpness / exposure stats for a candidate window
 *   embedFrames   — CLIP image embeddings via transformers.js (lazy, optional)
 *                   falls back to color-histogram vectors when the model
 *                   cannot load (offline, small screens).
 *
 * Pitfall (from the export pipeline): never trust one probe per video —
 * seeking is asynchronous and can land a frame early, so each grab awaits
 * 'seeked' with a timeout and re-draws from the element's current frame.
 */
"use strict";

(function (root) {
  const VideoScan = {};

  const GRAY_W = 64, GRAY_H = 36;
  const CLIP_SIZE = 224;

  /* ------------------------------------------------------- frame grab */

  function once(el, ev, ms) {
    return new Promise((resolve) => {
      let done = false;
      const h = () => { if (!done) { done = true; el.removeEventListener(ev, h); resolve(true); } };
      el.addEventListener(ev, h);
      setTimeout(() => h(), ms || 2500);
    });
  }

  /* One video element, sequential seeks. onProgress(i, n).
   * Returns [{t, gray: Float32Array, luma, sharp, darkFrac, brightFrac,
   *           rgb: Uint8ClampedArray|null}]                                  */
  VideoScan.sampleFrames = async function (file, times, opts, onProgress) {
    opts = opts || {};
    const wantRgb = !!opts.rgb;
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.src = url;
    await once(v, "loadedmetadata", 8000);
    if (!v.videoWidth) { URL.revokeObjectURL(url); throw new Error("video could not be decoded"); }

    const gCan = document.createElement("canvas");
    gCan.width = GRAY_W; gCan.height = GRAY_H;
    const gCtx = gCan.getContext("2d", { willReadFrequently: true });
    const cCan = wantRgb ? document.createElement("canvas") : null;
    if (cCan) { cCan.width = CLIP_SIZE; cCan.height = CLIP_SIZE; }
    const cCtx = cCan ? cCan.getContext("2d", { willReadFrequently: true }) : null;
    const tCan = opts.thumb ? document.createElement("canvas") : null;
    if (tCan) { tCan.width = 128; tCan.height = 72; }
    const tCtx = tCan ? tCan.getContext("2d") : null;

    const out = [];
    for (let i = 0; i < times.length; i++) {
      const t = Math.max(0, Math.min(times[i], (v.duration || 1e9) - 0.05));
      if (Math.abs(v.currentTime - t) > 0.01) {
        v.currentTime = t;
        await once(v, "seeked");
      }
      gCtx.drawImage(v, 0, 0, GRAY_W, GRAY_H);
      const gd = gCtx.getImageData(0, 0, GRAY_W, GRAY_H).data;
      const gray = new Float32Array(GRAY_W * GRAY_H);
      let lumaSum = 0, dark = 0, bright = 0;
      for (let p = 0; p < gray.length; p++) {
        const r = gd[p * 4], g = gd[p * 4 + 1], b = gd[p * 4 + 2];
        const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        gray[p] = y;
        lumaSum += y;
        if (y < 0.03) dark++;
        if (y > 0.97) bright++;
      }
      /* sharpness: mean squared gradient (Laplacian energy proxy) */
      let sharp = 0;
      for (let y = 1; y < GRAY_H - 1; y++) {
        for (let x = 1; x < GRAY_W - 1; x++) {
          const p = y * GRAY_W + x;
          const lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - GRAY_W] - gray[p + GRAY_W];
          sharp += lap * lap;
        }
      }
      sharp /= (GRAY_W - 2) * (GRAY_H - 2);
      let rgb = null;
      if (cCtx) {
        cCtx.drawImage(v, 0, 0, CLIP_SIZE, CLIP_SIZE);
        rgb = cCtx.getImageData(0, 0, CLIP_SIZE, CLIP_SIZE).data;
      }
      let thumb = null;
      if (tCtx) {
        tCtx.drawImage(v, 0, 0, tCan.width, tCan.height);
        thumb = tCan.toDataURL("image/jpeg", 0.72);
      }
      out.push({
        t, gray, rgb, thumb,
        luma: lumaSum / gray.length,
        sharp,
        darkFrac: dark / gray.length,
        brightFrac: bright / gray.length,
      });
      if (onProgress) onProgress(i + 1, times.length);
    }
    URL.revokeObjectURL(url);
    return out;
  };

  /* ------------------------------------------------------- shot detect */

  /* mean abs diff between consecutive gray frames → boundaries where the
   * diff spikes above max(absolute floor, k × rolling median). Returns
   * [{t, strength}] at the NEW shot's first sampled frame. */
  VideoScan.detectShots = function (samples) {
    const diffs = [];
    for (let i = 1; i < samples.length; i++) {
      let s = 0;
      const a = samples[i - 1].gray, b = samples[i].gray;
      for (let p = 0; p < a.length; p++) s += Math.abs(a[p] - b[p]);
      diffs.push({ i, d: s / a.length });
    }
    if (!diffs.length) return { boundaries: [], diffs: [] };
    const med = quantile(diffs.map(x => x.d), 0.5);
    const mad = quantile(diffs.map(x => Math.abs(x.d - med)), 0.5) || 0.01;
    const thr = Math.max(0.10, med + Math.max(6 * mad, 3 * med));
    const boundaries = diffs
      .filter(x => x.d > thr)
      .map(x => ({ t: samples[x.i].t, strength: Math.min(1, x.d / (thr * 2)) }));
    return { boundaries, diffs };
  };

  function quantile(arr, q) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const i = (s.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  }

  /* ------------------------------------------------ window evaluation */

  VideoScan.windowQuality = function (samples) {
    if (!samples.length) return { sharp: 0, exposure: 0.5, notes: ["no frames sampled"] };
    const sharp = samples.reduce((a, s) => a + s.sharp, 0) / samples.length;
    const luma = samples.reduce((a, s) => a + s.luma, 0) / samples.length;
    const dark = samples.reduce((a, s) => a + s.darkFrac, 0) / samples.length;
    const blown = samples.reduce((a, s) => a + s.brightFrac, 0) / samples.length;
    const notes = [];
    if (dark > 0.25) notes.push("mostly dark frames — camera may be covered");
    else if (blown > 0.25) notes.push("large blown-out areas — harsh light or sky");
    else if (luma < 0.15) notes.push("underexposed");
    else if (luma > 0.85) notes.push("overexposed");
    return { sharp, luma, exposure: 1 - (dark + blown), notes };
  };

  /* color-histogram vector (fallback embedding): 4×4×4 RGB bins */
  function histVec(rgb) {
    const v = new Float32Array(64);
    if (!rgb) return v;
    for (let p = 0; p < rgb.length; p += 4) {
      const b = (rgb[p] >> 6) * 16 + (rgb[p + 1] >> 6) * 4 + (rgb[p + 2] >> 6);
      v[b]++;
    }
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }

  /* ------------------------------------------------------- embeddings */

  let embedder = null, embedderState = "idle";
  const MODEL_ID = "Xenova/clip-vit-base-patch32";
  const CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.min.js";

  VideoScan.embedderStatus = () => embedderState;

  /* Lazy-load CLIP. onStatus(text) streams progress. Resolves to a
   * function (samples) → [Float32Array] of L2-normalized embeddings, or
   * null when the model can't load (caller falls back to histograms). */
  VideoScan.getEmbedder = async function (onStatus) {
    if (embedder) return embedder;
    if (embedderState === "failed") return null;
    embedderState = "loading";
    try {
      if (onStatus) onStatus("loading CLIP model (~90 MB, first time only)…");
      const mod = await import(/* webpackIgnore: true */ CDN);
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;
      const pipe = await mod.pipeline("image-feature-extraction", MODEL_ID, {
        quantized: true,
        progress_callback: (p) => {
          if (onStatus && p.status === "progress" && p.file && p.total)
            onStatus(`loading CLIP ${p.file}: ${Math.round(100 * p.loaded / p.total)}%`);
        },
      });
      const fn = async (samples) => {
        const out = [];
        for (const s of samples) {
          const el = document.createElement("canvas");
          el.width = CLIP_SIZE; el.height = CLIP_SIZE;
          el.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(s.rgb), CLIP_SIZE, CLIP_SIZE), 0, 0);
          const t = await pipe(el, { pooling: "mean", normalize: true });
          const vec = t.data ? Float32Array.from(t.data) : Float32Array.from(t);
          out.push(vec);
        }
        return out;
      };
      embedder = fn;
      embedderState = "ready";
      return embedder;
    } catch (e) {
      console.warn("CLIP embedder unavailable:", e);
      embedderState = "failed";
      return null;
    }
  };

  /* vectors for frames — CLIP when available, else color histograms */
  VideoScan.embedFrames = async function (samples, onStatus) {
    let vecs = null, method = "clip";
    const emb = await VideoScan.getEmbedder(onStatus);
    if (emb && samples.every(s => s.rgb)) {
      try { vecs = await emb(samples); } catch (e) { vecs = null; }
    }
    if (!vecs) {
      vecs = samples.map(histVec);
      method = "histogram";
    }
    return { vecs, method };
  };

  VideoScan.cos = function (a, b) {
    let d = 0;
    for (let i = 0; i < a.length && i < b.length; i++) d += a[i] * b[i];
    return d;
  };

  /* mean pairwise cosine within one list (1 = all identical) */
  VideoScan.intraSim = function (vecs) {
    if (vecs.length < 2) return 1;
    let s = 0, n = 0;
    for (let i = 0; i < vecs.length; i++)
      for (let j = i + 1; j < vecs.length; j++) { s += VideoScan.cos(vecs[i], vecs[j]); n++; }
    return n ? s / n : 1;
  };

  /* mean of best cross-list cosine (how much two windows look alike) */
  VideoScan.crossSim = function (a, b) {
    if (!a.length || !b.length) return 0;
    let s = 0;
    for (const x of a) {
      let best = -1;
      for (const y of b) best = Math.max(best, VideoScan.cos(x, y));
      s += best;
    }
    return s / a.length;
  };

  root.VideoScan = VideoScan;
  if (typeof module !== "undefined" && module.exports) module.exports = VideoScan;
})(typeof globalThis !== "undefined" ? globalThis : this);
