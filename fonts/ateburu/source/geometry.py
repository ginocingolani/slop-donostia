"""Ateburu's drawing toolkit: exact contours for stems, diagonals, bars, ovals and nib-expanded strokes, joined with
skia-pathops booleans, then turned into interpolation-compatible TrueType outlines.

Everything a glyph is made of is a closed contour built from straight lines and cubic Béziers whose points are computed
from the master's parameters (see glyphs.py). Strokes meet one another only at transversal crossings, never along
tangents, so the booleans give clean corners; within one primitive (a serifed stem, a bracketed diagonal) the joins are
drawn exactly and stay smooth.
"""
import contextlib
import math

import pathops
from fontTools.cu2qu import curves_to_quadratic

# The curvature (CURV axis, 0..1) the primitives below draw at: set by build.py around each master's drawing. At 0
# every primitive draws exactly as in the straight cut; above 0 the stems flare towards their ends, serif brackets
# and wedge ends curve into their strokes, and diagonals may bow.
CURV = 0.0


@contextlib.contextmanager
def curvature(c):
    global CURV
    old, CURV = CURV, c
    try:
        yield
    finally:
        CURV = old

# ---------------------------------------------------------------------------------------------------------------------
# vectors and Béziers


def add(p, q):
    return (p[0] + q[0], p[1] + q[1])


def sub(p, q):
    return (p[0] - q[0], p[1] - q[1])


def mul(p, k):
    return (p[0] * k, p[1] * k)


def dot(p, q):
    return p[0] * q[0] + p[1] * q[1]


def length(p):
    return math.hypot(p[0], p[1])


def unit(p):
    n = length(p)
    return (p[0] / n, p[1] / n) if n else (0.0, 0.0)


def lerp(p, q, t):
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)


def bez(c, t):
    p0, p1, p2, p3 = c
    u = 1 - t
    a, b, cc, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
    return (a * p0[0] + b * p1[0] + cc * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + cc * p2[1] + d * p3[1])


def bez_d(c, t):
    p0, p1, p2, p3 = c
    u = 1 - t
    a, b, cc = 3 * u * u, 6 * u * t, 3 * t * t
    return (a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + cc * (p3[0] - p2[0]),
            a * (p1[1] - p0[1]) + b * (p2[1] - p1[1]) + cc * (p3[1] - p2[1]))


def split(c, t):
    p0, p1, p2, p3 = c
    a, b, cc = lerp(p0, p1, t), lerp(p1, p2, t), lerp(p2, p3, t)
    d, e = lerp(a, b, t), lerp(b, cc, t)
    f = lerp(d, e, t)
    return (p0, a, d, f), (f, e, cc, p3)


def line_cubic(p, q):
    """A straight line as a cubic (for spines)"""
    return (p, lerp(p, q, 1 / 3), lerp(p, q, 2 / 3), q)


def arc_cubic(p, tp, q, tq, k=0.55):
    """A cubic from p (leaving along unit tangent tp) to q (arriving along unit tangent tq); handle length k × chord"""
    d = length(sub(q, p)) * k
    return (p, add(p, mul(unit(tp), d)), sub(q, mul(unit(tq), d)), q)


def hobby(p, tp, q, tq, tension=1.0):
    """John Hobby's curve between two points with given directions: the most natural-looking cubic for the pair"""
    tp, tq = unit(tp), unit(tq)
    chord = sub(q, p)
    dist = length(chord)
    ang = math.atan2(chord[1], chord[0])
    theta = math.atan2(tp[1], tp[0]) - ang
    phi = ang - math.atan2(tq[1], tq[0])
    theta = (theta + math.pi) % (2 * math.pi) - math.pi
    phi = (phi + math.pi) % (2 * math.pi) - math.pi
    a, b = 2 ** 0.5, 1 / 16
    c = (3 - 5 ** 0.5) / 2
    st, ct, sp, cp = math.sin(theta), math.cos(theta), math.sin(phi), math.cos(phi)
    alpha = a * (st - b * sp) * (sp - b * st) * (ct - cp)
    rho = (2 + alpha) / (1 + (1 - c) * ct + c * cp)
    sigma = (2 - alpha) / (1 + (1 - c) * cp + c * ct)
    return (p, add(p, mul(tp, rho * dist / (3 * tension))), sub(q, mul(tq, sigma * dist / (3 * tension))), q)


# ---------------------------------------------------------------------------------------------------------------------
# contours → skia paths


class Contour:
    """A closed contour: a start point and segments ('L', p) / ('C', c1, c2, p)"""

    def __init__(self, start):
        self.start = tuple(start)
        self.segs = []
        self.cur = self.start

    def L(self, p):
        p = tuple(p)
        if length(sub(p, self.cur)) > 1e-6:
            self.segs.append(('L', p))
            self.cur = p
        return self

    def C(self, c1, c2, p):
        self.segs.append(('C', tuple(c1), tuple(c2), tuple(p)))
        self.cur = tuple(p)
        return self

    def cubic(self, c):
        """append a cubic given as (p0, p1, p2, p3) whose p0 is the current point"""
        return self.C(c[1], c[2], c[3])

    def path(self):
        p = pathops.Path()
        pen = p.getPen()
        pen.moveTo(self.start)
        for s in self.segs:
            if s[0] == 'L':
                pen.lineTo(s[1])
            else:
                pen.curveTo(s[1], s[2], s[3])
        pen.closePath()
        return p


def polygon(pts):
    c = Contour(pts[0])
    for p in pts[1:]:
        c.L(p)
    return c.path()


def rect(x0, y0, x1, y1):
    return polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def union(paths):
    paths = [p for p in paths if p is not None]
    out = paths[0]
    for p in paths[1:]:
        out = pathops.op(out, p, pathops.PathOp.UNION, clockwise=True)
    return pathops.simplify(out, clockwise=True)


def diff(a, b):
    return pathops.op(a, b, pathops.PathOp.DIFFERENCE, clockwise=True)


def inter(a, b):
    return pathops.op(a, b, pathops.PathOp.INTERSECTION, clockwise=True)


def halfplane(p, d, size=6000):
    """The half-plane to the LEFT of the directed line through p along d (a big polygon)"""
    d = unit(d)
    n = (-d[1], d[0])
    a = sub(p, mul(d, size))
    b = add(p, mul(d, size))
    return polygon([a, b, add(b, mul(n, size)), add(a, mul(n, size))])


def transform(path, fn):
    """Apply a point function to every point of a path (used for mirroring/rotating whole glyph parts)"""
    out = pathops.Path()
    pen = out.getPen()
    for verb, pts in path.segments:
        pts = [fn(p) for p in pts]
        if verb == 'moveTo':
            pen.moveTo(pts[0])
        elif verb == 'lineTo':
            pen.lineTo(pts[0])
        elif verb == 'curveTo':
            pen.curveTo(*pts)
        elif verb == 'qCurveTo':
            pen.qCurveTo(*pts)
        elif verb == 'closePath':
            pen.closePath()
        elif verb == 'endPath':
            pen.endPath()
    return pathops.simplify(out, clockwise=True)


