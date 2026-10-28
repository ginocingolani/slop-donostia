# Ateburu

Ateburu (*ate* "door" + *buru* "head": the lintel over a Basque house door) is a display typeface drawn from the
lettering carved into the lintels, stelae and slabs of the Basque Country between the 16th and 19th centuries. It is
heavy, wide and low in contrast, with short flared serifs that read as cut rather than painted. Its Basque character
rides on a handful of letters (the crowned A, the long-legged R, the curved K, the wedge-armed E and F, the spurred G,
the open 4, the flat-topped 5, the swan-necked 7 and the lozenge interpunct); everything else stays calm and Roman.

It was made first for the place names in Slop Donostia's HUD (light text on a dark translucent panel, 11–44 px), and is
published under the SIL Open Font License so that others have a properly licensed Basque display face. **Version
0.200**: capitals (a unicase face), GF Latin Core, two axes (weight and curvature) and the inscription forms behind
OpenType features; see "Glyph set" and "OpenType features" below.

Open [`specimen.html`](specimen.html) in a browser to see it at work.

## Files

| Path | What |
|---|---|
| `variable/Ateburu[CURV,wght].ttf` | The variable font: `wght` 600–900, `CURV` 0–100 |
| `static/Ateburu-SemiBold.ttf` … `-Black.ttf` | Static instances at CURV 0, autohinted: SemiBold 600 (the HUD weight), Bold 700, ExtraBold 800, Black 900 |
| `webfonts/Ateburu-Variable.woff2` | The variable font for the web (about 57 KB) |
| `webfonts/Ateburu-HUD.woff2` | SemiBold, subset to the letters and punctuation of place names, for Slop Donostia's HUD (about 7.5 KB) |
| `source/*.py` | The source: every glyph is drawn in code (see "How it is made") |
| `source/Ateburu.designspace`, `source/masters/` | Four masters: HUD (600) and Black (900), each straight (CURV 0) and curved (CURV 100) |
| `source/qa.py`, `source/build-report.json` | Outline checks; the spacing, kerning and check results of the last build |
| `build.py` | Builds everything above, reproducibly |
| `specimen.html` | Specimen: test strings at 12–96 px, both axes, the OpenType features, the glyph set |
| `SOURCES.md` | For every identity glyph and alternate, the inscriptions it is drawn from |
| `FONTLOG.txt`, `OFL.txt` | History and licence |

## Using it

```css
@font-face {
  font-family: 'Ateburu';
  src: url('webfonts/Ateburu-Variable.woff2') format('woff2');
  font-weight: 600 900;
  font-display: swap;
}
.place {
  font-family: 'Ateburu', serif;
  font-weight: 600;                          /* the wght axis */
  font-variation-settings: "CURV" 60;        /* the curvature axis */
  font-feature-settings: "ss01", "dlig";     /* dotted i, nexus letters */
  letter-spacing: 0.05em;
}
```

Small light-on-dark text should use the SemiBold (600): light on dark looks heavier than it is. The face is spaced for
display; at 12–16 px a little tracking (4–8 %) helps. Lowercase letters map to the same capitals, so mixed-case data
comes out in capitals without any `text-transform` (the lowercase codepoints that have inscription forms, e n m d t z
r h q b, take them only under `ss03`). `font-feature-settings` and `font-variation-settings` each replace the whole
list: set every tag you want in one declaration.

### Axes

| Tag | Name | Range | Default | |
|---|---|---|---|---|
| `wght` | Weight | 600–900 | 600 | Named instances SemiBold 600, Bold 700, ExtraBold 800, Black 900 |
| `CURV` | Curvature | 0–100 | 0 | 0 is the straight cut. Towards 100 the stroke ends flare over their last third (stems stay straight in the middle), wedge ends curve into their arms like brackets, T's arms droop and E, F, L, Z bend a touch, A V W Y legs bow, X bends into a gentle S, R and K legs run rounder into a longer flick. STAT names: 0 Straight, 50 Carved, 100 Curved |

`CURV` is a private axis (upper case tag), so set it with `font-variation-settings`. For display sizes 50–60 comes
closest to the stones' flare; at HUD sizes (12–17 px) 40 softens the stroke ends without losing anything.

### OpenType features

