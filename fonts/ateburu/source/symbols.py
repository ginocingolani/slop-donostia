"""Ateburu's symbols and the rest of the punctuation: what GF Latin Core asks for beyond the letters.

The face is all capitals, so everything is centred on the capitals: brackets, braces and bars span the cap height
with the parentheses' overhang, the maths signs and guillemets sit on the hyphen's axis (y = 352), the asterisk and
degree sign hang from the cap line. Strokes take the face's weights (hair for horizontals, a lighter stem for
verticals) and its cut ends: wedges where a stroke ends free, lozenges for dots.
"""
import math

from geometry import (Contour, bar, diag, diag_through, diff, hobby, inter, mirror_x, oval, polygon, rect, ring, shift,
                      stroke, transform, union, unit)
import glyphs as Gl
from glyphs import CAP, COMPOSITES, G, glyph, lozenge

AXIS = 352          # the maths axis: the hyphen's middle


def scaled(path, k, cx, cy, x, y):
    """path scaled by k about (cx, cy), then moved so that (cx, cy) lands on (x, y)"""
    return transform(path, lambda p: (x + (p[0] - cx) * k, y + (p[1] - cy) * k))


def hbar_(m, x0, x1, y, t=None):
    t = m.hair * 0.96 if t is None else t
    return rect(x0, y - t / 2, x1, y + t / 2)


def vbar_(m, x, y0, y1, t=None):
    t = m.stem * 0.78 if t is None else t
    return rect(x - t / 2, y0, x + t / 2, y1)


# ---------------------------------------------------------------------------------------------------------------------
# maths


def math_w(m):
    return m.v(470, 510)


@glyph('plus', 0x2B)
def plus(m):
    W = math_w(m)
    t = m.hair * 0.96
    return G(union([hbar_(m, 0, W, AXIS), vbar_(m, W / 2, AXIS - W / 2, AXIS + W / 2, t * 1.12)]), W, m.v(56, 46),
             m.v(56, 46))


@glyph('minus', 0x2212)
def minus(m):
    W = math_w(m)
    return G(hbar_(m, 0, W, AXIS), W, m.v(56, 46), m.v(56, 46))


@glyph('equal', 0x3D)
def equal(m):
    W = math_w(m)
    gap = m.v(86, 80)
    t = m.hair * 0.9
    return G(union([hbar_(m, 0, W, AXIS + (gap + t) / 2, t), hbar_(m, 0, W, AXIS - (gap + t) / 2, t)]), W,
             m.v(56, 46), m.v(56, 46))


@glyph('multiply', 0xD7)
def multiply(m):
    W = math_w(m) * 0.82
    t = m.hair * 1.02
    a = diag(*diag_through((0, AXIS - W / 2), (W, AXIS + W / 2), t, AXIS - W / 2, AXIS + W / 2))
    b = diag(*diag_through((W, AXIS - W / 2), (0, AXIS + W / 2), t, AXIS - W / 2, AXIS + W / 2))
    return G(union([a, b]), W, m.v(70, 60), m.v(70, 60))


@glyph('divide', 0xF7)
def divide(m):
    W = math_w(m)
    dx, dy = m.v(54, 66), m.v(62, 76)
    off = m.v(150, 160)
    return G(union([hbar_(m, 0, W, AXIS), lozenge(W / 2, AXIS + off, dx, dy), lozenge(W / 2, AXIS - off, dx, dy)]),
             W, m.v(56, 46), m.v(56, 46))


def chevron_path(m, w, h, t, x0=0, y=AXIS, point_left=True):
    """An angle bracket w wide and h high: two strokes of horizontal width t meeting in a point cut flat. The outer
    edges run from the point to the ends' outer corners; the inner edges are the outer ones moved t to the right"""
    c = t * 0.22                       # half the flat cut at the point
    pts = [(x0 + w - t, y + h / 2), (x0, y + c), (x0, y - c), (x0 + w - t, y - h / 2), (x0 + w, y - h / 2),
           (x0 + t, y), (x0 + w, y + h / 2)]
    p = polygon(pts)
    return p if point_left else mirror_x(p, x0 + w / 2)