def edge_x(path, y, side='max'):
    """The outline's leftmost ('min') or rightmost ('max') x at height y"""
    band = inter(path, rect(-5000, y - 0.5, 5000, y + 0.5))
    xs = [p[0] for _, pts in band.segments for p in pts]
    if not xs:
        return None
    return max(xs) if side == 'max' else min(xs)


def edge_y(path, x, side='max'):
    """The outline's lowest ('min') or highest ('max') y at abscissa x"""
    band = inter(path, rect(x - 0.5, -5000, x + 0.5, 5000))
    ys = [p[1] for _, pts in band.segments for p in pts]
    if not ys:
        return None
    return max(ys) if side == 'max' else min(ys)


def rotate180(path, cx, cy):
    return transform(path, lambda p: (2 * cx - p[0], 2 * cy - p[1]))


def mirror_x(path, cx):
    return transform(path, lambda p: (2 * cx - p[0], p[1]))


def shift(path, dx, dy):
    return transform(path, lambda p: (p[0] + dx, p[1] + dy))


# ---------------------------------------------------------------------------------------------------------------------
# ovals


def oval(cx, cy, rx, ry, k=0.5523, k2=None):
    """An oval through its four extremes; k is the handle ratio (0.5523 = circle, more = squarer). k2 (optional) gives
    a different ratio for the vertical-tangent ends of each quadrant, so the sides can be fuller than the top"""
    k2 = k if k2 is None else k2
    e, n, w, s = (cx + rx, cy), (cx, cy + ry), (cx - rx, cy), (cx, cy - ry)
    c = Contour(s)
    c.C((cx + rx * k, cy - ry), (cx + rx, cy - ry * k2), e)
    c.C((cx + rx, cy + ry * k2), (cx + rx * k, cy + ry), n)
    c.C((cx - rx * k, cy + ry), (cx - rx, cy + ry * k2), w)
    c.C((cx - rx, cy - ry * k2), (cx - rx * k, cy - ry), s)
    return c.path()


def ring(cx, cy, rx, ry, side, top, k_out=0.57, k_in=0.55, k2_out=None, k2_in=None, bottom=None):
    """An O: outer oval minus the counter; side = thickness at the vertical extremes, top/bottom at the horizontal"""
    bottom = top if bottom is None else bottom
    inner_cy = cy + (bottom - top) / 2
    outer = oval(cx, cy, rx, ry, k_out, k2_out)
    inner = oval(cx, inner_cy, rx - side, ry - (top + bottom) / 2, k_in, k2_in)
    return diff(outer, inner)


# ---------------------------------------------------------------------------------------------------------------------
# serifed stems, diagonals and wedge-ended bars


class Serif:
    """How a stroke end flares: e = reach beyond the stroke edge, t = thickness at the tip, h = height of the bracket
    up the stroke's edge, (a1, a2, a3) shape the bracket: a1/a2 how fast it leaves the tip (along / up), a3 how long it
    runs along the edge before it meets it"""

    def __init__(self, e, t, h, a1=0.42, a2=0.10, a3=0.42):
        self.e, self.t, self.h, self.a1, self.a2, self.a3 = e, t, h, a1, a2, a3

    def scaled(self, k=1.0, kh=None):
        return Serif(self.e * k, self.t, self.h * (k if kh is None else kh), self.a1, self.a2, self.a3)


def _bracket(tip, edge_pt, edge_dir_away, toward, s):
    """Cubic from the serif's tip (top of its end face) to the point where the bracket meets the stroke edge.
    edge_dir_away: unit vector along the edge pointing away from the serif (up the stem); toward: unit horizontal
    vector from the tip toward the stroke"""
    run = length(sub(edge_pt, tip))
    c1 = add(tip, add(mul(toward, s.e * s.a1), (0, (edge_pt[1] - tip[1]) * s.a2)))
    c2 = sub(edge_pt, mul(edge_dir_away, run * s.a3))
    return (tip, c1, c2, edge_pt)


def curved_serif(s, room, c=None):
    """The serif s at curvature c (default: CURV): its bracket climbs further up the stroke (up to 2.6 times, never
    more than a third of the stroke's length `room`), leaves the tip more steeply and runs into the stroke more
    gently, so the stroke flares over its last third instead of standing on a bracketed foot; the reach grows a little
    and the tip's end face shrinks. At c = 0, s itself."""
    c = CURV if c is None else c
    if not c:
        return s
    h = s.h + (min(s.h * 2.6, max(s.h, room * 0.33)) - s.h) * c
    return Serif(s.e * (1 + 0.15 * c), s.t * (1 - 0.45 * c), h,
                 s.a1 + (0.28 - s.a1) * c, s.a2 + (0.32 - s.a2) * c, s.a3 + (0.58 - s.a3) * c)


def stem(x0, x1, y0, y1, serif=None, bl=True, br=True, tl=True, tr=True, flare_l=0.0, flare_r=0.0, sb=None, st=None):
    """A vertical stem from x0 to x1 and y0 to y1 with bracketed flared serifs at the chosen corners and an optional
    waist (flare) on either side. sb/st override the serif at the bottom/top. With curvature (CURV > 0) the brackets
    lengthen into flared ends and the waist straightens out: the stem flares towards both ends, never pinches."""
    sb = sb or serif
    st = st or serif
    if CURV:
        room = y1 - y0
        sb = curved_serif(sb, room) if sb else sb
        st = curved_serif(st, room) if st else st
        flare_l *= 1 - CURV
        flare_r *= 1 - CURV
    ym = (y0 + y1) / 2
    c = Contour((x0 - (sb.e if bl else 0), y0))
    c.L((x1 + (sb.e if br else 0), y0))
    # right side, going up
    if br:
        tip = (x1 + sb.e, y0 + sb.t)
        c.L(tip)
        lo = (x1, y0 + sb.h)
        c.cubic(_bracket(tip, lo, (0, 1), (-1, 0), sb))
    else:
        lo = (x1, y0)
    hi = (x1, y1 - st.h) if tr else (x1, y1)
    if flare_r:
        mid = (x1 - flare_r, ym)
        c.C((lo[0], lo[1] + (ym - lo[1]) * 0.45), (mid[0], ym - (ym - lo[1]) * 0.45), mid)
        c.C((mid[0], ym + (hi[1] - ym) * 0.45), (hi[0], hi[1] - (hi[1] - ym) * 0.45), hi)
    else:
        c.L(hi)
    if tr:
        tip = (x1 + st.e, y1 - st.t)
        b = _bracket(tip, hi, (0, -1), (-1, 0), st)
        c.cubic((b[3], b[2], b[1], b[0]))
        c.L((x1 + st.e, y1))
    c.L((x0 - (st.e if tl else 0), y1))
    # left side, going down
    hi = (x0, y1 - st.h) if tl else (x0, y1)
    if tl:
        tip = (x0 - st.e, y1 - st.t)
        c.L(tip)
        c.cubic(_bracket(tip, hi, (0, -1), (1, 0), st))
    lo = (x0, y0 + sb.h) if bl else (x0, y0)
    if flare_l:
        mid = (x0 + flare_l, ym)
        c.C((hi[0], hi[1] - (hi[1] - ym) * 0.45), (mid[0], ym + (hi[1] - ym) * 0.45), mid)
        c.C((mid[0], ym - (ym - lo[1]) * 0.45), (lo[0], lo[1] + (ym - lo[1]) * 0.45), lo)
    else:
        c.L(lo)
    if bl:
        tip = (x0 - sb.e, y0 + sb.t)
        b = _bracket(tip, lo, (0, 1), (1, 0), sb)
        c.cubic((b[3], b[2], b[1], b[0]))
    return c.path()


