import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, utimes, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModelIdentity } from '../tools/flux-model-identity.mjs';
import { preflightFlux, discoverCudaDriver, fluxLaunchEnv } from '../dist/adapters/flux.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
test('identity receipts bind exact name/size/path/mtime/SHA; preflight refuses changes and preserves receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rover-flux-identity-'));
  try {
    for (const dir of ['runtime/flux', 'test-data', 'engine/bin', 'engine/lib']) await mkdir(join(root, dir), { recursive: true });
    const runnerPath = join(root, 'engine/bin/mgt-flux-klein'), bytes = Buffer.from('#!/bin/sh\nexit 0\n');
    await writeFile(runnerPath, bytes); await chmod(runnerPath, 0o755);
    const nvccHostCompiler = { provider: 'conda-forge', version: '14.3.0', packages: [{ file: 'fixture.conda', sha256: digest('gcc') }] };
    const lock = 'fixture-lock', archives = [{ component: 'fixture', version: '1', sha256: digest('archive') }];
    await mkdir(join(root, 'runtime/flux/mgt-flux-klein-runner'));
    await writeFile(join(root, 'runtime/flux/mgt-flux-klein-runner/Cargo.lock'), lock);
    await writeFile(join(root, 'runtime/flux/pins.json'), JSON.stringify({ nvccHostCompiler, openssl: { version: '3.5.5' }, runnerSource: 'fixture-source', rust: { toolchain: '1.99.0' }, archives }));
    await writeFile(join(root, 'engine/binary-identity.json'), JSON.stringify({ nvccHostCompiler: { ...nvccHostCompiler, scope: 'nvcc host compiler only', gccVersion: 'gcc 14.3.0', gxxVersion: 'g++ 14.3.0' }, cargoTargetDir: join(root, 'target-gcc14'), binary: runnerPath, bytes: bytes.length, sha256: digest(bytes), computeCap: '120', cudaVersion: '12.9',
      openssl: { version: '3.5.5' }, runnerSource: 'fixture-source', cargoLockSha256: digest(lock), cudaArchives: archives, libraryDir: join(root, 'engine/lib'), toolchain: { rustc: 'rustc 1.99.0 (fixture)' } }));
    const cudaLibraryDir = join(root, 'engine/lib');
    for (const name of ['libcudart.so.12', 'libcublas.so.12', 'libcublasLt.so.12', 'libcurand.so.10']) await writeFile(join(cudaLibraryDir, name), 'fixture');
    const modelPath = join(root, 'fixture.gguf'), vaePath = join(root, 'fixture.safetensors');
    await writeFile(modelPath, 'model'); await writeFile(vaePath, 'vae');
    await writeFile(join(root, 'runtime/flux/model-pins.json'), JSON.stringify([{ file: 'fixture.gguf', bytes: 5, sha256: digest('model') }, { file: 'fixture.safetensors', bytes: 3, sha256: digest('vae') }]));
    const modelIdentityPath = join(root, 'test-data/receipt.json');
    const receipts = await createModelIdentity(modelPath, vaePath, modelIdentityPath, root);
    assert.equal(receipts.length, 2); assert.equal(typeof receipts[0].mtimeNs, 'string');
    // A real ELF shared library exercises dlopen without a GPU or system writes.
    await copyFile('/lib/x86_64-linux-gnu/libc.so.6', join(cudaLibraryDir, 'libcuda.so'));
    const config = { runnerPath, cudaLibraryDir, cudaDriverLibraryDir: cudaLibraryDir, modelPath, vaePath, modelIdentityPath };
    assert.equal((await preflightFlux(config, root)).binary, runnerPath);
    const binaryIdentityPath = join(root, 'engine/binary-identity.json');
    const binaryIdentity = await readFile(binaryIdentityPath, 'utf8');
    for (const field of ['provider', 'version', 'packages', 'scope', 'gccVersion', 'gxxVersion']) {
      const wrongHost = JSON.parse(binaryIdentity);
      wrongHost.nvccHostCompiler[field] = 'tampered';
      await writeFile(binaryIdentityPath, JSON.stringify(wrongHost));
      await assert.rejects(preflightFlux(config, root), /build provenance mismatch/);
    }
    const wrongTarget = JSON.parse(binaryIdentity);
    wrongTarget.cargoTargetDir = join(root, 'target');
    await writeFile(binaryIdentityPath, JSON.stringify(wrongTarget));
    await assert.rejects(preflightFlux(config, root), /build provenance mismatch/);
    const wrongOpenSSL = JSON.parse(binaryIdentity);
    wrongOpenSSL.openssl.version = '3.5.4';
    await writeFile(binaryIdentityPath, JSON.stringify(wrongOpenSSL));
    await assert.rejects(preflightFlux(config, root), /build provenance mismatch/);
    await writeFile(binaryIdentityPath, binaryIdentity);
    const receiptBytes = await readFile(modelIdentityPath);
    await assert.rejects(createModelIdentity(modelPath, vaePath, modelIdentityPath, root), /EEXIST/);
    await assert.rejects(createModelIdentity(modelPath, vaePath, join(root, 'tracked.json'), root), /Git-ignored/);
    await utimes(modelPath, new Date(0), new Date(0));
    await assert.rejects(preflightFlux(config, root), /identity changed/);
    await writeFile(modelPath, 'alter');
    await assert.rejects(createModelIdentity(modelPath, vaePath, join(root, 'test-data/wrong.json'), root), /SHA-256/);
    assert.deepEqual(await readFile(modelIdentityPath), receiptBytes);
    await writeFile(runnerPath, Buffer.from('changed'));
    await assert.rejects(preflightFlux(config, root), /runner identity mismatch/);
  } finally { await rm(root, { recursive: true }); }
});

