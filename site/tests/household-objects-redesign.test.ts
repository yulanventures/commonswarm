import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHouseholdObjectsController, householdAttribution, householdObjectsFixture,
  renderHouseholdObjects, renderHouseholdObjectHistory, type HouseholdObjectView,
} from '../src/lib/household-objects-view.js';

// Redesign (2026-10-04) presentation changes for Lists & docs: names instead of IDs, a saved
// list that stays on screen, and the plain empty state. The permission and conflict guards are
// owned by household-objects-view.test.ts and are not re-tested here.

const names = { people: { 'person-a': 'Tom', 'person-b': 'Mei' }, agents: { 'agent-a': 'Claude' } };

test('attribution reads names when the dashboard supplies them, and keeps the ID form otherwise', () => {
  const agent = { user_id: 'person-a', principal_id: 'agent-a', run_id: null, connection_id: null, grant_id: null };
  const person = { user_id: 'person-b', principal_id: null, run_id: null, connection_id: null, grant_id: null };
  assert.equal(householdAttribution(agent, names), 'Claude, Tom’s agent');
  assert.equal(householdAttribution(person, names), 'Mei');
  const removed = { people: {}, agents: { 'agent-a': 'Juniper (removed)' } };
  assert.equal(householdAttribution(agent, removed), 'Juniper (removed)');
  assert.match(renderHouseholdObjectHistory(householdObjectsFixture().objects[1]!, false, removed), /Juniper \(removed\)/);
  // Control: without names, or with an unknown agent, the unambiguous ID form remains.
  assert.equal(householdAttribution(agent), 'Agent agent-a for person-a');
  assert.equal(householdAttribution({ ...agent, principal_id: 'agent-z' }, names), 'Agent agent-z for person-a');
  const workspace = { ...householdObjectsFixture(), names };
  const history = renderHouseholdObjectHistory(workspace.objects[1]!, false, names);
  assert.match(history, /Claude, Tom’s agent/);
  assert.doesNotMatch(history, /Agent agent-a for person-a/);
  // The machine-readable time stays ISO; the visible one is local.
  assert.match(history, /<time datetime="2026-10-03T00:00:00\.000Z">(?!2026-10-03T)/);
});

test('a committed save keeps the object selected with the revision the server returned', async () => {
  const workspace = householdObjectsFixture();
  const saved: HouseholdObjectView = structuredClone(workspace.objects[0]!);
  saved.current = { ...saved.current, revision: { ...saved.current.revision, token: 'fixture-revision-list-saved' },
    content: { kind: 'list', items: [
      { item_id: 'apples', text: 'Apples', order: 0, checked: true }, { item_id: 'bread', text: 'Bread', order: 1, checked: true },
    ] } };
  saved.history = [workspace.objects[0]!.current, saved.current];
  const reloads: string[] = [];
  const controller = createHouseholdObjectsController(workspace, {
    save: async (request) => ({ status: 'committed', object_id: request.object_id,
      revision: { ...saved.current.revision } }) as never,
    readRevision: async () => ({ kind: 'doc', markdown: '' }),
    recoverDraft: async () => { throw new Error('not used'); },
    reloadObject: async (_workspace, objectId) => { reloads.push(objectId); return structuredClone(saved); },
  });
  assert.equal(controller.select('groceries'), true);
  assert.equal(controller.stage({ kind: 'list', items: [
    { item_id: 'apples', text: 'Apples', order: 0, checked: true }, { item_id: 'bread', text: 'Bread', order: 1, checked: true },
  ] }), true);
  assert.equal(await controller.save(), true);
  const state = controller.getState();
  assert.deepEqual(reloads, ['groceries']);
  assert.equal(state.selected_id, 'groceries', 'the list a person just changed stays open');
  assert.equal(state.notice, 'Saved.');
  assert.equal(state.workspace.objects.find((object) => object.object_id === 'groceries')?.current.revision.token,
    'fixture-revision-list-saved');
});

test('a reload that fails or returns a foreign object falls back to the honest reload notice', async () => {
  for (const reloadObject of [
    async () => { throw new Error('offline'); },
    async () => ({ ...structuredClone(householdObjectsFixture().objects[1]!) }),
  ]) {
    const workspace = householdObjectsFixture();
    const controller = createHouseholdObjectsController(workspace, {
      save: async (request) => ({ status: 'committed', object_id: request.object_id,
        revision: { ...workspace.objects[0]!.current.revision, token: 'fixture-revision-list-saved' } }) as never,
      readRevision: async () => ({ kind: 'doc', markdown: '' }),
      recoverDraft: async () => { throw new Error('not used'); },
      reloadObject,
    });
    controller.select('groceries');
    controller.stage({ kind: 'list', items: [{ item_id: 'apples', text: 'Apples', order: 0, checked: true },
      { item_id: 'bread', text: 'Bread', order: 1, checked: true }] });
    await controller.save();
    const state = controller.getState();
    assert.equal(state.notice, 'Saved. Reload the object to read the committed revision.');
    assert.equal(state.selected_id, null);
  }
});

test('the empty view tells a person how lists are made, in plain words', () => {
  const workspace = { ...householdObjectsFixture(), objects: [] };
  const html = renderHouseholdObjects(createHouseholdObjectsController(workspace, {
    save: async () => ({ status: 'unknown' }), readRevision: async () => ({ kind: 'doc', markdown: '' }),
    recoverDraft: async () => { throw new Error('not used'); },
  }).getState());
  assert.match(html, /No lists or docs yet\. Ask an agent: “Create a CommonSwarm list called Groceries\.”/);
  assert.match(html, /<p class="hh-eyebrow">Lists &amp; docs<\/p>/);
  assert.doesNotMatch(html, /Household objects<\/p>|Approved operations|retained history/);
});
