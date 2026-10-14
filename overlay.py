"""Per-frame value-widget overlay renderer (PIL), matching the web preview.

The gpx2video engine draws map/track/route widgets well but its arc/bar
value shapes are unreliable (UAF bug patched, digit rendering corrupted).
So value widgets are composited here from the same model as the DOM preview.
"""
import io
import math
import urllib.request
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

TILE_CACHE = Path("/home/fi/gpx2video-webapp/projects/_tilecache")
TILE_CACHE.mkdir(parents=True, exist_ok=True)


def get_tile(z, x, y):
    """Fetch an OpenStreetMap tile with on-disk cache."""
    if x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
        return None
    p = TILE_CACHE / f"{z}_{x}_{y}.png"
    if p.exists():
        try:
            return Image.open(p).convert("RGB")
        except Exception:
            pass
    try:
        req = urllib.request.Request(
            f"https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            headers={"User-Agent": "gpx-overlay-studio/1.0 (local video overlay)"})
        data = urllib.request.urlopen(req, timeout=15).read()
        p.write_bytes(data)
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None

FONT_PATHS = {
    "Orbitron": "/home/fi/.local/share/fonts/Orbitron.ttf",
    "sans-serif": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "monospace": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
}
_font_cache = {}


def font(family, size, weight="bold"):
    key = (family, int(size), weight)
    if key not in _font_cache:
        path = FONT_PATHS.get(family, FONT_PATHS["Orbitron"])
        try:
            f = ImageFont.truetype(path, int(size))
            if weight != "bold" and family == "Orbitron":
                pass  # variable font: keep default instance
            _font_cache[key] = f
        except Exception:
            _font_cache[key] = ImageFont.load_default()
    return _font_cache[key]


def hex_rgba(hexstr, alpha=1.0):
    h = (hexstr or "#ffffff").lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (r, g, b, max(0, min(255, round(alpha * 255))))


class Telemetry:
    """Python mirror of the frontend's sampleAt / fmtVal / rangeFor."""

    def __init__(self, data: dict):
        self.t0 = data["t0"]
        self.points = data["points"]

    def sample(self, t):
        pts = self.points
        if not pts:
            return {k: 0 for k in ("speed", "hr", "cad", "ele", "dist", "grade", "power", "temp")}
        t = max(0, min(t, pts[-1]["rel"]))
        i = next((k for k, p in enumerate(pts) if p["rel"] >= t), len(pts) - 1)
        if i <= 0:
            i = 1
        if i >= len(pts):
            i = len(pts) - 1
        a, b = pts[i - 1], pts[i]
        f = (t - a["rel"]) / (b["rel"] - a["rel"]) if b["rel"] > a["rel"] else 0
        out = {}
        for k in ("speed", "hr", "cad", "ele", "dist", "grade", "power", "temp"):
            x, y = a.get(k), b.get(k)
            out[k] = (x if y is None else y if x is None else x + (y - x) * f) or 0
        return out

    def series(self, w):
        u = w.get("unit", "")
        t = w["type"]
        if t in ("speed", "avgspeed", "maxspeed"):
            f = 2.236936 if u == "mph" else 1 if u == "mps" else 3.6
            return [p["speed"] * f for p in self.points]
        if t == "heartrate":
            return [p["hr"] for p in self.points if p.get("hr") is not None]
        if t == "cadence":
            return [p["cad"] for p in self.points if p.get("cad") is not None]
        if t == "elevation":
            return [p["ele"] * (3.28084 if u == "ft" else 1) for p in self.points]
        if t == "distance":
            return [p["dist"] / (1609.344 if u == "miles" else 1000) for p in self.points]
        if t == "grade":
            return [p["grade"] for p in self.points]
        if t == "verticalspeed":
            f = 196.85 if u == "feetpermin" else 3600
            return [f * p["speed"] * p["grade"] / 100 for p in self.points]
        return []

    def value(self, w, t):
        s = self.sample(t)
        u, ty = w.get("unit", ""), w["type"]
        if ty in ("speed", "avgspeed", "maxspeed"):
            v = (s["dist"] / t if ty == "avgspeed" and t > 0.2 else s["speed"]) \
                if ty != "avgspeed" else (s["dist"] / t if t > 0.2 else 0)
            if ty == "avgspeed":
                v = s["dist"] / t if t > 0.2 else 0
            f = 2.236936 if u == "mph" else 1 if u == "mps" else 3.6
            return f"{v * f:.1f}"
        if ty == "heartrate":
            return str(round(s["hr"] or 0))
        if ty == "cadence":
            return str(round(s["cad"] or 0))
        if ty == "elevation":
            return str(round(s["ele"] * (3.28084 if u == "ft" else 1)))
        if ty == "distance":
            v = s["dist"] / (1609.344 if u == "miles" else 1000)
            return f"{v:.2f}"
        if ty == "duration":
            t = max(0, t)
            return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{int(t % 60):02d}"
        if ty == "time":
            d = datetime.fromtimestamp(self.t0 + t)
            return d.strftime("%H:%M:%S")
        if ty == "grade":
            return f"{s['grade']:.1f}"
        if ty == "verticalspeed":
            v = (196.85 if u == "feetpermin" else 3600) * s["speed"] * s["grade"] / 100
            return f"{v:.0f}"
        if ty == "temperature":
            return str(round(s["temp"])) if s.get("temp") else "--"
        if ty == "power":
            return str(round(s["power"])) if s.get("power") else "--"
        return "0"

    def value_f(self, w, t):
        try:
            return float(self.value(w, t))
        except ValueError:
            return 0.0

    def range_for(self, w):
        if not w.get("auto_range", True):
            return float(w.get("value_min", 0)), float(w.get("value_max", 100))
        s = self.series(w)
        if not s:
            return 0.0, 1.0
        mn, mx = min(s), max(s)
        if w["type"] == "heartrate":
            mn, mx = min(mn, 80), max(mx, 180)
        if mx - mn < 1:
            mx = mn + 1
        pad = (mx - mn) * 0.15
        return float(math.floor(mn - pad)), float(math.ceil(mx + pad))


UNIT_LABEL = {
    "kph": "km/h", "mph": "mph", "mps": "m/s", "bpm": "bpm",
    "trpermin": "tr/min", "m": "m", "ft": "FT", "km": "km", "miles": "mi",
    "C": "°C", "F": "°F", "watt": "W", "percent": "%",
    "meterperhour": "m/h", "feetpermin": "ft/min",
}


def unit_label(w):
    return UNIT_LABEL.get(w.get("unit", ""), w.get("unit", ""))


def draw_text(dr, xy, txt, fnt, fill, shadow=0, anchor="lm"):
    x, y = xy
    if shadow:
        sh = (0, 0, 0, min(255, 120 + shadow * 12))
        for dx in range(-1, 2):
            for dy in range(-1, 2):
                if dx or dy:
                    dr.text((x + dx * shadow * .7, y + dy * shadow * .7), txt,
                            font=fnt, fill=sh, anchor=anchor)
    dr.text((x, y), txt, font=fnt, fill=fill, anchor=anchor)


def render_widget(img, w, tel, t):
    dr = ImageDraw.Draw(img, "RGBA")
    x, y, W, H = (w.get(k, 0) for k in ("x", "y", "w", "h"))
    style = w.get("style", "text")
    ff = w.get("font_family", "Orbitron")
    shadow = w.get("shadow", 3)
    val = tel.value(w, t)
    ul = unit_label(w)

    if w.get("bg_color"):
        dr.rounded_rectangle([x, y, x + W, y + H],
                             radius=w.get("round_corner", 8),
                             fill=hex_rgba(w["bg_color"], w.get("bg_opacity", .33)))

    c_lbl = hex_rgba(w.get("label_color", "#ffffff"))
    c_val = hex_rgba(w.get("value_color", "#ffffff"))
    c_uni = hex_rgba(w.get("unit_color", "#ffffffcc"))
    fs = lambda n, d: max(6, int(n if n else d))

    if style == "arc":
        cx, cy = x + W / 2, y + H / 2
        r = min(W, H) / 2 - w.get("gauge_width", 14) / 2 - 4
        a0, sweep = 135, w.get("gauge_angle", 270)
        dr.arc([cx - r, cy - r, cx + r, cy + r], a0, a0 + sweep,
               fill=hex_rgba(w.get("secondary_color", "#ffffff55")),
               width=int(w.get("gauge_width", 14)))
        mn, mx = tel.range_for(w)
        frac = max(0, min(1, (tel.value_f(w, t) - mn) / (mx - mn or 1)))
        if frac > 0.001:
            dr.arc([cx - r, cy - r, cx + r, cy + r], a0, a0 + sweep * frac,
                   fill=hex_rgba(w.get("primary_color", "#ffffff")),
                   width=int(w.get("gauge_width", 14)))
        # centered text block (label / value / unit) in the ring
        lines = []
        if w.get("show_label", True) and w.get("label"):
            lines.append((w["label"], font(ff, fs(w.get("label_size"), 16)), c_lbl))
        if w.get("show_value", True):
            lines.append((val, font(ff, fs(w.get("value_size"), 42)), c_val))
        if w.get("show_unit", True) and ul:
            lines.append((ul, font(ff, fs(w.get("unit_size"), 18)), c_uni))
        heights = [f.size * 1.18 for _, f, _ in lines]
        # optical lift: a ring with a bottom gap reads "centered" slightly high
        yy = cy - sum(heights) / 2 - H * 0.022
        for (txt, fnt, col), h in zip(lines, heights):
            draw_text(dr, (cx, yy + h / 2), txt, fnt, col, shadow, anchor="mm")
            yy += h
        return

    if style in ("bar", "barv"):
        vert = style == "barv"
        mn, mx = tel.range_for(w)
        frac = max(0, min(1, (tel.value_f(w, t) - mn) / (mx - mn or 1)))
        padx = x + 10
        f_cap = font(ff, fs(w.get("label_size"), 16) * .8)

        def fit_font(txt, size, max_w):
            """Shrink a font until the text fits max_w (keeps columns apart)."""
            f = font(ff, size)
            while size > 6 and dr.textlength(txt, font=f) > max_w:
                size -= 1
                f = font(ff, size)
            return f

        if vert:
            bw = max(10, int(W * .18))
            bx = x + W - bw - 12
            ty0, ty1 = y + 30, y + H - 30
            dr.rounded_rectangle([bx, ty0, bx + bw, ty1], radius=bw // 2,
                                 fill=hex_rgba(w.get("secondary_color", "#ffffff55")))
            fill_h = (ty1 - ty0) * frac
            if fill_h > 1:
                dr.rounded_rectangle([bx, ty1 - fill_h, bx + bw, ty1],
                                     radius=bw // 2,
                                     fill=hex_rgba(w.get("primary_color", "#ffffff")))
            draw_text(dr, (bx + bw / 2, ty0 - 6), str(round(mx)), f_cap, c_lbl)
            draw_text(dr, (bx + bw / 2, ty1 + 6), str(round(mn)), f_cap, c_lbl)
            # text column LEFT of the bar, shrink-to-fit: label and value can
            # never cross the bar edge (was overlapping per review)
            avail = bx - padx - 8
            yy = y + 18
            if w.get("show_label", True) and w.get("label"):
                draw_text(dr, (padx, yy), w["label"],
                          fit_font(w["label"], fs(w.get("label_size"), 16), avail),
                          c_lbl, shadow)
                yy += fs(w.get("label_size"), 16) * 1.3
            if w.get("show_value", True):
                vf = fit_font(val, fs(w.get("value_size"), 32), avail)
                draw_text(dr, (padx, yy + vf.size * .5), val, vf, c_val, shadow)
        else:
            # one text row (label left, value+unit right) with the bar below;
            # nothing sits on the bar (value was overlapping per review)
            row_h = fs(w.get("value_size"), 32)
            row_mid = y + 16 + row_h * .5
            uf = font(ff, fs(w.get("unit_size"), 18))
            ulw = dr.textlength(" " + ul, font=uf) \
                if (w.get("show_unit", True) and ul) else 0
            vw = dr.textlength(val, font=font(ff, row_h))
            right = x + W - 12
            if w.get("show_value", True):
                draw_text(dr, (right - ulw, row_mid), val,
                          font(ff, row_h), c_val, shadow, anchor="rm")
                if ulw:
                    draw_text(dr, (right, row_mid + row_h * .12), ul,
                              uf, c_uni, shadow, anchor="rm")
            if w.get("show_label", True) and w.get("label"):
                avail = max(20, right - ulw - vw - padx - 16)
                draw_text(dr, (padx, row_mid), w["label"],
                          fit_font(w["label"], fs(w.get("label_size"), 16), avail),
                          c_lbl, shadow)
            bar_y = y + H - 26
            bh = max(8, int(H * .12))
            dr.rounded_rectangle([padx, bar_y, x + W - 12, bar_y + bh],
                                 radius=bh // 2,
                                 fill=hex_rgba(w.get("secondary_color", "#ffffff55")))
            fill_w = (x + W - 12 - padx) * frac
            if fill_w > 1:
                dr.rounded_rectangle([padx, bar_y, padx + fill_w, bar_y + bh],
                                     radius=bh // 2,
                                     fill=hex_rgba(w.get("primary_color", "#ffffff")))
            draw_text(dr, (padx, bar_y + bh + 8), str(round(mn)), f_cap, c_lbl)
            dr.text((x + W - 10, bar_y + bh + 8), str(round(mx)), font=f_cap,
                    fill=c_lbl, anchor="rm")
        return

    # "text" and "big"
    pad = 10
    if style == "big":
        colx = x + pad if w.get("value_align", "left") == "left" else x + W / 2
        yy = y + H / 2
        if w.get("show_unit", True) and ul:
            yy -= fs(w.get("value_size"), 42) * .35
            draw_text(dr, (colx, yy - fs(w.get("value_size"), 42) * .4), ul,
                      font(ff, fs(w.get("unit_size"), 18)), c_uni, shadow)
        if w.get("show_label", True) and w.get("label"):
            draw_text(dr, (colx, yy - fs(w.get("value_size"), 42) * .35), w["label"],
                      font(ff, fs(w.get("label_size"), 16)), c_lbl, shadow)
        if w.get("show_value", True):
            draw_text(dr, (colx, yy + fs(w.get("value_size"), 42) * .25), val,
                      font(ff, fs(w.get("value_size"), 42)), c_val, shadow)
        return

    colx = x + pad
    yy = y + H * .3
    if w.get("show_label", True) and w.get("label"):
        draw_text(dr, (colx, yy), w["label"],
                  font(ff, fs(w.get("label_size"), 16)), c_lbl, shadow)
        yy += fs(w.get("value_size"), 42) * .62
    row_y = y + H * .62
    xx = colx
    if w.get("show_value", True):
        draw_text(dr, (xx, row_y), val,
                  font(ff, fs(w.get("value_size"), 42)), c_val, shadow)
        xx += dr.textlength(val, font=font(ff, fs(w.get("value_size"), 42))) + 8
    if w.get("show_unit", True) and ul:
        draw_text(dr, (xx, row_y + fs(w.get("value_size"), 42) * .12), ul,
                  font(ff, fs(w.get("unit_size"), 18)), c_uni, shadow)


def draw_map(img, w, tel, t):
    """Real slippy-map tiles (OpenStreetMap) + route + position marker."""
    pts = tel.points
    if not pts:
        return
    x0, y0, W, H = (w.get(k, 0) for k in ("x", "y", "w", "h"))
    pad = 14

    def deg2num(lat, lon, z):
        lat_r = math.radians(lat)
        n = 2.0 ** z
        return ((lon + 180.0) / 360.0 * n,
                (1.0 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi)
                / 2.0 * n)

    lats = [p["lat"] for p in pts]
    lons = [p["lon"] for p in pts]
    z = 18
    while z > 3:
        x1, y1 = deg2num(max(lats), min(lons), z)
        x2, y2 = deg2num(min(lats), max(lons), z)
        if (x2 - x1) * 256 <= (W - 2 * pad) and (y2 - y1) * 256 <= (H - 2 * pad):
            break
        z -= 1
    x1, y1 = deg2num(max(lats), min(lons), z)
    x2, y2 = deg2num(min(lats), max(lons), z)
    origin_x = x1 * 256 - (W - (x2 - x1) * 256) / 2
    origin_y = y1 * 256 - (H - (y2 - y1) * 256) / 2

    canvas = Image.new("RGBA", (W, H), (238, 238, 232, 255))
    tx0, ty0 = int(origin_x // 256), int(origin_y // 256)
    tx1, ty1 = int((origin_x + W) // 256) + 1, int((origin_y + H) // 256) + 1
    for tx in range(tx0, tx1 + 1):
        for ty in range(max(0, ty0), max(0, ty1) + 1):
            tile = get_tile(z, tx, ty)
            if tile is not None:
                canvas.paste(tile, (tx * 256 - int(origin_x), ty * 256 - int(origin_y)))

    dr = ImageDraw.Draw(img, "RGBA")

    def proj(p):
        xn, yn = deg2num(p["lat"], p["lon"], z)
        return (x0 + xn * 256 - origin_x, y0 + yn * 256 - origin_y)

    line = [proj(p) for p in pts]
    dr.rectangle([x0, y0, x0 + W, y0 + H], fill=(0, 0, 0, 0))
    img.paste(canvas, (int(x0), int(y0)))
    dr = ImageDraw.Draw(img, "RGBA")
    lw = 4
    dr.line([(px + 2, py + 2) for px, py in line], fill=(0, 0, 0, 130),
            width=lw, joint="curve")
    dr.line(line, fill=hex_rgba(w.get("primary_color", "#e8542a")), width=lw,
            joint="curve")
    cur = next((p for p in pts if p["rel"] >= t), pts[-1])
    cx, cy = proj(cur)
    r = 7
    dr.ellipse([cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2], fill=(0, 0, 0, 130))
    dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(30, 120, 230, 255))
    dr.ellipse([cx - r + 2, cy - r + 2, cx + r - 2, cy + r - 2],
               outline=(255, 255, 255, 255), width=2)
    attr = font("sans-serif", 9)
    dr.text((x0 + W - 8, y0 + H - 6), "© OpenStreetMap", font=attr,
            fill=(60, 60, 60, 220), anchor="rs")
    if w.get("border"):
        dr.rectangle([x0, y0, x0 + W, y0 + H],
                     outline=hex_rgba(w.get("border_color", "#000000")),
                     width=int(w["border"]))


def render_overlay(w, h, widgets, tel, t):
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for wd in widgets:
        if not wd.get("display", True):
            continue
        if wd.get("type") == "gpx":
            draw_route(img, wd, tel, t)
        elif wd.get("type") == "track":
            draw_track(img, wd, tel, t)
        elif wd.get("type") == "map":
            draw_map(img, wd, tel, t)
        else:
            render_widget(img, wd, tel, t)
    return img


def _proj(pts, W, H, pad):
    lat0 = (min(p["lat"] for p in pts) + max(p["lat"] for p in pts)) / 2
    kx = math.cos(math.radians(lat0))
    xs = [p["lon"] * kx for p in pts]
    ys = [-p["lat"] for p in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    sc = min((W - 2 * pad) / ((maxx - minx) or 1e-9),
             (H - 2 * pad) / ((maxy - miny) or 1e-9))

    def f(p):
        return (pad + (p["lon"] * kx - minx) * sc, pad + (-p["lat"] - miny) * sc)
    return f


def draw_route(img, w, tel, t):
    pts = tel.points
    if not pts:
        return
    dr = ImageDraw.Draw(img, "RGBA")
    x, y, W, H = (w.get(k, 0) for k in ("x", "y", "w", "h"))
    proj = _proj(pts, W, H, 18)
    line = [proj(p) for p in pts]
    shifted = [(px + x, py + y) for px, py in line]
    lw = int(w.get("gauge_width", 5))
    col = hex_rgba(w.get("primary_color", "#ffffff"))
    sh = (0, 0, 0, 140)
    dr.line([(px + 2, py + 2) for px, py in shifted], fill=sh, width=lw, joint="curve")
    dr.line(shifted, fill=col, width=lw, joint="curve")
    cur = next((p for p in pts if p["rel"] >= t), pts[-1])
    cx, cy = proj(cur)
    cx, cy = cx + x, cy + y
    r = 8
    dr.ellipse([cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2], fill=sh)
    dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    dr.ellipse([cx - r + 2, cy - r + 2, cx + r - 2, cy + r - 2],
               outline=(255, 255, 255, 255), width=2)


def draw_track(img, w, tel, t):
    pts = tel.points
    if not pts:
        return
    dr = ImageDraw.Draw(img, "RGBA")
    x, y, W, H = (w.get(k, 0) for k in ("x", "y", "w", "h"))
    if w.get("bg_color"):
        dr.rectangle([x, y, x + W, y + H],
                     fill=hex_rgba(w["bg_color"], w.get("bg_opacity", .2)))
    eles = [p["ele"] for p in pts]
    mine, maxe = min(eles), max(eles)
    span = (maxe - mine) or 1
    tspan = pts[-1]["rel"] or 1

    def px(p):
        return x + 8 + (p["rel"] / tspan) * (W - 16)

    def py(p):
        return y + H - 14 - ((p["ele"] - mine) / span) * (H - 30)

    poly = [(px(p), py(p)) for p in pts]
    dr.polygon([poly[0], *poly, (poly[-1][0], y + H - 8), (poly[0][0], y + H - 8)],
               fill=hex_rgba(w.get("primary_color", "#ffffff"), 0.22))
    dr.line(poly, fill=hex_rgba(w.get("primary_color", "#ffffff")), width=3,
            joint="curve")
    cur = next((p for p in pts if p["rel"] >= t), pts[-1])
    cx = px(cur)
    dr.line([(cx, y + 6), (cx, y + H - 6)],
            fill=hex_rgba(w.get("secondary_color", "#ff6b35")), width=2)
    cy = py(cur)
    dr.ellipse([cx - 5, cy - 5, cx + 5, cy + 5],
               fill=hex_rgba(w.get("secondary_color", "#ff6b35")))
    fnt = font(w.get("font_family", "Orbitron"), max(10, H * .11))
    lbl = f"{w.get('label', 'ALT')}: {round(cur['ele'])} {unit_label(w)}"
    draw_text(dr, (x + 12, y + H * .16), lbl, fnt,
              hex_rgba(w.get("label_color", "#ffffff")), 2)
    if w.get("border"):
        dr.rectangle([x, y, x + W, y + H],
                     outline=hex_rgba(w.get("border_color", "#000000")),
                     width=int(w["border"]))


def overlay_png(w, h, widgets, tel, t):
    img = render_overlay(w, h, widgets, tel, t)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