@glyph('less', 0x3C)
def less(m):
    W = math_w(m) * 0.86
    return G(chevron_path(m, W, W * 1.04, m.v(118, 156)), W, m.v(60, 50), m.v(60, 50))


@glyph('greater', 0x3E)
def greater(m):
    W = math_w(m) * 0.86
    return G(chevron_path(m, W, W * 1.04, m.v(118, 156), point_left=False), W, m.v(60, 50), m.v(60, 50))


@glyph('asciicircum', 0x5E)
def asciicircum(m):
    W = m.v(440, 470)
    h = m.v(300, 310)
    t = m.v(110, 146)
    y0 = CAP - h
    pts = [(0, y0), (t, y0), (W / 2, CAP - t * 1.25), (W - t, y0), (W, y0), (W / 2 + t * 0.32, CAP), (W / 2 - t * 0.32, CAP)]
    return G(polygon(pts), W, m.v(40, 34), m.v(40, 34))


@glyph('asciitilde', 0x7E)
def asciitilde(m):
    W = math_w(m)
    a, b = m.v(52, 66), m.v(46, 58)
    amp = m.v(52, 54)
    x0 = a
    sp = [
        hobby((x0, AXIS - amp * 0.5), (0.5, 1), (W * 0.32, AXIS + amp * 0.5), (1, 0)),
        hobby((W * 0.32, AXIS + amp * 0.5), (1, 0), (W * 0.68, AXIS - amp * 0.5), (1, 0)),
        hobby((W * 0.68, AXIS - amp * 0.5), (1, 0), (W - x0, AXIS + amp * 0.5), (0.5, 1)),
    ]
    return G(stroke(sp, a, b, knots=[(0, 0.92), (1, 1.0), (2, 1.0), (3, 0.92)], name='~'), W, m.v(50, 42), m.v(50, 42))


@glyph('underscore', 0x5F)
def underscore(m):
    W = m.v(520, 540)
    t = m.hair * 0.86
    return G(rect(0, -150, W, -150 + t), W, 0, 0)


@glyph('bar', 0x7C)
def bar_glyph(m):
    t = m.stem * 0.78
    return G(rect(0, -110, t, CAP + 110), t, m.v(90, 80), m.v(90, 80))


@glyph('backslash', 0x5C)
def backslash(m):
    return G(mirror_x(Gl.slash(m).path, Gl.slash(m).w / 2), Gl.slash(m).w, m.v(10, 6), m.v(10, 6))


# ---------------------------------------------------------------------------------------------------------------------
# brackets and braces


def bracket_path(m):
    s = m.stem * 0.84
    h = m.hair * 0.92
    W = m.v(196, 222)
    yb, yt = -90, CAP + 90
    return union([rect(0, yb, s, yt), bar(s / 2, W, yt - h, yt, right=(0, m.wdrop * 0.7, m.wlen * 0.6)),
                  bar(s / 2, W, yb, yb + h, right=(m.wdrop * 0.7, 0, m.wlen * 0.6))]), W


@glyph('bracketleft', 0x5B)
def bracketleft(m):
    p, W = bracket_path(m)
    return G(p, W, m.v(70, 60), m.v(30, 26))


@glyph('bracketright', 0x5D)
def bracketright(m):
    p, W = bracket_path(m)
    return G(mirror_x(p, W / 2), W, m.v(30, 26), m.v(70, 60))


def brace_path(m):
    a, b = m.v(48, 72), m.v(40, 58)
    W = m.v(250, 280)
    yt, yb, ym = CAP + 90, -90, CAP / 2
    xm = a * 0.6                      # the point
    xs = W * 0.52                     # the vertical runs
    sp_top = [
        hobby((W - a * 0.3, yt - b), (-1, 0), (xs, yt - b * 2.6), (0, -1)),
        hobby((xs, yt - b * 2.6), (0, -1), (xs, ym + b * 2.2), (0, -1)),
        hobby((xs, ym + b * 2.2), (0, -1), (xm, ym), (-1, -0.35)),
    ]
    top = stroke(sp_top, a, b, knots=[(0, 0.8), (1, 1.0), (2, 1.0), (3, 0.82)], name='{')
    bottom = transform(top, lambda p: (p[0], 2 * ym - p[1]))
    return union([top, bottom]), W


