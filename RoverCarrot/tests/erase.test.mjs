import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { erasePage, defaultErasePlan } from '../dist/erase/erase.mjs';
import { eraseStage } from '../dist/erase/stage.js';
import { workflowTargetBlocks, workflowRegionKey } from '../dist/typography/ported/shared/pageWorkflowPolicy.mjs';
import { runBubbleLayoutMaskPrepass } from '../dist/typography/ported/main/jobs/bubbleLayoutJob.mjs';
import { resolveConfig } from '../dist/core/config.js';
import { eraseReference } from './erase-reference.mjs';
import { differentialPage, differentialRequests, differentialArtifact } from './erase-differential.mjs';
const block = { id: 'a', bbox: { x: 100, y: 100, w: 200, h: 200 }, bboxSpace: 'normalized_1000', fontSizePx: 20, sourceText: '', translatedText: '', outlineWidthPx: 0 };
const page = { id: 'p', width: 200, height: 160, blocks: [block, { ...block, id: 'b', bbox: { x: 650, y: 650, w: 200, h: 200 } }] };
const withTmp = async fn => { const dir = await mkdtemp(join(tmpdir(), 'rover-erase-')); try { return await fn(dir); } finally { await rm(dir, { recursive: true }); } };

test('target selection exactly matches reference including missing translation, exclusions and prior binding', () => {
  for (const overwrite of [[], ['erase']]) for (const variant of [page, { ...page, inpaintedImagePath: 'prior', erasedWorkflowRegions: { a: workflowRegionKey(page, block) } }, { ...page, blocks: [{ ...block, inpaintExcluded: true }] }]) {
    const plan = { ...defaultErasePlan, overwrite };
    assert.deepEqual(workflowTargetBlocks(variant, 'erase', plan), eraseReference('src/shared/pageWorkflowPolicy.ts').workflowTargetBlocks(variant, 'erase', plan));
  }
});
test('mask, crop/tiling, model/composite mask and outside-mask bytes match unmodified TS', () => {
  for (const variant of [page, { ...page, blocks: [{ ...block, bbox: { x: -20, y: 930, w: 100, h: 100 } }] }, { ...page, width: 1600, height: 1000, blocks: [{ ...block, bbox: { x: 20, y: 20, w: 960, h: 960 } }] }])
    assert.ok(differentialPage(variant, Buffer.alloc(variant.width * variant.height * 4, 255)).crops > 0);
});
test('request construction and fake generated crop composite exact; mask union PNG bytes exact', () => withTmp(async dir => {
  assert.equal((await differentialRequests(dir)).requests, 1); assert.equal((await differentialArtifact(dir)).unionPixels, 2);
}));
test('prepass request, best-effort failure and layout restoration inventory match reference', async () => {
  const calls = [], runner = { async runPage(input) { calls.push(input); return { patches: [] }; } };
  const input = { page, blockIds: ['a'], config: { policy: 'balanced', overwriteManual: false }, runner, signal: new AbortController().signal };
  const actual = await runBubbleLayoutMaskPrepass(input), expected = await eraseReference('src/main/jobs/bubbleLayoutJob.ts').runBubbleLayoutMaskPrepass(input);
  assert.deepEqual(actual, expected); assert.equal(calls[0].paddingRatio, 0); assert.equal(calls[0].includeTypographySegmentation, true);
  const failure = { ...input, runner: { async runPage() { throw new Error('detector failed'); } } };
  assert.deepEqual(await runBubbleLayoutMaskPrepass(failure), await eraseReference('src/main/jobs/bubbleLayoutJob.ts').runBubbleLayoutMaskPrepass(failure));
});
test('erase stage preserves partial result, fails page, binds only changed blocks and restores transient layout', () => withTmp(async dir => {
  await mkdir(join(dir, 'pages')); const imagePath = join(dir, 'pages', 'original.png');
  const png = new PNG({ width: page.width, height: page.height }); png.data.fill(255); await writeFile(imagePath, PNG.sync.write(png));
  let release = 0, prepass = 0;
  const engine = { model: 'flux-klein', async dispose() {}, async inpaint(bitmap, width, height, mask, windows, options) {
    assert.equal(options.requirePixelChange, false); assert.equal(options.maxPixels, 1048576); assert.equal(options.contextPx, 160);
    const first = options.compositeMasks[0];
    for (let y = 0; y < first.bounds.h; y++) for (let x = 0; x < first.bounds.w; x++) if (first.data[y*first.bounds.w+x]) bitmap[((first.bounds.y+y)*width+first.bounds.x+x)*4] = 0;
  } };
  const options = { plan: defaultErasePlan, stages: ['erase', 'layout'], acquireEngine: async () => ({ engine, async release() { release++; } }), runner: { async runPage() { prepass++; return { patches: [] }; } } };
  const result = await eraseStage(options).execute({ ...page, imagePath });
  assert.equal(result.status, 'failed'); assert.equal(prepass, 1); assert.equal(release, 1);
  assert.deepEqual(result.page.erasedWorkflowRegions, { a: workflowRegionKey({ ...page, imagePath }, block) });
  assert.ok(result.page.inpaintedImagePath); assert.ok(result.page.inpaintMaskPath);
  assert.equal(PNG.sync.read(await readFile(result.page.inpaintedImagePath)).width, page.width);
  assert.deepEqual(result.page.blocks, page.blocks, 'no transient prepass fields committed');
  const unchanged = { ...engine, async inpaint() {} };
  const failed = await eraseStage({ ...options, acquireEngine: async () => ({ engine: unchanged, async release() {} }) }).execute({ ...page, imagePath });
  assert.equal(failed.status, 'failed'); assert.equal(failed.page.inpaintedImagePath, undefined);
  await assert.rejects(erasePage({ ...page, imagePath }, { ...options, acquireEngine: async () => ({ engine: { ...engine, async inpaint() { throw new Error('crop failed'); } }, async release() { release++; } }) }), /crop failed/);
  assert.equal(release, 2);
}));
test('empty/excluded erase avoids engine; config validates every supplied field', async () => {
  const noAcquire = async () => { throw new Error('must not acquire'); };
  for (const input of [{ ...page, blocks: [] }, { ...page, blocks: [{ ...block, inpaintExcluded: true }] }])
    assert.equal(await erasePage(input, { plan: defaultErasePlan, stages: ['erase'], acquireEngine: noAcquire }), input);
  const raw = { version: 1, mode: 'smoke', input: '/input', output: '/output' };
  const inpainting = { backend: 'flux-klein-cuda', runnerPath: '/runner', cudaLibraryDir: '/lib', modelPath: '/model', vaePath: '/vae', modelIdentityPath: '/receipt' };
  assert.deepEqual(resolveConfig({ ...raw, inpainting }).inpainting, inpainting);
  assert.equal(resolveConfig({ ...raw, inpainting: { ...inpainting, cudaDriverLibraryDir: '/driver' } }).inpainting.cudaDriverLibraryDir, '/driver');
  for (const cudaDriverLibraryDir of ['', 'relative', 12]) assert.throws(() => resolveConfig({ ...raw, inpainting: { ...inpainting, cudaDriverLibraryDir } }), /cudaDriverLibraryDir/);
  assert.throws(() => resolveConfig({ ...raw, inpainting: { ...inpainting, cudaDriverDir: '/driver' } }), /Unknown/);
  assert.equal(resolveConfig({ ...raw, inpainting: {} }).inpainting, undefined);
  for (const patch of [{ backend: 'cpu' }, { runnerPath: 'relative' }, { cudaLibraryDir: 3 }, { vaePath: '' }, { modelIdentityPath: false }, { unknown: 'x' }])
    assert.throws(() => resolveConfig({ ...raw, inpainting: { ...inpainting, ...patch } }));
  assert.throws(() => resolveConfig({ ...raw, inpainting: { modelIdentityPath: '/receipt' } }));
});

