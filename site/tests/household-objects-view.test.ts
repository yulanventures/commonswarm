import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from '@astrojs/compiler-rs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import type { HouseholdContent, HouseholdOutcome } from '../../src/protocol/household-object-events.js';
import { decideHouseholdObject, emptyHouseholdObjectState, reduceHouseholdObjectStream,
  type DecideHouseholdObjectContext } from '../../src/protocol/household-objects.js';
import {
  createHouseholdObjectsController, createHouseholdObjectsState, householdContentPatch,
  householdObjectsFixture, householdConflictFixture, renderHouseholdConflict, renderHouseholdContent,
  renderHouseholdObjectHistory, renderHouseholdObjects,
  type HouseholdActions, type HouseholdConflictView, type HouseholdSaveRequest,
} from '../src/lib/household-objects-view.js';

// New presentation boundary: tests protect observable permissions, rendered
// content and async lifecycle. The server core cannot catch UI-only writes,
// injected markup or a late response reviving a previous workspace. Injected
// actions are the production integration contract, not a test-only transport.
function setup(role: 'reader' | 'editor' = 'editor', overrides: Partial<HouseholdActions> = {}) {
  const workspace = householdObjectsFixture(role);
  const doc = workspace.objects[1]!;
  const conflict = householdConflictFixture(workspace);
  const saves: HouseholdSaveRequest[] = [];
  const reads: string[] = [];
  const recoveries: string[] = [];
  let sequence = 0;
  const controller = createHouseholdObjectsController(workspace, {
    save: async (request) => { saves.push(structuredClone(request)); return { status: 'refused', reason: 'fixture_refusal' }; },
    readRevision: async (revision) => { reads.push(revision.token); return { kind: 'doc', markdown: 'Loaded retained content' }; },
    recoverDraft: async (_workspace, draftId) => { recoveries.push(draftId); return conflict; },
    ...overrides,
  }, () => `request-${++sequence}`);
  return { workspace, doc, conflict, saves, reads, recoveries, controller };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('reader and unapproved editor actions never reach save; approved editor carries an exact before-value patch', async () => {
  for (const role of ['reader', 'editor'] as const) {
    const fixture = setup(role);
    if (role === 'editor') fixture.controller.switchWorkspace({ ...fixture.workspace, operations: ['read'] });
    assert.equal(fixture.controller.select('weekend'), true);
    assert.equal(fixture.controller.stage({ kind: 'doc', markdown: 'Changed' }), false);
    assert.equal(await fixture.controller.save(true), false);
    assert.equal(await fixture.controller.checkSave(), false);
    assert.equal(fixture.saves.length, 0);
    const html = renderHouseholdObjects(fixture.controller.getState());
    assert.match(html, /Content role:/);
    assert.doesNotMatch(html, /<textarea|data-hh-action="(?:save|toggle|reviewed-save)"/);
  }
  const editor = setup();
  editor.controller.select('weekend');
  assert.match(renderHouseholdObjects(editor.controller.getState()), /<textarea data-hh-document/);
  assert.equal(editor.controller.stage({ kind: 'doc', markdown: 'Changed' }), true);
  assert.equal(await editor.controller.save(), true);
  assert.deepEqual(editor.saves, [{ request_id: 'request-1', workspace_id: 'fixture-household', object_id: 'weekend',
    base: editor.doc.current.revision, patch: { kind: 'doc', splices: [{ start: 0,
      before: '## Saturday\nBring a picnic. **Check the weather.**', after: 'Changed' }] } }]);
  assert.match(editor.controller.getState().notice, /refused/);
  assert.deepEqual(editor.controller.getState().proposed, { kind: 'doc', markdown: 'Changed' });
});

test('retired history is readable by a reader; foreign versions are withheld with a valid page control', async () => {
  const fixture = setup('reader');
  const page = structuredClone(fixture.workspace);
  page.objects[1]!.history[0]!.content = null;
  fixture.controller.switchWorkspace(page);
  fixture.controller.select('weekend');
  const html = renderHouseholdObjects(fixture.controller.getState());
  assert.match(html, /Retired · retained/);
  assert.match(html, /Agent agent-a for person-a/);
  assert.match(html, /Person person-a/);
  assert.equal(await fixture.controller.openRevision(fixture.doc.history[0]!.revision.token), true);
  assert.deepEqual(fixture.reads, [fixture.doc.history[0]!.revision.token]);
  assert.match(renderHouseholdObjects(fixture.controller.getState()), /Loaded retained content/);
  assert.doesNotMatch(renderHouseholdObjects(fixture.controller.getState()), /<textarea/);
  assert.equal(await fixture.controller.openRevision(fixture.doc.current.revision.token), true);
  assert.equal(fixture.controller.getState().opened_version, null);
  const mixed = structuredClone(page);
  mixed.objects[1]!.history[0]!.revision.workspace_id = 'someone-elses-workspace';
  const withheld = createHouseholdObjectsState(mixed);
  assert.deepEqual(withheld.workspace.objects.map((object) => object.object_id), ['groceries', 'guide']);
  assert.equal(await fixture.controller.openRevision('unknown-token'), false);
  assert.equal(fixture.reads.length, 1);
});

test('hostile Markdown, list, file, title and attribution stay inert while ordinary formatting renders', () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script><form><button data-hh-action="save">Save</button></form>';
  const doc = renderHouseholdContent({ kind: 'doc', markdown: `**Safe emphasis**\n${hostile}\n[bad](javascript:alert(1))\n[external](https://example.test)\n![image](https://example.test/x.png)` });
  assert.match(doc, /<strong>Safe emphasis<\/strong>/);
  assert.match(doc, /&lt;script&gt;/);
  assert.doesNotMatch(doc, /<(?:script|img|iframe|form|input|button|a)\b|<[^>]+\s(?:href|src)=/i);
  const fixture = setup('reader');
  fixture.workspace.name = hostile;
  fixture.workspace.audience = [hostile];
  fixture.workspace.objects[1]!.current.title = hostile;
  fixture.workspace.objects[1]!.current.author.user_id = hostile;
  fixture.controller.switchWorkspace(fixture.workspace);
  fixture.controller.select('weekend');
  const html = renderHouseholdObjects(fixture.controller.getState());
  assert.doesNotMatch(html, /<script\b|<img\b|<form\b|<button data-hh-action="save"/);
  assert.match(html, /&lt;img/);
  for (const content of [
    { kind: 'list', items: [{ item_id: 'one', order: 0, checked: false, text: hostile }] },
    { kind: 'file', name: hostile, media_type: hostile },
  ] as HouseholdContent[]) assert.doesNotMatch(renderHouseholdContent(content), /<(?:script|img|form|button)\b/i);
});

