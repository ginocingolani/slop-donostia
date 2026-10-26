#!/usr/bin/env python3
"""fonts/donostia-display/build.py

Builds Donostia Display, the HUD's display face: Marcellus (Brian J. Bonislawsky / Astigmatic, SIL OFL 1.1) with the
crowned A of Basque lettering, the flat bar over the apex that the carved inscriptions of Lapurdi, Behe Nafarroa and
Zuberoa keep from compressing TA / MA into one letter, renamed as the OFL requires of a modified font (Marcellus is a
Reserved Font Name) and subset to the Latin the HUD writes in Basque, Spanish, French and English.

The output (DonostiaDisplay-Regular.woff2) is committed, so the app needs nothing from here. To rebuild:

    python3 -m venv .venv && .venv/bin/pip install fonttools==4.55.3 brotli==1.1.0 skia-pathops==0.8.0.post2
    .venv/bin/python fonts/donostia-display/build.py

The Marcellus source is fetched from google/fonts at a pinned commit and checked against its SHA-256, so the build
is reproducible byte for byte.
"""
import hashlib
import io
import os
import urllib.request

from fontTools import subset
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.removeOverlaps import removeOverlaps

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE_URL = ('https://raw.githubusercontent.com/google/fonts/90abd17b4f97671435798b6147b698aa9087612f/'
              'ofl/marcellus/Marcellus-Regular.ttf')
SOURCE_SHA256 = '1cf0cd10b17d35e852729962cc1ffaffed94514895972458345e2df34abb2f81'
OUT = os.path.join(HERE, 'DonostiaDisplay-Regular.woff2')

FAMILY = 'Donostia Display'
COPYRIGHT = ('Copyright (c) 2012, Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved '
             'Font Names "Marcellus". Modified 2026 by the Slop Donostia contributors (crowned A); not Marcellus.')
# Basic Latin, Latin-1, the Œ ligature, typographic quotes & dashes, the ellipsis, the bullet and the middle dot
UNICODES = [*range(0x20, 0x7F), *range(0xA0, 0x100), 0x152, 0x153, 0x2013, 0x2014, 0x2018, 0x2019, 0x201A, 0x201C,
            0x201D, 0x201E, 0x2022, 0x2026, 0x20AC]


def fetch_source():
    req = urllib.request.Request(SOURCE_URL, headers={'User-Agent': 'slop-donostia font build'})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f'Marcellus-Regular.ttf: unexpected SHA-256 {digest}')
    return TTFont(io.BytesIO(data), recalcTimestamp=False)  # keep the source's dates: the same bytes every build


def glyph_outline(glyf, name):
    """The glyph's TrueType contours replayed into a RecordingPen (so they can be edited and added to)"""
    coords, ends, flags = glyf[name].getCoordinates(glyf)
    return [list(zip(coords[s:e + 1], flags[s:e + 1])) for s, e in zip([0, *[e + 1 for e in ends[:-1]]], ends)]


def replay(contours, pen):
    for contour in contours:
        k = next(i for i, (_, fl) in enumerate(contour) if fl & 1)  # start on an on-curve point
        contour = contour[k:] + contour[:k]
        pen.moveTo(contour[0][0])
        offs = []
        for p, fl in contour[1:] + contour[:1]:
            if not fl & 1:
                offs.append(p)
            elif offs:
                pen.qCurveTo(*offs, p)
                offs = []
            else:
                pen.lineTo(p)
        if offs:
            pen.qCurveTo(*offs, contour[0][0])
        pen.closePath()


def crown_a(font):
    """Marcellus's pointed A becomes the crowned A: the apex sinks under a flat bar on the cap line whose ends droop like
    bracketed serifs, and the counter rises to just under the bar. The accented As are composites of A and follow."""
    glyf = font['glyf']
    cap = font['OS/2'].sCapHeight  # 1434 of 2048
    contours = glyph_outline(glyf, 'A')
    apex_y = max(y for c in contours for (x, y), _ in c)
    counter_top = max((p for p, _ in contours[1]), key=lambda p: p[1])
    contours = [[(((x, cap - 40) if y == apex_y else (x, y)), fl) for (x, y), fl in c] for c in contours]
    contours[1] = [((counter_top[0], 1262) if p == counter_top else p, fl) for p, fl in contours[1]]

    rec = RecordingPen()
    replay(contours, rec)
    # the bar, clockwise (an outer contour in TrueType): 800 units wide, 120 thick in the middle, 196 at the ends
    c, half, top = 697, 400, cap
    left, right, mid, end = c - half, c + half, top - 120, top - 196
    rec.moveTo((left, top))
    rec.lineTo((right, top))
    rec.lineTo((right - 14, end))
    rec.qCurveTo((right - 120, mid), (right - 270, mid))
    rec.lineTo((left + 270, mid))
    rec.qCurveTo((left + 120, mid), (left + 14, end))
    rec.closePath()

    pen = TTGlyphPen(None)
    rec.replay(pen)
    glyf['A'] = pen.glyph()
    removeOverlaps(font, ['A'])
    glyf['A'].recalcBounds(glyf)


def rename(font):
    names = {0: COPYRIGHT, 1: FAMILY, 2: 'Regular', 3: f'{FAMILY} Regular 1.000', 4: f'{FAMILY} Regular',
             5: 'Version 1.000; a modified Marcellus', 6: 'DonostiaDisplay-Regular', 16: FAMILY, 17: 'Regular'}
    table = font['name']
    keep = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17}
    table.names = [n for n in table.names if n.nameID in keep]
    for n in table.names:
        if n.nameID in names:
            n.string = names[n.nameID]
    # name 7 (trademark) & 8, 9 (manufacturer, designer) stay: the design is Brian J. Bonislawsky's


def main():
    font = fetch_source()
    crown_a(font)
    rename(font)
    font['head'].fontRevision = 1.0
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['kern', 'liga', 'case', 'locl']
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.notdef_outline = True
    sub = subset.Subsetter(options)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    font.flavor = 'woff2'
    font.save(OUT)
    print(f'{os.path.relpath(OUT)}: {os.path.getsize(OUT)} bytes')


if __name__ == '__main__':
    main()
