import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('upload_snapshot', Path(__file__).with_name('upload-snapshot.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UploadFailures(unittest.TestCase):
    def exercise(self, failure=None):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = root / 'artifact'
            artifact.mkdir(mode=0o700)
            for name in module.FILES:
                (artifact / name).write_text('synthetic\n')
                (artifact / name).chmod(0o600)
            (artifact / 'manifest.txt').write_text('format=commonswarm-n-db-v2\n')
            (artifact / 'source-counts.tsv').write_text('storage.objects|2\n')
            rows = [{'bucket': 'swarm-files', 'name': name, 'version': 'version'} for name in ['a', 'b']]
            keys = module.physical_keys(rows)
            (artifact / 'storage-backend-objects.ndjson').write_text(''.join(json.dumps(row) + '\n' for row in rows))
            (artifact / 'SHA256SUMS').write_text(''.join(hashlib.sha256((artifact / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in module.FILES))
            env = root / 'env'
            env.write_text('TENANT_ID=commonswarm\nSTORAGE_S3_BUCKET=commonswarm-files\nSTORAGE_S3_ENDPOINT=https://invalid.test\nAWS_ACCESS_KEY_ID=synthetic\nAWS_SECRET_ACCESS_KEY=synthetic\n')
            env.chmod(0o600)
            evidence = root / 'evidence.json'
            evidence.write_text(json.dumps({'publicDisabled': True, 'path': '/accounts/test/buckets/yulan-vps-1-backups/settings', 'rules': 'Delete objects after 35 day(s)\nEnabled', 'observed_at': '2026-09-18T00:13:29Z'}))
            calls = []

            def fake_run(args, **kwargs):
                calls.append(args)
                output = ''
                code = 0
                if args[0] == 'sha256sum':
                    pass
                elif args[1] == 'lsf':
                    if args[2] == module.ROOT:
                        output = '20260917T031501Z/\n'
                    else:
                        output = '\n'.join(keys[:-1] if failure == 'missing-object' else keys) + '\n'
                elif args[1] == 'check' and args[2].startswith('csfiles:'):
                    self.assertIn('--download', args)
                    code = 1 if failure == 'corrupt-object' else 0
                elif args[1] == 'check' and args[2] == str(artifact):
                    self.assertIn('--download', args)
                    code = 1 if failure == 'partial-database' else 0
                elif args[1] == 'cat':
                    output = '{}' if failure == 'wrong-marker' else (artifact / 'COMPLETE.json').read_text()
                return subprocess.CompletedProcess(args, code, stdout=output, stderr='')

            with patch.dict(os.environ, {'COMMONSWARM_ENV_FILE': str(env)}), patch.object(module.subprocess, 'run', fake_run):
                if failure:
                    with self.assertRaises(RuntimeError):
                        module.upload(artifact, evidence)
                else:
                    result = module.upload(artifact, evidence)
                    self.assertEqual(result['objects'], 2)
                    self.assertTrue(result['database_bytes_verified'])
                    self.assertTrue(result['object_bytes_verified'])
            marker_writes = [args for args in calls if len(args) > 1 and args[1] == 'copyto']
            self.assertEqual(len(marker_writes), 1 if failure in (None, 'wrong-marker') else 0)
            self.assertFalse(any(args[1] in ('delete', 'purge', 'sync', 'move') for args in calls))

    def test_complete_backup_checks_both_streams(self): self.exercise()
    def test_missing_from_both_source_and_destination_is_not_success(self): self.exercise('missing-object')
    def test_corrupt_object_cannot_publish_completion(self): self.exercise('corrupt-object')
    def test_partial_database_cannot_publish_completion(self): self.exercise('partial-database')
    def test_bad_remote_marker_cannot_report_success(self): self.exercise('wrong-marker')


if __name__ == '__main__': unittest.main()
