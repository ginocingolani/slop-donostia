# Sources

Where Ateburu's identity forms come from, as a record of independent creation. Every glyph is drawn in code
(`source/*.py`) from numbers chosen by eye; the sources below were looked at, compared with renders of the face,
and never traced, scanned into outlines or copied. No existing font (Vasca, Vasca Berria, Harri, the Euskara family,
Waskonia, Kai, Hizki, Urkiola, Alfabeto Bilbao or any other) was opened, traced or used as a shape source.

## Primary source: Louis Colas, *La tombe basque* (1923)

*La Tombe basque. Recueil d'inscriptions funéraires et domestiques du Pays Basque français*, Biarritz, Grande
Imprimerie Moderne, 1923. Colas died in 1929, so his drawings are in the public domain. He drew the stones rather than
photographing them, as clean outlines of letters cut in relief: already a regularised reading, which is why the
photographs below were used to check it. Figure numbers are those printed in the book; page numbers are those of the
scan on archive.org ("LaTombeBasque", 412 pages).

| Fig. | Scan page | Inscription | Date | What it shows |
|---|---|---|---|---|
| 51 | 27 | IOANA DE MARTIQVET | 1614 | Letters and date cut deep (incised, not relief); points between words |
| 83 | 36 | HAVDA·PRESA·EGINA·MARTIN DE·HIRIART… (Saint-Pée, the Nivelle weir) | 1705 | Flat-topped A with a small triangular counter, R with a long straight leg, E and T with flared arm ends, spurred G, lozenge interpuncts, swan-necked 7 |
| 84 | 36 | SEMPEREC EGVINA VICTOR D'VHALDE… (Saint-Pée, Utsalea bridge) | 1738 | Colas: "Lettres larges, bien formées, légèrement empattées. Beaucoup de relief." Flat-topped A; a 7 with a curved stem; square points |
| 85 | 36 | HAVDA·ERROTA·SENPERECO·HERRIACERAGVINARACIA (Saint-Pée, Ibarron mill) | 1652 | Flat-topped A, long-legged R, wedge-ended E, spurred G, lozenge interpuncts, stems that flare towards their ends |
| 126 | 46 | SEPVLTVRA·LARRONDO… (a slab) | 1804 | The crowned A with its bar reaching left over the apex and a crossbar dipped into a V; open 4 |
| 127 | 46 | ESPONDACO SEPVLTVRA… MARiA… EGVINA (a tabular stele) | 1685 | Flat-topped 5; spurred G; the dotted i among capitals (ss01) |
| 129 | 46 | CESTE MAISON APPELEE GORRITIA… (Gorriti house) | 1662 | Flat-topped A in a long domestic inscription |
| 281 | 91 | MARIA IBIRARRENE | 1784 | Open 4 |
| 283 | 91 | ANHAVSCO·ERRETOR·ETCHYA·AVCOAREN·DESPENDYOS·EGVYNA (Anhaux presbytery lintel) | 1751 | Flat-topped 5 and swan-necked 7 in the date; flat-topped A, long R leg, flared E arms, spurred G |
| 537 | 160 | IOANNA DHARICEC◊ | 17th c. | Flat-topped A; a lozenge closing the line |
| 540 | 161 | ENAVT HARAN | 1637 | Swan-necked 7 |
| 541 | 161 | PIER REDO XARANCO (Pierre Doxaranco) | 1704 | Open 4 with the bar running past the stem |
| 542 | 161 | PREDO DE PELERETEGVI… HARRI | 1683 | Flat-topped A, long-legged R |
| 757, 759 | 227 | HIC IACET MARIA DE GARATS; HIC CACHET MARIE DE APESCHRENA | 1641, 1642 | Lettering round a discoidal stele; the crowned MARIA monogram (not used in v0.1) |

## Photographs (reference only, not reproduced)

From Wikimedia Commons, category "Atalarri in the Northern Basque Country". They were used to check Colas's drawings
against cut stone: the weight of relief letters, the wedge at the stroke ends, how heavy a painted relief reads.

