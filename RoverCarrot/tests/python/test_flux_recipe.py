"""CUDA layout assembly regression tests (temporary files, no network)."""
import importlib.util
import json
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest
import zipfile

MODULE = Path(__file__).resolve().parents[2] / 'runtime/flux/build.py'
SPEC = importlib.util.spec_from_file_location('flux_recipe', MODULE)
RECIPE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECIPE)


class CudaAssemblyTests(unittest.TestCase):
    def component_file(self, redist, component, path, data=b'fixture'):
        file = redist / component / 'archive' / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        return file

    def test_recursive_merge_migrates_old_links_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            redist, cuda = root / 'redist', root / 'cuda'
            files = [
                self.component_file(redist, 'a', 'lib/stubs/liba.so'),
                self.component_file(redist, 'b', 'lib64/stubs/libb.so'),
                self.component_file(redist, 'a', 'include/shared/deep/a.h'),
                self.component_file(redist, 'b', 'include/shared/deep/b.h'),
                self.component_file(redist, 'a', 'bin/nvcc'),
                self.component_file(redist, 'a', 'nvvm/libdevice/device.bc'),
            ]
            cuda.mkdir()
            (cuda / 'include').symlink_to(redist / 'a/archive/include')
            (cuda / 'lib64').mkdir()
            (cuda / 'lib64/stubs').symlink_to(redist / 'a/archive/lib/stubs')
            before = {file: file.read_bytes() for file in files}
            for _ in range(2):
                RECIPE.assemble_cuda(redist, cuda)
                for file in files:
                    archive = redist / file.relative_to(redist).parts[0] / 'archive'
                    relative = file.relative_to(archive)
                    if relative.parts[0] == 'lib':
                        relative = Path('lib64', *relative.parts[1:])
                    link = cuda / relative
                    self.assertTrue(link.is_symlink())
                    self.assertEqual(link.resolve(), file.resolve())
                    for parent in link.parents:
                        if parent == cuda:
                            break
                        self.assertFalse(parent.is_symlink())
                self.assertEqual((cuda / 'lib').readlink(), Path('lib64'))
                self.assertEqual(before, {file: file.read_bytes() for file in files})

    def test_different_files_at_same_path_collide_even_with_same_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            redist, cuda = root / 'redist', root / 'cuda'
            first = self.component_file(redist, 'a', 'lib/stubs/shared.so')
            second = self.component_file(redist, 'b', 'lib/stubs/shared.so')
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, 'CUDA layout collision:'):
                    RECIPE.assemble_cuda(redist, cuda)
                self.assertEqual((cuda / 'lib64/stubs/shared.so').resolve(), first)
                self.assertEqual(second.read_bytes(), b'fixture')

    def test_file_directory_collision_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            redist, cuda = root / 'redist', root / 'cuda'
            self.component_file(redist, 'a', 'include/shared')
            self.component_file(redist, 'b', 'include/shared/header.h')
            with self.assertRaisesRegex(RuntimeError, 'CUDA layout collision:'):
                RECIPE.assemble_cuda(redist, cuda)


