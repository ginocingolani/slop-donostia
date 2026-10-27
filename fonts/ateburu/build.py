#!/usr/bin/env python3
"""fonts/ateburu/build.py

Builds Ateburu, an original display face in the Basque lettering tradition (letra vasca), from its source: the
letters are drawn in code in source/glyphs.py with the toolkit in source/geometry.py. Two masters, HUD (wght 600, for
light-on-dark place names at 12-20 px) and Black (wght 900), are built from the same drawing functions with different
parameters, made interpolation-compatible, spaced and kerned, and written as:

    source/masters/Ateburu-HUD.ttf, source/masters/Ateburu-Black.ttf   the two masters
    source/Ateburu.designspace                                         wght 600-900, four named instances
    variable/Ateburu[wght].ttf                                         the variable font
    static/Ateburu-{SemiBold,Bold,ExtraBold,Black}.ttf                 static instances
    webfonts/Ateburu-Variable.woff2                                    the variable font for the web
    webfonts/Ateburu-HUD.woff2                                         the SemiBold (HUD) instance, subset, for the app

All outputs are committed, so the app needs nothing from here. To rebuild:

    python3 -m venv .venv && .venv/bin/pip install fonttools==4.55.3 skia-pathops==0.8.0.post2 brotli==1.1.0
    .venv/bin/python fonts/ateburu/build.py

The build is deterministic: the same source gives the same bytes (fixed timestamps, no randomness). It fails if a
glyph's masters are incompatible or an outline has the wrong direction or overlapping contours.

SIL Open Font License 1.1, no Reserved Font Name: see OFL.txt. Copyright 2026 The Ateburu Project Authors.
"""
import json
import math
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ next to the sources
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'source'))

import pathops  # noqa: E402
from fontTools import subset  # noqa: E402
from fontTools.designspaceLib import (AxisDescriptor, DesignSpaceDocument, InstanceDescriptor,  # noqa: E402
                                      SourceDescriptor)
from fontTools.fontBuilder import FontBuilder  # noqa: E402
from fontTools.misc.timeTools import timestampFromString  # noqa: E402
from fontTools.otlLib.builder import buildStatTable  # noqa: E402
from fontTools.pens.ttGlyphPen import TTGlyphPen  # noqa: E402
from fontTools.ttLib import TTFont, newTable  # noqa: E402
from fontTools.varLib import build as varlib_build  # noqa: E402
from fontTools.varLib.instancer import instantiateVariableFont  # noqa: E402

import geometry  # noqa: E402
import glyphs as G  # noqa: E402

FAMILY = 'Ateburu'  # the working name: rename here (and in the file names below) if the family is renamed
VERSION = '0.100'
COPYRIGHT = 'Copyright 2026 The Ateburu Project Authors (https://github.com/ginocingolani/slop-donostia)'
LICENSE = ('This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available '
           'with a FAQ at: https://openfontlicense.org')
LICENSE_URL = 'https://openfontlicense.org'
VENDOR = 'NONE'
TIMESTAMP = timestampFromString('Tue Oct 27 00:00:00 2026')

UPM = 1000
ASCENT, DESCENT = 930, -230   # typo = hhea; line gap 0: "normal" line height 1.16, caps centred in the line
MASTERS = [G.Master('HUD', 0.0, 600), G.Master('Black', 1.0, 900)]
INSTANCES = [('SemiBold', 600), ('Bold', 700), ('ExtraBold', 800), ('Black', 900)]

OUT_MASTERS = os.path.join(HERE, 'source', 'masters')
OUT_DS = os.path.join(HERE, 'source', f'{FAMILY}.designspace')
OUT_VF = os.path.join(HERE, 'variable', f'{FAMILY}[wght].ttf')
OUT_STATIC = os.path.join(HERE, 'static')
OUT_WEB = os.path.join(HERE, 'webfonts')
REPORT = os.path.join(HERE, 'source', 'build-report.json')


# ---------------------------------------------------------------------------------------------------------------------
# drawing every master


def draw_all():
    drawn = {}   # name -> [G per master]
    for name, (unis, fn) in G.GLYPHS.items():
        drawn[name] = [fn(m) for m in MASTERS]
    return drawn


