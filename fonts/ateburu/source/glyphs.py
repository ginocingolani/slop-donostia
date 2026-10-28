"""Ateburu's letters, drawn in code. Each function takes a master (HUD or Black) and returns the glyph's outline in
"body" coordinates (x = 0 at the left edge of its main strokes, serifs may reach past it), its body width and how its
sides space (see build.py). The identity sits in a handful of default glyphs; everything else stays calm and Roman.

Sources for every identity form are listed in ../SOURCES.md (Louis Colas, La tombe basque, 1923, and photographs of
dated lintels); nothing here is traced from any font or image: the shapes are numbers chosen by eye and judgment.
"""
import math

from geometry import (Contour, Serif, add, bar, curved_serif, diag, diag_through, diff, edge_x, edge_y, hobby, inter,
                      length, line_cubic, mirror_x, mul, oval, polygon, rect, ring, rotate180, shift, stem, stroke, sub,
                      union, unit)

CAP = 720
OVERSHOOT = 13
ACCENT_GAP = 54  # between the cap line and the bottom of a capital accent


class Master:
    """The design parameters of one master. t = 0 is HUD (wght 600), t = 1 is Black (wght 900); c = 0 is the straight
    cut (CURV 0), c = 1 the curved one (CURV 100). Weight-dependent numbers come from v(); the curvature reaches the
    drawing through geometry.curvature() (stems, diagonals, wedge ends) and through m.c in the glyphs that bend."""

    def __init__(self, name, t, wght, c=0.0):
        self.name, self.t, self.wght, self.c = name, t, wght, c
        self.curv = round(c * 100)
        v = self.v
        self.C = CAP
        self.o = OVERSHOOT
        self.op = 6                    # overshoot of pointed vertices
        self.stem = v(120, 184)        # vertical stems
        self.hair = v(100, 148)        # horizontal strokes
        self.rside = v(130, 198)       # round letters at their sides
        self.rtop = v(96, 140)         # round letters at top and bottom
        self.thick = v(120, 182)       # thick diagonals (perpendicular)
        self.thin = v(100, 146)        # thin diagonals
        self.serif = Serif(e=v(32, 36), t=v(14, 18), h=v(84, 98))
        self.flare = v(5, 6)           # the waist of a free stem side
        self.wdrop = v(44, 52)         # how far a wedge arm-end grows past the arm
        self.wlen = v(86, 104)         # over what length
        self.trap = v(15, 4)           # ink-trap depth (HUD: real traps; Black: vestigial, keeps the masters compatible)
        self.sp = v(66, 48)            # side bearing of a serifed stem (measured from the stem, not the serif tip)

    def v(self, a, b):
        return a + (b - a) * self.t


class G:
    """A drawn glyph: outline (skia path), body width w, left/right side bearings (None = auto-spaced), and the x of
    its anchors: top (accents), bottom (cedilla, comma below), ogonek (the hook at the lower right), caron (Ľ's
    apostrophe caron beside the stem)"""

    def __init__(self, path, w, lsb=None, rsb=None, top=None, bottom=None, adv=None, ogonek=None, caron=None,
                 top_y=None):
        self.path, self.w, self.lsb, self.rsb = path, w, lsb, rsb
        self.top_y = top_y   # the top anchor's height, if not the cap line (the short dotted i)
        self.top = w / 2 if top is None else top
        self.bottom = w / 2 if bottom is None else bottom
        self.ogonek = w * 0.78 if ogonek is None else ogonek
        self.caron = w * 0.6 if caron is None else caron
        self.adv = adv  # fixed advance (dashes, space)


GLYPHS = {}   # name -> (unicodes, function)


def glyph(name, *unicodes):
    def deco(fn):
        GLYPHS[name] = (list(unicodes), fn)
        return fn
    return deco


# ---------------------------------------------------------------------------------------------------------------------
# shared parts


def ink_trap(corner, d1, d2, depth, mouth=0.5):
    """A notch cut into the ink at an acute junction: corner is the counter's corner, d1/d2 unit vectors along the two
    edges away from the corner. The notch opens over `mouth` × depth along each edge and reaches `depth` into the
    joint, against the bisector. The cutter pokes a little into the counter so it never shares an edge with the
    outline (booleans stay robust)."""
    bis = unit(add(d1, d2))
    n1 = unit(sub(bis, mul(d1, bis[0] * d1[0] + bis[1] * d1[1])))
    n2 = unit(sub(bis, mul(d2, bis[0] * d2[0] + bis[1] * d2[1])))
    a = add(add(corner, mul(d1, depth * mouth)), mul(n1, 3))
    b = add(add(corner, mul(d2, depth * mouth)), mul(n2, 3))
    c = sub(corner, mul(bis, depth))
    return polygon([a, c, b, add(corner, mul(bis, 4))])


def line_x_at(p, q, y):
    return p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1])


def intersect_lines(p1, d1, p2, d2):
    """Point where the line p1 + s d1 meets p2 + t d2"""
    den = d1[0] * d2[1] - d1[1] * d2[0]
    s = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
    return add(p1, mul(d1, s))


def lozenge(cx, cy, dx, dy):
    return polygon([(cx, cy - dy), (cx + dx, cy), (cx, cy + dy), (cx - dx, cy)])


def dot_size(m):
    return m.v(66, 84), m.v(76, 96)


def bow(m, mid):
    """diag() bend for a stroke whose middle moves sideways by `mid` units at CURV 100 (nothing at CURV 0)"""
    d = mid / 0.75 * m.c
    return (d, d)


def s_bend(m, amp):
    """diag() bend for a gentle S: the stroke's thirds move by -/+ about amp units at CURV 100"""
    d = amp / 0.288 * m.c
    return (-d, d)


def arm(m, root, amount):
    """bar() bend: the arm's free end moves by `amount` units at CURV 100 (positive up), growing from x = root"""
    return (root, 0.0, amount * m.c) if m.c else None


def bowl(m, x0, y0, y1, xr, side=None, top=None, k=0.60, kin=0.58):
    """A D-shaped bowl attached to a stem whose right edge is x0: outer from y0 to y1 reaching xr, minus its counter.
    Returns (outer, counter)."""
    side = side or m.rside
    top = top or m.hair
    h = y1 - y0
    ym = (y0 + y1) / 2
    # the flat part of the bowl's bars before they curve: proportional to the bowl's width
    flat = max((xr - x0) - h / 2 * 1.02, (xr - x0) * 0.30)
    xa = x0 + flat
    rx = xr - xa
    outer = Contour((x0 - m.stem / 2, y0))
    outer.L((xa, y0))
    outer.C((xa + rx * k, y0), (xr, ym - h / 2 * k), (xr, ym))
    outer.C((xr, ym + h / 2 * k), (xa + rx * k, y1), (xa, y1))
    outer.L((x0 - m.stem / 2, y1))
    iy0, iy1 = y0 + top, y1 - top
    ih = iy1 - iy0
    ixr = xr - side
    ixa = min(xa, ixr - ih / 2 * 0.9)
    irx = ixr - ixa
    inner = Contour((x0, iy0))
    inner.L((ixa, iy0))
    inner.C((ixa + irx * kin, iy0), (ixr, ym - ih / 2 * kin), (ixr, ym))
    inner.C((ixr, ym + ih / 2 * kin), (ixa + irx * kin, iy1), (ixa, iy1))
    inner.L((x0, iy1))
    return outer.path(), inner.path()


# ---------------------------------------------------------------------------------------------------------------------
# straight letters


@glyph('H', 0x48, 0x68)
def H(m):
    s, C = m.stem, m.C
    W = m.v(574, 650)
    yc = m.v(370, 368)
    return G(union([
        stem(0, s, 0, C, m.serif, flare_l=m.flare, flare_r=m.flare),
        stem(W - s, W, 0, C, m.serif, flare_l=m.flare, flare_r=m.flare),
        rect(s / 2, yc - m.hair / 2, W - s / 2, yc + m.hair / 2),
    ]), W, m.sp, m.sp)


@glyph('I', 0x49)
def I(m):
    s = m.stem
    return G(stem(0, s, 0, m.C, m.serif, flare_l=m.flare, flare_r=m.flare), s, m.sp, m.sp, ogonek=s * 0.66)