test('interrupted and pending saves keep their draft and reuse the original request only after an explicit check', async () => {
  const calls: HouseholdSaveRequest[] = [];
  const fixture = setup('editor', { save: async (request) => {
    calls.push(structuredClone(request));
    if (calls.length === 1) throw new Error('connection interrupted');
    if (calls.length === 2) return { status: 'pending', object_id: 'weekend', reservation_id: 'reservation-a' };
    return { status: 'committed', object_id: 'weekend', revision: { ...request.base, token: 'new-committed-revision' } };
  } });
  fixture.controller.select('weekend');
  fixture.controller.stage({ kind: 'doc', markdown: 'Local draft' });
  await fixture.controller.save();
  assert.equal(fixture.controller.getState().save_state, 'unknown');
  assert.match(renderHouseholdObjects(fixture.controller.getState()), /Local draft/);
  assert.equal(fixture.controller.stage({ kind: 'doc', markdown: 'Different draft' }), false);
  assert.equal(await fixture.controller.save(), false);
  assert.equal(calls.length, 1);
  await fixture.controller.checkSave();
  assert.equal(fixture.controller.getState().save_state, 'pending');
  assert.doesNotMatch(fixture.controller.getState().notice, /^Saved/);
  assert.equal(calls.length, 2);
  await fixture.controller.checkSave();
  assert.equal(fixture.controller.getState().save_state, 'committed');
  assert.deepEqual(calls[1], calls[0]); assert.deepEqual(calls[2], calls[0]);
  assert.equal(fixture.controller.getState().proposed, null);
  assert.equal(fixture.controller.getState().selected_id, null);
});

