"""Ateburu's alternates, reached through OpenType features (see features.py):

calt   A with its crown's long end to the right after T, V, W, Y; R and K with short legs before A, T, V, W, Y, J
ss02   a small o, tucked after L, T, K and R
ss04   Roman forms: an A without the crown, R with a straight leg, the plain inscription K
ss05   plain figures for numeric use: a closed 4, a straight 7, a 5 without the wedge
ss06   curiosities of the stones: 8 for G, reversed N S D E, the barred I, V for U (and Ꝑ, encoded as itself)
tnum   tabular figures
"""
import math

from geometry import bar, diag, diag_through, diff, mirror_x, polygon, rect, ring, stem, union
import glyphs as Gl
from glyphs import CAP, COMPOSITES, G, glyph

# ---------------------------------------------------------------------------------------------------------------------
# calt


@glyph('A.r')
def A_r(m):
    return Gl.A(m, flag='r')


@glyph('R.short')
def R_short(m):
    return Gl.r_glyph(m, 'short')


@glyph('K.short')
def K_short(m):
    return Gl.K(m, short=True)


@glyph('K.straight.short')
def K_straight_short(m):
    return Gl.K_straight(m, short=True)


def alt_composites(base, alt, suffix):
    """Accented forms of an alternate: every composite built on `base`, rebuilt on `alt`"""
    out = []
    for name, unis, b, mark, place in list(COMPOSITES):
        if b == base and mark:
            out.append((name + suffix, [], alt, mark, place))
    COMPOSITES.extend(out)
    return [o[0] for o in out]


A_R_COMPOSITES = alt_composites('A', 'A.r', '.r')
R_SHORT_COMPOSITES = alt_composites('R', 'R.short', '.short')
K_SHORT_COMPOSITES = alt_composites('K', 'K.short', '.short')


# ---------------------------------------------------------------------------------------------------------------------
# ss04: Roman forms


@glyph('A.roman')
def A_roman(m):
    """A Roman A for long labels: the legs meet in a narrow flat apex, the crossbar is straight"""
    C, h, op = m.C, m.hair, m.op
    W = m.v(660, 780)
    thin, thick = m.thin * 0.92, m.thick * 0.96
    apex = m.v(54, 72)
    xa = W / 2 - apex / 2
    l_hw = thin / math.sin(math.atan2(C, xa))
    r_hw = thick / math.sin(math.atan2(C, W - (xa + apex)))
    left = diag((0, 0), (l_hw, 0), (xa, C + op), (xa + l_hw, C + op),
                {'bl': m.serif.scaled(1.05), 'br': m.serif.scaled(0.55, 0.7)}, bend=Gl.bow(m, 9))
    right = diag((W - r_hw, 0), (W, 0), (xa + apex - r_hw, C + op), (xa + apex, C + op),
                 {'br': m.serif.scaled(1.05), 'bl': m.serif.scaled(0.55, 0.7)}, bend=Gl.bow(m, -9))
    yc = m.v(232, 226)
    hb = h * 0.88

    def lx(y):
        return l_hw + xa * y / (C + op)

    def rx(y):
        return (W - r_hw) + ((xa + apex - r_hw) - (W - r_hw)) * y / (C + op)
    cross = rect(lx(yc + hb) - 20, yc, rx(yc + hb) + 20, yc + hb)
    return G(union([left, right, cross]), W, None, None, top=W / 2, ogonek=W - r_hw * 0.5)


@glyph('R.roman')
def R_roman(m):
    return Gl.r_glyph(m, 'roman')


A_ROMAN_COMPOSITES = alt_composites('A', 'A.roman', '.roman')
R_ROMAN_COMPOSITES = alt_composites('R', 'R.roman', '.roman')
K_ROMAN_COMPOSITES = alt_composites('K', 'K.roman', '.roman')


# ---------------------------------------------------------------------------------------------------------------------
# ss02: the small o


