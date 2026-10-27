# Ateburu

Ateburu (*ate* "door" + *buru* "head": the lintel over a Basque house door) is a display typeface drawn from the
lettering carved into the lintels, stelae and slabs of the Basque Country between the 16th and 19th centuries. It is
heavy, wide and low in contrast, with short flared serifs that read as cut rather than painted. Its Basque character
rides on a handful of letters (the crowned A, the long-legged R, the curved K, the wedge-armed E and F, the spurred G,
the open 4, the flat-topped 5, the swan-necked 7 and the lozenge interpunct); everything else stays calm and Roman.

It was made first for the place names in Slop Donostia's HUD (light text on a dark translucent panel, 11–44 px), and is
published under the SIL Open Font License so that others have a properly licensed Basque display face. **Version
0.100**, a first cut for review: capitals only, see "Glyph set" below.

Open [`specimen.html`](specimen.html) in a browser to see it at work.

## Files

| Path | What |
|---|---|
| `variable/Ateburu[wght].ttf` | The variable font, `wght` 600–900 |
| `static/Ateburu-SemiBold.ttf` … `-Black.ttf` | Static instances: SemiBold 600 (the HUD weight), Bold 700, ExtraBold 800, Black 900 |
| `webfonts/Ateburu-Variable.woff2` | The variable font for the web |
| `webfonts/Ateburu-HUD.woff2` | SemiBold, subset for Slop Donostia's HUD (about 6 KB) |
| `source/glyphs.py`, `source/geometry.py` | The source: every letter is drawn in code (see below) |
| `source/Ateburu.designspace`, `source/masters/` | Two masters, HUD (600) and Black (900) |
| `source/qa.py`, `source/build-report.json` | Outline checks; the spacing, kerning and check results of the last build |
| `build.py` | Builds everything above, reproducibly |
| `specimen.html` | Specimen: test strings at 12–96 px, both masters, light on dark and dark on light, the glyph set |
| `SOURCES.md` | For every identity glyph, the inscriptions it is drawn from |
| `FONTLOG.txt`, `OFL.txt` | History and licence |

## Using it

```css
@font-face {
  font-family: 'Ateburu';
  src: url('webfonts/Ateburu-Variable.woff2') format('woff2');
  font-weight: 600 900;
  font-display: swap;
}
.place { font-family: 'Ateburu', serif; font-weight: 600; letter-spacing: 0.05em; }
```

Small light-on-dark text should use the SemiBold (600): light on dark looks heavier than it is. The face is spaced for
display; at 12–16 px a little tracking (4–8 %) helps. Lowercase letters map to the same capitals, so mixed-case data
comes out in capitals without any `text-transform`.

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
1751), and the exaggerated, flicked R leg.

So Ateburu does not claim to be "the authentic Basque letter" or to go back to the 8th century. It is a contemporary
display face that reads the documented inscriptions, says where each identity form comes from (`SOURCES.md`), and owns
its modern conventions as such. Please present it that way.

## How it is made

There are no drawings to trace: every glyph is a Python function (`source/glyphs.py`) that builds its outline from a
master's parameters with a small toolkit (`source/geometry.py`):

- **serifed stems** with bracketed, flared serifs and a slight waist, **diagonals** with serifs bracketed into their
  edges, **bars** whose ends are cut as wedges, **ovals**, and **strokes** expanded from a spine with an elliptical
  nib (wider than tall, so verticals are heavier than horizontals) for S, J, the figures, the R and K legs, & and ?;
- the parts are joined with skia-pathops; the two masters' outlines are aligned contour by contour (segments split
  where one master's booleans cut the outline in more places), converted to quadratics together with cu2qu, and
  rounded once, keeping smooth points smooth;
- the side bearings follow an optical model (the white at each side, clipped to a shallow depth from the side's
  outermost point, equals a serifed stem's), and the kerning gives every pair the same white as HH without letting
  any two letters come closer than a minimum gap; the Basque digraphs TX, TZ and TS are kerned like the rest.

`build.py` writes the masters, the designspace, the variable font, the static instances and the web fonts, and fails
if an outline runs the wrong way, contours overlap or the masters don't interpolate. Running it twice gives the same
bytes:

```sh
python3 -m venv .venv && .venv/bin/pip install fonttools==4.55.3 skia-pathops==0.8.0.post2 brotli==1.1.0
.venv/bin/python fonts/ateburu/build.py
```

To change a letter, edit its function in `source/glyphs.py` and rebuild; `specimen.html` shows the result.

## Metrics

UPM 1000. Cap height 720 (caps-only face, so the x-height is set to the cap height too). Overshoot 13 for rounds, 6
for pointed vertices. Accents reach 930; the cedilla and the tail of Q go down to −172. Ascender 930, descender −230, line gap 0:
`line-height: normal` is 1.16, and the capitals sit centred in the line, so 1.15–1.2 works with accented capitals.

| | HUD (600) | Black (900) |
|---|---|---|
| Vertical stem | 120 | 184 |
| Horizontal stroke | 100 | 148 |
| Round sides / tops | 130 / 96 | 198 / 140 |
| Serif reach / height of bracket | 32 / 84 | 36 / 98 |
| Advance of H / O / A | 706 / 772 / 788 | 746 / 790 / 860 |

Ink traps are cut where the A's crossbar meets its legs and where the K's arm meets the stem: 15 units deep in the HUD
master, vestigial (4 units) in the Black, where they would show.

## Glyph set (v0.1)

A–Z (lowercase a–z map to the same capitals), Œ, 0–9, Á É Í Ó Ú Ü Ñ Ç À È Ò (and their lowercase codepoints), the
lozenge interpunct ·, `. , : ; ! ? ¡ ¿ ' ’ ‘ " “ ” - – — ( ) / &`, space and no-break space. The `kern` feature covers
785 pairs. Planned for v0.2: the rest of the GF Latin Core set, case-sensitive forms, tabular figures, and the
inscription forms behind stylistic sets (see `FONTLOG.txt`).

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
