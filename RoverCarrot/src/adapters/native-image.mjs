// Minimal Electron `nativeImage` replacement for the ported erase path.
// Bitmaps are BGRA (Electron/Skia N32 on little-endian), 4 bytes per pixel.
// Decode preserves alpha; N32 bitmaps contain premultiplied colour channels.
// PNG encoders and sharp raw inputs use straight RGBA. Decode/encode/resize
// are asynchronous; the ported call sites await them (documented in STEP6_VALIDATION.md).
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const LIMIT = 120_000_000;

function bgraToRgba(bgra) {
  const rgba = Buffer.from(bgra);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = bgra[i + 3];
    for (let c = 0; c < 3; c++) rgba[i + c] = alpha ? Math.min(255, Math.round(bgra[i + 2 - c] * 255 / alpha)) : 0;
  }
  return rgba;
}

function rgbaToBgra(rgba) {
  const bgra = Buffer.from(rgba);
  for (let i = 0; i < bgra.length; i += 4) {
    for (let c = 0; c < 3; c++) bgra[i + c] = Math.round(rgba[i + 2 - c] * rgba[i + 3] / 255);
  }
  return bgra;
}

class RoverImage {
  constructor(bgra, width, height) {
    this.bgra = bgra;
    this.width = width;
    this.height = height;
  }
  isEmpty() { return !this.bgra || !this.width || !this.height; }
  getSize() { return { width: this.width, height: this.height }; }
  toBitmap() { return this.isEmpty() ? Buffer.alloc(0) : Buffer.from(this.bgra); }
  async toPNG() {
    if (this.isEmpty()) return Buffer.alloc(0);
    return sharp(bgraToRgba(this.bgra), { raw: { width: this.width, height: this.height, channels: 4 } }).png().toBuffer();
  }
  // The reference uses quality "best"; sharp lanczos3 equivalence to Electron
  // is unverified. This affects downsampled large crops and generated upsampling.
  async resize({ width, height } = {}) {
    if (this.isEmpty()) return EMPTY;
    if (width === undefined && height === undefined) return new RoverImage(Buffer.from(this.bgra), this.width, this.height);
    width ??= Math.round(height * this.width / this.height);
    height ??= Math.round(width * this.height / this.width);
    if (width <= 0 || height <= 0) return EMPTY;
    const { data, info } = await sharp(bgraToRgba(this.bgra), { raw: { width: this.width, height: this.height, channels: 4 } })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
    return new RoverImage(rgbaToBgra(data), info.width, info.height);
  }
}

const EMPTY = new RoverImage(null, 0, 0);

async function decode(input) {
  try {
    const { data, info } = await sharp(input, { failOn: 'warning', limitInputPixels: LIMIT })
      .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return new RoverImage(rgbaToBgra(data), info.width, info.height);
  } catch {
    return EMPTY;
  }
}

export const nativeImage = {
  createFromBitmap(bitmap, { width, height } = {}) {
    if (!Buffer.isBuffer(bitmap)) throw new Error('buffer must be a node Buffer');
    if (!Number.isSafeInteger(width)) throw new Error('width is required');
    if (!Number.isSafeInteger(height)) throw new Error('height is required');
    if (width <= 0 || height <= 0) return EMPTY;
    if (width * height > LIMIT) throw new Error('bitmap exceeds pixel limit');
    if (bitmap.length !== width * height * 4) throw new Error('invalid buffer size');
    return new RoverImage(Buffer.from(bitmap), width, height);
  },
  createFromBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new Error('buffer must be a node Buffer');
    return decode(buffer);
  },
  async createFromPath(path) {
    try { return await decode(await readFile(path)); } catch { return EMPTY; }
  },
};
