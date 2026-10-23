// js/donostia/png.js
// Minimal exact PNG decoder for the baked data images (8-bit gray / RGB / RGBA, non-interlaced). Image decoding through
// <img> / createImageBitmap may colour-manage or premultiply, which would corrupt the packed 16-bit heights.
//
// The image data is inflated as a stream and unfiltered one row at a time straight into its destination (the plain
// pixels, or a reshaping of them, see TRANSFORMS), so neither the whole inflated stream nor a second copy of the image
// is ever held: the 86 MB ground map peaks at its final size instead of three times it.
//
// decodePNGOffThread() runs the decode in a module worker running this very file, so the ~100 MB of terrain & ground
// maps unpack in parallel and off the main thread, and only the final arrays come back (transferred, not copied).
// Without workers (Node tools, old browsers) it decodes here.

function parsePNG(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => data[i] === b)) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos + 8 <= data.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit non-interlaced PNGs are supported');
      channels = { 0: 1, 2: 3, 6: 4 }[body[9]];
      if (!channels) throw new Error(`unsupported PNG colour type ${body[9]}`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!channels) throw new Error('PNG without a header');
  return { width, height, channels, idat };
}

// Undoes a row's filter in place (row: the filtered bytes, prev: the previous row unfiltered, zeros above the first)
function unfilter(filter, row, prev, bpp) {
  const n = row.length;
  switch (filter) {
    case 0:
      return;
    case 1: // sub
      for (let i = bpp; i < n; i++) row[i] += row[i - bpp];
      return;
    case 2: // up
      for (let i = 0; i < n; i++) row[i] += prev[i];
      return;
    case 3: // average
      for (let i = 0; i < bpp; i++) row[i] += prev[i] >> 1;
      for (let i = bpp; i < n; i++) row[i] += (row[i - bpp] + prev[i]) >> 1;
      return;
    case 4: // Paeth (with nothing to the left it picks the byte above)
      for (let i = 0; i < bpp; i++) row[i] += prev[i];
      for (let i = bpp; i < n; i++) {
        const a = row[i - bpp], b = prev[i], c = prev[i - bpp];
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        row[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      return;
    default:
      throw new Error(`bad PNG row filter ${filter}`);
  }
}

// Inflates the image data and hands each unfiltered row to onRow(y, row). The row's array is reused for the rows
// after it: onRow copies what it keeps.
async function eachRow({ width, height, channels, idat }, onRow) {
  const stride = width * channels;
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let y = 0, filter = -1, fill = 0;
  const reader = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let k = 0; k < value.length && y < height;) {
      if (filter < 0) { filter = value[k++]; continue; }
      const n = Math.min(stride - fill, value.length - k);
      cur.set(value.subarray(k, k + n), fill);
      fill += n;
      k += n;
      if (fill < stride) continue;
      unfilter(filter, cur, prev, channels);
      onRow(y++, cur);
      [prev, cur] = [cur, prev];
      filter = -1;
      fill = 0;
    }
  }
  if (y < height) throw new Error(`truncated PNG: ${y} of ${height} rows`);
}

// What the decoded rows become: name -> (header, arg) -> { onRow(y, row), done() -> { ...fields, transfer: [buffers] } }
const TRANSFORMS = {
  // the plain pixels: { width, height, channels, data }
  image({ width, height, channels }) {
    const stride = width * channels, data = new Uint8Array(stride * height);
    return {
      onRow: (y, row) => data.set(row, y * stride),
      done: () => ({ width, height, channels, data, transfer: [data.buffer] })
    };
  },
  // a grey image of `planes` planes stacked vertically -> one RGBA texel per pixel of a plane (the ground maps)
  planesToRGBA({ width, height, channels }, planes) {
    const h = height / planes;
    if (channels !== 1 || !(planes >= 1 && planes <= 4) || !Number.isInteger(h)) {
      throw new Error(`planesToRGBA: a grey image of 1-4 planes expected, got ${channels} channels, ${height} rows / ${planes}`);
    }
    const rgba = new Uint8Array(4 * width * h);
    return {
      onRow(y, row) {
        const p = Math.floor(y / h), base = 4 * (y - p * h) * width + p;
        for (let i = 0; i < width; i++) rgba[base + 4 * i] = row[i];
      },
      done: () => ({ width, height: h, channels: 4, data: rgba, transfer: [rgba.buffer] })
    };
  },
  // terrain RGB (R, G: height in cm + offset·100, big-endian; B: class) -> heights (m), classes and the heights as
  // half floats for the GPU (terrain.js HeightField)
  heightField({ width, height, channels }, offset) {
    if (channels !== 3) throw new Error(`heightField: an RGB image expected, got ${channels} channels`);
    const n = width * height;
    const heights = new Float32Array(n), classes = new Uint8Array(n), half = new Uint16Array(n);
    return {
      onRow(y, row) {
        for (let i = 0, k = y * width; i < width; i++, k++) {
          heights[k] = ((row[3 * i] << 8) | row[3 * i + 1]) / 100 - offset;
          classes[k] = row[3 * i + 2];
          half[k] = toHalfFloat(heights[k]);
        }
      },
      done: () => ({ width, height, heights, classes, half, transfer: [heights.buffer, classes.buffer, half.buffer] })
    };
  }
};

