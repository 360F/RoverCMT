import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FluxWorker } from '../dist/typography/ported/main/inpainting/fluxWorker.mjs';
import { createFluxEngine } from '../dist/typography/ported/main/inpainting/fluxEngine.mjs';
import { fluxLaunchArgs } from '../dist/adapters/flux.mjs';
import { buildFluxWorkerEnv } from '../dist/typography/ported/main/inpainting/fluxWorkerEnv.mjs';
import { eraseReference } from './erase-reference.mjs';
const fixture = resolve('tests/fixtures/flux/runner.mjs');
const launch = (mode, log) => ({ backend: 'cuda-native', executable: process.execPath, runtimePath: process.execPath, args: [fixture, mode], env: { REQUEST_LOG: log, LD_LIBRARY_PATH: '/fixture/lib' }, label: 'fixture' });
const silent = { info() {}, warn() {} };
const request = { input: '', mask: '', output: '', steps: 4, strength: 1, maxPixels: 1048576, maskPadding: 0 };
const rows = async file => (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('launch arguments and POSIX environment match reference contract', () => {
  assert.deepEqual(fluxLaunchArgs({ modelPath: 'model', vaePath: 'vae' }), ['--transformer-path', 'model', '--vae-path', 'vae', '--steps', '4', '--strength', '1', '--mask-padding', '16']);
  const spec = launch('normal', '/tmp/unused');
  assert.deepEqual(buildFluxWorkerEnv(spec), eraseReference('src/main/inpainting/fluxWorkerEnv.ts').buildFluxWorkerEnv(spec));
  assert.equal(buildFluxWorkerEnv(spec).LD_LIBRARY_PATH, '/fixture/lib');
});
test('real JSON-lines worker starts in its own group, reuses across pages and shuts down', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rover-flux-')), log = join(dir, 'requests');
  const engine = createFluxEngine({ launch: launch('normal', log), diagnostics: silent, runRootDir: dir }, {
    async runInpaint({ getWorker }) { await getWorker().inpaint(request); },
  });
  try {
    await engine.inpaint(); await engine.inpaint();
    const history = await rows(log), pid = history[0].pid;
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    assert.equal(Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]), pid, 'owned POSIX group ID');
    assert.equal(history.filter(r => r.type === 'startup').length, 1);
    assert.deepEqual(history.filter(r => r.type === 'inpaint').map(r => r.id), ['1', '2']);
    await engine.dispose(); await engine.dispose();
    assert.equal(alive(pid), false);
    const final = await rows(log); assert.equal(final.at(-2).type, 'shutdown'); assert.equal(final.at(-1).type, 'exit');
    assert.deepEqual(final[1], { pid, type: 'inpaint', input: '', mask: '', output: '', steps: 4, strength: 1, max_pixels: 1048576, mask_padding: 0, id: '1' });
  } finally { await engine.dispose(); await rm(dir, { recursive: true }); }
});
for (const mode of ['cpu-fallback', 'startup-crash', 'crash', 'hang', 'error', 'ignore-shutdown']) test(`worker ${mode} cleanup leaves unrelated owned sentinel alive`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rover-flux-')), log = join(dir, 'requests');
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });
  const worker = new FluxWorker(launch(mode, log), { requestTimeoutMs: 150, diagnostics: silent });
  try {
    if (mode === 'ignore-shutdown') await worker.inpaint(request);
    else await assert.rejects(worker.inpaint(request), mode === 'cpu-fallback' ? /refused CPU fallback/ : undefined);
    const disposeStarted = Date.now();
    await worker.dispose();
    if (mode === 'ignore-shutdown') {
      assert.ok(Date.now() - disposeStarted >= 1450, 'reference shutdown grace is 1500 ms');
      assert.equal(worker.client.child.signalCode, 'SIGKILL');
    }
    if (mode === 'hang') assert.equal(worker.client.child.signalCode, 'SIGKILL');
    assert.equal(alive((await rows(log))[0].pid), false);
    assert.equal(alive(sentinel.pid), true);
  } finally {
    await worker.dispose(); const ended = once(sentinel, 'exit'); sentinel.kill('SIGTERM'); await ended;
    await rm(dir, { recursive: true });
  }
});

test('owned descendant inherits worker group and graceful shutdown removes both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rover-flux-tree-')), log = join(dir, 'requests');
  const worker = new FluxWorker(launch('tree', log), { diagnostics: silent });
  try {
    await worker.inpaint(request);
    const history = await rows(log), parent = history[0].pid, descendant = history.find(r => r.type === 'descendant').childPid;
    const state = await readFile(`/proc/${descendant}/stat`, 'utf8');
    assert.equal(Number(state.slice(state.lastIndexOf(')') + 2).split(' ')[2]), parent);
    await worker.dispose(); assert.equal(alive(parent), false); assert.equal(alive(descendant), false);
  } finally { await worker.dispose(); await rm(dir, { recursive: true }); }
});
test('abort cleans owned worker; unhealthy engine restarts on the following page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rover-flux-restart-')), log = join(dir, 'requests');
  const controller = new AbortController(), worker = new FluxWorker(launch('hang', log), { diagnostics: silent });
  try {
    const response = worker.inpaint(request, controller.signal); setTimeout(() => controller.abort(), 100);
    await assert.rejects(response, { name: 'AbortError' }); await worker.dispose();
    assert.equal(alive((await rows(log))[0].pid), false);
    const spec = launch('crash', log), engine = createFluxEngine({ launch: spec, diagnostics: silent, runRootDir: dir }, { async runInpaint({ getWorker }) { await getWorker().inpaint(request); } });
    try {
      await assert.rejects(engine.inpaint()); spec.args = [fixture, 'normal']; await engine.inpaint();
    } finally { await engine.dispose(); }
    const started = (await rows(log)).filter(r => r.type === 'startup'); assert.equal(started.length, 3);
    assert.ok(started.every(r => !alive(r.pid)));
  } finally { await worker.dispose(); await rm(dir, { recursive: true }); }
});
