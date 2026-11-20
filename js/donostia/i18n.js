// js/donostia/i18n.js
// The interface's languages: English (the default, for everyone: the browser's language is not looked at), euskara
// and Spanish, chosen in the settings sheet and remembered per browser. Every string a visitor reads or a screen
// reader speaks is here by key; the city's own names (streets, auzoak, landmarks) are data and stay as they are,
// Basque with the Spanish under it.
//
//   t(key, params?)        the string in the language in force ('{name}' placeholders filled from params); English
//                          where a language lacks the key, the key itself where English does too
//   getLang() / setLang(id)   'en' | 'eu' | 'es'; setLang stores the choice (localStorage 'donostia-lang'), sets
//                          <html lang>, rewrites the page's marked elements and calls the listeners. No reload.
//   onLang(fn)             fn(lang) after every change (for what scripts write: lists, readouts, the map's lines)
//   applyI18n(root?)       rewrites the marked elements under root (index.html marks them, see below)
//   placeName(place)       a fly-to place's { name, sub } in the language in force (GEO.teleports has the Basque and
//                          the Spanish names; the English ones are PLACES_EN here, by id, so the baked data stays as
//                          it is)
//   translateStatus(raw)   js/donostia/main.js writes the loading screen's lines in English: where one is known it
//                          comes back in the language in force, otherwise as it came (see STATUS)
//
// index.html keeps its English text (the page reads right before any script runs) and marks what is translated:
//   data-i18n="key"                      the element's text
//   data-i18n-attr="title:key;aria-label:key2"   attributes
//   data-i18n-rich="key"                 text with the element's own child elements (links, italics) kept: in the
//                                        string, <0>…</0> wraps the words that go in the first child, <1>…</1> the
//                                        second… English is the markup itself and needs no entry
// Nothing here needs the DOM to be imported: node loads it for the tests.

export const LANGS = ['en', 'eu', 'es'];
export const LANG_NAMES = { en: 'English', eu: 'Euskara', es: 'Español' }; // each in its own language
export const DEFAULT_LANG = 'en';
const LANG_KEY = 'donostia-lang'; // localStorage: the language picked ('en' | 'eu' | 'es'); absent: English