| Feature | What it does |
|---|---|
| `kern`, `mark`, `mkmk`, `ccmp` | Kerning (about 4,200 pairs); combining accents on every capital, stacking; a dotted i drops its dot under an accent |
| `locl` (Catalan) | `L·L` becomes Ŀ + L, so the punt volat sits between the two Ls |
| `calt` (on by default) | The A's crown turns its long end right after T, V, W, Y; R and K take a shorter leg before A, T, V, W, Y, J |
| `dlig` | Nexus letters: TX TZ TS TA TE TR (the T's bar runs on over the next letter), NE ND ME (a shared stem), DE (E inside D), LA, AN, MA |
| `ss01` | Dotted i: every lowercase i, and every capital I after a letter, becomes the dotted minuscule at cap height (DONOSTiA, IBAiA); a word-initial I stays a capital |
| `cv01`, `cv02` | With ss01, the dotted i's stem (0 short with serifs, 1 cap height with the dot above, 2 short plain, 3 cap height plain) and dot (0 lozenge, 1 round, 2 wedge) |
| `ss02` | A small o tucked after L, T, K and R |
| `ss03` | Inscription unicase: the lowercase codepoints e n m d t z r h q b take the minuscule forms the stones mix among capitals (an uncial e, a Π-shaped n, a three-legged m, ∂, a t with a curled foot, ʒ, an r with an ear, h, b, q) |
| `ss04` | Roman forms: an A without the crown and with a straight crossbar, an R with a straight leg, the plain K |
| `ss05` | Plain figures for data: a closed 4, a 5 without the wedge, a straight 7 |
| `ss06` | Curiosities of the stones: 8 for G, reversed N S D E, the barred I, V for U |
| `ss08`, `cv03` | K: `ss08` or `"cv03" 1` the straight-armed K; `"cv03" 2` the plain K |
| `tnum`, `pnum` | Tabular and proportional figures |

No `case` feature: the punctuation already sits on the capitals (brackets span the cap height, ¿ ¡ « » – and the
maths signs are centred on it).

**Known issue (Chrome).** In Chrome on macOS, a word that a page shapes once without a feature is sometimes drawn the
same way where another element sets `font-feature-settings` on the same word (seen with `ss04`, `ss05`, `ss08`,
`cv03`). The font is right (HarfBuzz shapes every feature as it should); pages that compare a word with and without a
feature can declare a second `@font-face` family over the same file for the "with" side, as `specimen.html` does.

### The HUD subset

`webfonts/Ateburu-HUD.woff2` is the SemiBold at CURV 0 with kerning only. Two switches at the top of `build.py`
change it without touching anything else: `HUD_CURV` (0–100) builds it at that curvature, and `HUD_SS01 = True`
bakes the dotted i in as a required feature, so it applies with no CSS, under letter-spacing (which turns `calt` off)
and in canvas text.

## The tradition, and an honest note on it

The letters are real. From the 16th century on, and above all in the 17th, the stonecutters of Lapurdi, Behe Nafarroa
and Zuberoa (and of Navarre and Gipuzkoa) cut names, dates and devotions in relief, clearing the ground around the
letters. Relief carving makes heavy, even strokes, wide letters and wedge-like serifs; it also produced the forms that
are now read as "Basque": an A crowned by a flat bar, often with a crossbar that dips, Rs whose legs run out past the
bowl, lozenge points between words, open 4s and swan-necked 7s in the dates. Louis Colas drew hundreds of these stones
in *La tombe basque* (Biarritz, 1923), and his drawings are this face's main source.

The *idea* of one Basque letter is modern. Between about 1890 and 1936 the Basque Renaissance selected some of these
forms and made them an emblem (mastheads, institutional logos, Txiki Zabalo's posters); the style was then kept in
exile, revived by commercial sign-painting in the late Franco years, politicised in the Transition, and finally
institutionalised and commodified. Eduardo Herrera (2004) and Johan Järlehed (2012) describe *letra vasca* as an
"invented tradition" in Hobsbawm's sense: old letterforms, a new canon. Some of what people now take as typical is
20th-century convention: the curled K above all (old Basque spelling hardly used K: *HERRIAC*, 1652; *ANHAVSCO*,
1751), and the exaggerated, flicked R leg. The TX, TZ and TS nexus letters join modern (batua) digraphs; the stones
wrote CH, TCH and TZ.

So Ateburu does not claim to be "the authentic Basque letter" or to go back to the 8th century. It is a contemporary
display face that reads the documented inscriptions, says where each identity form comes from (`SOURCES.md`), and owns
its modern conventions as such. Please present it that way.

## How it is made

There are no drawings to trace: every glyph is a Python function that builds its outline from a master's parameters
(`source/glyphs.py` for the letters and figures, `latin.py` for the extended Latin letters and the accented
composites, `marks.py` for the accents, `symbols.py` for the rest of the punctuation, `alternates.py`, `nexus.py` and
`unicase.py` for what the features reach, `features.py` for the OpenType code) with a small toolkit
(`source/geometry.py`):

- **serifed stems** with bracketed, flared serifs, **diagonals** with serifs bracketed into their edges, **bars**
  whose ends are cut as wedges, **ovals**, and **strokes** expanded from a spine with an elliptical nib (wider than
  tall, so verticals are heavier than horizontals) for S, J, the figures, the R and K legs, & and ?; with curvature,
  stems flare towards their ends and bars and diagonals bend along a parabola;
- the parts are joined with skia-pathops; the four masters' outlines are aligned contour by contour: runs of one to
  three segments of one master are matched against runs of the other by dynamic programming, laid on a common arc
  length and cut at the union of their vertices, then converted to quadratics together with cu2qu and rounded once,
  keeping smooth points smooth;
- the side bearings follow an optical model (the white at each side, clipped to a shallow depth from the side's
  outermost point, equals a serifed stem's), and the kerning gives every pair the same white as HH without letting
  any two letters come closer than a minimum gap; the Basque digraphs TX, TZ and TS are kerned like the rest.

`build.py` writes the masters, the designspace, the variable font, the static instances (autohinted with ttfautohint)
and the web fonts. It fails if an outline runs the wrong way, contours overlap or the masters don't interpolate,
checking the masters, the statics and a grid of instances across both axes (wght 600–900 × CURV 0–100). Running it
twice gives the same bytes:

```sh
python3 -m venv .venv && .venv/bin/pip install fonttools==4.55.3 skia-pathops==0.8.0.post2 brotli==1.1.0 \
    ttfautohint-py==0.6.1
.venv/bin/python fonts/ateburu/build.py
```

To change a letter, edit its function and rebuild (about 40 s); `specimen.html` shows the result.

## Metrics

UPM 1000. Cap height 720 (caps-only face, so the x-height is set to the cap height too). Overshoot 13 for rounds, 6
for pointed vertices. Accents reach 928 (the ring; 944 in the Black); the comma below goes down to −266 (−296 in the
Black). Ascender 930, descender −230,
line gap 0 (typo metrics, used): `line-height: normal` is 1.16, and the capitals sit centred in the line, so 1.15–1.2
works with accented capitals. Windows metrics are the family's extremes (944 / 296) in every file.

| | HUD (600) | Black (900) |
|---|---|---|
| Vertical stem | 120 | 184 |
| Horizontal stroke | 100 | 148 |
| Thick / thin diagonal | 120 / 100 | 182 / 146 |
| Serif reach / height of bracket | 32 / 84 | 36 / 98 |
| Advance of H / O / A | 706 / 771 / 789 | 746 / 790 / 900 |

Ink traps are cut where the A's crossbar meets its legs and where the K's arm meets the stem: 15 units deep in the HUD
master, vestigial (4 units) in the Black, where they would show.

## Glyph set (v0.2)

350 glyphs, 352 codepoints. All of Google Fonts' GF Latin Core (glyphsets 1.0.0): A–Z (lowercase a–z map to the
same capitals), the accented capitals of the Western and Central European languages and their lowercase codepoints,
Æ Œ Ø Þ Ð Đ Ħ Ł Ŀ ẞ, figures 0–9 (proportional and tabular), the combining accents and their spacing forms, ◌, and
the punctuation and symbols (`. , : ; … ! ? ¡ ¿ ' " ‘ ’ ‚ “ ” „ « » ‹ › - – — ( ) [ ] { } / \ | & @ # % * + − × ÷ =
< > ^ ~ _ ° § ¶ © ® ™ $ € £ ¥ ¢ ª º • ·`). Beyond it: Ꝑ (U+A750, the per/pro abbreviation), and the alternates the
features reach.

Not yet: arrows and ± (the HUD helpers in the design brief), the Latin-1 signs outside GF Latin Core (¤ ¦ ¬ µ, the
superiors and the fractions), the word-separator and star ornaments (an `ss07` of separators), Arbizu-style cycling of
A, R and E variants, and the AR nexus (the A's slanted leg makes no convincing R stem in this design). See
`FONTLOG.txt`.

## Name

"Ateburu" is a working name, kept in one constant (`FAMILY` in `build.py`) and in the output file names. There is
no Reserved Font Name, so modified or subset versions may keep the name.

## Licence

Copyright 2026 The Ateburu Project Authors. Licensed under the SIL Open Font License 1.1, with no Reserved Font Name:
see [`OFL.txt`](OFL.txt). The fonts are not covered by the repository's MIT licence.

## Credits

- **Louis Colas**, *La Tombe basque. Recueil d'inscriptions funéraires et domestiques du Pays Basque français*,
  Biarritz, 1923 (public domain): the drawings of dated inscriptions that the identity forms are drawn from.
- The carvers of the lintels and stelae of Lapurdi, Behe Nafarroa, Zuberoa, Navarre and Gipuzkoa, whose names are
  mostly lost.
- Photographs on Wikimedia Commons used as reference only (not reproduced): see `SOURCES.md`.
- The research and critique behind the design: Edorta Kortadi's *Grafía vasca* (Auñamendi), Eduardo Herrera's *La
  "letra vasca". Etnicidad y cultura tipográfica* (2004), Johan Järlehed's work on *letra vasca* as invented tradition
  (2012–2017), and Martín Odriozola's *Hizki* thesis (EINA, 2019), read as critique only.
- No existing font was traced or copied (not Vasca, Harri, the Euskara family, Hizki, Urkiola or any other); nor were
  the Zabalo plates (1947), which are still in copyright in Spain.
