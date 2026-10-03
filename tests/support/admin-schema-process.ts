/** SQL subprocess boundary: retain child failures without exposing SQL or rows. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function sqlPhase(label: string, sql: string): string {
  assert.match(label, /^[a-z0-9_.-]{1,100}$/);
  return `\\warn admin-schema-phase: ${label}\n${sql}\n`;
}

export function assertSqlProcessResult(result: SpawnSyncReturns<string>): void {
  if (!result.error && result.status === 0) return;
  const stderr = result.stderr ?? '';
  const phase = [...stderr.matchAll(/^admin-schema-phase: ([a-z0-9_.-]{1,100})$/gm)].at(-1)?.[1] ?? 'unknown';
  const errors = [...stderr.matchAll(/^(?:psql:[^\r\n]*?:(\d+):\s*)?ERROR:\s+([A-Z0-9]{5}):\s*([^\r\n]*)/gm)].map(([, line, state, message]) => {
    // Only fixed error text leaves the harness. DETAIL/CONTEXT/LINE, quoted
    // values, arbitrary exception messages and stdout may contain row data.
    const safe = message!.match(/^(?:permission denied for (?:database|schema|table|function|type|relation|sequence)|must be owner of (?:database|schema|table|function|type|relation|sequence)|must be able to SET ROLE|duplicate key value violates unique constraint|syntax error|unsafe admin policy role|unsafe admin issuer role|duplicate admin issuer membership|migration principal must be able to read the live ledger)\b/)?.[0] ?? 'SQL error text withheld';
    return `ERROR: ${state}: ${safe}${line ? ` (input line ${line})` : ''}`;
  });
  const code = result.error && 'code' in result.error && typeof result.error.code === 'string'
    && /^[A-Z0-9_]+$/.test(result.error.code) ? result.error.code : result.error ? 'spawn_error' : 'none';
  assert.fail(`SQL child failed: phase=${phase} exit_status=${result.status} signal=${result.signal} spawn_code=${code}\n`
    + `safe stderr:\n${errors.slice(-4).join('\n') || 'no SQL error captured'}`);
}

export function runSqlProcess(command: string, args: string[], sql: string): void {
  const directory = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'admin-schema-sql-'));
  let fd: number | undefined;
  try {
    const path = join(directory, 'input.sql');
    writeFileSync(path, sql, { mode: 0o600 });
    fd = openSync(path, 'r');
    // A file descriptor keeps the same stdin/psql transaction semantics, but
    // Node has no large pipe write to fail with EPIPE when psql exits early.
    const result = spawnSync(command, args, { stdio: [fd, 'pipe', 'pipe'],
      encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    assertSqlProcessResult(result);
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Use the PATH-resolved rm guard; a refused cleanup must fail visibly.
    execFileSync('rm', ['-rf', directory]);
  }
}
