# Donostia Display

The HUD sets its place names (the auzoa, the viewpoints, the street plaques, the map's districts) in the letter of the
Basque carved inscriptions: the Roman capital as the stonecutters of Lapurdi, Behe Nafarroa and Zuberoa cut it into
discoidal stelae and lintels, whose most persistent form is the **crowned A**. That A keeps a flat bar over its apex and
its counter rising to it, from the way the inscriptions compressed TA and MA into one letter. Controls, numbers and
Spanish names stay in Inter, and the display letter is never set below 12 px.

`DonostiaDisplay-Regular.woff2` is [Marcellus](https://fonts.google.com/specimen/Marcellus) (Brian J. Bonislawsky,
Astigmatic), a flared face with Roman capital proportions, with that crowned A. It is subset to the Latin the HUD
writes in Basque, Spanish, French and English, and is about 14 KB. `build.py` makes it reproducibly from the
Marcellus release in google/fonts; its docstring says how to run it.

## Licence

SIL Open Font License 1.1: see [`OFL.txt`](OFL.txt). It is a modified Marcellus, and "Marcellus" is a Reserved Font
Name, so it ships under another name. The font is not covered by the project's MIT licence.

## Harri

The face this one stands in for is [Harri](https://www.blancoletters.com/typefaces/harri/) by Juan Luis Blanco
(Blancoletters, also published by Type-Ø-Tones and in Adobe Fonts). It is drawn from the same inscriptions, and it is
commercial. Its EULA forbids sharing the font software or giving third parties access to it, so its files can never
be committed here or served from this repository's GitHub Pages.

The HUD now leads with [Ateburu](../ateburu/README.md), an OFL face drawn for it, and keeps Donostia Display as its
fallback. With a licence, Harri can still be put first in `--font-display` in `css/donostia.css`:

- **Adobe Fonts.** With a Creative Cloud plan, create a web project with Harri. Then add its stylesheet `<link>` (from
  `use.typekit.net`) to `index.html` where the comment by the font preload says. The files stay on Adobe's servers.
- **A Blancoletters web licence.** Serve the licensed webfont from a host you control (the licence covers one domain
  and a number of monthly page views), and add its `@font-face` there.

Without either, or for anyone who forks this, the HUD uses Ateburu, then Donostia Display.
