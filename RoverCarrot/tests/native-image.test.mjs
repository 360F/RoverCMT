import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { nativeImage } from '../dist/adapters/native-image.mjs';
import { writePngFromBitmap, readGeneratedBitmap } from '../dist/typography/ported/main/inpainting/imageRaster.mjs';

test('native image BGRA copy, opaque PNG/Buffer/Path round trip and empty input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rover-native-'));
  try {
    const bgra = Buffer.from([3, 7, 251, 255, 240, 18, 2, 255]);
    const image = nativeImage.createFromBitmap(bgra, { width: 2, height: 1 });
    bgra[0] = 90;
    assert.equal(image.toBitmap()[0], 3);
    const copy = image.toBitmap(); copy[1] = 0; assert.equal(image.toBitmap()[1], 7);
    const png = await image.toPNG(), path = join(dir, 'image.png'); await writeFile(path, png);
    const rgba = await sharp(png).ensureAlpha().raw().toBuffer();
    assert.deepEqual(rgba, Buffer.from([251, 7, 3, 255, 2, 18, 240, 255]));
    for (const decoded of [await nativeImage.createFromBuffer(png), await nativeImage.createFromPath(path)]) {
      assert.deepEqual(decoded.getSize(), { width: 2, height: 1 }); assert.deepEqual(decoded.toBitmap(), image.toBitmap());
    }
    for (const empty of [await nativeImage.createFromBuffer(Buffer.from('bad')), await nativeImage.createFromPath(join(dir, 'absent')), nativeImage.createFromBitmap(Buffer.alloc(0), { width: 0, height: 1 })]) {
      assert.equal(empty.isEmpty(), true); assert.equal(empty.toBitmap().length, 0); assert.equal((await empty.toPNG()).length, 0);
    }
  } finally { await rm(dir, { recursive: true }); }
});
test('alpha is preserved in premultiplied BGRA, giving black-flattened RGB without losing alpha', async () => {
  const rgba = Buffer.from([255, 128, 0, 128, 255, 18, 99, 0]);
  const png = await sharp(rgba, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const image = await nativeImage.createFromBuffer(png);
  assert.deepEqual(image.toBitmap(), Buffer.from([0, 64, 128, 128, 0, 0, 0, 0]));
  assert.deepEqual((await nativeImage.createFromBuffer(await image.toPNG())).toBitmap(), image.toBitmap());
});
test('async resize and >1 MP crop encode/decode path has dimensions and constant pixels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rover-resize-'));
  try {
    const width = 1536, height = 1024, bitmap = Buffer.alloc(width * height * 4);
    for (let i = 0; i < bitmap.length; i += 4) bitmap.set([17, 43, 91, 255], i);
    const path = join(dir, 'crop.png');
    await writePngFromBitmap(path, bitmap, width, height, { width: 1024, height: 640 });
    assert.deepEqual((await nativeImage.createFromPath(path)).getSize(), { width: 1024, height: 640 });
    assert.deepEqual(await readGeneratedBitmap(path, width, height), bitmap);
  } finally { await rm(dir, { recursive: true }); }
});

test('bitmap argument/length errors and resize aspect semantics follow the reference API subset', async () => {
  assert.throws(() => nativeImage.createFromBitmap(new Uint8Array(4), { width: 1, height: 1 }), /node Buffer/);
  assert.throws(() => nativeImage.createFromBitmap(Buffer.alloc(5), { width: 1, height: 1 }), /invalid buffer size/);
  assert.throws(() => nativeImage.createFromBitmap(Buffer.alloc(3), { width: 1, height: 1 }), /invalid buffer size/);
  assert.throws(() => nativeImage.createFromBitmap(Buffer.alloc(4), {}), /width is required/);
  assert.throws(() => nativeImage.createFromBuffer('bad'), /node Buffer/);
  const image = nativeImage.createFromBitmap(Buffer.alloc(8*4*4, 255), { width: 8, height: 4 });
  assert.deepEqual((await image.resize({ width: 4 })).getSize(), { width: 4, height: 2 });
  assert.deepEqual((await image.resize({ height: 8 })).getSize(), { width: 16, height: 8 });
  assert.deepEqual((await image.resize()).toBitmap(), image.toBitmap());
  assert.equal((await image.resize({ width: 0, height: 0 })).isEmpty(), true);
});
