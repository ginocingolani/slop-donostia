# Slop Donostia

Donostia / San Sebastián from the top of Igeldo to the end of Sagüés, built with [three.js](https://threejs.org/),
WebGPURenderer and TSL on real data: the Basque Government's LiDAR terrain and isobaths, the municipal 1:500 map and
b5m's measured building heights.

A fork of [Slop New York](https://github.com/mrdoob/slop-newyork) by Mr.doob, whose renderer, lighting, materials,
actors and audio it builds on. The New York simulation is still here as [`newyork.html`](newyork.html).

Right now: map, topography and buildings, explored with a free god-mode camera. Next: facades, landmarks, trees,
then the travel modes (walk, drive, cycle, helicopter and a trainera).

## Data

See [`tools/donostia/README.md`](tools/donostia/README.md) for the pipeline, sources and licences.

## License and data

The project code is available under the [MIT License](LICENSE) (© Mr.doob and contributors).

Geographic data: Eusko Jaurlaritza / Gobierno Vasco – geoEuskadi (CC BY 4.0); b5m – Gipuzkoako Foru Aldundia (CC BY
4.0); Donostiako Udala / Ayuntamiento de San Sebastián (CC BY-SA 3.0); © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
(ODbL). The New York data keeps its original sources (NYC Open Data, OpenStreetMap).
