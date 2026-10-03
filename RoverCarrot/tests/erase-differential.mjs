import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createEraseReference, eraseReference } from './erase-reference.mjs';
import { buildPatternPageMask } from '../dist/typography/ported/main/inpainting/patternPageMask.mjs';
import { prepareFluxWindow } from '../dist/typography/ported/main/inpainting/fluxWindowPreparation.mjs';
import { buildExclusivePaddedWindowMasks, expandWindowMaskToPage } from '../dist/typography/ported/main/inpainting/inpaintingWindowMask.mjs';
import { compositeConstrainedFluxOutput } from '../dist/typography/ported/main/inpainting/fluxCompositeConstraint.mjs';
import { measureMaskedRegionChange } from '../dist/typography/ported/main/inpainting/fluxChangeStats.mjs';
import { runFluxInpaint } from '../dist/typography/ported/main/inpainting/fluxEngineRunner.mjs';
import { persistActualInpaintMask, loadMaskArtifact } from '../dist/typography/ported/main/inpainting/inpaintMaskArtifact.mjs';

// Independent synchronous PNG codec for the reference Electron seam. Opaque
// synthetic request crops only; NO Rover image or algorithm imports here.
export const referenceNativeImage = {
  createFromBitmap(bytes, { width, height }) {
    const bitmap = Buffer.from(bytes);
    return { isEmpty: () => !width || !height, getSize: () => ({ width, height }), toBitmap: () => Buffer.from(bitmap),
      toPNG() { const png = new PNG({ width, height }); for (let i = 0; i < bitmap.length; i += 4) png.data.set([bitmap[i+2], bitmap[i+1], bitmap[i], bitmap[i+3]], i); return PNG.sync.write(png); },
      resize() { throw new Error('Reference seam resize forbidden: compare crop geometry separately'); } };
  },
  createFromBuffer(bytes) { const png = PNG.sync.read(bytes), bgra = Buffer.alloc(png.data.length); for (let i = 0; i < bgra.length; i += 4) bgra.set([png.data[i+2], png.data[i+1], png.data[i], png.data[i+3]], i); return this.createFromBitmap(bgra, png); },
  createFromPath(path) { return this.createFromBuffer(readFileSync(path)); },
};
export const codecReference = createEraseReference({
  'src/main/inpainting/inpaintingRuntimeLogger.ts': { logInpaintingRuntimeInfo() {}, logInpaintingRuntimeWarn() {} },
  'src/main/logger.ts': { logWarn() {} },
}, { electron: { nativeImage: referenceNativeImage } });
const moduleFor = name => eraseReference(`src/main/inpainting/${name}.ts`);
export function differentialPage(page, bitmap, extra = {}) {
  const { width, height } = page;
  const options = { page, bitmap, width, height, mode: 'flux-region', collectSourceGlyphEvidence: false, ...extra };
  const mask = buildPatternPageMask(options), expected = moduleFor('patternPageMask').buildPatternPageMask(options);
  assert.deepEqual(mask, expected, 'entire page mask context including model/composite masks and ownership');
  const cropOptions = { contextPx: 64, maskPaddingPx: 16, featherPx: 8, maxPixels: 1048576 };
  const owned = buildExclusivePaddedWindowMasks(mask.inpaintWindowMasks, width, height, 16);
  assert.deepEqual(owned, moduleFor('inpaintingWindowMask').buildExclusivePaddedWindowMasks(mask.inpaintWindowMasks, width, height, 16));
  let cropCount = 0, preservedPixels = 0;
  for (const [index, window] of mask.inpaintWindows.entries()) for (const tileLargeCrops of [false, true]) {
    const input = { mask: mask.pageMask, width, height, window, windowMask: owned[index], cropOptions, tileLargeCrops, isolateWindowMasks: true };
    const prepared = prepareFluxWindow(input);
    assert.deepEqual(prepared, moduleFor('fluxWindowPreparation').prepareFluxWindow(input), 'crop bounds, process sizes, local and validation masks');
    for (const crop of prepared.crops) {
      cropCount++;
      const generated = Buffer.alloc(crop.paddedBounds.w * crop.paddedBounds.h * 4);
      for (let i = 0; i < generated.length; i += 4) generated.set([37, 91, 173, 255], i);
      const actual = Buffer.from(bitmap), reference = Buffer.from(bitmap);
      // Exact outside-mask invariant: hard ownership constraint with zero feather.
      // Production feathered path is also compared, separately below.
      const core = mask.inpaintCompositeMasks[index], hard = [core];
      const args = { bitmap: actual, generated, effectiveMask: prepared.effectiveMask, width, height, crop, featherPx: 0, index: 0, compositeMasks: hard, compositeConstraints: hard };
      compositeConstrainedFluxOutput(args);
      moduleFor('fluxCompositeConstraint').compositeConstrainedFluxOutput({ ...args, bitmap: reference });
      assert.deepEqual(actual, reference);
      const envelope = expandWindowMaskToPage(core, width, height);
      for (let pixel = 0; pixel < envelope.length; pixel++) if (!envelope[pixel]) {
        const offset = pixel * 4;
        if (actual[offset] !== bitmap[offset] || actual[offset+1] !== bitmap[offset+1] || actual[offset+2] !== bitmap[offset+2] || actual[offset+3] !== bitmap[offset+3]) throw new Error(`Pixel outside composite mask changed: ${pixel}`);
        preservedPixels++;
      }
      const stats = measureMaskedRegionChange(bitmap, actual, mask.pageMask);
      assert.deepEqual(stats, moduleFor('fluxChangeStats').measureMaskedRegionChange(bitmap, reference, mask.pageMask));
      const feathered = { ...args, index, featherPx: mask.inpaintCompositeFeatherPx[index], compositeMasks: mask.inpaintCompositeMasks,
        compositeConstraints: mask.inpaintWindowConstraints.some(Boolean) ? mask.inpaintWindowConstraints : undefined };
      compositeConstrainedFluxOutput({ ...feathered, bitmap: actual });
      moduleFor('fluxCompositeConstraint').compositeConstrainedFluxOutput({ ...feathered, bitmap: reference });
      assert.deepEqual(actual, reference, 'production feather/composite constraints');
    }
  }
  return { usesTypographySegmentation: mask.usesKoharuTypographyComposite, blocks: mask.blocksErased, windows: mask.inpaintWindows.length, crops: cropCount, preservedPixels };
}
export async function differentialRequests(root) {
  const width = 192, height = 160, mask = new Uint8Array(width * height);
  for (let y = 40; y < 70; y++) for (let x = 50; x < 90; x++) mask[y*width+x] = 1;
  const before = Buffer.alloc(width*height*4, 255), actual = Buffer.from(before), expected = Buffer.from(before);
  const execute = async (fn, bitmap, label) => {
    const requests = [];
    await fn({ bitmap, mask, width, height, windows: [{ x: 35, y: 25, w: 80, h: 70 }], isolateWindowMasks: false, tileLargeCrops: false,
      runOptions: { featherPx: 0 }, runRootDir: join(root, label), getWorker: () => ({ async inpaint(request) {
        const input = PNG.sync.read(await readFile(request.input)), modelMask = PNG.sync.read(await readFile(request.mask));
        requests.push({ ...request, input: '<input>', mask: '<mask>', output: '<output>', inputPixels: input.data, maskPixels: modelMask.data });
        for (let i = 0; i < input.data.length; i += 4) input.data.set([37, 91, 173, 255], i);
        await writeFile(request.output, PNG.sync.write(input));
      } }) }, { warn() {} });
    return requests;
  };
  assert.deepEqual(await execute(runFluxInpaint, actual, 'rover'), await execute(codecReference('src/main/inpainting/fluxEngineRunner.ts').runFluxInpaint, expected, 'reference'));
  assert.deepEqual(actual, expected);
  for (let p = 0; p < mask.length; p++) if (!mask[p]) assert.deepEqual(actual.subarray(p*4,p*4+4), before.subarray(p*4,p*4+4));
  return { requests: 1, outsideMaskPixels: mask.filter(v => !v).length };
}
export async function differentialArtifact(root) {
  const width = 32, height = 24, page = { imagePath: join(root, 'pages', 'original.png') }, first = new Uint8Array(width*height), next = new Uint8Array(width*height);
  first[35] = 1; next[100] = 1; next[35] = 1;
  const previous = await persistActualInpaintMask({ page, mask: first, width, height, suffix: 'first' });
  const input = { page: { ...page, inpaintMaskPath: previous.path, maskProvenance: 'retouch-updated' }, mask: next, width, height, suffix: 'union' };
  const actual = await persistActualInpaintMask(input), expected = await codecReference('src/main/inpainting/inpaintMaskArtifact.ts').persistActualInpaintMask(input);
  assert.equal(actual.provenance, expected.provenance); assert.equal(actual.provenance, 'retouch-updated');
  assert.deepEqual(await readFile(actual.path), await readFile(expected.path), 'deterministic grayscale PNG bytes');
  const union = await loadMaskArtifact(actual.path, width, height);
  for (let i = 0; i < union.length; i++) assert.equal(union[i], first[i] || next[i] ? 1 : 0);
  return { pngBytes: (await readFile(actual.path)).length, unionPixels: union.filter(Boolean).length };
}

