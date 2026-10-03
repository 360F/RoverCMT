// Linux Flux.2 Klein runner adapter (M1 Step 6).
// Reference: fd461737 src/main/inpainting.ts (createFluxInpaintingEngine, cuda-native
// launch arguments), fluxAssets/workerLaunch.ts and fluxAssets/constants.ts.
// Linux difference: the Windows runner preloads CUDA DLLs via --cuda-runtime-dir;
// on Linux the runner's dynamic loader resolves the pinned CUDA 12.9 / cuDNN 9.21
// libraries through LD_LIBRARY_PATH, so that argument is not passed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import { createFluxEngine } from '../typography/ported/main/inpainting/fluxEngine.mjs';
import { FLUX_INPAINT_MASK_PADDING_PX } from '../typography/ported/main/inpainting/fluxEngineConstants.mjs';

const REQUIRED_LIBRARIES = ['libcudart.so.12', 'libcublas.so.12', 'libcublasLt.so.12', 'libcurand.so.10'];

const execute = promisify(execFile);

export function fluxLaunchEnv(prepared, inherited = process.env) {
  return { LD_LIBRARY_PATH: [prepared.libraryDir, prepared.driverLibraryDir, inherited.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    RUST_LOG: 'warn,koharu_runtime=info,koharu_ml=info' };
}

// Probe with the same Linux loader environment as the runner, without GPU inference.
// Python is already required by the repository runtime recipes.
export async function discoverCudaDriver(config, { run = execute } = {}) {
  let directories;
  if (config.cudaDriverLibraryDir) {
    if (!isAbsolute(config.cudaDriverLibraryDir)) throw new Error('inpainting.cudaDriverLibraryDir must be an absolute path');
    directories = [config.cudaDriverLibraryDir];
  } else {
    let stdout;
    try { ({ stdout } = await run('ldconfig', ['-p'], { encoding: 'utf8', timeout: 10000 })); }
    catch (error) { throw new Error('Flux NVIDIA driver discovery failed; configure absolute inpainting.cudaDriverLibraryDir', { cause: error }); }
    directories = [...new Set([...stdout.matchAll(/^\s*libcuda\.so\.1\s+\([^\n]*\)\s+=>\s+(\/[^\n]+)$/gm)].map(m => dirname(m[1].trim())))];
  }
  for (const driverLibraryDir of directories) {
    try {
      await access(join(driverLibraryDir, 'libcuda.so'), constants.R_OK);
      await run('python3', ['-c', 'import ctypes, os; ctypes.CDLL(os.path.join(os.environ["ROVER_CUDA_DRIVER_DIR"], "libcuda.so")); ctypes.CDLL("libcuda.so")'], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, ...fluxLaunchEnv({ libraryDir: config.cudaLibraryDir, driverLibraryDir }), ROVER_CUDA_DRIVER_DIR: driverLibraryDir },
      });
      return driverLibraryDir;
    } catch (error) {
      if (config.cudaDriverLibraryDir) throw new Error(`Flux NVIDIA driver directory must contain loadable unversioned libcuda.so: ${driverLibraryDir}`, { cause: error });
    }
  }
  throw new Error('Flux NVIDIA driver not found: require a directory containing loadable unversioned libcuda.so; configure absolute inpainting.cudaDriverLibraryDir (no system symlinks are created)');
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Arguments exactly as createFluxInpaintingEngine appends them for cuda-native,
// minus the Windows-only --cuda-runtime-dir.
export function fluxLaunchArgs(config) {
  return ['--transformer-path', config.modelPath, '--vae-path', config.vaePath,
    '--steps', '4', '--strength', '1', '--mask-padding', String(FLUX_INPAINT_MASK_PADDING_PX)];
}