def _sub_cubic(cub, s0, s1):
    """The piece of a cubic between parameters s0 and s1 (s1 < s0 gives it reversed)"""
    if s1 < s0:
        q = _sub_cubic(cub, s1, s0)
        return (q[3], q[2], q[1], q[0])
    if s1 < 1:
        cub = split(cub, s1)[0]
    if s0 > 0:
        cub = split(cub, s0 / s1)[1]
    return cub


def diag(b0, b1, t0, t1, serifs=None, bend=None):
    """A diagonal stroke between a bottom edge (x b0..b1 at y = b0[1]) and a top edge (t0..t1 at y = t0[1]).
    serifs: dict with any of 'bl', 'br', 'tl', 'tr' -> Serif (bracketed into the left/right edge at that end).
    bend = (d1, d2): both edges become cubics whose control points at a third and two thirds of the height move
    sideways by d1 and d2 (d1 = d2 bows the stroke, d1 = -d2 bends it into a gentle S); the stroke keeps its width.
    With curvature the serifs' brackets lengthen as in stem()."""
    serifs = serifs or {}
    y0, y1 = b0[1], t0[1]
    if CURV:
        serifs = {k: curved_serif(v, y1 - y0) for k, v in serifs.items()}
    if bend and (bend[0] or bend[1]):
        return _bent_diag(b0, b1, t0, t1, serifs, bend)
    left_dir = unit(sub(t0, b0))   # up the left edge
    right_dir = unit(sub(t1, b1))  # up the right edge

    def on_left(h):
        return lerp(b0, t0, h / (y1 - y0))

    def on_right(h):
        return lerp(b1, t1, h / (y1 - y0))

    s = serifs.get('bl')
    c = Contour((b0[0] - s.e, y0) if s else b0)
    s = serifs.get('br')
    c.L((b1[0] + s.e, y0) if s else b1)
    if s:
        tip = (b1[0] + s.e, y0 + s.t)
        c.L(tip)
        c.cubic(_bracket(tip, on_right(s.h), right_dir, (-1, 0), s))
    s = serifs.get('tr')
    if s:
        hi = on_right(y1 - y0 - s.h)
        c.L(hi)
        tip = (t1[0] + s.e, y1 - s.t)
        b = _bracket(tip, hi, mul(right_dir, -1), (-1, 0), s)
        c.cubic((b[3], b[2], b[1], b[0]))
        c.L((t1[0] + s.e, y1))
    else:
        c.L(t1)
    s = serifs.get('tl')
    c.L((t0[0] - s.e, y1) if s else t0)
    if s:
        tip = (t0[0] - s.e, y1 - s.t)
        c.L(tip)
        c.cubic(_bracket(tip, on_left(y1 - y0 - s.h), mul(left_dir, -1), (1, 0), s))
    s = serifs.get('bl')
    if s:
        lo = on_left(s.h)
        c.L(lo)
        tip = (b0[0] - s.e, y0 + s.t)
        b = _bracket(tip, lo, left_dir, (1, 0), s)
        c.cubic((b[3], b[2], b[1], b[0]))
    return c.path()


def _bent_diag(b0, b1, t0, t1, serifs, bend):
    """diag() with cubic edges (see there)"""
    y0, y1 = b0[1], t0[1]
    H = y1 - y0
    d1, d2 = bend

    def edge(p, q):
        dx = q[0] - p[0]
        return (p, (p[0] + dx / 3 + d1, p[1] + H / 3), (p[0] + 2 * dx / 3 + d2, p[1] + 2 * H / 3), q)

    le, re = edge(b0, t0), edge(b1, t1)

    def at(e, h):
        return bez(e, h / H)

    def up(e, h):
        return unit(bez_d(e, h / H))

    def run(c, e, h0, h1):
        """follow edge e from height h0 to h1 (the contour is at e(h0))"""
        c.cubic(_sub_cubic(e, h0 / H, h1 / H))

    sbl, sbr, stl, s_tr = (serifs.get(k) for k in ('bl', 'br', 'tl', 'tr'))
    c = Contour((b0[0] - sbl.e, y0) if sbl else b0)
    c.L((b1[0] + sbr.e, y0) if sbr else b1)
    h = 0.0
    if sbr:
        tip = (b1[0] + sbr.e, y0 + sbr.t)
        c.L(tip)
        c.cubic(_bracket(tip, at(re, sbr.h), up(re, sbr.h), (-1, 0), sbr))
        h = sbr.h
    h_top = H - s_tr.h if s_tr else H
    run(c, re, h, h_top)
    if s_tr:
        tip = (t1[0] + s_tr.e, y1 - s_tr.t)
        b = _bracket(tip, at(re, h_top), mul(up(re, h_top), -1), (-1, 0), s_tr)
        c.cubic((b[3], b[2], b[1], b[0]))
        c.L((t1[0] + s_tr.e, y1))
    c.L((t0[0] - stl.e, y1) if stl else t0)
    h = H
    if stl:
        tip = (t0[0] - stl.e, y1 - stl.t)
        c.L(tip)
        h = H - stl.h
        c.cubic(_bracket(tip, at(le, h), mul(up(le, h), -1), (1, 0), stl))
    h_bot = sbl.h if sbl else 0.0
    run(c, le, h, h_bot)
    if sbl:
        tip = (b0[0] - sbl.e, y0 + sbl.t)
        b = _bracket(tip, at(le, h_bot), up(le, h_bot), (1, 0), sbl)
        c.cubic((b[3], b[2], b[1], b[0]))
    return c.path()


