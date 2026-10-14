"""GPX Overlay Studio — FastAPI backend wrapping the gpx2video engine."""
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from fastapi import (FastAPI, File, HTTPException, Request, Response,
                     UploadFile)
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).resolve().parent
PROJECTS = BASE / "projects"
PROJECTS.mkdir(exist_ok=True)
ENGINE_DIR = Path("/home/fi/gpx2video/build")
ENGINE = ENGINE_DIR / "tools" / "gpx2video"
LIB_ENV = {**os.environ,
           "LD_LIBRARY_PATH": "/home/fi/sysroot-gpx2video/usr/lib/x86_64-linux-gnu:/home/fi/sysroot-gpx2video/usr/lib"}

app = FastAPI(title="GPX Overlay Studio")
JOBS: dict = {}
JOBS_LOCK = threading.Lock()

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}
HR_NS = "{http://www.garmin.com/xmlschemas/TrackPointExtension/v1}"


@app.get("/api/health")
def health():
    return {"ok": True, "engine": ENGINE.exists()}


# ---------------------------------------------------------------- gpx parse
def parse_gpx(path: Path) -> dict:
    root = ET.parse(path).getroot()
    pts = []
    for p in root.findall(".//g:trkpt", GPX_NS):
        t = p.findtext("g:time", namespaces=GPX_NS)
        if not t:
            continue
        ts = datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
        ext = p.find("g:extensions", GPX_NS)
        hr = cad = power = temp = None
        if ext is not None:
            hr = ext.findtext(f".//{HR_NS}hr")
            cad = ext.findtext(f".//{HR_NS}cad")
            power = ext.findtext(f".//{HR_NS}power")
            temp = ext.findtext(f".//{HR_NS}atemp")
        pts.append({
            "t": ts,
            "lat": float(p.get("lat")), "lon": float(p.get("lon")),
            "ele": float(p.findtext("g:ele", namespaces=GPX_NS) or 0),
            "hr": int(hr) if hr else None,
            "cad": int(cad) if cad else None,
            "power": float(power) if power else None,
            "temp": float(temp) if temp else None,
        })
    if not pts:
        raise HTTPException(400, "GPX has no timestamped trackpoints")
    pts.sort(key=lambda q: q["t"])
    t0 = pts[0]["t"]
    R = 6371000.0

    def hav(a, b):
        import math
        p1, p2 = math.radians(a["lat"]), math.radians(b["lat"])
        dp = math.radians(b["lat"] - a["lat"])
        dl = math.radians(b["lon"] - a["lon"])
        h = (math.sin(dp / 2) ** 2 +
             math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
        return 2 * R * math.asin(math.sqrt(h))

    cum = 0.0
    for i, q in enumerate(pts):
        if i:
            cum += hav(pts[i - 1], q)
            dt = q["t"] - pts[i - 1]["t"]
            q["speed"] = hav(pts[i - 1], q) / dt if dt > 0 else 0.0
            de = q["ele"] - pts[i - 1]["ele"]
            dq = hav(pts[i - 1], q)
            q["grade"] = 100.0 * de / dq if dq > 1 else 0.0
        else:
            q["speed"] = 0.0
            q["grade"] = 0.0
        q["rel"] = q["t"] - t0
        q["dist"] = cum
    return {
        "t0": t0,
        "duration": pts[-1]["rel"],
        "points": [{k: q[k] for k in
                    ("rel", "lat", "lon", "ele", "hr", "cad", "power",
                     "temp", "speed", "grade", "dist")} for q in pts],
        "has": {
            "hr": any(q["hr"] for q in pts),
            "cad": any(q["cad"] for q in pts),
            "power": any(q["power"] for q in pts),
            "temp": any(q["temp"] for q in pts),
        },
    }


# ---------------------------------------------------------------- projects
@app.post("/api/projects")
def create_project(video: UploadFile = File(...), gpx: UploadFile = File(...)):
    pid = uuid.uuid4().hex[:12]
    pdir = PROJECTS / pid
    pdir.mkdir()
    vpath = pdir / ("video" + Path(video.filename or "v.mp4").suffix.lower())
    gpath = pdir / "track.gpx"
    with vpath.open("wb") as f:
        shutil.copyfileobj(video.file, f)
    with gpath.open("wb") as f:
        shutil.copyfileobj(gpx.file, f)

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate,nb_frames,"
         "color_transfer,color_primaries,color_space,bit_rate,profile:"
         "stream_tags=rotate:stream_side_data=rotation",
         "-show_entries", "format=duration,size,bit_rate", "-of", "json",
         str(vpath)],
        capture_output=True, text=True)
    info = json.loads(probe.stdout or "{}")
    stream = (info.get("streams") or [{}])[0]
    # display orientation: portrait phone videos are coded landscape + a
    # rotation flag — widgets and layout must use DISPLAY dimensions
    rot = 0
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                rot = abs(int(float(sd["rotation"])))
            except (TypeError, ValueError):
                pass
    if not rot:
        try:
            rot = abs(int((stream.get("tags") or {}).get("rotate", 0)))
        except (TypeError, ValueError):
            pass
    vw, vh = int(stream.get("width") or 0), int(stream.get("height") or 0)
    if rot % 180 == 90 and vw and vh:
        vw, vh = vh, vw
    fmt = info.get("format") or {}
    try:
        dur = float(fmt.get("duration") or 0)
    except ValueError:
        dur = 0
    fps = 30.0
    try:
        num, den = (stream.get("avg_frame_rate") or "30/1").split("/")
        if float(den) > 0:
            fps = float(num) / float(den)
    except Exception:
        pass
    total = int(stream.get("nb_frames") or round(dur * fps))

    subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(min(0.4, dur / 2)), "-i",
         str(vpath), "-frames:v", "1", "-q:v", "3", str(pdir / "poster.jpg"), "-y"],
        capture_output=True)

    try:
        telemetry = parse_gpx(gpath)
    except Exception as e:
        raise HTTPException(400, f"GPX parse failed: {e}")
    # normalize: the engine rejects odd namespace prefixes from some tools
    write_normalized_gpx(telemetry["points"], telemetry["t0"], gpath)
    (pdir / "telemetry.json").write_text(json.dumps(telemetry))

    meta = {
        "id": pid,
        "video": {"name": video.filename, "path": str(vpath),
                  "w": vw,
                  "h": vh,
                  "duration": dur, "fps": fps, "frames": total,
                  "hdr_filter": HDR_VF if is_hdr(stream) else "",
                  "size": int(fmt.get("size") or 0),
                  "bit_rate": int(fmt.get("bit_rate") or
                                  stream.get("bit_rate") or 0),
                  "profile": stream.get("profile") or ""},
        "gpx": {"name": gpx.filename, "points": len(telemetry["points"]),
                "duration": telemetry["duration"], "has": telemetry["has"]},
    }
    (pdir / "meta.json").write_text(json.dumps(meta))
    return meta


