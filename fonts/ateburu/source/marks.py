"""Ateburu's marks: the combining accents, encoded with zero width and drawn where they sit on a capital (the face
has no lowercase, so there is only the capital form), and their spacing forms.

Top marks stand ACCENT_GAP above the cap line, centred on x = 0, and attach to a letter's top anchor; bottom marks
(cedilla, comma below) hang from the baseline under the bottom anchor; the ogonek hangs from its own anchor at the
letter's lower right. They are kept compact and heavy enough to survive 12 px light-on-dark: wedges cut like the
serifs, lozenge dots like the interpunct.
"""
import math

from geometry import Contour, add, hobby, mirror_x, polygon, rect, ring, stroke, union
from glyphs import ACCENT_GAP, CAP, COMPOSITES, GLYPHS, G, accent_base, lozenge

# name -> anchor class: 'top', 'bottom' or 'ogonek'
MARK_CLASS = {}
# the stacking gap between two top marks
MKMK_GAP = 40


def mark(name, uni, cls):
    def deco(fn):
        GLYPHS[name] = ([uni] if uni else [], fn)
        MARK_CLASS[name] = cls
        return fn
    return deco


def wedge_stroke(p, q, wb, wt):
    """A straight stroke from p (bottom) to q (top) that widens from wb to wt, cut level at both ends (an accent cut
    with one stab of the chisel)"""
    return polygon([(p[0] - wb / 2, p[1]), (p[0] + wb / 2, p[1]), (q[0] + wt / 2, q[1]), (q[0] - wt / 2, q[1])])


@mark('acutecomb', 0x0301, 'top')
def acute(m):
    y0 = accent_base(m)
    hgt = m.v(144, 150)
    dxs = m.v(118, 128)
    wb, wt = m.v(40, 52), m.v(96, 126)
    return G(wedge_stroke((-dxs / 2, y0), (dxs / 2, y0 + hgt), wb, wt), 0, 0, 0)


@mark('gravecomb', 0x0300, 'top')
def grave(m):
    return G(mirror_x(acute(m).path, 0), 0, 0, 0)


@mark('hungarumlautcomb', 0x030B, 'top')
def hungarumlaut(m):
    y0 = accent_base(m)
    hgt = m.v(140, 146)
    dxs = m.v(84, 92)
    wb, wt = m.v(34, 44), m.v(78, 100)
    sep = m.v(84, 100)
    return G(union([wedge_stroke((-sep - dxs / 2, y0), (-sep + dxs / 2, y0 + hgt), wb, wt),
                    wedge_stroke((sep - dxs / 2, y0), (sep + dxs / 2, y0 + hgt), wb, wt)]), 0, 0, 0)


def chevron(m, up=True):
    """The circumflex (up) or caron (down): two wedge strokes meeting in a flat-cut point"""
    y0 = accent_base(m)
    h = m.v(132, 140)
    w = m.v(296, 328)
    t = m.v(86, 112)                 # each arm's horizontal width at its foot
    tip = m.v(46, 60)                # the flat cut at the point
    pts = [(-w / 2, y0), (-w / 2 + t, y0), (0, y0 + h - t * 0.9), (w / 2 - t, y0), (w / 2, y0),
           (tip / 2, y0 + h), (-tip / 2, y0 + h)]
    if not up:
        pts = [(x, 2 * y0 + h - y) for x, y in pts]
        pts.reverse()
    return polygon(pts)


@mark('circumflexcomb', 0x0302, 'top')
def circumflex(m):
    return G(chevron(m, True), 0, 0, 0)


@mark('caroncomb', 0x030C, 'top')
def caron(m):
    return G(chevron(m, False), 0, 0, 0)


@mark('tildecomb', 0x0303, 'top')
def tilde(m):
    """A flat, compact tilde, heavy enough to survive at 12 px on a dark panel"""
    y0 = accent_base(m)
    a, b = m.v(44, 54), m.v(42, 52)
    w = m.v(330, 366)
    amp = m.v(46, 46)
    x0 = -w / 2 + a
    sp = [
        hobby((x0, y0 + b + 2), (0.55, 1), (-w * 0.17, y0 + b + amp), (1, 0)),
        hobby((-w * 0.17, y0 + b + amp), (1, 0), (w * 0.17, y0 + b), (1, 0)),
        hobby((w * 0.17, y0 + b), (1, 0), (-x0, y0 + b + amp - 2), (0.55, 1)),
    ]
    return G(stroke(sp, a, b, knots=[(0, 0.9), (1, 1.0), (2, 1.0), (3, 0.9)], name='tilde', fine=2), 0, 0, 0)


@mark('macroncomb', 0x0304, 'top')
def macron(m):
    y0 = accent_base(m) + m.v(16, 14)
    w = m.v(290, 320)
    t = m.v(80, 104)
    return G(rect(-w / 2, y0, w / 2, y0 + t), 0, 0, 0)


@mark('brevecomb', 0x0306, 'top')
def breve(m):
    y0 = accent_base(m)
    a, b = m.v(42, 54), m.v(36, 46)
    w, h = m.v(280, 308), m.v(122, 128)
    sp = [hobby((-w / 2 + a, y0 + h), (0.08, -1), (0, y0 + b), (1, 0)),
          hobby((0, y0 + b), (1, 0), (w / 2 - a, y0 + h), (-0.08, 1))]
    shape = stroke(sp, a, b, knots=[(0, 0.86), (1, 1.04), (2, 0.86)], name='breve')
    return G(shape, 0, 0, 0)