@glyph('braceleft', 0x7B)
def braceleft(m):
    p, W = brace_path(m)
    return G(p, W, m.v(50, 42), m.v(26, 22))


@glyph('braceright', 0x7D)
def braceright(m):
    p, W = brace_path(m)
    return G(mirror_x(p, W / 2), W, m.v(26, 22), m.v(50, 42))


# ---------------------------------------------------------------------------------------------------------------------
# signs


@glyph('numbersign', 0x23)
def numbersign(m):
    W = m.v(560, 600)
    y0, y1 = m.v(40, 30), CAP - m.v(40, 30)
    t_v = m.stem * 0.70
    t_h = m.hair * 0.86
    slant = m.v(60, 64)
    xa, xb = W * 0.34, W * 0.66
    parts = []
    for x in (xa, xb):
        parts.append(polygon([(x - slant / 2 - t_v / 2, y0), (x - slant / 2 + t_v / 2, y0),
                              (x + slant / 2 + t_v / 2, y1), (x + slant / 2 - t_v / 2, y1)]))
    for y in (CAP * 0.33, CAP * 0.66):
        parts.append(hbar_(m, W * 0.06, W * 0.94, y, t_h))
    return G(union(parts), W, None, None)


@glyph('dollar', 0x24)
def dollar(m):
    S = Gl.S(m)
    t = m.v(64, 86)
    return G(union([S.path, rect(S.w / 2 - t / 2, -110, S.w / 2 + t / 2, CAP + 110)]), S.w, None, None)


@glyph('percent', 0x25)
def percent(m):
    W = m.v(700, 760)
    r_x, r_y = m.v(126, 140), m.v(150, 160)
    side, top = m.v(56, 80), m.v(48, 66)
    o1 = ring(r_x, CAP - r_y, r_x, r_y, side, top)
    o2 = ring(W - r_x, r_y, r_x, r_y, side, top)
    t = m.hair * 1.0
    sl = diag(*diag_through((W * 0.16, 0), (W * 0.84, CAP), t, 0, CAP))
    return G(union([o1, o2, sl]), W, None, None)


@glyph('asterisk', 0x2A)
def asterisk(m):
    """Six tapering spokes, cut like the accents, hanging from the cap line"""
    r = m.v(166, 176)
    cx, cy = r, CAP - r * 0.95
    wb, wt = m.v(34, 44), m.v(86, 112)
    spokes = []
    for k in range(6):
        ang = math.pi / 2 + k * math.pi / 3
        d = (math.cos(ang), math.sin(ang))
        n = (-d[1], d[0])
        p0 = (cx + d[0] * 6, cy + d[1] * 6)
        p1 = (cx + d[0] * r, cy + d[1] * r)
        spokes.append(polygon([(p0[0] + n[0] * wb / 2, p0[1] + n[1] * wb / 2), (p1[0] + n[0] * wt / 2, p1[1] + n[1] * wt / 2),
                               (p1[0] - n[0] * wt / 2, p1[1] - n[1] * wt / 2), (p0[0] - n[0] * wb / 2, p0[1] - n[1] * wb / 2)]))
    spokes.append(lozenge(cx, cy, wb * 0.9, wb * 0.9))
    return G(union(spokes), 2 * r, m.v(40, 34), m.v(40, 34))


