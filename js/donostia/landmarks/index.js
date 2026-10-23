import * as THREE from 'three/webgpu';
import * as kit from './kit.js';
import * as udaletxea from './udaletxea.js';
import * as victoriaEugenia from './victoria-eugenia.js';
import * as hotelMariaCristina from './hotel-maria-cristina.js';
import * as artzainOna from './artzain-ona.js';
import * as kursaal from './kursaal.js';
import * as santaMaria from './santa-maria.js';
import * as motaGaztelua from './mota-gaztelua.js';
import * as itsasMuseoa from './itsas-museoa.js';
import * as igeldo from './igeldo.js';
import * as santaKlara from './santa-klara.js';
import * as miramar from './miramar.js';
import * as haizearenOrrazia from './haizearen-orrazia.js';
import * as uliaDorrea from './ulia-dorrea.js';

// js/donostia/landmarks/index.js
// Registry of the hand-modelled landmarks. Each module builds one landmark from its GEO.landmarks sites; the 1:500
// buildings under a built landmark are hidden from the plain extrusions (js/donostia/buildings.js).

const MODELS = [
  [udaletxea, ['udaletxea']],
  [victoriaEugenia, ['victoria-eugenia']],
  [hotelMariaCristina, ['hotel-maria-cristina']],
  [artzainOna, ['artzain-ona']],
  [kursaal, ['kursaal', 'kursaal-auditorium', 'kursaal-kamara']],
  [santaMaria, ['santa-maria']],
  [motaGaztelua, ['mota-gaztelua']],
  [itsasMuseoa, ['itsas-museoa', 'aquariuma']],
  [igeldo, ['igeldo-itsasargia', 'igeldo-torreoia']],
  [santaKlara, ['santa-klara-itsasargia']],
  [miramar, ['miramar']],
  [haizearenOrrazia, ['haizearen-orrazia']],
  [uliaDorrea, ['ulia-dorrea']]
];

export function buildLandmarks(GEO, terrain) {
  const group = new THREE.Group();
  group.name = 'DonostiaLandmarks';
  const hidden = new Set();
  const ctx = { GEO, terrain, kit };
  for (const [module, ids] of MODELS) {
    const sites = ids.map((id) => GEO.landmarks.find((s) => s.id === id)).filter(Boolean);
    if (!sites.length) continue;
    let model = null;
    try {
      model = module.build(sites, ctx);
    } catch (e) {
      console.warn(`[landmark ${ids[0]}]`, e);
    }
    if (!model) continue;
    model.name ||= ids[0];
    group.add(model);
    for (const site of sites) for (const b of site.buildings || []) hidden.add(b);
  }
  return { group, hidden };
}