// IEEE 754 binary16 of a float: THREE.DataUtils.toHalfFloat (three.js r186, MIT; table-based, truncating) copied so
// the workers need no three.js and the half floats stay bit-identical
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
let halfTables = null;
function toHalfFloat(val) {
  if (!halfTables) {
    const base = new Uint32Array(512), shift = new Uint32Array(512);
    for (let i = 0; i < 256; ++i) {
      const e = i - 127;
      if (e < -27) { base[i] = 0x0000; base[i | 0x100] = 0x8000; shift[i] = shift[i | 0x100] = 24; }
      else if (e < -14) { base[i] = 0x0400 >> (-e - 14); base[i | 0x100] = (0x0400 >> (-e - 14)) | 0x8000; shift[i] = shift[i | 0x100] = -e - 1; }
      else if (e <= 15) { base[i] = (e + 15) << 10; base[i | 0x100] = ((e + 15) << 10) | 0x8000; shift[i] = shift[i | 0x100] = 13; }
      else if (e < 128) { base[i] = 0x7c00; base[i | 0x100] = 0xfc00; shift[i] = shift[i | 0x100] = 24; }
      else { base[i] = 0x7c00; base[i | 0x100] = 0xfc00; shift[i] = shift[i | 0x100] = 13; }
    }
    halfTables = { base, shift };
  }
  f32[0] = Math.min(Math.max(val, -65504), 65504);
  const f = u32[0];
  const e = (f >> 23) & 0x1ff;
  return halfTables.base[e] + ((f & 0x007fffff) >> halfTables.shift[e]);
}

async function decodeAndTransform(buffer, transform, arg) {
  const make = TRANSFORMS[transform || 'image'];
  if (!make) throw new Error(`unknown PNG transform ${transform}`);
  const header = parsePNG(buffer);
  const sink = make(header, arg);
  await eachRow(header, sink.onRow);
  return sink.done();
}

/** Decodes a PNG (ArrayBuffer) here: { width, height, channels, data } */
export async function decodePNG(buffer) {
  const { transfer, ...image } = await decodeAndTransform(buffer, null);
  return image;
}

// --- worker side ---------------------------------------------------------------------------------------------------------

const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
if (inWorker) {
  self.onmessage = async ({ data: { id, buffer, transform, arg } }) => {
    try {
      const { transfer, ...result } = await decodeAndTransform(buffer, transform, arg);
      self.postMessage({ id, result }, transfer);
    } catch (e) {
      self.postMessage({ id, error: e.message || String(e) });
    }
  };
  // the page hands its buffers over only once it knows this worker runs (see decodePNGOffThread)
  self.postMessage({ ready: true });
}

// --- main side ---------------------------------------------------------------------------------------------------------

const POOL = 4; // workers: the data images decode side by side
let pool = null; // [{ worker, ready, jobs, dead }], empty without workers
let nextWorker = 0, nextId = 0;

function workerPool() {
  if (pool) return pool;
  pool = [];
  if (typeof Worker === 'undefined') return pool;
  for (let k = 0; k < POOL; k++) {
    let worker;
    try {
      worker = new Worker(new URL('./png.js', import.meta.url), { type: 'module' });
    } catch {
      break; // no module workers: decode on the main thread
    }
    const entry = { worker, jobs: new Map(), dead: false };
    entry.ready = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.ready) { resolve(); return; }
        const job = entry.jobs.get(data.id);
        entry.jobs.delete(data.id);
        if (data.error) job?.reject(new Error(data.error));
        else job?.resolve(data.result);
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        entry.dead = true;
        const error = new Error(`PNG decoder worker failed: ${e.message || 'could not start'}`);
        // before its handshake (it never ran): the jobs waiting for it still hold their buffers and decode here
        reject(error);
        // after it: the jobs it was running took their buffers along
        for (const job of entry.jobs.values()) job.reject(error);
        entry.jobs.clear();
      };
    });
    entry.ready.catch(() => {}); // (each job handles it)
    pool.push(entry);
  }
  return pool;
}

/**
 * Decodes a PNG (ArrayBuffer, detached by the call) in a worker and applies an optional transform of TRANSFORMS
 * ('planesToRGBA' with the plane count, 'heightField' with the height offset). Resolves to the decoded image
 * { width, height, channels, data } or the transform's result.
 */
export function decodePNGOffThread(buffer, transform = null, arg = null) {
  const local = async () => {
    const { transfer, ...result } = await decodeAndTransform(buffer, transform, arg);
    return result;
  };
  const live = workerPool().filter((e) => !e.dead);
  if (!live.length) return local();
  const entry = live[nextWorker++ % live.length];
  // The buffer moves to the worker (transferred, never copied) once the worker has said it runs: one that can't
  // start leaves it here, to decode on this thread
  return entry.ready.then(() => {
    if (entry.dead) return local();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      entry.jobs.set(id, { resolve, reject });
      entry.worker.postMessage({ id, buffer, transform, arg }, [buffer]);
    });
  }, local);
}