test('transient bubble geometry is used for masks then restored exactly', () => withTmp(async dir => {
  await mkdir(join(dir, 'pages'));
  const imagePath = join(dir, 'pages', 'original.png'), png = new PNG({ width: 200, height: 160 }); png.data.fill(255);
  await writeFile(imagePath, PNG.sync.write(png));
  const layout = { version: 1, origin: 'detected', modelId: 'koharu-layout-rfdetr-fixture', sourceImageRevision: 'fixed', direction: 'horizontal', confidence: 1, insetRatio: 0,
    regions: [{ spans: [{ blockStart: .05, blockEnd: .45, inlineStart: .05, inlineEnd: .45 }] }] };
  let called = false;
  const output = await erasePage({ ...page, blocks: [block], imagePath }, { plan: defaultErasePlan, stages: ['erase', 'layout'],
    runner: { async runPage() { return { patches: [{ blockId: 'a', bubbleLayout: layout, renderBbox: { x: 50, y: 50, w: 400, h: 400 } }] }; } },
    acquireEngine: async () => ({ release: async () => {}, engine: { model: 'flux-klein', dispose: async () => {},
      async inpaint(bitmap, width, height, mask, windows, options) {
        called = true;
        assert.ok(options.compositeConstraints[0], 'transient layout must constrain erase');
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y*width+x]) bitmap[(y*width+x)*4] = 0;
      } } }) });
  assert.equal(called, true); assert.deepEqual(output.blocks, [block]);
}));

test('shared bubble and typography segmentation model/composite inventories match reference', () => {
  const layout = { version: 1, origin: 'manual', direction: 'horizontal', confidence: 1, insetRatio: 0,
    regions: [{ spans: [{ blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 }] }] };
  const input = { ...page, blocks: page.blocks.map(b => ({ ...b, bubbleLayout: layout, renderBbox: { x: 50, y: 50, w: 900, h: 900 } })) };
  const logits = new Float32Array(8*8).fill(-10);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) logits[y*8+x] = 10;
  const segmentation = { imageWidth: 200, imageHeight: 160, detections: [{ label: 'text', labelId: 1, score: .99, box: [10, 10, 185, 150], mask: { logits, width: 8, height: 8 } }] };
  const result = differentialPage(input, Buffer.alloc(200*160*4, 255), { bubbleLayoutConstraintBlockIds: ['a', 'b'], sharedInpaintGroupIdsByBlock: { a: ['shared-1'], b: ['shared-1'] }, typographySegmentation: segmentation });
  assert.ok(result.crops > 0); assert.equal(result.usesTypographySegmentation, true);
});