@glyph('E', 0x45, 0x65)
def E(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(452, 512)
    ym = m.v(372, 370)
    hm = h * 0.94
    return G(union([
        stem(0, s, 0, C, m.serif, br=False, tr=False, flare_l=m.flare),
        bar(s / 2, W, C - h, C, right=(0, m.wdrop, m.wlen), bend=arm(m, s / 2, -m.v(10, 12))),
        bar(s / 2, W * 0.86, ym - hm / 2, ym + hm / 2, right=(m.wdrop * 0.55, m.wdrop * 0.55, m.wlen * 0.8),
            bend=arm(m, s / 2, m.v(4, 5))),
        bar(s / 2, W + m.v(8, 10), 0, h, right=(m.wdrop, 0, m.wlen), bend=arm(m, s / 2, m.v(10, 12))),
    ]), W, m.sp, None, top=W * 0.48, ogonek=W * 0.82)


@glyph('F', 0x46, 0x66)
def F(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(436, 494)
    ym = m.v(352, 350)
    hm = h * 0.94
    return G(union([
        stem(0, s, 0, C, m.serif, tr=False, flare_l=m.flare, flare_r=m.flare),
        bar(s / 2, W, C - h, C, right=(0, m.wdrop, m.wlen), bend=arm(m, s / 2, -m.v(10, 12))),
        bar(s / 2, W * 0.86, ym - hm / 2, ym + hm / 2, right=(m.wdrop * 0.55, m.wdrop * 0.55, m.wlen * 0.8),
            bend=arm(m, s / 2, m.v(4, 5))),
    ]), W, m.sp, None)


@glyph('L', 0x4C, 0x6C)
def L(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(446, 506)
    return G(union([
        stem(0, s, 0, C, m.serif, br=False, flare_l=m.flare, flare_r=m.flare),
        bar(s / 2, W, 0, h, right=(m.wdrop, 0, m.wlen), bend=arm(m, s / 2, m.v(10, 12))),
    ]), W, m.sp, None, top=s / 2, caron=s + m.v(62, 58))


@glyph('T', 0x54, 0x74)
def T(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(588, 648)
    x0 = W / 2 - s / 2
    return G(union([
        stem(x0, x0 + s, 0, C, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare),
        bar(0, W, C - h, C, left=(0, m.wdrop, m.wlen), right=(0, m.wdrop, m.wlen),
            bend=(W / 2, -m.v(12, 14) * m.c, -m.v(12, 14) * m.c) if m.c else None),
    ]), W, None, None)


@glyph('Z', 0x5A, 0x7A)
def Z(m):
    C, h = m.C, m.hair
    W = m.v(548, 608)
    hw = m.thick / math.sin(math.atan2(C - 2 * h, W - m.v(150, 200)))
    return G(union([
        bar(m.v(14, 16), W - m.v(10, 12), C - h, C, left=(0, m.wdrop, m.wlen),
            bend=(W - m.v(10, 12), -m.v(8, 10) * m.c, 0.0) if m.c else None),
        bar(0, W + m.v(6, 8), 0, h, right=(m.wdrop, 0, m.wlen), bend=arm(m, 0, m.v(8, 10))),
        polygon([(0, 0), (hw, 0), (W - m.v(10, 12), C), (W - m.v(10, 12) - hw, C)]),
    ]), W, None, None)


# ---------------------------------------------------------------------------------------------------------------------
# rounds


def o_ring(m, W, side=None, top=None, k_out=0.585, k_in=0.56):
    C, o = m.C, m.o
    return ring(W / 2, C / 2, W / 2, C / 2 + o, side or m.rside, top or m.rtop, k_out=k_out, k_in=k_in)


@glyph('O', 0x4F, 0x6F)
def O(m):
    W = m.v(690, 754)
    return G(o_ring(m, W), W, None, None)


@glyph('Q', 0x51, 0x71)
def Q(m):
    W = m.v(690, 754)
    a, b = m.v(52, 76), m.v(42, 60)
    tail = stroke([hobby((W * 0.44, m.v(60, 70)), (0.62, -1), (W * 0.80, -m.v(96, 100)), (1, -0.18)),
                   hobby((W * 0.80, -m.v(96, 100)), (1, -0.18), (W + m.v(70, 78), -m.v(108, 110)), (1, 0.12))],
                  a, b, knots=[(0, 1.0), (1, 0.92), (2, 0.62)], name='Q')
    return G(union([o_ring(m, W), tail]), W, None, None)


def c_shape(m, W, beak_top=True, beak_bottom=True, xt=None, xb=None):
    """The ring of a C cut open on the right, plumb, with a beak (a downward spur) at the top terminal and a smaller
    upward one at the bottom terminal. The beaks are added before the cut, so the cut makes each terminal in one go."""
    C, o = m.C, m.o
    cx, cy = W / 2, C / 2
    xt = W * m.v(0.735, 0.68) if xt is None else xt
    xb = W * m.v(0.770, 0.715) if xb is None else xb
    ringp = o_ring(m, W)
    parts = [ringp]

    def inner_top(x):
        return edge_y(inter(ringp, rect(x - 1, cy, x, C + 100)), x - 0.5, 'min')

    def outer_top(x):
        return edge_y(inter(ringp, rect(x - 1, cy, x, C + 100)), x - 0.5, 'max')

    def inner_bot(x):
        return edge_y(inter(ringp, rect(x - 1, -100, x, cy)), x - 0.5, 'max')

    yi_t, yi_b = inner_top(xt), inner_bot(xb)
    if beak_top:
        bl, bw = m.v(50, 40), m.v(46, 50)
        yi2 = inner_top(xt - bw)
        parts.append(polygon([(xt + 30, yi_t + 50), (xt + 30, yi_t - bl), (xt, yi_t - bl), (xt - bw, yi2 + 5),
                              (xt - bw, yi2 + 50)]))
    if beak_bottom:
        bl, bw = m.v(28, 20), m.v(36, 40)
        yi2 = inner_bot(xb - bw)
        parts.append(polygon([(xb + 30, yi_b - 50), (xb - bw, yi2 - 50), (xb - bw, yi2 - 5), (xb, yi_b + bl),
                              (xb + 30, yi_b + bl)]))
    shape = union(parts)
    shape = diff(shape, rect(xt, min(cy, yi_t - 80), W + 100, C + 100))
    shape = diff(shape, rect(xb, -100, W + 100, max(cy, yi_b + 60) if beak_bottom else cy))
    return shape


@glyph('C', 0x43, 0x63)
def C_(m):
    W = m.v(646, 726)
    # the Black's terminals are cut further back than the HUD's, so its heavier strokes keep the aperture open
    return G(c_shape(m, W, xt=W * m.v(0.735, 0.645), xb=W * m.v(0.770, 0.685)), W, None, None)


@glyph('G', 0x47, 0x67)
def G_(m):
    W = m.v(686, 756)
    side = m.rside
    yg = m.v(374, 378)          # top of the bar
    gs = side * 0.94            # the beard's width
    shape = c_shape(m, W, beak_bottom=False, xt=W * m.v(0.735, 0.70))
    ringp = o_ring(m, W)
    lower_right = inter(ringp, rect(W * 0.5, -100, W + 100, yg))
    sy = m.v(152, 146)          # the spur's tip
    beard = polygon([(W - gs, yg), (W, yg), (W, sy + m.v(46, 52)), (W - m.v(8, 10), sy), (W - gs, sy + m.v(118, 128))])
    gbar = bar(W - gs - m.v(112, 120), W, yg - m.hair * 0.94, yg)
    return G(union([shape, lower_right, beard, gbar]), W, None, None)


@glyph('D', 0x44, 0x64)
def D(m):
    s, C = m.stem, m.C
    W = m.v(626, 690)
    outer, counter = bowl(m, s, 0, C, W, k=0.62, kin=0.60)
    return G(diff(union([stem(0, s, 0, C, m.serif, br=False, tr=False, flare_l=m.flare), outer]), counter),
             W, m.sp, None, top=W * 0.46)


@glyph('B', 0x42, 0x62)
def B(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(546, 608)
    ym = m.v(392, 392)  # middle of the waist
    o1, c1 = bowl(m, s, 0, ym + h / 2, W, side=m.rside * 0.97, k=0.60, kin=0.58)
    o2, c2 = bowl(m, s, ym - h / 2, C, W * 0.90, side=m.rside * 0.92, top=h * 0.96, k=0.60, kin=0.58)
    shape = union([stem(0, s, 0, C, m.serif, br=False, tr=False, flare_l=m.flare), o1, o2])
    return G(diff(diff(shape, c1), c2), W, m.sp, None, top=W * 0.46)


@glyph('P', 0x50, 0x70)
def P(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(540, 600)
    yb = m.v(300, 296)
    o1, c1 = bowl(m, s, yb, C, W, k=0.60, kin=0.58)
    shape = union([stem(0, s, 0, C, m.serif, tr=False, flare_l=m.flare), o1])
    return G(diff(shape, c1), W, m.sp, None, top=W * 0.44)


def r_leg(m, xj, yj, xe, name, turn=None):
    """The long leg of R (and the leg of K): leaves the junction heading down and right, bottoms out on the baseline,
    then flicks up beyond the bowl. xj, yj: start; xe: x of the flick's end. turn: for K's longer leg, the leg runs
    as a straight diagonal until `turn` units above its low point and only then rounds into R's flick"""
    a, b = m.v(60, 92), m.v(48, 70)
    k = m.c                          # curvature: a rounder leg, a longer and higher flick
    yb = b - m.o * 0.6               # spine low point: the stroke's underside just under the baseline
    xb = xe - m.v(118, 132) - 26 * k
    flick = hobby((xb, yb), (1, 0), (xe + 6 * k, yb + m.v(40, 46) + 30 * k), (0.82 - 0.22 * k, 0.58 + 0.22 * k),
                  tension=1.0 - 0.1 * k)
    if turn is not None:
        # a straight diagonal from the start, tangent to a circle of radius R that sets the leg down on the baseline
        # at the low point, then the flick
        R = turn * (1 + 0.35 * k)
        cx, cy = xb, yb + R
        dx, dy = cx - xj, cy - yj
        dist = math.hypot(dx, dy)
        alpha = -(math.atan2(dy, dx) - math.asin(min(R / dist, 0.99)))   # the diagonal's slope below horizontal
        phi = -math.pi / 2 - alpha
        T = (cx + R * math.cos(phi), cy + R * math.sin(phi))
        d = (math.cos(alpha), -math.sin(alpha))
        if k:   # with curvature the diagonal sags a little
            mid = add(lerp2((xj, yj), T, 0.5), mul((-d[1], d[0]), -9 * k))
            spine = [hobby((xj, yj), d, mid, d), hobby(mid, d, T, d)]
        else:
            spine = [line_cubic((xj, yj), T)]
        spine += [arc_to(T, d, (xb, yb), (1, 0), R), flick]
        n = len(spine)
        return stroke(spine, a, b, knots=[(0, 1.02), (n - 2, 0.99), (n - 1, 0.96), (n, 0.74)], name=name,
                      fine=2 if k else 1)
    seg1 = hobby((xj, yj), (0.52 - 0.14 * k, -1), (xb, yb), (1, 0), tension=1.05 - 0.17 * k)
    return stroke([seg1, flick], a, b, knots=[(0, 1.02), (1, 0.96), (2, 0.74)], name=name, fine=2 if k else 1)


def lerp2(p, q, t):
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)


def arc_to(p, tp, q, tq, R):
    """A cubic circular arc of radius R from p (heading tp) to q (heading tq)"""
    ang = math.acos(max(-1.0, min(1.0, tp[0] * tq[0] + tp[1] * tq[1])))
    h = 4 / 3 * math.tan(ang / 4) * R
    return (p, add(p, mul(unit(tp), h)), sub(q, mul(unit(tq), h)), q)


def r_glyph(m, leg='kick'):
    """R. leg: 'kick' (the long leg flicking out past the bowl), 'short' (the same leg with a short flick, for calt
    before A T V W Y J) or 'roman' (a straight leg on a flared foot, for ss04)"""
    s, C, h = m.stem, m.C, m.hair
    Wb = m.v(530, 590)                 # the bowl
    yb = m.v(334, 330)
    o1, c1 = bowl(m, s, yb, C, Wb, k=0.60, kin=0.58)
    if leg == 'roman':
        th = m.thick * 0.96
        top = (s + (Wb - s) * 0.40, yb + h * 0.5)
        foot = (Wb - m.v(4, 0), 0)
        legp = diag(*diag_through((foot[0] - th * 0.4, 0), top, th, 0, yb + h * 0.5),
                    {'br': m.serif.scaled(1.0), 'bl': m.serif.scaled(0.5, 0.7)}, bend=bow(m, -6))
        rsb = None
    else:
        xe = Wb + (m.v(98, 104) if leg == 'kick' else m.v(26, 30))
        legp = r_leg(m, s + (Wb - s) * 0.30, yb + h * 0.5, xe, 'R')
        rsb = m.v(30, 22)
    shape = union([stem(0, s, 0, C, m.serif, tr=False, flare_l=m.flare), o1, legp])
    shape = diff(shape, c1)
    return G(shape, Wb, m.sp, rsb, top=Wb * 0.42)


@glyph('R', 0x52, 0x72)
def R(m):
    return r_glyph(m)


def k_frame(m):
    """What the three Ks share: the advance-setting width W (the arm's reach at the cap line, as wide as N), the
    crotch X where arm and leg part on the stem's right edge, and the flick's end (R's leg, at the same overhang)"""
    s = m.stem
    W = m.v(604, 672)
    X = (s + m.v(6, 8), m.v(352, 348))
    return s, W, X, W + m.v(14, 16)


def arm_top_serifs(m, arm, W):
    """Short flared serifs on both sides of an arm's end, cut level on the cap line (the straight cut; with curvature
    the arm's nib swells towards its end instead, see K)"""
    C = m.C
    sr, sl = m.serif.scaled(0.95), m.serif.scaled(0.6)
    xr, xl = edge_x(arm, C - 1, 'max'), edge_x(arm, C - 1, 'min')
    xr2, xl2 = edge_x(arm, C - sr.h, 'max'), edge_x(arm, C - sl.h, 'min')
    serif_r = polygon([(xr2 - 30, C - sr.h), (xr2, C - sr.h), (xr + sr.e, C - sr.t), (xr + sr.e, C), (xr - 30, C)])
    serif_l = polygon([(xl2 + 30, C - sl.h), (xl2, C - sl.h), (xl - sl.e, C - sl.t), (xl - sl.e, C), (xl + 30, C)])
    return [serif_r, serif_l]


def crotch_trap(m, shape, X):
    return trap_at(shape, X, m.trap)


def k_short_end(m, W):
    """Where a short K leg's flick ends (calt, before A T V W Y J)"""
    return W - m.v(56, 62)


@glyph('K', 0x4B, 0x6B)
def K(m, short=False):
    """The curved Basque K, a 20th-century convention owned as such: arm and leg part from one open crotch on the
    stem; the arm, as heavy as the thick diagonals, leaves low and sweeps up to the cap line; the leg is R's leg,
    with R's flick"""
    s, C = m.stem, m.C
    s_, W, X, xe = k_frame(m)
    if short:
        xe = k_short_end(m, W)
    k = m.c
    a, b = m.v(64, 96), m.v(52, 76)          # as heavy as the thick diagonals at 45 degrees
    top = (W - a * 0.95, C + 60)
    start = (s * 0.42, X[1] + b * 0.55)
    if k:   # the arm flares into the cap line by itself, like the stems' ends
        knots = [(0, 1.02), (0.62, 0.97), (0.9, 1.0 + 0.16 * k), (1, 1.0 + 0.42 * k)]
    else:
        knots = [(0, 1.02), (1, 0.97)]
    arm = stroke([hobby(start, (0.80, 0.60 + 0.04 * k), top, (0.30 - 0.06 * k, 1), tension=1.0 - 0.08 * k)],
                 a, b, knots=knots, name='K arm', fine=5 if k else 2)
    arm = diff(arm, rect(-100, C, W + 300, C + 300))
    leg = r_leg(m, s * 0.42, X[1] - b * 0.35, xe, 'K', turn=m.v(104, 120))
    parts = [stem(0, s, 0, C, m.serif, flare_l=m.flare), arm, leg] + ([] if k else arm_top_serifs(m, arm, W))
    shape = inter(union(parts), rect(-200, -200, xe + 300, C + 2))
    return G(crotch_trap(m, shape, X), W, m.sp, m.v(24, 18), top=W * 0.36)


def straight_stroke(pb, pt, thick, y0, y1, serifs, bend=None, clip_x=None):
    """A straight (or bowed) diagonal of perpendicular thickness `thick` along the centreline pb-pt, cut level at y0
    and y1, kept right of clip_x"""
    path = diag(*diag_through(pb, pt, thick, y0, y1), serifs, bend=bend)
    return path if clip_x is None else inter(path, rect(clip_x, -300, 3000, 1300))


def through_edge(X, d, thick, side):
    """A centreline point for a stroke of direction d whose `side` edge (+1 right, -1 left, horizontally) passes
    through X"""
    hw = thick / 2 / max(abs(unit(d)[1]), 1e-6)
    return (X[0] - side * hw, X[1])


@glyph('K.straight')
def K_straight(m, short=False):
    """K with a straight arm, its end flared level on the cap line, and R's kicked leg"""
    s, C = m.stem, m.C
    s_, W, X, xe = k_frame(m)
    if short:
        xe = k_short_end(m, W)
    th = m.thick * 0.96
    d = (W - X[0] - m.v(40, 46), C - X[1])
    c0 = through_edge(X, d, th, 1)
    pt = add(c0, mul(d, (C - c0[1]) / d[1]))
    pb = add(c0, mul(d, -1.2))
    arm = straight_stroke(pb, pt, th, pb[1], C, {'tr': m.serif.scaled(1.15), 'tl': m.serif.scaled(0.7)},
                          bend=bow(m, -8), clip_x=s * 0.5)
    leg = r_leg(m, s * 0.42, X[1] - m.v(52, 76) * 0.35, xe, 'K', turn=m.v(104, 120))
    shape = union([stem(0, s, 0, C, m.serif, flare_l=m.flare), arm, leg])
    return G(crotch_trap(m, shape, X), W, m.sp, m.v(24, 18), top=W * 0.36)


@glyph('K.roman')
def K_roman(m):
    """The plain inscription K: a thin straight arm and a thick straight leg meeting at the stem, all three standing
    on flared feet"""
    s, C = m.stem, m.C
    s_, W, X, xe = k_frame(m)
    Wl = W + m.v(26, 44)                      # the leg's foot reaches a little past the arm
    tha, thl = m.thin, m.thick * 0.94
    da = (W - X[0] - m.v(44, 50), C - X[1])
    ca = through_edge(X, da, tha, 1)
    arm = straight_stroke(add(ca, mul(da, -1.2)), add(ca, mul(da, (C - ca[1]) / da[1])), tha,
                          ca[1] - 1.2 * da[1], C, {'tr': m.serif, 'tl': m.serif.scaled(0.7)},
                          bend=bow(m, -6), clip_x=s * 0.5)
    dl = (Wl - m.v(70, 96) - X[0], -X[1])     # down to the foot
    cl = through_edge(X, dl, thl, 1)
    foot = add(cl, mul(dl, -cl[1] / dl[1]))
    top_ = add(cl, mul(dl, -1.0))
    leg = straight_stroke(foot, top_, thl, 0, top_[1], {'br': m.serif.scaled(1.05)},
                          bend=bow(m, -7), clip_x=s * 0.5)
    shape = union([stem(0, s, 0, C, m.serif, flare_l=m.flare), arm, leg])
    return G(crotch_trap(m, shape, X), Wl, m.sp, None, top=W * 0.36)


# ---------------------------------------------------------------------------------------------------------------------
# diagonals


@glyph('A', 0x41, 0x61)
def A(m, flag='l'):
    """The crowned A: a flat bar over the apex, reaching further to the left, and a crossbar that dips into a V. The
    legs' inner edges meet right under the crown, so the counter is a tall kite between the crown and the V.
    flag='r' turns the crown's long end to the right (calt uses it after T, V, W and Y, whose arms overhang the A's
    left)"""
    C, h = m.C, m.hair
    W = m.v(660, 800)               # 0.200: the Black wider than before, so its kite counter opens
    hc = h * 0.98
    thin, thick = m.thin * 0.92, m.thick * 0.96
    # solve the apex width so that the legs' inner edges meet just under the crown
    apex_w = m.v(170, 220)
    for _ in range(8):
        ax0 = W / 2 - apex_w / 2 + m.v(14, 16)
        l_hw = thin / math.sin(math.atan2(C, ax0))
        r_hw = thick / math.sin(math.atan2(C, W - (ax0 + apex_w)))
        spread = hc * (ax0 / C + (W - ax0 - apex_w) / C)
        apex_w = l_hw + r_hw - spread + m.v(4, 0)
    ax0 = W / 2 - apex_w / 2 + m.v(14, 16)
    l_hw = thin / math.sin(math.atan2(C, ax0))
    r_hw = thick / math.sin(math.atan2(C, W - (ax0 + apex_w)))
    left = diag((0, 0), (l_hw, 0), (ax0, C), (ax0 + l_hw, C),
                {'bl': m.serif.scaled(1.05), 'br': m.serif.scaled(0.55, 0.7)}, bend=bow(m, 9))
    right = diag((W - r_hw, 0), (W, 0), (ax0 + apex_w - r_hw, C), (ax0 + apex_w, C),
                 {'br': m.serif.scaled(1.05), 'bl': m.serif.scaled(0.55, 0.7)}, bend=bow(m, -9))
    # the crown: a bar on the cap line, longer to the left (or right), its ends cut as wedges
    if flag == 'l':
        cl = ax0 - m.v(132, 140)
        cr = ax0 + apex_w + m.v(20, 22)
        wl = min(m.wlen * 0.85, ax0 * (C - hc) / C - cl - 24)
        crown = bar(cl, cr, C - hc, C, left=(0, m.wdrop * 0.95, wl), right=(0, m.wdrop * 0.4, m.wlen * 0.4))
    else:
        cl = ax0 - m.v(20, 22)
        cr = ax0 + apex_w + m.v(132, 140)
        x_r = W + ((ax0 + apex_w) - W) * (C - hc) / C
        wr = min(m.wlen * 0.85, cr - x_r - 24)
        crown = bar(cl, cr, C - hc, C, left=(0, m.wdrop * 0.4, m.wlen * 0.4), right=(0, m.wdrop * 0.95, wr))
    # the V crossbar: its upper edge leaves the legs at y_side and dips to y_mid in the middle
    hb = h * 0.88
    y_side = m.v(364, 358)
    y_mid = m.v(298, 292)                      # >= 0.40 cap: the counter stays open
    def lx(y):
        return l_hw + ax0 * y / C
    def rx(y):
        return (W - r_hw) + ((ax0 + apex_w - r_hw) - (W - r_hw)) * y / C
    xm = (lx(y_mid) + rx(y_mid)) / 2
    xl, xr = lx(y_side) - 40, rx(y_side) + 40
    vbar = polygon([(xl, y_side + 10), (xm, y_mid), (xr, y_side + 10), (xr, y_side + 10 - hb * 1.08),
                    (xm, y_mid - hb * 1.12), (xl, y_side + 10 - hb * 1.08)])
    shape = union([left, right, crown, vbar])
    # ink traps in the counter's lower corners, where the V meets the legs
    up_l = unit((ax0, C))
    up_r = unit(((ax0 + apex_w - r_hw) - (W - r_hw), C))
    pl = intersect_lines((lx(0), 0), up_l, (xm, y_mid), unit((xl - xm, y_side + 10 - y_mid)))
    pr = intersect_lines((rx(0), 0), up_r, (xm, y_mid), unit((xr - xm, y_side + 10 - y_mid)))
    shape = trap_at(shape, pl, m.trap)
    shape = trap_at(shape, pr, m.trap)
    return G(shape, W, None, None, top=(lx(C * 0.5) + rx(C * 0.5)) / 2, ogonek=W - r_hw * 0.5)


@glyph('V', 0x56, 0x76)
def V(m):
    C = m.C
    W = m.v(652, 724)
    vt = m.v(40, 48)    # half the flat at the vertex
    lw = m.thick / math.sin(math.atan2(C, W / 2))
    rw = m.thin / math.sin(math.atan2(C, W / 2))
    y0 = -m.op
    left = diag((W / 2 - lw + vt, y0), (W / 2 + vt, y0), (0, C), (lw, C), {'tl': m.serif, 'tr': m.serif.scaled(0.7)},
                bend=bow(m, 10))
    right = diag((W / 2 - vt, y0), (W / 2 - vt + rw, y0), (W - rw, C), (W, C), {'tr': m.serif, 'tl': m.serif.scaled(0.7)},
                 bend=bow(m, -10))
    return G(union([left, right]), W, None, None)


@glyph('W', 0x57, 0x77)
def W_(m):
    C = m.C
    W = m.v(958, 1060)
    vt = m.v(34, 40)
    y0 = -m.op
    v1, v2 = W * 0.27, W * 0.73       # the two bottom vertices
    t2, t3 = W * 0.60, W * 0.40       # tops of the inner, crossing strokes
    thick, thin = m.thick * 0.98, m.thin * 0.84
    def hw(t, dx):
        return t / math.sin(math.atan2(C, abs(dx)))
    s1w, s2w, s3w, s4w = hw(thick, v1), hw(thin, t2 - v1), hw(thick, v2 - t3), hw(thin, W - v2)
    s1 = diag((v1 - s1w + vt, y0), (v1 + vt, y0), (0, C), (s1w, C), {'tl': m.serif, 'tr': m.serif.scaled(0.6)},
              bend=bow(m, 9))
    s2 = diag((v1 - vt, y0), (v1 - vt + s2w, y0), (t2 - s2w / 2, C), (t2 + s2w / 2, C), {'tr': m.serif.scaled(0.6)},
              bend=bow(m, -5))
    s3 = diag((v2 - s3w + vt, y0), (v2 + vt, y0), (t3 - s3w / 2, C), (t3 + s3w / 2, C), {'tl': m.serif.scaled(0.6)},
              bend=bow(m, 5))
    s4 = diag((v2 - vt, y0), (v2 - vt + s4w, y0), (W - s4w, C), (W, C), {'tr': m.serif, 'tl': m.serif.scaled(0.6)},
              bend=bow(m, -9))
    return G(union([s1, s2, s3, s4]), W, None, None)


@glyph('X', 0x58, 0x78)
def X(m):
    C = m.C
    W = m.v(636, 706)
    inset = m.v(34, 40)   # the top is a little narrower than the foot
    thick_w = m.thick / math.sin(math.atan2(C, W - inset))
    thin_w = m.thin * 0.92 / math.sin(math.atan2(C, W - inset))
    down = diag((W - thick_w, 0), (W, 0), (inset / 2, C), (inset / 2 + thick_w, C),
                {'bl': m.serif.scaled(0.8), 'br': m.serif, 'tl': m.serif, 'tr': m.serif.scaled(0.8)},
                bend=tuple(-d for d in s_bend(m, 8)))
    up = diag((0, 0), (thin_w, 0), (W - inset / 2 - thin_w, C), (W - inset / 2, C),
              {'bl': m.serif, 'br': m.serif.scaled(0.8), 'tl': m.serif.scaled(0.8), 'tr': m.serif}, bend=s_bend(m, 8))
    return G(union([down, up]), W, None, None)


@glyph('Y', 0x59, 0x79)
def Y(m):
    C, s = m.C, m.stem
    W = m.v(644, 716)
    yj = m.v(326, 322)
    cx = W / 2
    lw = m.thick / math.sin(math.atan2(C - yj, cx))
    rw = m.thin / math.sin(math.atan2(C - yj, cx))
    lb = diag_through((cx - s * 0.1, yj - 10), (lw / 2, C), m.thick, yj - 120, C)
    left = diag(*lb, {'tl': m.serif, 'tr': m.serif.scaled(0.7)}, bend=bow(m, 7))
    rb = diag_through((cx + s * 0.1, yj - 10), (W - rw / 2, C), m.thin, yj - 120, C)
    right = diag(*rb, {'tr': m.serif, 'tl': m.serif.scaled(0.7)}, bend=bow(m, -7))
    # the arms' outer edges run into the stem's sides: clip what would stick out below
    y_l = lb[0][1] + (lb[2][1] - lb[0][1]) * ((cx - s / 2) - lb[0][0]) / (lb[2][0] - lb[0][0])
    y_r = rb[1][1] + (rb[3][1] - rb[1][1]) * ((cx + s / 2) - rb[1][0]) / (rb[3][0] - rb[1][0])
    if m.c:   # bowed arms: where their outer edges really cross the stem's sides
        y_l = edge_y(left, cx - s / 2 + 0.5, 'min')
        y_r = edge_y(right, cx + s / 2 - 0.5, 'min')
    keep = polygon([(-100, C + 100), (-100, y_l), (cx - s / 2, y_l), (cx - s / 2, -100), (cx + s / 2, -100),
                    (cx + s / 2, y_r), (W + 100, y_r), (W + 100, C + 100)])
    arms = inter(union([left, right]), keep)
    st = stem(cx - s / 2, cx + s / 2, 0, max(y_l, y_r) + 20, m.serif, tl=False, tr=False)
    return G(union([arms, st]), W, None, None)


@glyph('M', 0x4D, 0x6D)
def M(m):
    C = m.C
    W = m.v(746, 830)
    splay = m.v(38, 42)
    yv = m.v(212, 204)           # the middle vertex: 70 % of the way down
    thin, thick = m.thin * 0.92, m.thick
    lw = thin / math.sin(math.atan2(C, splay))
    rw = m.stem * 0.98 / math.sin(math.atan2(C, splay))
    left = diag((0, 0), (lw, 0), (splay, C), (splay + lw, C), {'bl': m.serif, 'br': m.serif, 'tl': m.serif})
    right = diag((W - rw, 0), (W, 0), (W - splay - rw, C), (W - splay, C), {'bl': m.serif, 'br': m.serif, 'tr': m.serif})
    vx = W / 2
    dl_dir = unit((vx - splay, yv - C))
    dr_dir = unit((vx - (W - splay), yv - C))
    dlw = thick / math.sin(math.atan2(C - yv, vx - splay))
    drw = thin / math.sin(math.atan2(C - yv, W - splay - vx))
    q = intersect_lines((splay + dlw, C), dl_dir, (W - splay, C), dr_dir)
    q2 = intersect_lines((W - splay - drw, C), dr_dir, (splay, C), dl_dir)
    dl = polygon([(splay, C), (splay + dlw, C), q, (vx, yv)])
    dr = polygon([(W - splay - drw, C), (W - splay, C), (vx, yv), q2])
    return G(union([left, right, dl, dr]), W, None, None)


@glyph('N', 0x4E, 0x6E)
def N(m):
    C = m.C
    W = m.v(608, 676)
    sn = m.stem * 0.88
    dw = m.thick / math.sin(math.atan2(C, W - m.v(150, 200)))
    left = stem(0, sn, 0, C, m.serif, tr=False, flare_l=m.flare, flare_r=m.flare)
    right = stem(W - sn, W, -m.op, C, m.serif, bl=False, br=False, flare_l=m.flare, flare_r=m.flare)
    d = polygon([(W - dw, -m.op), (W, -m.op), (dw, C), (0, C)])
    return G(union([left, right, d]), W, m.sp, m.sp)


@glyph('U', 0x55, 0x75)
def U(m):
    C, s, o = m.C, m.stem, m.o
    W = m.v(612, 680)
    yu = m.v(300, 304)
    bottom = m.rtop * 1.02
    c = Contour((0, C))
    c.L((0, yu))
    k = 0.58
    ry = yu + o
    c.C((0, yu - ry * k), (W / 2 - W / 2 * k, -o), (W / 2, -o))
    c.C((W / 2 + W / 2 * k, -o), (W, yu - ry * k), (W, yu))
    c.L((W, C))
    c.L((W - s, C))
    c.L((W - s, yu))
    irx, iry = W / 2 - s, ry - bottom
    ki = 0.56
    c.C((W - s, yu - iry * ki), (W / 2 + irx * ki, -o + bottom), (W / 2, -o + bottom))
    c.C((W / 2 - irx * ki, -o + bottom), (s, yu - iry * ki), (s, yu))
    c.L((s, C))
    tops = [stem(0, s, yu, C, m.serif, bl=False, br=False), stem(W - s, W, yu, C, m.serif, bl=False, br=False)]
    return G(union([c.path()] + tops), W, m.sp, m.sp, ogonek=W * 0.68)


@glyph('J', 0x4A, 0x6A)
def J(m):
    C, s, o = m.C, m.stem, m.o
    W = m.v(452, 506)
    yu = m.v(268, 272)
    ry = yu + o
    bottom = m.rtop * 1.02
    k, ki = 0.58, 0.56
    irx, iry = W / 2 - s, ry - bottom
    yt = m.v(176, 186)            # the hook's end
    c = Contour((W, C))
    c.L((W - s, C))
    c.L((W - s, yu))
    c.C((W - s, yu - iry * ki), (W / 2 + irx * ki, -o + bottom), (W / 2, -o + bottom))
    c.C((W / 2 - irx * ki, -o + bottom), (s, yu - iry * ki), (s, yu))
    c.L((0, yu))
    c.C((0, yu - ry * k), (W / 2 - W / 2 * k, -o), (W / 2, -o))
    c.C((W / 2 + W / 2 * k, -o), (W, yu - ry * k), (W, yu))
    hook = diff(c.path(), rect(-100, yt, W / 2, C + 100))
    top = stem(W - s, W, yu, C, m.serif, bl=False, br=False)
    # the hook's end is cut level and flares a little outward, like a serif
    flare = polygon([(-m.v(14, 16), yt), (s * 0.5, yt), (s * 0.5, yt - 40), (2, yt - m.v(80, 90))])
    return G(union([hook, top, flare]), W, None, m.sp, top=W * 0.6)


# ---------------------------------------------------------------------------------------------------------------------
# S


@glyph('S', 0x53, 0x73)
def S(m):
    C, o = m.C, m.o
    W = m.v(512, 574)
    a, b = m.v(62, 96), m.v(48, 70)
    yt, yb = C + o - b, -o + b
    pts = {
        't0': (W - a * 0.95, C * 0.79),
        'top': (W * 0.52, yt),
        'l': (a * 1.02, C * 0.735),
        'mid': (W * 0.50, C * 0.505),
        'r': (W - a * 1.02, C * 0.262),
        'bot': (W * 0.47, yb),
        'b0': (a * 0.95, C * 0.215),
    }
    sp = [
        hobby(pts['t0'], (-0.25, 1), pts['top'], (-1, 0)),
        hobby(pts['top'], (-1, 0), pts['l'], (0, -1)),
        hobby(pts['l'], (0, -1), pts['mid'], (1, -0.48)),
        hobby(pts['mid'], (1, -0.48), pts['r'], (0, -1)),
        hobby(pts['r'], (0, -1), pts['bot'], (-1, 0)),
        hobby(pts['bot'], (-1, 0), pts['b0'], (-0.25, 1)),
    ]
    body = stroke(sp, a, b, knots=[(0, 0.9), (1, 1.0), (2.2, 1.0), (3, 1.10), (3.8, 1.0), (5, 1.0), (6, 0.9)], name='S')
    # terminals: cut plumb, the top one with a downward beak, the bottom one with an upward one
    xt, xb = W - a * 0.55, a * 0.55
    body = diff(body, rect(xt, C * 0.55, W + 200, C + 200))
    body = diff(body, rect(-200, -200, xb, C * 0.45))
    return G(body, W, None, None)


# ---------------------------------------------------------------------------------------------------------------------
# figures


@glyph('zero', 0x30)
def zero(m):
    W = m.v(548, 604)
    return G(o_ring(m, W, side=m.rside * 0.96, top=m.rtop * 1.02, k_out=0.60, k_in=0.58), W, None, None)


@glyph('one', 0x31)
def one(m):
    C, s = m.C, m.stem
    x0 = m.v(146, 156)                  # the flag's reach
    st = stem(x0, x0 + s, 0, C, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare,
              sb=m.serif.scaled(1.3))
    fd = m.v(150, 156)                  # the flag's drop at its tip
    ft = m.v(88, 118)                   # its thickness there
    a_ = (x0 + s * 0.5, C)
    slope = fd / a_[0]
    tip_top, tip_bot = (0, C - fd), (0, C - fd - ft)
    yd = C - fd - ft + slope * (x0 + 30)
    flag = polygon([a_, tip_top, tip_bot, (x0 + 30, yd)])
    # the stem's corner left above the flag is trimmed along the flag's top edge
    st = diff(st, polygon([(x0 - 80, C - slope * (s * 0.5 + 80)), a_, (x0 + s * 0.5, C + 100), (x0 - 80, C + 100)]))
    return G(union([st, flag]), x0 + s, None, None)


@glyph('two', 0x32)
def two(m):
    C, o, h = m.C, m.o, m.hair
    W = m.v(536, 596)
    a, b = m.v(62, 94), m.v(48, 70)
    sp = [
        hobby((a * 0.95, C * 0.70), (0.1, 1), (W * 0.49, C + o - b), (1, 0)),
        hobby((W * 0.49, C + o - b), (1, 0), (W - a, C * 0.69), (0, -1)),
        hobby((W - a, C * 0.69), (0, -1), (a * 0.9, h * 0.6), (-0.82, -1), tension=1.05),
    ]
    body = stroke(sp, a, b, knots=[(0, 0.92), (1, 1.0), (2, 1.0), (3, 1.04)], name='2', fine=2)
    body = diff(body, rect(-200, C * 0.55, a * 0.5, C + 200))
    base = bar(0, W + m.v(6, 8), 0, h, right=(m.wdrop, 0, m.wlen))
    return G(union([body, base]), W, None, None)


@glyph('three', 0x33)
def three(m):
    C, o = m.C, m.o
    W = m.v(530, 594)
    a, b = m.v(60, 92), m.v(46, 68)
    ym = m.v(398, 384)
    up = [
        hobby((a * 0.9, C * 0.73), (0.2, 1), (W * 0.48, C + o - b), (1, 0)),
        hobby((W * 0.48, C + o - b), (1, 0), (W * 0.90 - a, (C + ym) / 2 + 10), (0, -1)),
        hobby((W * 0.90 - a, (C + ym) / 2 + 10), (0, -1), (W * 0.34, ym), (-1, -0.05)),
    ]
    low = [
        hobby((W * 0.36, ym), (1, 0.02), (W - a, ym * 0.48), (0, -1)),
        hobby((W - a, ym * 0.48), (0, -1), (W * 0.47, -o + b), (-1, 0)),
        hobby((W * 0.47, -o + b), (-1, 0), (a * 0.9, C * 0.21), (-0.2, 1)),
    ]
    s1 = stroke(up, a, b, knots=[(0, 0.92), (1, 1.0), (2, m.v(0.96, 0.86)), (3, 0.92)], name='3a')
    s2 = stroke(low, a, b, knots=[(0, 0.92), (1, 1.02), (3, 0.92)], name='3b')
    body = union([s1, s2])
    body = diff(body, rect(-200, C * 0.55, a * 0.5, C + 200))
    body = diff(body, rect(-200, -200, a * 0.5, C * 0.45))
    return G(body, W, None, None)


@glyph('four', 0x34)
def four(m):
    """The open 4 of the dated stones: the diagonal stops short of the stem, and the bar runs on past it"""
    C, s, h = m.C, m.stem, m.hair
    W = m.v(600, 664)
    xs = W * 0.60                    # the stem's left edge
    yb = m.v(170, 166)               # bottom of the bar
    gap = m.v(30, 28)
    st = stem(xs, xs + s, 0, C * 0.92, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare)
    st = union([st, polygon([(xs, C * 0.92 - 30), (xs + s, C * 0.92 - 30), (xs + s, C * 0.92 + m.v(30, 36)), (xs, C * 0.92)])])
    bar_ = bar(0, W, yb, yb + h, right=(m.wdrop * 0.5, m.wdrop * 0.5, m.wlen * 0.6))
    dw = m.thin / math.sin(math.atan2(C - yb, xs - gap - m.v(110, 140)))
    top_r = xs - gap
    d = polygon([(0, yb + 2), (dw, yb + 2), (top_r, C), (top_r - dw, C)])
    return G(union([st, bar_, d]), W, None, None)


@glyph('five', 0x35)
def five(m):
    """The flat-topped 5 of the 1751 Anhaux lintel: a square top bar with a wedge, a short stem, a full bowl"""
    C, o, h, s = m.C, m.o, m.hair, m.stem
    W = m.v(548, 608)
    a, b = m.v(60, 92), m.v(46, 68)
    xs = m.v(26, 30)                          # the stem's left edge
    top = bar(xs, W * 0.94, C - h, C, right=(0, m.wdrop, m.wlen))
    ysb = m.v(372, 380)                       # where the stem meets the bowl
    sw = s * 0.92
    st = polygon([(xs, C - 2), (xs + sw, C - 2), (xs + sw, ysb - 40), (xs, ysb - 40)])
    ytop = m.v(468, 476) - b                  # the bowl's shoulder (spine)
    sp = [
        hobby((xs + sw / 2, ysb - 30), (0.22, 1), (W * 0.52, ytop), (1, 0)),
        hobby((W * 0.52, ytop), (1, 0), (W - a, ytop * 0.50), (0, -1)),
        hobby((W - a, ytop * 0.50), (0, -1), (W * 0.46, -o + b), (-1, 0)),
        hobby((W * 0.46, -o + b), (-1, 0), (a * 0.9, C * 0.21), (-0.2, 1)),
    ]
    bowl_ = stroke(sp, a, b, knots=[(0, 0.84), (0.6, 0.96), (1, 1.0), (2, 1.02), (4, 0.92)], name='5', fine=2)
    bowl_ = diff(bowl_, rect(-200, -200, a * 0.5, C * 0.45))
    shape = union([top, st, bowl_])
    shape = diff(shape, rect(-200, C * 0.45, xs, C + 200))
    return G(shape, W, None, None)


def six_path(m, W):
    C, o = m.C, m.o
    a, b = m.v(60, 92), m.v(46, 68)
    yr = m.v(250, 262)            # height of the bowl
    ryy = yr + o
    bowl_ = ring(W / 2, yr, W / 2, ryy, m.rside * 0.94, m.rtop * 0.98, k_out=0.58, k_in=0.56)
    sp = [
        hobby((a, yr), (0, 1), (W * 0.54, C + o - b), (1, 0.06), tension=1.0),
        hobby((W * 0.54, C + o - b), (1, 0.06), (W * 0.92 - a * 0.5, C * 0.80), (0.35, -1)),
    ]
    neck = stroke(sp, a * 1.0, b, knots=[(0, 1.02), (1, 0.96), (2, 0.88)], name='6')
    neck = diff(neck, rect(W * 0.86, C * 0.55, W + 200, C + 200))
    return union([bowl_, neck])


@glyph('six', 0x36)
def six(m):
    W = m.v(556, 616)
    return G(six_path(m, W), W, None, None)


@glyph('nine', 0x39)
def nine(m):
    """The 9 drawn as itself (0.100 turned the 6 round): a bowl a touch larger than the 6's, under the cap line, and
    a tail that runs down its right side and turns into the same plumb-cut terminal as the 3 and the 5"""
    C, o = m.C, m.o
    W = m.v(556, 616)
    a, b = m.v(60, 92), m.v(46, 68)
    yr = m.v(258, 268)
    cy = C - yr
    bowl_ = ring(W / 2, cy, W / 2, yr + o, m.rside * 0.94, m.rtop * 0.98, k_out=0.58, k_in=0.56)
    sp = [
        hobby((W - a, cy), (0, -1), (W * 0.62, C * 0.14), (-0.55, -1), tension=1.0),
        hobby((W * 0.62, C * 0.14), (-0.55, -1), (W * 0.40, -o + b), (-1, -0.05)),
        hobby((W * 0.40, -o + b), (-1, -0.05), (a * 0.9, C * 0.20), (-0.25, 1)),
    ]
    tail = stroke(sp, a, b, knots=[(0, 1.02), (1, 1.0), (2, 0.96), (3, 0.9)], name='9', fine=2)
    tail = diff(tail, rect(-200, -200, a * 0.5, C * 0.45))
    return G(union([bowl_, tail]), W, None, None)


@glyph('seven', 0x37)
def seven(m):
    """The swan-necked 7 of the 1637, 1705 and 1751 dates: its stem leaves the bar curving out, then falls plumb"""
    C, h, s = m.C, m.hair, m.stem
    W = m.v(548, 606)
    a, b = m.v(60, 92), m.v(46, 68)
    top = bar(0, W - a, C - h, C, left=(0, m.wdrop, m.wlen))
    xf = W * 0.40                       # where the neck lands
    p0 = (W - a, C + 40)
    p1 = (W * 0.66, C * 0.46)
    p2 = (xf, m.v(150, 160))
    sp = [
        hobby(p0, (-0.04, -1), p1, (-0.62, -1), tension=1.0),
        hobby(p1, (-0.62, -1), p2, (0, -1), tension=1.0),
        line_cubic(p2, (xf, -40)),
    ]
    neck = stroke(sp, a, b, knots=[(0, 1.0), (1, 1.0), (3, 1.0)], name='7', fine=2)
    neck = diff(neck, rect(-200, -300, W + 200, 0))
    neck = diff(neck, rect(-200, C, W + 200, C + 300))
    foot = stem(xf - a, xf + a, 0, m.v(130, 140), m.serif, tl=False, tr=False)
    return G(union([top, neck, foot]), W, None, None)


@glyph('eight', 0x38)
def eight(m):
    C, o = m.C, m.o
    W = m.v(560, 620)
    a, b = m.v(60, 90), m.v(46, 66)
    yw = m.v(392, 396)                 # the waist
    ut, lb = C + o - b, -o + b
    xm = W / 2
    pts = [
        ((xm, yw), (1, 0.42)),
        ((W * 0.92 - a, (yw + ut) / 2 + 4), (0, 1)),
        ((xm, ut), (-1, 0)),
        ((W * 0.08 + a, (yw + ut) / 2 + 4), (0, -1)),
        ((xm, yw), (1, -0.42)),
        ((W - a, (yw + lb) / 2), (0, -1)),
        ((xm, lb), (-1, 0)),
        ((a, (yw + lb) / 2), (0, 1)),
        ((xm, yw), (1, 0.42)),
    ]
    sp = [hobby(p, tp, q, tq) for (p, tp), (q, tq) in zip(pts, pts[1:])]
    body = stroke(sp, a, b, knots=[(0, 0.86), (1, 0.94), (2, 0.94), (3, 0.94), (4, 0.86), (5, 1.0), (6, 1.0), (7, 1.0), (8, 0.86)], name='8')
    return G(body, W, None, None)


# ---------------------------------------------------------------------------------------------------------------------
# punctuation


@glyph('period', 0x2E)
def period(m):
    dx, dy = dot_size(m)
    return G(lozenge(dx, dy - 4, dx, dy), 2 * dx, m.v(46, 38), m.v(46, 38))


@glyph('periodcentered', 0xB7)
def periodcentered(m):
    """The lozenge interpunct of the inscriptions (HAVDA·ERROTA·SENPERECO, 1652): taller than wide, like the cut ones"""
    dx, dy = m.v(64, 80), m.v(84, 102)
    return G(lozenge(dx, m.C / 2, dx, dy), 2 * dx, m.v(54, 44), m.v(54, 44))


def comma_shape(m, cy):
    dx, dy = dot_size(m)
    cx = dx
    head = lozenge(cx, cy, dx, dy)
    tail = polygon([(cx + dx * 0.62, cy - dy * 0.38), (cx - dx * 0.62, cy - dy - m.v(150, 156)),
                    (cx - dx * 0.86, cy - dy - m.v(138, 142)), (cx - dx * 0.30, cy - dy * 0.70)])
    return union([head, tail])


@glyph('comma', 0x2C)
def comma(m):
    dx, dy = dot_size(m)
    return G(comma_shape(m, dy - 4), 2 * dx, m.v(46, 38), m.v(46, 38))


@glyph('colon', 0x3A)
def colon(m):
    dx, dy = dot_size(m)
    return G(union([lozenge(dx, dy - 4, dx, dy), lozenge(dx, m.v(420, 420), dx, dy)]), 2 * dx, m.v(52, 42), m.v(52, 42))


@glyph('semicolon', 0x3B)
def semicolon(m):
    dx, dy = dot_size(m)
    return G(union([comma_shape(m, dy - 4), lozenge(dx, m.v(420, 420), dx, dy)]), 2 * dx, m.v(52, 42), m.v(52, 42))


@glyph('quoteright', 0x2019)
def quoteright(m):
    dx, dy = dot_size(m)
    return G(comma_shape(m, m.C - dy + 6), 2 * dx, m.v(40, 32), m.v(40, 32))


@glyph('quoteleft', 0x2018)
def quoteleft(m):
    dx, dy = dot_size(m)
    sh = comma_shape(m, m.C - dy + 6)
    return G(rotate180(sh, dx, (m.C + 6 + (m.C - 2 * dy + 6 - m.v(150, 156))) / 2), 2 * dx, m.v(40, 32), m.v(40, 32))


@glyph('quotedblright', 0x201D)
def quotedblright(m):
    dx, dy = dot_size(m)
    gap = m.v(40, 44)
    one_ = comma_shape(m, m.C - dy + 6)
    return G(union([one_, shift(one_, 2 * dx + gap, 0)]), 4 * dx + gap, m.v(40, 32), m.v(40, 32))


@glyph('quotedblleft', 0x201C)
def quotedblleft(m):
    dx, dy = dot_size(m)
    gap = m.v(40, 44)
    sh = rotate180(comma_shape(m, m.C - dy + 6), dx, (m.C + 6 + (m.C - 2 * dy + 6 - m.v(150, 156))) / 2)
    return G(union([sh, shift(sh, 2 * dx + gap, 0)]), 4 * dx + gap, m.v(40, 32), m.v(40, 32))


def straight_quote(m, x):
    wt, wb = m.v(98, 126), m.v(54, 70)
    return polygon([(x - wt / 2, m.C + 8), (x + wt / 2, m.C + 8), (x + wb / 2, m.C - m.v(250, 250)), (x - wb / 2, m.C - m.v(250, 250))])


@glyph('quotesingle', 0x27)
def quotesingle(m):
    wt = m.v(98, 126)
    return G(straight_quote(m, wt / 2), wt, m.v(44, 36), m.v(44, 36))


@glyph('quotedbl', 0x22)
def quotedbl(m):
    wt = m.v(98, 126)
    gap = m.v(50, 54)
    return G(union([straight_quote(m, wt / 2), straight_quote(m, wt * 1.5 + gap)]), 2 * wt + gap, m.v(44, 36), m.v(44, 36))


@glyph('exclam', 0x21)
def exclam(m):
    dx, dy = dot_size(m)
    wt, wb = m.v(132, 176), m.v(76, 104)
    cx = dx
    wedge = polygon([(cx - wt / 2, m.C), (cx + wt / 2, m.C), (cx + wb / 2, 2 * dy + m.v(70, 76)), (cx - wb / 2, 2 * dy + m.v(70, 76))])
    return G(union([wedge, lozenge(cx, dy - 4, dx, dy)]), 2 * dx, m.v(60, 48), m.v(60, 48))


@glyph('exclamdown', 0xA1)
def exclamdown(m):
    dx, dy = dot_size(m)
    return G(rotate180(exclam(m).path, dx, m.C / 2), 2 * dx, m.v(60, 48), m.v(60, 48))


def question_path(m, W):
    C, o = m.C, m.o
    dx, dy = dot_size(m)
    a, b = m.v(58, 90), m.v(46, 66)
    xs = W * 0.46
    sp = [
        hobby((a * 0.9, C * 0.70), (0.1, 1), (W * 0.50, C + o - b), (1, 0)),
        hobby((W * 0.50, C + o - b), (1, 0), (W - a, C * 0.70), (0, -1)),
        hobby((W - a, C * 0.70), (0, -1), (xs, C * 0.40), (0, -1), tension=1.0),
        line_cubic((xs, C * 0.40), (xs, 2 * dy + m.v(76, 80))),
    ]
    body = stroke(sp, a, b, knots=[(0, 0.92), (1, 1.0), (2, 1.0), (3, 0.86), (4, 0.86)], name='?')
    body = diff(body, rect(-200, C * 0.55, a * 0.5, C + 200))
    return union([body, lozenge(xs, dy - 4, dx, dy)])


@glyph('question', 0x3F)
def question(m):
    W = m.v(470, 530)
    return G(question_path(m, W), W, m.v(40, 32), m.v(40, 32))


@glyph('questiondown', 0xBF)
def questiondown(m):
    W = m.v(470, 530)
    return G(rotate180(question_path(m, W), W / 2, m.C / 2), W, m.v(40, 32), m.v(40, 32))


@glyph('hyphen', 0x2D)
def hyphen(m):
    W = m.v(226, 244)
    h = m.hair * 0.96
    return G(rect(0, 350 - h / 2, W, 350 + h / 2), W, m.v(38, 32), m.v(38, 32))


@glyph('endash', 0x2013)
def endash(m):
    h = m.hair * 0.96
    return G(rect(0, 350 - h / 2, 420, 350 + h / 2), 420, 40, 40)


@glyph('emdash', 0x2014)
def emdash(m):
    h = m.hair * 0.96
    return G(rect(0, 350 - h / 2, 920, 350 + h / 2), 920, 40, 40)


def paren_path(m):
    C = m.C
    a, b = m.v(50, 76), m.v(40, 58)
    W = m.v(210, 238)
    ytop, ybot = C + 70, -70
    sp = [
        hobby((W - a * 0.2, ytop), (-0.56, -1), (a, C / 2), (0, -1)),
        hobby((a, C / 2), (0, -1), (W - a * 0.2, ybot), (0.56, -1)),
    ]
    p = stroke(sp, a, b, knots=[(0, 0.82), (1, 1.06), (2, 0.82)], name='(')
    return p, W


@glyph('parenleft', 0x28)
def parenleft(m):
    p, W = paren_path(m)
    return G(p, W, m.v(58, 48), m.v(34, 30))


@glyph('parenright', 0x29)
def parenright(m):
    p, W = paren_path(m)
    return G(mirror_x(p, W / 2), W, m.v(34, 30), m.v(58, 48))


@glyph('slash', 0x2F)
def slash(m):
    C = m.C
    W = m.v(380, 410)
    t = m.hair * 1.02
    hw = t / math.sin(math.atan2(C + 140, W))
    return G(polygon([(0, -70), (hw, -70), (W, C + 70), (W - hw, C + 70)]), W, m.v(10, 6), m.v(10, 6))


@glyph('ampersand', 0x26)
def ampersand(m):
    """A Roman ampersand whose tail ends in the same upturned flick as the legs of R and K"""
    C, o = m.C, m.o
    W = m.v(706, 778)
    a, b = m.v(56, 86), m.v(44, 62)
    pts = [
        ((W * 0.90, C * 0.52), (-0.20, -1)),         # the arm's end, cut level
        ((W * 0.42, -o + b), (-1, 0)),               # bottom of the bowl
        ((a, C * 0.25), (0, 1)),                     # its left side
        ((W * 0.40, C * 0.50), (0.78, 1)),           # rising through the crossing
        ((W * 0.60 - a * 0.5, C * 0.79), (0, 1)),    # the loop's right side
        ((W * 0.38, C + o - b), (-1, 0)),            # its top
        ((W * 0.12 + a * 0.5, C * 0.79), (0, -1)),   # its left side
        ((W * 0.50, C * 0.36), (0.64, -1)),          # falling through the crossing
        ((W * 0.80, b - o * 0.6), (1, 0)),           # along the baseline
        ((W + m.v(20, 24), b + m.v(30, 34)), (0.82, 0.58)),  # the flick
    ]
    sp = [hobby(p, tp, q, tq) for (p, tp), (q, tq) in zip(pts, pts[1:])]
    body = stroke(sp, a, b, knots=[(0, 0.88), (1, 1.0), (2, 1.02), (3, 0.98), (4, 0.84), (5, 0.80), (6, 0.84),
                                   (7, 1.0), (8, 0.98), (9, 0.80)], name='&', fine=3)
    # the arm's end: cut level at its top, with a short spur to the right like the serifs' tips
    body = diff(body, rect(W * 0.70, C * 0.52, W + 200, C * 0.66))
    xe = edge_x(body, C * 0.52 - 1, 'max')
    xs = edge_x(body, C * 0.52 - 1, 'min') if xe else None
    if xe:
        e = m.serif.e * 0.9
        spur = polygon([(xs + 10, C * 0.52), (xe + e, C * 0.52), (xe + e, C * 0.52 - m.serif.t),
                        (xe - 4, C * 0.52 - m.serif.h * 0.9), (xs + 10, C * 0.52 - m.serif.h * 0.9)])
        body = union([body, spur])
    return G(body, W, None, m.v(24, 18))


@glyph('space', 0x20, 0xA0)
def space(m):
    return G(None, 0, 0, 0, adv=m.v(250, 240))


# ---------------------------------------------------------------------------------------------------------------------
# marks: see marks.py


def accent_base(m):
    return m.C + ACCENT_GAP


# ---------------------------------------------------------------------------------------------------------------------
# the dotted i: the minuscule i of the Iparralde shop signs (PHARMACiE, PALAiS, IBAiA), drawn among the capitals.
# Four stems (short with serifs, the cap-height stem of I, and both without serifs) and three dots (the lozenge of
# the interpunct, a round dot, a chisel-cut wedge). The short stem leaves room for the dot inside the cap height; the
# tall one carries a smaller dot above the cap line, where the accents sit.

I_STEMS = ['short', 'tall', 'shortplain', 'tallplain']
I_DOTS = ['lozenge', 'round', 'wedge']


def idot_size(m, tall):
    """half width, half height of the lozenge dot: the interpunct's proportions on the short i, the dieresis's on
    the tall one (it sits in the accent zone)"""
    return (m.v(54, 68), m.v(62, 78)) if tall else (m.v(60, 76), m.v(80, 98))


def short_i_top(m):
    """The short stem's top: under the dot, which reaches the cap line"""
    dx, dy = idot_size(m, False)
    return m.C - 2 * dy - m.v(58, 54)


def i_stem(m, kind):
    s = m.stem
    top = m.C if kind.startswith('tall') else short_i_top(m)
    if kind.endswith('plain'):
        return stem(0, s, 0, top, m.serif, bl=False, br=False, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare)
    return stem(0, s, 0, top, m.serif, flare_l=m.flare, flare_r=m.flare)


def i_dot(m, kind, cx, tall):
    dx, dy = idot_size(m, tall)
    bottom = m.C + m.v(50, 48) if tall else short_i_top(m) + m.v(58, 54)
    if kind == 'lozenge':
        return lozenge(cx, bottom + dy, dx, dy)
    if kind == 'round':
        r = (dx + dy) * 0.56
        return oval(cx, bottom + r - m.o * 0.5, r, r)
    # the chisel-cut wedge: flat on top, cut to a point below
    w, h = dx * 1.24, dy * 1.80
    return polygon([(cx, bottom - m.op), (cx + w, bottom - m.op + h), (cx - w, bottom - m.op + h)])


def make_i(stem_kind, dot_kind):
    def fn(m):
        s = m.stem
        return G(union([i_stem(m, stem_kind), i_dot(m, dot_kind, s / 2, stem_kind.startswith('tall'))]),
                 s, m.sp, m.sp)
    return fn


def make_dotless(stem_kind):
    def fn(m):
        top_y = m.C + short_i_accent_shift(m) if stem_kind.startswith('short') else None
        return G(i_stem(m, stem_kind), m.stem, m.sp, m.sp, top_y=top_y)
    return fn


for _st in I_STEMS:
    for _dt in I_DOTS:
        GLYPHS[f'i.{_st}.{_dt}'] = ([], make_i(_st, _dt))
for _st in ('short', 'shortplain', 'tallplain'):
    GLYPHS[f'dotlessi.{_st}'] = ([], make_dotless(_st))


def short_i_accent_shift(m):
    """How far an accent drops to sit on the short i where its dot is: its bottom at the dot's bottom"""
    return short_i_top(m) + m.v(58, 54) - accent_base(m)


# composites: (name, unicodes, base, mark or None, placement). Placement None puts the mark on the base's anchor for
# its class (top; bottom for the cedilla and comma below; ogonek; caron for Ľ); 'short' lowers it onto the short
# dotted i; 'spacing' makes a spacing accent (no base). latin.py adds the accented letters and marks.py the spacing
# accents. Lowercase codepoints share the capitals' glyphs, except the i family, which has its own glyphs so that the
# dotted-i features can tell i from I.
COMPOSITES = [
    ('i', [0x69], 'I', None, None),
    ('iacute', [0xED], 'I', 'acutecomb', None), ('igrave', [0xEC], 'I', 'gravecomb', None),
    ('idieresis', [0xEF], 'I', 'dieresiscomb', None),
]
I_ACCENTS = [('acute', 'acutecomb'), ('grave', 'gravecomb'), ('dieresis', 'dieresiscomb'),
             ('circumflex', 'circumflexcomb')]
for _acc, _mark in I_ACCENTS:
    COMPOSITES.append((f'i{_acc}.short', [], 'dotlessi.short', _mark, 'short'))
    COMPOSITES.append((f'i{_acc}.shortplain', [], 'dotlessi.shortplain', _mark, 'short'))
    COMPOSITES.append((f'i{_acc}.tallplain', [], 'dotlessi.tallplain', _mark, None))


def trap_at(shape, near, depth, mouth=0.5):
    """Cut an ink trap at the outline vertex nearest to `near` (a concave corner where two strokes meet), using the
    outline's own tangents there, so the cutter meets the outline cleanly"""
    from geometry import contours_of, seg_list
    best = None
    for c in contours_of(shape):
        segs = seg_list(c)
        for i, (t, pts) in enumerate(segs):
            v = pts[0]
            d = length(sub(v, near))
            if best is None or d < best[0]:
                prev = segs[i - 1][1]
                best = (d, v, prev, pts)
    _, v, prev, nxt = best
    d_in = unit(sub(prev[-2] if length(sub(prev[-2], v)) > 1e-6 else prev[0], v))   # back along the previous segment
    d_out = unit(sub(nxt[1] if length(sub(nxt[1], v)) > 1e-6 else nxt[-1], v))      # along the next segment
    return diff(shape, ink_trap(v, d_in, d_out, depth, mouth))


@glyph('OE', 0x152, 0x153)
def OE(m):
    """The left half of an O whose bars run straight into an E (no overshoot: the bowl meets flat arms)"""
    C, s, h = m.C, m.stem, m.hair
    rb = m.v(330, 372)                      # the bowl's half width
    bowl = ring(rb, C / 2, rb, C / 2, m.rside, h, k_out=0.585, k_in=0.56)
    bowl = inter(bowl, rect(-100, -100, rb + 1, C + 100))
    sw = s * 0.92
    arm = m.v(300, 340)
    W = rb + sw + arm
    hm = h * 0.94
    ym = m.v(372, 370)
    shape = union([
        bowl,
        rect(rb - 1, 0, rb + sw, C),
        bar(rb + sw / 2, W, C - h, C, right=(0, m.wdrop, m.wlen)),
        bar(rb + sw / 2, W - arm * 0.16, ym - hm / 2, ym + hm / 2,
            right=(m.wdrop * 0.55, m.wdrop * 0.55, m.wlen * 0.8)),
        bar(rb + sw / 2, W + m.v(8, 10), 0, h, right=(m.wdrop, 0, m.wlen)),
    ])
    return G(shape, W, None, None, top=W * 0.48)