// Production-default geometry across real pages without expensive fake composite
// loops; the full differential above separately tests composite at fixed context.
export function differentialGeometry(page, bitmap) {
  const { width, height } = page;
  const bubbleLayoutConstraintBlockIds = page.blocks.filter(b => b.bubbleLayout).map(b => b.id);
  const options = { page, bitmap, width, height, mode: 'flux-region', collectSourceGlyphEvidence: false, bubbleLayoutConstraintBlockIds };
  const mask = buildPatternPageMask(options);
  assert.deepEqual(mask, moduleFor('patternPageMask').buildPatternPageMask(options));
  const owned = buildExclusivePaddedWindowMasks(mask.inpaintWindowMasks, width, height, 16);
  const isolateWindowMasks = mask.inpaintWindowConstraints.some(Boolean) || mask.usesKoharuTypographyComposite;
  let crops = 0, downscaledCrops = 0;
  for (const [index, window] of mask.inpaintWindows.entries()) for (const tileLargeCrops of [false, true]) {
    const args = { width, height, mask: mask.pageMask, window, windowMask: isolateWindowMasks ? owned[index] : undefined, isolateWindowMasks, tileLargeCrops,
      cropOptions: { contextPx: 160, maskPaddingPx: 16, featherPx: 8, maxPixels: 1048576 } };
    const result = prepareFluxWindow(args);
    assert.deepEqual(result, moduleFor('fluxWindowPreparation').prepareFluxWindow(args));
    crops += result.crops.length;
    downscaledCrops += result.crops.filter(c => c.processSize.width !== c.paddedBounds.w || c.processSize.height !== c.paddedBounds.h).length;
  }
  return { blocks: mask.blocksErased, windows: mask.inpaintWindows.length, crops, downscaledCrops, storedLayouts: bubbleLayoutConstraintBlockIds.length, contextPx: 160 };
}