@glyph('at', 0x40)
def at(m):
    R = m.v(392, 404)
    cx, cy = R, m.v(300, 304)
    a, b = m.v(48, 70), m.v(42, 60)
    ri_x, ri_y = m.v(126, 128), m.v(150, 146)
    xi = cx - ri_x * 0.05
    stem_x = xi + ri_x + a * 0.1
    sp = [
        line_(stem_x, cy + ri_y + b * 0.4, stem_x, cy - ri_y * 0.55),
        hobby((stem_x, cy - ri_y * 0.55), (0, -1), (cx + R * 0.66, cy - ri_y * 0.62), (0.4, 1)),
        hobby((cx + R * 0.66, cy - ri_y * 0.62), (0.4, 1), (cx + R - a, cy + R * 0.12), (0, 1)),
        hobby((cx + R - a, cy + R * 0.12), (0, 1), (cx, cy + R - b), (-1, 0)),
        hobby((cx, cy + R - b), (-1, 0), (cx - R + a, cy), (0, -1)),
        hobby((cx - R + a, cy), (0, -1), (cx, cy - R + b), (1, 0)),
        hobby((cx, cy - R + b), (1, 0), (cx + R * 0.44, cy - R * 0.93), (1, 0.22)),
    ]
    outer = stroke(sp, a, b, knots=[(0, 1.0), (1, 1.0), (2, 0.92), (4, 1.0), (6, 1.0), (7, 0.86)], name='@')
    inner = ring(xi, cy, ri_x, ri_y, m.v(50, 74), m.v(44, 62))
    return G(union([outer, inner]), 2 * R, None, None)


def line_(x0, y0, x1, y1):
    from geometry import line_cubic
    return line_cubic((x0, y0), (x1, y1))


@glyph('cent', 0xA2)
def cent(m):
    W = m.v(560, 620)
    C = Gl.c_shape(m, W, xt=W * m.v(0.735, 0.645), xb=W * m.v(0.770, 0.685))
    C = scaled(C, 0.80, W / 2, CAP / 2, W * 0.44, CAP / 2)
    t = m.v(60, 82)
    return G(union([C, rect(W * 0.44 - t / 2, -80, W * 0.44 + t / 2, CAP + 80)]), W * 0.88, None, None)


@glyph('sterling', 0xA3)
def sterling(m):
    W = m.v(560, 616)
    a, b = m.v(60, 92), m.v(46, 68)
    h = m.hair
    o = m.o
    k = m.c
    sp = [
        hobby((W - a * 0.95, CAP * 0.74), (-0.1, 1), (W * 0.58, CAP + o - b), (-1, 0)),
        hobby((W * 0.58, CAP + o - b), (-1, 0), (W * 0.26, CAP * 0.70), (0, -1)),
        hobby((W * 0.26, CAP * 0.70), (0, -1), (W * 0.24, CAP * 0.30), (-0.05, -1)),
        hobby((W * 0.24, CAP * 0.30), (-0.05, -1), (a * 0.6, h * 0.6), (-0.7, -1)),
    ]
    neck = stroke(sp, a, b, knots=[(0, 0.88), (1, 1.0), (2, 1.04), (3, 1.0), (4, 1.0)], name='£')
    neck = diff(neck, rect(W - a * 0.4, CAP * 0.55, W + 200, CAP + 200))
    base = bar(0, W, 0, h, right=(m.wdrop, 0, m.wlen), bend=Gl.arm(m, 0, m.v(8, 10)))
    cross = bar(W * 0.02, W * 0.62, CAP * 0.42 - h * 0.45, CAP * 0.42 + h * 0.45,
                left=(m.wdrop * 0.4, m.wdrop * 0.4, m.wlen * 0.5), right=(m.wdrop * 0.4, m.wdrop * 0.4, m.wlen * 0.5))
    return G(inter(union([neck, base, cross]), rect(-200, -2, W + 200, CAP + 200)), W, None, None)


@glyph('yen', 0xA5)
def yen(m):
    Y = Gl.Y(m)
    W = Y.w
    t = m.hair * 0.84
    bars = [hbar_(m, W * 0.18, W * 0.82, CAP * 0.30, t), hbar_(m, W * 0.18, W * 0.82, CAP * 0.30 + t + m.v(46, 40), t)]
    return G(union([Y.path] + bars), W, None, None)