test('conflicts require private recovery and review; the reviewed retry uses current base and a new request', async () => {
  const calls: HouseholdSaveRequest[] = [];
  const fixture = setup('editor', { save: async (request) => {
    calls.push(structuredClone(request));
    return { status: 'conflict', object_id: 'weekend', current: calls.length === 1 ? fixture.conflict.current.revision
      : { ...fixture.conflict.current.revision, token: 'another-new-current-revision' }, draft_id: 'draft-a' };
  } });
  fixture.controller.select('weekend'); fixture.controller.stage(fixture.conflict.proposed);
  await fixture.controller.save();
  assert.equal(calls.length, 1);
  assert.equal(await fixture.controller.save(true), false);
  assert.equal(await fixture.controller.recoverDraft(), true);
  const html = renderHouseholdConflict(fixture.controller.getState());
  assert.match(html, /aria-label="Base"/); assert.match(html, /aria-label="Current"/);
  assert.match(html, /aria-label="Your proposed draft"/);
  assert.equal(await fixture.controller.save(), false);
  assert.equal(calls.length, 1);
  await fixture.controller.save(true);
  assert.equal(calls[1]!.request_id, 'request-2');
  assert.deepEqual(calls[1]!.base, fixture.conflict.current.revision);
  assert.deepEqual(calls[1]!.patch, { kind: 'doc', splices: [{ start: 0,
    before: 'Bring a picnic. Meet at noon.', after: 'Bring fruit for the picnic.' }] });
  const readerState = { ...fixture.controller.getState(), conflict: fixture.conflict };
  readerState.workspace.content_role = 'reader';
  assert.doesNotMatch(renderHouseholdConflict(readerState), /data-hh-action="reviewed-save"/);
  readerState.conflict = { ...fixture.conflict, owner_user_id: 'person-b' };
  assert.equal(renderHouseholdConflict(readerState), '');
});

test('foreign-owner recovered drafts never become visible, paired with valid recovery', async () => {
  const fixture = setup('editor', {
    save: async () => ({ status: 'conflict', object_id: 'weekend', current: fixture.conflict.current.revision, draft_id: 'draft-a' }),
    recoverDraft: async () => ({ ...fixture.conflict, owner_user_id: 'person-b', proposed: { kind: 'doc', markdown: 'Private other-person draft' } }),
  });
  fixture.controller.select('weekend'); fixture.controller.stage({ kind: 'doc', markdown: 'Mine' }); await fixture.controller.save();
  assert.equal(await fixture.controller.recoverDraft(), false);
  assert.equal(fixture.controller.getState().conflict, null);
  assert.doesNotMatch(renderHouseholdObjects(fixture.controller.getState()), /Private other-person draft/);
  // A new controller uses the same conflict result with the authorized owner.
  const valid = setup('editor', { save: async () => ({ status: 'conflict', object_id: 'weekend', current: fixture.conflict.current.revision, draft_id: 'draft-a' }) });
  valid.controller.select('weekend'); valid.controller.stage({ kind: 'doc', markdown: 'Mine' }); await valid.controller.save();
  assert.equal(await valid.controller.recoverDraft(), true);
});

