/** CI only: legacy file and signal handlers refuse household-managed rows in the database. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import postgres from 'postgres';
import { localClusterAdminUrl } from '../support/admin-schema-db.js';
import {
  FILE_DOWNLOAD_URL_KIND,
  FILE_RESTORE_KIND,
  FILE_TOMBSTONE_KIND,
  FILE_VERSION_COMMIT_KIND,
  FILE_VERSION_CREATE_KIND,
  fileDownloadUrl,
  fileRestore,
  fileTombstone,
  fileVersionCommit,
  fileVersionCreate,
  type FileActor,
  type FileStorage,
} from '../../supabase/functions/command/file-artifacts.ts';

class RollbackProof extends Error {}

function openCluster(max: number) {
  let local: { DB_URL: string };
  try { local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { throw new Error('Local Supabase is unavailable; this proof requires the authorized CI stack.'); }
  return postgres(localClusterAdminUrl(local.DB_URL), { prepare: false, max });
}

function storage() {
  const downloads: string[] = [];
  const api: FileStorage = {
    async signUpload() { return { path: '/upload', token: 'upload-token' }; },
    async objectSize() { return 4; },
    async signDownload(path) { downloads.push(path); return '/download'; },
    async removeObjects() {},
  };
  return { api, downloads };
}

function ledger() {
  let calls = 0;
  return { calls: () => calls, fn: async () => { calls += 1; return null; } };
}

async function signalApi() {
  const bundled = await build({
    stdin: { contents: `export { resolveSignalAttachments } from './supabase/functions/command/index.ts';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `
      const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused',
        SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value' };
      const Deno = { env: { get: (name) => settings[name] }, serve: () => { throw new Error('unexpected server'); } };
      const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
      Object.defineProperty(globalThis, 'Deno', { value: Deno, configurable: true });` },
    footer: { js: `
      if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno);
      else Reflect.deleteProperty(globalThis, 'Deno');` },
    plugins: [{ name: 'inert-signal-transports', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, (args) => ({ path: args.path, namespace: 'inert-edge' }));
      builder.onLoad({ filter: /.*/, namespace: 'inert-edge' }, (args) => {
        if (args.path === 'npm:@supabase/supabase-js@2.110.8') {
          return { loader: 'js', contents: 'export function createClient() { return { auth: { async getUser() { return { error: null, data: { user: null } }; }, async getClaims() { return { error: null, data: { claims: {} } }; } } }; }' };
        }
        if (args.path === 'npm:postgres@3.4.9') {
          return { loader: 'js', contents: 'export default function postgres() { const sql = async () => []; sql.begin = async () => {}; sql.json = (value) => value; return sql; }' };
        }
        throw new Error(`unexpected edge dependency ${args.path}`);
      });
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`) as {
    resolveSignalAttachments(tx: postgres.TransactionSql<Record<string, unknown>>, route: { workspaceId: string }, refs: { file_id: string; version_n: number }[]): Promise<{ ok: true; attachments: { name: string; content_type: string; size_bytes: number }[] } | { ok: false; error: string }>;
  };
}

test('legacy file and signal handlers refuse a household-managed row and still change an ordinary file', { timeout: 120_000 }, async () => {
  const signals = await signalApi();
  const db = openCluster(1);
  const actorId = randomUUID(), workspace = randomUUID();
  const managed = randomUUID(), ordinary = randomUUID(), managedVersion = randomUUID(), ordinaryVersion = randomUUID();
  const noteFile = randomUUID(), noteVersion = randomUUID();
  const actor: FileActor = { kind: 'user', id: actorId };
  const managedPath = `${workspace}/${managed}/1`;
  const ordinaryPath = `${workspace}/${ordinary}/1`;
  const bytes = storage();
  try {
    await assert.rejects(db.begin(async (tx) => {
      await tx`INSERT INTO auth.users(id,aud,role,email) VALUES (${actorId}::uuid,'authenticated','authenticated',${`${actorId}@example.test`})`;
      await tx`INSERT INTO swarm.users(user_id,display_name) VALUES (${actorId}::uuid,'Synthetic owner')`;
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES (${workspace}::uuid,'Synthetic files',${actorId}::uuid)`;
      await tx`INSERT INTO swarm.files(file_id,workspace_id,name,created_by_kind,created_by,current_version,household_managed) VALUES
        (${managed}::uuid,${workspace}::uuid,'shared.txt','user',${actorId}::uuid,1,true),
        (${ordinary}::uuid,${workspace}::uuid,'plain.txt','user',${actorId}::uuid,1,false)`;
      await tx`INSERT INTO swarm.file_versions(version_id,file_id,workspace_id,version_n,state,size_bytes,content_type,storage_path,uploaded_by_kind,uploaded_by,committed_at) VALUES
        (${managedVersion}::uuid,${managed}::uuid,${workspace}::uuid,1,'live',4,'text/plain',${managedPath},'user',${actorId}::uuid,clock_timestamp()),
        (${ordinaryVersion}::uuid,${ordinary}::uuid,${workspace}::uuid,1,'live',4,'text/plain',${ordinaryPath},'user',${actorId}::uuid,clock_timestamp())`;
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      const refusedDownload = await fileDownloadUrl(tx, workspace, { kind: FILE_DOWNLOAD_URL_KIND, file_id: managed, version_n: null }, bytes.api);
      assert.equal(refusedDownload.ok, false);
      if (!refusedDownload.ok) assert.equal(refusedDownload.refusal.error, 'household_managed_file');
      assert.deepEqual(bytes.downloads, []);
      const downloaded = await fileDownloadUrl(tx, workspace, { kind: FILE_DOWNLOAD_URL_KIND, file_id: ordinary, version_n: null }, bytes.api);
      assert.equal(downloaded.ok, true);
      if (downloaded.ok === true) assert.equal(downloaded.body.download_path, '/download');
      assert.deepEqual(bytes.downloads, [ordinaryPath]);

      const managedTombstoneLedger = ledger();
      const refusedTombstone = await fileTombstone(tx, workspace, actor, { kind: FILE_TOMBSTONE_KIND, file_id: managed }, managedTombstoneLedger.fn);
      assert.equal(refusedTombstone.ok, false);
      if (!refusedTombstone.ok) assert.equal(refusedTombstone.refusal.error, 'household_managed_file');
      assert.equal(managedTombstoneLedger.calls(), 0);
      const [managedRow] = await tx<{ tombstoned_at: Date | null; household_managed: boolean }[]>`SELECT tombstoned_at, household_managed FROM swarm.files WHERE file_id=${managed}::uuid`;
      assert.equal(managedRow?.tombstoned_at, null);
      assert.equal(managedRow?.household_managed, true);
      const ordinaryTombstoneLedger = ledger();
      const tombstoned = await fileTombstone(tx, workspace, actor, { kind: FILE_TOMBSTONE_KIND, file_id: ordinary }, ordinaryTombstoneLedger.fn);
      assert.equal(tombstoned.ok, true);
      const [tombstoneRow] = await tx<{ tombstoned_at: Date | null }[]>`SELECT tombstoned_at FROM swarm.files WHERE file_id=${ordinary}::uuid`;
      assert.ok(tombstoneRow?.tombstoned_at !== null);
      const hidden = await fileDownloadUrl(tx, workspace, { kind: FILE_DOWNLOAD_URL_KIND, file_id: ordinary, version_n: null }, bytes.api);
      assert.equal(hidden.ok, false);
      if (!hidden.ok) assert.equal(hidden.refusal.error, 'file_tombstoned');

      const managedRestoreLedger = ledger();
      const refusedRestore = await fileRestore(tx, workspace, actor, { kind: FILE_RESTORE_KIND, file_id: managed }, managedRestoreLedger.fn);
      assert.equal(refusedRestore.ok, false);
      if (!refusedRestore.ok) assert.equal(refusedRestore.refusal.error, 'household_managed_file');
      assert.equal(managedRestoreLedger.calls(), 0);
      const ordinaryRestoreLedger = ledger();
      const restored = await fileRestore(tx, workspace, actor, { kind: FILE_RESTORE_KIND, file_id: ordinary }, ordinaryRestoreLedger.fn);
      assert.equal(restored.ok, true);
      const [restoredRow] = await tx<{ tombstoned_at: Date | null }[]>`SELECT tombstoned_at FROM swarm.files WHERE file_id=${ordinary}::uuid`;
      assert.equal(restoredRow?.tombstoned_at, null);
      const again = await fileDownloadUrl(tx, workspace, { kind: FILE_DOWNLOAD_URL_KIND, file_id: ordinary, version_n: null }, bytes.api);
      assert.equal(again.ok, true);

      const refusedCreate = await fileVersionCreate(tx, workspace, actor, {
        kind: FILE_VERSION_CREATE_KIND, file_id: randomUUID(), version_id: randomUUID(),
        name: 'shared.txt', declared_size_bytes: 4, content_type: 'text/plain', if_version: null,
      }, bytes.api, ledger().fn);
      assert.equal(refusedCreate.ok, false);
      if (!refusedCreate.ok) assert.equal(refusedCreate.refusal.error, 'household_managed_file');
      const [managedVersions] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm.file_versions WHERE file_id=${managed}::uuid`;
      assert.equal(Number(managedVersions?.count), 1);
      const created = await fileVersionCreate(tx, workspace, actor, {
        kind: FILE_VERSION_CREATE_KIND, file_id: noteFile, version_id: noteVersion,
        name: 'note.txt', declared_size_bytes: 4, content_type: 'text/plain', if_version: null,
      }, bytes.api, ledger().fn);
      assert.equal(created.ok, true);
      if (created.ok === true) assert.equal(created.body.version_n, 1);
      const [note] = await tx<{ household_managed: boolean; state: string }[]>`SELECT f.household_managed, v.state FROM swarm.files f JOIN swarm.file_versions v USING (file_id, workspace_id) WHERE f.file_id=${noteFile}::uuid`;
      assert.equal(note?.household_managed, false);
      assert.equal(note?.state, 'pending');
      const committed = await fileVersionCommit(tx, workspace, actor, {
        kind: FILE_VERSION_COMMIT_KIND, file_id: noteFile, version_id: noteVersion, sha256: null,
      }, bytes.api, ledger().fn);
      assert.equal(committed.ok, true);
      if (committed.ok === true) assert.equal(committed.body.size_bytes, 4);
      const [liveNote] = await tx<{ state: string; current_version: number }[]>`SELECT v.state, f.current_version FROM swarm.files f JOIN swarm.file_versions v USING (file_id, workspace_id) WHERE v.version_id=${noteVersion}::uuid`;
      assert.equal(liveNote?.state, 'live');
      assert.equal(Number(liveNote?.current_version), 1);
      const managedCommitLedger = ledger();
      const refusedCommit = await fileVersionCommit(tx, workspace, actor, {
        kind: FILE_VERSION_COMMIT_KIND, file_id: managed, version_id: managedVersion, sha256: null,
      }, bytes.api, managedCommitLedger.fn);
      assert.equal(refusedCommit.ok, false);
      if (!refusedCommit.ok) assert.equal(refusedCommit.refusal.error, 'household_managed_file');
      assert.equal(managedCommitLedger.calls(), 0);
      const [managedVersionRow] = await tx<{ state: string }[]>`SELECT state FROM swarm.file_versions WHERE version_id=${managedVersion}::uuid`;
      assert.equal(managedVersionRow?.state, 'live');

      const route = { workspaceId: workspace };
      const refusedSignal = await signals.resolveSignalAttachments(tx, route, [{ file_id: managed, version_n: 1 }]);
      assert.equal(refusedSignal.ok, false);
      if (!refusedSignal.ok) assert.equal(refusedSignal.error, 'household_managed_file');
      const posted = await signals.resolveSignalAttachments(tx, route, [{ file_id: ordinary, version_n: 1 }]);
      assert.equal(posted.ok, true);
      if (posted.ok) {
        assert.equal(posted.attachments[0]?.name, 'plain.txt');
        assert.equal(posted.attachments[0]?.content_type, 'text/plain');
        assert.equal(posted.attachments[0]?.size_bytes, 4);
      }
      throw new RollbackProof();
    }), RollbackProof);
  } finally {
    await db.end();
  }
});
