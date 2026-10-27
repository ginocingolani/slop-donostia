"""Ateburu's letters, drawn in code. Each function takes a master (HUD or Black) and returns the glyph's outline in
"body" coordinates (x = 0 at the left edge of its main strokes, serifs may reach past it), its body width and how its
sides space (see build.py). The identity sits in a handful of default glyphs; everything else stays calm and Roman.

Sources for every identity form are listed in ../SOURCES.md (Louis Colas, La tombe basque, 1923, and photographs of
dated lintels); nothing here is traced from any font or image: the shapes are numbers chosen by eye and judgment.
"""
import math

from geometry import (Contour, Serif, add, bar, diag, diag_through, diff, edge_x, edge_y, hobby, inter, length,
                      line_cubic, mirror_x, mul, polygon, rect, ring, rotate180, shift, stem, stroke, sub, union, unit)

CAP = 720
OVERSHOOT = 13
ACCENT_GAP = 54  # between the cap line and the bottom of a capital accent


class Master:
    """The design parameters of one master. t = 0 is HUD (wght 600), t = 1 is Black (wght 900)."""

    def __init__(self, name, t, wght):
        self.name, self.t, self.wght = name, t, wght
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
    """A drawn glyph: outline (skia path), body width w, left/right side bearings (None = auto-spaced), anchors"""

    def __init__(self, path, w, lsb=None, rsb=None, top=None, bottom=None, adv=None):
        self.path, self.w, self.lsb, self.rsb = path, w, lsb, rsb
        self.top = w / 2 if top is None else top
        self.bottom = w / 2 if bottom is None else bottom
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


def oval_point(cx, cy, rx, ry, k, x, upper=True):
    """y of an oval() at a given x (numerically, on its upper or lower half)"""
    from geometry import bez
    if upper:
        arcs = [((cx + rx, cy), (cx + rx, cy + ry * k), (cx + rx * k, cy + ry), (cx, cy + ry)),
                ((cx, cy + ry), (cx - rx * k, cy + ry), (cx - rx, cy + ry * k), (cx - rx, cy))]
    else:
        arcs = [((cx - rx, cy), (cx - rx, cy - ry * k), (cx - rx * k, cy - ry), (cx, cy - ry)),
                ((cx, cy - ry), (cx + rx * k, cy - ry), (cx + rx, cy - ry * k), (cx + rx, cy))]
    best = None
    for a in arcs:
        for i in range(401):
            p = bez(a, i / 400)
            if best is None or abs(p[0] - x) < abs(best[0] - x):
                best = p
    return best[1]


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


@glyph('I', 0x49, 0x69)
def I(m):
    s = m.stem
    return G(stem(0, s, 0, m.C, m.serif, flare_l=m.flare, flare_r=m.flare), s, m.sp, m.sp)