@mark('dotaccentcomb', 0x0307, 'top')
def dotaccent(m):
    y0 = accent_base(m)
    dx, dy = m.v(58, 72), m.v(66, 82)
    return G(lozenge(0, y0 + dy, dx, dy), 0, 0, 0)


@mark('dieresiscomb', 0x0308, 'top')
def dieresis(m):
    y0 = accent_base(m)
    dx, dy = m.v(54, 68), m.v(62, 78)
    sep = m.v(104, 120)
    return G(union([lozenge(-sep, y0 + dy, dx, dy), lozenge(sep, y0 + dy, dx, dy)]), 0, 0, 0)


@mark('ringcomb', 0x030A, 'top')
def ringmark(m):
    y0 = accent_base(m) - 6
    r = m.v(80, 88)
    return G(ring(0, y0 + r, r * 1.04, r, m.v(36, 48), m.v(32, 42)), 0, 0, 0)


@mark('cedillacomb', 0x0327, 'bottom')
def cedilla(m):
    """A cedilla cut like a hook: it leaves the letter's foot plumb, swings right and comes back under itself in a
    flat, tapering tail (redrawn for 0.200: the old one's bowl was too round and its tail too thin at 900)"""
    a, b = m.v(34, 44), m.v(30, 38)
    r = m.v(64, 74)
    k = m.c
    sp = [
        hobby((0, 40), (0, -1), (r * 0.62, -84), (1, -0.25)),
        hobby((r * 0.62, -84), (1, -0.25), (r * 0.30, -150 - 6 * k), (-1, -0.55)),
        hobby((r * 0.30, -150 - 6 * k), (-1, -0.55), (-m.v(64, 70), -176 + b * 0.8), (-1, 0.08)),
    ]
    return G(stroke(sp, a, b, knots=[(0, 1.02), (1, 1.08), (2, 1.0), (3, 0.78)], name='cedilla', fine=4), 0, 0, 0)


@mark('commaaccentcomb', 0x0326, 'bottom')
def commaaccent(m):
    """The comma below (Ș Ț Ģ Ķ Ļ Ņ): the comma's lozenge head and tail, smaller, under the baseline"""
    dx, dy = m.v(46, 58), m.v(52, 64)
    cy = -m.v(70, 72) - dy
    head = lozenge(0, cy, dx, dy)
    tail = polygon([(dx * 0.62, cy - dy * 0.38), (-dx * 0.62, cy - dy - m.v(92, 96)),
                    (-dx * 0.86, cy - dy - m.v(84, 88)), (-dx * 0.30, cy - dy * 0.70)])
    return G(union([head, tail]), 0, 0, 0)


@mark('ogonekcomb', 0x0328, 'ogonek')
def ogonek(m):
    """A hook hanging from the letter's lower right: down and in, then out to a tapering tip"""
    a, b = m.v(36, 46), m.v(32, 40)
    k = m.c
    sp = [
        hobby((0, 36), (-0.18, -1), (-m.v(46, 52), -96), (0.05, -1)),
        hobby((-m.v(46, 52), -96), (0.05, -1), (m.v(40, 46) + 6 * k, -172), (1, 0.12)),
    ]
    return G(stroke(sp, a, b, knots=[(0, 1.04), (1, 1.0), (2, 0.66)], name='ogonek', fine=2), 0, 0, 0)


@mark('caroncomb.alt', None, 'caron')
def caron_alt(m):
    """The caron of Ľ (Slovak), written beside the stem as an apostrophe; it attaches to the letter's caron anchor"""
    dx, dy = m.v(50, 62), m.v(58, 72)
    cy = CAP - dy + 6
    head = lozenge(0, cy, dx, dy)
    tail = polygon([(dx * 0.62, cy - dy * 0.38), (-dx * 0.62, cy - dy - m.v(112, 118)),
                    (-dx * 0.86, cy - dy - m.v(104, 108)), (-dx * 0.30, cy - dy * 0.70)])
    return G(union([head, tail]), 0, 0, 0)


# the spacing forms: the mark alone in a glyph of its own width (composites, placed by build.py)
SPACING = [('acute', 0xB4, 'acutecomb'), ('grave', 0x60, 'gravecomb'), ('circumflex', 0x2C6, 'circumflexcomb'),
           ('caron', 0x2C7, 'caroncomb'), ('tilde', 0x2DC, 'tildecomb'), ('macron', 0xAF, 'macroncomb'),
           ('breve', 0x2D8, 'brevecomb'), ('dotaccent', 0x2D9, 'dotaccentcomb'), ('dieresis', 0xA8, 'dieresiscomb'),
           ('ring', 0x2DA, 'ringcomb'), ('hungarumlaut', 0x2DD, 'hungarumlautcomb'), ('cedilla', 0xB8, 'cedillacomb'),
           ('ogonek', 0x2DB, 'ogonekcomb')]
for _name, _uni, _mark in SPACING:
    COMPOSITES.append((_name, [_uni], None, _mark, 'spacing'))
