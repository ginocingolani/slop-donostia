"""Ateburu's OpenType layout, written as feature-file text: the substitutions (stylistic sets, character variants)
are the same in every master; the kerning values differ per master and come from build.py.

Lookups run in the order they appear here, so ss01 (which makes the dotted i) comes before cv01 and cv02 (which pick
its stem and its dot)."""
import glyphs as G

LETTERS = list('ABCDEFGHIJKLMNOPQRSTUVWXYZ') + ['OE', 'K.straight', 'K.roman']


def glyph_names():
    return set(G.GLYPHS) | {c[0] for c in G.COMPOSITES}


def letters():
    """Every glyph that is a letter (for the contexts of the dotted i)"""
    names = glyph_names()
    out = [n for n in LETTERS if n in names]
    out += [c[0] for c in G.COMPOSITES if c[0] in names and c[0] not in out]
    out += [n for n in sorted(names) if n.startswith(('i.', 'dotlessi.')) and n not in out]
    return out


def gsub():
    i_caps = ['I', 'Iacute', 'Igrave', 'Idieresis']
    i_lower = ['i', 'iacute', 'igrave', 'idieresis']
    short = ['i.short.lozenge'] + [f'i{a}.short' for a, _ in G.I_ACCENTS]
    L = []
    L.append(f'@LETTER = [{" ".join(letters())}];')
    L.append('')
    # ss01: the dotted i, Iparralde shop-sign style
    L.append('lookup IDOT {')
    for cap, low, dotted in zip(i_caps, i_lower, short):
        L.append(f'  sub [{cap} {low}] by {dotted};')
    L.append('} IDOT;')
    L.append('')
    L.append('feature ss01 {')
    L.append('  featureNames { name "Dotted i among capitals"; };')
    L.append(f'  sub [{" ".join(i_lower)}]\' lookup IDOT;')
    L.append(f'  sub @LETTER [{" ".join(i_caps)}]\' lookup IDOT;')
    L.append('} ss01;')
    L.append('')
    # cv01: the dotted i's stem
    L.append('feature cv01 {')
    L.append('  cvParameters {')
    L.append('    FeatUILabelNameID { name "Dotted i: stem"; };')
    L.append('    ParamUILabelNameID { name "Cap-height stem, dot above"; };')
    L.append('    ParamUILabelNameID { name "Short stem without serifs"; };')
    L.append('    ParamUILabelNameID { name "Cap-height stem without serifs"; };')
    L.append('  };')
    L.append('  sub i.short.lozenge from [i.tall.lozenge i.shortplain.lozenge i.tallplain.lozenge];')
    for a, _ in G.I_ACCENTS:
        cap = 'I' + a
        L.append(f'  sub i{a}.short from [{cap} i{a}.shortplain i{a}.tallplain];')
    L.append('} cv01;')
    L.append('')
    # cv02: the dotted i's dot
    L.append('feature cv02 {')
    L.append('  cvParameters {')
    L.append('    FeatUILabelNameID { name "Dotted i: dot"; };')
    L.append('    ParamUILabelNameID { name "Round dot"; };')
    L.append('    ParamUILabelNameID { name "Chisel-cut wedge"; };')
    L.append('  };')
    for st in G.I_STEMS:
        L.append(f'  sub i.{st}.lozenge from [i.{st}.round i.{st}.wedge];')
    L.append('} cv02;')
    L.append('')
    # cv03: K
    L.append('feature cv03 {')
    L.append('  cvParameters {')
    L.append('    FeatUILabelNameID { name "K"; };')
    L.append('    ParamUILabelNameID { name "Straight arm, kicked leg"; };')
    L.append('    ParamUILabelNameID { name "Plain inscription K"; };')
    L.append('  };')
    L.append('  sub K from [K.straight K.roman];')
    L.append('} cv03;')
    L.append('')
    L.append('feature ss04 {')
    L.append('  featureNames { name "Roman forms"; };')
    L.append('  sub K by K.roman;')
    L.append('} ss04;')
    L.append('')
    L.append('feature ss08 {')
    L.append('  featureNames { name "Straight-armed K"; };')
    L.append('  sub K by K.straight;')
    L.append('} ss08;')
    L.append('')
    return '\n'.join(L)