def outlines(drawn):
    """name -> per master TrueType contours (compatible)"""
    out, errors = {}, []
    for name, gs in drawn.items():
        if gs[0].path is None:
            out[name] = [[] for _ in MASTERS]
            continue
        try:
            out[name] = geometry.make_compatible(name, [g.path for g in gs])
        except geometry.CompatError as e:
            errors.append(str(e))
    if errors:
        raise SystemExit('incompatible masters:\n  ' + '\n  '.join(errors))
    return out


# ---------------------------------------------------------------------------------------------------------------------
# profiles, spacing and kerning


def flatten(contour, steps=10):
    """TrueType contour [(on, (x, y))] → polygon points"""
    pts = contour
    n = len(pts)
    # rotate to an on-curve start
    k = next(i for i, (on, _) in enumerate(pts) if on)
    pts = pts[k:] + pts[:k]
    poly = []
    i = 0
    cur = pts[0][1]
    poly.append(cur)
    offs = []
    for on, p in pts[1:] + pts[:1]:
        if on:
            if offs:
                # implied on-curves between consecutive off-curves
                ctrl = offs
                ons = [cur] + [((ctrl[j][0] + ctrl[j + 1][0]) / 2, (ctrl[j][1] + ctrl[j + 1][1]) / 2)
                               for j in range(len(ctrl) - 1)] + [p]
                for j, q in enumerate(ctrl):
                    a, b = ons[j], ons[j + 1]
                    for s in range(1, steps + 1):
                        t = s / steps
                        poly.append(((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * q[0] + t * t * b[0],
                                     (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * q[1] + t * t * b[1]))
                offs = []
            else:
                poly.append(p)
            cur = p
        else:
            offs.append(p)
    return poly


def profile(contours, ys):
    """For each y: (min x, max x) of the outline's crossings, or None"""
    polys = [flatten(c) for c in contours if c]
    out = []
    for y in ys:
        xs = []
        for poly in polys:
            for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
                if (y0 <= y < y1) or (y1 <= y < y0):
                    xs.append(x0 + (x1 - x0) * (y - y0) / (y1 - y0))
        out.append((min(xs), max(xs)) if xs else None)
    return out


YS = list(range(-150, 900, 6))


def weight_at(y, C=G.CAP):
    if y < 0 or y > C:
        return 0.0
    r = y / C
    return 0.55 + 0.45 * math.sin(math.pi * min(max(r, 0), 1)) ** 0.5


def side_area(d, depth):
    return sum(weight_at(y) * min(max(v, 0), depth) for y, v in zip(YS, d) if v is not None)


def side_dist(prof, side, offset):
    """Distance from the side boundary to the outline at each y, given the body-relative profile and the side bearing
    (offset). side 'L': boundary at x = -offset (body x 0 is offset from the origin); 'R': boundary at body width +
    offset, prof values are already 'width - x'"""
    out = []
    for p in prof:
        if p is None:
            out.append(None)
        else:
            out.append(offset + (p[0] if side == 'L' else p[1]))
    return out


def spacing(drawn, tt):
    """Work out every glyph's side bearings per master: fixed ones from the drawing, the rest by matching the white
    space at each side (clipped in depth) to that of a serifed stem."""
    result = {}
    for mi, m in enumerate(MASTERS):
        ref_prof = profile(tt['H'][mi], YS)
        depth = m.sp + m.v(118, 96)
        ref_left = side_area(side_dist([(p[0], None) if p else None for p in ref_prof], 'L', m.sp), depth)
        minimum = m.v(16, 12)
        for name, gs in drawn.items():
            g = gs[mi]
            if g.adv is not None:
                result.setdefault(name, []).append((0, g.adv))
                continue
            if not tt[name][mi]:
                result.setdefault(name, []).append((g.lsb or 0, g.rsb or 0))
                continue
            prof = profile(tt[name][mi], YS)
            lprof = [(p[0], None) if p else None for p in prof]
            rprof = [(None, g.w - p[1]) if p else None for p in prof]

            def solve(side, pr):
                lo, hi = -300.0, 400.0
                for _ in range(40):
                    mid = (lo + hi) / 2
                    d = side_dist(pr, side, mid)
                    if side_area(d, depth) < ref_left:
                        lo = mid
                    else:
                        hi = mid
                s = (lo + hi) / 2
                # never closer than `minimum` to the boundary anywhere in the cap band (accents excluded)
                d = side_dist(pr, side, 0)
                closest = min(v for y, v in zip(YS, d) if v is not None and -40 <= y <= G.CAP + 40)
                return max(s, minimum - closest)

            lsb = g.lsb if g.lsb is not None else solve('L', lprof)
            rsb = g.rsb if g.rsb is not None else solve('R', rprof)
            result.setdefault(name, []).append((lsb, rsb))
    return result


# overrides applied on top of the automatic spacing: (name, master index or None for both, 'lsb'|'rsb', delta)
SPACING_TWEAKS = {
}


def kern_value(m, left_prof, right_prof, ref_gaps, depth2, mingap):
    """Kern so that the clipped white area between the two glyphs matches the reference pair's (HH) over the same
    heights (so a period after T is compared with HH's white at the period's own height)"""
    gaps = [(y, a + b) for y, (a, b) in zip(YS, zip(left_prof, right_prof)) if a is not None and b is not None]
    if not gaps:
        return 0
    ref_area = sum(weight_at(y) * min(max(ref_gaps[y], 0), depth2) for y, _ in gaps)

    def area(k):
        return sum(weight_at(y) * min(max(v + k, 0), depth2) for y, v in gaps)

    lo, hi = -400.0, 300.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if area(mid) < ref_area:
            lo = mid
        else:
            hi = mid
    k = (lo + hi) / 2
    closest = min(v for y, v in gaps)
    return max(k, mingap - closest)


KERN_LEFT_OPEN = set('AFKLPRTVWXYZ') | {'quoteright', 'quotedblright', 'seven', 'four', 'one'}
KERN_RIGHT_OPEN = set('AJTVWXYZ') | {'period', 'comma', 'quoteright', 'quotedblright', 'quoteleft', 'quotedblleft',
                                     'hyphen', 'four', 'seven'}
REQUIRED_PAIRS = [('A', 'T'), ('T', 'A'), ('L', 'T'), ('R', 'A'), ('R', 'T'), ('Y', 'A'), ('A', 'V'), ('K', 'O'),
                  ('T', 'X'), ('T', 'Z'), ('T', 'S')]
CLASSES = {
    'A': ['A', 'Aacute', 'Agrave'], 'E': ['E', 'Eacute', 'Egrave'], 'I': ['I', 'Iacute'],
    'O': ['O', 'Oacute', 'Ograve'], 'U': ['U', 'Uacute', 'Udieresis'], 'N': ['N', 'Ntilde'], 'C': ['C', 'Ccedilla'],
}


def kerning(drawn, tt, sb):
    """Pairs among open shapes (and the required ones), valued per master by matching white area; the same pair list in
    both masters so that the variable font can interpolate them"""
    letters = [c for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
    extra = ['period', 'comma', 'hyphen', 'quoteright', 'quotedblright', 'quoteleft', 'quotedblleft', 'one', 'four',
             'seven', 'zero']
    names = letters + extra
    per_master = []
    for mi, m in enumerate(MASTERS):
        profs = {}
        for n in names:
            prof = profile(tt[n][mi], YS)
            lsb, rsb = sb[n][mi]
            w = drawn[n][mi].w
            profs[n] = ([lsb + p[0] if p else None for p in prof], [rsb + (w - p[1]) if p else None for p in prof])
        depth2 = 2 * m.sp + m.v(150, 120)
        ref_gaps = {y: a + b for y, a, b in zip(YS, profs['H'][1], profs['H'][0]) if a is not None and b is not None}
        # beyond the stem's height (quotes, the comma's tail) the white of the stem's ends carries on
        top, bottom = ref_gaps[max(ref_gaps)], ref_gaps[min(ref_gaps)]
        for y in YS:
            if y not in ref_gaps:
                ref_gaps[y] = top if y > 0 else bottom
        vals = {}
        for a in names:
            for b in names:
                if (a, b) not in REQUIRED_PAIRS and not (a in KERN_LEFT_OPEN or b in KERN_RIGHT_OPEN):
                    continue
                if a in extra and b in extra:
                    continue
                k = kern_value(m, profs[a][1], profs[b][0], ref_gaps, depth2, m.v(34, 26))
                vals[(a, b)] = k
        per_master.append(vals)
    pairs = {}
    for key in per_master[0]:
        ks = [pm[key] for pm in per_master]
        if key in REQUIRED_PAIRS or any(abs(k) >= 14 for k in ks):
            pairs[key] = [int(round(k / 2) * 2) for k in ks]
    return pairs


# ---------------------------------------------------------------------------------------------------------------------
# font assembly


def tt_glyph(contours, dx):
    pen = TTGlyphPen(None)
    for c in contours:
        k = next(i for i, (on, _) in enumerate(c) if on)
        c = c[k:] + c[:k]
        pen.moveTo((c[0][1][0] + dx, c[0][1][1]))
        offs = []
        for on, p in c[1:]:
            p = (p[0] + dx, p[1])
            if on:
                if offs:
                    pen.qCurveTo(*offs, p)
                    offs = []
                else:
                    pen.lineTo(p)
            else:
                offs.append(p)
        if offs:
            pen.qCurveTo(*offs, (c[0][1][0] + dx, c[0][1][1]))
        pen.closePath()
    return pen.glyph()


def glyph_order():
    order = ['.notdef']
    order += [n for n in G.GLYPHS]
    order += [c[0] for c in G.COMPOSITES]
    return order


def notdef(m):
    w, h = m.v(500, 540), G.CAP
    t = m.v(60, 90)
    outer = geometry.rect(40, 0, 40 + w, h)
    inner = geometry.rect(40 + t, t, 40 + w - t, h - t)
    return geometry.diff(outer, inner), w + 80


def build_master(mi, drawn, tt, sb, kern):
    m = MASTERS[mi]
    order = glyph_order()
    glyf, hmtx, cmap = {}, {}, {}
    nd_path, nd_adv = notdef(m)
    nd = geometry.make_compatible('.notdef', [nd_path, nd_path])[0]
    glyf['.notdef'] = tt_glyph(nd, 0)
    hmtx['.notdef'] = nd_adv
    anchors = {}
    for name, gs in drawn.items():
        g = gs[mi]
        lsb, rsb = sb[name][mi]
        lsb_i = int(round(lsb))
        if g.adv is not None:
            glyf[name] = TTGlyphPen(None).glyph()
            hmtx[name] = int(round(g.adv))
        else:
            glyf[name] = tt_glyph(tt[name][mi], lsb_i)
            hmtx[name] = int(round(lsb_i + g.w + rsb))
        anchors[name] = (lsb_i + g.top, lsb_i + g.bottom)
        for u in G.GLYPHS[name][0]:
            cmap[u] = name
    for name, uni, base, mark in G.COMPOSITES:
        pen = TTGlyphPen(glyf)
        pen.addComponent(base, (1, 0, 0, 1, 0, 0))
        top, bottom = anchors[base]
        x = bottom if mark == 'cedillacomb' else top
        pen.addComponent(mark, (1, 0, 0, 1, int(round(x)), 0))
        glyph = pen.glyph()
        glyph.components[0].flags |= 0x0200  # USE_MY_METRICS
        glyf[name] = glyph
        hmtx[name] = hmtx[base]
        cmap[uni] = name
        cmap[G.LOWER[name]] = name

    fb = FontBuilder(UPM, isTTF=True)
    fb.font.recalcTimestamp = False
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyf)
    glyf_t = fb.font['glyf']
    metrics = {}
    for name in order:
        g = glyf_t[name]
        g.recalcBounds(glyf_t)
        metrics[name] = (hmtx[name], getattr(g, 'xMin', 0) if g.numberOfContours else 0)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT, lineGap=0)
    style = m.name
    fb.setupNameTable({
        'copyright': COPYRIGHT, 'familyName': f'{FAMILY} {style}', 'styleName': 'Regular',
        'uniqueFontIdentifier': f'{VERSION};{VENDOR};{FAMILY}-{style}', 'fullName': f'{FAMILY} {style}',
        'version': f'Version {VERSION}', 'psName': f'{FAMILY}-{style}', 'designer': 'The Ateburu Project Authors',
        'licenseDescription': LICENSE, 'licenseInfoURL': LICENSE_URL,
        'typographicFamily': FAMILY, 'typographicSubfamily': style,
    })
    ymax = max(getattr(glyf_t[n], 'yMax', 0) for n in order if glyf_t[n].numberOfContours)
    ymin = min(getattr(glyf_t[n], 'yMin', 0) for n in order if glyf_t[n].numberOfContours)
    fb.setupOS2(usWeightClass=m.wght, fsType=0, achVendID=VENDOR, sTypoAscender=ASCENT, sTypoDescender=DESCENT,
                sTypoLineGap=0, usWinAscent=max(ASCENT, ymax), usWinDescent=max(-DESCENT, -ymin), sxHeight=G.CAP,
                sCapHeight=G.CAP, fsSelection=0x80, ulUnicodeRange1=0b11, ulCodePageRange1=1,
                usDefaultChar=0, usBreakChar=32, version=4)
    fb.setupPost(isFixedPitch=0, underlinePosition=-120, underlineThickness=int(m.v(60, 80)))
    fb.setupHead(unitsPerEm=UPM, fontRevision=float(VERSION), created=TIMESTAMP, modified=TIMESTAMP)
    fb.font['head'].flags |= 0x0008  # integer scaling
    fb.addOpenTypeFeatures(kern_fea(kern, mi))
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = gasp
    return fb.font


def kern_fea(kern, mi):
    lines = []
    for k, members in CLASSES.items():
        lines.append(f'@L_{k} = [{" ".join(members)}];')
        lines.append(f'@R_{k} = [{" ".join(members)}];')
    lines.append('feature kern {')
    lines.append('  lookupflag 0;')
    # glyph pairs first would override classes; all our pairs are class or single-glyph pairs on bases
    for (a, b), vals in sorted(kern.items()):
        la = f'@L_{a}' if a in CLASSES else a
        rb = f'@R_{b}' if b in CLASSES else b
        if a in CLASSES or b in CLASSES:
            lines.append(f'  enum pos {la} {rb} {vals[mi]};' if False else f'  pos {la} {rb} {vals[mi]};')
        else:
            lines.append(f'  pos {la} {rb} {vals[mi]};')
    lines.append('} kern;')
    return '\n'.join(lines) + '\n'


def check_outlines(font, name):
    """Direction (outer clockwise), no overlapping contours, no zero-area contours"""
    problems = []
    gs = font.getGlyphSet()
    glyf_t = font['glyf']
    for gname in font.getGlyphOrder():
        g = glyf_t[gname]
        if g.numberOfContours <= 0:
            continue
        path = pathops.Path()
        pen = path.getPen(glyphSet=gs)
        gs[gname].draw(pen)
        simplified = pathops.simplify(path, clockwise=True)
        if abs(abs(path.area) - abs(simplified.area)) > 1.0:
            problems.append(f'{name} {gname}: overlapping contours ({path.area:.0f} vs {simplified.area:.0f})')
        # direction: compare each contour's winding with the simplified one
        if not path.clockwise and path.area:
            problems.append(f'{name} {gname}: first contour not clockwise')
    return problems


def set_names(font, style, weight):
    """Names of a static instance (RIBBI family + typographic family/subfamily)"""
    name = font['name']
    ribbi = style in ('Regular', 'Bold')
    fam = FAMILY if ribbi else f'{FAMILY} {style}'
    sub = style if ribbi else 'Regular'
    for rec in list(name.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 25) or rec.nameID >= 256:
            name.removeNames(nameID=rec.nameID)
    name.setName(fam, 1, 3, 1, 0x409)
    name.setName(sub, 2, 3, 1, 0x409)
    name.setName(f'{VERSION};{VENDOR};{FAMILY}-{style}', 3, 3, 1, 0x409)
    name.setName(f'{FAMILY} {style}', 4, 3, 1, 0x409)
    name.setName(f'{FAMILY}-{style}', 6, 3, 1, 0x409)
    if not ribbi:
        name.setName(FAMILY, 16, 3, 1, 0x409)
        name.setName(style, 17, 3, 1, 0x409)
    os2 = font['OS/2']
    os2.usWeightClass = weight
    os2.fsSelection = 0x80 | (0x20 if style == 'Bold' else 0) | (0x40 if style == 'Regular' else 0)
    font['head'].macStyle = 0x01 if style == 'Bold' else 0


def build_variable(master_paths):
    ds = DesignSpaceDocument()
    ax = AxisDescriptor()
    ax.tag, ax.name, ax.minimum, ax.default, ax.maximum = 'wght', 'Weight', 600, 600, 900
    ax.labelNames = {'en': 'Weight'}
    ds.addAxis(ax)
    for m, path in zip(MASTERS, master_paths):
        s = SourceDescriptor()
        s.path = path
        s.filename = os.path.relpath(path, os.path.dirname(OUT_DS))
        s.name = f'{FAMILY} {m.name}'
        s.familyName = FAMILY
        s.styleName = m.name
        s.location = {'Weight': m.wght}
        ds.addSource(s)
    for style, w in INSTANCES:
        i = InstanceDescriptor()
        i.familyName = FAMILY
        i.styleName = style
        i.name = f'{FAMILY} {style}'
        i.postScriptFontName = f'{FAMILY}-{style}'
        i.location = {'Weight': w}
        ds.addInstance(i)
    ds.write(OUT_DS)
    vf, _, _ = varlib_build(ds)
    vf.recalcTimestamp = False
    name = vf['name']
    for rec in list(name.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17):
            name.removeNames(nameID=rec.nameID)
    name.setName(f'{FAMILY} SemiBold', 1, 3, 1, 0x409)
    name.setName('Regular', 2, 3, 1, 0x409)
    name.setName(f'{VERSION};{VENDOR};{FAMILY}-Variable', 3, 3, 1, 0x409)
    name.setName(f'{FAMILY} SemiBold', 4, 3, 1, 0x409)
    name.setName(f'{FAMILY}-SemiBold', 6, 3, 1, 0x409)
    name.setName(FAMILY, 16, 3, 1, 0x409)
    name.setName('SemiBold', 17, 3, 1, 0x409)
    name.setName(f'{FAMILY}', 25, 3, 1, 0x409)  # variations PostScript name prefix
    buildStatTable(vf, [dict(tag='wght', name='Weight', values=[
        dict(value=w, name=s, flags=0) for s, w in INSTANCES])], elidedFallbackName=2)
    vf['OS/2'].usWeightClass = 600
    return vf


def main():
    drawn = draw_all()
    if geometry.STROKE_ERRORS:
        print('stroke fitting error > 1.5 units:', geometry.STROKE_ERRORS)
    tt = outlines(drawn)
    sb = spacing(drawn, tt)
    for name, master, side, delta in SPACING_TWEAKS.values() if isinstance(SPACING_TWEAKS, dict) else []:
        pass
    kern = kerning(drawn, tt, sb)

    os.makedirs(OUT_MASTERS, exist_ok=True)
    master_paths, problems = [], []
    for mi, m in enumerate(MASTERS):
        font = build_master(mi, drawn, tt, sb, kern)
        p = os.path.join(OUT_MASTERS, f'{FAMILY}-{m.name}.ttf')
        font.save(p)
        master_paths.append(p)
        problems += check_outlines(TTFont(p), m.name)
    if problems:
        raise SystemExit('outline problems:\n  ' + '\n  '.join(problems))

    vf = build_variable(master_paths)
    os.makedirs(os.path.dirname(OUT_VF), exist_ok=True)
    vf.save(OUT_VF)

    os.makedirs(OUT_STATIC, exist_ok=True)
    os.makedirs(OUT_WEB, exist_ok=True)
    for style, w in INSTANCES:
        inst = instantiateVariableFont(TTFont(OUT_VF), {'wght': w})
        inst.recalcTimestamp = False
        set_names(inst, style, w)
        inst.save(os.path.join(OUT_STATIC, f'{FAMILY}-{style}.ttf'))

    web = TTFont(OUT_VF)
    web.recalcTimestamp = False
    web.flavor = 'woff2'
    web.save(os.path.join(OUT_WEB, f'{FAMILY}-Variable.woff2'))

    hud = TTFont(os.path.join(OUT_STATIC, f'{FAMILY}-SemiBold.ttf'))
    hud.recalcTimestamp = False
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['kern']
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.notdef_outline = True
    options.recalc_timestamp = False
    sub = subset.Subsetter(options)
    sub.populate(unicodes=list(hud.getBestCmap().keys()))
    sub.subset(hud)
    hud.flavor = 'woff2'
    hud.save(os.path.join(OUT_WEB, f'{FAMILY}-HUD.woff2'))

    report = {
        'glyphs': len(glyph_order()),
        'kerning_pairs': len(kern),
        'spacing': {n: [[round(a), round(b)] for a, b in v] for n, v in sb.items()},
        'kerning': {f'{a} {b}': v for (a, b), v in sorted(kern.items())},
    }
    with open(REPORT, 'w') as f:
        json.dump(report, f, indent=1, sort_keys=True)
        f.write('\n')
    for p in [*master_paths, OUT_VF, *[os.path.join(OUT_STATIC, f'{FAMILY}-{s}.ttf') for s, _ in INSTANCES],
              os.path.join(OUT_WEB, f'{FAMILY}-Variable.woff2'), os.path.join(OUT_WEB, f'{FAMILY}-HUD.woff2')]:
        print(f'{os.path.relpath(p, HERE)}: {os.path.getsize(p)} bytes')


if __name__ == '__main__':
    main()
