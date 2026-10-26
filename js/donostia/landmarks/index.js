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
import * as bretxa from './bretxa.js';
import * as boulevardKioskoa from './boulevard-kioskoa.js';
import * as tenisKluba from './tenis-kluba.js';
import * as tabakalera from './tabakalera.js';
import * as atotxaDorrea from './atotxa-dorrea.js';
import * as anoeta from './anoeta.js';
import * as illunbe from './illunbe.js';
import * as alderdiEder from './alderdi-eder.js';
import * as klubNautikoa from './klub-nautikoa.js';

// js/donostia/landmarks/index.js
// Registry of the hand-modelled landmarks. Each module builds one landmark from its GEO.landmarks sites; the 1:500
// buildings under a built landmark are hidden from the plain extrusions (js/donostia/buildings.js). Those are the sites'
// `buildings` (tools/donostia/build.mjs), less those of any site a model lists in userData.skipped (site ids it could
// not build), plus the GEO.buildings indices it lists in userData.hide (buildings it replaces that no site claims, found
// by position: the Aquarium's, the tennis pavilion, the funicular's stations). Modules never edit GEO.

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
  [uliaDorrea, ['ulia-dorrea']],
  [bretxa, ['bretxa', 'bretxa-merkatua', 'bretxa-plaza']],
  [boulevardKioskoa, ['boulevard-kioskoa']],
  [tenisKluba, ['tenis-kluba', 'tenis-pistak']],
  [tabakalera, ['tabakalera']],
  [atotxaDorrea, ['atotxa-dorrea']],
  [anoeta, ['anoeta']],
  [illunbe, ['illunbe']],
  [alderdiEder, []],
  [klubNautikoa, []]
];

export function buildLandmarks(GEO, terrain) {
  const group = new THREE.Group();
  group.name = 'DonostiaLandmarks';
  const hidden = new Set();
  const ctx = { GEO, terrain, kit };
  for (const [module, ids] of MODELS) {
    const sites = ids.map((id) => GEO.landmarks.find((s) => s.id === id)).filter(Boolean);
    if (!sites.length && ids.length) continue;
    let model = null;
    try {
      model = module.build(sites, ctx);
    } catch (e) {
      console.warn(`[landmark ${ids[0]}]`, e);
    }
    if (!model) continue;
    model.name ||= ids[0];
    group.add(model);
    const skipped = new Set(model.userData.skipped || []);
    for (const site of sites) if (!skipped.has(site.id)) for (const b of site.buildings || []) hidden.add(b);
    for (const b of model.userData.hide || []) hidden.add(b);
  }
  // main.js updates the objects it adds; forward to the models that animate (funicular cars, lighthouse beams…). As
  // with build(), one landmark's failure stays its own: an update that throws is logged once and dropped, leaving that
  // model still, instead of stopping the later updaters and the frame's render on every frame.
  const animated = group.children.filter((m) => typeof m.userData.update === 'function');
  if (animated.length) {
    group.userData.update = (dt, elapsed, camera) => {
      for (let k = 0; k < animated.length; k++) {
        try {
          animated[k].userData.update(dt, elapsed, camera);
        } catch (e) {
          console.warn(`[landmark ${animated[k].name} update]`, e);
          animated.splice(k--, 1);
        }
      }
    };
  }
  return { group, hidden };
}
