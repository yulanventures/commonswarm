"""Exercise the public checker against real, disposable Git snapshots.

Run: python3 -m unittest discover -s scripts -p 'test_file_size.py'
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('check-file-size.py').resolve()


class FileSizeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='file-size-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.env = os.environ.copy()
        # Git hooks can export repository variables; fixtures must be isolated.
        for key in subprocess.check_output(['git', 'rev-parse', '--local-env-vars'], text=True).split():
            self.env.pop(key, None)
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        self.git('init', '-q')
        self.git('config', 'user.name', 'File size fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'core.hooksPath', os.devnull)
        self.git('commit', '-qm', 'empty base', '--allow-empty')
        self.base = self.git('rev-parse', 'HEAD').strip()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, env=self.env, text=True)

    def write(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value.encode('utf-8') if isinstance(value, str) else value)

    def commit(self):
        self.git('add', '--all')
        self.git('commit', '-qm', 'fixture change')
        return self.git('rev-parse', 'HEAD').strip()

    def check(self, expected, *args, cwd=None):
        result = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd or self.root,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(expected, result.returncode, result.stdout + result.stderr)
        return result.stdout

    def test_rule_cases(self):
        # One table owns the size contract, including exact and rounded boundaries.
        cases = [
            ('new over', None, 25000, 1),
            ('new under', None, 19999, 0),
            ('exact limit', None, 20000, 0),
            ('grow past', 20000, 20001, 1),
            ('over shrinks', 25000, 24000, 0),
            ('over unchanged', 25000, 25000, 0),
            ('over grows', 25000, 26000, 1),
            ('same rounded token size', 25001, 25002, 0),
        ]
        for name, before, after, expected in cases:
            with self.subTest(name=name):
                path = name + '.txt'
                if before is not None:
                    self.write(path, 'x' * before)
                    self.commit()
                base = self.git('rev-parse', 'HEAD').strip()
                self.write(path, 'y' * after)
                self.git('add', '--all')
                output = self.check(expected, '--staged')
                if expected:
                    self.assertIn('limit 5000', output)
                    self.assertIn('new {} tokens'.format((after + 3) // 4), output)
                    self.assertIn('split this file' if before is None or before <= 20000
                                  else 'reduce it back to', output)
                # Also exercise CI's committed-snapshot mode.
                self.commit()
                self.check(expected, '--base', base)

    def test_rename(self):
        self.write('source.txt', ('abcdefghij\n' * 2400))
        base = self.commit()
        self.git('mv', 'source.txt', 'moved.txt')
        self.check(0, '--staged')
        self.write('moved.txt', ('abcdefghij\n' * 2400) + 'extra')
        self.git('add', '--all')
        output = self.check(1, '--staged')
        self.assertIn('"moved.txt": base 6600', output)
        self.commit()
        self.check(1, '--base', base)

    def test_binary_and_lockfiles(self):
        for path, blob in [('nul.bin', b'x' * 25000 + b'\0'),
                           ('invalid.bin', b'x' * 25000 + b'\xff')]:
            self.write(path, blob)
        for name in ('pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock',
                     'bun.lockb', 'poetry.lock', 'uv.lock', 'deno.lock'):
            self.write('nested/' + name, 'x' * 25000)
        self.git('add', '--all')
        self.check(0, '--staged')

    def test_ignore_patterns_and_staged_policy(self):
        self.write('.file-size-ignore', '# Generated fixture\ngenerated/**\n!generated/keep.txt\n/root.txt\n*.min.js\n')
        for path in ('generated/deep/file.txt', 'root.txt', 'nested/bundle.min.js'):
            self.write(path, 'x' * 25000)
        self.git('add', '--all')
        # An unstaged policy edit must not affect the staged check.
        self.write('.file-size-ignore', '')
        self.check(0, '--staged')
        for path in ('generated/keep.txt', 'nested/root.txt'):
            self.write(path, 'x' * 25000)
            self.git('add', path)
        output = self.check(1, '--staged')
        self.assertEqual(2, len(output.splitlines()))

    def test_subdirectory_uses_root_policy_and_inventory(self):
        self.write('.file-size-ignore', '# Generated output\nsub/ignored.txt\n')
        self.write('sub/ignored.txt', 'x' * 25000)
        self.write('sub/frozen.txt', 'x' * 24000)
        base = self.commit()
        self.write('sub/ignored.txt', 'x' * 28000)
        self.git('add', '--all')
        self.check(0, '--staged', cwd=self.root / 'sub')
        head = self.commit()
        self.check(0, '--base', base, '--head', head, cwd=self.root / 'sub')
        import json
        rows = json.loads(self.check(0, '--inventory', cwd=self.root / 'sub'))
        self.assertEqual(['sub/frozen.txt'], [row['path'] for row in rows])
        self.write('sub/handwritten.txt', 'x' * 25000)
        self.git('add', '--all')
        self.assertIn('"sub/handwritten.txt"',
                      self.check(1, '--staged', cwd=self.root / 'sub'))

    def test_text_cannot_escape_ratchet_with_binary_bytes(self):
        cases = [('invalid', b'\xff'), ('nul', b'\0')]
        for name, suffix in cases:
            with self.subTest(name=name):
                path = name + '.txt'
                self.write(path, 'x' * 25000)
                base = self.commit()
                self.write(path, b'x' * 65000 + suffix)
                self.git('add', '--all')
                output = self.check(1, '--staged')
                self.assertIn('base 6250, new 16251 tokens', output)
                self.commit()
                self.check(1, '--base', base)
                # The same decode policy still permits shrinking a text file.
                self.write(path, b'x' * 20000 + suffix)
                self.commit()
                self.check(0, '--base', base)

    @unittest.skipUnless(SCRIPT.with_name('install-hooks.sh').exists(),
                         'repo already has a hook installer')
    def test_installer_preserves_existing_executable_hooks(self):
        installer = SCRIPT.with_name('install-hooks.sh')
        self.git('config', '--unset', 'core.hooksPath')
        hooks = self.root / self.git('rev-parse', '--git-path', 'hooks').strip()
        self.write(str(hooks.relative_to(self.root) / 'example.sample'), '#!/bin/sh\n')
        (hooks / 'example.sample').chmod(0o755)
        self.write(str(hooks.relative_to(self.root) / 'README'), 'non-executable')
        result = subprocess.run(['sh', str(installer)], cwd=self.root,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('scripts/hooks', self.git('config', '--get', 'core.hooksPath').strip())
        self.git('config', '--unset', 'core.hooksPath')
        for name in ('pre-push', 'commit-msg'):
            self.write(str(hooks.relative_to(self.root) / name), '#!/bin/sh\nexit 0\n')
            (hooks / name).chmod(0o755)
        result = subprocess.run(['sh', str(installer)], cwd=self.root,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        for name in ('pre-push', 'commit-msg'):
            self.assertIn(str(hooks.relative_to(self.root) / name), result.stderr)
        self.assertNotIn('example.sample', result.stderr)
        self.assertNotIn('README', result.stderr)
        config = subprocess.run(['git', 'config', '--get', 'core.hooksPath'],
                                cwd=self.root, env=self.env, capture_output=True)
        self.assertEqual(1, config.returncode)

    def test_partial_staging(self):
        self.write('partial.txt', 'x' * 25000)
        self.git('add', '--all')
        self.write('partial.txt', 'short')
        self.check(1, '--staged')
        self.git('add', '--all')
        self.write('partial.txt', 'x' * 25000)
        self.check(0, '--staged')

    def test_unicode_counts_characters(self):
        self.write('unicode.txt', '😀' * 20000)
        self.git('add', '--all')
        self.check(0, '--staged')
        self.write('unicode.txt', '😀' * 20001)
        self.git('add', '--all')
        self.assertIn('new 5001 tokens', self.check(1, '--staged'))

    def test_delete(self):
        self.write('large.txt', 'x' * 25000)
        base = self.commit()
        self.git('rm', 'large.txt')
        self.commit()
        self.check(0, '--base', base)

    def test_merge_base_excludes_target_only_changes(self):
        self.git('branch', 'target')
        self.write('branch.txt', 'small')
        head = self.commit()
        self.git('checkout', '-q', 'target')
        self.write('target-only.txt', 'x' * 25000)
        target = self.commit()
        self.git('checkout', '-q', head)
        self.check(0, '--base', target, '--head', head, '--merge-base')

    def test_missing_base_errors(self):
        self.check(2, '--base', 'does-not-exist')

    def test_initial_commit(self):
        head = self.git('rev-parse', 'HEAD').strip()
        self.git('update-ref', '-d', 'HEAD', head)
        self.write('large.txt', 'x' * 25000)
        self.git('add', '--all')
        self.check(1, '--staged')
        self.commit()
        self.check(1, '--base', '0' * 40)


if __name__ == '__main__':
    unittest.main()