test('workspace switching immediately clears content and ignores late saves, reads and recovery, including switch-back', async () => {
  for (const operation of ['save', 'read', 'recover'] as const) {
    const delayed = deferred<Exclude<HouseholdOutcome, { status: 'released' }> | HouseholdContent | HouseholdConflictView>();
    const fixture = setup('editor', {
      save: async () => operation === 'save' ? delayed.promise as Promise<Exclude<HouseholdOutcome, { status: 'released' }>>
        : { status: 'conflict', object_id: 'weekend', current: fixture.conflict.current.revision, draft_id: 'draft-a' },
      readRevision: async () => delayed.promise as Promise<HouseholdContent>,
      recoverDraft: async () => delayed.promise as Promise<HouseholdConflictView>,
    });
    const page = structuredClone(fixture.workspace); page.objects[1]!.history[0]!.content = null;
    fixture.controller.switchWorkspace(page); fixture.controller.select('weekend');
    fixture.controller.stage({ kind: 'doc', markdown: 'Draft from old workspace' });
    let completion: Promise<boolean>;
    if (operation === 'save') completion = fixture.controller.save();
    else if (operation === 'read') completion = fixture.controller.openRevision(fixture.doc.history[0]!.revision.token);
    else { await fixture.controller.save(); completion = fixture.controller.recoverDraft(); }
    fixture.controller.switchWorkspace({ ...fixture.workspace, workspace_id: 'new-workspace', name: 'New workspace', objects: [], audience: ['Person C'] });
    assert.doesNotMatch(renderHouseholdObjects(fixture.controller.getState()), /Weekend|picnic|Person A|Draft from old/);
    fixture.controller.switchWorkspace(fixture.workspace);
    const cleared = fixture.controller.getState();
    delayed.resolve(operation === 'save' ? { status: 'conflict', object_id: 'weekend', current: fixture.conflict.current.revision, draft_id: 'draft-a' }
      : operation === 'read' ? { kind: 'doc', markdown: 'Late private bytes' } : fixture.conflict);
    assert.equal(await completion, false);
    assert.deepEqual(fixture.controller.getState(), cleared);
  }
});

test('paginated history appends retained revisions once and refuses a foreign page', async () => {
  const fixture = setup('reader', { readHistory: async () => ({ revisions: [fixture.doc.history[0]!], next_cursor: null }) });
  const page = structuredClone(fixture.workspace); page.objects[1]!.history = [page.objects[1]!.current]; page.objects[1]!.next_history_cursor = 'next-page';
  fixture.controller.switchWorkspace(page); fixture.controller.select('weekend');
  assert.equal(await fixture.controller.moreHistory(), true);
  assert.equal(fixture.controller.getState().workspace.objects[1]!.history.length, 2);
  assert.equal(await fixture.controller.moreHistory(), false);
  assert.match(renderHouseholdObjectHistory(fixture.controller.getState().workspace.objects[1]!), /Retired · retained/);
  const other = setup('reader', { readHistory: async () => ({ revisions: [{ ...fixture.doc.history[0]!,
    revision: { ...fixture.doc.history[0]!.revision, workspace_id: 'foreign' } }], next_cursor: null }) });
  other.controller.switchWorkspace(page); other.controller.select('weekend');
  assert.equal(await other.controller.moreHistory(), false);
  assert.equal(other.controller.getState().workspace.objects[1]!.history.length, 1);
});