@glyph('Euro', 0x20AC)
def euro(m):
    W = m.v(640, 700)
    C = Gl.c_shape(m, W, xt=W * m.v(0.735, 0.645), xb=W * m.v(0.770, 0.685))
    t = m.hair * 0.76
    xl = -m.v(70, 80)
    yh, yl = CAP * m.v(0.60, 0.62), CAP * m.v(0.39, 0.37)
    bars = [bar(xl, W * 0.56, yh - t / 2, yh + t / 2, left=(m.wdrop * 0.3, m.wdrop * 0.3, m.wlen * 0.5)),
            bar(xl, W * 0.50, yl - t / 2, yl + t / 2, left=(m.wdrop * 0.3, m.wdrop * 0.3, m.wlen * 0.5))]
    return G(union([C] + bars), W, None, None)


@glyph('section', 0xA7)
def section(m):
    """A ring in the middle, a hook above it that comes over the top and down the left into the ring, and the same
    hook turned round below. It drops below the baseline, as the sign usually does, so the three bowls have room"""
    W = m.v(430, 470)
    a, b = m.v(44, 62), m.v(36, 48)
    o = m.o
    yb, yt = -m.v(96, 100), CAP + o
    H = yt - yb
    cy = yb + H / 2
    rx, ry = W / 2 - a, H * 0.165
    ring_sp = [
        hobby((W / 2, cy + ry), (1, 0), (W - a, cy), (0, -1)),
        hobby((W - a, cy), (0, -1), (W / 2, cy - ry), (-1, 0)),
        hobby((W / 2, cy - ry), (-1, 0), (a, cy), (0, 1)),
        hobby((a, cy), (0, 1), (W / 2, cy + ry), (1, 0)),
    ]
    ring_ = stroke(ring_sp, a, b, knots=[(0, 0.92), (1, 1.0), (2, 0.92), (3, 1.0), (4, 0.92)], name='§ ring')
    hook = [
        hobby((W - a * 0.95, yb + 0.88 * H), (-0.15, 1), (W * 0.50, yt - b), (-1, 0)),
        hobby((W * 0.50, yt - b), (-1, 0), (a, yb + 0.78 * H), (0, -1)),
        hobby((a, yb + 0.78 * H), (0, -1), (a * 1.1, cy + ry * 0.15), (0, -1)),
    ]
    h1 = stroke(hook, a, b, knots=[(0, 0.84), (1, 1.0), (2, 1.0), (3, 1.0)], name='§ hook')
    h1 = diff(h1, rect(W - a * 0.45, yb + 0.66 * H, W + 200, yt + 200))
    h2 = transform(h1, lambda p: (W - p[0], 2 * cy - p[1]))
    return G(union([ring_, h1, h2]), W, None, None)


@glyph('paragraph', 0xB6)
def paragraph(m):
    W = m.v(500, 540)
    t = m.stem * 0.72
    h = m.hair * 0.9
    x1, x2 = W * 0.52, W - t
    bowl = inter(oval(x1, CAP * 0.72, x1, CAP * 0.28 + 1, 0.56), rect(-10, CAP * 0.40, x1 + 1, CAP + 10))
    return G(union([bowl, rect(x1 - 1, 0, x1 + t, CAP), rect(x2, 0, x2 + t, CAP), rect(x1, CAP - h, x2 + t, CAP)]),
             W, None, None)


@glyph('degree', 0xB0)
def degree(m):
    r = m.v(112, 118)
    return G(ring(r, CAP - r, r, r, m.v(40, 52), m.v(36, 48)), 2 * r, m.v(50, 42), m.v(50, 42))


@glyph('bullet', 0x2022)
def bullet(m):
    dx, dy = m.v(92, 108), m.v(110, 128)
    return G(lozenge(dx, AXIS, dx, dy), 2 * dx, m.v(60, 50), m.v(60, 50))


