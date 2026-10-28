"""ss03, inscription unicase: the minuscules that the stones mix among capitals at cap height (Colas notes the mixing
as "much more frequent in Basse-Navarre"; the Musée Basque panel's hemen, bete, SAtZEN; an epitaph of 1661 read as
CY GIT IEAN dE TCHAVS). Typed in lowercase, e n m d t z r h q b take these forms under ss03; capitals stay
capitals. By default the lowercase codepoints show the capitals, as everywhere in the face.

Forms: an uncial e like Є, a Π-shaped n, a three-legged m, an uncial ∂-like d, a t whose foot curls up, a hooked z
(ʒ), an r with an ear, an h, a q and a b with bowls at the minuscule's height, all within the capitals' height.
"""
from geometry import bar, diff, hobby, inter, rect, ring, shift, stem, stroke, union
import glyphs as Gl
from glyphs import CAP, COMPOSITES, G, glyph

UNICASE = ['e', 'n', 'm', 'd', 't', 'z', 'r', 'h', 'q', 'b']
XH = 0.64          # the minuscule bowls' height, as a share of the cap height

# the lowercase codepoints get glyphs of their own (copies of the capitals) so ss03 can tell them from the capitals
for _c in UNICASE:
    COMPOSITES.append((_c, [ord(_c)], _c.upper(), None, None))


def nib(m):
    return m.v(62, 94), m.v(48, 70)


@glyph('e.unc')
def e_unc(m):
    """The uncial e: an open round bowl with a bar across its middle, cut with a wedge"""
    W = m.v(600, 668)
    c = Gl.c_shape(m, W, xt=W * m.v(0.70, 0.64), xb=W * m.v(0.74, 0.68))
    h = m.hair * 0.94
    ym = CAP * 0.5
    b = bar(m.rside * 0.5, W * m.v(0.70, 0.58), ym - h / 2, ym + h / 2,
            right=(m.wdrop * 0.5, m.wdrop * 0.5, m.wlen * 0.7))
    return G(union([c, b]), W, None, None)


@glyph('n.unc')
def n_unc(m):
    """The Π-shaped n of the panels (hemen, dena)"""
    s, C, h = m.stem, m.C, m.hair
    W = m.v(560, 620)
    ext = m.v(30, 34)
    return G(union([
        stem(0, s, 0, C - h * 0.5, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare),
        stem(W - s, W, 0, C - h * 0.5, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare),
        bar(-ext, W + ext, C - h, C, left=(0, m.wdrop * 0.8, m.wlen * 0.8), right=(0, m.wdrop * 0.8, m.wlen * 0.8)),
    ]), W, m.sp + ext, m.sp + ext)


@glyph('m.unc')
def m_unc(m):
    """A three-legged m under one bar, the panels' ⲙ read square"""
    s, C, h = m.stem, m.C, m.hair
    W = m.v(800, 880)
    ext = m.v(30, 34)
    sm = s * 0.92
    return G(union([
        stem(0, s, 0, C - h * 0.5, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare),
        stem(W / 2 - sm / 2, W / 2 + sm / 2, 0, C - h * 0.5, m.serif, tl=False, tr=False),
        stem(W - s, W, 0, C - h * 0.5, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare),
        bar(-ext, W + ext, C - h, C, left=(0, m.wdrop * 0.8, m.wlen * 0.8), right=(0, m.wdrop * 0.8, m.wlen * 0.8)),
    ]), W, m.sp + ext, m.sp + ext)


@glyph('d.unc')
def d_unc(m):
    """The uncial d: a round bowl whose right side rises and turns back over it (∂)"""
    C, o = m.C, m.o
    W = m.v(600, 664)
    a, b = nib(m)
    ry = C * XH / 2
    bowl_ = ring(W / 2, ry, W / 2, ry + o, m.rside * 0.96, m.rtop, k_out=0.585, k_in=0.56)
    sp = [
        hobby((W - a, ry), (0, 1), (W * 0.66, C + o - b), (-0.55, 1)),
        hobby((W * 0.66, C + o - b), (-0.55, 1), (W * 0.20, C * 0.88), (-1, -0.35)),
    ]
    neck = stroke(sp, a, b, knots=[(0, 1.0), (1, 0.98), (2, 0.84)], name='d.unc', fine=2)
    return G(union([bowl_, neck]), W, None, None)