def diag_through(pb, pt, thick, y0, y1):
    """Edges of a diagonal whose centreline runs from pb (bottom) to pt (top), with the given perpendicular thickness,
    cut by the horizontals y0 and y1. Returns (b0, b1, t0, t1) for diag()"""
    d = unit(sub(pt, pb))
    hw = thick / 2 / max(abs(d[1]), 1e-6)  # half the horizontal width
    def at(y):
        return lerp(pb, pt, (y - pb[1]) / (pt[1] - pb[1]))[0]
    xb, xt = at(y0), at(y1)
    return (xb - hw, y0), (xb + hw, y0), (xt - hw, y1), (xt + hw, y1)


def bar(x0, x1, y0, y1, left=None, right=None, bend=None):
    """A horizontal bar with optional wedge ends: left/right = (up, down, length): at that end the bar's top edge rises
    by `up` and its bottom edge drops by `down` over the last `length` units, cut square.
    With curvature (CURV > 0) each wedge's slanted edge curves into the bar like a bracket (it leaves the bar's edge
    tangentially and reaches the end steeply), over a slightly longer run. bend = (xr, dl, dr): the bar bends as a
    parabola from x = xr, its left end moving up by dl and its right end by dr (negative: down)."""
    if not CURV and not bend:
        c = Contour((x0, y0))
        if left:
            up, down, ln = left
            c = Contour((x0, y0 - down))
            c.L((x0 + ln, y0))
        if right:
            up, down, ln = right
            c.L((x1 - ln, y0))
            c.L((x1, y0 - down))
            c.L((x1, y1 + up))
            c.L((x1 - ln, y1))
        else:
            c.L((x1, y0))
            c.L((x1, y1))
        if left:
            up, down, ln = left
            c.L((x0 + ln, y1))
            c.L((x0, y1 + up))
        else:
            c.L((x0, y1))
        return c.path()
    return _curved_bar(x0, x1, y0, y1, left, right, bend)


def _wedge_edge(p, q, along, k):
    """The slanted edge of a wedge from p (on the bar's edge) to q (the end), as a cubic: straight at k = 0, at k = 1 a
    bracket that leaves p along the bar (direction `along`) and arrives at q vertically"""
    t1, t2 = lerp(p, q, 1 / 3), lerp(p, q, 2 / 3)
    run = abs(q[0] - p[0])
    f1 = add(p, mul(along, run * 0.62))
    f2 = (q[0], q[1] + (p[1] - q[1]) * 0.50)
    return (p, lerp(t1, f1, k), lerp(t2, f2, k), q)


def _curved_bar(x0, x1, y0, y1, left, right, bend):
    k = CURV
    grow = 1 + 0.20 * k

    def wedge(p, q, along, rev):
        """the wedge edge from p (on the bar's edge) to q (at the end), or from q to p if rev"""
        if k and abs(p[1] - q[1]) > 1e-6:
            cub = _wedge_edge(p, q, along, k)
            return ('C',) + (cub[::-1] if rev else cub)
        return ('L', q, p) if rev else ('L', p, q)

    # the outline as pieces in the bar's flat frame, ('L', p, q) or ('C', p, c1, c2, q), from the bottom left corner
    pieces = []
    if left:
        upl, downl, lnl = left
        lnl *= grow
        start = (x0, y0 - downl)
        pieces.append(wedge((x0 + lnl, y0), start, (-1, 0), True))
        a = (x0 + lnl, y0)
    else:
        start = a = (x0, y0)
    if right:
        upr, downr, lnr = right
        lnr *= grow
        pieces.append(('L', a, (x1 - lnr, y0)))
        pieces.append(wedge((x1 - lnr, y0), (x1, y0 - downr), (1, 0), False))
        pieces.append(('L', (x1, y0 - downr), (x1, y1 + upr)))
        pieces.append(wedge((x1 - lnr, y1), (x1, y1 + upr), (1, 0), True))
        b = (x1 - lnr, y1)
    else:
        pieces += [('L', a, (x1, y0)), ('L', (x1, y0), (x1, y1))]
        b = (x1, y1)
    if left:
        pieces.append(('L', b, (x0 + lnl, y1)))
        pieces.append(wedge((x0 + lnl, y1), (x0, y1 + upl), (-1, 0), False))
        pieces.append(('L', (x0, y1 + upl), start))
    else:
        pieces.append(('L', b, (x0, y1)))
        pieces.append(('L', (x0, y1), start))

    def disp(x):
        if not bend:
            return 0.0
        xr, dl, dr = bend
        if x >= xr:
            return dr * ((x - xr) / max(x1 - xr, 1e-6)) ** 2
        return dl * ((xr - x) / max(xr - x0, 1e-6)) ** 2

    def slope(x, toward):
        """the displacement's derivative at x, on the side of x where `toward` lies"""
        xr, dl, dr = bend
        if x > xr or (x == xr and toward > x):
            return 2 * dr * (x - xr) / max(x1 - xr, 1e-6) ** 2
        return -2 * dl * (xr - x) / max(xr - x0, 1e-6) ** 2

    def mv(p):
        return (p[0], p[1] + disp(p[0]))

    c = Contour(mv(start))
    for pc in pieces:
        if pc[0] == 'C':
            c.C(mv(pc[2]), mv(pc[3]), mv(pc[4]))
            continue
        p, q = pc[1], pc[2]
        if not bend or abs(q[0] - p[0]) < 1e-6:
            c.L(mv(q))
            continue
        xr = bend[0]
        cuts = [p, q]
        if (p[0] - xr) * (q[0] - xr) < 0:     # the parabola is in two pieces: split the edge at xr
            cuts = [p, lerp(p, q, (xr - p[0]) / (q[0] - p[0])), q]
        for a_, b_ in zip(cuts, cuts[1:]):
            # a straight edge under a parabolic displacement is exactly a quadratic Bezier
            pa, pb = mv(a_), mv(b_)
            ctrl = ((a_[0] + b_[0]) / 2, pa[1] + ((b_[1] - a_[1]) + slope(a_[0], b_[0]) * (b_[0] - a_[0])) / 2)
            c.C(lerp(pa, ctrl, 2 / 3), lerp(pb, ctrl, 2 / 3), pb)
    return c.path()


# ---------------------------------------------------------------------------------------------------------------------
# nib-expanded strokes


def _support(n, a, b):
    """The point of the ellipse x²/a² + y²/b² = 1 that lies furthest along the direction n"""
    d = math.sqrt((a * n[0]) ** 2 + (b * n[1]) ** 2)
    return ((a * a * n[0]) / d, (b * b * n[1]) / d) if d else (0.0, 0.0)


