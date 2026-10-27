"""Outline checks for the built TrueType fonts: direction, overlaps, extremes, kinks and stubs.

Hard errors (wrong direction, overlapping contours, open or degenerate contours) fail the build. Soft findings are
written to the build report so they can be reviewed: a curve bulging past its end points without a point at the
extreme, a corner that is almost (but not quite) smooth, a segment shorter than 3 units.
"""
import math

import pathops


def _contours(glyph, glyf):
    coords, ends, flags = glyph.getCoordinates(glyf)
    out, start = [], 0
    for e in ends:
        out.append([(tuple(coords[i]), bool(flags[i] & 1)) for i in range(start, e + 1)])
        start = e + 1
    return out


def _segments(contour):
    """(kind, points) with implied on-curve points made explicit: ('L', (p0, p1)) or ('Q', (p0, c, p1))"""
    pts = contour
    k = next(i for i, (_, on) in enumerate(pts) if on)
    pts = pts[k:] + pts[:k]
    segs = []
    cur = pts[0][0]
    offs = []
    for p, on in pts[1:] + pts[:1]:
        if on:
            if not offs:
                segs.append(('L', (cur, p)))
            else:
                ons = [cur] + [((offs[j][0] + offs[j + 1][0]) / 2, (offs[j][1] + offs[j + 1][1]) / 2)
                               for j in range(len(offs) - 1)] + [p]
                for j, c in enumerate(offs):
                    segs.append(('Q', (ons[j], c, ons[j + 1])))
                offs = []
            cur = p
        else:
            offs.append(p)
    return segs


def _angle(v):
    return math.atan2(v[1], v[0])


def check_font(font):
    errors, notes = [], []
    glyf = font['glyf']
    gs = font.getGlyphSet()
    for name in font.getGlyphOrder():
        g = glyf[name]
        if g.numberOfContours <= 0:
            continue
        path = pathops.Path()
        gs[name].draw(path.getPen(glyphSet=gs))
        simp = pathops.simplify(path, clockwise=True)
        if abs(abs(path.area) - abs(simp.area)) > 2.0:
            errors.append(f'{name}: overlapping contours')
        if path.area and not path.clockwise:
            errors.append(f'{name}: outer contour runs counter-clockwise')
        for ci, c in enumerate(_contours(g, glyf)):
            if len(c) < 3:
                errors.append(f'{name}: degenerate contour {ci}')
                continue
            segs = _segments(c)
            for kind, pts in segs:
                if kind == 'Q':
                    p0, cc, p1 = pts
                    for ax in (0, 1):
                        lo, hi = min(p0[ax], p1[ax]), max(p0[ax], p1[ax])
                        # the quadratic's extreme along this axis, if it lies inside the segment
                        den = p0[ax] - 2 * cc[ax] + p1[ax]
                        if den:
                            t = (p0[ax] - cc[ax]) / den
                            if 0 < t < 1:
                                v = (1 - t) ** 2 * p0[ax] + 2 * (1 - t) * t * cc[ax] + t * t * p1[ax]
                                if v < lo - 1.0 or v > hi + 1.0:
                                    notes.append(f'{name}: extreme without a point near ({p0[0]}, {p0[1]})')
                length = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])
                if length < 3 and kind == 'L':
                    notes.append(f'{name}: {length:.1f}-unit stub at {pts[0]}')
            # corners that are nearly smooth: tangent change between 1 and 9 degrees at an on-curve point
            n = len(segs)
            for i in range(n):
                a, b = segs[i], segs[(i + 1) % n]
                pa, pb = a[1], b[1]
                tin = (pa[-1][0] - pa[-2][0], pa[-1][1] - pa[-2][1])
                tout = (pb[1][0] - pb[0][0], pb[1][1] - pb[0][1])
                if math.hypot(*tin) < 1e-6 or math.hypot(*tout) < 1e-6:
                    continue
                d = abs((_angle(tout) - _angle(tin) + math.pi) % (2 * math.pi) - math.pi)
                deg = math.degrees(d)
                if 1.5 < deg < 9 and (a[0] == 'Q' or b[0] == 'Q'):
                    notes.append(f'{name}: kink of {deg:.1f}° at {pa[-1]}')
    return errors, notes