const STRINGS = {
  en: {
    'status.starting': 'Starting…',
    'loading.reload': 'Reload',
    'loading.webgpuTitle': 'WebGPU is needed',
    'loading.webgpuNote': 'Slop Donostia is drawn with WebGPU, which this browser or device does not offer. Try the current Chrome, Edge or Samsung Internet (Android 12 or later), Safari on iOS / iPadOS 26 or later, or a desktop browser.',
    'view.label': '3D view of Donostia / San Sebastián',
    'brand.github': 'Slop Donostia on GitHub (opens in a new tab)',
    'brand.fork': 'fork of',
    'time.label': 'Time of day',
    'time.golden': 'Golden hour',
    'time.midday': 'Midday',
    'time.twilight': 'Blue hour',
    'time.midnight': 'Night',
    'time.live': 'Now',
    'time.goldenTitle': 'Golden hour [1]',
    'time.middayTitle': 'Midday [2]',
    'time.twilightTitle': 'Blue hour [3]',
    'time.midnightTitle': 'Night [4]',
    'time.liveTitle': "Real time: Donostia's own clock, weather and sea, now [5]",
    'tool.flyTo': 'Go to',
    'tool.flyToTitle': 'Fly to a viewpoint',
    'tool.map': 'Map',
    'tool.mapTitle': 'Street map [M]',
    'tool.settings': 'Settings',
    'tool.credits': 'Data sources',
    'tool.creditsTitle': 'Data sources & licences',
    'tool.clean': 'Clean view',
    'tool.cleanTitle': 'Clean view [H]',
    'tool.cleanLabel': 'Hide the interface',
    'live.label': 'Donostia now',
    'live.clockTitle': 'Now (Europe/Madrid time)',
    'live.creditTitle': 'Weather & sea data by Open-Meteo.com (CC BY 4.0)',
    'live.loading': 'Loading…',
    'live.loadingTitle': 'Loading the weather and the sea (Open-Meteo)',
    'live.noData': 'No data',
    'live.noDataTitle': 'No weather from Open-Meteo ({error}): the sky keeps to the clock with calm weather, and asks again every 15 min',
    'live.noAnswer': 'no answer',
    'live.weatherTitle': '{word}, {temp} °C; wind {wind} km/h from the {dir}; {cloud}% cloud; {vis} visibility',
    'live.tideTitle': 'Tide: {level} m on mean sea level, {trend}',
    'live.tideNext': '; {name} at {time} ({level} m)',
    'live.wavesTitle': 'Waves: {height} m every {period} s from the {dir}',
    'live.seaTemp': '; the sea {temp} °C',
    'tide.high': 'High water',
    'tide.low': 'Low water',
    'tide.rising': 'rising',
    'tide.falling': 'falling',
    'tide.turning': 'turning',
    'weather.clear': 'Clear',
    'weather.cloudy': 'Cloudy',
    'weather.overcast': 'Overcast',
    'weather.fog': 'Fog',
    'weather.drizzle': 'Drizzle',
    'weather.rain': 'Rain',
    'weather.showers': 'Showers',
    'weather.snow': 'Snow',
    'weather.storm': 'Storm',
    'compass': 'N NE E SE S SW W NW',
    'flyto.title': 'Go to',
    'flyto.label': 'Fly to',
    'settings.quality': 'Quality',
    'settings.language': 'Language',
    'settings.more': 'More',
    'screen.full': 'Full screen',
    'screen.exit': 'Exit full screen',
    'screen.hint': 'For full screen: Share › Add to Home Screen',
    'more.source': 'Source code',
    'more.licences': 'Licences',
    'more.newTab': ' (opens in a new tab)',
    'quality.auto': 'Auto',
    'compile.details': 'Loading details… {n}%',
    'compile.applying': 'Applying quality… {n}%',
    'quality.low': 'Low',
    'quality.medium': 'Medium',
    'quality.high': 'High',
    'quality.ultra': 'Ultra',
    'quality.autoNote': 'Auto: {tier}',
    'credits.title': 'Data sources',
    'where.label': 'Where you are, and the radar: click to fly there',
    'radar.title': 'Click to fly there',
    'radar.expandTitle': 'Full map [M]',
    'radar.expand': 'Open the full map',
    'hint.fly': 'Fly',
    'hint.upDown': 'Up / down',
    'hint.fast': 'Fast',
    'hint.look': 'Look',
    'hint.speed': 'Speed',
    'hint.map': 'Map',
    'key.drag': 'Drag',
    'key.wheel': 'Wheel',
    'gauge.label': 'Camera telemetry',
    'gauge.camera': 'God camera',
    'gauge.alt': 'Alt',
    'touch.label': 'Touch controls',
    'touch.stick': 'Flight stick: push up or down to fly forward or back, left or right to slide, past the rim to go fast',
    'touch.actions': 'Hold to climb or descend',
    'touch.up': 'Up',
    'touch.down': 'Down',
    'touch.upLabel': 'Climb',
    'touch.downLabel': 'Descend',
    'map.label': 'Street map of Donostia',
    'map.title': 'Map of Donostia',
    'map.here': 'You are at {place}',
    'map.search': 'Search a street: Kale Nagusia, Boulevard…',
    'map.searchLabel': 'Search a street',
    'map.close': 'Close',
    'map.closeTitle': 'Close [M / Esc]',
    'map.zoomIn': 'Zoom in',
    'map.zoomOut': 'Zoom out',
    'map.centre': 'Centre on the camera',
    'map.whole': 'Show the whole city',
    'map.hint': 'Click to fly there · Drag to pan · Scroll or pinch to zoom',
    'map.hintTouch': 'Tap to fly there · Drag to pan · Pinch to zoom',
    'map.clickFly': 'Click to fly there',
    'map.enterFly': 'Enter: fly there',
    'map.licences': 'data licences',
    // the loading screen's lines, as js/donostia/main.js and index.html word them (see STATUS)
    'status.renderer': 'Initializing three.js r{n} WebGPURenderer…',
    'status.terrain': 'Loading LiDAR terrain & sea floor…',
    'status.ground': 'Building the bay, the hills & the streets…',
    'status.landmarks': 'Raising the landmarks…',
    'status.buildings': 'Raising {n} buildings…',
    'status.trees': 'Planting trees & dressing the streets…',
    'status.shaders': 'Compiling shaders…',
    'status.shadersPct': 'Compiling shaders… {n}%',
    'status.noStart': 'Could not start: {n}',
    'status.noLoad': 'Could not load the app (network or browser support).',
    'status.gpuReset': 'The GPU was reset ({n}). Reload the page to continue.',
    'status.noWebgpu': 'This browser has no WebGPU, which Slop Donostia needs to draw the city.',
    'status.noAdapter': "WebGPU is there, but this device's graphics are not supported by it (or it is turned off).",
    'status.noDevice': 'WebGPU could not start on this device (the browser gave no GPU device). Close other tabs and reload, or try another browser.',
    'status.hintIos': 'On iPhone and iPad it comes with iOS 26 (Safari 26).',
    'status.hintAndroid': 'On Android it needs Chrome 121 or later on Android 12 or later.',
    'status.hintDesktop': 'Try a current Chrome or Edge, or Safari 26 or later.',
    'status.insecure': 'WebGPU also needs a secure (https) page.'
  },

  eu: {
    'status.starting': 'Abiarazten…',
    'loading.reload': 'Kargatu berriro',
    'loading.webgpuTitle': 'WebGPU behar da',
    'loading.webgpuNote': 'Slop Donostia WebGPUrekin marrazten da, eta nabigatzaile edo gailu honek ez du eskaintzen. Probatu Chrome, Edge edo Samsung Internet eguneratuekin (Android 12 edo berriagoa), Safarirekin iOS / iPadOS 26an edo berriagoan, edo mahaigaineko nabigatzaile batekin.',
    'view.label': 'Donostiaren 3D ikuspegia',
    'brand.github': 'Slop Donostia GitHuben (fitxa berri batean irekitzen da)',
    'brand.fork': 'jatorria:',
    'time.label': 'Eguneko ordua',
    'time.golden': 'Ilunabarra',
    'time.midday': 'Eguerdia',
    'time.twilight': 'Ordu urdina',
    'time.midnight': 'Gaua',
    'time.live': 'Orain',
    'time.goldenTitle': 'Ilunabarra [1]',
    'time.middayTitle': 'Eguerdia [2]',
    'time.twilightTitle': 'Ordu urdina [3]',
    'time.midnightTitle': 'Gaua [4]',
    'time.liveTitle': 'Denbora errealean: Donostiako ordua, eguraldia eta itsasoa, orain [5]',
    'tool.flyTo': 'Joan',
    'tool.flyToTitle': 'Hegan egin begiratoki batera',
    'tool.map': 'Mapa',
    'tool.mapTitle': 'Kale-mapa [M]',
    'tool.settings': 'Aukerak',
    'tool.credits': 'Datu-iturriak',
    'tool.creditsTitle': 'Datu-iturriak eta lizentziak',
    'tool.clean': 'Bista garbia',
    'tool.cleanTitle': 'Bista garbia [H]',
    'tool.cleanLabel': 'Ezkutatu interfazea',
    'live.label': 'Donostia orain',
    'live.clockTitle': 'Orain (Europe/Madrid ordua)',
    'live.creditTitle': 'Eguraldiaren eta itsasoaren datuak: Open-Meteo.com (CC BY 4.0)',
    'live.loading': 'Kargatzen…',
    'live.loadingTitle': 'Eguraldia eta itsasoa kargatzen (Open-Meteo)',
    'live.noData': 'Daturik ez',
    'live.noDataTitle': 'Open-Meteok ez du eguraldirik eman ({error}): zeruak orduari jarraitzen dio eguraldi bareaz, eta 15 minuturo galdetzen du berriro',
    'live.noAnswer': 'erantzunik ez',
    'live.weatherTitle': '{word}, {temp} °C; haizea: {wind} km/h ({dir}); hodeiak: % {cloud}; ikuspena: {vis}',
    'live.tideTitle': 'Itsasaldia: {level} m batez besteko itsas mailaren gainean, {trend}',
    'live.tideNext': '; {name}: {time} ({level} m)',
    'live.wavesTitle': 'Olatuak: {height} m, {period} s-ko tartea ({dir})',
    'live.seaTemp': '; itsasoa {temp} °C',
    'tide.high': 'Itsasgora',
    'tide.low': 'Itsasbehera',
    'tide.rising': 'gorantz',
    'tide.falling': 'beherantz',
    'tide.turning': 'aldatzen',
    'weather.clear': 'Oskarbi',
    'weather.cloudy': 'Hodeitsu',
    'weather.overcast': 'Estalia',
    'weather.fog': 'Lainoa',
    'weather.drizzle': 'Zirimiria',
    'weather.rain': 'Euria',
    'weather.showers': 'Zaparradak',
    'weather.snow': 'Elurra',
    'weather.storm': 'Ekaitza',
    'compass': 'I IE E HE H HM M IM', // iparra, ekialdea, hegoa, mendebaldea
    'flyto.title': 'Joan',
    'flyto.label': 'Joan hona',
    'settings.quality': 'Kalitatea',
    'settings.language': 'Hizkuntza',
    'settings.more': 'Gehiago',
    'screen.full': 'Pantaila osoa',
    'screen.exit': 'Irten pantaila osotik',
    'screen.hint': 'Pantaila osorako: Partekatu › Gehitu hasierako pantailan',
    'more.source': 'Iturburu-kodea',
    'more.licences': 'Lizentziak',
    'more.newTab': ' (fitxa berri batean irekitzen da)',
    'quality.auto': 'Auto',
    'compile.details': 'Xehetasunak kargatzen… %{n}',
    'compile.applying': 'Kalitatea aplikatzen… %{n}',
    'quality.low': 'Baxua',
    'quality.medium': 'Ertaina',
    'quality.high': 'Altua',
    'quality.ultra': 'Ultra',
    'quality.autoNote': 'Auto: {tier}',
    'credits.title': 'Datu-iturriak',
    'where.label': 'Non zauden, eta radarra: egin klik hara joateko',
    'radar.title': 'Egin klik hara joateko',
    'radar.expandTitle': 'Mapa osoa [M]',
    'radar.expand': 'Ireki mapa osoa',
    'hint.fly': 'Hegan',
    'hint.upDown': 'Gora / behera',
    'hint.fast': 'Azkar',
    'hint.look': 'Begiratu',
    'hint.speed': 'Abiadura',
    'hint.map': 'Mapa',
    'key.drag': 'Arrastatu',
    'key.wheel': 'Gurpila',
    'gauge.label': 'Kameraren telemetria',
    'gauge.camera': 'Jainko-kamera',
    'gauge.alt': 'Alt',
    'touch.label': 'Ukipen-kontrolak',
    'touch.stick': 'Hegaldi-palanka: bultzatu gora edo behera aurrera edo atzera hegan egiteko, ezkerrera edo eskuinera albora joateko, eta ertzetik harago azkar joateko',
    'touch.actions': 'Eutsi sakatuta igotzeko edo jaisteko',
    'touch.up': 'Igo',
    'touch.down': 'Jaitsi',
    'touch.upLabel': 'Igo',
    'touch.downLabel': 'Jaitsi',
    'map.label': 'Donostiako kale-mapa',
    'map.title': 'Donostiako mapa',
    'map.here': 'Hemen zaude: {place}',
    'map.search': 'Bilatu kalea: Kale Nagusia, Boulevard…',
    'map.searchLabel': 'Bilatu kalea',
    'map.close': 'Itxi',
    'map.closeTitle': 'Itxi [M / Esc]',
    'map.zoomIn': 'Hurbildu',
    'map.zoomOut': 'Urrundu',
    'map.centre': 'Zentratu kameran',
    'map.whole': 'Erakutsi hiri osoa',
    'map.hint': 'Egin klik hara joateko · Arrastatu mugitzeko · Gurpila edo atximurka zoom egiteko',
    'map.hintTouch': 'Ukitu hara joateko · Arrastatu mugitzeko · Atximurkatu zoom egiteko',
    'map.clickFly': 'Egin klik hara joateko',
    'map.enterFly': 'Enter: hara joan',
    'map.licences': 'datuen lizentziak',
    'credits.terrain': 'Lurra eta itsas hondoa: Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi — LiDAR 2017 MDT eta isobatak (<0>CC BY 4.0</0>)',
    'credits.boats': 'Portuko ontziak: 2025eko ortoargazkiaren gainean digitalizatuak, Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi',
    'credits.heights': 'Eraikinen altuerak: b5m, Gipuzkoako Foru Aldundia / Diputación Foral de Gipuzkoa (<0>CC BY 4.0</0>)',
    'credits.ground': 'Eraikinak, kaleak eta lurzorua: Donostiako Udala / Ayuntamiento de San Sebastián, 1:500 udal-kartografia (<0>CC BY-SA 3.0</0>)',
    'credits.districts': 'Auzoak: Donostiako Udala / Ayuntamiento de San Sebastián (<0>CC BY-SA 3.0</0>)',
    'credits.osm': 'Kale eta leku izenak, eraikin nabarmenak, ura, zubiak, hiri-altzariak: <0>© OpenStreetMap-eko egileak</0> (<1>ODbL</1>)',
    'credits.derived': 'Datuak birproiektatu, sinplifikatu, birlagindu eta konbinatu dira Slop Donostiarako; datu eratorriak ODbL / CC BY-SA 3.0 lizentziapean daude (<0>xehetasunak</0>).',
    'credits.tifo': 'Aitor Zabaletaren erretratua Anoetako tifoaren oihalean: <0>Goiena.eus</0>en argazki batetik, <1>Wikimedia Commons</1>en bidez, grisetan (<2>CC BY-SA 4.0</2>). Erakusten duen domina zaleen lana da',
    'credits.live': 'Denbora erreala (Orain): eguraldiaren eta itsasoaren datuak, <0>Open-Meteo.com</0> (<1>CC BY 4.0</1>), haren iragarpen- eta itsaso-ereduak; eguzkiaren eta ilargiaren kokapenak, Astronomical Almanac-en eta Meeusen <2>Astronomical Algorithms</2> liburuaren arabera',
    'credits.lettering': 'Letra: Ateburu, Slop Donostiarako marraztua, Louis Colasen <0>La tombe basque</0> (1923) liburuko euskal inskripzioetatik (<1>SIL OFL 1.1</1>); ordezkoa Donostia Display, Astigmatic-en Marcellus, A koroatuarekin (<2>SIL OFL 1.1</2>)',
    'credits.code': 'Kodea: MIT, <0>mrdoob/slop-newyork</0>etik forkatua',
    'status.renderer': 'three.js r{n} WebGPURenderer abiarazten…',
    'status.terrain': 'LiDAR lurra eta itsas hondoa kargatzen…',
    'status.ground': 'Badia, mendiak eta kaleak eraikitzen…',
    'status.landmarks': 'Eraikin nabarmenak altxatzen…',
    'status.buildings': '{n} eraikin altxatzen…',
    'status.trees': 'Zuhaitzak landatzen eta kaleak janzten…',
    'status.shaders': 'Shaderrak konpilatzen…',
    'status.shadersPct': 'Shaderrak konpilatzen… % {n}',
    'status.noStart': 'Ezin izan da abiarazi: {n}',
    'status.noLoad': 'Ezin izan da aplikazioa kargatu (sarea edo nabigatzailearen euskarria).',
    'status.gpuReset': 'GPUa berrabiarazi da ({n}). Kargatu berriro orria jarraitzeko.',
    'status.noWebgpu': 'Nabigatzaile honek ez du WebGPUrik, eta Slop Donostiak hiria marrazteko behar du.',
    'status.noAdapter': 'WebGPU badago, baina ez du gailu honen grafikorik onartzen (edo desaktibatuta dago).',
    'status.noDevice': 'WebGPU ezin izan da abiarazi gailu honetan (nabigatzaileak ez du GPU gailurik eman). Itxi beste fitxak eta kargatu berriro, edo probatu beste nabigatzaile batekin.',
    'status.hintIos': 'iPhone eta iPadetan iOS 26rekin dator (Safari 26).',
    'status.hintAndroid': 'Androiden Chrome 121 edo berriagoa behar du, Android 12an edo berriagoan.',
    'status.hintDesktop': 'Probatu Chrome edo Edge eguneratu batekin, edo Safari 26 edo berriagoarekin.',
    'status.insecure': 'WebGPUk orri segurua (https) ere behar du.'
  },

  es: {
    'status.starting': 'Iniciando…',
    'loading.reload': 'Recargar',
    'loading.webgpuTitle': 'Hace falta WebGPU',
    'loading.webgpuNote': 'Slop Donostia se dibuja con WebGPU, que este navegador o dispositivo no ofrece. Prueba con Chrome, Edge o Samsung Internet actuales (Android 12 o posterior), Safari en iOS / iPadOS 26 o posterior, o un navegador de escritorio.',
    'view.label': 'Vista 3D de Donostia / San Sebastián',
    'brand.github': 'Slop Donostia en GitHub (se abre en una pestaña nueva)',
    'brand.fork': 'fork de',
    'time.label': 'Hora del día',
    'time.golden': 'Atardecer',
    'time.midday': 'Mediodía',
    'time.twilight': 'Hora azul',
    'time.midnight': 'Noche',
    'time.live': 'Ahora',
    'time.goldenTitle': 'Atardecer [1]',
    'time.middayTitle': 'Mediodía [2]',
    'time.twilightTitle': 'Hora azul [3]',
    'time.midnightTitle': 'Noche [4]',
    'time.liveTitle': 'Tiempo real: la hora, el tiempo y el mar de Donostia, ahora [5]',
    'tool.flyTo': 'Ir a',
    'tool.flyToTitle': 'Volar a un mirador',
    'tool.map': 'Mapa',
    'tool.mapTitle': 'Callejero [M]',
    'tool.settings': 'Ajustes',
    'tool.credits': 'Fuentes de datos',
    'tool.creditsTitle': 'Fuentes de datos y licencias',
    'tool.clean': 'Vista limpia',
    'tool.cleanTitle': 'Vista limpia [H]',
    'tool.cleanLabel': 'Ocultar la interfaz',
    'live.label': 'Donostia ahora',
    'live.clockTitle': 'Ahora (hora de Europe/Madrid)',
    'live.creditTitle': 'Datos del tiempo y del mar: Open-Meteo.com (CC BY 4.0)',
    'live.loading': 'Cargando…',
    'live.loadingTitle': 'Cargando el tiempo y el mar (Open-Meteo)',
    'live.noData': 'Sin datos',
    'live.noDataTitle': 'Open-Meteo no da el tiempo ({error}): el cielo sigue al reloj con tiempo en calma, y vuelve a preguntar cada 15 min',
    'live.noAnswer': 'sin respuesta',
    'live.weatherTitle': '{word}, {temp} °C; viento de {wind} km/h del {dir}; {cloud} % de nubes; visibilidad de {vis}',
    'live.tideTitle': 'Marea: {level} m sobre el nivel medio del mar, {trend}',
    'live.tideNext': '; {name} a las {time} ({level} m)',
    'live.wavesTitle': 'Oleaje: {height} m cada {period} s del {dir}',
    'live.seaTemp': '; el mar a {temp} °C',
    'tide.high': 'Pleamar',
    'tide.low': 'Bajamar',
    'tide.rising': 'subiendo',
    'tide.falling': 'bajando',
    'tide.turning': 'cambiando',
    'weather.clear': 'Despejado',
    'weather.cloudy': 'Nuboso',
    'weather.overcast': 'Cubierto',
    'weather.fog': 'Niebla',
    'weather.drizzle': 'Sirimiri',
    'weather.rain': 'Lluvia',
    'weather.showers': 'Chubascos',
    'weather.snow': 'Nieve',
    'weather.storm': 'Tormenta',
    'compass': 'N NE E SE S SO O NO',
    'flyto.title': 'Ir a',
    'flyto.label': 'Volar a',
    'settings.quality': 'Calidad',
    'settings.language': 'Idioma',
    'settings.more': 'Más',
    'screen.full': 'Pantalla completa',
    'screen.exit': 'Salir de pantalla completa',
    'screen.hint': 'Para pantalla completa: Compartir › Añadir a pantalla de inicio',
    'more.source': 'Código fuente',
    'more.licences': 'Licencias',
    'more.newTab': ' (se abre en una pestaña nueva)',
    'quality.auto': 'Auto',
    'compile.details': 'Cargando detalles… {n}%',
    'compile.applying': 'Aplicando calidad… {n}%',
    'quality.low': 'Baja',
    'quality.medium': 'Media',
    'quality.high': 'Alta',
    'quality.ultra': 'Ultra',
    'quality.autoNote': 'Auto: {tier}',
    'credits.title': 'Fuentes de datos',
    'where.label': 'Dónde estás, y el radar: haz clic para volar allí',
    'radar.title': 'Haz clic para volar allí',
    'radar.expandTitle': 'Mapa completo [M]',
    'radar.expand': 'Abrir el mapa completo',
    'hint.fly': 'Volar',
    'hint.upDown': 'Subir / bajar',
    'hint.fast': 'Rápido',
    'hint.look': 'Mirar',
    'hint.speed': 'Velocidad',
    'hint.map': 'Mapa',
    'key.drag': 'Arrastrar',
    'key.wheel': 'Rueda',
    'gauge.label': 'Telemetría de la cámara',
    'gauge.camera': 'Cámara dios',
    'gauge.alt': 'Alt',
    'touch.label': 'Controles táctiles',
    'touch.stick': 'Palanca de vuelo: empuja arriba o abajo para volar adelante o atrás, a la izquierda o a la derecha para ir de lado, y más allá del borde para ir rápido',
    'touch.actions': 'Mantén pulsado para subir o bajar',
    'touch.up': 'Subir',
    'touch.down': 'Bajar',
    'touch.upLabel': 'Subir',
    'touch.downLabel': 'Bajar',
    'map.label': 'Callejero de Donostia',
    'map.title': 'Mapa de Donostia',
    'map.here': 'Estás en {place}',
    'map.search': 'Buscar una calle: Kale Nagusia, Boulevard…',
    'map.searchLabel': 'Buscar una calle',
    'map.close': 'Cerrar',
    'map.closeTitle': 'Cerrar [M / Esc]',
    'map.zoomIn': 'Acercar',
    'map.zoomOut': 'Alejar',
    'map.centre': 'Centrar en la cámara',
    'map.whole': 'Ver toda la ciudad',
    'map.hint': 'Haz clic para volar allí · Arrastra para mover · Rueda o pellizco para el zoom',
    'map.hintTouch': 'Toca para volar allí · Arrastra para mover · Pellizca para el zoom',
    'map.clickFly': 'Haz clic para volar allí',
    'map.enterFly': 'Intro: volar allí',
    'map.licences': 'licencias de los datos',
    'credits.terrain': 'Terreno y fondo marino: Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi — LiDAR 2017 MDT e isóbatas (<0>CC BY 4.0</0>)',
    'credits.boats': 'Barcos del puerto: digitalizados sobre la ortofoto de 2025, Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi',
    'credits.heights': 'Alturas de los edificios: b5m, Gipuzkoako Foru Aldundia / Diputación Foral de Gipuzkoa (<0>CC BY 4.0</0>)',
    'credits.ground': 'Edificios, calles y suelo: Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (<0>CC BY-SA 3.0</0>)',
    'credits.districts': 'Barrios (auzoak): Donostiako Udala / Ayuntamiento de San Sebastián (<0>CC BY-SA 3.0</0>)',
    'credits.osm': 'Nombres de calles y lugares, edificios emblemáticos, agua, puentes, mobiliario urbano: <0>© colaboradores de OpenStreetMap</0> (<1>ODbL</1>)',
    'credits.derived': 'Los datos se han reproyectado, simplificado, remuestreado y combinado para Slop Donostia; los datos derivados están bajo ODbL / CC BY-SA 3.0 (<0>detalles</0>).',
    'credits.tifo': 'El retrato de Aitor Zabaleta en la lona del tifo de Anoeta: de una foto de <0>Goiena.eus</0> vía <1>Wikimedia Commons</1>, en grises (<2>CC BY-SA 4.0</2>). El medallón que muestra es obra de la afición',
    'credits.live': 'Tiempo real (Ahora): datos del tiempo y del mar de <0>Open-Meteo.com</0> (<1>CC BY 4.0</1>), sus modelos de predicción y marinos; las posiciones del sol y de la luna según el Astronomical Almanac y los <2>Astronomical Algorithms</2> de Meeus',
    'credits.lettering': 'Rotulación: Ateburu, dibujada para Slop Donostia a partir de las inscripciones vascas de <0>La tombe basque</0> (1923) de Louis Colas (<1>SIL OFL 1.1</1>); de reserva Donostia Display, la Marcellus de Astigmatic con la A coronada (<2>SIL OFL 1.1</2>)',
    'credits.code': 'Código: MIT, fork de <0>mrdoob/slop-newyork</0>',
    'status.renderer': 'Iniciando three.js r{n} WebGPURenderer…',
    'status.terrain': 'Cargando el terreno LiDAR y el fondo marino…',
    'status.ground': 'Construyendo la bahía, los montes y las calles…',
    'status.landmarks': 'Levantando los edificios emblemáticos…',
    'status.buildings': 'Levantando {n} edificios…',
    'status.trees': 'Plantando árboles y vistiendo las calles…',
    'status.shaders': 'Compilando shaders…',
    'status.shadersPct': 'Compilando shaders… {n} %',
    'status.noStart': 'No se pudo iniciar: {n}',
    'status.noLoad': 'No se pudo cargar la aplicación (la red o la compatibilidad del navegador).',
    'status.gpuReset': 'La GPU se ha reiniciado ({n}). Recarga la página para continuar.',
    'status.noWebgpu': 'Este navegador no tiene WebGPU, que Slop Donostia necesita para dibujar la ciudad.',
    'status.noAdapter': 'WebGPU está, pero no admite los gráficos de este dispositivo (o está desactivado).',
    'status.noDevice': 'WebGPU no pudo arrancar en este dispositivo (el navegador no dio un dispositivo GPU). Cierra otras pestañas y recarga, o prueba con otro navegador.',
    'status.hintIos': 'En iPhone y iPad llega con iOS 26 (Safari 26).',
    'status.hintAndroid': 'En Android hace falta Chrome 121 o posterior con Android 12 o posterior.',
    'status.hintDesktop': 'Prueba con un Chrome o Edge actual, o con Safari 26 o posterior.',
    'status.insecure': 'WebGPU también necesita una página segura (https).'
  }
};

