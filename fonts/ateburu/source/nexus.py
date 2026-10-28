"""Nexus letters for dlig: two letters sharing a stroke, the way the carvers saved stone (Zabalo's "yuxtaposición"
and joined letters, after Colas). Each is built from the face's own parts:

TX TZ TS TA TE TR   T's bar runs on over the next letter and becomes its top (X's arms, Z's top bar, S's head, the
                    A's crown, E's top arm, R's bowl top)
ME NE ND            the first letter's last stem is the second's stem
DE                  E inside D: D's bars are E's top and bottom arms, a middle arm is added in the counter
LA                  L's foot runs into the A's left foot
AN                  the A's right leg is N's first stroke, N's diagonal leaves from the apex
MA                  the M's V lands on the A's left leg

AR, also on the dossier's list, is left out: the A's slanted leg makes no convincing R stem in this design.

TX, TZ and TS are modern digraphs (batua); historically CH, TCH and TZ were written (see SOURCES.md).
"""
import math

from geometry import bar, diag, diff, inter, polygon, rect, shift, stem, union
import glyphs as Gl
from glyphs import G, glyph

NEXUS = []          # (ligature name, component letters)


def nexus(name, letters):
    def deco(fn):
        Gl.GLYPHS[name] = ([], fn)
        NEXUS.append((name, letters))
        return fn
    return deco


def t_bar(m, x1, right=None, droop_right=True):
    """T's bar from 0 to x1, with T's left wedge; `right` as bar()'s right end"""
    s, C, h = m.stem, m.C, m.hair
    W = Gl.T(m).w
    d = m.v(12, 14)
    bend = (W / 2, -d * m.c, (-d * m.c if droop_right else 0.0)) if m.c else None
    return bar(0, x1, C - h, C, left=(0, m.wdrop, m.wlen), right=right, bend=bend)


def t_stem(m):
    s, C = m.stem, m.C
    W = Gl.T(m).w
    x0 = W / 2 - s / 2
    return stem(x0, x0 + s, 0, C, m.serif, tl=False, tr=False, flare_l=m.flare, flare_r=m.flare), W


def e_arms(m, x, top=True, sw=None):
    """E's arms from a stem whose left edge is at x (stem width sw); returns (parts, E's width)"""
    s, C, h = m.stem, m.C, m.hair
    sw = s if sw is None else sw
    W = m.v(452, 512)
    ym = m.v(372, 370)
    hm = h * 0.94
    parts = [
        bar(x + sw / 2, x + W * 0.86, ym - hm / 2, ym + hm / 2, right=(m.wdrop * 0.55, m.wdrop * 0.55, m.wlen * 0.8),
            bend=Gl.arm(m, x + sw / 2, m.v(4, 5))),
        bar(x + sw / 2, x + W + m.v(8, 10), 0, h, right=(m.wdrop, 0, m.wlen), bend=Gl.arm(m, x + sw / 2, m.v(10, 12))),
    ]
    if top:
        parts.append(bar(x + sw / 2, x + W, C - h, C, right=(0, m.wdrop, m.wlen), bend=Gl.arm(m, x + sw / 2, -m.v(10, 12))))
    return parts, W


# ---------------------------------------------------------------------------------------------------------------------
# T + ...


@nexus('T_X', 'TX')
def T_X(m):
    st, WT = t_stem(m)
    X = Gl.X(m)
    xX = WT * 0.80
    return G(union([st, shift(X.path, xX, 0), t_bar(m, xX + X.w * 0.97, right=(0, m.wdrop, m.wlen))]), xX + X.w,
             None, None)


@nexus('T_Z', 'TZ')
def T_Z(m):
    C, h = m.C, m.hair
    st, WT = t_stem(m)
    WZ = m.v(548, 608)
    xZ = WT * 0.78
    hw = m.thick / math.sin(math.atan2(C - 2 * h, WZ - m.v(150, 200)))
    r = WZ - m.v(10, 12)
    diag_ = polygon([(xZ, 0), (xZ + hw, 0), (xZ + r, C), (xZ + r - hw, C)])
    base = bar(xZ, xZ + WZ + m.v(6, 8), 0, h, right=(m.wdrop, 0, m.wlen), bend=Gl.arm(m, xZ, m.v(8, 10)))
    return G(union([st, t_bar(m, xZ + r, droop_right=False), diag_, base]), xZ + WZ, None, None)