@glyph('o.small')
def o_small(m):
    """A small O, as the stones tuck one after an open letter: centred on the middle of the capitals"""
    W = m.v(392, 432)
    ry = CAP * 0.29
    return G(ring(W / 2, CAP * 0.48, W / 2, ry, m.rside * 0.82, m.rtop * 0.84, k_out=0.585, k_in=0.56), W, None, None)


# ---------------------------------------------------------------------------------------------------------------------
# ss05: plain figures


@glyph('four.ss05')
def four_ss05(m):
    """A closed 4: the diagonal runs into the stem's top"""
    C, s, h = m.C, m.stem, m.hair
    W = m.v(600, 664)
    xs = W * 0.60
    yb = m.v(170, 166)
    st = stem(xs, xs + s, 0, C, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare)
    bar_ = bar(0, W, yb, yb + h, right=(m.wdrop * 0.5, m.wdrop * 0.5, m.wlen * 0.6))
    dw = m.thin / math.sin(math.atan2(C - yb, xs - m.v(60, 90)))
    d = polygon([(0, yb + 2), (dw, yb + 2), (xs + s * 0.5, C), (xs + s * 0.5 - dw, C)])
    return G(union([st, bar_, d]), W, None, None)


@glyph('seven.ss05')
def seven_ss05(m):
    """A straight 7"""
    C, h = m.C, m.hair
    W = m.v(548, 606)
    top = bar(0, W, C - h, C, left=(0, m.wdrop, m.wlen))
    th = m.thick * 0.92
    leg = diag(*diag_through((W * 0.30, 0), (W - th * 0.55, C - h * 0.5), th, 0, C - h * 0.5))
    return G(union([top, leg]), W, None, None)


@glyph('five.ss05')
def five_ss05(m):
    """The 5 with a plain top bar and a leaning stem"""
    g = Gl.five(m)
    C, h = m.C, m.hair
    xs = m.v(26, 30)
    W = g.w
    # the wedge-ended top bar replaced by a plain one
    body = diff(g.path, rect(xs + m.stem, C - h - 2, W + 100, C + 100))
    body = union([body, rect(xs, C - h, W * 0.90, C)])
    return G(body, W, None, None)


# ---------------------------------------------------------------------------------------------------------------------
# ss06: curiosities


def mirrored(fn):
    def draw(m):
        g = fn(m)
        lsb, rsb = g.rsb, g.lsb
        return G(mirror_x(g.path, g.w / 2), g.w, lsb, rsb)
    return draw


for _n, _fn in (('N', Gl.N), ('S', Gl.S), ('D', Gl.D), ('E', Gl.E)):
    Gl.GLYPHS[f'{_n}.ss06'] = ([], mirrored(_fn))


@glyph('I.ss06')
def I_ss06(m):
    """The barred I of some 17th-century discoidal stelae"""
    s = m.stem
    ext = m.v(70, 76)
    t = m.hair * 0.86
    return G(union([Gl.I(m).path, rect(-ext, CAP * 0.5 - t / 2, s + ext, CAP * 0.5 + t / 2)]), s, m.sp + ext, m.sp + ext)


@glyph('uniA750', 0xA750, 0xA751)
def P_stroke(m):
    """Ꝑ, P with a stroke through its stem (per, pro), common in the abbreviations of the stones"""
    g = Gl.P(m)
    s = m.stem
    ext = m.v(78, 84)
    t = m.hair * 0.86
    return G(union([g.path, rect(-ext, CAP * 0.2 - t / 2, s + ext, CAP * 0.2 + t / 2)]), g.w, m.sp + ext, None,
             top=g.top)


COMPOSITES.extend([
    ('G.ss06', [], 'eight', None, None),        # the G written as an 8
    ('U.ss06', [], 'V', None, None),            # V for U
])

# ---------------------------------------------------------------------------------------------------------------------
# tabular figures: each figure centred in one advance, the widest figure's (build.py places them, 'tab')

FIGURES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
COMPOSITES.extend([(f + '.tf', [], f, None, 'tab') for f in FIGURES])
