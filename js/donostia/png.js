// js/donostia/png.js
// Minimal exact PNG decoder for the baked data images (8-bit gray / RGB / RGBA, non-interlaced). Image decoding through
// <img> / createImageBitmap may colour-manage or premultiply, which would corrupt the packed 16-bit heights.
//
// decodePNGOffThread() runs the decode (and an optional reshaping of the pixels, see TRANSFORMS) in a module worker
// running this very file, so the ~100 MB of terrain & ground maps unpack in parallel and off the main thread, and only
// the final arrays come back (transferred, not copied). Without workers (Node tools, old browsers) it decodes here.

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePNG(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => data[i] === b)) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < data.length) {
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
  const zipped = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idat) { zipped.set(c, off); off += c.length; }
  const raw = await inflate(zipped);
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= channels ? out[prev + i - channels] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + i] = (raw[src + i] + p) & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

// Reshapings of a decoded image, run next to the decode: name -> (image, arg) -> { ...fields, transfer: [buffers] }
const TRANSFORMS = {
  // a grey image of `arg` planes stacked vertically -> one RGBA texel per pixel of a plane (the ground maps)
  planesToRGBA(img, planes) {
    const h = img.height / planes, n = img.width * h, src = img.data, rgba = new Uint8Array(4 * n);
    for (let p = 0; p < planes; p++) {
      const base = p * n;
      for (let k = 0; k < n; k++) rgba[4 * k + p] = src[base + k];
    }
    return { width: img.width, height: h, channels: 4, data: rgba, transfer: [rgba.buffer] };
  },
  // terrain RGB (R, G: height in cm + offset·100, big-endian; B: class) -> heights (m), classes and the heights as
  // half floats for the GPU (terrain.js HeightField)
  heightField(img, offset) {
    const n = img.width * img.height, px = img.data;
    const heights = new Float32Array(n), classes = new Uint8Array(n), half = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      heights[k] = ((px[3 * k] << 8) | px[3 * k + 1]) / 100 - offset;
      classes[k] = px[3 * k + 2];
      half[k] = toHalfFloat(heights[k]);
    }
    return { width: img.width, height: img.height, heights, classes, half, transfer: [heights.buffer, classes.buffer, half.buffer] };
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
  const img = await decodePNG(buffer);
  if (!transform) return { ...img, transfer: [img.data.buffer] };
  return TRANSFORMS[transform](img, arg);
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
}

// --- main side ---------------------------------------------------------------------------------------------------------

const POOL = 4; // workers: the five data images decode side by side
const workers = [];
let nextWorker = 0, nextId = 0, workersFailed = false;
const pending = new Map();

function worker() {
  if (workersFailed || typeof Worker === 'undefined') return null;
  try {
    if (workers.length < POOL) {
      const w = new Worker(new URL('./png.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data: { id, result, error } }) => {
        const job = pending.get(id);
        pending.delete(id);
        if (error) job.reject(new Error(error));
        else job.resolve(result);
      };
      w.onerror = (e) => {
        // a worker that can't start (no module workers): decode on the main thread from now on
        workersFailed = true;
        for (const [id, job] of pending) if (job.worker === w) { pending.delete(id); job.fallback(); }
        e.preventDefault?.();
      };
      workers.push(w);
    }
    return workers[nextWorker++ % workers.length];
  } catch {
    workersFailed = true;
    return null;
  }
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
  const w = worker();
  if (!w) return local();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    // (the buffer is copied for the fallback only if the worker fails before taking it)
    const copy = buffer.slice(0);
    pending.set(id, { resolve, reject, worker: w, fallback: () => decodeAndTransform(copy, transform, arg).then(({ transfer, ...r }) => resolve(r), reject) });
    w.postMessage({ id, buffer, transform, arg }, [buffer]);
  });
}