test('list patches reach the real core and produce the proposed list across remove, move, add and check', () => {
  const base: HouseholdContent = { kind: 'list', items: [
    { item_id: 'a', text: 'A', checked: false, order: 0 }, { item_id: 'b', text: 'B', checked: false, order: 1 },
    { item_id: 'c', text: 'C', checked: true, order: 2 },
  ] };
  const proposed: HouseholdContent = { kind: 'list', items: [
    { item_id: 'c', text: 'Changed C', checked: false, order: 0 }, { item_id: 'd', text: 'D', checked: true, order: 1 },
    { item_id: 'b', text: 'B', checked: false, order: 2 },
  ] };
  const initial = emptyHouseholdObjectState('workspace', 'stream');
  const verified = { workspace_id: 'workspace', object_id: 'list', revision: null,
    blob: { storage_key: 'fixture/base', size_bytes: 100, sha256: '0'.repeat(64) }, content: base };
  const context: DecideHouseholdObjectContext = { access: { workspace_id: 'workspace', archived_at: null, boundary: { kind: 'shared' },
    actor: { user_id: 'person', principal_id: null, run_id: null }, credential: { kind: 'human' },
    member: { workspace_id: 'workspace', user_id: 'person', revoked_at: null, content_role: 'editor', content_consent_id: 'consent' } },
    now: Date.UTC(2026, 9, 3), command_id: 'create', event_id: 'event-create', request_digest: 'a'.repeat(64), seq: 0,
    revision_token: 'base-revision-000000000000', draft_id: 'draft', other_storage_bytes: 0, other_object_count: 0,
    identity_write_attempts: 0, workspace_write_attempts: 0, contents: [], prepared: verified };
  const created = decideHouseholdObject({ kind: 'create_household_object', object_id: 'list', title: 'List', content: base }, initial, context);
  assert.equal(created.outcome.status, 'committed');
  assert.equal(created.events.length, 1);
  const state = reduceHouseholdObjectStream(created.events, initial);
  const revision = state.objects.list!.history[0]!.revision;
  const patch = householdContentPatch(base, proposed)!;
  const updated = decideHouseholdObject({ kind: 'update_household_object', object_id: 'list', base: revision, patch }, state, {
    ...context, command_id: 'update', event_id: 'event-update', request_digest: 'b'.repeat(64), seq: 1,
    revision_token: 'next-revision-000000000000', contents: [{ ...verified, revision }],
    prepared: { ...verified, revision, content: proposed, blob: { storage_key: 'fixture/next', size_bytes: 100, sha256: '1'.repeat(64) } },
  });
  // The independent core applies before values, checks order and compares the
  // patched result with these separately supplied proposed bytes/content facts.
  assert.equal(updated.outcome.status, 'committed');
  assert.equal(updated.events.length, 1);
  assert.equal(householdContentPatch(base, { kind: 'doc', markdown: 'Wrong type' }), null);
});

test('a reader can recover their retained draft after reload without submitting a mutation', async () => {
  const fixture = setup('reader'); fixture.controller.select('weekend');
  assert.equal(fixture.controller.restoreDraft('draft-a', fixture.conflict.current.revision), true);
  assert.equal(await fixture.controller.recoverDraft(), true);
  assert.match(renderHouseholdConflict(fixture.controller.getState()), /Bring fruit for the picnic/);
  assert.equal(await fixture.controller.save(true), false);
  assert.equal(fixture.saves.length, 0);
  assert.equal(fixture.controller.restoreDraft('foreign', { ...fixture.doc.current.revision, workspace_id: 'foreign' }), false);
});

test('all three Astro components compile and server-render escaped, accessible reader/editor states without a browser', async () => {
  const fixture = setup(); fixture.controller.select('weekend');
  const state = fixture.controller.getState(); state.conflict = fixture.conflict; state.save_state = 'conflict';
  const container = await AstroContainer.create();
  for (const [name, props, expected] of [
    ['HouseholdObjects', { state }, /aria-label="Household workspace"/],
    ['HouseholdObjectHistory', { object: fixture.doc }, /Retired · retained/],
    ['HouseholdConflict', { state }, /aria-label="Your proposed draft"/],
  ] as const) {
    const source = await readFile(new URL(`../src/components/app/${name}.astro`, import.meta.url), 'utf8');
    const compiled = transform(source, { filename: `${name}.astro`, internalURL: 'astro/compiler-runtime',
      resultScopedSlot: true, resolvePath: (specifier) => specifier });
    assert.deepEqual(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), []);
    // Evaluate the real compiled component in memory. CSS imports are handled by
    // Vite in the product; this server-render harness tests markup without Vite.
    const code = compiled.code.replace(/import "[^"\n]+\?astro&type=style[^"\n]+";\n/gu, '')
      .replaceAll('"astro/compiler-runtime"', JSON.stringify(new URL('../node_modules/astro/dist/runtime/compiler/index.js', import.meta.url).href))
      .replaceAll('"../../lib/household-objects-view"', JSON.stringify(new URL('../src/lib/household-objects-view.ts', import.meta.url).href));
    const component = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    const html = await container.renderToString(component.default, { props });
    assert.match(html, expected);
    assert.doesNotMatch(html, /<script\b|\sonclick=/);
  }
});
