/* GPX Overlay Studio — Phase 3 Mode A: fully client-side export.
 *
 * Pipeline (no server calls beyond fetching the source file bytes):
 *   mp4box demux -> WebCodecs VideoDecoder -> I420 planes -> WebGL2
 *   composite (exact tuned HLG chain + overlay) -> VideoEncoder ->
 *   mp4-muxer -> Blob download. Audio is passed through as encoded AAC
 *   samples (lossless carry; no re-encode, no version-gated audio classes).
 *
 * Tone map: the tuned chain from the server render, one-to-one:
 *   YUV(BT.2020 limited) -> RGB -> HLG inverse OETF (npl=100) ->
 *   hable tonemap (desat=0) -> BT.2020->BT.709 gamut ->
 *   eq(contrast 1.32, saturation 1.45, brightness -0.09, gamma 0.93)
 */
"use strict";

const ExportA = (() => {

  // Calibration LUT: measured residual between this shader chain and the
  // server's ffmpeg chain on aligned frames (33 points per channel). Baked
  // from tools/fit_lut-style analysis; re-fit if the ffmpeg grade changes.
  const CAL_LUT = [[0.1046, 0.1782, 0.2379, 0.2864, 0.3325, 0.3749, 0.4145, 0.4506, 0.484, 0.5182, 0.5494, 0.5812, 0.6141, 0.6422, 0.6766, 0.7072, 0.7351, 0.7604, 0.7855, 0.8071, 0.828, 0.848, 0.8676, 0.8847, 0.901, 0.915, 0.9184, 0.9319, 0.9384, 0.9492, 0.9622, 0.9622, 1.0], [0.0964, 0.195, 0.2527, 0.2964, 0.3407, 0.3825, 0.4155, 0.4499, 0.482, 0.5142, 0.5456, 0.5766, 0.6068, 0.6377, 0.6701, 0.6989, 0.726, 0.7521, 0.7768, 0.7978, 0.8174, 0.8368, 0.8546, 0.8675, 0.8839, 0.8945, 0.8974, 0.903, 0.9094, 0.92, 0.9488, 0.9488, 1.0], [0.0562, 0.1185, 0.1646, 0.2073, 0.2452, 0.2806, 0.3178, 0.3586, 0.4019, 0.4474, 0.4878, 0.5243, 0.5631, 0.5989, 0.6338, 0.6681, 0.6958, 0.7244, 0.7496, 0.7709, 0.7915, 0.8115, 0.8255, 0.8389, 0.8547, 0.8684, 0.8684, 0.878, 0.878, 0.8821, 0.9355, 0.9355, 1.0]];

  /* ------------------------------------------------------ capability probe */
  async function probeModeA(width = 1080, height = 1920) {
    const out = { webgl2: false, decode: {}, encode: {}, usable: false };
    const gl = document.createElement("canvas").getContext("webgl2");
    out.webgl2 = !!gl;
    if (gl) gl.getExtension("WEBGL_debug_renderer_info");

    const codecs = ["avc1.640028", "avc1.4d401f", "hvc1.1.6.L120.90",
                    "hev1.1.6.L120.90", "vp09.00.40.08"];
    for (const codec of codecs) {
      try {
        out.decode[codec] = !!(await VideoDecoder.isConfigSupported({ codec })).supported;
      } catch (e) { out.decode[codec] = false; }
      try {
        out.encode[codec] = !!(await VideoEncoder.isConfigSupported({
          codec, width, height, bitrate: 12_000_000, framerate: 30,
        })).supported;
      } catch (e) { out.encode[codec] = false; }
    }
    out.usable = out.webgl2 &&
      (out.encode["avc1.640028"] || out.encode["avc1.4d401f"]);
    return out;
  }

  /* ------------------------------------------------------------- demux */
  async function demux(blob) {
    const file = MP4Box.createFile();
    const res = { video: null, audio: null, vSamples: [], aSamples: [] };
    let gotV = 0, gotA = 0, checkDone = null;
    const ready = new Promise((resolveReady) => {
      file.onReady = (info) => {
        const vt = info.videoTracks[0];
        const at = info.audioTracks[0];
        if (vt) {
          const trak = file.getTrackById(vt.id);
          // tkhd matrix carries the display rotation (phone portrait = 90/270)
          const m = trak.tkhd.matrix || [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
          const rotDeg = Math.round(Math.atan2(m[1] / 65536, m[0] / 65536) * 180 / Math.PI);
          res.video = {
            id: vt.id, codec: vt.codec, timescale: vt.timescale,
            width: vt.video ? vt.video.width : info.width,
            height: vt.video ? vt.video.height : info.height,
            rotation: ((rotDeg % 360) + 360) % 360,
            nbSamples: vt.nb_samples,
          };
          for (const entry of trak.mdia.minf.stbl.stsd.entries) {
            const box = entry.avcC || entry.hvcC || entry.vvcC;
            if (box) {
              // box.write() needs a DataStream writer (global in the all build)
              const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
              box.write(s);
              // WebCodecs/mp4-muxer want the AVCC record WITHOUT the 8-byte
              // box header (size + type) that write() includes.
              res.video.description = new Uint8Array(s.buffer.slice(8));
              break;
            }
          }
          file.setExtractionOptions(vt.id, null, { nbSamples: 50 });
        }
        if (at) {
          res.audio = {
            id: at.id, codec: at.codec, timescale: at.timescale,
            sampleRate: at.audio ? at.audio.sample_rate : 48000,
            channels: at.audio ? at.audio.channel_count : 2,
            nbSamples: at.nb_samples,
          };
          file.setExtractionOptions(at.id, null, { nbSamples: 50 });
        }
        resolveReady();
      };
    });
    // Samples arrive only after start(); completion is tracked by count.
    const samplesDone = new Promise((resolveSamples) => {
      checkDone = () => {
        const vOk = !res.video || gotV >= res.video.nbSamples;
        const aOk = !res.audio || gotA >= res.audio.nbSamples;
        if (vOk && aOk) resolveSamples();
      };
      setTimeout(resolveSamples, 15000);  // safety: never deadlock
    });
    file.onSamples = (id, user, samples) => {
      if (res.video && id === res.video.id) {
        for (const s of samples) res.vSamples.push(s);
        gotV += samples.length;
      } else if (res.audio && id === res.audio.id) {
        for (const s of samples) res.aSamples.push(s);
        gotA += samples.length;
      }
      if (checkDone) checkDone();
    };
    const buf = await blob.arrayBuffer();
    buf.fileStart = 0;
    file.appendBuffer(buf);
    await ready;
    file.start();
    await samplesDone;
    file.flush();
    return res;
  }

  /* ------------------------------------------------- WebGL2 composite */
  const VS = `#version 300 es
  in vec2 aPos; out vec2 vUv;
  void main() {
    vUv = vec2((aPos.x + 1.0) / 2.0, 1.0 - (aPos.y + 1.0) / 2.0);
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

  // The tuned chain, one-to-one with the server's ffmpeg filter graph.
  const FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D yTex, uTex, vTex, ovTex;
  uniform vec3 uLut[33];
  uniform int uRot;  // clockwise display rotation of the stored frame
  uniform int uHdr;  // 1 = HLG chain + grade; 0 = SDR passthrough

  vec3 yuv2rgb2020(vec3 yuv) {
    float y = (yuv.x - 16.0 / 255.0) * (255.0 / 219.0);
    float u = yuv.y - 128.0 / 255.0;
    float v = yuv.z - 128.0 / 255.0;
    return vec3(y + 1.4746 * v,
                y - 0.164553 * u - 0.571353 * v,
                y + 1.8814 * u);
  }
  float hlgInv(float e) {
    const float a = 0.17883277, b = 0.28466892, c = 0.5599107;
    return e <= 0.5 ? (e * e) / 3.0 : (exp((e - c) / a) + b) / 12.0;
  }
  float hable(float x) {
    float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
  }
  vec3 gamut2020to709(vec3 c) {
    // GLSL mat3() fills COLUMNS — args are the transpose of the row form.
    mat3 m = mat3( 1.6605, -0.1246, -0.0182,
                  -0.5876,  1.1329, -0.1006,
                  -0.0728, -0.0083,  1.1187);
    return clamp(m * c, 0.0, 1.0);
  }
  vec3 lutLookup(vec3 c) {
    vec3 r;
    for (int k = 0; k < 3; k++) {
      float v = clamp(c[k], 0.0, 1.0) * 32.0;
      int i0 = int(floor(v));
      int i1 = min(i0 + 1, 32);
      r[k] = mix(uLut[i0][k], uLut[i1][k], v - float(i0));
    }
    return r;
  }
  vec2 srcUv(vec2 uv) {
    // Verified against ffmpeg autorotate on asymmetric test patterns:
    // matrix angle 90 maps to this quadrant, 270 to the opposite one.
    if (uRot == 90) return vec2(uv.y, 1.0 - uv.x);
    if (uRot == 180) return vec2(1.0 - uv.x, 1.0 - uv.y);
    if (uRot == 270) return vec2(1.0 - uv.y, uv.x);
    return uv;
  }
  void main() {
    vec2 uv = srcUv(vUv);
    vec3 yuv = vec3(texture(yTex, uv).r, texture(uTex, uv).r, texture(vTex, uv).r);
    vec3 s;
    if (uHdr == 1) {
      vec3 rgb2020 = clamp(yuv2rgb2020(yuv), 0.0, 1.0);
      vec3 lin = vec3(hlgInv(rgb2020.r), hlgInv(rgb2020.g), hlgInv(rgb2020.b));
      // ffmpeg order: linearize -> gamut 2020->709 (linear) -> hable -> OETF
      vec3 g709 = gamut2020to709(lin);
      vec3 tm = vec3(hable(g709.r), hable(g709.g), hable(g709.b)) / hable(1.0);
      s = clamp(tm, 0.0, 1.0);
      s = mix(4.5 * s, 1.099 * pow(s, vec3(0.45)) - 0.099, step(vec3(0.018), s));
      // eq (ffmpeg semantics: luma ops + saturation on chroma from input)
      vec3 luma3 = vec3(0.2126, 0.7152, 0.0722);
      float y0 = dot(s, luma3);
      float y = (y0 - 0.5) * 1.32 + 0.5 - 0.09;
      y = pow(clamp(y, 0.0, 1.0), 1.0 / 0.93);
      vec3 chroma = s - vec3(y0);
      s = lutLookup(clamp(vec3(y) + chroma * 1.45, 0.0, 1.0));
    } else {
      // SDR: display-referred passthrough (matches the browser preview)
      float y = (yuv.x - 16.0 / 255.0) * (255.0 / 219.0);
      float u = yuv.y - 128.0 / 255.0;
      float v = yuv.z - 128.0 / 255.0;
      s = clamp(vec3(y + 1.5748 * v,
                     y - 0.1873 * u - 0.4681 * v,
                     y + 1.8556 * u), 0.0, 1.0);
    }
    vec4 ov = texture(ovTex, vUv);
    outColor = vec4(mix(s, ov.rgb, ov.a), 1.0);
  }`;

  function makeGL(W, H) {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const gl = canvas.getContext("webgl2", {
      preserveDrawingBuffer: true, premultipliedAlpha: false,
    });
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error("shader: " + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error("link: " + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    // uniform3fv expects interleaved [r,g,b] triples per entry, not
    // per-channel blocks — transpose the LUT at upload.
    const lutFlat = [];
    for (let i = 0; i < 33; i++)
      lutFlat.push(CAL_LUT[0][i], CAL_LUT[1][i], CAL_LUT[2][i]);
    gl.uniform3fv(gl.getUniformLocation(prog, "uLut[0]"),
                  new Float32Array(lutFlat));
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = (unit, name) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
      return t;
    };
    return { canvas, gl, prog, textures: {
      y: tex(0, "yTex"), u: tex(1, "uTex"), v: tex(2, "vTex"), ov: tex(3, "ovTex") } };
  }

  /* ----------------------------------------------------------- export */
  async function exportModeA({ videoBlob, telemetry, widgets, meta,
                               syncOffsetMs = 0, onProgress }) {
    const prog = onProgress || (() => {});
    prog("demuxing source…");
    const d = await demux(videoBlob);
    if (!d.video) throw new Error("no video track in source");
    // DISPLAY orientation (rotation-aware): the editor's layout and the
    // encoder both work in display space; the shader rotates the samples.
    const cw = d.video.width, ch = d.video.height;
    const W = (meta && meta.video && meta.video.w) || cw;
    const H = (meta && meta.video && meta.video.h) || ch;
    const swapped = (W !== cw || H !== ch);
    let rot = d.video.rotation || 0;
    if (swapped && rot % 180 === 0) rot = 90;
    if (!swapped && rot % 180 !== 0) rot = 0;
    rot = ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
    const fps = (meta && meta.video && meta.video.fps) || 30;
    const N = d.vSamples.length;
    const decCodec = d.video.codec;

    const { canvas: glCanvas, gl, textures, prog: glProg } = makeGL(W, H);
    gl.uniform1i(gl.getUniformLocation(glProg, "uRot"), rot);
    const uHdrLoc = gl.getUniformLocation(glProg, "uHdr");
    gl.uniform1i(uHdrLoc, (meta && meta.video && meta.video.hdr_filter) ? 1 : 0);

    // I420 buffers reused per frame (cropped to display size)
    const ySize = W * H, uvSize = (W >> 1) * (H >> 1);
    const yBuf = new Uint8Array(ySize);
    const uBuf = new Uint8Array(uvSize);
    const vBuf = new Uint8Array(uvSize);

    // Version-proof YUV extraction with stride inference and cropping.
    // Chrome's VideoDecoder fills copyTo() with DISPLAY-width strides even
    // when codedWidth is 16-aligned (1088 vs 1080) — using coded stride
    // shifts every row and corrupts chroma (streaks, magenta/green tint).
    let padded = null;
    async function extractI420(frame) {
      // Normalize to the STORED visible rect. The swap fires only when the
      // browser reports POST-rotation display dims (equal to the output
      // dims); Chrome reports the pre-rotation stored rect (equal to the
      // coded dims), which must be used as-is.
      let dw = frame.displayWidth || W, dh = frame.displayHeight || H;
      if (rot % 180 !== 0 && dw === W && dh === H) {
        const tmp = dw; dw = dh; dh = tmp;
      }
      const cw = frame.codedWidth || dw, ch = frame.codedHeight || dh;
      const fmt = frame.format || "I420";
      const semi = (fmt === "NV12" || fmt === "P010");
      const ten = /10/.test(fmt);   // I420P10 / P010: 2 bytes per sample
      const B = ten ? 2 : 1;
      const sz = frame.allocationSize
        ? frame.allocationSize()
        : (semi ? (cw * ch * 3 * B) / 2 : (cw * ch + 2 * (cw >> 1) * (ch >> 1)) * B);
      if (!padded || padded.byteLength < sz) padded = new Uint8Array(sz);
      try {
        await frame.copyTo(padded.subarray(0, sz));
      } catch (_) {
        // modern API fallback: browser converts to planar 8-bit I420
        await frame.copyTo([
          { data: padded.subarray(0, dw * dh), stride: dw },
          { data: padded.subarray(dw * dh, dw * dh + (dw >> 1) * (dh >> 1)), stride: dw >> 1 },
          { data: padded.subarray(dw * dh + (dw >> 1) * (dh >> 1), sz), stride: dw >> 1 },
        ], { format: "I420" });
      }
      // stride inference: visible-size layout vs coded-size layout (bytes)
      const dispTotal = semi ? (dw * dh * 3 * B) / 2
                             : (dw * dh + 2 * (dw >> 1) * (dh >> 1)) * B;
      const strideY = sz === dispTotal ? dw * B : cw * B;
      const strideUV = strideY >> 1;
      const sample8 = (off, x) => ten
        ? ((padded[off + x * 2] | (padded[off + x * 2 + 1] << 8)) >> 2)
        : padded[off + x];
      for (let y = 0; y < dh; y++) {
        const row = y * strideY;
        for (let x = 0; x < dw; x++) yBuf[y * dw + x] = sample8(row, x);
      }
      // Plane offsets: layout stores either visible rows (display-stride) or
      // coded rows — detect which from the total size (chroma sits wrong by
      // thousands of bytes if we guess this wrong).
      const rowsY = (sz === strideY * dh + 2 * (strideUV * (dh >> 1))) ? dh : ch;
      const offUV = strideY * rowsY;
      const rowsUV = rowsY >> 1;
      const offV = offUV + strideUV * rowsUV;
      if (semi) {
        // interleaved UV (pairs), 1 or 2 bytes per component
        for (let y = 0; y < (dh >> 1); y++) {
          const row = offUV + y * strideY;
          for (let x = 0; x < (dw >> 1); x++) {
            const o = row + x * 2 * B;
            uBuf[y * (dw >> 1) + x] = ten
              ? ((padded[o] | (padded[o + 1] << 8)) >> 2) : padded[o];
            vBuf[y * (dw >> 1) + x] = ten
              ? ((padded[o + 2] | (padded[o + 3] << 8)) >> 2) : padded[o + 1];
          }
        }
      } else {
        for (let y = 0; y < (dh >> 1); y++) {
          const urow = offUV + y * strideUV, vrow = offV + y * strideUV;
          for (let x = 0; x < (dw >> 1); x++) {
            uBuf[y * (dw >> 1) + x] = sample8(urow, x);
            vBuf[y * (dw >> 1) + x] = sample8(vrow, x);
          }
        }
      }
      return [dw, dh];
    }

    const encConfig = {
      codec: "avc1.640028", width: W, height: H,
      bitrate: (meta && meta.video && meta.video.bit_rate) || 12_000_000,
      framerate: fps,
      avc: { format: "annexb" },
      latencyMode: "realtime",  // no B-frames: monotonic DTS == PTS
    };
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width: W, height: H },
      audio: d.audio ? {
        codec: "aac", sampleRate: d.audio.sampleRate,
        numberOfChannels: d.audio.channels,
      } : undefined,
      fastStart: "in-memory",
    });

    // Audio: lossless passthrough of the encoded samples. The muxer needs
    // a decoderConfig on every chunk (AAC config synthesized from track info).
    const audioMeta = d.audio ? {
      decoderConfig: {
        codec: (d.audio.codec || "mp4a.40.2").startsWith("mp4a")
          ? d.audio.codec : "mp4a.40.2",
        sampleRate: d.audio.sampleRate,
        numberOfChannels: d.audio.channels,
      },
    } : null;
    const aT0 = d.aSamples.length
      ? Math.round((d.aSamples[0].dts * 1_000_000) / d.aSamples[0].timescale) : 0;
    for (const s of d.aSamples) {
      muxer.addAudioChunk(new EncodedAudioChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: Math.round((s.cts * 1_000_000) / s.timescale) - aT0,
        duration: (s.duration * 1_000_000) / s.timescale,
        data: s.data,
      }), audioMeta);
    }

    let encError = null;
    // This Chromium's VideoEncoder emits no decoderConfig metadata, so the
    // avcC must be derived from the encoder's own bitstream: annex-B chunks
    // are converted to length-prefixed form and their SPS/PPS collected.
    const spsPPS = { sps: [], pps: [] };
    function splitAnnexB(bytes) {
      const nals = [];
      const findStart = (from) => {
        for (let j = from; j + 3 < bytes.length; j++) {
          if (bytes[j] === 0 && bytes[j + 1] === 0) {
            if (bytes[j + 2] === 1) return [j, 3];
            if (bytes[j + 2] === 0 && bytes[j + 3] === 1) return [j, 4];
          }
        }
        return null;
      };
      let sc = findStart(0);
      while (sc) {
        const [start, len] = sc;
        const next = findStart(start + len);
        const end = next ? next[0] : bytes.length;
        if (end > start + len) nals.push(bytes.subarray(start + len, end));
        sc = next;
      }
      return nals;
    }
    function buildAvcC() {
      const sps = spsPPS.sps[0], pps = spsPPS.pps[0];
      if (!sps || !pps) return null;
      const size = 11 + (2 + sps.length) + 1 + (2 + pps.length);
      const out = new Uint8Array(size);
      const dv = new DataView(out.buffer);
      out[0] = 1; out[1] = sps[1]; out[2] = sps[2]; out[3] = sps[3];
      out[4] = 0xFF; out[5] = 0xE1;
      dv.setUint16(6, sps.length);
      out.set(sps, 8);
      out[8 + sps.length] = 1;
      dv.setUint16(9 + sps.length, pps.length);
      out.set(pps, 11 + sps.length);
      return out;
    }
    const videoMeta = {
      decoderConfig: {
        codec: "avc1.640028", codedWidth: W, codedHeight: H,
        colorSpace: "bt709",
      },
    };
    const encoder = new VideoEncoder({
      output: (chunk) => {
        try {
          const raw = new Uint8Array(chunk.byteLength);
          chunk.copyTo(raw);
          const nals = splitAnnexB(raw);
          let total = 0;
          for (const n of nals) total += 4 + n.length;
          const adv = new Uint8Array(total);
          const dv = new DataView(adv.buffer);
          let off = 0;
          for (const n of nals) {
            const type = n[0] & 0x1f;
            if (type === 7 && spsPPS.sps.length === 0) spsPPS.sps.push(n);
            if (type === 8 && spsPPS.pps.length === 0) spsPPS.pps.push(n);
            dv.setUint32(off, n.length);
            adv.set(n, off + 4);
            off += 4 + n.length;
          }
          if (!videoMeta.decoderConfig.description) {
            const avcC = buildAvcC();
            if (avcC) videoMeta.decoderConfig.description = avcC;
          }
          muxer.addVideoChunkRaw(adv, chunk.type, chunk.timestamp,
                                 chunk.duration, videoMeta);
        } catch (e) {
          encError = encError || e;
          window.__encErr = String(e && e.stack || e);
        }
      },
      error: (e) => { encError = encError || e; window.__encErr = String(e); },
    });
    encoder.configure(encConfig);

    let decodedCount = 0, encodedCount = 0;
    const done = new Promise((resolve) => {
      const dec = new VideoDecoder({
        output: async (frame) => {
          try {
            const t = Math.round(decodedCount * 1_000_000 / fps);
            // I420 planes -> textures (normalized stored-rect dims)
            const [fw, fh] = await extractI420(frame);
            // frame's own color metadata is the authority on HLG
            const cs = frame.colorSpace;
            if (cs && (cs.transfer === "hlg" || cs.transfer === "smpte2084"))
              gl.uniform1i(uHdrLoc, 1);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            const up = (tex, data, w2, h2) => {
              gl.activeTexture(gl.TEXTURE0 + [textures.y, textures.u, textures.v].indexOf(tex));
              gl.bindTexture(gl.TEXTURE_2D, tex);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w2, h2, 0,
                            gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
            };
            up(textures.y, yBuf, fw, fh);
            up(textures.u, uBuf, fw >> 1, fh >> 1);
            up(textures.v, vBuf, fw >> 1, fh >> 1);
            // overlay at the frame's own time
            const ov = await Capture.paintFrame(telemetry, widgets,
              syncOffsetMs / 1000 + t / 1_000_000, W, H);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, textures.ov);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                          gl.UNSIGNED_BYTE, ov);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const out = new VideoFrame(glCanvas, {
              timestamp: t, duration: (1_000_000 / fps) | 0,
            });
            encoder.encode(out);
            out.close(); frame.close();
            encodedCount++;
            prog(`composited ${decodedCount + 1}/${N}`);
          } catch (e) {
            encError = encError || e;
            try { frame.close(); } catch (_) {}
          }
          decodedCount++;
          if (decodedCount >= N) resolve();
        },
        error: (e) => { encError = encError || e; resolve(); },
      });
      dec.configure({
        codec: decCodec, codedWidth: W, codedHeight: H,
        description: d.video.description, optimizeForLatency: false,
      });
      for (const s of d.vSamples) {
        dec.decode(new EncodedVideoChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: (s.cts * 1_000_000) / s.timescale,
          duration: (s.duration * 1_000_000) / s.timescale,
          data: s.data,
        }));
      }
      dec.flush().then(() => {
        if (N === 0) return resolve();
        // a dropped trailing sample must never hang the export
        setTimeout(resolve, 5000);
      }).catch(() => resolve());
    });
    await done;
    prog("finalizing mux…");
    await encoder.flush();
    encoder.close();
    if (encError) throw encError;
    muxer.finalize();
    prog("done ✓");
    return new Blob([muxer.target.buffer], { type: "video/mp4" });
  }

  return { probeModeA, exportModeA, demux };
})();
