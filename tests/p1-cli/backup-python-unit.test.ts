import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BACKUP_DIR = new URL("../../deploy/supabase-stack/backup/", import.meta.url).pathname;
const PYTHON_TESTS = ["test_restore_drill.py", "test_upload_snapshot.py", "test_notify_healthcheck.py"];

// `python -I` leaves the current directory off sys.path, so run from an empty temporary
// directory and let unittest discover each file by pattern in the backup directory.
for (const file of PYTHON_TESTS) {
  test(`backup python unit tests pass: ${file}`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "backup-python-unit-"));
    try {
      const run = spawnSync(
        "python3",
        ["-I", "-m", "unittest", "discover", "-s", BACKUP_DIR, "-p", file],
        { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
      );
      const lines = run.stderr.split("\n").filter((l) => /^(Ran \d+ tests?|OK|FAILED)/.test(l));
      assert.equal(run.status, 0, `${file}: ${lines.join(" ")}`);
      assert.match(run.stderr, /^Ran [1-9]\d* tests? in /m, `${file}: ran no tests`);
      console.log(`${file}: ${lines.join(" ")}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
