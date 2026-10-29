"""Ateburu's Latin beyond A-Z: the letters drawn as such (Æ, Ø, Þ, ẞ, Ð/Đ, Ħ, Ł, Ŀ) and every precomposed letter of
Google Fonts' GF Latin Core set (Western and Central European), built as composites of a base and a mark.

The face is unicase: a lowercase codepoint shares its capital's glyph (á is Á), except the i family, which keeps
glyphs of its own so that the dotted-i features can tell i from I. Latvian Ģ Ķ Ļ Ņ Ŗ take the comma below, though
Unicode decomposes them with the cedilla; Slovak Ľ (and ľ) take the apostrophe caron beside the stem.
"""
import unicodedata

from geometry import bar, diag_through, diff, hobby, inter, polygon, rect, stem, stroke, union
import glyphs as Gl
from glyphs import CAP, COMPOSITES, G, glyph, lozenge

# ---------------------------------------------------------------------------------------------------------------------
# letters drawn as such


@glyph('AE', 0xC6, 0xE6)
def AE(m):
    """The crowned A's left leg leaning on an E: the crown runs on as the E's top arm"""
    s, C, h = m.stem, m.C, m.hair
    W = m.v(860, 960)
    xs = m.v(372, 418)                       # the E part's stem, left edge
    thin = m.thin * 0.92
    lw = thin / 0.93                          # horizontal width of the leg (steep enough for this)
    leg = Gl.diag(*diag_through((lw / 2, 0), (xs + s * 0.5 - lw / 2, C), thin, 0, C),
                  {'bl': m.serif.scaled(1.05), 'br': m.serif.scaled(0.55, 0.7)})
    st = stem(xs, xs + s, 0, C, m.serif, tl=False, tr=False, flare_r=m.flare)
    ym = m.v(372, 370)
    hm = h * 0.94
    crown_l = xs - m.v(150, 160)
    parts = [
        leg, st,
        bar(crown_l, W, C - h, C, left=(0, m.wdrop * 0.95, m.wlen * 0.8), right=(0, m.wdrop, m.wlen),
            bend=Gl.arm(m, xs + s / 2, -m.v(10, 12))),
        bar(xs + s / 2, xs + s + (W - xs - s) * 0.80, ym - hm / 2, ym + hm / 2,
            right=(m.wdrop * 0.55, m.wdrop * 0.55, m.wlen * 0.8), bend=Gl.arm(m, xs + s / 2, m.v(4, 5))),
        bar(xs + s / 2, W + m.v(8, 10), 0, h, right=(m.wdrop, 0, m.wlen), bend=Gl.arm(m, xs + s / 2, m.v(10, 12))),
    ]
    # the A's crossbar, from the leg into the stem, dipped like the A's
    yb = m.v(300, 296)
    hb = h * 0.88
    parts.append(polygon([(lw * 0.5 + xs * 0.22, yb + hb), (xs + 2, yb + hb), (xs + 2, yb), (lw * 0.5 + xs * 0.22, yb)]))
    return G(union(parts), W, None, None, top=xs * 0.62, ogonek=W * 0.84)


@glyph('Oslash', 0xD8, 0xF8)
def Oslash(m):
    W = m.v(690, 754)
    o = Gl.o_ring(m, W)
    t = m.hair * 0.96
    sl = Gl.diag(*diag_through((W * 0.12, -50), (W * 0.88, m.C + 50), t * 1.05, -50, m.C + 50))
    return G(union([o, sl]), W, None, None)