def _fit(pts, ts, t0, t1):
    """Least-squares cubic through pts with fixed ends and end tangent directions t0 (leaving) and t1 (arriving)"""
    p0, p3 = pts[0], pts[-1]
    # chord-length parameters, refined by a couple of Newton steps against the fitted curve
    d = [0.0]
    for a, b in zip(pts, pts[1:]):
        d.append(d[-1] + length(sub(b, a)))
    us = [x / d[-1] for x in d] if d[-1] else ts
    alpha = beta = d[-1] / 3
    for _ in range(4):
        c11 = c12 = c22 = x1 = x2 = 0.0
        for u, p in zip(us, pts):
            b1, b2 = 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u
            base = add(mul(p0, (1 - u) ** 3 + b1), mul(p3, b2 + u ** 3))
            r = sub(p, base)
            a1, a2 = mul(t0, b1), mul(t1, -b2)
            c11 += dot(a1, a1)
            c12 += dot(a1, a2)
            c22 += dot(a2, a2)
            x1 += dot(a1, r)
            x2 += dot(a2, r)
        det = c11 * c22 - c12 * c12
        if abs(det) > 1e-9:
            alpha = (x1 * c22 - x2 * c12) / det
            beta = (c11 * x2 - c12 * x1) / det
        chord = length(sub(p3, p0))
        alpha = min(max(alpha, chord * 0.02), chord * 1.6)
        beta = min(max(beta, chord * 0.02), chord * 1.6)
        cub = (p0, add(p0, mul(t0, alpha)), sub(p3, mul(t1, beta)), p3)
        # Newton reparameterisation
        nus = []
        for u, p in zip(us, pts):
            q = sub(bez(cub, u), p)
            d1 = bez_d(cub, u)
            # second derivative
            a0, a1_, a2_, a3 = cub
            u_ = 1 - u
            d2 = (6 * u_ * (a2_[0] - 2 * a1_[0] + a0[0]) + 6 * u * (a3[0] - 2 * a2_[0] + a1_[0]),
                  6 * u_ * (a2_[1] - 2 * a1_[1] + a0[1]) + 6 * u * (a3[1] - 2 * a2_[1] + a1_[1]))
            num = dot(q, d1)
            den = dot(d1, d1) + dot(q, d2)
            nus.append(min(max(u - num / den, 0.0), 1.0) if abs(den) > 1e-9 else u)
        nus[0], nus[-1] = 0.0, 1.0
        us = nus
    err = max(length(sub(bez(cub, u), p)) for u, p in zip(us, pts))
    return cub, err


def _scale_at(knots, u):
    if not knots:
        return 1.0
    if u <= knots[0][0]:
        return knots[0][1]
    for (ua, sa), (ub, sb) in zip(knots, knots[1:]):
        if u <= ub:
            if ub <= ua:
                return sb
            t = (u - ua) / (ub - ua)
            # smoothstep: the width changes without a break in its slope, so the outline has none either
            return sa + (sb - sa) * t * t * (3 - 2 * t)
    return knots[-1][1]


STROKE_ERRORS = []


def stroke(spine, a, b, knots=None, n=32, name=''):
    """Expand a spine (contiguous cubics) with an elliptical nib of semi-axes a (horizontal) and b (vertical): the
    stroke is a = half the width of a vertical stroke, b = half the thickness of a horizontal one. knots: optional
    [(u, scale)] over u in [0, len(spine)] to swell or taper the nib along the stroke. Flat ends."""
    left, right = [], []
    worst = 0.0
    for i, seg in enumerate(spine):
        if _is_straight(seg, 0.01) and _scale_at(knots, i) == _scale_at(knots, i + 1) and \
                all(_scale_at(knots, i + f) == _scale_at(knots, i) for f in (0.25, 0.5, 0.75)):
            d = unit(sub(seg[3], seg[0]))
            s = _scale_at(knots, i)
            off = _support((-d[1], d[0]), a * s, b * s)
            p0l, p3l = add(seg[0], off), add(seg[3], off)
            p0r, p3r = sub(seg[0], off), sub(seg[3], off)
            left.append(('L', p0l, p3l))
            right.append(('L', p0r, p3r))
            continue
        L, R, ts = [], [], []
        for j in range(n + 1):
            t = j / n
            p = bez(seg, t)
            d = bez_d(seg, t)
            if length(d) < 1e-9:
                d = bez_d(seg, min(max(t, 1e-3), 1 - 1e-3))
            d = unit(d)
            s = _scale_at(knots, i + t)
            off = _support((-d[1], d[0]), a * s, b * s)
            L.append(add(p, off))
            R.append(sub(p, off))
            ts.append(t)
        for side, out in ((L, left), (R, right)):
            eps = 1e-3
            # end tangents of the offset curve, numerically (they follow the spine's unless the nib swells)
            def off_at(t, sign):
                p = bez(seg, t)
                d = unit(bez_d(seg, t))
                o = _support((-d[1], d[0]), a * _scale_at(knots, i + t), b * _scale_at(knots, i + t))
                return add(p, mul(o, sign))
            sign = 1 if side is L else -1
            ta = unit(sub(off_at(eps, sign), off_at(0.0, sign)))
            tb = unit(sub(off_at(1.0, sign), off_at(1 - eps, sign)))
            cub, err = _fit(side, ts, ta, tb)
            worst = max(worst, err)
            out.append(cub)
    if worst > 1.5:
        STROKE_ERRORS.append((name, round(worst, 2)))
    def first(piece):
        return piece[1] if piece[0] == 'L' else piece[0]

    def last(piece):
        return piece[2] if piece[0] == 'L' else piece[3]

    c = Contour(first(left[0]))
    for piece in left:
        if piece[0] == 'L':
            c.L(piece[1])
            c.L(piece[2])
        else:
            c.L(piece[0])
            c.cubic(piece)
    c.L(last(right[-1]))
    for piece in reversed(right):
        if piece[0] == 'L':
            c.L(piece[2])
            c.L(piece[1])
        else:
            c.L(piece[3])
            c.cubic((piece[3], piece[2], piece[1], piece[0]))
    return c.path()


# ---------------------------------------------------------------------------------------------------------------------
# skia path → plain contours, and making several masters' outlines compatible


def contours_of(path):
    """[[('L', p) | ('C', c1, c2, p), ...] with the start point as contour[0] = ('M', p)]"""
    out, cur = [], None
    for verb, pts in path.segments:
        if verb == 'moveTo':
            cur = [('M', tuple(pts[0]))]
        elif verb == 'lineTo':
            cur.append(('L', tuple(pts[0])))
        elif verb == 'curveTo':
            cur.append(('C', tuple(pts[0]), tuple(pts[1]), tuple(pts[2])))
        elif verb == 'qCurveTo':
            # degree-elevate quadratic pieces (pathops should not emit these for cubic input)
            start = cur[-1][-1]
            offs, end = pts[:-1], pts[-1]
            ons = [start] + [lerp(offs[i], offs[i + 1], 0.5) for i in range(len(offs) - 1)] + [end]
            for i, q in enumerate(offs):
                a, b = ons[i], ons[i + 1]
                cur.append(('C', lerp(a, q, 2 / 3), lerp(b, q, 2 / 3), b))
        elif verb in ('closePath', 'endPath'):
            if cur and len(cur) > 1:
                start = cur[0][1]
                if length(sub(cur[-1][-1], start)) > 1e-6:
                    cur.append(('L', start))
                out.append(cur)
            cur = None
    # drop degenerate segments (zero length)
    clean = []
    for c in out:
        segs = [c[0]]
        for s in c[1:]:
            prev = segs[-1][-1]
            if s[0] == 'L' and length(sub(s[1], prev)) < 1e-3:
                continue
            if s[0] == 'C' and max(length(sub(q, prev)) for q in s[1:]) < 1e-3:
                continue
            segs.append(s)
        if len(segs) > 2:
            clean.append(segs)
    return clean


