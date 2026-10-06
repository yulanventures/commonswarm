/** Legacy file and signal paths refuse Lists & docs rows and still serve ordinary files. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
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
} from '../supabase/functions/command/file-artifacts.ts';

const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actor: FileActor = { kind: 'user', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };

function scripted(rows: unknown[][]) {
  const queries: string[] = [];
  let n = 0;
  const tx = (strings: TemplateStringsArray) => {
    queries.push(strings.join(' '));
    const page = rows[n];
    n += 1;
    if (page === undefined) {
      return Promise.reject(new Error(`unexpected query: ${queries.at(-1)?.slice(0, 160)}`));
    }
    return Promise.resolve(page);
  };
  return { tx: tx as never, queries };
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
  const fn = async () => {
    calls += 1;
    return null;
  };
  return { fn, get calls() { return calls; } };
}

function refusal(result: { ok: false | true | 'replay'; refusal?: { error: string; message: string } }): { error: string; message: string } {
  assert.equal(result.ok, false);
  if (result.ok !== false) throw new Error('expected a refusal');
  return result.refusal!;
}

test('download, tombstone, restore, commit and name lookup refuse a household-managed file before any byte change', async () => {
  const managed = { household_managed: true, tombstoned_at: new Date('2026-10-01T00:00:00Z') };
  const download = scripted([[managed]]);
  const downloads = storage();
  const downloaded = await fileDownloadUrl(download.tx, workspace, {
    kind: FILE_DOWNLOAD_URL_KIND, file_id: fileId, version_n: null,
  }, downloads.api);
  assert.equal(refusal(downloaded).error, 'household_managed_file');
  assert.match(refusal(downloaded).message, /Nothing was changed\.$/);
  assert.equal(download.queries.length, 1);
  assert.deepEqual(downloads.downloads, []);

  const tombstoneLedger = ledger();
  const tombstone = scripted([[{
    name: 'note.txt', ...managed, created_by: actor.id, created_by_kind: 'user',
  }]]);
  const tombstoned = await fileTombstone(tombstone.tx, workspace, actor, {
    kind: FILE_TOMBSTONE_KIND, file_id: fileId,
  }, tombstoneLedger.fn);
  assert.equal(refusal(tombstoned).error, 'household_managed_file');
  assert.equal(tombstoneLedger.calls, 0);
  assert.equal(tombstone.queries.some((query) => /UPDATE swarm\.files/.test(query)), false);

  const restoreLedger = ledger();
  const restore = scripted([[{
    name: 'note.txt', ...managed, created_by: actor.id, created_by_kind: 'user',
    window_ended: false, purged: '0',
  }]]);
  const restored = await fileRestore(restore.tx, workspace, actor, {
    kind: FILE_RESTORE_KIND, file_id: fileId,
  }, restoreLedger.fn);
  assert.equal(refusal(restored).error, 'household_managed_file');
  assert.equal(restoreLedger.calls, 0);
  assert.equal(restore.queries.some((query) => /UPDATE swarm\.files/.test(query)), false);

  const commitLedger = ledger();
  const commit = scripted([[{ file_id: fileId, household_managed: true }]]);
  const committed = await fileVersionCommit(commit.tx, workspace, actor, {
    kind: FILE_VERSION_COMMIT_KIND, file_id: fileId, version_id: versionId, sha256: null,
  }, storage().api, commitLedger.fn);
  assert.equal(refusal(committed).error, 'household_managed_file');
  assert.equal(commitLedger.calls, 0);

  const named = scripted([
    [{ workspace_id: workspace }],
    [{ total: '0' }],
    [{
      file_id: fileId, household_managed: true, tombstoned_at: new Date('2026-10-01T00:00:00Z'),
      current_version: 1, live_version_count: '1', in_flight_version_count: '0',
    }],
  ]);
  const created = await fileVersionCreate(named.tx, workspace, actor, {
    kind: FILE_VERSION_CREATE_KIND, file_id: fileId, version_id: versionId,
    name: 'note.txt', declared_size_bytes: 4, content_type: 'text/plain', if_version: null,
  }, storage().api, ledger().fn);
  assert.equal(refusal(created).error, 'household_managed_file');
  assert.equal(named.queries.some((query) => /INSERT INTO swarm\.files/.test(query)), false);
});

test('ordinary files still download, tombstone, restore, miss a pending version, and keep a tombstoned name', async () => {
  const downloads = storage();
  const download = scripted([
    [{ household_managed: false }],
    [{
      version_n: 2, storage_path: 'objects/note', content_type: 'text/plain', size_bytes: '4',
      name: 'note.txt', tombstoned_at: null, version_state: 'live',
      live_version_count: '1', retired_version_count: '0',
    }],
  ]);
  const downloaded = await fileDownloadUrl(download.tx, workspace, {
    kind: FILE_DOWNLOAD_URL_KIND, file_id: fileId, version_n: null,
  }, downloads.api);
  assert.equal(downloaded.ok, true);
  if (downloaded.ok === true) assert.equal(downloaded.body.download_path, '/download');
  assert.deepEqual(downloads.downloads, ['objects/note']);

  const missing = scripted([[], []]);
  const missed = await fileDownloadUrl(missing.tx, workspace, {
    kind: FILE_DOWNLOAD_URL_KIND, file_id: fileId, version_n: null,
  }, storage().api);
  assert.equal(refusal(missed).error, 'file_not_found');

  const tombstoneLedger = ledger();
  const tombstone = scripted([
    [{
      name: 'note.txt', household_managed: false, tombstoned_at: null,
      created_by: actor.id, created_by_kind: 'user',
    }],
    [{ purge_at: '2026-11-05' }],
  ]);
  const tombstoned = await fileTombstone(tombstone.tx, workspace, actor, {
    kind: FILE_TOMBSTONE_KIND, file_id: fileId,
  }, tombstoneLedger.fn);
  assert.equal(tombstoned.ok, true);
  assert.equal(tombstoneLedger.calls, 1);
  assert.equal(tombstone.queries.some((query) => /UPDATE swarm\.files/.test(query)), true);

  const held = scripted([
    [{ workspace_id: workspace }],
    [{ total: '0' }],
    [{
      file_id: fileId, household_managed: false, tombstoned_at: new Date('2026-10-01T00:00:00Z'),
      current_version: 1, live_version_count: '1', in_flight_version_count: '0',
    }],
  ]);
  const named = await fileVersionCreate(held.tx, workspace, actor, {
    kind: FILE_VERSION_CREATE_KIND, file_id: fileId, version_id: versionId,
    name: 'note.txt', declared_size_bytes: 4, content_type: 'text/plain', if_version: null,
  }, storage().api, ledger().fn);
  assert.equal(refusal(named).error, 'file_tombstoned');

  const restoreLedger = ledger();
  const restore = scripted([
    [{
      name: 'note.txt', household_managed: false, tombstoned_at: new Date('2026-10-01T00:00:00Z'),
      created_by: actor.id, created_by_kind: 'user', window_ended: false, purged: '0',
    }],
    [],
  ]);
  const restored = await fileRestore(restore.tx, workspace, actor, {
    kind: FILE_RESTORE_KIND, file_id: fileId,
  }, restoreLedger.fn);
  assert.equal(restored.ok, true);
  assert.equal(restoreLedger.calls, 1);
  assert.match(restore.queries.at(-1)!, /tombstoned_at = NULL/);

  const commitLedger = ledger();
  const commit = scripted([
    [{ file_id: fileId, household_managed: false }],
    [],
  ]);
  const committed = await fileVersionCommit(commit.tx, workspace, actor, {
    kind: FILE_VERSION_COMMIT_KIND, file_id: fileId, version_id: versionId, sha256: null,
  }, storage().api, commitLedger.fn);
  assert.equal(refusal(committed).error, 'file_not_found');
  assert.equal(commitLedger.calls, 1);
});

async function signalEntry() {
  const bundled = await build({
    stdin: { contents: `export { resolveSignalAttachments } from './supabase/functions/command/index.ts';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `
      const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused',
        SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value' };
      const Deno = { env: { get: name => settings[name] }, serve: () => { throw new Error('unexpected server'); } };
      const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
      Object.defineProperty(globalThis, 'Deno', { value: Deno, configurable: true });` },
    footer: { js: `
      if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno); else Reflect.deleteProperty(globalThis, 'Deno');` },
    plugins: [{ name: 'inert-signal-transports', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, (args) => ({ path: args.path, namespace: 'inert-edge' }));
      builder.onLoad({ filter: /.*/, namespace: 'inert-edge' }, (args) => {
        if (args.path === 'npm:@supabase/supabase-js@2.110.8') {
          return { loader: 'js', contents: 'export function createClient() { return { auth: { async getUser() { return { error: null, data: { user: null } }; } } }; }' };
        }
        if (args.path === 'npm:postgres@3.4.9') {
          return { loader: 'js', contents: `export default function postgres() { const sql = async () => []; sql.begin = async () => {}; sql.json = value => value; return sql; }` };
        }
        throw new Error(`unexpected edge dependency ${args.path}`);
      });
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`) as {
    resolveSignalAttachments(
      tx: (strings: TemplateStringsArray) => Promise<unknown[]>,
      route: { workspaceId: string; streamId: string; membershipRole: null; membershipRevokedAt: null },
      refs: { file_id: string; version_n: number }[],
    ): Promise<{ ok: true; attachments: { name: string; content_type: string; size_bytes: number }[] } | { ok: false; error: string; message: string }>;
  };
}

const route = { workspaceId: workspace, streamId: workspace, membershipRole: null, membershipRevokedAt: null };
const ref = { file_id: fileId, version_n: 2 };

test('signal attachment refuses a household-managed file and still posts an ordinary live file', async () => {
  const api = await signalEntry();
  const managed = scripted([[{
    file_id: fileId, name: 'note.txt', tombstoned_at: null, purged_at: null, household_managed: true,
  }]]);
  const refused = await api.resolveSignalAttachments(managed.tx, route, [ref]);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error, 'household_managed_file');
    assert.match(refused.message, /Nothing was posted\.$/);
  }
  assert.equal(managed.queries.length, 1);

  const tombstoned = scripted([[{
    file_id: fileId, name: 'note.txt', tombstoned_at: new Date('2026-10-01T00:00:00Z'),
    purged_at: null, household_managed: false,
  }]]);
  const unavailable = await api.resolveSignalAttachments(tombstoned.tx, route, [ref]);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error, 'signal_attachment_unavailable');
  assert.equal(tombstoned.queries.length, 1);

  const live = scripted([
    [{ file_id: fileId, name: 'note.txt', tombstoned_at: null, purged_at: null, household_managed: false }],
    [{ version_n: 2, state: 'live', content_type: 'text/plain', size_bytes: '4' }],
  ]);
  const posted = await api.resolveSignalAttachments(live.tx, route, [ref]);
  assert.equal(posted.ok, true);
  if (posted.ok) {
    assert.equal(posted.attachments[0]?.name, 'note.txt');
    assert.equal(posted.attachments[0]?.content_type, 'text/plain');
    assert.equal(posted.attachments[0]?.size_bytes, 4);
  }
  assert.equal(live.queries.length, 2);
});