class BuildToolRecipeTests(unittest.TestCase):
    def test_pins_match_step4(self):
        flux = json.loads(MODULE.with_name('pins.json').read_text())['buildTools']
        llama = json.loads((MODULE.parent.parent / 'llama/pins.json').read_text())['wheels']
        self.assertEqual(flux, [pin for pin in llama if pin['package'] in ('cmake', 'ninja')])
        self.assertEqual([(pin['package'], pin['version']) for pin in flux],
                         [('cmake', '4.3.4'), ('ninja', '1.13.2')])

    def test_wheel_extraction_reuse_and_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pins = []
            for package, name in (('cmake', 'cmake/data/bin/cmake'),
                                  ('ninja', 'ninja-1.13.2.data/scripts/ninja')):
                wheel = root / (package + '.whl')
                with zipfile.ZipFile(wheel, 'w') as archive:
                    archive.writestr(name, b'fixture executable')
                pins.append({'package': package, 'version': '1.13.2', 'file': wheel.name,
                             'url': 'unused', 'bytes': wheel.stat().st_size,
                             'sha256': RECIPE.sha256(wheel)})
            for _ in range(2):
                bins = RECIPE.provision_build_tools(pins, root, root)
                for path, name in zip(bins, ('cmake', 'ninja')):
                    self.assertEqual((path / name).read_bytes(), b'fixture executable')
                    self.assertTrue((path / name).stat().st_mode & 0o111)
            original = {'PATH': '/host/bin', 'LD_LIBRARY_PATH': '/host/lib'}
            env = RECIPE.build_environment(original, root, root / 'cuda', root / 'openssl',
                                           {'computeCap': '120'}, 16, bins)
            self.assertEqual(env['PATH'].split(':')[:4],
                             [str(root / 'cargo/bin'), *(str(p) for p in bins), str(root / 'cuda/bin')])
            for key, relative in (('CARGO_HOME', 'cargo'), ('RUSTUP_HOME', 'rustup'),
                                  ('CARGO_TARGET_DIR', 'target-gcc14'), ('OPENSSL_DIR', 'openssl')):
                self.assertEqual(env[key], str(root / relative))
            self.assertEqual(env['CUDA_HOME'], str(root / 'cuda'))
            self.assertEqual(env['OPENSSL_STATIC'], '1')
            self.assertEqual(env['CARGO_BUILD_JOBS'], '16')
            self.assertEqual(original['PATH'], '/host/bin')
            (bins[0] / 'cmake').write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'differs from pin'):
                RECIPE.provision_build_tools(pins, root, root)

    def test_reference_environment_preserves_flags_and_remaps_existing_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, home, cargo = root / 'runner', root / 'home', root / 'cargo'
            for path in (source, home / '.cargo', cargo):
                path.mkdir(parents=True)
            env = {'HOME': str(home), 'CARGO_HOME': str(cargo),
                   'RUSTFLAGS': '-C debuginfo=0', 'CUDA_HOME': str(root / 'cuda')}
            identity = RECIPE.reference_environment(env, source)
            self.assertEqual(env['LLAMA_CPP_TAG'], 'b-mgt-unused')
            self.assertEqual(env['RUSTFLAGS'], '-C debuginfo=0 ' + ' '.join(
                f'--remap-path-prefix={path}={placeholder}' for path, placeholder in
                ((source, '<mgt-source>'), (home, '<build-home>'),
                 (cargo, '<cargo-home>'), (home / '.cargo', '<cargo-home>'))))
            self.assertNotIn(directory, json.dumps(identity))
            self.assertEqual(identity['CUDA_HOME'], '<cuda-root>')
            env = {'HOME': str(root / 'missing'), 'CARGO_HOME': str(root / 'missing-cargo')}
            RECIPE.reference_environment(env, root / 'missing-source')
            self.assertEqual(env['RUSTFLAGS'], '')

    def test_native_selection_keeps_runner_features_unchanged(self):
        manifest = Path('/fixture/Cargo.toml')
        full = RECIPE.cargo_command(manifest)
        self.assertEqual(full, ['cargo', 'build', '--release', '--locked', '-vv',
                                '--manifest-path', str(manifest)])
        native = RECIPE.cargo_command(manifest, True)
        self.assertEqual(native[:len(full)], full)
        self.assertEqual([native[i + 1] for i, value in enumerate(native) if value == '-p'],
                         list(RECIPE.NATIVE_PACKAGES))
        self.assertNotIn('--no-default-features', native)
        self.assertNotIn('--features', native)
        self.assertNotIn('candle', ' '.join(native))