def seg_list(contour):
    """contour → list of (type, pts) where pts include the segment's start: ('L', (p0, p1)) / ('C', (p0, p1, p2, p3)).
    The closing segment returns to the start, so the contour is the cycle of these segments."""
    out = []
    prev = contour[0][1]
    for s in contour[1:]:
        if s[0] == 'L':
            out.append(('L', (prev, s[1])))
            prev = s[1]
        else:
            out.append(('C', (prev, s[1], s[2], s[3])))
            prev = s[3]
    if length(sub(prev, contour[0][1])) > 1e-6:
        out.append(('L', (prev, contour[0][1])))
    return out


def signed_area(segs):
    a = 0.0
    for t, pts in segs:
        if t == 'L':
            (x0, y0), (x1, y1) = pts
            a += x0 * y1 - x1 * y0
        else:
            for k in range(8):
                p, q = bez(pts, k / 8), bez(pts, (k + 1) / 8)
                a += p[0] * q[1] - q[0] * p[1]
    return a / 2


def _centroid(segs):
    pts = [pts[0] for _, pts in segs]
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def _is_straight(c, tol=0.35):
    p0, p1, p2, p3 = c
    d = sub(p3, p0)
    n = length(d)
    if n < 1e-6:
        return False
    u = mul(d, 1 / n)
    for q in (p1, p2):
        v = sub(q, p0)
        if abs(v[0] * u[1] - v[1] * u[0]) > tol:
            return False
        s = dot(v, u)
        if s < -tol or s > n + tol:
            return False
    return True


def _extrema_ts(c):
    """Parameters in (0.02, 0.98) where a cubic has a horizontal or vertical tangent, per axis"""
    out = {}
    for axis in (0, 1):
        p0, p1, p2, p3 = (c[0][axis], c[1][axis], c[2][axis], c[3][axis])
        a = -p0 + 3 * p1 - 3 * p2 + p3
        b = 2 * (p0 - 2 * p1 + p2)
        cc = p1 - p0
        roots = []
        if abs(a) < 1e-9:
            if abs(b) > 1e-9:
                roots = [-cc / b]
        else:
            disc = b * b - 4 * a * cc
            if disc >= 0:
                r = math.sqrt(disc)
                roots = [(-b + r) / (2 * a), (-b - r) / (2 * a)]
        roots = sorted(t for t in roots if 0.02 < t < 0.98)
        # only meaningful extrema: the curve must actually bulge beyond its ends by more than half a unit
        keep = []
        for t in roots:
            v = bez(c, t)[axis]
            if v > max(p0, p3) + 0.5 or v < min(p0, p3) - 0.5:
                keep.append(t)
        out[axis] = keep
    return out



def _seg_split(t, pts, fracs):
    """Split a segment at the given fractions of its parameter (ascending, in (0, 1))"""
    out = []
    if t == 'L':
        p0, p1 = pts
        prev = p0
        for f in fracs:
            q = lerp(p0, p1, f)
            out.append(('L', (prev, q)))
            prev = q
        out.append(('L', (prev, p1)))
        return out
    rest, done = pts, 0.0
    for f in fracs:
        a, rest = split(rest, (f - done) / (1 - done))
        out.append(('C', a))
        done = f
    out.append(('C', rest))
    return out


def _seg_length(t, pts):
    if t == 'L':
        return length(sub(pts[1], pts[0]))
    return sum(length(sub(bez(pts, (k + 1) / 12), bez(pts, k / 12))) for k in range(12))


def _as_cubic(seg):
    t, pts = seg
    return seg if t == 'C' else ('C', line_cubic(pts[0], pts[1]))


def _align_pair(a, b, na, nb):
    """Align two cyclic segment lists from two masters. Every segment of the shorter list maps to a run of one or more
    consecutive segments of the longer one (dynamic programming over all start rotations, cost = distance of the
    normalised run ends); the shorter list's segments are split to match, and where the two masters disagree on a
    segment's type the straight one becomes a (straight) cubic. Returns the two lists, now structurally identical, and
    the operations done to `a` (see _apply_ops), so that lists already aligned with `a` can follow it."""
    swap = len(a) > len(b)
    if swap:
        a, b, na, nb = b, a, nb, na
    n, m = len(a), len(b)
    A0 = [na(s[1][0]) for s in a]
    A1 = [na(s[1][-1]) for s in a]
    INF = float('inf')
    best = (INF, None, None)
    for r in range(m):
        bb = b[r:] + b[:r]
        B0 = [nb(s[1][0]) for s in bb]
        B1 = [nb(s[1][-1]) for s in bb]
        dp = [[INF] * (m + 1) for _ in range(n + 1)]
        back = [[0] * (m + 1) for _ in range(n + 1)]
        dp[0][0] = 0.0
        for i in range(1, n + 1):
            for j in range(i, m - (n - i) + 1):
                for k in range(i - 1, j):
                    if dp[i - 1][k] == INF:
                        continue
                    cost = dp[i - 1][k] + length(sub(A0[i - 1], B0[k])) + length(sub(A1[i - 1], B1[j - 1]))
                    if a[i - 1][0] != bb[k][0] or j - k > 1:
                        cost += 0.002 * (j - k)
                    if cost < dp[i][j]:
                        dp[i][j] = cost
                        back[i][j] = k
        if dp[n][m] < best[0]:
            best = (dp[n][m], r, back)
    _, r, back = best
    if r is None:
        raise CompatError('alignment failed')
    bb = b[r:] + b[:r]
    runs = []
    j = m
    for i in range(n, 0, -1):
        k = back[i][j]
        runs.append((k, j))
        j = k
    runs.reverse()
    a_out, b_out, splits, conv = [], [], [], []
    for (k, j), seg in zip(runs, a):
        run = bb[k:j]
        fr = []
        if len(run) == 1:
            pieces = [seg]
        else:
            ls = [_seg_length(*s) for s in run]
            tot = sum(ls) or 1.0
            acc = 0.0
            for l_ in ls[:-1]:
                acc += l_
                fr.append(acc / tot)
            pieces = _seg_split(seg[0], seg[1], fr)
        splits.append(fr)
        for p, q in zip(pieces, run):
            differ = p[0] != q[0]
            if differ:
                p, q = _as_cubic(p), _as_cubic(q)
            a_out.append(p)
            b_out.append(q)
            conv.append(differ)
    if swap:   # the caller's `a` was the longer list: it was rotated
        return b_out, a_out, ('rot', r, conv)
    return a_out, b_out, ('split', splits, conv)