| File | Photographer, licence | What it shows |
|---|---|---|
| `Armentdarits_Pierre_Sculptée1.jpg` (ECHEHAVRE… 1688) | Harrieta171, CC BY-SA 3.0 | Heavy, near-monoline relief letters painted black; flat-topped A with a small counter; long R leg; wedge-ended E |
| `Athalburu_Londaitz.jpg` (LONDAITSIA… 1740) | Asp., CC0 | Flat-topped A; reversed N; 8 for G (ERA8VINA); lozenge points |
| `Jaxu_Linteau1.JPG` (PIERRE DE LISSONDO… 1726) | Harrieta171, CC BY-SA 3.0 | Curved-stemmed 7 in an incised date; A without crossbar |

## Glyph by glyph

| Glyph | Ateburu's form | Drawn from |
|---|---|---|
| **A** | A flat bar on the cap line over the apex, reaching further left than right, its ends cut as wedges; the legs meet right under it, so the counter is a tall kite; the crossbar dips into a V whose lowest point stays above 0.40 of the cap height. Ink traps where the V meets the legs (HUD master). | Colas figs. 83, 85, 129, 283, 537, 542 (flat-topped A); fig. 126 (the bar reaching left, the crossbar dipped into a V); photo Armendaritz 1688. The V crossbar is the form the 20th-century tradition fixed (Txiki Zabalo's posters, 1933); the stones show both straight and dipped bars. |
| **R** | The leg leaves the bowl, runs down past it on a curve and flicks up at the baseline, reaching about 0.1 em beyond the bowl; kerning keeps it off the next letter. | Colas figs. 83, 85, 283, 541, 542 (the leg running out past the bowl); the upturned flick is a sign-painters' convention of the 20th century, owned as such. |
| **K** | The arm leaves low from an open crotch on the stem and sweeps up to the cap line; the leg is R's leg, with R's flick. Ink trap where arm and leg part (HUD master). | No historical source: old Basque spelling rarely used K (HERRIAC, 1652, fig. 85; ANHAVSCO, 1751, fig. 283). The curved K is a modern convention; Ateburu draws it to match its own R. The straight-armed K (ss08) is Ateburu's own compromise; the plain K (ss04) is the Roman capital. |
| **E, F** | Arm ends cut as wedges (the top arm's drops, the bottom arm's rises, the middle one grows both ways and is shorter). | Colas figs. 83, 85, 127, 283; photo Armendaritz 1688. |
| **G** | A C-shaped bowl with a beaked top terminal, a short bar, and a beard that ends in a spur below the bowl. | Colas figs. 83 (EGINA), 85 (GVINARACIA), 127 (EGVINA), 283 (EGVYNA). The 8-shaped G of the stones is kept for a future stylistic set, never as the default. |
| **4** | Open: the diagonal stops short of the stem, and the bar runs on past it. | Colas figs. 126 (1804), 281 (1784), 541 (1704). |
| **5** | A flat, square top bar with a wedge end, a short stem, a full bowl. | Colas figs. 283 (1751), 127 (1685). |
| **7** | The stem leaves the bar curving outward, then falls plumb onto a small serifed foot. | Colas figs. 83 (1705), 84 (1738), 283 (1751), 540 (1637); photo Jaxu 1726. |
| **·** | A lozenge, taller than wide, at mid cap height. | Colas figs. 83, 85, 126, 537. |
| Serifs | Short brackets that flare out of the stems; stems with a slight waist. | Colas fig. 84 ("légèrement empattées") and the stems of figs. 83 and 85. |

Everything else (B, D, H, I, L, M, N, O, P, Q, S, T, U, V, W, X, Y, Z, the other figures, the punctuation and the
symbols) is a calm Roman capital in the same system of weights and serifs. M's middle vertex stops at 70 % of its
depth; W is drawn as two crossing Vs.

## Curvature (the CURV axis)

At CURV 100 the stems flare towards their ends and the wedge ends curve into their arms like brackets: the soft,
cut edges of relief letters in Colas figs. 85 (1652) and 283 (1751), where stems widen towards their ends and arms
swell into their wedges (the axis was set by comparing renders at CURV 0, 50 and 100 with those two drawings). The
droop of T's arms, the slight bend of E, F, L and Z, the bowed legs of A, V, W, Y and the S-bent X carry that
softness through the rest of the alphabet; they are Ateburu's own extension, not forms taken from a particular stone.

## Alternates (OpenType features)

| Feature | Ateburu's form | Drawn from |
|---|---|---|
| `ss01` dotted i | A minuscule i at cap height among capitals, a lozenge for its dot (cv01 and cv02 offer a taller or plain stem, a round or wedge dot) | Colas fig. 127 (MARiA, 1685). The 20th-century shop signs of Iparralde made the dotted i a convention (PHARMACiE, PALAiS, IBAiA). The lozenge dot repeats Ateburu's interpunct. |
| `ss02` small o | Ateburu's O, smaller and re-weighted, tucked into the open side of L, T, K and R | The smaller O fitted into open letters, which Herrera (2004) calls "caso evidente de la O"; drawn from the face's own O. |
| `ss03` unicase | Minuscules at cap height: an uncial e like Є, a Π-shaped n, a three-legged m, ∂, a t whose foot curls up, ʒ, an r with an ear, h, b and q with bowls at the minuscule's height | Mixed-case inscriptions in which minuscules stand among capitals: the 1661 epitaph read as CY GIT IEAN dE TCHAVS… and its OCTObrE, PAr, POVr; CINq; the Musée Basque panel (hemen, bete, dena, SAtZEN). Known from Colas's captions and from descriptions in the research behind this face (after Odriozola 2019, pp. 18–20, read as context); drawn from those descriptions in Ateburu's own system, nothing traced. |
| `dlig` nexus | TX TZ TS TA TE TR: the T's bar runs on over the next letter. NE ND ME: a shared stem. DE: E inside D. LA: L's foot runs into the A. AN: the A's right leg is N's first stroke. MA: the M's V lands on the A's left leg | Shared stems and letters set inside letters are the stones' commonest economy. The taxonomy of combinations reproduced in Auñamendi's "Grafía vasca" (after Zabalo, 1947; the plates themselves were not used) lists MA, ME, TA, TE, TR, ND, DE (E inside D), NA and AL among others; MA is in IOANA DE MARTIQVET (Colas fig. 51, 1614). NE, LA and AN are Ateburu's extensions of the same habit. TX, TZ and TS join modern (batua) digraphs; the stones wrote CH, TCH and TZ. |
| `ss04` Roman | An A without the crown, with a straight crossbar; an R with a straight leg on a flared foot; the plain K | The stones show straight crossbars beside dipped ones (see A above) and R's long, straight leg (Colas fig. 83; long legs in figs. 85, 542). |
| `ss05` figures | A closed 4, a 5 without the wedge, a straight 7 | Not from the stones: plain figures for numbers in data. |
| `ss06` curiosities | 8 for G; reversed N, S, D and E; the barred I; V for U | 8 for G and the reversed N: photo Athalburu Londaitz (ERA8VINA, 1740), and frequent in Colas; reversed S, D and E and the barred I (17th century): Colas; V for U: HAVDA (figs. 83, 85), ANHAVSCO (fig. 283). |
| Ꝑ (U+A750) | P with a stroke through its stem | The Latin per/pro abbreviation, among the abbreviation marks of the inscriptions. |
| `calt` | The A's crown turns its long end right after T, V, W, Y; R and K take a shorter leg before A, T, V, W, Y, J | Typesetting, not history. The idea of turning the A's flag in context is Hizki's (Odriozola 2019), read as critique; nothing was drawn from it. |

## Secondary sources (context and critique; nothing drawn from them)

- Edorta Kortadi Olano, "Grafía vasca", *Auñamendi Eusko Entziklopedia*.
- Eduardo Herrera Fernández, "La 'letra vasca'. Etnicidad y cultura tipográfica", *I Congreso de Tipografía*,
  Valencia, 2004.
- Johan Järlehed, "La letra vasca. Tradición inventada, nacionalismo y mercantilización cultural en el paisaje
  lingüístico de Euskal Herria", 2012; and his later papers on Basque and Galician vernacular type.
- Martín Odriozola Aguirre, *Hizki. Alfabeto unicase basado en la grafía vasca*, EINA, 2019 (a student project with no
  licence: read as critique and context only).
- Pablo and Jon "Txiki" Zabalo, *Arquitectura popular y grafía vasca*, Buenos Aires, 1947: known only through
  secondary reproductions, still in copyright in Spain; no plate used. Its list of letter combinations, as quoted in
  Auñamendi, informed which nexus letters to draw.