@glyph('ellipsis', 0x2026)
def ellipsis(m):
    dx, dy = Gl.dot_size(m)
    gap = m.v(70, 62)
    dots = [lozenge(dx + k * (2 * dx + gap), dy - 4, dx, dy) for k in range(3)]
    return G(union(dots), 6 * dx + 2 * gap, m.v(46, 38), m.v(46, 38))


@glyph('quotedblbase', 0x201E)
def quotedblbase(m):
    dx, dy = Gl.dot_size(m)
    gap = m.v(40, 44)
    one_ = Gl.comma_shape(m, dy - 4)
    return G(union([one_, shift(one_, 2 * dx + gap, 0)]), 4 * dx + gap, m.v(46, 38), m.v(46, 38))


COMPOSITES.append(('quotesinglbase', [0x201A], 'comma', None, None))


# ---------------------------------------------------------------------------------------------------------------------
# guillemets: chevrons on the maths axis, the size of the capitals' middle


def guil(m, n, point_left):
    w = m.v(200, 222)
    h = m.v(300, 320)
    t = m.v(104, 136)
    step = t + m.v(58, 50)
    parts = [chevron_path(m, w, h, t, x0=k * step, point_left=point_left) for k in range(n)]
    return union(parts), w + step * (n - 1)


@glyph('guillemetleft', 0xAB)
def guillemetleft(m):
    p, W = guil(m, 2, True)
    return G(p, W, m.v(44, 36), m.v(44, 36))


@glyph('guillemetright', 0xBB)
def guillemetright(m):
    p, W = guil(m, 2, False)
    return G(p, W, m.v(44, 36), m.v(44, 36))


@glyph('guilsinglleft', 0x2039)
def guilsinglleft(m):
    p, W = guil(m, 1, True)
    return G(p, W, m.v(44, 36), m.v(44, 36))


@glyph('guilsinglright', 0x203A)
def guilsinglright(m):
    p, W = guil(m, 1, False)
    return G(p, W, m.v(44, 36), m.v(44, 36))


# ---------------------------------------------------------------------------------------------------------------------
# small capitals inside or above: © ® ª º ™


def ring_frame(m, R):
    return ring(R, CAP / 2, R, R, m.v(46, 60), m.v(42, 56))


@glyph('copyright', 0xA9)
def copyright(m):
    R = m.v(392, 404)
    Cw = m.v(646, 726)
    C = Gl.c_shape(m, Cw, xt=Cw * m.v(0.735, 0.645), xb=Cw * m.v(0.770, 0.685))
    return G(union([ring_frame(m, R), scaled(C, 0.46, Cw / 2, CAP / 2, R, CAP / 2)]), 2 * R, None, None)


@glyph('registered', 0xAE)
def registered(m):
    R = m.v(392, 404)
    Rg = Gl.R(m)
    return G(union([ring_frame(m, R), scaled(Rg.path, 0.46, Rg.w * 0.55, CAP / 2, R, CAP / 2)]), 2 * R, None, None)


def ordinal(m, glyph_fn, w):
    g = glyph_fn(m)
    k = 0.52
    letter = scaled(g.path, k, 0, CAP, 0, CAP)
    line = rect(0, CAP * (1 - k) - m.v(110, 112), g.w * k, CAP * (1 - k) - m.v(110, 112) + m.hair * 0.66)
    return G(union([letter, line]), g.w * k, m.v(44, 36), m.v(44, 36))


@glyph('ordfeminine', 0xAA)
def ordfeminine(m):
    return ordinal(m, Gl.A, None)


@glyph('ordmasculine', 0xBA)
def ordmasculine(m):
    return ordinal(m, Gl.O, None)


@glyph('trademark', 0x2122)
def trademark(m):
    k = 0.44
    T, M = Gl.T(m), Gl.M(m)
    gap = m.v(40, 34)
    t = scaled(T.path, k, 0, CAP, 0, CAP)
    mm = scaled(M.path, k, 0, CAP, T.w * k + gap, CAP)
    return G(union([t, mm]), (T.w + M.w) * k + gap, m.v(40, 34), m.v(40, 34))