def project_dir(pid: str) -> Path:
    pdir = PROJECTS / pid
    if not pdir.is_dir():
        raise HTTPException(404, "unknown project")
    return pdir


def write_normalized_gpx(pts: list, t0: float, path: Path) -> None:
    """Write a clean, canonical GPX/1.1 for the engine. Uploads may come in
    with odd namespace prefixes the engine's parser rejects — normalize once.
    Uses lxml so the Garmin-style ns3: extension prefix is preserved (the
    engine's non-namespace-aware parser matches it)."""
    from lxml import etree as LET
    uri = "http://www.topografix.com/GPX/1/1"
    tpe = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
    q = lambda t: f"{{{uri}}}{t}"
    qt = lambda t: f"{{{tpe}}}{t}"
    root = LET.Element(q("gpx"), nsmap={None: uri, "ns3": tpe},
                       creator="kongming", version="1.1")
    md = LET.SubElement(root, q("metadata"))
    LET.SubElement(md, q("time")).text = (
        datetime.fromtimestamp(t0, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
    trk = LET.SubElement(root, q("trk"))
    LET.SubElement(trk, q("name")).text = "track"
    seg = LET.SubElement(trk, q("trkseg"))
    for p in pts:
        pt = LET.SubElement(seg, q("trkpt"),
                            lat=repr(p["lat"]), lon=repr(p["lon"]))
        LET.SubElement(pt, q("ele")).text = repr(p["ele"])
        LET.SubElement(pt, q("time")).text = (
            datetime.fromtimestamp(t0 + p["rel"], timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%S.000Z"))
        exts = {k: p.get(k) for k in ("hr", "cad", "power", "temp")
                if p.get(k) is not None}
        if exts:
            ext = LET.SubElement(pt, q("extensions"))
            tpx = LET.SubElement(ext, qt("TrackPointExtension"))
            for k in ("hr", "cad", "power", "temp"):
                if k in exts:
                    tag = {"temp": "atemp"}.get(k, k)
                    LET.SubElement(tpx, qt(tag)).text = repr(exts[k])
    LET.ElementTree(root).write(str(path), encoding="UTF-8",
                                xml_declaration=True)


HDR_VF = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
          "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
          "eq=contrast=1.32:saturation=1.45:brightness=-0.09:gamma=0.93,"
          "format=yuv420p")


def is_hdr(stream: dict) -> bool:
    return (stream.get("color_transfer") or "").lower() in (
        "arib-std-b67", "smpte2084", "smpte428")


def get_project_meta(pid: str) -> dict:
    return json.loads(project_dir(pid).joinpath("meta.json").read_text())


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return get_project_meta(pid)


@app.get("/api/projects")
def latest_project():
    dirs = sorted((d for d in PROJECTS.iterdir()
                   if d.is_dir() and d.name != "_layouts"),
                  key=lambda d: d.stat().st_mtime, reverse=True)
    for d in dirs:
        if (d / "meta.json").exists():
            return json.loads((d / "meta.json").read_text())
    return {}


@app.get("/api/projects/{pid}/video")
def get_video(pid: str):
    pdir = project_dir(pid)
    meta = json.loads(pdir.joinpath("meta.json").read_text())
    return FileResponse(Path(meta["video"]["path"]),
                        media_type="video/mp4")


@app.get("/api/projects/{pid}/telemetry")
def get_telemetry(pid: str):
    return json.loads(project_dir(pid).joinpath("telemetry.json").read_text())


@app.get("/api/projects/{pid}/poster")
def get_poster(pid: str):
    return FileResponse(project_dir(pid) / "poster.jpg")


# ---------------------------------------------------------------- layout xml
def widget_xml(w: dict) -> ET.Element:
    wtype = w.get("type", "text")

    def sub(el, tag, val):
        if val is not None and val != "":
            ET.SubElement(el, tag).text = str(val)

    # map & track are top-level layout elements, not widgets
    if wtype in ("map", "track"):
        el = ET.Element(wtype)
        el.set("x", str(int(w.get("x", 0))))
        el.set("y", str(int(w.get("y", 0))))
        el.set("width", str(int(w.get("w", 200))))
        el.set("height", str(int(w.get("h", 80))))
        el.set("display", "true" if w.get("display", True) else "false")
        if wtype == "track":
            el.set("orientation", "horizontal")
            sub(el, "border", w.get("border", 1))
            sub(el, "border-color", w.get("border_color", "#000000ff"))
            bg_op = float(w.get("bg_opacity", 0.2))
            bg = (w.get("bg_color", "#000000") or "#000000").lstrip("#")[:6]
            sub(el, "background-color",
                f"#{bg}{format(max(0, min(255, round(bg_op * 255))), '02x')}")
        else:
            sub(el, "source", w.get("source", 1))
            sub(el, "zoom", w.get("zoom", 13))
            sub(el, "factor", w.get("factor", 2))
            sub(el, "margin", w.get("margin", 16))
            sub(el, "border", w.get("border", 4))
            sub(el, "border-color", w.get("border_color", "#000000ff"))
        return el

    el = ET.Element("widget")
    el.set("x", str(int(w.get("x", 0))))
    el.set("y", str(int(w.get("y", 0))))
    el.set("width", str(int(w.get("w", 200))))
    el.set("height", str(int(w.get("h", 80))))
    el.set("display", "true" if w.get("display", True) else "false")

    sub(el, "type", wtype)
    sub(el, "name", w.get("label", ""))
    sub(el, "margin", w.get("margin", 0))
    sub(el, "padding", w.get("padding", 5))
    if wtype == "gpx":
        # route-line widget: mostly styling
        sub(el, "gauge-primary-color", w.get("primary_color", "#ffffff"))
        sub(el, "gauge-width", w.get("gauge_width", 4))
        return el
    style = w.get("style", "text")
    if style == "barv":
        sub(el, "shape", "bar")
        el.set("orientation", "vertical")
    elif style in ("text", "big", "arc", "bar", "chart"):
        sub(el, "shape", "arc" if style == "arc" else
            "bar" if style == "bar" else
            "chart" if style == "chart" else "text")
    ff = w.get("font_family", "Orbitron")
    sub(el, "label-font-family", ff)
    sub(el, "value-font-family", ff)
    sub(el, "unit-font-family", ff)
    if style in ("arc", "bar", "barv"):
        # NOTE: gauge-angle is load-bearing — an arc/bar widget with sweep 0
        # divides by zero in the engine's tickinit and crashes the renderer.
        sub(el, "with-gauge", "true")
        sub(el, "gauge-angle", max(60, int(w.get("gauge_angle", 270))))
        sub(el, "gauge-rotation", w.get("gauge_rotation", 0))
        sub(el, "with-needle", "false")
        sub(el, "with-tick", "false")
        sub(el, "with-tick-label", "false")
        sub(el, "gauge-width", w.get("gauge_width", 12))
        sub(el, "gauge-cap", "round")
        sub(el, "gauge-primary-color", w.get("primary_color", "#ffffff"))
        sub(el, "gauge-secondary-color", w.get("secondary_color", "#ffffff55"))
        if w.get("auto_range", True):
            sub(el, "value-min-auto", "true")
            sub(el, "value-max-auto", "true")
        else:
            sub(el, "value-min-auto", "false")
            sub(el, "value-min", w.get("value_min", 0))
            sub(el, "value-max-auto", "false")
            sub(el, "value-max", w.get("value_max", 100))
    sub(el, "value-unit", w.get("unit", ""))
    sub(el, "value-format", w.get("format", ""))
    sub(el, "with-label", "true" if w.get("show_label", True) else "false")
    sub(el, "with-value", "true" if w.get("show_value", True) else "false")
    sub(el, "with-unit", "true" if w.get("show_unit", True) else "false")
    sub(el, "with-icon", "true" if w.get("show_icon", True) else "false")
    sub(el, "label-font-size", w.get("label_size", 16))
    sub(el, "value-font-size", w.get("value_size", 34))
    sub(el, "unit-font-size", w.get("unit_size", 20))
    sub(el, "value-font-weight", w.get("value_weight", "bold"))
    sub(el, "label-color", w.get("label_color", "#ffffff"))
    sub(el, "value-color", w.get("value_color", "#ffffff"))
    sub(el, "unit-color", w.get("unit_color", "#ffffff"))
    sub(el, "icon-color", w.get("icon_color", "#ffffff"))
    sub(el, "value-horizontal-align", w.get("value_align", "left"))
    shadow = w.get("shadow", 3)
    sub(el, "text-shadow", shadow)
    sub(el, "label-shadow-distance", shadow)
    sub(el, "value-shadow-distance", shadow)
    sub(el, "unit-shadow-distance", shadow)
    bg_op = float(w.get("bg_opacity", 0.33))
    bg = (w.get("bg_color", "#000000") or "#000000").lstrip("#")[:6]
    if w.get("bg_color"):
        sub(el, "background-color",
            f"#{bg}{format(max(0, min(255, round(bg_op * 255))), '02x')}")
    if w.get("round_corner"):
        sub(el, "round-corner", w.get("round_corner"))
    return el


def build_layout_xml(state: dict) -> str:
    """Engine layout: ONLY map widgets (tiles need the engine). Everything
    else — including route/track charts — is composited by overlay.py,
    because the engine's shape renderers are unreliable."""
    root = ET.Element("layout")
    for w in state.get("widgets", []):
        if w.get("type") == "map" and w.get("display", True):
            root.append(widget_xml(w))
    tree = ET.ElementTree(root)
    ET.indent(tree)
    out = PROJECTS / "_layouts"
    out.mkdir(exist_ok=True)
    path = out / f"{uuid.uuid4().hex[:10]}.xml"
    tree.write(path, encoding="UTF-8", xml_declaration=True)
    return str(path)


# ---------------------------------------------------------------- overlay pass
def composite_overlay(in_mp4: Path, out_mp4: Path, widgets: list,
                      telemetry: dict, meta: dict, progress_cb=None,
                      t_offset: float = 0.0):
    """Composite value widgets (rendered per-frame by overlay.py) over the
    engine's output video via ffmpeg."""
    import overlay as ov
    tel = ov.Telemetry(telemetry)
    W, H = meta["video"]["w"], meta["video"]["h"]
    fps = meta["video"]["fps"] or 30.0
    nframes = max(1, int(meta["video"]["frames"] or round(meta["video"]["duration"] * fps)))
    hdr = (meta.get("video") or {}).get("hdr_filter") or ""
    base = f"[0:v]{hdr}[b];[b][1:v]overlay=0:0[v]" if hdr \
        else "[0:v][1:v]overlay=0:0[v]"
    cmd = ["ffmpeg", "-v", "error", "-i", str(in_mp4),
           "-f", "image2pipe", "-framerate", str(fps), "-i", "-",
           "-filter_complex", base, "-map", "[v]", "-map", "0:a?",
           "-c:v", "libx264", "-preset", "slow", "-crf", "15",
           "-pix_fmt", "yuv420p", "-c:a", "copy", "-y", str(out_mp4)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for i in range(nframes):
            proc.stdin.write(ov.overlay_png(W, H, widgets, tel,
                                            t_offset + i / fps))
            if progress_cb:
                progress_cb(i)
    finally:
        proc.stdin.close()
        proc.wait()
    return out_mp4.exists()


# ---------------------------------------------------------------- render
def engine_cmd(pdir: Path, layout: str, out: str, extra: list) -> list:
    meta = json.loads(pdir.joinpath("meta.json").read_text())
    return [str(ENGINE), "-v",
            "-m", meta["video"]["path"],
            "-g", str(pdir / "track.gpx"),
            "-l", layout,
            "-o", out] + extra


def run_job(jid: str, out_path: Path, total_frames: int,
            widgets: list, telemetry: dict, meta: dict):
    """Single-pass render: composite widgets over the source video at high
    quality. (A separate engine encode pass caused visible blockiness.)"""
    with JOBS_LOCK:
        JOBS[jid].update(status="running", frames=0, total=total_frames,
                         phase="compositing")
    try:
        def cb(i):
            with JOBS_LOCK:
                JOBS[jid]["frames"] = i

        ok = composite_overlay(Path(meta["video"]["path"]), out_path,
                               widgets, telemetry, meta, cb,
                               t_offset=float(meta.get("_offset", 0)))
        with JOBS_LOCK:
            if ok:
                JOBS[jid].update(status="done", frames=total_frames, phase="done")
            else:
                JOBS[jid].update(status="failed", error="render failed")
    except Exception as e:
        with JOBS_LOCK:
            JOBS[jid].update(status="failed", error=str(e)[:300])


@app.post("/api/projects/{pid}/render")
def render(pid: str, request: Request, body: dict):
    pdir = project_dir(pid)
    state = body.get("layout") or {}
    offset_ms = int(body.get("sync_offset_ms") or 0)
    out = pdir / "output.mp4"
    meta = json.loads(pdir.joinpath("meta.json").read_text())
    telemetry = json.loads(pdir.joinpath("telemetry.json").read_text())
    widgets = list(state.get("widgets", []))
    meta["_offset"] = offset_ms / 1000.0
    jid = uuid.uuid4().hex[:10]
    with JOBS_LOCK:
        JOBS[jid] = {"id": jid, "pid": pid, "status": "queued",
                     "frames": 0, "total": meta["video"]["frames"],
                     "phase": "compositing"}
    threading.Thread(target=run_job,
                     args=(jid, out, meta["video"]["frames"],
                           widgets, telemetry, meta),
                     daemon=True).start()
    return {"job": jid}


# --------------------------------------------- Mode B: client-side capture
@app.post("/api/projects/{pid}/export_frame/{idx}")
async def export_frame(pid: str, idx: int, file: UploadFile = File(...)):
    """Accept one client-rendered lossless overlay PNG (1-based index)."""
    pdir = project_dir(pid)
    fdir = pdir / "client_frames"
    fdir.mkdir(exist_ok=True)
    data = await file.read()
    (fdir / f"{idx:06d}.png").write_bytes(data)
    return {"ok": True, "idx": idx, "bytes": len(data)}


def run_mode_b(jid: str, pid: str, frames: int, fps: float, offset_ms: int):
    """One ffmpeg pass over client-rendered frames: mux + encode only.
    The server draws nothing (client-side rendering requirement)."""
    pdir = project_dir(pid)
    meta = json.loads(pdir.joinpath("meta.json").read_text())
    fdir = pdir / "client_frames"
    out = pdir / "output.mp4"
    hdr = (meta.get("video") or {}).get("hdr_filter") or ""
    if hdr:
        fc = f"[1:v]{hdr}[base];[base][0:v]overlay=0:0:eof_action=pass,format=yuv420p[out]"
    else:
        # No HDR chain: never emit "[1:v][base]" (empty filter name)
        fc = "[1:v][0:v]overlay=0:0:eof_action=pass,format=yuv420p[out]"
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-framerate", str(fps), "-start_number", "1",
           "-i", str(fdir / "%06d.png"),
           "-i", meta["video"]["path"],
           "-filter_complex", fc,
           "-map", "[out]", "-map", "1:a?",
           "-c:v", "libx264", "-crf", "15", "-preset", "medium",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart",
           "-progress", "pipe:1", "-nostats",
           str(out)]
    with JOBS_LOCK:
        JOBS[jid].update(status="running", phase="encoding", frames=0, total=frames)
    errf = pdir / "ffmpeg_client_export.log"
    try:
        with open(errf, "w") as ef:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=ef, text=True)
            for line in proc.stdout:
                if line.startswith("frame="):
                    try:
                        n = int(line.split("=", 1)[1])
                    except ValueError:
                        continue
                    with JOBS_LOCK:
                        JOBS[jid]["frames"] = min(n, frames)
            proc.wait()
        if proc.returncode == 0 and out.exists():
            with JOBS_LOCK:
                JOBS[jid].update(status="done", frames=frames, phase="done")
        else:
            err = errf.read_text()[-300:] if errf.exists() else ""
            with JOBS_LOCK:
                JOBS[jid].update(status="failed", error=err or "ffmpeg failed")
    except Exception as e:
        with JOBS_LOCK:
            JOBS[jid].update(status="failed", error=str(e)[:300])


@app.post("/api/projects/{pid}/export_client")
def export_client(pid: str, body: dict):
    frames = int(body.get("frames") or 0)
    fps = float(body.get("fps") or 30)
    offset_ms = int(body.get("sync_offset_ms") or 0)
    fdir = project_dir(pid) / "client_frames"
    have = len(list(fdir.glob("*.png"))) if fdir.exists() else 0
    if frames <= 0 or have < frames:
        raise HTTPException(400, f"missing frames: got {have}/{frames}")
    jid = uuid.uuid4().hex[:10]
    with JOBS_LOCK:
        JOBS[jid] = {"id": jid, "pid": pid, "status": "queued",
                     "frames": 0, "total": frames, "phase": "encoding"}
    threading.Thread(target=run_mode_b,
                     args=(jid, pid, frames, fps, offset_ms),
                     daemon=True).start()
    return {"job": jid}


@app.post("/api/projects/{pid}/client_output_a")
async def client_output_a(pid: str, request: Request):
    """Verification sink: accept a client-rendered Mode A result for checks."""
    data = await request.body()
    p = project_dir(pid) / "output_client_a.mp4"
    p.write_bytes(data)
    return {"ok": True, "bytes": len(data)}


@app.post("/api/projects/{pid}/frame")
def preview_frame(pid: str, body: dict):
    """Pixel-true preview: render ~250ms starting at time t (ms) as a PNG.

    The engine's --trim is an unimplemented stub, so we pre-cut the clip
    with ffmpeg and anchor it on the GPX timeline with --start-time.
    """
    pdir = project_dir(pid)
    state = body.get("layout") or {}
    t_ms = max(0, int(body.get("t_ms") or 0))
    offset_ms = int(body.get("sync_offset_ms") or 0)
    meta = json.loads(pdir.joinpath("meta.json").read_text())
    telemetry = json.loads(pdir.joinpath("telemetry.json").read_text())
    widgets = list(state.get("widgets", []))

    import overlay as ov
    from PIL import Image
    base = pdir / "frame_base.png"
    hdr = (meta.get("video") or {}).get("hdr_filter") or ""
    extract = ["ffmpeg", "-v", "error", "-ss", str(t_ms / 1000), "-i",
               meta["video"]["path"]]
    if hdr:
        extract += ["-vf", hdr]
    extract += ["-frames:v", "1", str(base), "-y"]
    subprocess.run(extract, capture_output=True, timeout=300)
    if not base.exists():
        raise HTTPException(500, "frame extraction failed")
    bg = Image.open(base).convert("RGBA")
    W, H = meta["video"]["w"], meta["video"]["h"]
    if bg.size != (W, H):
        bg = bg.resize((W, H))
    tel = ov.Telemetry(telemetry)
    ov_img = ov.render_overlay(W, H, widgets, tel,
                               t_ms / 1000 + offset_ms / 1000)
    bg.alpha_composite(ov_img)
    png = pdir / "preview_tmp.png"
    bg.convert("RGB").save(png)
    return FileResponse(png, media_type="image/png")


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    with JOBS_LOCK:
        if jid not in JOBS:
            raise HTTPException(404, "unknown job")
        return dict(JOBS[jid])


@app.get("/api/jobs/{jid}/result")
def job_result(jid: str, download: int = 0):
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job or job.get("status") != "done":
        raise HTTPException(409, "job not done")
    path = PROJECTS / job["pid"] / "output.mp4"
    return FileResponse(path, media_type="video/mp4",
                        filename="overlay.mp4" if download else None)


# ---------------------------------------------------------------- static ui
@app.get("/", response_class=HTMLResponse)
def index():
    return (BASE / "static" / "index.html").read_text()


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