@glyph('E', 0x45, 0x65)
def E(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(452, 512)
    ym = m.v(372, 370)
    hm = h * 0.94
    return G(union([
        stem(0, s, 0, C, m.serif, br=False, tr=False, flare_l=m.flare),
        bar(s / 2, W, C - h, C, right=(0, m.wdrop, m.wlen)),
        bar(s / 2, W * 0.86, ym - hm / 2, ym + hm / 2, right=(m.wdrop * 0.55, m.wdrop * 0.55, m.wlen * 0.8)),
        bar(s / 2, W + m.v(8, 10), 0, h, right=(m.wdrop, 0, m.wlen)),
    ]), W, m.sp, None, top=W * 0.48)


@glyph('F', 0x46, 0x66)
def F(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(436, 494)
    ym = m.v(352, 350)
    hm = h * 0.94
    return G(union([
        stem(0, s, 0, C, m.serif, tr=False, flare_l=m.flare, flare_r=m.flare),
        bar(s / 2, W, C - h, C, right=(0, m.wdrop, m.wlen)),
        bar(s / 2, W * 0.86, ym - hm / 2, ym + hm / 2, right=(m.wdrop * 0.55, m.wdrop * 0.55, m.wlen * 0.8)),
    ]), W, m.sp, None)


@glyph('L', 0x4C, 0x6C)
def L(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(446, 506)
    return G(union([
        stem(0, s, 0, C, m.serif, br=False, flare_l=m.flare, flare_r=m.flare),
        bar(s / 2, W, 0, h, right=(m.wdrop, 0, m.wlen)),
    ]), W, m.sp, None, top=s / 2)


@glyph('T', 0x54, 0x74)
def T(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(588, 648)
    x0 = W / 2 - s / 2
    return G(union([
        stem(x0, x0 + s, 0, C, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare),
        bar(0, W, C - h, C, left=(0, m.wdrop, m.wlen), right=(0, m.wdrop, m.wlen)),
    ]), W, None, None)


@glyph('Z', 0x5A, 0x7A)
def Z(m):
    C, h = m.C, m.hair
    W = m.v(548, 608)
    hw = m.thick / math.sin(math.atan2(C - 2 * h, W - m.v(150, 200)))
    return G(union([
        bar(m.v(14, 16), W - m.v(10, 12), C - h, C, left=(0, m.wdrop, m.wlen)),
        bar(0, W + m.v(6, 8), 0, h, right=(m.wdrop, 0, m.wlen)),
        polygon([(0, h - 2), (hw, h - 2), (W - m.v(10, 12), C - h + 2), (W - m.v(10, 12) - hw, C - h + 2)]),
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
        bl, bw = m.v(50, 54), m.v(46, 52)
        yi2 = inner_top(xt - bw)
        parts.append(polygon([(xt + 30, yi_t + 50), (xt + 30, yi_t - bl), (xt, yi_t - bl), (xt - bw, yi2 + 5),
                              (xt - bw, yi2 + 50)]))
        # the outer corner rises a touch: the terminal reads as cut square, not worn
        bw2 = m.v(64, 70)
        yo, yo2 = outer_top(xt), outer_top(xt - bw2)
        parts.append(polygon([(xt + 30, yo - 50), (xt - bw2, yo2 - 50), (xt - bw2, yo2 - 4), (xt, yo + 8),
                              (xt + 30, yo + 8)]))
    if beak_bottom:
        bl, bw = m.v(28, 30), m.v(36, 42)
        yi2 = inner_bot(xb - bw)
        parts.append(polygon([(xb + 30, yi_b - 50), (xb - bw, yi2 - 50), (xb - bw, yi2 - 5), (xb, yi_b + bl),
                              (xb + 30, yi_b + bl)]))
    shape = union(parts)
    shape = diff(shape, rect(xt, min(cy, yi_t - 80), W + 100, C + 100))
    shape = diff(shape, rect(xb, -100, W + 100, max(cy, yi_b + 60) if beak_bottom else cy))
    return shape


@glyph('C', 0x43, 0x63)
def C_(m):
    W = m.v(624, 704)
    return G(c_shape(m, W, xt=W * m.v(0.735, 0.665), xb=W * m.v(0.770, 0.70)), W, None, None)


@glyph('G', 0x47, 0x67)
def G_(m):
    C = m.C
    W = m.v(670, 740)
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


def r_leg(m, xj, yj, xe, name):
    """The long leg of R (and the leg of K): leaves the junction heading down and right, bottoms out on the baseline,
    then flicks up beyond the bowl. xj, yj: start; xe: x of the flick's end"""
    a, b = m.v(60, 92), m.v(48, 70)
    yb = b - m.o * 0.6               # spine low point: the stroke's underside just under the baseline
    xb = xe - m.v(118, 132)
    seg1 = hobby((xj, yj), (0.52, -1), (xb, yb), (1, 0), tension=1.05)
    seg2 = hobby((xb, yb), (1, 0), (xe, yb + m.v(40, 46)), (0.82, 0.58), tension=1.0)
    return stroke([seg1, seg2], a, b, knots=[(0, 1.02), (1, 0.96), (2, 0.74)], name=name)


@glyph('R', 0x52, 0x72)
def R(m):
    s, C, h = m.stem, m.C, m.hair
    Wb = m.v(530, 590)                 # the bowl
    yb = m.v(334, 330)
    o1, c1 = bowl(m, s, yb, C, Wb, k=0.60, kin=0.58)
    xe = Wb + m.v(98, 104)
    leg = r_leg(m, s + (Wb - s) * 0.30, yb + h * 0.5, xe, 'R')
    shape = union([stem(0, s, 0, C, m.serif, tr=False, flare_l=m.flare), o1, leg])
    shape = diff(shape, c1)
    # the leg's end: cut square to the stroke, then trimmed level at the top so it reads as carved
    return G(shape, Wb, m.sp, m.v(-58, -66), top=Wb * 0.42)


@glyph('K', 0x4B, 0x6B)
def K(m):
    s, C = m.stem, m.C
    W = m.v(566, 628)
    xj, yj = s - m.v(8, 12), m.v(300, 296)
    # the arm: a gentle arc from the stem up to the cap line, ending square with short serifs
    a, b = m.v(54, 84), m.v(46, 68)
    top_x = W - m.v(60, 70)
    arm_dir0 = (0.86, 0.52)
    arm = stroke([hobby((xj, yj), arm_dir0, (top_x, C + 40), (0.40, 1), tension=1.0)], a, b,
                 knots=[(0, 0.96), (1, 1.04)], name='K arm')
    arm = diff(arm, rect(-100, C, W + 300, C + 300))
    sr, sl = m.serif.scaled(0.95), m.serif.scaled(0.6)
    xr, xl = edge_x(arm, C - 1, 'max'), edge_x(arm, C - 1, 'min')
    xr2, xl2 = edge_x(arm, C - sr.h, 'max'), edge_x(arm, C - sl.h, 'min')
    serif_r = polygon([(xr2 - 30, C - sr.h), (xr2, C - sr.h), (xr + sr.e, C - sr.t), (xr + sr.e, C), (xr - 30, C)])
    serif_l = polygon([(xl2 + 30, C - sl.h), (xl2, C - sl.h), (xl - sl.e, C - sl.t), (xl - sl.e, C), (xl + 30, C)])
    leg = r_leg(m, s + m.v(30, 40), m.v(392, 388), W + m.v(54, 58), 'K')
    shape = union([stem(0, s, 0, C, m.serif, flare_l=m.flare), arm, serif_r, serif_l, leg])
    # ink trap where the arm's upper edge meets the stem
    ys = edge_y(inter(arm, rect(s, 0, s + 1, C)), s + 0.5, 'max')
    shape = trap_at(shape, (s, ys), m.trap)
    return G(shape, W, m.sp, m.v(-40, -44), top=W * 0.36)


# ---------------------------------------------------------------------------------------------------------------------
# diagonals


@glyph('A', 0x41, 0x61)
def A(m):
    """The crowned A: a flat bar over the apex, reaching further to the left, and a crossbar that dips into a V. The
    legs' inner edges meet right under the crown, so the counter is a tall kite between the crown and the V"""
    C, h = m.C, m.hair
    W = m.v(660, 760)
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
                {'bl': m.serif.scaled(1.05), 'br': m.serif.scaled(0.55, 0.7)})
    right = diag((W - r_hw, 0), (W, 0), (ax0 + apex_w - r_hw, C), (ax0 + apex_w, C),
                 {'br': m.serif.scaled(1.05), 'bl': m.serif.scaled(0.55, 0.7)})
    # the crown: a bar on the cap line, longer to the left, its ends cut as wedges
    cl = ax0 - m.v(132, 140)
    cr = ax0 + apex_w + m.v(20, 22)
    wl = min(m.wlen * 0.85, ax0 * (C - hc) / C - cl - 24)
    crown = bar(cl, cr, C - hc, C, left=(0, m.wdrop * 0.95, wl), right=(0, m.wdrop * 0.4, m.wlen * 0.4))
    # the V crossbar: its upper edge leaves the legs at y_side and dips to y_mid in the middle
    hb = h * 0.88
    y_side = m.v(364, 372)
    y_mid = m.v(298, 304)                      # >= 0.40 cap: the counter stays open
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
    return G(shape, W, None, None, top=(lx(C * 0.5) + rx(C * 0.5)) / 2)


@glyph('V', 0x56, 0x76)
def V(m):
    C = m.C
    W = m.v(652, 724)
    vt = m.v(40, 48)    # half the flat at the vertex
    lw = m.thick / math.sin(math.atan2(C, W / 2))
    rw = m.thin / math.sin(math.atan2(C, W / 2))
    y0 = -m.op
    left = diag((W / 2 - lw + vt, y0), (W / 2 + vt, y0), (0, C), (lw, C), {'tl': m.serif, 'tr': m.serif.scaled(0.7)})
    right = diag((W / 2 - vt, y0), (W / 2 - vt + rw, y0), (W - rw, C), (W, C), {'tr': m.serif, 'tl': m.serif.scaled(0.7)})
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
    s1 = diag((v1 - s1w + vt, y0), (v1 + vt, y0), (0, C), (s1w, C), {'tl': m.serif, 'tr': m.serif.scaled(0.6)})
    s2 = diag((v1 - vt, y0), (v1 - vt + s2w, y0), (t2 - s2w / 2, C), (t2 + s2w / 2, C), {'tr': m.serif.scaled(0.6)})
    s3 = diag((v2 - s3w + vt, y0), (v2 + vt, y0), (t3 - s3w / 2, C), (t3 + s3w / 2, C), {'tl': m.serif.scaled(0.6)})
    s4 = diag((v2 - vt, y0), (v2 - vt + s4w, y0), (W - s4w, C), (W, C), {'tr': m.serif, 'tl': m.serif.scaled(0.6)})
    return G(union([s1, s2, s3, s4]), W, None, None)


@glyph('X', 0x58, 0x78)
def X(m):
    C = m.C
    W = m.v(636, 706)
    inset = m.v(34, 40)   # the top is a little narrower than the foot
    thick_w = m.thick / math.sin(math.atan2(C, W - inset))
    thin_w = m.thin * 0.92 / math.sin(math.atan2(C, W - inset))
    down = diag((W - thick_w, 0), (W, 0), (inset / 2, C), (inset / 2 + thick_w, C),
                {'bl': m.serif.scaled(0.8), 'br': m.serif, 'tl': m.serif, 'tr': m.serif.scaled(0.8)})
    up = diag((0, 0), (thin_w, 0), (W - inset / 2 - thin_w, C), (W - inset / 2, C),
              {'bl': m.serif, 'br': m.serif.scaled(0.8), 'tl': m.serif.scaled(0.8), 'tr': m.serif})
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
    left = diag(*lb, {'tl': m.serif, 'tr': m.serif.scaled(0.7)})
    rb = diag_through((cx + s * 0.1, yj - 10), (W - rw / 2, C), m.thin, yj - 120, C)
    right = diag(*rb, {'tr': m.serif, 'tl': m.serif.scaled(0.7)})
    # the arms' outer edges run into the stem's sides: clip what would stick out below
    y_l = lb[0][1] + (lb[2][1] - lb[0][1]) * ((cx - s / 2) - lb[0][0]) / (lb[2][0] - lb[0][0])
    y_r = rb[1][1] + (rb[3][1] - rb[1][1]) * ((cx + s / 2) - rb[1][0]) / (rb[3][0] - rb[1][0])
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
    return G(union([c.path()] + tops), W, m.sp, m.sp)


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
    x_in = edge_x(hook, yt - 1, 'max') if False else s
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
    body = stroke(sp, a, b, knots=[(0, 0.92), (1, 1.0), (2, 1.0), (3, 1.04)], name='2')
    body = diff(body, rect(-200, C * 0.55, a * 0.5, C + 200))
    base = bar(0, W + m.v(6, 8), 0, h, right=(m.wdrop, 0, m.wlen))
    return G(union([body, base]), W, None, None)


@glyph('three', 0x33)
def three(m):
    C, o = m.C, m.o
    W = m.v(530, 590)
    a, b = m.v(60, 92), m.v(46, 68)
    ym = m.v(400, 400)
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
    s1 = stroke(up, a, b, knots=[(0, 0.92), (1, 1.0), (3, 0.92)], name='3a')
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
    st = union([st, polygon([(xs, C * 0.92 - 2), (xs + s, C * 0.92 - 2), (xs + s, C * 0.92 + m.v(30, 36)), (xs, C * 0.92)])])
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
    bowl_ = stroke(sp, a, b, knots=[(0, 0.84), (0.6, 0.96), (1, 1.0), (2, 1.02), (4, 0.92)], name='5')
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
    W = m.v(556, 616)
    return G(rotate180(six_path(m, W), W / 2, m.C / 2), W, None, None)


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
    neck = stroke(sp, a, b, knots=[(0, 1.0), (1, 1.0), (3, 0.98)], name='7')
    neck = diff(neck, rect(-200, -300, W + 200, 0))
    neck = diff(neck, rect(-200, C, W + 200, C + 300))
    foot = stem(xf - a * 0.98, xf + a * 0.98, 0, m.v(130, 140), m.serif, tl=False, tr=False)
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
    """The lozenge interpunct of the inscriptions (HAVDA·ERROTA·SENPERECO, 1652)"""
    dx, dy = m.v(58, 74), m.v(68, 86)
    return G(lozenge(dx, m.C / 2, dx, dy), 2 * dx, m.v(46, 38), m.v(46, 38))


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
        hobby((W - a, C * 0.70), (0, -1), (xs, C * 0.40), (-0.18, -1), tension=1.0),
        line_cubic((xs, C * 0.40), (xs, 2 * dy + m.v(76, 80))),
    ]
    body = stroke(sp, a, b, knots=[(0, 0.92), (1, 1.0), (2, 1.0), (3, 0.92), (4, 0.82)], name='?')
    body = diff(body, rect(-200, C * 0.55, a * 0.5, C + 200))
    return union([body, lozenge(xs, dy - 4, dx, dy)])


@glyph('question', 0x3F)
def question(m):
    W = m.v(470, 530)
    return G(question_path(m, W), W, None, None)


@glyph('questiondown', 0xBF)
def questiondown(m):
    W = m.v(470, 530)
    return G(rotate180(question_path(m, W), W / 2, m.C / 2), W, None, None)


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
    return G(p, W, m.v(56, 46), m.v(24, 18))


@glyph('parenright', 0x29)
def parenright(m):
    p, W = paren_path(m)
    return G(mirror_x(p, W / 2), W, m.v(24, 18), m.v(56, 46))


@glyph('slash', 0x2F)
def slash(m):
    C = m.C
    W = m.v(380, 410)
    t = m.hair * 1.02
    hw = t / math.sin(math.atan2(C + 140, W))
    return G(polygon([(0, -70), (hw, -70), (W, C + 70), (W - hw, C + 70)]), W, m.v(10, 6), m.v(10, 6))


@glyph('ampersand', 0x26)
def ampersand(m):
    C, o = m.C, m.o
    W = m.v(700, 770)
    a, b = m.v(56, 86), m.v(44, 62)
    pts = [
        ((W * 0.90, C * 0.50), (-0.22, -1)),     # the arm's end
        ((W * 0.40, -o + b), (-1, 0)),           # bottom of the bowl
        ((a, C * 0.24), (0, 1)),                 # its left side
        ((W * 0.62 - a * 0.6, C * 0.78), (0, 1)),  # rising through the crossing to the loop's right side
        ((W * 0.40, C + o - b), (-1, 0)),        # the loop's top
        ((W * 0.16 + a * 0.6, C * 0.78), (0, -1)),  # its left side
        ((W * 0.86, b - o * 0.5), (1, -0.02)),   # falling through the crossing to the tail on the baseline
    ]
    sp = [hobby(p, tp, q, tq) for (p, tp), (q, tq) in zip(pts, pts[1:])]
    body = stroke(sp, a, b, knots=[(0, 0.88), (1, 1.0), (2, 1.02), (2.6, 0.92), (3, 0.82), (4, 0.80), (5, 0.84),
                                   (5.6, 1.02), (6, 0.92)], name='&')
    # the arm ends level (cut square)
    body = diff(body, rect(W * 0.70, C * 0.50, W + 200, C * 0.62))
    return G(body, W, None, None)


@glyph('space', 0x20, 0xA0)
def space(m):
    return G(None, 0, 0, 0, adv=m.v(250, 240))


# ---------------------------------------------------------------------------------------------------------------------
# marks (unencoded; used by the accented capitals)


def accent_base(m):
    return m.C + ACCENT_GAP


@glyph('acutecomb.case')
def acute(m):
    y0 = accent_base(m)
    hgt = m.v(144, 150)
    dxs = m.v(118, 128)
    wb, wt = m.v(40, 52), m.v(96, 126)
    p = polygon([(-dxs / 2 - wb / 2, y0), (-dxs / 2 + wb / 2, y0), (dxs / 2 + wt / 2, y0 + hgt), (dxs / 2 - wt / 2, y0 + hgt)])
    return G(p, 0, 0, 0)


@glyph('gravecomb.case')
def grave(m):
    return G(mirror_x(acute(m).path, 0), 0, 0, 0)


@glyph('dieresiscomb.case')
def dieresis(m):
    y0 = accent_base(m)
    dx, dy = m.v(54, 68), m.v(62, 78)
    sep = m.v(104, 120)
    return G(union([lozenge(-sep, y0 + dy, dx, dy), lozenge(sep, y0 + dy, dx, dy)]), 0, 0, 0)


@glyph('tildecomb.case')
def tilde(m):
    y0 = accent_base(m)
    a, b = m.v(34, 44), m.v(34, 44)
    w = m.v(310, 340)
    amp = m.v(44, 46)
    x0 = -w / 2 + a
    sp = [
        hobby((x0, y0 + b + 4), (0.55, 1), (-w * 0.18, y0 + b + amp), (1, 0)),
        hobby((-w * 0.18, y0 + b + amp), (1, 0), (w * 0.18, y0 + b), (1, 0)),
        hobby((w * 0.18, y0 + b), (1, 0), (-x0, y0 + b + amp - 4), (0.55, 1)),
    ]
    return G(stroke(sp, a, b, name='tilde'), 0, 0, 0)


@glyph('cedillacomb')
def cedilla(m):
    a, b = m.v(28, 36), m.v(26, 34)
    sp = [
        line_cubic((0, 20), (0, -40)),
        hobby((0, -40), (0, -1), (m.v(70, 76), -100), (1, -0.15)),
        hobby((m.v(70, 76), -100), (1, -0.15), (-m.v(70, 76), -172), (-1, 0.1)),
    ]
    sp = [hobby((-6, 30), (0.1, -1), (m.v(64, 70), -92), (0.2, -1)),
          hobby((m.v(64, 70), -92), (0.2, -1), (-m.v(70, 76), -176 + b), (-1, -0.05))]
    return G(stroke(sp, a, b, knots=[(0, 1.0), (1, 1.05), (2, 0.86)], name='cedilla'), 0, 0, 0)


# accented capitals: base + mark (name, unicode, base, mark, which anchor)
COMPOSITES = [
    ('Aacute', 0xC1, 'A', 'acutecomb.case'), ('Agrave', 0xC0, 'A', 'gravecomb.case'),
    ('Eacute', 0xC9, 'E', 'acutecomb.case'), ('Egrave', 0xC8, 'E', 'gravecomb.case'),
    ('Iacute', 0xCD, 'I', 'acutecomb.case'),
    ('Oacute', 0xD3, 'O', 'acutecomb.case'), ('Ograve', 0xD2, 'O', 'gravecomb.case'),
    ('Uacute', 0xDA, 'U', 'acutecomb.case'), ('Udieresis', 0xDC, 'U', 'dieresiscomb.case'),
    ('Ntilde', 0xD1, 'N', 'tildecomb.case'),
    ('Ccedilla', 0xC7, 'C', 'cedillacomb'),
]
LOWER = {'Aacute': 0xE1, 'Agrave': 0xE0, 'Eacute': 0xE9, 'Egrave': 0xE8, 'Iacute': 0xED, 'Oacute': 0xF3,
         'Ograve': 0xF2, 'Uacute': 0xFA, 'Udieresis': 0xFC, 'Ntilde': 0xF1, 'Ccedilla': 0xE7}



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