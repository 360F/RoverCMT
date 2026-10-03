// Claude-run only: real CUDA runner and full four-page CLI. No Docker operations.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { parseConfigToml } from '../dist/cli/config-file.js';
import { runCli } from '../dist/cli/app.js';
import { fluxLaunchArgs, fluxLaunchEnv, preflightFlux } from '../dist/adapters/flux.mjs';
import { FluxWorker } from '../dist/typography/ported/main/inpainting/fluxWorker.mjs';
import { buildPatternPageMask } from '../dist/typography/ported/main/inpainting/patternPageMask.mjs';
import { prepareFluxWindowCrops } from '../dist/typography/ported/main/inpainting/fluxCropTiling.mjs';
import { cropBitmapFromPage } from '../dist/typography/ported/main/inpainting/imageRaster.mjs';
import { resolveFluxCropPaths, writeFluxCropInputs } from '../dist/typography/ported/main/inpainting/fluxCropIO.mjs';
import { FLUX_INPAINT_CONTEXT_PX } from '../dist/typography/ported/main/inpainting/fluxEngineConstants.mjs';
import { nativeImage } from '../dist/adapters/native-image.mjs';

const [mode, configFile, destination, pageFile] = process.argv.slice(2);
if (!['runner', 'e2e'].includes(mode) || !configFile || !destination) throw new Error('Usage: node tools/erase-smoke.mjs runner|e2e <isolated.toml> <new-evidence-dir> [bound-page.json]');
const projectRoot = resolve('.'), evidence = resolve(destination); await mkdir(evidence);
const config = parseConfigToml(await readFile(configFile, 'utf8'), projectRoot);
assert.ok(config.inpainting, '[inpainting] required');
const lifecycle = join(evidence, 'lifecycle.jsonl'), llamaPids = new Set(), fluxPids = new Set(), stopped = new Set();
const exists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function gpuSnapshot() {
  const command = process.env.NVIDIA_SMI ?? '/usr/lib/wsl/lib/nvidia-smi';
  try { return { ok: true, text: execFileSync(command, ['--query-compute-apps=pid,process_name,used_gpu_memory', '--format=csv,noheader'], { encoding: 'utf8', timeout: 10000 }),
    devices: execFileSync(command, ['--query-gpu=index,memory.used,memory.free', '--format=csv,noheader'], { encoding: 'utf8', timeout: 10000 }) }; }
  catch (error) { return { ok: false, error: String(error) }; }
}
function record(type, fields = {}) {
  appendFileSync(lifecycle, JSON.stringify({ time: new Date().toISOString(), monotonicNs: String(process.hrtime.bigint()), type, ...fields }) + '\n');
}
let handoffError, gpuPathError;
const gpuSignals = new Set(), modelLoads = [], crops = [];
let currentFluxPid;
function observe(type, fields) {
  // Omit token streams; log lifecycle plus GPU state at actual start/stop events.
  if (['llama-stdout', 'llama-stderr'].includes(type)) return;
  record(type, fields);
  if (fields.message === 'Flux runtime stderr') {
    const line = fields.detail.line;
    if (/falling back to CPU/i.test(line)) gpuPathError = new Error(`CPU fallback: ${line}`);
    if (/NVIDIA driver reports CUDA .* support/.test(line)) gpuSignals.add(currentFluxPid);
    const load = line.match(/model loaded in ([0-9.]+)(ms|s|µs|ns)/);
    if (load) {
      const elapsedMs = Number(load[1]) * ({ ms: 1, s: 1000, 'µs': 0.001, ns: 0.000001 }[load[2]]);
      modelLoads.push({ pid: currentFluxPid, elapsedMs }); record('model-load-timing', modelLoads.at(-1));
    }
  }
  if (fields.message === 'Flux inpaint crop completed') {
    if (!gpuSignals.has(currentFluxPid)) gpuPathError = new Error('crop needs positive koharu CUDA driver signal');
    if (!Number.isFinite(fields.detail.elapsedMs)) gpuPathError = new Error('crop elapsedMs required');
    crops.push({ pid: currentFluxPid, ...fields.detail });
  }
  if (type === 'flux-disposed') record('flux-processes-after-dispose', { alivePids: [...fluxPids].filter(exists) });
  if (type === 'llama-start') llamaPids.add(fields.pid);
  if (type === 'llama-stopped') { stopped.add(fields.pid); record('gpu-after-llama-stop', { pid: fields.pid, gpu: gpuSnapshot(), pidAlive: exists(fields.pid) }); }
  if (fields.message === 'Flux worker process starting') {
    const pid = fields.detail.pid; currentFluxPid = pid; fluxPids.add(pid);
    const alive = [...llamaPids].filter(exists), missingStops = [...llamaPids].filter(p => !stopped.has(p));
    record('gpu-at-flux-start', { pid, aliveLlamaPids: alive, missingStops, gpu: gpuSnapshot() });
    if (alive.length || missingStops.length) handoffError = new Error('llama-server still alive or stop receipt missing before Flux start');
  }
}
record('gpu-before', { gpu: gpuSnapshot() });
if (mode === 'runner') {
  if (!pageFile) throw new Error('runner mode needs a bound page JSON (source paths read-only)');
  const prepared = await preflightFlux(config.inpainting, projectRoot);
  const stored = JSON.parse(await readFile(pageFile, 'utf8'));
  const page = { ...stored, imagePath: /^[a-z]:/i.test(stored.imagePath) ? `/mnt/${stored.imagePath[0].toLowerCase()}${stored.imagePath.slice(2).replace(/\\+/g, '/')}` : stored.imagePath };
  const image = await nativeImage.createFromPath(page.imagePath); assert.equal(image.isEmpty(), false);
  const { width, height } = image.getSize(), bitmap = image.toBitmap();
  const mask = buildPatternPageMask({ page, bitmap, width, height, mode: 'flux-region', collectSourceGlyphEvidence: false,
    bubbleLayoutConstraintBlockIds: page.blocks.filter(b => b.bubbleLayout).map(b => b.id) });
  const crop = mask.inpaintWindows.flatMap(window => prepareFluxWindowCrops({ width, height, window, mask: mask.pageMask, featherPx: 8, contextPx: FLUX_INPAINT_CONTEXT_PX, maskPaddingPx: 16, maxPixels: 1048576, tileLargeCrops: false }))[0];
  assert.ok(crop, 'bound page must have a usable mask crop');
  const paths = resolveFluxCropPaths(evidence, 0, 0);
  await writeFluxCropInputs(paths, crop, cropBitmapFromPage(bitmap, width, crop.paddedBounds));
  const diagnostics = { info(message, detail) { observe('inpainting-info', { message, detail }); }, warn(message, detail) { observe('inpainting-warn', { message, detail }); } };
  const launch = { backend: 'cuda-native', executable: prepared.binary, runtimePath: prepared.binary, label: 'Flux CUDA smoke', args: fluxLaunchArgs(config.inpainting),
    env: fluxLaunchEnv(prepared) };
  const worker = new FluxWorker(launch, { diagnostics });
  const request = { input: paths.inputPath, mask: paths.maskPath, output: paths.outputPath, steps: 4, strength: 1, maxPixels: 1048576, maskPadding: 0 };
  record('runner-request', { request, processSize: crop.processSize, paddedBounds: crop.paddedBounds });
  try {
    await worker.inpaint(request);
    const output = PNG.sync.read(await readFile(paths.outputPath));
    assert.equal(output.width, crop.processSize.width); assert.equal(output.height, crop.processSize.height);
    assert.equal(output.data.length, output.width * output.height * 4);
    record('crop-decoded', { width: output.width, height: output.height, png: paths.outputPath });
  } finally {
    await worker.dispose();
    record('flux-worker-exit', { pid: worker.client.child.pid, code: worker.client.child.exitCode, signal: worker.client.child.signalCode });
  }
  assert.equal(worker.client.child.exitCode, 0, 'clean runner shutdown must exit 0');
  assert.ok([...fluxPids].every(p => !exists(p)), 'runner clean shutdown');
  // Successful preflight, deliberately invalid input: real runner error response
  // or startup failure must still clean up its own process.
  const failing = new FluxWorker(launch, { diagnostics, requestTimeoutMs: 120000 });
  try { await assert.rejects(failing.inpaint({ ...request, input: join(evidence, 'absent.png') })); }
  finally {
    await failing.dispose();
    record('failed-flux-worker-exit', { pid: failing.client.child.pid, code: failing.client.child.exitCode, signal: failing.client.child.signalCode });
  }
  assert.ok([...fluxPids].every(p => !exists(p)), 'failed runner cleaned');
} else {
  assert.ok(config.translation); assert.equal(config.ocr?.device, 'gpu'); assert.ok(config.models?.koharu);
  assert.deepEqual(config.stages, ['detect', 'ocr', 'translate', 'typography', 'erase', 'layout']);
  // Refuse an existing output; materialization may not overwrite earlier evidence.
  await assert.rejects(access(config.output));
  const code = await runCli({ argv: [], projectRoot, cwd: projectRoot, configPath: resolve(configFile), isTTY: false,
    write: text => process.stdout.write(text), onRuntimeEvent: observe });
  assert.equal(code, 0); if (handoffError) throw handoffError;
  assert.ok(llamaPids.size > 0); assert.ok(fluxPids.size > 0);
  assert.ok([...llamaPids, ...fluxPids].every(p => !exists(p)), 'all owned inference processes exited');
  const index = JSON.parse(await readFile(join(config.output, 'index.json'), 'utf8'));
  const workDir = join(config.output, 'works', index.workOrder[0]);
  const work = JSON.parse(await readFile(join(workDir, 'work.json'), 'utf8'));
  const chapter = JSON.parse(await readFile(join(workDir, 'chapters', work.chapterOrder[0], 'chapter.json'), 'utf8'));
  assert.equal(chapter.pages.length, 4);
  assert.ok(chapter.pages.some(p => p.blocks.some(b => b.translatedText.trim())));
  for (const page of chapter.pages.filter(p => p.blocks.length)) {
    assert.ok(page.inpaintedImagePath); assert.ok(page.inpaintMaskPath); assert.ok(Object.keys(page.erasedWorkflowRegions).length);
    const png = PNG.sync.read(await readFile(page.inpaintedImagePath)); assert.equal(png.width, page.width); assert.equal(png.height, page.height);
  }
  await writeFile(join(evidence, 'chapter-summary.json'), JSON.stringify(chapter.pages.map(p => ({ id: p.id, blocks: p.blocks.length, erased: Object.keys(p.erasedWorkflowRegions ?? {}).length, layouts: p.blocks.filter(b => b.bubbleLayout).length })), null, 2), { flag: 'wx' });
}
if (gpuPathError) throw gpuPathError;
assert.ok(crops.length > 0, 'GPU crop completion required');
assert.ok(modelLoads.length > 0, 'model load timing required');
for (const { pid } of crops) assert.ok(modelLoads.some(load => load.pid === pid), 'model load timing for each successful GPU worker required');
record('gpu-after', { gpu: gpuSnapshot() });
await writeFile(join(evidence, 'summary.json'), JSON.stringify({ status: 'PASS', mode, gpuSignalPids: [...gpuSignals], modelLoads, crops, llamaPids: [...llamaPids], fluxPids: [...fluxPids], limitation: 'GPU samples are evidence for Claude to inspect; WSL may omit per-process VRAM. No automatic VRAM release claim.' }, null, 2), { flag: 'wx' });