@nexus('T_S', 'TS')
def T_S(m):
    st, WT = t_stem(m)
    S = Gl.S(m)
    xS = WT * 0.74
    return G(union([st, shift(S.path, xS, 0), t_bar(m, xS + S.w * 0.90, right=(0, m.wdrop * 0.8, m.wlen * 0.8))]),
             xS + S.w, None, None)


@nexus('T_A', 'TA')
def T_A(m):
    st, WT = t_stem(m)
    A = Gl.A(m, crowned=False)
    WA, ax0, apex_w, l_hw, r_hw = Gl.a_geometry(m)
    xA = WT * 0.80
    x1 = xA + ax0 + apex_w + m.v(20, 22)
    crown_bar = t_bar(m, x1, right=(0, m.wdrop * 0.4, m.wlen * 0.4), droop_right=False)
    return G(union([st, shift(A.path, xA, 0), crown_bar]), xA + WA, None, None)


@nexus('T_E', 'TE')
def T_E(m):
    s, C = m.stem, m.C
    st, WT = t_stem(m)
    xE = WT * 0.80
    arms, WE = e_arms(m, xE, top=False)
    e_stem = stem(xE, xE + s, 0, C, m.serif, br=False, tr=False, flare_l=m.flare)
    return G(union([st, e_stem, t_bar(m, xE + WE, right=(0, m.wdrop, m.wlen), droop_right=False)] + arms),
             xE + WE, None, None)


@nexus('T_R', 'TR')
def T_R(m):
    st, WT = t_stem(m)
    R = Gl.R(m)
    xR = WT * 0.80
    return G(union([st, shift(R.path, xR, 0), t_bar(m, xR + R.w * 0.55, droop_right=False)]), xR + R.w,
             None, m.v(30, 22))


# ---------------------------------------------------------------------------------------------------------------------
# shared stems


@nexus('N_E', 'NE')
def N_E(m):
    N = Gl.N(m)
    sn = m.stem * 0.88
    x = N.w - sn
    arms, WE = e_arms(m, x, sw=sn)
    return G(union([N.path] + arms), x + WE, m.sp, None)


@nexus('N_D', 'ND')
def N_D(m):
    C = m.C
    N = Gl.N(m)
    WD = m.v(626, 690)
    outer, counter = Gl.bowl(m, N.w, 0, C, N.w + (WD - m.stem), k=0.62, kin=0.60)
    return G(diff(union([N.path, outer]), counter), N.w + WD - m.stem, m.sp, None)


@nexus('M_E', 'ME')
def M_E(m):
    """M whose last leg stands upright and is E's stem"""
    C = m.C
    s = m.stem
    W = m.v(746, 830)
    splay = m.v(38, 42)
    yv = m.v(212, 204)
    thin, thick = m.thin * 0.92, m.thick
    lw = thin / math.sin(math.atan2(C, splay))
    left = diag((0, 0), (lw, 0), (splay, C), (splay + lw, C), {'bl': m.serif, 'br': m.serif, 'tl': m.serif})
    xs = W - splay - s
    vx = (splay + xs + s) / 2 - s * 0.2
    dl_dir = Gl.unit((vx - splay, yv - C))
    dr_dir = Gl.unit((vx - (xs + s), yv - C))
    dlw = thick / math.sin(math.atan2(C - yv, vx - splay))
    drw = thin / math.sin(math.atan2(C - yv, xs + s - vx))
    q = Gl.intersect_lines((splay + dlw, C), dl_dir, (xs + s, C), dr_dir)
    q2 = Gl.intersect_lines((xs + s - drw, C), dr_dir, (splay, C), dl_dir)
    dl = polygon([(splay, C), (splay + dlw, C), q, (vx, yv)])
    dr = polygon([(xs + s - drw, C), (xs + s, C), (vx, yv), q2])
    e_stem = stem(xs, xs + s, 0, C, m.serif, br=False, tr=False, tl=False)
    arms, WE = e_arms(m, xs)
    return G(union([left, dl, dr, e_stem] + arms), xs + WE, None, None)


