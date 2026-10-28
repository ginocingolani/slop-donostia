"""Ateburu's OpenType layout, written as feature-file text: the substitutions (stylistic sets, character variants)
are the same in every master; the kerning values differ per master and come from build.py.

Lookups run in the order they appear here, so ss01 (which makes the dotted i) comes before cv01 and cv02 (which pick
its stem and its dot)."""
import glyphs as G

LETTERS = list('ABCDEFGHIJKLMNOPQRSTUVWXYZ') + ['OE', 'AE', 'Oslash', 'Thorn', 'Eth', 'Dcroat', 'Hbar', 'Lslash', 'Ldot',
                                               'Germandbls', 'K.straight', 'K.roman']


def glyph_names():
    return set(G.GLYPHS) | {c[0] for c in G.COMPOSITES}


def letters():
    """Every glyph that is a letter (for the contexts of the dotted i)"""
    names = glyph_names()
    out = [n for n in LETTERS if n in names]
    out += [c[0] for c in G.COMPOSITES if c[2] is not None and c[0] in names and c[0] not in out]
    out += [n for n in sorted(names) if n.startswith(('i.', 'dotlessi.')) and n not in out]
    return out


def gsub():
    i_caps = ['I', 'Iacute', 'Igrave', 'Idieresis', 'Icircumflex']
    i_lower = ['i', 'iacute', 'igrave', 'idieresis', 'icircumflex']
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
    L.append('feature ss08 {')
    L.append('  featureNames { name "Straight-armed K"; };')
    L.append('  sub K by K.straight;')
    L.append('} ss08;')
    L.append('')
    return '\n'.join(L)


def mark_bases():
    """The glyphs that take combining marks: the letters drawn as such and their plain copies"""
    names = glyph_names()
    out = [n for n in LETTERS if n in names]
    out += [n for n in G.GLYPHS if n.startswith(('i.', 'dotlessi.')) and n not in out]
    out += [c[0] for c in G.COMPOSITES if c[2] is not None and c[3] is None and c[0] not in out]
    return out


def gdef():
    import marks as MK
    names = glyph_names()
    import nexus as NX
    marks_ = [n for n in MK.MARK_CLASS if n in names]
    ligs = [n for n, _ in NX.NEXUS if n in names]
    bases = sorted(n for n in names if n not in marks_ and n not in ligs)
    return ('table GDEF {\n  GlyphClassDef [' + ' '.join(bases) + '], [' + ' '.join(ligs) + '], [' + ' '.join(marks_)
            + '], ;\n} GDEF;\n')


def marks(anchors, mark_tops, cap, mark_class, mkmk_gap, accent_gap):
    """mark: every combining mark onto every letter, by anchor class; mkmk: top marks stack, bottom marks too"""
    L = []
    attach = {'top': cap, 'bottom': 0, 'ogonek': 0, 'caron': cap}
    base_y = lambda b, cls: int(round(anchors[b].get('top_y', cap))) if cls == 'top' else attach[cls]  # noqa
    for cls in ('top', 'bottom', 'ogonek', 'caron'):
        members = [n for n, c in mark_class.items() if c == cls]
        L.append(f'markClass [{" ".join(members)}] <anchor 0 {attach[cls]}> @MC_{cls};')
    L.append('feature mark {')
    for b in mark_bases():
        a = anchors[b]
        parts = ' '.join(f'<anchor {int(round(a[cls]))} {base_y(b, cls)}> mark @MC_{cls}'
                         for cls in ('top', 'bottom', 'ogonek', 'caron'))
        L.append(f'  pos base {b} {parts};')
    # precomposed letters take a further accent above their own (a top mark) or at their base's anchors
    for name, unis, b, mk, place in G.COMPOSITES:
        if b is None or not mk or place in ('spacing', 'tab', 'short') or name not in anchors:
            continue
        a = anchors[name]
        ys = {cls: base_y(name, cls) for cls in ('top', 'bottom', 'ogonek', 'caron')}
        if mark_class.get(mk) == 'top' and mk in mark_tops:
            ys['top'] = int(round(mark_tops[mk] + mkmk_gap - accent_gap))
        parts = ' '.join(f'<anchor {int(round(a[cls]))} {ys[cls]}> mark @MC_{cls}'
                         for cls in ('top', 'bottom', 'ogonek', 'caron'))
        L.append(f'  pos base {name} {parts};')
    L.append('} mark;')
    L.append('feature mkmk {')
    for n, top in mark_tops.items():
        L.append(f'  pos mark {n} <anchor 0 {int(round(top + mkmk_gap - accent_gap))}> mark @MC_top;')
    for n, c in mark_class.items():
        if c == 'bottom':
            L.append(f'  pos mark {n} <anchor 0 -150> mark @MC_bottom;')
    L.append('} mkmk;')
    return '\n'.join(L) + '\n'


def family(base):
    """A base glyph and every composite built on it (accented forms), in a stable order"""
    return [base] + [c[0] for c in G.COMPOSITES if c[2] == base and c[3] and c[4] != 'tab']


def locl():
    """Catalan: L·L (ela geminada) sets the first L as Ŀ, the dot in its angle"""
    return '\n'.join([
        'lookup LDOT {', '  sub L periodcentered by Ldot;', '} LDOT;',
        'feature locl {', '  script latn;', '  language CAT exclude_dflt;',
        "  sub L' lookup LDOT periodcentered' L;", '} locl;', ''])