def _apply_ops(segs, ops):
    """Do to a segment list what _align_pair did to its reference (the list must match the reference's structure)"""
    kind, x, conv = ops
    if kind == 'rot':
        segs = segs[x:] + segs[:x]
    else:
        out = []
        for seg, fr in zip(segs, x):
            out += _seg_split(seg[0], seg[1], fr) if fr else [seg]
        segs = out
    return [_as_cubic(sg) if c else sg for sg, c in zip(segs, conv)]


class CompatError(Exception):
    pass


def make_compatible(name, master_paths, max_err=0.6):
    """Take one glyph's outline (a skia Path) per master and return per master a list of TrueType contours
    [(on_curve: bool, (x, y)), ...] with identical structure, integer coordinates, clockwise outer contours.
    Contours are matched by position, start points aligned, straight cubics turned into lines and collinear
    lines merged where that holds in every master, curves split at their extremes, then converted to quadratics
    with cu2qu so that every master gets the same number of points."""
    master_paths = [pathops.simplify(p, clockwise=True) for p in master_paths]
    raw = [[seg_list(c) for c in contours_of(p)] for p in master_paths]
    # boolean slivers: contours of (almost) no area
    raw = [[_merge_collinear(c) for c in m if abs(signed_area(c)) > 40] for m in raw]
    err = None
    for tiny in (2.5, 0.0):
        masters = [[_drop_tiny(c, tiny) for c in m] for m in raw] if tiny else raw
        try:
            return _compatible(name, masters, max_err)
        except CompatError as e:
            err = err or e
    raise err


def _merge_collinear(segs, tol=0.004):
    """Within one master: consecutive straight segments that run on in the same direction become one"""
    segs = list(segs)
    changed = True
    while changed and len(segs) > 3:
        changed = False
        for i in range(len(segs)):
            j = (i + 1) % len(segs)
            (ta, a), (tb, b) = segs[i], segs[j]
            if ta != 'L' or tb != 'L':
                continue
            d1, d2 = sub(a[1], a[0]), sub(b[1], b[0])
            l1, l2 = length(d1), length(d2)
            if l1 < 1e-6 or l2 < 1e-6:
                continue
            if abs(d1[0] * d2[1] - d1[1] * d2[0]) / (l1 * l2) < tol and dot(d1, d2) > 0:
                segs[i] = ('L', (a[0], b[1]))
                del segs[j]
                if j == 0:
                    segs.insert(0, segs.pop())
                changed = True
                break
    return segs


def _drop_tiny(segs, tol):
    """Fold segments shorter than tol into their successor (boolean ops leave such stubs where strokes meet)"""
    segs = list(segs)
    changed = True
    while changed and len(segs) > 3:
        changed = False
        for i, (t, pts) in enumerate(segs):
            if length(sub(pts[-1], pts[0])) < tol and (t == 'L' or max(length(sub(q, pts[0])) for q in pts) < tol * 1.5):
                j = (i + 1) % len(segs)
                nt, npts = segs[j]
                segs[j] = (nt, (pts[0],) + tuple(npts[1:]))
                del segs[i]
                changed = True
                break
    return segs


def _compatible(name, masters, max_err):
    n = len(masters[0])
    for k, m in enumerate(masters):
        if len(m) != n:
            raise CompatError(f'{name}: master {k} has {len(m)} contours, master 0 has {n}')
    # bbox for normalisation
    def bbox(ms):
        xs = [p[0] for c in ms for _, pts in c for p in pts]
        ys = [p[1] for c in ms for _, pts in c for p in pts]
        return min(xs), min(ys), max(xs), max(ys)

    boxes = [bbox(m) for m in masters]

    def norm(k, p):
        x0, y0, x1, y1 = boxes[k]
        return ((p[0] - x0) / max(x1 - x0, 1), (p[1] - y0) / max(y1 - y0, 1))

    ref = masters[0]
    # order reference contours: by bbox (xmin, ymin)
    def cbox(c):
        xs = [p[0] for _, pts in c for p in pts]
        ys = [p[1] for _, pts in c for p in pts]
        return (round(min(xs)), round(min(ys)))

    order = sorted(range(n), key=lambda i: cbox(ref[i]))
    ref = [ref[i] for i in order]
    # every other master is aligned with the reference in turn; when that splits or rotates the reference, the masters
    # aligned before follow it, so all of them stay structurally identical
    per_contour = [[c] for c in ref]
    for k in range(1, len(masters)):
        pool = list(masters[k])
        for ci, c in enumerate(ref):
            cc = norm(0, _centroid(c))
            best = min(pool, key=lambda d, k=k: length(sub(norm(k, _centroid(d)), cc)))
            pool.remove(best)
            a2, b2, ops = _align_pair(per_contour[ci][0], best, lambda p: norm(0, p), lambda p, k=k: norm(k, p))
            per_contour[ci] = [a2] + [_apply_ops(x, ops) for x in per_contour[ci][1:]] + [b2]
    aligned = [[per_contour[ci][k] for ci in range(n)] for k in range(len(masters))]

    # start every contour at its lowest-then-leftmost on-curve point (same index in every master)
    for ci in range(n):
        segs = aligned[0][ci]
        idx = min(range(len(segs)), key=lambda i: (round(segs[i][1][0][1], 3), round(segs[i][1][0][0], 3)))
        for m in aligned:
            m[ci] = m[ci][idx:] + m[ci][:idx]

    # straight cubics → lines (only where straight in every master)
    for ci in range(n):
        for si in range(len(aligned[0][ci])):
            segs = [m[ci][si] for m in aligned]
            if all(t == 'C' for t, _ in segs) and all(_is_straight(pts) for _, pts in segs):
                for m in aligned:
                    pts = m[ci][si][1]
                    m[ci][si] = ('L', (pts[0], pts[3]))

    # merge collinear consecutive lines and drop tiny segments (when true in every master)
    def collinear(a, b):
        (p0, p1), (_, p2) = a, b
        d1, d2 = sub(p1, p0), sub(p2, p1)
        if length(d1) < 1e-6 or length(d2) < 1e-6:
            return True
        cross = abs(d1[0] * d2[1] - d1[1] * d2[0]) / (length(d1) * length(d2))
        return cross < 0.002 and dot(d1, d2) > 0

    changed = True
    while changed:
        changed = False
        for ci in range(n):
            segs0 = aligned[0][ci]
            m_ = len(segs0)
            if m_ <= 3:
                continue
            for si in range(m_):
                nj = (si + 1) % m_
                pairs = [(m[ci][si], m[ci][nj]) for m in aligned]
                if all(a[0] == 'L' and b[0] == 'L' and collinear(a[1], b[1]) for a, b in pairs):
                    for m in aligned:
                        a, b = m[ci][si], m[ci][nj]
                        m[ci][si] = ('L', (a[1][0], b[1][1]))
                        del m[ci][nj]
                        if nj == 0:  # keep the start point at index 0
                            m[ci].insert(0, m[ci].pop())
                    changed = True
                    break
            if changed:
                break
        if changed:
            continue
        # tiny segments (shorter than 1 unit in every master): fold into the neighbour
        for ci in range(n):
            m_ = len(aligned[0][ci])
            if m_ <= 3:
                continue
            for si in range(m_):
                segs = [m[ci][si] for m in aligned]
                if all(length(sub(pts[-1], pts[0])) < 1.0 for _, pts in segs):
                    for m in aligned:
                        t, pts = m[ci][si]
                        nj = (si + 1) % len(m[ci])
                        nt, npts = m[ci][nj]
                        m[ci][nj] = (nt, (pts[0],) + tuple(npts[1:]))
                        del m[ci][si]
                    changed = True
                    break
            if changed:
                break

    # split cubics at extremes found in every master on the same axis
    for ci in range(n):
        si = 0
        while si < len(aligned[0][ci]):
            segs = [m[ci][si] for m in aligned]
            if all(t == 'C' for t, _ in segs):
                exts = [_extrema_ts(pts) for _, pts in segs]
                for axis in (0, 1):
                    if all(len(e[axis]) == 1 for e in exts):
                        for m, e in zip(aligned, exts):
                            a, b = split(m[ci][si][1], e[axis][0])
                            m[ci][si:si + 1] = [('C', a), ('C', b)]
                        break
                else:
                    si += 1
                    continue
                continue  # re-examine the first half
            si += 1

    # cubics → quadratics, compatibly across masters
    out = [[] for _ in aligned]
    smooth_all = []
    for ci in range(n):
        tt = [[] for _ in aligned]
        for si in range(len(aligned[0][ci])):
            segs = [m[ci][si] for m in aligned]
            if segs[0][0] == 'L':
                for k, (_, pts) in enumerate(segs):
                    tt[k].append((True, pts[0]))
            else:
                quads = curves_to_quadratic([pts for _, pts in segs], [max_err] * len(segs))
                for k, q in enumerate(quads):
                    tt[k].append((True, q[0]))
                    for p in q[1:-1]:
                        tt[k].append((False, p))
        smooth = _smooth_points(tt)
        for k in range(len(aligned)):
            out[k].append(tt[k])
        smooth_all.append(smooth)
    return Outline(out, smooth_all)


