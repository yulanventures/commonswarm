"""Exercise the real shell verifier with a fake database transport. No DB access."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

class CountsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.scripts=self.root/'scripts';self.scripts.mkdir();self.art=self.root/'art';self.art.mkdir()
        for name in ('verify-counts.sh','verify-post-upgrade-counts.sh'):
            shutil.copyfile(Path(__file__).with_name(name),self.scripts/name)
        self.baseline='auth.users|1\nstorage.objects|3\nswarm.agent_tokens|2\n'
        self.actual=self.baseline+'swarm.agent_join_attempts|0\nswarm.agent_join_credentials|0\nswarm.h0_poll_batches|0\nswarm.h0_poll_locks|0\n'
        (self.art/'source-counts.tsv').write_text(self.baseline);(self.art/'cron-jobs.ndjson').write_text('{"jobname":"test"}\n')
        (self.root/'counts').write_text(self.actual);(self.root/'names').write_text(''.join(l.split('|')[0]+'\n' for l in self.actual.splitlines()))
        (self.root/'cron').write_text('{"jobname":"test"}\n')
        (self.scripts/'lib.sh').write_text('''
require_commands() { :; }
require_vars() { for name in "$@"; do [[ -n "${!name:-}" ]] || return 1; done; }
start_log() { mkdir -p "$MIGRATION_ARTIFACT_DIR/logs"; LOG_FILE="$MIGRATION_ARTIFACT_DIR/logs/test.log"; }
log() { echo "$*" >>"$LOG_FILE"; }
assert_target_identity() { echo guard >>"$TEST_ROOT/calls"; [[ "${TEST_IDENTITY_OK:-1}" == 1 ]]; }
make_temp_sql() { mktemp "$TEST_ROOT/query.XXXXXX"; }
target_psql() { echo names >>"$TEST_ROOT/calls"; cat "$TEST_ROOT/names"; }
cron_jobs_json_sql() { echo CRON_QUERY; }
database_psql() {
  echo query >>"$TEST_ROOT/calls"
  local file="${@: -1}"
  if [[ "$(cat "$file")" == CRON_QUERY ]]; then cat "$TEST_ROOT/cron"; else cat "$TEST_ROOT/counts"; fi
}
compare_cron_job_listings() { cmp -s "$1" "$2"; }
''')
        self.env={**os.environ,'TEST_ROOT':str(self.root),'MIGRATION_ARTIFACT_DIR':str(self.art),'TARGET_DATABASE_URL':'owned-fake-transport'}
    def tearDown(self):self.temp.cleanup()
    def run_check(self,*args):
        return subprocess.run(['bash',str(self.scripts/'verify-post-upgrade-counts.sh'),*args],env=self.env,capture_output=True,text=True)
    def test_fresh_upgrade_preserves_baseline(self):
        self.assertEqual(self.run_check('target').returncode,0)
        self.assertEqual((self.art/'source-counts.tsv').read_text(),self.baseline)
        derived=list(self.art.glob('h0-expected.*/source-counts.tsv'));self.assertEqual(len(derived),1)
        self.assertEqual(derived[0].read_text(),self.actual)
    def test_recovery_keeps_existing_h0_counts(self):
        text=self.actual.replace('attempts|0','attempts|4').replace('credentials|0','credentials|2')
        (self.art/'source-counts.tsv').write_text(text);(self.root/'counts').write_text(text)
        self.assertEqual(self.run_check().returncode,0)
    def test_new_table_with_rows_fails(self):
        (self.root/'counts').write_text(self.actual.replace('attempts|0','attempts|1'))
        self.assertNotEqual(self.run_check().returncode,0)
    def test_baseline_row_change_fails(self):
        (self.root/'counts').write_text(self.actual.replace('users|1','users|2'))
        self.assertNotEqual(self.run_check().returncode,0)
    def test_cron_change_fails(self):
        (self.root/'cron').write_text('{"jobname":"different"}\n')
        self.assertNotEqual(self.run_check().returncode,0)
    def test_extra_table_fails(self):
        with (self.root/'names').open('a') as f:f.write('swarm.unexpected\n')
        self.assertNotEqual(self.run_check().returncode,0)
    def test_missing_table_fails(self):
        (self.root/'names').write_text('auth.users\nstorage.objects\n')
        self.assertNotEqual(self.run_check().returncode,0)
    def test_partial_h0_baseline_fails(self):
        with (self.art/'source-counts.tsv').open('a') as f:f.write('swarm.agent_join_credentials|0\n')
        self.assertNotEqual(self.run_check().returncode,0)
    def test_source_rejected_before_any_guard_or_database(self):
        r=self.run_check('source');self.assertEqual(r.returncode,64)
        self.assertFalse((self.root/'calls').exists())
    def test_bad_target_identity_stops_before_queries(self):
        self.env['TEST_IDENTITY_OK']='0';self.assertNotEqual(self.run_check().returncode,0)
        self.assertEqual((self.root/'calls').read_text(),'guard\n')
    def test_duplicate_baseline_fails(self):
        with (self.art/'source-counts.tsv').open('a') as f:f.write('auth.users|1\n')
        self.assertNotEqual(self.run_check().returncode,0)
    def test_target_order_preserved_without_dropping_tables(self):
        text='\n'.join(reversed(self.actual.splitlines()))+'\n';(self.root/'counts').write_text(text)
        (self.root/'names').write_text(''.join(l.split('|')[0]+'\n' for l in text.splitlines()))
        self.assertEqual(self.run_check().returncode,0)
if __name__=='__main__':unittest.main()