@nexus('D_E', 'DE')
def D_E(m):
    """E inside D: the D's bars are the E's top and bottom arms; a middle arm stands in the counter"""
    s, h = m.stem, m.hair
    D = Gl.D(m)
    ym = m.v(372, 370)
    hm = h * 0.94
    arm_ = bar(s / 2, D.w * m.v(0.60, 0.58), ym - hm / 2, ym + hm / 2,
               right=(m.wdrop * 0.55, m.wdrop * 0.55, m.wlen * 0.7), bend=Gl.arm(m, s / 2, m.v(4, 5)))
    return G(union([D.path, arm_]), D.w, m.sp, None, top=D.top)


# ---------------------------------------------------------------------------------------------------------------------
# with A


@nexus('L_A', 'LA')
def L_A(m):
    L = Gl.L(m)
    A = Gl.A(m)
    xA = L.w - m.v(84, 96)
    return G(union([L.path, shift(A.path, xA, 0)]), xA + A.w, m.sp, None)


@nexus('A_N', 'AN')
def A_N(m):
    """The A's right leg is N's first stroke: N's diagonal leaves from the apex for N's right stem"""
    C = m.C
    A = Gl.A(m)
    WA, ax0, apex_w, l_hw, r_hw = Gl.a_geometry(m)
    sn = m.stem * 0.88
    apex_r = ax0 + apex_w
    # the wedge between the A's right leg and the diagonal is the N's lower counter: it must stay open at the Black,
    # so the right stem goes where the diagonal clears the A's right foot by `gap`
    a_right = A.path.bounds[2]
    gap = m.v(118, 112)
    xr = a_right + gap + m.thick
    for _ in range(8):
        dw = m.thick / math.sin(math.atan2(C + m.op, xr - apex_r))
        xr = a_right + gap + dw
    d = polygon([(xr - dw, -m.op), (xr, -m.op), (apex_r, C), (apex_r - dw, C)])
    right = stem(xr - sn, xr, -m.op, C, m.serif, bl=False, br=False, flare_l=m.flare, flare_r=m.flare)
    return G(union([A.path, d, right]), xr, None, m.sp)


@nexus('M_A', 'MA')
def M_A(m):
    """The M's V lands on the A's left leg: M's last leg is the A's first"""
    C = m.C
    W = m.v(746, 830)
    splay = m.v(38, 42)
    yv = m.v(212, 204)
    thin, thick = m.thin * 0.92, m.thick
    lw = thin / math.sin(math.atan2(C, splay))
    left = diag((0, 0), (lw, 0), (splay, C), (splay + lw, C), {'bl': m.serif, 'br': m.serif, 'tl': m.serif})
    vx = W / 2
    WA, ax0, apex_w, l_hw, r_hw = Gl.a_geometry(m)
    xA = vx - ax0 * yv / C - l_hw * 0.5
    A = Gl.A(m)
    # the M's first diagonal: a straight stroke from the top of the left leg down to the vertex on the A's left leg,
    # run on 80 units past it so that it ends buried in that leg (no sliver of counter where they meet), and cut at the
    # leg's inner edge so that nothing of it shows inside the A
    dlw = thick / math.sin(math.atan2(C - yv, vx - splay))
    slope = (vx - splay) / (C - yv)
    y_end = yv - 80
    x_end = splay + slope * (C - y_end)
    dl = polygon([(splay, C), (splay + dlw, C), (x_end + dlw, y_end), (x_end, y_end)])
    inner = xA + l_hw - 2            # the leg's inner edge at the baseline; it leans right by ax0 over the cap height
    keep = polygon([(-500, -100), (inner - ax0 * 100 / C, -100), (inner + ax0 * (C + 100) / C, C + 100),
                    (-500, C + 100)])
    return G(union([left, inter(dl, keep), shift(A.path, xA, 0)]), xA + WA, None, None)