class Outline:
    """One glyph's compatible outlines: per master, contours of exact (float) TrueType points [(on, (x, y))], and per
    contour the indices of its smooth on-curve points. at(scalars) interpolates the masters with the given weights (one
    per master, from the designspace's variation model) and rounds to integers keeping smooth points smooth."""

    def __init__(self, masters, smooth):
        self.masters, self.smooth = masters, smooth

    def exact(self, scalars):
        """The first master plus the weighted differences of the others (scalars sum to 1): on one axis this is
        exactly p0 + t (p1 - p0), so the straight cut rounds as it always has"""
        out = []
        for cs in zip(*self.masters):
            pts = []
            for ps in zip(*cs):
                x0, y0 = ps[0][1]
                x = x0 + sum(w * (p[1][0] - x0) for w, p in zip(scalars[1:], ps[1:]) if w)
                y = y0 + sum(w * (p[1][1] - y0) for w, p in zip(scalars[1:], ps[1:]) if w)
                pts.append((ps[0][0], (x, y)))
            out.append(pts)
        return out

    def at(self, scalars):
        out = []
        for c, smooth in zip(self.exact(scalars), self.smooth):
            pts = [(on, (int(round(p[0])), int(round(p[1])))) for on, p in c]
            out.append(_keep_smooth(c, pts, smooth))
        return out


def _smooth_points(tt):
    """Indices of on-curve points that are smooth (tangent continuous within 2°) in every master"""
    n = len(tt[0])
    keep = []
    for i in range(n):
        if not tt[0][i][0]:
            continue
        ok = True
        for pts in tt:
            p, a, b = pts[i][1], pts[i - 1][1], pts[(i + 1) % n][1]
            if pts[i - 1][0] and pts[(i + 1) % n][0]:
                ok = False  # a corner between two lines is never "smooth"
                break
            d1, d2 = sub(p, a), sub(b, p)
            if length(d1) < 1e-6 or length(d2) < 1e-6:
                ok = False
                break
            cross = (d1[0] * d2[1] - d1[1] * d2[0]) / (length(d1) * length(d2))
            if abs(cross) > 0.035 or dot(d1, d2) <= 0:
                ok = False
                break
        if ok:
            keep.append(i)
    return keep


def _keep_smooth(exact, pts, smooth):
    """After rounding to integers, put the off-curve neighbours of each smooth point back on its tangent line. An
    off-curve point between two smooth points goes to the crossing of both tangents; then the integer grid around the
    ideal position is searched for the least angular error, so rounding leaves no visible kinks"""
    pts = list(pts)
    n = len(pts)
    cons = {}
    for i in smooth:
        p = pts[i][1]
        ia, ib = (i - 1) % n, (i + 1) % n
        if pts[ia][0]:
            d = unit(sub(p, pts[ia][1]))
        elif pts[ib][0]:
            d = unit(sub(pts[ib][1], p))
        else:
            d = unit(sub(exact[ib][1], exact[ia][1]))
        if not pts[ia][0]:
            cons.setdefault(ia, []).append((p, d, -1))
        if not pts[ib][0]:
            cons.setdefault(ib, []).append((p, d, 1))
    for j, cs in cons.items():
        e = exact[j][1]
        ideal = e
        if len(cs) == 1:
            q, d, _ = cs[0]
            ideal = add(q, mul(d, dot(sub(e, q), d)))
        else:
            (q1, d1, _), (q2, d2, _) = cs[:2]
            den = d1[0] * d2[1] - d1[1] * d2[0]
            if abs(den) > 1e-6:
                t = ((q2[0] - q1[0]) * d2[1] - (q2[1] - q1[1]) * d2[0]) / den
                x = add(q1, mul(d1, t))
                if length(sub(x, e)) < 6:
                    ideal = x
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                c = (int(round(ideal[0])) + dx, int(round(ideal[1])) + dy)
                err = 0.0
                ok = True
                for q, d, sign in cs:
                    v = sub(c, q)
                    lv = length(v)
                    if lv < 1e-6 or sign * dot(v, d) <= 0:
                        ok = False
                        break
                    err += abs((v[0] * d[1] - v[1] * d[0]) / lv)
                if not ok:
                    continue
                err += 0.002 * length(sub(c, e))
                if best is None or err < best[0]:
                    best = (err, c)
        if best:
            pts[j] = (False, best[1])
    return pts