// The fly-to places in English, by GEO.teleports id. Most are proper names: the place keeps its own name and only the
// generic part is translated
export const PLACES_EN = {
  igeldo: 'Mount Igeldo',
  urgull: 'Mount Urgull',
  kontxa: 'La Concha promenade',
  udaletxea: 'City Hall gardens · Alderdi Eder',
  'alde-zaharra': 'Constitution Square · Old Town',
  kursaal: 'Kursaal & Zurriola beach',
  'artzain-ona': 'Good Shepherd Cathedral',
  orrazia: 'Comb of the Wind',
  miramar: 'Miramar Palace',
  'santa-klara': 'Santa Clara Island',
  sagues: 'Sagües',
  dabadaba: 'Dabadaba',
  aiete: 'Aiete Palace',
  anoeta: 'Anoeta Stadium',
  'aitor-zabaleta': 'Aitor Zabaleta stand'
};

// --- The language in force -------------------------------------------------------------------------------------------

const isLang = (id) => LANGS.includes(id);
const stored = () => {
  try {
    const id = globalThis.localStorage?.getItem(LANG_KEY);
    return isLang(id) ? id : DEFAULT_LANG;
  } catch { return DEFAULT_LANG; /* storage unavailable */ }
};
let lang = stored();
const listeners = new Set();

