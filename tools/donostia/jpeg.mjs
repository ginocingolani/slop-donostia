// tools/donostia/jpeg.mjs
// A small baseline JPEG decoder (sequential DCT, Huffman, 8-bit, any chroma sampling, restart intervals): enough for
// geoEuskadi's WMS orthophoto tiles, so the bakes that read them need no image library and give the same pixels on any
// machine (the IDCT runs in float64 and rounds once). Progressive and arithmetic-coded files are refused.
//   decodeJPEG(buffer) -> { width, height, data: Uint8Array RGB }

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55,
  62, 63
]);

// IDCT basis: C[x * 8 + u] = c(u) / 2 * cos((2x + 1) u pi / 16)
const BASIS = new Float64Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) BASIS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
}

// Canonical Huffman table -> lookup by (length, code): maxcode / valptr per length, as in the spec's F.2.2.3
function huffmanTable(counts, symbols) {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k;
    mincode[len] = code;
    code += counts[len - 1];
    k += counts[len - 1];
    maxcode[len] = counts[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { maxcode, valptr, mincode, symbols };
}

export function decodeJPEG(buf) {
  const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (d[0] !== 0xff || d[1] !== 0xd8) throw new Error('not a JPEG');
  const qt = [], dc = [], ac = [];
  let frame = null, restart = 0, pos = 2;
  const u16 = (p) => (d[p] << 8) | d[p + 1];

  while (pos < d.length) {
    if (d[pos] !== 0xff) throw new Error(`JPEG: marker expected at byte ${pos}`);
    const marker = d[pos + 1];
    pos += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) continue;
    if (marker === 0xd9) break;
    const len = u16(pos), end = pos + len;
    if (marker === 0xdb) { // quantisation tables
      for (let p = pos + 2; p < end;) {
        const pq = d[p] >> 4, tq = d[p] & 15, t = new Int32Array(64);
        p++;
        for (let i = 0; i < 64; i++) { t[ZIGZAG[i]] = pq ? u16(p + 2 * i) : d[p + i]; }
        p += pq ? 128 : 64;
        qt[tq] = t;
      }
    } else if (marker === 0xc4) { // Huffman tables
      for (let p = pos + 2; p < end;) {
        const tc = d[p] >> 4, th = d[p] & 15;
        const counts = d.subarray(p + 1, p + 17);
        let n = 0;
        for (const c of counts) n += c;
        const table = huffmanTable(counts, d.slice(p + 17, p + 17 + n));
        (tc ? ac : dc)[th] = table;
        p += 17 + n;
      }
    } else if (marker === 0xc0 || marker === 0xc1) { // baseline / extended sequential
      if (d[pos + 2] !== 8) throw new Error('JPEG: only 8-bit samples');
      const height = u16(pos + 3), width = u16(pos + 5), nc = d[pos + 7];
      const comps = [];
      for (let c = 0; c < nc; c++) {
        const o = pos + 8 + 3 * c;
        comps.push({ id: d[o], h: d[o + 1] >> 4, v: d[o + 1] & 15, tq: d[o + 2] });
      }
      frame = { width, height, comps };
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error(`JPEG: unsupported coding (SOF${marker - 0xc0})`);
    } else if (marker === 0xdd) {
      restart = u16(pos + 2);
    } else if (marker === 0xda) {
      if (!frame) throw new Error('JPEG: scan before frame');
      const ns = d[pos + 2], scan = [];
      for (let s = 0; s < ns; s++) {
        const id = d[pos + 3 + 2 * s], t = d[pos + 4 + 2 * s];
        const comp = frame.comps.find((c) => c.id === id);
        scan.push({ comp, dc: dc[t >> 4], ac: ac[t & 15] });
      }
      pos = decodeScan(d, end, frame, scan, qt, restart);
      continue;
    }
    pos = end;
  }
  if (!frame || !frame.comps[0].samples) throw new Error('JPEG: no image data');
  return toRGB(frame);
}