@glyph('Thorn', 0xDE, 0xFE)
def Thorn(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(540, 600)
    y0, y1 = m.v(150, 146), m.v(592, 598)
    o1, c1 = Gl.bowl(m, s, y0, y1, W, k=0.60, kin=0.58)
    shape = union([stem(0, s, 0, C, m.serif, flare_l=m.flare, flare_r=m.flare), o1])
    return G(diff(shape, c1), W, m.sp, None, top=W * 0.44)


@glyph('Germandbls', 0x1E9E, 0xDF)
def Germandbls(m):
    """The capital sharp s: a stem whose top runs right and folds into a diagonal, then a bowl like the 3's"""
    s, C, o = m.stem, m.C, m.o
    W = m.v(560, 620)
    a, b = m.v(62, 94), m.v(48, 70)
    st = stem(0, s, 0, C * 0.70, m.serif, tl=False, tr=False, flare_l=m.flare)
    k = m.c
    top = [
        hobby((s / 2, C * 0.66), (0, 1), (s / 2 + (W * 0.5 - s / 2) * 0.48, C + o - b), (1, 0)),
        hobby((s / 2 + (W * 0.5 - s / 2) * 0.48, C + o - b), (1, 0), (W - a * 1.05, C - b * 0.6), (0.45, -1)),
        hobby((W - a * 1.05, C - b * 0.6), (0.45, -1), (W * 0.42, C * 0.47), (-1, -0.7)),
    ]
    low = [
        hobby((W * 0.42, C * 0.47), (1, 0.05), (W - a, C * 0.23), (0, -1)),
        hobby((W - a, C * 0.23), (0, -1), (W * 0.52, -o + b), (-1, 0)),
        hobby((W * 0.52, -o + b), (-1, 0), (s + m.v(66, 70) + a * 0.3, C * 0.17), (-0.6, 1)),
    ]
    body = union([stroke(top, a, b, knots=[(0, 1.0), (1, 0.98), (2, 0.92), (3, 0.9)], name='Germandbls a', fine=5),
                  stroke(low, a, b, knots=[(0, 0.92), (1, 1.04), (2, 1.0), (3, 0.88)], name='Germandbls b', fine=3)])
    # the bowl's tail ends free, cut plumb, clear of the stem's foot
    body = diff(body, rect(-100, -100, s + m.v(66, 70), C * 0.36))
    return G(union([st, body]), W, m.sp, None, top=W * 0.5)


def d_with_bar(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(626, 690)
    outer, counter = Gl.bowl(m, s, 0, C, W, k=0.62, kin=0.60)
    d = Gl.diff(union([stem(0, s, 0, C, m.serif, br=False, tr=False, flare_l=m.flare), outer]), counter)
    xl = -m.v(70, 76)
    ym = m.v(372, 370)
    t = h * 0.86
    barp = bar(xl, s + m.v(118, 128), ym - t / 2, ym + t / 2, left=(m.wdrop * 0.4, m.wdrop * 0.4, m.wlen * 0.5))
    return G(union([d, barp]), W, m.sp + m.v(60, 64), None, top=W * 0.46)


@glyph('Eth', 0xD0, 0xF0)
def Eth(m):
    return d_with_bar(m)


@glyph('Dcroat', 0x110, 0x111)
def Dcroat(m):
    return d_with_bar(m)


@glyph('Hbar', 0x126, 0x127)
def Hbar(m):
    s, C = m.stem, m.C
    W = m.v(574, 650)
    yc = m.v(370, 368)
    yb = m.v(560, 566)
    t = m.hair * 0.86
    ext = m.v(54, 60)
    return G(union([
        Gl.stem(0, s, 0, C, m.serif, flare_l=m.flare, flare_r=m.flare),
        Gl.stem(W - s, W, 0, C, m.serif, flare_l=m.flare, flare_r=m.flare),
        rect(s / 2, yc - m.hair / 2, W - s / 2, yc + m.hair / 2),
        rect(-ext, yb - t / 2, W + ext, yb + t / 2),
    ]), W, m.sp + ext, m.sp + ext)


@glyph('Lslash', 0x141, 0x142)
def Lslash(m):
    s, C, h = m.stem, m.C, m.hair
    W = m.v(446, 506)
    L = Gl.L(m).path
    t = h * 0.92
    sl = Gl.diag(*diag_through((-m.v(70, 76), m.v(250, 246)), (s + m.v(120, 130), m.v(470, 474)), t, m.v(214, 210),
                               m.v(500, 506)))
    return G(union([L, sl]), W, m.sp + m.v(56, 60), None, top=s / 2)


@glyph('Ldot', 0x13F, 0x140)
def Ldot(m):
    """Catalan Ŀ: the interpunct's lozenge set in the angle of the L"""
    s = m.stem
    W = m.v(446, 506)
    L = Gl.L(m).path
    dx, dy = m.v(58, 72), m.v(76, 92)
    return G(union([L, lozenge(s + m.v(96, 104), m.C * 0.5, dx, dy)]), W, m.sp, None, top=s / 2)


# ---------------------------------------------------------------------------------------------------------------------
# precomposed letters: built from their Unicode decompositions

MARK_OF = {0x0300: 'gravecomb', 0x0301: 'acutecomb', 0x0302: 'circumflexcomb', 0x0303: 'tildecomb',
           0x0304: 'macroncomb', 0x0306: 'brevecomb', 0x0307: 'dotaccentcomb', 0x0308: 'dieresiscomb',
           0x030A: 'ringcomb', 0x030B: 'hungarumlautcomb', 0x030C: 'caroncomb', 0x0326: 'commaaccentcomb',
           0x0327: 'cedillacomb', 0x0328: 'ogonekcomb'}
SUFFIX = {'gravecomb': 'grave', 'acutecomb': 'acute', 'circumflexcomb': 'circumflex', 'tildecomb': 'tilde',
          'macroncomb': 'macron', 'brevecomb': 'breve', 'dotaccentcomb': 'dotaccent', 'dieresiscomb': 'dieresis',
          'ringcomb': 'ring', 'hungarumlautcomb': 'hungarumlaut', 'caroncomb': 'caron',
          'commaaccentcomb': 'commaaccent', 'cedillacomb': 'cedilla', 'ogonekcomb': 'ogonek',
          'caroncomb.alt': 'caron'}
LATVIAN = set('GKLNR')     # their "cedilla" is a comma below
TARGETS = (list(range(0xC0, 0x100)) + list(range(0x100, 0x180)) + [0x218, 0x219, 0x21A, 0x21B] +
           list(range(0x1E80, 0x1E86)) + [0x1EF2, 0x1EF3])
I_LOWER = {0xED: 'iacute', 0xEC: 'igrave', 0xEF: 'idieresis', 0xEE: 'icircumflex'}


def _composites():
    out = {}     # name -> [name, unicodes, base, mark, place]
    for cp in TARGETS:
        if cp in I_LOWER:
            continue
        dec = unicodedata.decomposition(chr(cp)).split()
        if len(dec) != 2 or dec[0].startswith('<'):
            continue
        base_cp, mark_cp = int(dec[0], 16), int(dec[1], 16)
        if mark_cp not in MARK_OF:
            continue
        base = chr(base_cp).upper()
        if not ('A' <= base <= 'Z'):
            continue
        mk = MARK_OF[mark_cp]
        if mk == 'cedillacomb' and base in LATVIAN:
            mk = 'commaaccentcomb'
        if mk == 'caroncomb' and base == 'L':
            mk = 'caroncomb.alt'
        name = base + SUFFIX[mk]
        if name not in out:
            out[name] = [name, [], base, mk, None]
        out[name][1].append(cp)
    return out


for _name, _entry in _composites().items():
    if any(c[0] == _name for c in COMPOSITES):
        continue
    COMPOSITES.append(tuple(_entry))
COMPOSITES += [
    ('dotlessi', [0x131], 'I', None, None),
    ('dotlessj', [0x237], 'J', None, None),
    ('icircumflex', [0xEE], 'I', 'circumflexcomb', None),
]