@glyph('t.unc')
def t_unc(m):
    """The t of the panels: a stem whose foot curls up to the right, a crossbar high on it"""
    s, C, h = m.stem, m.C, m.hair
    W = m.v(470, 520)
    a, b = nib(m)
    xs = W * 0.30
    sp = [
        hobby((xs, C + 10), (0, -1), (xs, C * 0.24), (0, -1)),
        hobby((xs, C * 0.24), (0, -1), (xs + W * 0.30, b - m.o * 0.6), (1, 0)),
        hobby((xs + W * 0.30, b - m.o * 0.6), (1, 0), (W - a * 0.5, b + m.v(46, 52)), (0.7, 0.72)),
    ]
    st = stroke(sp, a, b, knots=[(0, 1.0), (1, 1.0), (2, 0.96), (3, 0.76)], name='t.unc', fine=2)
    st = inter(st, rect(-200, -100, W + 200, C))
    cross = bar(0, W * 0.86, C * 0.70 - h / 2, C * 0.70 + h / 2, left=(m.wdrop * 0.4, m.wdrop * 0.4, m.wlen * 0.6),
                right=(m.wdrop * 0.4, m.wdrop * 0.4, m.wlen * 0.6))
    return G(union([st, cross]), W, None, m.v(24, 18))


@glyph('z.unc')
def z_unc(m):
    """The hooked z (ʒ): a top bar, a diagonal to the middle, and a bowl like the 3's that ends in a plumb cut"""
    C, o, h = m.C, m.o, m.hair
    W = m.v(530, 590)
    a, b = nib(m)
    top = bar(m.v(14, 16), W - m.v(10, 12), C - h, C, left=(0, m.wdrop, m.wlen))
    sp = [
        hobby((W - m.v(10, 12) - a * 0.6, C - h * 0.5), (-0.62, -1), (W * 0.40, C * 0.50), (-0.55, -1)),
        hobby((W * 0.40, C * 0.50), (1, 0.05), (W - a, C * 0.24), (0, -1)),
        hobby((W - a, C * 0.24), (0, -1), (W * 0.47, -o + b), (-1, 0)),
        hobby((W * 0.47, -o + b), (-1, 0), (a * 0.9, C * 0.20), (-0.2, 1)),
    ]
    first = stroke(sp[:1], a * 0.94, b, name='z.unc a')
    low = stroke(sp[1:], a, b, knots=[(0, 0.92), (1, 1.02), (2, 1.0), (3, 0.9)], name='z.unc b', fine=2)
    low = diff(low, rect(-200, -200, a * 0.5, C * 0.45))
    return G(union([top, first, low]), W, None, None)


@glyph('r.unc')
def r_unc(m):
    """An r with an ear: a stem on its foot, an arm that leaves its top and droops to a cut end"""
    s, C = m.stem, m.C
    W = m.v(440, 490)
    a, b = nib(m)
    st = stem(0, s, 0, C, m.serif, tr=False, flare_l=m.flare, flare_r=m.flare)
    sp = [hobby((s * 0.5, C * 0.62), (0.35, 1), (W * 0.58, C + m.o - b), (1, 0)),
          hobby((W * 0.58, C + m.o - b), (1, 0), (W - a * 0.6, C * 0.70), (0.2, -1))]
    ear = stroke(sp, a * 0.92, b, knots=[(0, 0.9), (1, 1.0), (2, 1.04)], name='r.unc', fine=2)
    return G(union([st, ear]), W, m.sp, None, top=s / 2)


@glyph('h.unc')
def h_unc(m):
    """h: the left stem at full height, a shoulder at the minuscule's height into a second stem"""
    s, C, h = m.stem, m.C, m.hair
    W = m.v(590, 650)
    a, b = nib(m)
    yx = C * XH
    left = stem(0, s, 0, C, m.serif, flare_l=m.flare, flare_r=m.flare)
    right = stem(W - s, W, 0, yx * 0.62, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare)
    sp = [hobby((s * 0.5, yx * 0.62), (0.2, 1), (W * 0.56, yx + m.o - b), (1, 0)),
          hobby((W * 0.56, yx + m.o - b), (1, 0), (W - s * 0.5, yx * 0.5), (0, -1))]
    shoulder = stroke(sp, s * 0.5, b, knots=[(0, 0.86), (1, 1.0), (2, 1.0)], name='h.unc', fine=2)
    return G(union([left, right, shoulder]), W, m.sp, m.sp)


def minuscule_bowl(m, x0, xr):
    """A D-shaped bowl at the minuscule's height on a stem whose right edge is x0, reaching xr"""
    outer, counter = Gl.bowl(m, x0, 0, CAP * XH, xr, k=0.62, kin=0.60)
    return outer, counter


@glyph('b.unc')
def b_unc(m):
    s, C = m.stem, m.C
    W = m.v(560, 620)
    outer, counter = minuscule_bowl(m, s, W)
    return G(diff(union([stem(0, s, 0, C, m.serif, br=False, flare_l=m.flare, flare_r=m.flare), outer]), counter),
             W, m.sp, None, top=W * 0.46)


@glyph('q.unc')
def q_unc(m):
    """q: b's bowl turned round on a stem that drops below the line"""
    s, C = m.stem, m.C
    W = m.v(560, 620)
    outer, counter = minuscule_bowl(m, s, W)
    st = stem(0, s, -m.v(170, 172), C * XH, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare)
    b_ = diff(union([st, outer]), counter)
    from geometry import mirror_x
    return G(mirror_x(b_, W / 2), W, None, m.sp, top=W * 0.54)