// Decodes the entropy-coded segment from `start` into each component's sample plane; returns the position after it
function decodeScan(d, start, frame, scan, qt, restart) {
  const hmax = Math.max(...frame.comps.map((c) => c.h)), vmax = Math.max(...frame.comps.map((c) => c.v));
  const mcusX = Math.ceil(frame.width / (8 * hmax)), mcusY = Math.ceil(frame.height / (8 * vmax));
  for (const c of frame.comps) {
    c.bw = mcusX * c.h; // blocks per line, padded to whole MCUs
    c.bh = mcusY * c.v;
    c.samples = new Uint8Array(c.bw * 8 * c.bh * 8);
    c.pred = 0;
  }
  let pos = start, bits = 0, nbits = 0;
  const readBit = () => {
    if (nbits === 0) {
      let b = d[pos++];
      if (b === 0xff) {
        if (d[pos] === 0) pos++; // a stuffed 0xff
        else { b = 0; pos--; } // a marker: pad with zeros until the restart or the scan's end skips it
      }
      bits = b;
      nbits = 8;
    }
    nbits--;
    return (bits >> nbits) & 1;
  };
  const receive = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };
  const extend = (v, n) => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decodeHuff = (t) => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      if (code <= t.maxcode[len]) return t.symbols[t.valptr[len] + code - t.mincode[len]];
    }
    throw new Error('JPEG: bad Huffman code');
  };
  const coef = new Float64Array(64), tmp = new Float64Array(64);
  const block = (s, bx, by) => {
    const c = s.comp, q = qt[c.tq];
    coef.fill(0);
    const t = decodeHuff(s.dc);
    c.pred += t ? extend(receive(t), t) : 0;
    coef[0] = c.pred * q[0];
    for (let k = 1; k < 64;) {
      const rs = decodeHuff(s.ac), r = rs >> 4, size = rs & 15;
      if (!size) {
        if (r !== 15) break; // end of block
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) throw new Error('JPEG: coefficient overflow');
      coef[ZIGZAG[k]] = extend(receive(size), size) * q[ZIGZAG[k]];
      k++;
    }
    // separable IDCT: rows, then columns
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += BASIS[x * 8 + u] * coef[y * 8 + u];
        tmp[y * 8 + x] = sum;
      }
    }
    const stride = c.bw * 8, base = by * 8 * stride + bx * 8;
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let v = 0; v < 8; v++) sum += BASIS[y * 8 + v] * tmp[v * 8 + x];
        const val = Math.round(sum + 128);
        c.samples[base + y * stride + x] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
    }
  };
  const single = scan.length === 1;
  const total = single
    ? Math.ceil((Math.ceil(frame.width * scan[0].comp.h / hmax)) / 8) * Math.ceil((Math.ceil(frame.height * scan[0].comp.v / vmax)) / 8)
    : mcusX * mcusY;
  const perLine = single ? Math.ceil(Math.ceil(frame.width * scan[0].comp.h / hmax) / 8) : mcusX;
  for (let m = 0; m < total; m++) {
    if (restart && m > 0 && m % restart === 0) {
      // byte-align, skip the RSTn marker, reset the DC predictions
      nbits = 0;
      while (pos < d.length && !(d[pos] === 0xff && d[pos + 1] >= 0xd0 && d[pos + 1] <= 0xd7)) pos++;
      pos += 2;
      for (const s of scan) s.comp.pred = 0;
    }
    const mx = m % perLine, my = Math.floor(m / perLine);
    if (single) block(scan[0], mx, my);
    else {
      for (const s of scan) {
        for (let v = 0; v < s.comp.v; v++) for (let h = 0; h < s.comp.h; h++) block(s, mx * s.comp.h + h, my * s.comp.v + v);
      }
    }
  }
  // find the next marker
  while (pos < d.length && !(d[pos] === 0xff && d[pos + 1] !== 0 && !(d[pos + 1] >= 0xd0 && d[pos + 1] <= 0xd7))) pos++;
  return pos;
}

// Upsamples the chroma planes (nearest) and converts JFIF YCbCr to RGB
function toRGB(frame) {
  const { width, height, comps } = frame;
  const hmax = Math.max(...comps.map((c) => c.h)), vmax = Math.max(...comps.map((c) => c.v));
  const out = new Uint8Array(width * height * 3);
  const plane = (c, x, y) => c.samples[Math.floor((y * c.v) / vmax) * c.bw * 8 + Math.floor((x * c.h) / hmax)];
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (comps.length === 1) {
        out[o] = out[o + 1] = out[o + 2] = plane(comps[0], x, y);
        continue;
      }
      const Y = plane(comps[0], x, y), cb = plane(comps[1], x, y) - 128, cr = plane(comps[2], x, y) - 128;
      out[o] = clamp(Y + 1.402 * cr);
      out[o + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr);
      out[o + 2] = clamp(Y + 1.772 * cb);
    }
  }
  return { width, height, data: out };
}
