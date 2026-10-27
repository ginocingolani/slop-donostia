# Slop Donostia

Donostia / San Sebastián from the top of Igeldo to the end of Sagüés and south to Anoeta and the Hospital
Universitario, built with [three.js](https://threejs.org/), WebGPURenderer and TSL on real data: the Basque
Government's LiDAR terrain and isobaths, the municipal 1:500 map, b5m's measured building heights and OpenStreetMap.

A fork of [Slop New York](https://github.com/mrdoob/slop-newyork) by Mr.doob, whose renderer, lighting, materials,
actors and audio it builds on. The New York simulation is still here as [`newyork.html`](newyork.html).

Right now: LiDAR terrain, sea and surf, the 1:500 buildings with facades and roofs, twenty modelled landmarks (the
Kursaal, the Buen Pastor, the Bretxa, Igeldo's funicular and Montaña Suiza, Anoeta...), the Urumea bridges, the sea
and river walls with the rocks of the shore, the port's pontoons, gangways and quays, trees and street furniture, explored with a free god-mode camera. Next: the travel modes (walk, drive, cycle, helicopter and a
trainera).

## Data

See [`tools/donostia/README.md`](tools/donostia/README.md) for the pipeline, sources and licences.

## License and data

The project code is available under the [MIT License](LICENSE) (© Mr.doob and Slop Donostia contributors). MIT covers
the code only, not the Donostia data files derived from the sources below (`tools/donostia/data/*.json`,
`data/donostia/*.png`, `js/donostia/geodata.js` and `js/donostia/data-*.js`): those are offered under the
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) for their OpenStreetMap content and
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) for their municipal-map content, with the
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) credits below; see
[Licences](tools/donostia/README.md#licences) for which file carries which.

Geographic data: Eusko Jaurlaritza / Gobierno Vasco – geoEuskadi (CC BY 4.0); b5m – Gipuzkoako Foru Aldundia (CC BY
4.0); Donostiako Udala / Ayuntamiento de San Sebastián (CC BY-SA 3.0); © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
(ODbL). The data was reprojected, simplified, resampled and combined for Slop Donostia. The New York data keeps its
original sources (NYC Open Data, OpenStreetMap).

The HUD's display font, [`fonts/ateburu`](fonts/ateburu/README.md), is an original Basque display face drawn for Slop
Donostia from the carved inscriptions, under the SIL Open Font License 1.1 (no Reserved Font Name), not MIT. Its
fallback, [`fonts/donostia-display`](fonts/donostia-display/README.md), is a modified Marcellus, also under the OFL.
Harri, the commercial Basque face Donostia Display stood in for, is never included; that font's README says how to use
it with a licence of your own.