class OpenSSLRecipeTests(unittest.TestCase):
    def test_pin_build_and_verified_reuse(self):
        pin = json.loads(MODULE.with_name('pins.json').read_text())['openssl']
        self.assertEqual(pin['version'], '3.5.5')
        self.assertEqual(pin['bytes'], 53104821)
        self.assertEqual(pin['sha256'], 'b28c91532a8b65a1f983b4c28b7488174e4a01008e29ce8e69bd789f28bc2a89')
        self.assertEqual(pin['url'], 'https://github.com/openssl/openssl/releases/download/openssl-3.5.5/openssl-3.5.5.tar.gz')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefix = root / 'openssl-3.5.5'

            def run(command, **kwargs):
                if command == ['make', 'install_sw']:
                    for name in ('lib/libssl.a', 'lib/libcrypto.a', 'include/openssl/ssl.h'):
                        path = prefix / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(b'fixture')

            with patch.object(RECIPE, 'verified_download') as download, \
                    patch.object(RECIPE, 'extract_archive'), \
                    patch.object(RECIPE.subprocess, 'run', side_effect=run) as execute:
                result, identity = RECIPE.provision_openssl(pin, root, root, 2)
                self.assertEqual(result, prefix)
                self.assertEqual(identity, pin)
                download.assert_called_with(pin['url'], root / 'openssl-3.5.5.tar.gz', pin['sha256'], pin['bytes'])
                self.assertEqual(execute.call_args_list[0].args[0],
                                 ['perl', 'Configure', *pin['configureOptions'],
                                  f'--prefix={prefix}', f'--openssldir={prefix / "ssl"}'])
                self.assertEqual(execute.call_args_list[1].args[0], ['make', '-j2'])
                execute.reset_mock()
                RECIPE.provision_openssl(pin, root, root, 2)
                execute.assert_not_called()
                (prefix / 'lib/libssl.a').write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, 'verification mismatch'):
                    RECIPE.provision_openssl(pin, root, root, 2)
                execute.assert_not_called()

    def test_source_integrity_rejects_wrong_size_and_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'source.tar.gz'
            archive.write_bytes(b'fixture')
            for digest, size in ((RECIPE.sha256(archive), 1), ('0' * 64, 7)):
                with self.assertRaisesRegex(RuntimeError, 'Integrity mismatch'):
                    RECIPE.verified_download('unused', archive, digest, size)


