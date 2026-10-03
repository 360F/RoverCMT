// Claude-run optional exact codec check using existing reference Electron.
// Compare opaque/alpha fixtures, real raster and >1 MP crop; no GPU required.
import { app, nativeImage as electronImage } from 'electron';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeImage as roverImage } from '../dist/adapters/native-image.mjs';
import { createEraseReference } from '../tests/erase-reference.mjs';
import { writePngFromBitmap, readGeneratedBitmap } from '../dist/typography/ported/main/inpainting/imageRaster.mjs';
const [contextPath, destination] = process.argv.slice(2);
if (!contextPath || !destination) throw new Error('Expected Step3 context and new evidence directory');
const root = resolve(destination); await mkdir(root);
app.setPath('userData', join(root, 'profile')); app.disableHardwareAcceleration();
await app.whenReady();
try {
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  const reference = createEraseReference({}, { electron: { nativeImage: electronImage } });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex'), records = [];
  const compare = (caseName, actual, expected) => {
    const equal = actual.equals(expected);
    records.push({ caseName, equal, roverSha256: hash(actual), referenceSha256: hash(expected), bytes: actual.length });
  };
  const fixture = Buffer.from([3, 7, 251, 255, 0, 64, 128, 128, 0, 0, 0, 0]);
  const size = { width: 3, height: 1 };
  const referenceFixture = electronImage.createFromBitmap(fixture, size), roverFixture = roverImage.createFromBitmap(fixture, size);
  compare('bitmap-alpha', roverFixture.toBitmap(), referenceFixture.toBitmap());
  compare('png-alpha-roundtrip', (await roverImage.createFromBuffer(referenceFixture.toPNG())).toBitmap(), electronImage.createFromBuffer(referenceFixture.toPNG()).toBitmap());
  const windowsPath = path => /^[a-z]:/i.test(path) ? `/mnt/${path[0].toLowerCase()}${path.slice(2).replace(/\\+/g, '/')}` : path;
  for (const binding of context.bindings) {
    const path = windowsPath(binding.raster), ref = electronImage.createFromPath(path), own = await roverImage.createFromPath(path);
    assert.deepEqual(own.getSize(), ref.getSize()); compare(`raster:${binding.pageId}`, own.toBitmap(), ref.toBitmap());
    // Exercise reference TS write/read functions, including both resize awaits.
    const dimensions = ref.getSize(), target = { width: 1024, height: 640 };
    assert.ok(dimensions.width * dimensions.height > 1048576);
    const refPath = join(root, `${binding.pageId}-reference.png`), ownPath = join(root, `${binding.pageId}-rover.png`);
    await reference('src/main/inpainting/imageRaster.ts').writePngFromBitmap(refPath, ref.toBitmap(), dimensions.width, dimensions.height, target);
    await writePngFromBitmap(ownPath, ref.toBitmap(), dimensions.width, dimensions.height, target);
    compare(`resize:${binding.pageId}`, (await roverImage.createFromPath(ownPath)).toBitmap(), electronImage.createFromPath(refPath).toBitmap());
    const refBack = await reference('src/main/inpainting/imageRaster.ts').readGeneratedBitmap(refPath, dimensions.width, dimensions.height);
    const ownBack = await readGeneratedBitmap(refPath, dimensions.width, dimensions.height);
    compare(`resize-back:${binding.pageId}`, ownBack, refBack);
  }
  await writeFile(join(root, 'comparison.json'), JSON.stringify({ versions: process.versions, records }, null, 2), { flag: 'wx' });
  app.exit(records.every(r => r.equal) ? 0 : 1);
} catch (error) { console.error(error); app.exit(1); }