test('driver discovery tries cache directories, requires unversioned loadable library, honors override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rover-driver-'));
  try {
    const missing = join(root, 'missing'), good = join(root, 'good');
    await mkdir(missing); await mkdir(good);
    await writeFile(join(missing, 'libcuda.so.1'), 'versioned only');
    await copyFile('/lib/x86_64-linux-gnu/libc.so.6', join(good, 'libcuda.so'));
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execute = promisify(execFile);
    const run = (command, args, options) => command === 'ldconfig'
      ? Promise.resolve({ stdout: `libcuda.so.1 (libc6,x86-64) => ${missing}/libcuda.so.1\nlibcuda.so.1 (libc6,x86-64) => ${good}/libcuda.so.1\n` })
      : execute(command, args, options);
    assert.equal(await discoverCudaDriver({ cudaLibraryDir: root }, { run }), good);
    assert.equal(await discoverCudaDriver({ cudaLibraryDir: root, cudaDriverLibraryDir: good }), good);
    await assert.rejects(discoverCudaDriver({ cudaLibraryDir: root, cudaDriverLibraryDir: missing }), /loadable unversioned/);
    await writeFile(join(missing, 'libcuda.so'), 'invalid ELF');
    await assert.rejects(discoverCudaDriver({ cudaLibraryDir: root, cudaDriverLibraryDir: missing }), /loadable unversioned/);
    await assert.rejects(discoverCudaDriver({ cudaLibraryDir: root }, { run: async () => ({ stdout: '' }) }), /driver not found/);
    await assert.rejects(discoverCudaDriver({ cudaDriverLibraryDir: 'relative' }), /absolute path/);
    assert.deepEqual(fluxLaunchEnv({ libraryDir: '/pinned', driverLibraryDir: good }, { LD_LIBRARY_PATH: '/inherited', RUST_LOG: 'off' }), {
      LD_LIBRARY_PATH: `/pinned:${good}:/inherited`, RUST_LOG: 'warn,koharu_runtime=info,koharu_ml=info',
    });
  } finally { await rm(root, { recursive: true }); }
});
