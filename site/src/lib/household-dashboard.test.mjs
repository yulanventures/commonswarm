import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHouseholdDashboard } from './household-dashboard.ts';

test('workspace switching clears household content and ignores an earlier authenticated load', async () => {
  const root = { textContent: 'old private content', replaceChildren() { this.textContent = ''; } };
  const dashboard = createHouseholdDashboard(root);
  let finish;
  const pending = dashboard.open({ workspace_id: 'old-workspace', name: 'Old', viewer_user_id: 'a', audience: ['A'] },
    () => new Promise(resolve => { finish = resolve; }));
  assert.equal(root.textContent, 'Loading shared objects…');
  dashboard.clear();
  assert.equal(root.textContent, '');
  finish({ status: 'ok', content_role: 'editor', operations: ['read', 'create', 'update'] });
  await pending;
  assert.equal(root.textContent, '', 'late consent cannot mount previous-workspace objects');
});

test('a refused content read shows confirmation guidance and makes no object request', async () => {
  const root = { textContent: '', replaceChildren() { this.textContent = ''; } };
  let calls = 0;
  await createHouseholdDashboard(root).open({ workspace_id: 'household', name: 'Household', viewer_user_id: 'a', audience: ['A','B'] },
    async command => { calls++; assert.equal(command.kind, 'household_access'); return { status: 'refused', reason: 'content_consent_required' }; });
  assert.equal(calls, 1);
  assert.match(root.textContent, /confirmation/);
});