class Gcc14RecipeTests(unittest.TestCase):
    def test_conda_pins_have_exact_official_identities(self):
        pin = json.loads(MODULE.with_name('pins.json').read_text())['nvccHostCompiler']
        self.assertEqual((pin['provider'], pin['version']), ('conda-forge', '14.3.0'))
        names = {p['name'] for p in pin['packages']}
        self.assertTrue({'gcc_impl_linux-64', 'gxx_impl_linux-64', 'sysroot_linux-64',
                         'libgcc-devel_linux-64', 'libstdcxx-devel_linux-64'} <= names)
        for package in pin['packages']:
            self.assertEqual(package['file'], f"{package['name']}-{package['version']}-{package['build']}.conda")
            self.assertEqual(package['url'], f"https://conda.anaconda.org/conda-forge/{package['subdir']}/{package['file']}")
            self.assertRegex(package['sha256'], r'^[0-9a-f]{64}$')
            self.assertGreater(package['bytes'], 0)

    def test_nvcc_scope_and_inherited_conflicts(self):
        original = {'PATH': '/usr/bin', 'CC': '/usr/bin/gcc', 'CXX': '/usr/bin/g++'}
        host = Path('/fixture/g++')
        env = RECIPE.nvcc_environment(original, host)
        self.assertEqual(env['NVCC_PREPEND_FLAGS'], '-ccbin /fixture/g++')
        self.assertEqual({key: env[key] for key in original}, original)
        self.assertNotIn('NVCC_CCBIN', env)
        for key in ('NVCC_CCBIN', 'NVCC_PREPEND_FLAGS', 'NVCC_APPEND_FLAGS',
                    'CUDAHOSTCXX', 'NVCCFLAGS', 'NVCC_FLAGS', 'CUDA_NVCC_FLAGS'):
            with self.assertRaisesRegex(RuntimeError, 'Conflicting inherited'):
                RECIPE.nvcc_environment({**original, key: ''}, host)

    def test_fresh_target_and_exact_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target-gcc14'
            attempt = {'id': 'fixture', 'cargoLockSha256': 'locked', 'recipeSha256': 'recipe'}
            with self.assertRaisesRegex(RuntimeError, 'same recorded'):
                RECIPE.prepare_target(target, attempt, True)
            RECIPE.prepare_target(target, attempt)
            output = target / 'keep.o'
            output.write_bytes(b'preserved')
            with self.assertRaisesRegex(RuntimeError, 'non-empty'):
                RECIPE.prepare_target(target, attempt)
            RECIPE.prepare_target(target, attempt, True)
            with self.assertRaisesRegex(RuntimeError, 'same recorded'):
                RECIPE.prepare_target(target, {**attempt, 'cargoLockSha256': 'changed'}, True)
            self.assertEqual(output.read_bytes(), b'preserved')
            linked = Path(directory) / 'linked'
            linked.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                RECIPE.prepare_target(linked, attempt, True)

    def test_reference_completion_resume_is_limited_to_known_predecessor(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target-gcc14'
            previous = {'id': 'flux-sm120-gcc14', 'cargoLockSha256': 'locked',
                        'recipeSha256': RECIPE.REFERENCE_ENV_PREDECESSOR,
                        'nvccHostCompiler': {'version': '14.3.0'}}
            RECIPE.prepare_target(target, previous)
            marker = target / '.gcc14-attempt.json'
            before = marker.read_bytes()
            output = target / 'keep.o'
            output.write_bytes(b'preserved')
            attempt = {**previous, 'recipeSha256': 'completed-recipe'}
            receipt = RECIPE.prepare_target(target, attempt, True)
            self.assertTrue(receipt['referenceEnvironmentCompleted'])
            self.assertEqual(receipt['previousRecipeSha256'], RECIPE.REFERENCE_ENV_PREDECESSOR)
            for key, value in (('cargoLockSha256', 'changed'),
                               ('nvccHostCompiler', {'version': '15'})):
                with self.assertRaisesRegex(RuntimeError, 'same recorded'):
                    RECIPE.prepare_target(target, {**attempt, key: value}, True)
            marker.write_text(json.dumps({**previous, 'recipeSha256': 'unknown'}))
            with self.assertRaisesRegex(RuntimeError, 'same recorded'):
                RECIPE.prepare_target(target, attempt, True)
            marker.write_bytes(before)
            self.assertEqual(output.read_bytes(), b'preserved')
            self.assertEqual(marker.read_bytes(), before)

    def test_launcher_records_captured_commands_and_refuses_bypass(self):
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / 'real-nvcc'
            real.write_text(f'#!{sys.executable}\nimport sys\nprint("fake nvcc", sys.argv[1:])\n')
            real.chmod(0o755)
            log = root / 'invocations.jsonl'
            host = root / 'prefix/bin/g++'
            env = RECIPE.nvcc_environment({}, host)
            launcher = RECIPE.nvcc_launcher(root / 'bin', real, host, log) / 'nvcc'
            env['PATH'] = os.environ['PATH']
            result = subprocess.run([str(launcher), '--ptx', 'fixture.cu'], env=env,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            entry = json.loads(log.read_text())
            self.assertEqual(entry['argv'], ['--ptx', 'fixture.cu'])
            self.assertEqual(entry['hostCompiler'], str(host))
            before = log.read_bytes()
            for flags in (['-allow-unsupported-compiler'], ['--allow-unsupported-compiler'],
                          ['-ccbin', '/system/g++'], ['--compiler-bindir=/system']):
                result = subprocess.run([str(launcher), *flags], env=env, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
            result = subprocess.run([str(launcher), '--ptx'], env={**env, 'NVCC_CCBIN': ''}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(log.read_bytes(), before)

    def test_conda_extraction_verified_reuse_and_tamper(self):
        import io
        import tarfile
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            downloads = root / 'gcc14-conda/downloads'
            downloads.mkdir(parents=True)
            payload = io.BytesIO()
            with tarfile.open(fileobj=payload, mode='w') as archive:
                for name in ('bin/x86_64-conda-linux-gnu-gcc', 'bin/x86_64-conda-linux-gnu-g++'):
                    member = tarfile.TarInfo(name)
                    member.size, member.mode = 7, 0o755
                    archive.addfile(member, io.BytesIO(b'fixture'))
            package = downloads / 'fixture.conda'
            with zipfile.ZipFile(package, 'w') as archive:
                archive.writestr('pkg-fixture.tar.zst', payload.getvalue())
            pin = {'provider': 'conda-forge', 'version': '14.3.0', 'packages': [
                {'url': 'unused', 'file': package.name, 'bytes': package.stat().st_size,
                 'sha256': RECIPE.sha256(package)}]}
            with patch.object(RECIPE, 'decompress_zstd', side_effect=lambda b: b), \
                    patch.object(RECIPE.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
                    patch.object(RECIPE.subprocess, 'check_output', return_value='14.3.0\n'):
                gcc, gxx = RECIPE.provision_gcc(pin, root)
                self.assertEqual(gcc.read_bytes(), b'fixture')
                RECIPE.provision_gcc(pin, root)
                gxx.write_bytes(b'tampered')
                with self.assertRaisesRegex(RuntimeError, 'verification mismatch'):
                    RECIPE.provision_gcc(pin, root)


if __name__ == '__main__':
    unittest.main()