export const getLang = () => lang;

export function t(key, params) {
  const text = STRINGS[lang][key] ?? STRINGS[DEFAULT_LANG][key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : text;
}

/** The eight winds' abbreviations in the language in force, from the north clockwise */
export const compassNames = () => t('compass').split(' ');

export function setLang(id) {
  if (!isLang(id) || id === lang) return lang;
  lang = id;
  try {
    // (English is the absence of a choice)
    if (id === DEFAULT_LANG) globalThis.localStorage?.removeItem(LANG_KEY);
    else globalThis.localStorage?.setItem(LANG_KEY, id);
  } catch { /* storage unavailable */ }
  if (typeof document !== 'undefined') applyI18n();
  for (const fn of [...listeners]) fn(lang);
  return lang;
}

export function onLang(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A fly-to place (GEO.teleports: id, name in Basque, name_es): its name in the language in force, and the line under it */
export function placeName(place) {
  const eu = place.name, es = place.name_es || place.name;
  const name = lang === 'eu' ? eu : lang === 'es' ? es : PLACES_EN[place.id] || place.name_en || eu;
  // the place's own (Basque) name under a translation; under the Basque, the Spanish, as on the street plaques
  const sub = lang === 'eu' ? es : eu;
  return { name, sub: sub !== name ? sub : '' };
}

// --- The page ----------------------------------------------------------------------------------------------------------

const originals = new WeakMap(); // data-i18n-rich element -> its own (English) child nodes

// 'Words <0>in a link</0>, more words' over the element's child elements, kept by their order
function rich(el, text) {
  let kept = originals.get(el);
  if (!kept) originals.set(el, kept = [...el.childNodes].map((n) => n.cloneNode(true)));
  if (text == null) { el.replaceChildren(...kept.map((n) => n.cloneNode(true))); return; }
  const kids = kept.filter((n) => n.nodeType === 1);
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(/<(\d)>(.*?)<\/\1>/g)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const child = kids[Number(m[1])]?.cloneNode(false);
    if (child) { child.textContent = m[2]; nodes.push(child); } else nodes.push(m[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  el.replaceChildren(...nodes);
}

export function applyI18n(root = document) {
  if (root === document) document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const text = t(el.dataset.i18n);
    if (el.textContent !== text) el.textContent = text;
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [name, key] = pair.split(':').map((s) => s.trim());
      if (name && key && el.getAttribute(name) !== t(key)) el.setAttribute(name, t(key));
    }
  }
  // (English is the page's own markup)
  for (const el of root.querySelectorAll('[data-i18n-rich]')) rich(el, lang === DEFAULT_LANG ? null : STRINGS[lang][el.dataset.i18nRich]);
}

// --- The loading screen's lines ------------------------------------------------------------------------------------------
// js/donostia/main.js (and index.html's own error handler) write #loading-status in English, with numbers and the
// browser's messages in it. Each line known here is recognised by its wording and said in the language in force; a
// line that is not known comes through as it was written. Should main.js come to say its lines by key (t('status.…')),
// this table can go.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// English wording -> [pattern, key], '{n}' being whatever the line carries (a count, a percentage, a message)
const STATUS = Object.keys(STRINGS.en).filter((k) => k.startsWith('status.')).map((key) => {
  const [head, tail] = STRINGS.en[key].split('{n}');
  return [new RegExp(escape(head) + (tail === undefined ? '' : `(.*?)${escape(tail)}${tail ? '' : '$'}`)), key];
// (the longer wordings first: 'Compiling shaders… 40%' before 'Compiling shaders…')
}).sort((a, b) => STRINGS.en[b[1]].length - STRINGS.en[a[1]].length);

export function translateStatus(raw) {
  if (lang === DEFAULT_LANG || !raw) return raw;
  let out = String(raw);
  for (const [pattern, key] of STATUS) out = out.replace(pattern, (m, n) => t(key, { n: n ?? '' }));
  return out;
}

// The loading screen is on before the HUD exists: its lines are watched from here, and said again when the language
// changes
function watchLoadingScreen() {
  const overlay = document.getElementById('loading-overlay');
  const status = document.getElementById('loading-status');
  if (!overlay || !status || typeof MutationObserver !== 'function') return;
  let raw = status.textContent, shown = raw;
  const say = () => {
    if (status.textContent !== shown) raw = status.textContent; // (a new line from main.js)
    shown = translateStatus(raw);
    if (status.textContent !== shown) status.textContent = shown;
    // (main.js's button on a lost GPU)
    const reload = document.getElementById('loading-reload');
    if (reload && reload.textContent !== t('loading.reload')) reload.textContent = t('loading.reload');
  };
  new MutationObserver(say).observe(overlay, { childList: true, subtree: true, characterData: true });
  onLang(say);
  say();
}

if (typeof document !== 'undefined') {
  applyI18n();
  watchLoadingScreen();
}