def gsub2():
    import alternates as ALT
    names = glyph_names()
    L = []
    a_fam = family('A')
    tvwy = [n for b in 'TVWY' for n in family(b)]
    r_fam = family('R')
    k_fam = ['K', 'K.straight'] + [n for n in family('K') if n != 'K']
    # ss04 first, so that calt finds the Roman forms already in place
    L.append('feature ss04 {')
    L.append('  featureNames { name "Roman forms: A without the crown, straight-legged R, plain K"; };')
    L.append(f'  sub [{" ".join(a_fam)}] by [{" ".join(n + ".roman" if n != "A" else "A.roman" for n in a_fam)}];')
    L.append(f'  sub [{" ".join(r_fam)}] by [{" ".join(n + ".roman" if n != "R" else "R.roman" for n in r_fam)}];')
    kk = family('K')
    L.append(f'  sub [{" ".join(kk)}] by [{" ".join(n + ".roman" if n != "K" else "K.roman" for n in kk)}];')
    L.append('} ss04;')
    L.append('')
    # dlig: the nexus letters (before calt, which would otherwise turn the A of TA first)
    import nexus as NX
    L.append('feature dlig {')
    for name, letters in NX.NEXUS:
        L.append(f'  sub {" ".join(letters)} by {name};')
    L.append('} dlig;')
    L.append('')
    # calt
    nxt = a_fam + [n + '.r' if n != 'A' else 'A.r' for n in a_fam] + tvwy + ['J']
    L.append(f'@CALT_A = [{" ".join(a_fam)}];')
    L.append(f'@CALT_A_R = [{" ".join(n + ".r" if n != "A" else "A.r" for n in a_fam)}];')
    L.append(f'@CALT_TVWY = [{" ".join(tvwy)}];')
    L.append(f'@CALT_NEXT = [{" ".join(nxt)}];')
    r_short = [n + '.short' if n != 'R' else 'R.short' for n in r_fam]
    k_src = ['K', 'K.straight'] + [n for n in family('K') if n != 'K']
    k_short = ['K.short', 'K.straight.short'] + [n + '.short' for n in family('K') if n != 'K']
    L.append('feature calt {')
    L.append('  # the crowned A turns its long end to the right after a letter whose arm overhangs it')
    L.append("  sub @CALT_TVWY @CALT_A' by @CALT_A_R;")
    L.append('  # R and K take a short leg before a letter that opens at the foot')
    L.append(f"  sub [{' '.join(r_fam)}]' @CALT_NEXT by [{' '.join(r_short)}];")
    L.append(f"  sub [{' '.join(k_src)}]' @CALT_NEXT by [{' '.join(k_short)}];")
    L.append('} calt;')
    L.append('')
    # ss02: the small o after the open letters
    left = (family('L') + ['Lslash', 'Ldot'] + family('T') + family('K') + ['K.straight', 'K.roman', 'K.short',
            'K.straight.short'] + family('R') + ['R.short', 'R.roman'])
    left = [n for n in dict.fromkeys(left) if n in names]
    L.append('feature ss02 {')
    L.append('  featureNames { name "Small o tucked after L, T, K, R"; };')
    L.append(f"  sub [{' '.join(left)}] O' by o.small;")
    L.append('} ss02;')
    L.append('')
    # ss03: inscription unicase, from the lowercase codepoints
    import unicase as UC
    L.append('feature ss03 {')
    L.append('  featureNames { name "Inscription unicase: e n m d t z r h q b typed in lowercase"; };')
    L.append(f'  sub [{" ".join(UC.UNICASE)}] by [{" ".join(c + ".unc" for c in UC.UNICASE)}];')
    L.append('} ss03;')
    L.append('')
    # ss05: plain figures
    L.append('feature ss05 {')
    L.append('  featureNames { name "Plain figures: closed 4, straight 7, plain 5"; };')
    L.append('  sub four by four.ss05;')
    L.append('  sub seven by seven.ss05;')
    L.append('  sub five by five.ss05;')
    L.append('} ss05;')
    L.append('')
    # ss06: curiosities
    L.append('feature ss06 {')
    L.append('  featureNames { name "Curiosities of the stones: 8 for G, reversed N S D E, barred I, V for U"; };')
    for g in ('G', 'N', 'S', 'D', 'E', 'I', 'U'):
        L.append(f'  sub {g} by {g}.ss06;')
    L.append('} ss06;')
    L.append('')
    # figures
    figs = ALT.FIGURES
    L.append('feature tnum {')
    L.append(f'  sub [{" ".join(figs)}] by [{" ".join(f + ".tf" for f in figs)}];')
    L.append('} tnum;')
    L.append('feature pnum {')
    L.append(f'  sub [{" ".join(f + ".tf" for f in figs)}] by [{" ".join(figs)}];')
    L.append('} pnum;')
    L.append('')
    # ccmp: a dotted i followed by a top mark loses its dot
    tops = ' '.join(n for n, c in __import__('marks').MARK_CLASS.items() if c == 'top')
    L.append(f'@CCMP_TOP = [{tops}];')
    L.append('feature ccmp {')
    for st in G.I_STEMS:
        dotless = 'I' if st == 'tall' else f'dotlessi.{st}'
        L.append(f"  sub [{' '.join(f'i.{st}.{dt}' for dt in G.I_DOTS)}]' @CCMP_TOP by {dotless};")
    L.append('} ccmp;')
    L.append('')
    return '\n'.join(L)
