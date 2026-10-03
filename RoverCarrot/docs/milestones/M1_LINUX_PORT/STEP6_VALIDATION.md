# Step 6 — Inpainting / Erase validation

Implementation continuation, 2026-10-03. Starting HEAD `fd7b6128`, handoff baseline
`45797b19`; the uncommitted Step 6 tree was supplied for recovery. Reference is
read-only fork `fd461737`. Steps 3–5 remain provisional baselines; fresh independent
review is DEFERRED. This document neither marks Step 6 DONE nor changes handoff.

## Requirements / observable contract

Authority: [Step 6](IMPLEMENTATION_PLAN.md#step-6--inpainting--erase),
[Reference-driven validation](IMPLEMENTATION_PLAN.md#reference-driven-validation),
[GPU operations](IMPLEMENTATION_PLAN.md#gpu-validation-운영-2026-10-03-사용자-결정),
[M1-INPAINT-001](CURRENT.md#m1-inpaint-001--flux-klein-candle-runner-linux-runtime),
[2026-10-03 baseline decision](CURRENT.md#m1-baseline-decision-2026-10-03), and
[INPAINTING analysis](../../analysis/INPAINTING_PIPELINE_MIGRATION_ANALYSIS.md).

Reference source areas: `pageWorkflow/pageWorkflowImages.ts:eraseWorkflowPage`,
`jobs/bubbleLayoutJob.ts:runBubbleLayoutMaskPrepass`, `inpainting/patternPage.ts`,
`patternPageMask.ts`, `maskGeometry.ts`, `patternFluxCompositePlan.ts`,
`koharuTypographyMask.ts`, `inpaintingWindowMask.ts`, `fluxWindowPreparation.ts`,
`fluxCropTiling.ts`, `fluxEngineRunner.ts`, `imageRaster.ts`, `fluxChangeStats.ts`,
`inpaintMaskArtifact.ts`, `fluxWorker.ts`, `fluxWorkerEnv.ts`, runtimeSupport
`jsonLinesWorkerClient.ts` / `processTreeTermination.ts`, engine construction in
`src/main/inpainting.ts`, Flux assets constants/workerLaunch, Rust runner and
`scripts/flux-klein-build-plan.cjs`.

Preserved behavior:

- Erase target selection ignores missing source/translated text, respects
  `inpaintExcluded`, and uses overwrite/current geometry-region bindings.
  Installed defaults: Flux Klein cuda-native, bubbleLayout=true, overwrite erase.
- Flux + selected layout + bubbleLayout triggers a separate best-effort Koharu
  prepass. Targets are explicit block IDs. Geometry is unpadded, segmentation and
  shared ownership metadata are forwarded, and transient layout is restored before
  committing. Manual usable geometry constrains masks. Sequential erase does not
  apply `sourceEraseScale` (that reference adaptation belongs to the parallel path).
- Model mask and composite mask remain distinct. Crop geometry, ownership,
  mask dilation, validation masks, tiling and reference feathering are preserved.
  Pixel-change accounting is the reference RGB delta rule (>=8), not a new quality
  gate. A block with at least one qualifying changed pixel is marked erased;
  unchanged blocks fail the page with any successful partial result retained.
- Output is full page PNG, union grayscale mask PNG, provenance and changed-block
  `erasedWorkflowRegions`. Mask construction returning zero eligible blocks is the
  reference silent completion path. No retry inside the same page and no CPU fallback.
- Runtime stage order stays detect → OCR → translate → typography → erase → layout.
  OCR completes/cleans before translation; managed translation closes page-scoped
  servers before erase. One lazily started Flux worker is reused across erase pages
  and disposed in CLI `finally`. Core/Pipeline depend only on Stage contracts.

D9: repository-local Rust/CUDA recipe + explicit external model paths, no system
installer/container backend. D19: prepass and sequential source-size behavior
preserved; weak pixel-change gate documented. D20: missing translation still
permits erase (existing user decision). D21: sequential handoff retained; actual
GPU ownership/VRAM observations are pending Claude execution.

## Recovery audit verdicts / mixed authorship

This is mixed implementation authorship, **not a fresh independent review**.
Previous Claude implementation and this Codex continuation share the same working
tree. Codex authored the tests/comparators below and audited predecessor code;
Claude first-pass verification and future fresh review must inspect those tools.

| Area / files supplied at recovery | Recovery verdict | Continuation action / final limitation |
|---|---|---|
| `runtime/flux/{mgt-flux-klein-runner,runner-runtime-policy}/` | Complete source copy | Byte comparisons of all 14 source files; Cargo.lock pin verified; unchanged |
| `runtime/flux/{pins.json,model-pins.json}` | Complete pins | Preserved; actual model/VAE receipt now produced |
| `runtime/flux/build.py`, Python recipe tests | Narrow provisioning fix already supplied | Separate preceding Codex narrow task fixed CUDA directory collision; this continuation neither ran nor edited the build recipe/runtime outputs. CUDA build is Claude-owned |
| 52 new mirror modules, plus imageIO/logger adapters | Complete algorithms, partial provenance | AST comparison found 47 exact mechanical modules and 7 documented adapted modules after mapping the 2 omitted adapter entries. Working algorithms unchanged |
| `ported/source-map.json` | Incorrect ordering; missing adapter entries | Existing Step 5 order/entries restored; new entries appended; adaptations in a separate compatible JSON file |
| `adapters/native-image.mjs` | Incorrect alpha semantics; partial shim validation | Fixed premultiplied BGRA/alpha preservation, PNG unpremultiplication, exact bitmap length/type errors and resize aspect/empty behavior; tests added. Electron resize/colour-profile equivalence is not claimed |
| `adapters/flux.mjs` + `.d.mts` | Complete launch; partial preflight validation | Added binding to runner source/Cargo.lock, CUDA archive identities, local Rust pin and library directory; malformed receipt refusal; fake preflight tests |
| `erase/{erase.mjs,erase.d.mts,stage.ts}` | Complete reference workflow adaptation | Kept implementation; added target/prepass/restore/partial failure tests |
| `[inpainting]` contracts/config and CLI composition | Partial validation and lifecycle observations | Typed every supplied field, refused partial path tables; blank generated template remains disabled. Added validation-only runtime observer and sink reset after dispose |
| `pngjs` 7.0.0 dependency/lock | Complete | Reference version retained |
| `tools/copy-ocr-assets.mjs` | Missing erase/adapter copies | Added erase mjs/declarations and Flux/native-image runtime copying; built CLI import resolution checked |
| Model identity receipt tool | Missing | `tools/flux-model-identity.mjs`; pin/name/size/hash/path/mtimeNs binding, wx output under ignored test-data |
| Tests, deterministic differential and GPU tools | Missing | New tools/tests below; GPU tools prepared only |
| README / this document | Missing | Usage, Linux differences, authorship and evidence added |

Previous Claude authored all runner copies/pins, new mirror `.mjs` modules,
Flux/native-image adapters, erase stage/workflow, pngjs dependency, and initial
CLI/config/contracts changes. Codex continuation changed native-image and Flux
adapter behavior as described, CLI observer/reset, config validation and template
comment placement, source-map/order, logger declaration for reset, boundaries,
copy tool and README. Codex authored every new Node test/helper/fixture and tool
listed below, `erase-adaptations.json`, and this document. The preceding narrow
recipe fix and `tests/python/test_flux_recipe.py` are a separate Codex task supplied
before this continuation, not new changes made here.

## Mechanical ports / documented adaptations

`src/typography/ported/source-map.json` remains a flat path-to-reference mapping.
Its Step 5 entries and order are unchanged. All Step 6 additions are appended;
`erase-adaptations.json` records precise notes and both source/port SHA-256 values.
`tools/audit-erase-ports.mjs` verifies every mechanical addition after TS type
removal and ESM import conversion; comment-only lint directives are ignored by the
AST printer. This provenance audit is not a substitute for differential execution.

Exact mechanical additions after F1 (46): `main/artifactCleanup`; inpainting
`bubbleLayoutConstraintMask`, `computeGpuEnv`, `fluxChangeStats`,
`fluxCompositeConstraint`, `fluxCropIO`, `fluxCropTiling`, `fluxEngine`,
`fluxEngineConstants`, `fluxEngineRunner`, `fluxInpaintSummary`, `fluxMaskContracts`,
`fluxWindowPreparation`, `fluxWorkerEnv`, `fluxWorkerErrors`,
`inpaintingWindowMask`, `koharuTypographyMask`, `maskGeometry`,
`patternBlockEligibility`, `patternEngineRunner`, `patternFluxCompositePlan`,
`patternMaskContext`, `patternMaskMorphology`, `patternPageMask`,
`patternPageSourceDiagnostics`, `patternSharedWindows`, `patternTextMask`,
`patternWindowPolicy`, `rasterMasks`, `sharedBubbleTextBridge`,
`sourceGlyphEvidenceReceipt`, `sourceGlyphResidual`; `main/jobs/bubbleLayoutJob`;
`main/runtimeSupport/{jsonLinesWorkerClient,observeProcessErrors,processTreeTermination}`;
`main/translationCompletionReferences`; shared `bboxTranslation`, `blockDisplayText`,
`blockTransformPresets`, `blockTransforms`, `curveTransformMath`,
`editableRenderGeometry`, `gpuSettings`, `perspectiveTransformMath`, `thinPlateSpline`.
All names correspond to `.mjs` files. Existing Step 5 modules are reused unchanged.

| Adapted mirror module | Exact adaptation |
|---|---|
| `main/inpainting/imageIO.mjs` | Electron import → native-image shim; await every path/buffer decode, including fallback/snapshot |
| `main/inpainting/imageRaster.mjs` | Electron import → shim; await both resize sites, both buffer/path decode sites and bitmap/mask PNG encoding; pure crop/mask/composite functions unchanged |
| `main/inpainting/patternPage.mjs` | Electron import → shim; await output PNG encoding; algorithm unchanged |
| `main/inpainting/inpaintingRuntimeLogger.mjs` | App logger → CLI sink; no-op when unbound |
| `main/safeCleanup.mjs` | Logger import → inpainting sink; cleanup/error behavior unchanged |
| `main/inpainting/inpaintMaskArtifact.mjs` | Removed unused catch binding only |
| `shared/warpTransformMath.mjs` | Removed unused catch binding only |

Two retained line-level lint exceptions in `sourceGlyphEvidenceReceipt` and
`jsonLinesWorkerClient` preserve bitmap-excluding destructuring and the reference ANSI-control
sequence regular expression. Unused file-level disables were removed by the predecessor;
no algorithm refactor was performed.

## Linux image and process differences

Flux launch arguments match cuda-native engine construction except the Windows
`--cuda-runtime-dir` preload argument. Linux loads pinned CUDA 12.9 libraries via
`LD_LIBRARY_PATH=<recipe lib64>:<host LD_LIBRARY_PATH>`. Reference environment
builder preserves that value. No model/backend/GPU optimization override is added.

Sharp 0.35.5 replaces synchronous Electron decode/encode/resize. The bitmap is
premultiplied BGRA, alpha retained; PNG/sharp raw inputs are straight RGBA. The shim implements
the erase path subset (1x images, quality best), not tray/icon/multiscale APIs;
it retains the local 120-million-pixel decode/bitmap safety limit. Decode
is sRGB with no EXIF auto-rotation. Unlike the predecessor's incorrect opaque black
flattening, alpha survives round trips. Color values at partial alpha still lose
premultiplication precision; tests use exact expected bytes, never tolerance.
Electron's [N32Premul implementation](https://github.com/electron/electron/blob/v43.3.0/shell/common/api/electron_api_native_image.cc)
and [nativeImage contract](https://www.electronjs.org/docs/latest/api/native-image)
provide platform context. Resize uses sharp lanczos3. It is a Linux adaptation,
**not verified byte-equivalent to Electron**. The default CUDA path downscales
large crops (>1 MiB budget) and upsizes generated crops, so this limit is material.
`tools/electron-erase-reference.mjs` gives Claude an exact fresh codec/resize check
against an existing reference Electron. No earlier Step 5 acceptance is reused to
accept Step 6 codec differences.

The reference POSIX client already spawns `detached:true`, owns a separate group,
sends JSON shutdown, ends stdin, waits **1500 ms**, then group SIGKILL if needed.
Permanent request failure/timeout/abort immediately terminates its owned tree;
force-exit verification deadline is **3000 ms**, poll interval **25 ms**. These
modules were mechanically preserved. Fake workers verify normal shutdown, reuse,
startup crash, request crash, timeout, abort, error response, ignored shutdown,
owned descendant group and restart, while an unrelated owned sentinel stays alive.
No non-owned process is signaled. The reference's bounded termination failure is
propagated; no broad PID scan/kill or system cleanup was added.

## Runtime, model and generation identities

Runner source: byte-identical `tools/mgt-flux-klein-runner` plus
`tools/runner-runtime-policy`. Cargo.lock SHA-256:
`79be450b73763f9219a0fd0dec4006135e5d0d1a361cd16e643f2279a974ed86`.
Runner Cargo.toml binds Koharu `0d640615d435a399bc195c892de8f5d17efb68f8`, Candle
`e7e71e18414db8de91113963beaabb6b4046a0a5`; Cargo.lock binds resolved dependencies.
Default feature is CUDA. Rust **1.99.0** is a local reproducible build-tool pin;
Carrot does **not** provide a Rust toolchain pin. rustup 1.29.1, CUDA **12.9**
(nvcc 12.9.41), cuDNN **9.21.0.82**, compute capability **120**; archive URLs,
byte sizes and hashes are in `runtime/flux/pins.json`.

Exact Claude command from RoverCarrot:

```bash
python3 runtime/flux/build.py --build --jobs 16
```

Recipe invokes `cargo build --release --locked -vv --manifest-path
runtime/flux/mgt-flux-klein-runner/Cargo.toml` with repo-local RUSTUP_HOME,
CARGO_HOME/CARGO_TARGET_DIR, CUDA_COMPUTE_CAP=120, CUDA_PATH/CUDA_ROOT/
CUDA_TOOLKIT_ROOT_DIR pointing to `test-data/runtime/flux-sm120/cuda-12.9`,
CUDACXX=the GCC14 attempt's nvcc audit launcher, LD_LIBRARY_PATH/LIBRARY_PATH=its `lib64`, and
CARGO_BUILD_JOBS=16. GCC14 binary output and sibling `binary-identity.json` now
live in the immutable UUID runtime directory described below. Runner build/binary results are pending
Claude; the narrow OpenSSL provisioning follow-up below does not invoke the runner build.

Linux-only build dependency fix (2026-10-03): attempt-3 failed in
`openssl-sys 0.9.116` because the host has OpenSSL 3.5.5 runtime libraries but
neither development headers nor pkg-config. The recipe now provisions upstream
OpenSSL **3.5.5** source (53,104,821 bytes, SHA-256
`b28c91532a8b65a1f983b4c28b7488174e4a01008e29ce8e69bd789f28bc2a89`)
from `https://github.com/openssl/openssl/releases/download/openssl-3.5.5/openssl-3.5.5.tar.gz`.
Perl/make/gcc build it with `linux-x86_64 no-shared no-tests --libdir=lib`,
`--prefix=<runtime>/openssl-3.5.5`, and `--openssldir=<prefix>/ssl`.
`make install_sw` installs only into that ignored repository-local prefix.
Default provisioning (without `--build`) completes this OpenSSL build; subsequent
runs verify the source pin, configure options and installed header/library hashes
before skipping compilation. Only the Cargo build environment receives
`OPENSSL_DIR`, `OPENSSL_STATIC=1`, `OPENSSL_LIB_DIR` and `OPENSSL_INCLUDE_DIR`.
Binary identity records the OpenSSL source/version/size/SHA/configure options and
preflight requires them to match the pin. This resolves a Linux build dependency;
erase runtime behavior and reference Rust sources/dependencies remain unchanged.
The runner build and GPU validation remain pending; this narrow task does not run
`--build`.

Narrow follow-up validation: `python3 runtime/flux/build.py` exit **0**, local
OpenSSL compilation/install completed; a second identical non-build invocation
exit **0** verified and reused it without compilation. Installed CLI reports
OpenSSL 3.5.5. `python3 -m unittest discover -s tests/python` in RoverCarrot:
**19 tests PASS**, exit **0**. `npm run check` in RoverCarrot: typecheck/lint/build
and **103 Node tests PASS**, exit **0**. Both copied Rust directories remain
byte-identical to the root reference. No runner/Cargo build was executed.
Logs: `/tmp/rover-flux-provision.log`, `/tmp/rover-flux-reuse.log`,
`/tmp/rover-python-tests.log`, `/tmp/rover-check.log`.
Accidental root-level Python/check invocations failed on missing reference-only
dependencies; the required RoverCarrot commands above passed.

Linux-only host tool follow-up (2026-10-03, narrow Codex implementation):
attempt-4 failed in `libz-sys 1.1.29` because `cmake` was absent. FLUX now
pins the same PyPI manylinux x86_64 wheels as Step 4: CMake **4.3.4**
(29,528,910 bytes, SHA-256
`61a34a746853b3740c6ad494e51faf4d457b9ef82099e19974148808c31cc2eb`)
and Ninja **1.13.2** (183,365 bytes, SHA-256
`65a24341b5ac09fcadcc37082660be40a94174e51a937fabf6e2cae26225fa2c`).
URLs/filenames are copied verbatim into `runtime/flux/pins.json` `buildTools`.
Verified wheels live in the existing FLUX `downloads/`; extraction lives in
`test-data/runtime/flux-sm120/build-tools/`. Reuse compares extracted files
byte-for-byte with the verified wheel. The recipe prepends the actual CMake
`cmake/data/bin` and Ninja wheel `.data/scripts` directories to Cargo's PATH.
No system package installation, CMAKE/CMAKE_GENERATOR override, crate feature
change or dependency update is needed. Successful full builds record these pins
in `binary-identity.json` and CMake/Ninja versions in `toolchain`.

Host audit used the locked, offline Cargo metadata graph filtered to
`x86_64-unknown-linux-gnu` and inspected its build scripts and native helpers.
Platform-specific Windows/macOS/Wasm branches are not host requirements.
The per-package versions, resolved features and build-script hashes are preserved
in `test-data/validation/m1-step6/build/native-build-audit.json`.

| Native path | Actual locked Linux requirements / disposition |
|---|---|
| `libz-sys 1.1.29` | Resolved `cmake,libc,zlib-ng`: builds bundled zlib-ng with CMake and GCC; bypasses stock-zlib/pkg-config probing. CMake default Makefiles work with existing make; no system zlib headers needed |
| `aws-lc-sys 0.41.0` | Resolved `prebuilt-nasm`, no bindgen/FIPS. Bundled C/assembly and pregenerated Rust bindings work with GCC/binutils; CMake fallback is available. Linux assembly uses GNU assembler; NASM is a Windows path. Go/Perl source regeneration is unnecessary with pregenerated sources; no clang/libclang or OpenSSL headers required |
| `onig_sys 69.9.3` | No `generate` feature or forced system-library override: bundled Oniguruma builds via cc/GCC with bundled/generated headers. Missing pkg-config is not fatal; no clang/libclang needed |
| `openssl-sys 0.9.116` | Existing verified local static OpenSSL 3.5.5 supplies headers/libraries through OPENSSL_DIR/LIB_DIR/INCLUDE_DIR/STATIC; GCC handles header preprocessing. No pkg-config or bindgen required |
| `ring 0.17.14` | Registry crate uses pregenerated assembly, GCC/binutils and bundled headers; no NASM/Perl regeneration needed on Linux. Existing release artifacts reused in this native check |
| `esaxx-rs 0.1.10`, `rav1e 0.8.1`, `av-scenechange 0.14.1` | Resolved features omit `cpp` / `asm` / `asm` respectively; C++/NASM build branches are inactive |
| `native-tls`, `openssl`, `aws-lc-rs`, `rustls` | Build scripts emit Rust configuration; native work is delegated to audited sys crates |
| `cudarc 0.17.8/0.19.7`, `candle-kernels`, `candle-flash-attn` | Use provisioned CUDA headers/libraries/nvcc. `bindgen_cuda 0.1.6` launches nvcc, not clang/libclang. CUDA compilation intentionally excluded from native check |
| Other locked Linux build scripts | Rust compiler/version/cfg probes, embedded data or Rust source generation; no additional host tool/header provisioning required |

Native validation from RoverCarrot (same shared build_environment as `--build`):

```bash
python3 runtime/flux/build.py --check-native --jobs 16
# Runs, with the recipe's absolute manifest path:
cargo build --release --locked --manifest-path runtime/flux/mgt-flux-klein-runner/Cargo.toml \
  -p libz-sys -p aws-lc-sys -p onig_sys -p openssl-sys -p ring
```

Final recipe/Cargo exit **0**; Cargo finished release in **3.25s** using the
existing target cache. Compilation fingerprints confirm zlib-ng, AWS-LC
prebuilt-nasm and onig/openssl without bindgen; no feature flags were added to
the Cargo command. No runner, candle CUDA kernels or flash-attn build ran.
Receipt: `test-data/runtime/flux-sm120/native-check-identity.json` (separate from
runner binary provenance). Evidence: `test-data/validation/m1-step6/build/`
`native-check.log`, `native-check.exit`, `native-unittest.log`,
`native-unittest.exit`, `native-build-audit.json`.
`python3 -m unittest discover -s tests/python`: **22 tests PASS**, exit **0**,
including offline wheel pin/extraction/reuse/tamper, PATH/env and package-selection
tests. Both copied Rust directories remain byte-identical to reference; existing
downloads/redist/OpenSSL and uncommitted Step 6 work are preserved. No Git mutation
or plan/handoff edit occurred. Runtime behavior is unchanged.

### GCC 14 nvcc host compiler follow-up (2026-10-03)

Attempt-5 failed in `candle-kernels`: CUDA 12.9 `host_config.h` rejects the
system GCC 15.2. The user authorized conda-forge GCC 14 **only as nvcc's host
compiler**. Source, lockfile, CUDA 12.9, cuDNN 9.21, compute cap 120 and model/VAE
are unchanged. System GCC/G++ 15.2 remain the general C/C++ compilers; CC/CXX
are neither set nor replaced by this recipe.

`pins.json.nvccHostCompiler` pins the following exact conda-forge packages.
Each URL is `https://conda.anaconda.org/conda-forge/<subdir>/<file>`; byte size,
name, version, build string, subdir, URL, SHA-256 and dependency metadata are
recorded in the pin. SHA-256 values were read from official `linux-64` / `noarch`
`repodata.json.bz2`, retained in `test-data/runtime/flux-sm120/gcc14-conda/`.
The downloaded packages passed those exact SHA-256 and byte-size checks.

| Exact package file | Subdir | Repodata SHA-256 |
|---|---|---|
| `gcc_impl_linux-64-14.3.0-h054831b_20.conda` | linux-64 | `09bb9b0d54b012c36a115e3ecebc80276df261555e847afbb3fbc7ab5566408c` |
| `gxx_impl_linux-64-14.3.0-h99ea42b_20.conda` | linux-64 | `8cd46d6f94a5a34181492549e1e56e5795337007289e6ca30d9ff1864f0e33c1` |
| `libgcc-devel_linux-64-14.3.0-hf649bbc_120.conda` | noarch | `9e2a3e7de26fc149707f9ff3988dc3e6a0b9534aea1bedcaa6ec9ba93dfdd013` |
| `libstdcxx-devel_linux-64-14.3.0-h9f08a49_120.conda` | noarch | `5b7fd889a648c71d71a7cdda09107c0f189aa306f77c33cd66678a56cb225e53` |
| `libgcc-14.3.0-he0feb66_20.conda` | linux-64 | `ee549953022da53692ae9a5da17a5d4a1829b9a173b68433e529279f0d2f9305` |
| `libstdcxx-14.3.0-h934c35e_20.conda` | linux-64 | `83447d514a21052674806585721fef05979dd6700ca199dbfdef713b6113cb2b` |
| `libgomp-14.3.0-he0feb66_20.conda` | linux-64 | `b182215de444505bf9d590d409cc685b2fc1510ea5e865ffb2e0c6d4619cd01c` |
| `libsanitizer-14.3.0-h91d2232_20.conda` | linux-64 | `4b685b1da0f85f4771e1b243e66cf2cf7b2e625caa440efc082d800a4e9b091e` |
| `binutils_impl_linux-64-2.46.1-bootstrap_h59bd682_2.conda` | linux-64 | `6c7022a754063af8d085a5e46bf34ba934bdc5de2817d77977c0f9862da8d66c` |
| `ld_impl_linux-64-2.46.1-bootstrap_ha15bf96_2.conda` | linux-64 | `87a2158a8f16f8082f8d57282ef8f7b56dee8647b95919948cf03df91574edeb` |
| `sysroot_linux-64-2.17-h0157908_18.conda` | noarch | `69ab5804bdd2e8e493d5709eebff382a72fab3e9af6adf93a237ccf8f7dbd624` |
| `kernel-headers_linux-64-3.10.0-he073ed8_18.conda` | noarch | `a922841ad80bd7b222502e65c07ecb67e4176c4fa5b03678a005f39fcc98be4b` |
| `tzdata-2026c-h151e31d_0.conda` | noarch | `b928c30ddcb0e3f544c6eade8352737e6e610e263276b90232db6a578ef899d8` |
| `_openmp_mutex-4.5-20_gnu.conda` | linux-64 | `1dd3fffd892081df9726d7eb7e0dea6198962ba775bd88842135a4ddb4deb3c9` |

Packages are extracted directly into `gcc14-conda/prefix/` without installing
conda/mamba, activation, prefix patching, or added compiler/sysroot symlinks.
Standard package-provided relative layout works with nvcc. Extraction uses the
existing system `libzstd.so.1` through Python ctypes (no additional package).
Reuse verifies all package archives and the complete extracted file/link/mode
inventory against `prefix-identity.json`; unverified partial prefixes are refused.
Existing downloads, redist, OpenSSL, toolchains and old `target/` are untouched.
This narrow recipe now requires the already-provisioned Step 6 CUDA, Rust,
OpenSSL and CMake/Ninja dependencies for a full build; provisioning alone only
adds GCC 14 and its probe evidence.

CUDA compiler source audit (locked Cargo graph):

- `candle-kernels` at candle `e7e71e1` calls bindgen_cuda 0.1.6 `build_ptx`.
  Its PTX and object compilation branches append `-allow-unsupported-compiler`
  whenever `NVCC_CCBIN` is present, including an empty value. Do **not** use it.
- `candle-flash-attn` at the same revision directly invokes `Command::new("nvcc")`
  for PTX, with no `-ccbin` of its own. Its source-defined architecture remains
  unchanged. No source patch or feature change is made.
- Both locked cudarc versions (0.17.8 / 0.19.7) invoke nvcc only for
  `--version` detection, never host compilation; the launcher records these too.
- Locked `ug-cuda 0.5.0` at `bce254b` has no build.rs/nvcc compilation. It uses
  cudarc NVRTC at runtime. candle-flash-attn-v3 is not in this lockfile.

Use [nvcc's documented NVCC_PREPEND_FLAGS](https://docs.nvidia.com/cuda/archive/12.9.0/cuda-compiler-driver-nvcc/index.html#nvcc-environment-variables)
with `-ccbin <absolute-prefix>/bin/x86_64-conda-linux-gnu-g++`.
It reaches both direct nvcc and bindgen_cuda without activating that crate's
bypass branch. The recipe rejects inherited CUDA compiler overrides. A dedicated
PATH directory contains **only nvcc**, whose launcher records every argv and
host-compiler selection, rejects bypass flags / duplicate `-ccbin`, and execs
the unchanged CUDA 12.9 nvcc. General C/C++ compiler lookup stays unchanged.
The launcher journal is printed after Cargo exits, including on failure, since
bindgen_cuda discards captured successful nvcc output. Claude must preserve the
whole verbose log and journal; no `-allow-unsupported-compiler` may appear.

Provisioning/default command (executed in the implementation sandbox):

```bash
python3 runtime/flux/build.py
# Explicit equivalent:
python3 runtime/flux/build.py --provision
```

Exit **0**. Printed versions:

```text
x86_64-conda-linux-gnu-gcc (conda-forge gcc 14.3.0-20) 14.3.0
x86_64-conda-linux-gnu-g++ (conda-forge gcc 14.3.0-20) 14.3.0
Cuda compilation tools, release 12.9, V12.9.41
Build cuda_12.9.r12.9/compiler.35813241_0
```

Probe compiles a `.cu` containing `cuda_runtime.h`, a device kernel, a host
`std::vector`, and a compile-time `__GNUC__ == 14` assertion to an object with
`-arch=sm_120 -std=c++17 -c`. **PASS**; no unsupported-compiler bypass. Verbose
nvcc output names the repo-local G++ in preprocessing and host compilation and
reports `--gnu_version=140300`. Evidence: `gcc14-conda/provision.log`, `gcc14-conda/provision-final.log`, `gcc14-conda/provision-verified.log`, UUID probe
subdirectories containing `probe.log`, `sm120.cu`, `sm120.o`, invocation journal
and identity. Provisioning does not run Cargo or create/consume a target cache.

Full build is **Claude-only and unrun here**:

```bash
python3 runtime/flux/build.py --build --jobs 16
# Only to resume the exact recorded failed/interrupted GCC14 attempt:
python3 runtime/flux/build.py --build --jobs 16 --resume-gcc14
```

Cargo command includes `build --release --locked -vv`. CARGO_TARGET_DIR is the
new `test-data/runtime/flux-sm120/target-gcc14`; any non-empty fresh target is
refused. `--resume-gcc14` requires the existing `.gcc14-attempt.json` to match
recipe SHA-256 (with the narrowly pinned exception below), Cargo.lock SHA-256
and all pinned inputs, and records resume in
an immutable UUID build-run directory. Neither mode touches old `target/`.
Successful output lives in `gcc14-conda/build-runs/<uuid>/runtime/bin/` with
sibling `runtime/binary-identity.json`, preserving previous runtime artifacts.
Use the emitted binary path as runnerPath; CUDA libraryDir remains the original
CUDA 12.9 lib64. Identity retains all existing fields and adds exact GCC provider,
versions, package identities/SHA-256, probe identity, target, attempt and nvcc
journal path. Adapter preflight now requires matching GCC package provenance,
nvcc-only scope, version strings and the new target directory.

#### Reference cargo environment completion (2026-10-03)

Attempt 6 (`test-data/validation/m1-step6/build/attempt-6-gcc14/build.log`,
line ~21887) failed at `koharu-runtime/src/llama.rs` because compile-time
`LLAMA_CPP_TAG` was absent; nvcc used GCC 14 correctly. The recipe now follows
root read-only reference `scripts/flux-klein-build-plan.cjs:110–142` (CUDA env
122–128; tag/flags 134–139) and
`scripts/prepare-flux-klein-runner.cjs:466–482` for these platform-neutral values:

- `LLAMA_CPP_TAG=b-mgt-unused`, `CUDA_HOME=<cuda-root>` (same as CUDA_PATH/ROOT).
- `CARGO_HOME=<cargo-home>` is the existing repo-local cargo directory.
- `RUSTFLAGS=<inherited RUSTFLAGS>` followed, in reference order, by
  `--remap-path-prefix=<mgt-source>=<mgt-source>` for the Rover runner source root,
  `--remap-path-prefix=<build-home>=<build-home>` for HOME,
  `--remap-path-prefix=<cargo-home>=<cargo-home>` for repo-local CARGO_HOME,
  and the same cargo placeholder for HOME/.cargo. Each remap is appended only
  if its source path exists; inherited flags are preserved. Left-hand paths
  here and in identity metadata are placeholders, not literal build arguments.

The new `referenceBuildEnvironment` field in successful `binary-identity.json`
and each UUID run's `attempt.json` records these values without personal paths;
inherited flags are represented by their placeholder. Existing identity fields,
`--locked`, default CUDA features and GCC14 nvcc selection are retained.
Changing RUSTFLAGS invalidates cargo cache, so Claude's next
`--build --resume-gcc14` may recompile in the same GCC14-only `target-gcc14`.
Resume accepts only the exact previous recipe SHA-256
`5233d3e28b2b8fd94aa9db6ce1e8027823073050a96ba015ebf9a6004ebef8cc`
as a recipe-only exception, still requiring every other attempt field to match.
It preserves the original target marker and all existing artifacts, recording
`resume=true`, previous recipe hash and `referenceEnvironmentCompleted=true`
in the new run receipt and successful binary identity. Unknown recipe changes
or changed pins/lockfile remain rejected. This continuation runs no full build. Offline validation after completion:
`python3 -m unittest discover -s RoverCarrot/tests/python -v`: **29/29 PASS**
(including **15/15** Flux recipe tests); `npm run lint` in RoverCarrot: **PASS**.
Runner source directory comparison against root reference: byte-identical.

Offline validation: focused recipe unittest **13/13 PASS**; complete Python
unittest discovery **27/27 PASS**; focused production-source preflight test
**1/1 PASS** (temporary /tmp test copy changes only its imports to source, so no
build/dist writes); ESLint for the changed adapter/test **PASS**. This covers
archive integrity, extracted-prefix reuse/tamper, inherited overrides, nvcc
launcher logging/bypass/conflict rejection, fresh target refusal/exact resume,
and preflight rejection of changed GCC provenance. Rust source trees remain
byte-identical to root reference. No Git mutation or plan/handoff edit occurred.
CUDA compilation of the full locked runner, linking and GPU execution still
require Claude's outside-sandbox validation.

| Asset | Bytes | SHA-256 | Pin |
|---|---:|---|---|
| `flux-2-klein-4b-Q4_K_M.gguf` | 2604311104 | `0b25d143c8469b342bc5af3bce92b783bf6b0636d285f7b2f75e38af63af9a15` | unsloth/FLUX.2-klein-4B-GGUF, `8342a6a97b2d18acae5d62124735c39ba23060e2` |
| `diffusion_pytorch_model.safetensors` | 249521340 | `d8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b` | black-forest-labs/FLUX.2-small-decoder, `a3efc24f613ef42d9428af62fdbd6f5fd8856c4a` |

Both installed read-only files were hashed once; receipt is
`test-data/validation/m1-step6/continuation-20261003/model-identity.json`.
Personal paths and mtimeNs are confined to that ignored evidence. Preflight binds
path, basename, bytes, exact mtimeNs and pinned hash; no model copying or conversion.

Generation: **steps=4**, **strength=1**, **max_pixels=1048576** (1 MiB pixel budget),
request **mask_padding=0**; engine startup **--mask-padding 16** and Node-side
mask dilation **16 px**. Default context **160 px**, feather **8 px**; per-window
composite feather/constraint may be supplied by the reference mask planner.
CUDA-native sm120 uses reference process-size downscaling, without tile optimization.
Tiling geometry is tested separately for the reference paths that enable it.
No diffusion-pixel exact comparison is a parity target.

## Tests and differential methodology

New permanent tests: `tests/native-image.test.mjs`, `flux-worker.test.mjs`,
`flux-preflight.test.mjs`, `erase.test.mjs`; fixture
`tests/fixtures/flux/runner.mjs`; read-only TS loader `tests/erase-reference.mjs`;
exact comparator `tests/erase-differential.mjs`.

Synthetic cases cover edge clipping, large >1 MP crops and tiling, shared balloon
ownership, typography segmentation model/composite masks, target exclusion/current
bindings, blank translation, partial success and full unchanged failure,
transient layout restoration, best-effort prepass, config typing, receipt tampering,
BGRA/alpha/PNG round trips and asynchronous crop resize.

`tools/validate-erase.mjs` runs unmodified reference TS via in-memory transpile,
not the Rover mirror. The entire page mask context and every crop preparation
result are compared exactly (bounds, process sizes, masks, ownership, validation
bindings). Fixed generated BGRA crops exercise composite and change accounting.
Outside hard composite masks, every original pixel is explicitly asserted equal;
production feathered output is separately compared exactly to reference. Reference
feathering intentionally permits changes outside the core mask; the core is not
misrepresented as the feather envelope. Mask artifacts use pngjs 7.0.0 and compare
union pixels, provenance and deterministic grayscale PNG bytes.

For request execution the reference Electron seam is a separate synchronous
PNGjs codec on opaque synthetic crops, not Rover's image shim. It refuses resize;
large crop geometry is compared purely and sharp's >1 MP runtime path tested
separately. This validates algorithms and request construction, not Electron vs
sharp image-runtime equivalence. Reference/POSIX environment builders execute
independently. Source trees are never modified. Dynamic request file paths alone
are normalized; all other request fields and decoded crop/mask pixels are exact.

Real chapter binding uses the Step 3 durable context and installed chapter
`e87507ab-c752-4f9b-b0c0-75901c4c1110/0a4d6eaf-de01-4533-887c-10c0ab74c057`.
Stored blocks/layouts are fixed inputs, not an oracle for fresh diffusion output.
All nonempty pages are compared at fixed context=64 with stored-layout
constraints, using both tiled and untiled crop policies. A second `geometry-only`
run compares production context=160, mask padding=16, feather=8 and the actual
CUDA constraint-dependent isolation rule for all 46 pages; tiling geometry is
also exercised there as a separate policy. Independent PNGjs decode supplies identical opaque BGRA to both
algorithm implementations; this does not establish native-image decode parity.
Chapter/raster SHA-256 identities and per-page counts are in ignored summary.

## Actual self-validation / evidence

Evidence root (all new):
`test-data/validation/m1-step6/continuation-20261003/`.
Commands run from RoverCarrot. These are implementation-session results, not independent review.

| Command | Exit / result | Evidence |
|---|---|---|
| `node tools/audit-erase-ports.mjs` | 0; 47 mechanical, 7 adapted, 14 Rust source files exact | `ports-audit-final.json` |
| `node tools/flux-model-identity.mjs <installed-model> <installed-vae> <new-receipt>` | 0; both hashes match pins | `model-identity.json`, `model-identity.log` |
| `node tools/validate-erase.mjs test-data/validation/m1-step3/validation-context-durable.json <new-dir>` | 0; 46 pages, 260 blocks, 520 window cases, 1192 crops exact; 6911154393 repeated outside-mask pixel checks; 3 stored layouts across 2 pages | `differential.log`, `differential/summary.json` |
| Same command with a new directory and `geometry-only` | 0; 46 pages, 260 windows, 1474 crops exact with production CUDA isolation/defaults, including 2 downscaled crops | `default-geometry-cuda.log`, `default-geometry-cuda/summary.json` |
| `npm run check` | 0; typecheck/lint/build, **103/103** Node tests | `check-verified.log`, `.exit` |
| `npm run smoke` | 0; **15/15** in final isolated run | `smoke-verified.log`, `.exit` |
| `npm run check:boundaries` | 0; narrow native-image/pngjs allowlist, Core/Pipeline adapter-free | `boundaries-verified.log`, `.exit` |
| `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/python` | 0; 17/17 including preceding Flux recipe tests | `python.log`, `.exit` |
| `node --test tests/translation.test.mjs tests/typography.test.mjs` | 0; **27/27** Step 4/5 focused regressions | `earlier-stage-tests.log`, `.exit` |
| `node tools/validate-ocr.mjs test-data/validation/m1-step3/validation-context-durable.json cpu` | 0; 3 pages / 21 text+source fields exact, no differences | `ocr-cpu.log`; new `test-data/validation/m1-step3/differential-cpu-1791029598759/` |

Additional results: deterministic request construction/composite PASS; 29520
synthetic outside-mask pixels exact, grayscale union PNG **79 bytes** exact with
2 union pixels. The earlier full 46-page run used fixed context64; the final
production-default geometry receipt is separate. `default-geometry/` is an
additional pure isolated-window geometry run, not the final CUDA-policy receipt.

`node dist/cli.js --invalid`: exit 1 as intended, actionable argument rejection,
no missing-module error (`cli-import-invalid-flag.log`). A separate side-effect-free
`import('./dist/cli/app.js')` graph check exits 0 (`import-graph.log`). An earlier `node -e`
import probe accidentally used no CLI flags; configured output already existed
and was refused (exit 1, `cli-import.log`), with no output/evidence rewrite. This
probe appended normal CLI logs during the first separate smoke run and caused
its final real-log immutability assertion to fail; 15 individual cases passed.
That failure is preserved in `smoke.log`, `.exit`; a fully isolated rerun passed.
No test assertion was relaxed or real config/log/evidence restored or deleted.

No Flux GPU inference or CUDA build was run by this continuation. Model identity
hashing is not inference. Step 3 CPU OCR regression did execute the real OCR
model. Node tests use no real Flux model/GPU.

## Earlier-step files and regression scope

Step 1–5 files changed: `src/cli/app.ts` adds optional erase composition,
run-owned disposal and internal observer (inpainting-only configs also activate
configured layout), preserving existing public CLI/config
paths and earlier stages; `cli/config-file.ts`, `core/config.ts`,
`core/contracts.ts` add optional inpainting configuration; `tools/copy-ocr-assets.mjs`
adds runtime assets; `tests/boundaries.mjs` narrowly allows sharp only in the new
image adapter and pngjs only in the mask artifact mirror. Source-map existing
entries/order restored. README explains the added stage. No existing Step 5
algorithm module was changed. Dependency addition pngjs matches reference version.
All existing Node suites include Step 4 translation/lifecycle and Step 5 typography/
layout regressions. Step 3 CPU OCR is rerun on its durable bindings. Previous
observable contracts are preserved; no USER_DECISION_REQUIRED contract change was
needed. GPU OCR and live managed translation regressions remain Claude-owned.

## Claude orchestrator verification

Implementation of Step 6: mixed — previous Claude session (unfinished draft, see [Recovery audit](#recovery-audit-verdicts--mixed-authorship)) continued and corrected by Codex (implementation agent, tasks A–H). Validation in this section: Claude orchestrator, first pass, 2026-10-03/04. Because Claude authored part of the draft, this pass is **not independent** for those parts; independent review is **DEFERRED** ([Deferred Review Ledger](IMPLEMENTATION_PLAN.md#deferred-review-ledger)).

**Build (Claude, detached).** Attempts 1–5 failed on recipe gaps that Codex fixed (CUDA redist archives instead of PyPI wheels; `lib/stubs` merge; repo-local static OpenSSL 3.5.5; pinned cmake/ninja; CUDA 12.9 nvcc rejects GCC 15.2). After the user decision (repo-local GCC 14 as nvcc host compiler only), conda-forge GCC 14.3.0-20 (14 pinned packages, SHA-256 in `runtime/flux/pins.json`) is injected only through `NVCC_PREPEND_FLAGS=-ccbin`; `NVCC_CCBIN` is never set because bindgen_cuda 0.1.6 then adds `-allow-unsupported-compiler`. Attempt `attempt-6-gcc14` stopped at `env!(LLAMA_CPP_TAG)`; after the reference cargo env was added, `attempt-6-gcc14-resume1` succeeded in a fresh `target-gcc14` (all 394 crates built, `--locked`, Cargo.lock SHA-256 `79be450b…` unchanged, Rust 1.99.0). Verified in both logs: all 15 nvcc invocations used the GCC 14 host compiler, 0 `allow-unsupported-compiler`, 0 `NVCC_CCBIN`. Runner SHA-256 `d5173800d61389af81ef3bd4d9f7ad35e2d078396cba9a113c579128090b173c`, 84,446,472 bytes, compute cap 120, CUDA 12.9; `ldd` = system `libgcc_s`/`libm`/`libc` only, no RPATH/RUNPATH (no conda libstdc++/libgcc dependency). Model/VAE SHA-256 re-hashed by Claude and equal to `model-pins.json`.

**GPU run r1 — runtime failure found (F1).** The runner smoke "passed" functionally but ran on CPU (model load 61 s, 10–25 min per crop, VRAM flat, GPU 0 %). The 4-page E2E crawled and Claude stopped its owned processes (SIGTERM, no orphans) after ~1 h 46 m. **Incident:** the user's llama-server container stayed stopped for ~2 h during r1; the wrapper restored the same container (same ID, running/healthy, 8081 `/health` and `/v1/models` 200). Lesson recorded in the plan: GPU validation runs are time-bounded. Root cause and fix: [F1](#f1--pre-review-runtime-rework-2026-10-04).

**GPU run r2 (after F1), evidence `test-data/validation/m1-step6/claude-gpu-r2/`.** Host driver reports CUDA 13.4 (koharu requires ≥ 13.0). Each run under `timeout` and the container stop/start wrapper:
- Runner smoke (900 s cap): exit 0. Runner stderr `NVIDIA driver reports CUDA 13.4 support`, `GPU compute capability: 12.0`, no CPU-fallback line. Model load 62.5 s (model on the Windows drive via `/mnt/c`); 496×496 crop **20.4 s** (first crop, includes warm-up). Failure path (absent input) cleaned up; no runner left.
- 4-page CLI E2E (2,400 s cap; detect → GPU OCR → managed translation → typography → erase → layout): **PASS**, output `test-data/output/m1-step6-f1-rerun-20261004`. Pages 10/2/10/20 blocks, all erased (`erasedWorkflowRegions` bound per block); layouts 8/2/10/18. Flux model load 66.4 s; **42 crops, 34.6 s total, max 2.4 s**. Sequential lifecycle: 4 managed llama-server starts, each `SIGTERM` → exit code 0, VRAM back to the 1,477 MiB baseline after every stop and at Flux start (WSL reports no per-process VRAM; device total is the evidence). Flux worker disposed, `alivePids: []`, VRAM 1,477 MiB after. Container restored (healthy, 200/200) after each run; downtime a few minutes per run.
- Visual check of page 001 (original vs inpainted): bubble text removed, art outside bubbles intact; one faint residual glyph inside the bottom-left bubble. Diffusion pixels are not a parity target.

**Deterministic differential (fresh reference TS vs port, no GPU).** Run 1 `claude-review/` (before F1): full PASS — 46 pages, 260 blocks, 599 + 593 (constrained) crops, ~3.47e9 outside-mask pixels preserved exactly; production geometry PASS — 1,474 crops; request and mask-artifact checks exact. F1 changed 3 files in the 138-file source snapshot (`adapters/flux.mjs`, `erase-adaptations.json`, ported `fluxWorker.mjs`), so both modes were **rerun** (`claude-review-r2/`, new snapshot): PASS, summaries byte-identical to run 1.

**Other first-pass checks.** Shim fixtures (BGRA order, Step 5 raster equality on 4 pages, PNG round trip, resize) PASS (`claude-review/shim-check.out`). Diff reviewed: runner copy byte-identical to reference (14 files), launch args equal to reference minus Windows-only `--cuda-runtime-dir`, Linux-only additions are env (`LD_LIBRARY_PATH`, `RUST_LOG`) and CPU-fallback refusal. Regression after F1 (Claude): `npm run check` 105/105, `npm run smoke` 15/15, `npm run check:boundaries`, Python 29/29, `npm run build` — all PASS. Side effect noted: an earlier Codex run created Git-ignored `__pycache__/` and `.tmp/` at the repo root (no tracked change; left in place).

**Not run.** Exact Electron codec/resize comparison: no reference Electron executable exists on this host (same as Step 5). The sharp-based shim is therefore **not verified byte-equivalent to Electron** for decode/resize; deterministic parity above uses the same shim on both sides. Open for deferred review/user decision; no tolerance granted.

Prepared commands (Codex, kept for reruns). A concrete isolated TOML is ready at
`test-data/validation/m1-step6/continuation-20261003/prepared-gpu/e2e.toml`;
`bound-page.json` beside it contains the first durable Step 3 bound page.
The TOML reuses Claude's validated Step 5 isolated GPU profile and read-only
four-page input, adds the verified Flux receipt/paths, and selects a new output
`test-data/output/m1-step6-continuation-20261003-gpu` (confirmed absent).
It was parsed successfully; no GPU process or output was started.
No user config was copied or changed. Concrete first execution:

```bash
STEP6_EVIDENCE=test-data/validation/m1-step6/continuation-20261003
python3 runtime/flux/build.py --build --jobs 16
node tools/erase-smoke.mjs runner "$STEP6_EVIDENCE/prepared-gpu/e2e.toml" "$STEP6_EVIDENCE/prepared-gpu/runner-evidence" "$STEP6_EVIDENCE/prepared-gpu/bound-page.json"
HF_HUB_OFFLINE=1 node tools/erase-smoke.mjs e2e "$STEP6_EVIDENCE/prepared-gpu/e2e.toml" "$STEP6_EVIDENCE/prepared-gpu/e2e-evidence"
```

Build is Claude-only; do not run it twice or race an already-running build. For
repeat GPU validation reserve a new TOML/output/evidence destination. General
commands for those new paths follow. Receipt path may point
to the verified ignored receipt above. If preparing another receipt, create a new
parent directory first and use a fresh receipt filename.

```bash
# Build (Claude only; do not race an already-running build):
python3 runtime/flux/build.py --build --jobs 16
# Hash-only receipt creation when needed (paths supplied by Claude):
node tools/flux-model-identity.mjs "$FLUX_MODEL" "$FLUX_VAE" "$NEW_RECEIPT"
# Deterministic CPU reference differential:
node tools/validate-erase.mjs test-data/validation/m1-step3/validation-context-durable.json "$NEW_DIFFERENTIAL_DIR"
# Real runner smoke; bind one installed page in a new ignored JSON file:
node tools/erase-smoke.mjs runner "$STEP6_TOML" "$NEW_RUNNER_EVIDENCE_DIR" "$BOUND_PAGE_JSON"
# Real 4-page CLI E2E (exact selected stages, GPU OCR, managed translation):
HF_HUB_OFFLINE=1 node tools/erase-smoke.mjs e2e "$STEP6_TOML" "$NEW_E2E_EVIDENCE_DIR"
# Fresh exact codec comparison (existing reference Electron; no GPU):
"$REFERENCE_ELECTRON" tools/electron-erase-reference.mjs test-data/validation/m1-step3/validation-context-durable.json "$NEW_CODEC_EVIDENCE_DIR"
```

`STEP6_TOML` must select exactly detect, ocr, translate, typography, erase, layout,
configure `[models].koharu`, GPU OCR, managed translation, and `[inpainting]` from
README. Runner mode expects a single bound page object with blocks and original
image path; tool maps Windows paths read-only. Both modes reserve fresh evidence;
E2E refuses an existing output. Tools never stop/start Docker. Claude follows the
GPU operational protocol, including restoring the same preexisting container.

Inspect runner crop PNG size/format, load/crop timing diagnostics, successful JSON
shutdown and failure cleanup. Inspect `lifecycle.jsonl`: actual llama-start,
llama-stopped, Flux process-start and flux-disposed records; PID probes and GPU
snapshots at handoff. WSL may omit per-process VRAM; samples are evidence for Claude
to verify, not an automatic assertion of released VRAM. Confirm every owned runner
exits and no llama process remains before Flux starts. Record build command/exit,
binary SHA, GPU environment, output chapter, image/mask validity and codec results.
If actual runtime/codec failures require changing a previously accepted observable
contract or pinned runtime/model choice, stop for USER_DECISION_REQUIRED.

| Check | Result | Evidence |
|---|---|---|
| CUDA build / pinned binary identity | PASS (GCC 14 nvcc host only, ldd system-only) | `test-data/validation/m1-step6/build/attempt-6-gcc14-resume1/` |
| Real crop runner smoke / failure cleanup | PASS on GPU after F1 (r1 ran on CPU) | `claude-gpu-r2/runner-evidence/`, r1 kept in `claude-gpu-r1/` |
| Four-page GPU E2E / sequential lifecycle / VRAM handoff | PASS (42 crops, llama exits before Flux, Flux disposed) | `claude-gpu-r2/e2e-evidence/` |
| Exact Electron codec/resize comparison | Not run — no reference Electron on host | — |
| Orchestrator source/diff first-pass check | PASS; differential rerun after F1 identical | `claude-review/`, `claude-review-r2/` |

## Continuation safeguards / remaining scope

No Git mutation (including fetch/commit/tag/push), handoff/CURRENT edit, root
reference/analysis edit, source data/model write, prior evidence/output overwrite,
system change, Docker operation, or non-owned process signal was performed.
No model/binary/toolchain/archive/cache/image was added to the tracked tree.
Owned temporary fixtures/processes were cleaned; ignored evidence and prior
artifacts are preserved. Build/GPU orchestration remains Claude's task.

There is no identified earlier-step contract change requiring
USER_DECISION_REQUIRED. Open validation: actual pinned CUDA build/binary,
real runner crop and four-page GPU E2E, VRAM handoff inspection, and exact
Electron codec/resize comparison. These have prepared tools, not claimed results.
If a verified mismatch needs a behavioral change, the existing decision workflow
applies; no tolerance or blanket acceptance is granted here.

## Review findings

| ID | Severity | Disposition | Status | Rounds | Finding / evidence |
|---|---|---|---|---|---|


## F1 — pre-review runtime rework (2026-10-04)

Claude GPU validation found the GCC 14 runner identifying RTX 5090 but loading
Flux on CPU (~61 s model load, 10–25 min per 496×496 crop, unchanged 1,477 MiB
baseline VRAM and 0% GPU utilisation). This is implementation-session validation,
not independent review. Original evidence is preserved under
`test-data/validation/m1-step6/claude-gpu-r1/{runner-evidence,e2e-evidence}/lifecycle.jsonl`.

Root cause: pinned koharu `0d640615` `koharu-ml/src/lib.rs:31` selects CUDA only
when `koharu_runtime::check_cuda_driver_support()` succeeds. Its
`koharu-runtime/src/cuda.rs:127,162` loads **libcuda.so**, while WSL's linker cache
advertises only **libcuda.so.1**. The CUDA device banner alone therefore does not
prove the model is on GPU. Windows reference loads **nvcuda.dll** and uses CUDA;
silent CPU execution would diverge from the reference cuda-native engine contract.
Rejecting this fallback restores that contract; no new user decision is needed.

Rework adds optional absolute `[inpainting].cudaDriverLibraryDir` and otherwise
reads `ldconfig -p` entries for `libcuda.so.1`. Preflight requires readable,
loadable unversioned `libcuda.so` in the chosen directory and probes dlopen via
Python ctypes under the runner's loader environment (no inference). Launch order
is pinned CUDA 12.9, driver directory, inherited LD_LIBRARY_PATH. Missing or
unloadable driver libraries fail clearly; no symlink shim/system writes are made.
The probe verifies shared-library loading, not actual CUDA inference or GPU access.

`RUST_LOG=warn,koharu_runtime=info,koharu_ml=info` exposes driver checks. Worker
collects koharu stderr, including split lines, and CPU fallback permanently fails
the cuda-native engine through the existing owned-process termination path.
`fluxWorker.mjs` is now an explicitly documented Linux adaptation (46 mechanical,
8 adapted modules); all 14 Rust/reference files including Cargo remain identical.
Smoke requires `NVIDIA driver reports CUDA ... support` for each successful crop's
worker, refuses CPU fallback, and records model-load elapsedMs plus every crop's
runner elapsedMs in lifecycle and summary files. Existing PID/VRAM records remain.
Timing and VRAM are evidence, not performance thresholds or automatic VRAM claims.

No-GPU checks: `npm run check` (105 tests), `npm run smoke` (15 tests),
`npm run check:boundaries`, `python3 -m unittest discover -s tests/python`
(29 tests), `npm run build`, and `node tools/audit-erase-ports.mjs` passed.
Driver tests cover fixture cache discovery, explicit override, versioned-only and
invalid ELF refusal, no candidates, environment order; config tests cover absolute
optional paths and unknown keys; a real child fixture verifies split CPU fallback
fails and exits while an unrelated sentinel survives. Evidence is reserved under
`test-data/validation/m1-step6/f1-rework-20261004/`. GPU confirmation remains pending.

Exact Claude rerun from `RoverCarrot/` (existing GCC 14 binary, no rebuild):

```bash
npm run build
F1_EVIDENCE=test-data/validation/m1-step6/f1-rework-20261004
HF_HUB_OFFLINE=1 node tools/erase-smoke.mjs runner "$F1_EVIDENCE/e2e.toml" "$F1_EVIDENCE/runner-evidence" test-data/validation/m1-step6/continuation-20261003/prepared-gpu/bound-page.json
HF_HUB_OFFLINE=1 node tools/erase-smoke.mjs e2e "$F1_EVIDENCE/e2e.toml" "$F1_EVIDENCE/e2e-evidence"
```

The new TOML preserves r1 runtime/model/input bindings, omits the optional driver
override to exercise discovery, and selects fresh output
`test-data/output/m1-step6-f1-rerun-20261004`. Both evidence destinations must stay
absent until Claude runs them. Subsequent reruns need new TOML/output/evidence
paths. Inspect positive koharu CUDA message, model/crop timings, GPU utilisation
and VRAM, JSON shutdown and all owned PID exits. Preserve r1 evidence throughout.

| Finding | Severity | Disposition | Status |
|---|---|---|---|
| F1: WSL unversioned driver dlopen silently selected CPU | High | REQUIRED_FIX; code/tests complete as pre-review rework | Claude GPU rerun r2 PASS (driver CUDA 13.4 info line, 42 GPU crops); not independently reviewed or closed |
