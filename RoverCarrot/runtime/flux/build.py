#!/usr/bin/env python3
"""Pinned Linux CUDA build of the Carrot Flux.2 Klein runner, without sudo or HOME writes.

Mirrors the reference Windows producer (scripts/flux-klein-build-plan.cjs):
`cargo build --release` of tools/mgt-flux-klein-runner with default features
(`cuda`), CUDA 12.9 and CUDA_COMPUTE_CAP=120 (the `mgt-flux-klein-sm120` runtime
selected for RTX 50). The runner source is a byte-identical copy kept next to
this script. CUDA 12.9 components and cuDNN 9.21 come from NVIDIA's Linux
redistributable archives with the same versions as the reference Windows
runtime archives (cudart 12.9.37, cuBLAS 12.9.0.13, cuRAND 10.3.10.19, cuFFT
11.4.0.6, cuDNN 9.21.0.82). Pinned CMake/Ninja wheels supply Linux host
build tools. Default: provision only. --build compiles the runner;
--check-native builds only the locked host native dependencies.
GCC 14 is used only by nvcc through NVCC_PREPEND_FLAGS (never NVCC_CCBIN).
All large artifacts live in ignored test-data/runtime/flux-sm120.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile


# Only this pre-completion recipe may resume with the completed reference env.
REFERENCE_ENV_PREDECESSOR = '5233d3e28b2b8fd94aa9db6ce1e8027823073050a96ba015ebf9a6004ebef8cc'

NATIVE_PACKAGES = ('libz-sys', 'aws-lc-sys', 'onig_sys', 'openssl-sys', 'ring')


def provision_build_tools(pins, root, downloads):
    tools = root / 'build-tools'
    for pin in pins:
        wheel = downloads / pin['file']
        verified_download(pin['url'], wheel, pin['sha256'], pin['bytes'])
        destination = tools / pin['package']
        # Recheck every extracted byte against the verified wheel on reuse.
        with zipfile.ZipFile(wheel) as archive:
            for member in archive.infolist():
                relative = Path(member.filename)
                if relative.is_absolute() or '..' in relative.parts:
                    raise RuntimeError(f'Unsafe wheel path: {member.filename}')
                path = destination / relative
                if member.is_dir():
                    path.mkdir(parents=True, exist_ok=True)
                    continue
                data = archive.read(member)
                if path.exists():
                    if path.is_symlink() or path.read_bytes() != data:
                        raise RuntimeError(f'Existing build tool differs from pin: {path}')
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                if path.parent.name in ('bin', 'scripts'):
                    path.chmod(path.stat().st_mode | 0o111)
        print(f"Verified {pin['package']}=={pin['version']}", flush=True)
    ninja_pin = next(pin for pin in pins if pin['package'] == 'ninja')
    return (tools / 'cmake/cmake/data/bin',
            tools / f"ninja/ninja-{ninja_pin['version']}.data/scripts")


def cargo_command(manifest, check_native=False):
    command = ['cargo', 'build', '--release', '--locked', '-vv', '--manifest-path', str(manifest)]
    if check_native:
        for package in NATIVE_PACKAGES:
            command.extend(['-p', package])
    return command


def reference_environment(env, source):
    # Reference prepare-flux-klein-runner.cjs:466-482, in the same order.
    home = env.get('HOME')
    remaps = [(source, '<mgt-source>'), (home, '<build-home>'),
              (env.get('CARGO_HOME'), '<cargo-home>'),
              (Path(home or '') / '.cargo', '<cargo-home>')]
    flags = [env['RUSTFLAGS']] if env.get('RUSTFLAGS') else []
    recorded = ['<inherited RUSTFLAGS>'] if flags else []
    for path, placeholder in remaps:
        if path and Path(path).exists():
            flags.append(f'--remap-path-prefix={path}={placeholder}')
            recorded.append(f'--remap-path-prefix={placeholder}={placeholder}')
    env['RUSTFLAGS'] = ' '.join(flags).strip()
    env['LLAMA_CPP_TAG'] = 'b-mgt-unused'
    return {'LLAMA_CPP_TAG': env['LLAMA_CPP_TAG'], 'CUDA_HOME': '<cuda-root>',
            'CARGO_HOME': '<cargo-home>', 'RUSTFLAGS': ' '.join(recorded).strip(),
            'reference': ['scripts/flux-klein-build-plan.cjs:110-142',
                          'scripts/prepare-flux-klein-runner.cjs:466-482']}


def build_environment(env, root, cuda, openssl, pins, jobs, tool_bins):
    env = dict(env)
    env['PATH'] = ':'.join(str(path) for path in
                           (root / 'cargo/bin', *tool_bins, cuda / 'bin')) + ':' + env.get('PATH', '')
    env.update({
        'RUSTUP_HOME': str(root / 'rustup'), 'CARGO_HOME': str(root / 'cargo'),
        'OPENSSL_DIR': str(openssl), 'OPENSSL_STATIC': '1',
        'OPENSSL_LIB_DIR': str(openssl / 'lib'),
        'OPENSSL_INCLUDE_DIR': str(openssl / 'include'),
        'CUDA_COMPUTE_CAP': pins['computeCap'],
        'CUDA_HOME': str(cuda), 'CUDA_PATH': str(cuda), 'CUDA_ROOT': str(cuda), 'CUDA_TOOLKIT_ROOT_DIR': str(cuda),
        'CUDACXX': str(cuda / 'bin/nvcc'),
        'LD_LIBRARY_PATH': f"{cuda / 'lib64'}:{env.get('LD_LIBRARY_PATH', '')}",
        'LIBRARY_PATH': f"{cuda / 'lib64'}:{env.get('LIBRARY_PATH', '')}",
        'CARGO_TARGET_DIR': str(root / 'target-gcc14'), 'CARGO_BUILD_JOBS': str(jobs),
        'GIT_CEILING_DIRECTORIES': str(root),
    })
    return env


def verified_download(url, destination, digest, size):
    if not destination.exists():
        partial = destination.with_suffix(destination.suffix + '.partial')
        with urllib.request.urlopen(url) as response, partial.open('wb') as output:
            shutil.copyfileobj(response, output)
        partial.rename(destination)
    with destination.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if destination.stat().st_size != size or actual != digest:
        raise RuntimeError(f'Integrity mismatch: {destination}; no substitution permitted')


def extract_archive(archive_path, destination):
    marker = destination / '.extracted-sha256'
    digest = sha256(archive_path)
    if marker.exists():
        if marker.read_text().strip() != digest:
            raise RuntimeError(f'Existing extraction differs from pin: {destination}')
        return
    if destination.exists():
        raise RuntimeError(f'Unverified extraction already present: {destination}')
    partial = destination.with_name(destination.name + '.partial')
    if partial.exists():
        shutil.rmtree(partial)
    partial.mkdir(parents=True)
    with tarfile.open(archive_path) as archive:
        archive.extractall(partial, filter='data')
    (partial / '.extracted-sha256').write_text(digest + '\n')
    partial.rename(destination)


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def assemble_cuda(redist, cuda):
    # Each redist archive holds one <name>-archive/ root with bin/include/lib.
    # Merge real directories, linking only files to the verified bytes.
    def merge_directory(source, target):
        if target.is_symlink() and target.is_dir():
            # Migrate an earlier whole-directory link without touching its source.
            previous = target.resolve()
            target.unlink()
            target.mkdir()
            merge_directory(previous, target)
        elif target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_dir():
                raise RuntimeError(f'CUDA layout collision: {target}')
        else:
            target.mkdir()
        for child in sorted(source.iterdir()):
            link = target / child.name
            if child.is_dir():
                merge_directory(child, link)
            elif link.is_symlink() and link.resolve() == child.resolve():
                continue
            elif link.exists() or link.is_symlink():
                raise RuntimeError(f'CUDA layout collision: {link}')
            else:
                link.symlink_to(child.resolve())

    if cuda.is_symlink():
        raise RuntimeError(f'CUDA layout collision: {cuda}')
    cuda.mkdir(exist_ok=True)
    for component in sorted(redist.iterdir()):
        roots = [child for child in component.iterdir() if child.is_dir()]
        if len(roots) != 1:
            raise RuntimeError(f'Unexpected archive layout: {component}')
        for directory in ('bin', 'include', 'lib', 'lib64', 'nvvm'):
            source = roots[0] / directory
            if not source.is_dir():
                continue
            target = cuda / ('lib64' if directory == 'lib' else directory)
            merge_directory(source, target)
    if not (cuda / 'lib').exists():
        (cuda / 'lib').symlink_to('lib64', target_is_directory=True)


def provision_openssl(pin, root, downloads, jobs):
    archive = downloads / pin['url'].rsplit('/', 1)[1]
    verified_download(pin['url'], archive, pin['sha256'], pin['bytes'])
    source = root / f"openssl-source-{pin['version']}"
    extract_archive(archive, source)
    prefix = root / f"openssl-{pin['version']}"
    options = [*pin['configureOptions'], f'--prefix={prefix}', f'--openssldir={prefix / "ssl"}']
    identity = {k: pin[k] for k in ('version', 'url', 'bytes', 'sha256', 'configureOptions')}
    receipt_path = prefix / '.build-identity.json'

    def inventory():
        return {str(path.relative_to(prefix)): sha256(path)
                for directory in ('include', 'lib')
                for path in sorted((prefix / directory).rglob('*')) if path.is_file()}

    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if (receipt.get('source') != identity or receipt.get('configure') != options or
                not receipt.get('files') or receipt['files'] != inventory()):
            raise RuntimeError(f'OpenSSL build verification mismatch: {prefix}')
    else:
        work = source / f"openssl-{pin['version']}"
        subprocess.run(['perl', 'Configure', *options], cwd=work, check=True)
        subprocess.run(['make', f'-j{jobs}'], cwd=work, check=True)
        subprocess.run(['make', 'install_sw'], cwd=work, check=True)
        files = inventory()
        for required in ('lib/libssl.a', 'lib/libcrypto.a', 'include/openssl/ssl.h'):
            if required not in files:
                raise RuntimeError(f'Missing OpenSSL build output: {required}')
        receipt_path.write_text(json.dumps({'source': identity, 'configure': options,
                                           'files': files}, indent=2) + '\n')
    print(f"Verified local static OpenSSL=={pin['version']}", flush=True)
    return prefix, identity


# Conda packages are unpacked into their standard relocatable prefix. No activation,
# conda install, compiler PATH aliases, or toolchain/sysroot symlink fixes are used.
def decompress_zstd(data):
    import ctypes
    import ctypes.util
    lib = ctypes.CDLL(ctypes.util.find_library('zstd') or 'libzstd.so.1')
    lib.ZSTD_getFrameContentSize.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    lib.ZSTD_getFrameContentSize.restype = ctypes.c_ulonglong
    lib.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                   ctypes.c_void_p, ctypes.c_size_t]
    lib.ZSTD_decompress.restype = ctypes.c_size_t
    lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
    lib.ZSTD_isError.restype = ctypes.c_uint
    size = lib.ZSTD_getFrameContentSize(data, len(data))
    if size >= (1 << 64) - 2:
        raise RuntimeError('Conda zstd frame must declare its content size')
    output = ctypes.create_string_buffer(size)
    result = lib.ZSTD_decompress(output, size, data, len(data))
    if lib.ZSTD_isError(result) or result != size:
        raise RuntimeError('Invalid conda zstd frame')
    return output.raw


def prefix_inventory(prefix):
    return {str(p.relative_to(prefix)): {'link': os.readlink(p)} if p.is_symlink()
            else {'sha256': sha256(p), 'mode': p.stat().st_mode & 0o777}
            for p in sorted(prefix.rglob('*')) if p.is_symlink() or p.is_file()}


def provision_gcc(pin, root):
    import io
    workspace = root / 'gcc14-conda'
    downloads = workspace / 'downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    prefix = workspace / 'prefix'
    receipt = workspace / 'prefix-identity.json'
    for package in pin['packages']:
        verified_download(package['url'], downloads / package['file'],
                          package['sha256'], package['bytes'])
        print('Verified GCC package:', package['file'], package['sha256'], flush=True)
    if receipt.exists():
        identity = json.loads(receipt.read_text())
        if identity.get('pin') != pin or identity.get('files') != prefix_inventory(prefix):
            raise RuntimeError('GCC 14 prefix verification mismatch')
    else:
        if prefix.exists():
            raise RuntimeError('Unverified GCC prefix exists; preserve it and investigate')
        prefix.mkdir()
        for package in pin['packages']:
            with zipfile.ZipFile(downloads / package['file']) as archive:
                payloads = [n for n in archive.namelist() if n.startswith('pkg-') and n.endswith('.tar.zst')]
                if len(payloads) != 1:
                    raise RuntimeError('Unexpected conda package layout')
                with tarfile.open(fileobj=io.BytesIO(decompress_zstd(archive.read(payloads[0])))) as payload:
                    payload.extractall(prefix, filter='data')
        receipt.write_text(json.dumps({'pin': pin, 'files': prefix_inventory(prefix)}, indent=2) + '\n')
    gcc = prefix / 'bin/x86_64-conda-linux-gnu-gcc'
    gxx = prefix / 'bin/x86_64-conda-linux-gnu-g++'
    for compiler in (gcc, gxx):
        subprocess.run([str(compiler), '--version'], check=True)
        actual = subprocess.check_output([str(compiler), '-dumpfullversion'], text=True).strip()
        if actual != pin['version']:
            raise RuntimeError(f'GCC version mismatch: {actual}')
    return gcc, gxx


def nvcc_environment(env, gxx):
    import shlex
    env = dict(env)
    # Reject inherited overrides rather than silently honoring a bypass or a
    # second -ccbin. NVCC_CCBIN even when empty triggers bindgen_cuda's bypass.
    for key in ('NVCC_CCBIN', 'NVCC_PREPEND_FLAGS', 'NVCC_APPEND_FLAGS',
                'NVCCFLAGS', 'NVCC_FLAGS', 'CUDA_NVCC_FLAGS', 'CUDAHOSTCXX'):
        if key in env:
            raise RuntimeError(f'Conflicting inherited CUDA compiler setting: {key}')
    env['NVCC_PREPEND_FLAGS'] = '-ccbin ' + shlex.quote(str(gxx))
    return env


def nvcc_launcher(directory, nvcc, gxx, log):
    # bindgen_cuda captures stdout/stderr and discards them on success. Record
    # invocations independently, then replay the journal after cargo (also on
    # failure) so -vv logs include every command, flags and selected host.
    import sys
    directory.mkdir()
    launcher = directory / 'nvcc'
    launcher.write_text(f'''#!{sys.executable}
import json, os, sys
args = sys.argv[1:]
for arg in args:
    if 'unsupported-compiler' in arg or arg in ('-ccbin', '--compiler-bindir') or arg.startswith(('-ccbin=', '--compiler-bindir=')):
        raise SystemExit('Forbidden or conflicting nvcc compiler argument: ' + arg)
if 'NVCC_CCBIN' in os.environ or os.environ.get('NVCC_PREPEND_FLAGS') != {('-ccbin ' + __import__('shlex').quote(str(gxx)))!r} or 'NVCC_APPEND_FLAGS' in os.environ:
    raise SystemExit('Unexpected nvcc host compiler environment')
entry = {{'nvcc': {str(nvcc)!r}, 'argv': args, 'hostCompiler': {str(gxx)!r}, 'NVCC_PREPEND_FLAGS': os.environ['NVCC_PREPEND_FLAGS']}}
fd = os.open({str(log)!r}, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
os.write(fd, (json.dumps(entry) + '\\n').encode())
os.close(fd)
os.execv({str(nvcc)!r}, [{str(nvcc)!r}, *args])
''')
    launcher.chmod(0o755)
    return directory


def prepare_target(target, attempt, resume=False):
    marker = target / '.gcc14-attempt.json'
    if target.is_symlink():
        raise RuntimeError('GCC 14 target must not be a symlink')
    if resume:
        if not marker.is_file():
            raise RuntimeError('Resume requires the same recorded GCC14 attempt')
        previous = json.loads(marker.read_text())
        completed = (previous.get('recipeSha256') == REFERENCE_ENV_PREDECESSOR and
                     {k: v for k, v in previous.items() if k != 'recipeSha256'} ==
                     {k: v for k, v in attempt.items() if k != 'recipeSha256'})
        if previous != attempt and not completed:
            raise RuntimeError('Resume requires the same recorded GCC14 attempt')
        return {'previousRecipeSha256': previous.get('recipeSha256'),
                'referenceEnvironmentCompleted': completed}

    else:
        if target.exists() and any(target.iterdir()):
            raise RuntimeError('GCC 14 target is non-empty; use --resume-gcc14 for the same attempt')
        target.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps(attempt, indent=2) + '\n')


def gcc_probe(root, cuda, gcc, gxx, pin):
    import uuid
    directory = root / 'gcc14-conda' / 'probes' / uuid.uuid4().hex
    directory.mkdir(parents=True)
    env = nvcc_environment(os.environ, gxx)
    log = directory / 'nvcc-invocations.jsonl'
    launcher = nvcc_launcher(directory / 'nvcc-bin', cuda / 'bin/nvcc', gxx, log)
    env['PATH'] = str(launcher) + ':' + env.get('PATH', '')
    source = directory / 'sm120.cu'
    source.write_text('#include <cuda_runtime.h>\n#include <vector>\n'
                      '#if __GNUC__ != 14\n#error Expected GCC 14\n#endif\n'
                      '__global__ void probe(int *p) { *p = 120; }\n'
                      'int host_probe() { std::vector<int> v{120}; return v[0]; }\n')
    subprocess.run([str(cuda / 'bin/nvcc'), '--version'], check=True)
    command = ['nvcc', '-v', '-arch=sm_120', '-std=c++17', '-c', str(source),
               '-o', str(directory / 'sm120.o')]
    result = subprocess.run(command, env=env, capture_output=True, text=True)
    (directory / 'probe.log').write_text(result.stdout + result.stderr)
    print(result.stdout + result.stderr, flush=True)
    print(log.read_text(), flush=True)
    result.check_returncode()
    identity = {'provider': pin['provider'], 'version': pin['version'],
                'gccVersion': subprocess.check_output([str(gcc), '--version'], text=True).strip(),
                'gxxVersion': subprocess.check_output([str(gxx), '--version'], text=True).strip(),
                'packages': pin['packages'], 'gcc': str(gcc), 'gxx': str(gxx),
                'scope': 'nvcc host compiler only', 'mechanism': env['NVCC_PREPEND_FLAGS'],
                'probe': str(directory), 'probeObjectSha256': sha256(directory / 'sm120.o')}
    (directory / 'identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    print('PASS: CUDA 12.9 sm_120 probe with GCC 14; no compiler bypass', flush=True)
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--build', action='store_true')
    mode.add_argument('--provision', action='store_true', help='Default: provision GCC 14 and run sm_120 probe only')
    parser.add_argument('--resume-gcc14', action='store_true', help='Resume the recorded target-gcc14 attempt')
    mode.add_argument('--check-native', action='store_true',
                      help='Build only locked native host crates; no runner or CUDA kernels')
    parser.add_argument('--jobs', type=int, default=2)
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    here = Path(__file__).resolve().parent
    project = here.parents[1]
    pins = json.loads((here / 'pins.json').read_text())
    root = project / 'test-data/runtime/flux-sm120'
    if args.resume_gcc14 and not args.build:
        parser.error('--resume-gcc14 requires --build')
    gcc, gxx = provision_gcc(pins['nvccHostCompiler'], root)
    cuda = root / 'cuda-12.9'
    gcc_identity = gcc_probe(root, cuda, gcc, gxx, pins['nvccHostCompiler'])
    if not (args.build or args.check_native):
        return
    # Existing Step 6 dependencies are read-only in this narrow follow-up.
    openssl = root / f"openssl-{pins['openssl']['version']}"
    openssl_identity = pins['openssl']
    receipt = json.loads((openssl / '.build-identity.json').read_text())
    inventory = {str(path.relative_to(openssl)): sha256(path)
                 for directory in ('include', 'lib')
                 for path in sorted((openssl / directory).rglob('*')) if path.is_file()}
    options = [*pins['openssl']['configureOptions'], f'--prefix={openssl}',
               f'--openssldir={openssl / "ssl"}']
    if (receipt['source'] != openssl_identity or receipt['configure'] != options or
            not inventory or receipt['files'] != inventory):
        raise RuntimeError('Existing OpenSSL identity mismatch')
    # Recheck pinned dependency bytes without modifying their existing prefixes.
    for pin in [*pins['archives'], pins['openssl'], *pins['buildTools']]:
        archive = root / 'downloads' / pin['url'].rsplit('/', 1)[1]
        if not archive.is_file():
            raise RuntimeError(f'Existing dependency archive required: {archive}')
        verified_download(pin['url'], archive, pin['sha256'], pin['bytes'])
    for pin in pins['buildTools']:
        with zipfile.ZipFile(root / 'downloads' / pin['file']) as wheel:
            for member in wheel.infolist():
                if member.is_dir():
                    continue
                path = root / 'build-tools' / pin['package'] / member.filename
                if path.is_symlink() or path.read_bytes() != wheel.read(member):
                    raise RuntimeError(f'Existing build tool differs from pin: {path}')
    tool_bins = (root / 'build-tools/cmake/cmake/data/bin',
                 root / 'build-tools/ninja/ninja-1.13.2.data/scripts')
    env = dict(os.environ)
    if not (root / 'cargo/bin/cargo').exists():
        raise RuntimeError('Existing repo-local Rust toolchain is required')
    env = build_environment(env, root, cuda, openssl, pins, args.jobs, tool_bins)
    reference_env = reference_environment(env, here / 'mgt-flux-klein-runner')
    env = nvcc_environment(env, gxx)
    for version_command in (['rustc', '--version'], ['cargo', '--version'], ['nvcc', '--version'],
                            ['cmake', '--version'], ['ninja', '--version']):
        subprocess.run(version_command, env=env, check=True)
    manifest = here / 'mgt-flux-klein-runner/Cargo.toml'
    target = root / 'target-gcc14'
    command = cargo_command(manifest, args.check_native)
    print('Build:', json.dumps(command), flush=True)
    import uuid
    run_dir = root / 'gcc14-conda/build-runs' / uuid.uuid4().hex
    run_dir.mkdir(parents=True)
    attempt = {'id': 'flux-sm120-gcc14', 'nvccHostCompiler': pins['nvccHostCompiler'],
               'cargoLockSha256': sha256(manifest.with_name('Cargo.lock')),
               'recipeSha256': sha256(Path(__file__)), 'computeCap': pins['computeCap'],
               'cudaArchives': pins['archives'], 'rust': pins['rust'],
               'openssl': pins['openssl'], 'buildTools': pins['buildTools']}
    if args.build:
        resume_identity = prepare_target(target, attempt, args.resume_gcc14)
    elif target.exists() and any(target.iterdir()):
        raise RuntimeError('Native check requires an empty GCC14 target')
    log = run_dir / 'nvcc-invocations.jsonl'
    launcher = nvcc_launcher(run_dir / 'nvcc-bin', cuda / 'bin/nvcc', gxx, log)
    env['PATH'] = str(launcher) + ':' + env['PATH']
    env['CUDACXX'] = str(launcher / 'nvcc')
    print('GCC14 attempt:', json.dumps(attempt), 'resume:', args.resume_gcc14, flush=True)
    (run_dir / 'attempt.json').write_text(json.dumps({'attempt': attempt, 'resume': args.resume_gcc14,
                                                     'resumeIdentity': resume_identity if args.build else None,
                                                     'referenceBuildEnvironment': reference_env}, indent=2) + '\n')
    try:
        subprocess.run(command, env=env, check=True)
    finally:
        if log.exists():
            print('All nvcc invocations (including captured successful commands):', flush=True)
            print(log.read_text(), flush=True)
    if args.check_native:
        (run_dir / 'native-check-identity.json').write_text(json.dumps({
            'command': command, 'exitCode': 0, 'buildTools': pins['buildTools'],
            'cargoLockSha256': sha256(manifest.with_name('Cargo.lock')),
        }, indent=2) + '\n')
        return
    built = target / 'release/mgt-flux-klein'
    runtime_output = run_dir / 'runtime'
    bin_dir = runtime_output / 'bin'
    bin_dir.mkdir(parents=True)
    binary = bin_dir / 'mgt-flux-klein'
    shutil.copy2(built, binary)
    versions = {name: subprocess.run(command, env=env, check=True, capture_output=True, text=True).stdout.strip()
                for name, command in (('rustc', ['rustc', '--version']), ('cargo', ['cargo', '--version']),
                                      ('nvcc', ['nvcc', '--version']),
                                      ('cmake', ['cmake', '--version']),
                                      ('ninja', ['ninja', '--version']))}
    identity = {
        'referenceBuildEnvironment': reference_env,
        'resume': args.resume_gcc14, 'resumeIdentity': resume_identity,
        'nvccHostCompiler': gcc_identity,
        'cargoTargetDir': str(target), 'gcc14Attempt': attempt,
        'nvccInvocationLog': str(log),
        'openssl': openssl_identity,
        'buildTools': pins['buildTools'],
        'runnerSource': pins['runnerSource'],
        'computeCap': pins['computeCap'], 'cudaVersion': pins['cudaVersion'],
        'binary': str(binary), 'bytes': binary.stat().st_size, 'sha256': sha256(binary),
        'toolchain': versions,
        'cudaArchives': [{k: a[k] for k in ('component', 'version', 'sha256')} for a in pins['archives']],
        'cargoLockSha256': sha256(here / 'mgt-flux-klein-runner/Cargo.lock'),
        'libraryDir': str(cuda / 'lib64'),
    }
    (runtime_output / 'binary-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    print(json.dumps(identity, indent=2))


if __name__ == '__main__':
    main()
