// Small, dependency-free animated GIF writer.
//
// Two pieces:
//   1. median-cut colour quantiser (builds one shared 256-colour palette)
//   2. LZW frame writer (GIF89a, global palette, Netscape loop extension)
//
// Kept in its own file so the bouquet page can encode the share GIF entirely
// in the browser - no server round trip, nothing leaves the device.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OwGif = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function ByteWriter(size) {
    this.buffer = new Uint8Array(size || 1 << 16);
    this.length = 0;
  }
  ByteWriter.prototype.ensure = function (extra) {
    if (this.length + extra <= this.buffer.length) return;
    let next = this.buffer.length * 2;
    while (next < this.length + extra) next *= 2;
    const bigger = new Uint8Array(next);
    bigger.set(this.buffer.subarray(0, this.length));
    this.buffer = bigger;
  };
  ByteWriter.prototype.byte = function (v) {
    this.ensure(1);
    this.buffer[this.length++] = v & 0xff;
  };
  ByteWriter.prototype.bytes = function (arr) {
    this.ensure(arr.length);
    this.buffer.set(arr, this.length);
    this.length += arr.length;
  };
  ByteWriter.prototype.short = function (v) {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  };
  ByteWriter.prototype.string = function (str) {
    for (let i = 0; i < str.length; i++) this.byte(str.charCodeAt(i));
  };
  ByteWriter.prototype.result = function () {
    return this.buffer.subarray(0, this.length);
  };

  // ------------------------------------------------------------ quantiser --
  // Median cut over the collected samples. Returns {palette: Uint8Array(768),
  // size}. Squares are split along their widest colour axis at the median.
  function quantize(samples, maxColors) {
    let pixels = samples;
    if (pixels.length / 3 > 120000) {
      const stride = Math.ceil(pixels.length / 3 / 120000);
      const out = [];
      for (let i = 0; i < pixels.length; i += 3 * stride) out.push(pixels[i], pixels[i + 1], pixels[i + 2]);
      pixels = out;
    }
    const n = pixels.length / 3;
    const boxOf = (from, to) => {
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
      for (let i = from; i < to; i++) {
        const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
        if (r < rmin) rmin = r; if (r > rmax) rmax = r;
        if (g < gmin) gmin = g; if (g > gmax) gmax = g;
        if (b < bmin) bmin = b; if (b > bmax) bmax = b;
      }
      const range = Math.max(rmax - rmin, gmax - gmin, bmax - bmin);
      return { from, to, range, weight: to - from, color: [(rmin + rmax) >> 1, (gmin + gmax) >> 1, (bmin + bmax) >> 1] };
    };

    const boxes = [boxOf(0, n)];
    while (boxes.length < maxColors) {
      // split the widest box that still holds more than one colour cluster
      let target = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.to - b.from < 2) continue;
        const score = b.range * Math.sqrt(b.weight);
        if (score > best) { best = score; target = i; }
      }
      if (target < 0) break;
      const box = boxes[target];
      // choose the channel with the widest spread and sort by it
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
      for (let i = box.from; i < box.to; i++) {
        const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
        if (r < rmin) rmin = r; if (r > rmax) rmax = r;
        if (g < gmin) gmin = g; if (g > gmax) gmax = g;
        if (b < bmin) bmin = b; if (b > bmax) bmax = b;
      }
      const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
      const ch = dr >= dg && dr >= db ? 0 : dg >= db ? 1 : 2;
      const idx = [];
      for (let i = box.from; i < box.to; i++) idx.push(i);
      idx.sort((a, b) => pixels[a * 3 + ch] - pixels[b * 3 + ch]);
      const tmp = new Uint8Array((box.to - box.from) * 3);
      for (let i = 0; i < idx.length; i++) {
        const src = idx[i] * 3;
        tmp[i * 3] = pixels[src]; tmp[i * 3 + 1] = pixels[src + 1]; tmp[i * 3 + 2] = pixels[src + 2];
      }
      for (let i = 0; i < idx.length; i++) {
        const src = box.from * 3 + i * 3;
        pixels[src] = tmp[i * 3]; pixels[src + 1] = tmp[i * 3 + 1]; pixels[src + 2] = tmp[i * 3 + 2];
      }
      const mid = box.from + ((box.to - box.from) >> 1);
      boxes[target] = boxOf(box.from, mid);
      boxes.push(boxOf(mid, box.to));
    }

    const size = boxes.length;
    const palette = new Uint8Array(768);
    for (let i = 0; i < size; i++) {
      const from = boxes[i].from, to = boxes[i].to;
      let r = 0, g = 0, b = 0;
      for (let j = from; j < to; j++) { r += pixels[j * 3]; g += pixels[j * 3 + 1]; b += pixels[j * 3 + 2]; }
      const k = Math.max(1, to - from);
      palette[i * 3] = Math.round(r / k);
      palette[i * 3 + 1] = Math.round(g / k);
      palette[i * 3 + 2] = Math.round(b / k);
    }
    return { palette, size };
  }

  // RGB565 lookup cache -> nearest palette index
  function makeMapper(palette, size) {
    const cache = new Int16Array(32768).fill(-1);
    return function map(r, g, b) {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let found = cache[key];
      if (found >= 0) return found;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < size; i++) {
        const dr = r - palette[i * 3], dg = g - palette[i * 3 + 1], db = b - palette[i * 3 + 2];
        const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      cache[key] = best;
      return best;
    };
  }

  // ------------------------------------------------------------------ LZW --
  function lzwEncode(indices, minCodeSize, out) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let dict = new Map();

    let cur = 0;
    let shift = 0;
    const block = [];
    const flushBlock = () => {
      if (!block.length) return;
      out.byte(block.length);
      out.bytes(block);
      block.length = 0;
    };
    const emit = (code) => {
      cur |= code << shift;
      shift += codeSize;
      while (shift >= 8) {
        block.push(cur & 0xff);
        cur >>>= 8;
        shift -= 8;
        if (block.length === 255) flushBlock();
      }
    };
    const resetDict = () => {
      dict = new Map();
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    };

    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) { prefix = found; continue; }
      emit(prefix);
      if (nextCode < 4096) {
        dict.set(key, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(clearCode);
        resetDict();
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    // flush any partial byte
    if (shift > 0) {
      block.push(cur & 0xff);
      if (block.length === 255) flushBlock();
    }
    flushBlock();
    out.byte(0);
  }

  // --------------------------------------------------------------- writer --
  // frames: [{ indices, delay, x, y, w, h }] - x/y/w/h default to the full
  // canvas, but a partial rectangle lets us store only what moved.
  function encode(frames, width, height, palette, size, loop) {
    if (loop === undefined) loop = 0;
    const out = new ByteWriter(width * height);
    out.string('GIF89a');
    out.short(width);
    out.short(height);
    // GIF colour tables are a power of two, at least 2 entries. The packed
    // field stores that value minus one.
    let bits = 1;
    while ((1 << bits) < size) bits++;
    const tableSize = 1 << bits;
    out.byte(0x80 | (bits - 1));            // global colour table of `tableSize` entries
    out.byte(0);                            // background index
    out.byte(0);                            // pixel aspect ratio
    for (let i = 0; i < tableSize; i++) {
      out.byte(palette[i * 3] || 0);
      out.byte(palette[i * 3 + 1] || 0);
      out.byte(palette[i * 3 + 2] || 0);
    }
    // loop: 0 = forever, n = repeat n times, false/null = play once
    if (loop !== false && loop !== null) {
      out.byte(0x21); out.byte(0xff); out.byte(11);
      out.string('NETSCAPE2.0');
      out.byte(3); out.byte(1); out.short(loop || 0); out.byte(0);
    }
    const minCodeSize = Math.max(2, bits);  // LZW needs at least 2 bits
    for (const frame of frames) {
      // graphic control: delay + disposal 1 (do not dispose)
      out.byte(0x21); out.byte(0xf9); out.byte(4);   // graphic control ext
      out.byte(0x04);                                // disposal = do not dispose
      out.short(Math.max(2, Math.round(frame.delay)));
      out.byte(0);                                   // transparent index (unused)
      out.byte(0);                                   // block terminator
      out.byte(0x2c);
      out.short(frame.x || 0); out.short(frame.y || 0);
      out.short(frame.w || width); out.short(frame.h || height);
      out.byte(0);
      out.byte(minCodeSize);
      lzwEncode(frame.indices, minCodeSize, out);
    }
    out.byte(0x3b);
    return out.result();
  }

  // Convenience: quantise stacked RGBA frames and encode them.
  // When opts.delta is set, only the rectangle that changed is stored for each
  // frame after the first, which shrinks a twinkling-star animation a lot.
  // frames: [{ data: RGBA, delay }]
  function encodeFrames(frames, width, height, opts) {
    opts = opts || {};
    const maxColors = Math.min(256, opts.maxColors || 256);

    // ---- palette from a spread of samples across all frames
    const sample = [];
    const step = Math.max(1, Math.floor((width * height) / 38000));
    frames.forEach((frame) => {
      const d = frame.data;
      for (let p = 0; p < width * height; p += step) {
        const i = p * 4;
        sample.push(d[i], d[i + 1], d[i + 2]);
      }
    });
    const { palette, size } = quantize(new Uint8Array(sample), maxColors);
    const map = makeMapper(palette, size);

    const mapFrame = (data) => {
      const indices = new Uint8Array(width * height);
      for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
        indices[p] = map(data[i], data[i + 1], data[i + 2]);
      }
      return indices;
    };

    const outFrames = [];
    let previous = null;
    for (const frame of frames) {
      const indices = mapFrame(frame.data);
      if (!previous || !opts.delta) {
        outFrames.push({ indices, delay: frame.delay, x: 0, y: 0, w: width, h: height });
      } else {
        // bounding box of changed pixels, padded to whole 8px blocks
        let x0 = width, y0 = height, x1 = -1, y1 = -1;
        for (let y = 0; y < height; y++) {
          const row = y * width;
          for (let x = 0; x < width; x++) {
            if (indices[row + x] !== previous[row + x]) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) {
          // nothing moved: reuse a 1x1 pixel of the previous frame
          outFrames.push({ indices: new Uint8Array(1), delay: frame.delay, x: 0, y: 0, w: 1, h: 1 });
        } else {
          x0 = Math.max(0, x0 - (x0 % 8));
          y0 = Math.max(0, y0 - (y0 % 8));
          x1 = Math.min(width - 1, x1 + (7 - (x1 % 8)));
          y1 = Math.min(height - 1, y1 + (7 - (y1 % 8)));
          const w = x1 - x0 + 1, h = y1 - y0 + 1;
          const crop = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) {
            crop.set(indices.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + w), y * w);
          }
          outFrames.push({ indices: crop, delay: frame.delay, x: x0, y: y0, w, h });
        }
      }
      previous = indices;
    }
    return encode(outFrames, width, height, palette, size, opts.loop === undefined ? 0 : opts.loop);
  }

  return { quantize, makeMapper, lzwEncode, encode, encodeFrames };
});