export async function preflightFlux(config, projectRoot) {
  const binary = resolve(config.runnerPath);
  await access(binary, constants.X_OK);
  const runtimeRoot = dirname(dirname(binary));
  const identity = JSON.parse(await readFile(join(runtimeRoot, 'binary-identity.json'), 'utf8'));
  const buildPins = JSON.parse(await readFile(join(projectRoot, 'runtime/flux/pins.json'), 'utf8'));
  const lockSha = await sha256(join(projectRoot, 'runtime/flux/mgt-flux-klein-runner/Cargo.lock'));
  const expectedArchives = buildPins.archives.map(({ component, version, sha256 }) => ({ component, version, sha256 }));
  const host = identity.nvccHostCompiler;
  if (host?.provider !== buildPins.nvccHostCompiler?.provider ||
    host?.version !== buildPins.nvccHostCompiler?.version ||
    JSON.stringify(host?.packages) !== JSON.stringify(buildPins.nvccHostCompiler?.packages) ||
    host?.scope !== 'nvcc host compiler only' ||
    !host?.gccVersion?.includes(buildPins.nvccHostCompiler.version) ||
    !host?.gxxVersion?.includes(buildPins.nvccHostCompiler.version) ||
    !identity.cargoTargetDir?.endsWith('/target-gcc14'))
    throw new Error(`Flux runner build provenance mismatch: ${binary}`);
  if (identity.runnerSource !== buildPins.runnerSource || identity.cargoLockSha256 !== lockSha ||
    JSON.stringify(identity.openssl) !== JSON.stringify(buildPins.openssl) ||
    JSON.stringify(identity.cudaArchives) !== JSON.stringify(expectedArchives) ||
    !identity.toolchain?.rustc?.startsWith(`rustc ${buildPins.rust.toolchain} `))
    throw new Error(`Flux runner build provenance mismatch: ${binary}`);
  const info = await stat(binary);
  if (resolve(identity.binary) !== binary || identity.computeCap !== '120' || identity.cudaVersion !== '12.9' ||
    info.size !== identity.bytes || await sha256(binary) !== identity.sha256)
    throw new Error(`Flux runner identity mismatch: ${binary}`);
  const libraryDir = resolve(config.cudaLibraryDir);
  if (resolve(identity.libraryDir ?? '') !== libraryDir) throw new Error('Flux CUDA library directory does not match build identity');
  for (const name of REQUIRED_LIBRARIES) await access(join(libraryDir, name), constants.R_OK);
  // A verified identity receipt binds path + size + mtime to the pinned SHA-256,
  // so the 2.6 GB model is not rehashed for every run (Step 4 precedent).
  const pins = JSON.parse(await readFile(join(projectRoot, 'runtime/flux/model-pins.json'), 'utf8'));
  const receipts = JSON.parse((await readFile(config.modelIdentityPath, 'utf8')).replace(/("mtimeNs"\s*:\s*)([0-9]+)/g, '$1"$2"'));
  if (!Array.isArray(receipts)) throw new Error('Flux model identity receipt must be an array');
  for (const [pin, path] of [[pins[0], config.modelPath], [pins[1], config.vaePath]]) {
    const file = await stat(path, { bigint: true });
    const receipt = receipts.find(r => r.path === path);
    if (!file.isFile() || basename(path) !== pin.file || file.size !== BigInt(pin.bytes) || receipt?.sha256 !== pin.sha256 ||
      receipt?.bytes !== pin.bytes || !/^\d+$/.test(String(receipt?.mtimeNs)) || BigInt(String(receipt?.mtimeNs)) !== file.mtimeNs)
      throw new Error(`Flux model identity changed; verify the pinned SHA-256 once and refresh the receipt: ${path}`);
  }
  const driverLibraryDir = await discoverCudaDriver(config);
  return { binary, libraryDir, driverLibraryDir, identity };
}

export function fluxEngine(config, prepared, runRootDir) {
  const launch = {
    backend: 'cuda-native', executable: prepared.binary, runtimePath: prepared.binary, label: 'Flux Klein CUDA',
    args: fluxLaunchArgs(config),
    env: fluxLaunchEnv(prepared),
  };
  return createFluxEngine({ launch, modelPath: config.modelPath, vaePath: config.vaePath, sm75Fp16Enabled: false, runRootDir });
}
