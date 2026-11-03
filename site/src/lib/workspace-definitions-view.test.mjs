import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  renderWorkspaceDefinitionsHtml,
  mountWorkspaceDefinitions,
  workspaceDefinitionRefusalNotice,
} from './workspace-definitions-view.ts';

const baseRevision = {
  object_id: 'def-arr',
  sequence: 2,
  event_id: 'evt-2',
  token: 'def-arr:2:evt-2',
};

const certifiedRevision = {
  object_id: 'def-arr',
  sequence: 1,
  event_id: 'evt-1',
  token: 'def-arr:1:evt-1',
};

test('renderWorkspaceDefinitionsHtml renders Certified, Proposal pending diff, Proposed and reader gating', () => {
  const names = { people: { 'user-alice': 'Alice' }, agents: { 'agent-1': 'Claude' } };

  // 1. Certified state
  const certifiedHtml = renderWorkspaceDefinitionsHtml({
    can_edit: true,
    query: '',
    definitions: [{
      object_id: 'def-arr',
      term: 'ARR',
      revision: certifiedRevision,
      certification: { revision: certifiedRevision, certified_by: 'user-alice', certified_at: 1730000005000 },
    }],
    opened: {
      object_id: 'def-arr',
      current: {
        revision: certifiedRevision,
        term: 'ARR',
        meaning: 'Annualized recurring subscription revenue.',
        source: 'stripe.subscriptions',
        author: { user_id: 'user-alice', principal_id: null },
        occurred_at_server: 1730000000000,
      },
      certified: {
        revision: certifiedRevision,
        term: 'ARR',
        meaning: 'Annualized recurring subscription revenue.',
        source: 'stripe.subscriptions',
        certified_by: 'user-alice',
        certified_at: 1730000005000,
      },
      proposal_pending: false,
    },
    creating: false,
    busy: false,
    notice: '',
    names,
  });
  assert.match(certifiedHtml, /hh-def-badge--certified" data-def-status>Certified</);
  assert.match(certifiedHtml, /Certified by Alice/);
  assert.doesNotMatch(certifiedHtml, /data-def-diff/);
  assert.doesNotMatch(certifiedHtml, /data-def-action="certify"/);

  // 2. Proposal pending state (agent updated a certified definition -> side-by-side diff + Certify button)
  const pendingHtml = renderWorkspaceDefinitionsHtml({
    can_edit: true,
    query: '',
    definitions: [{
      object_id: 'def-arr',
      term: 'ARR',
      revision: baseRevision,
      certification: { revision: certifiedRevision, certified_by: 'user-alice', certified_at: 1730000005000 },
    }],
    opened: {
      object_id: 'def-arr',
      current: {
        revision: baseRevision,
        term: 'ARR',
        meaning: 'Annualized recurring subscription revenue excluding one-time setup fees.',
        source: 'stripe.subscriptions + billing.v2',
        author: { user_id: 'user-alice', principal_id: 'agent-1' },
        occurred_at_server: 1730000010000,
      },
      certified: {
        revision: certifiedRevision,
        term: 'ARR',
        meaning: 'Annualized recurring subscription revenue.',
        source: 'stripe.subscriptions',
        certified_by: 'user-alice',
        certified_at: 1730000005000,
      },
      proposal_pending: true,
    },
    creating: false,
    busy: false,
    notice: '',
    names,
  });
  assert.match(pendingHtml, /hh-def-badge--pending" data-def-status>Proposal pending</);
  assert.match(pendingHtml, /data-def-diff/);
  assert.match(pendingHtml, /<h5>Certified<\/h5>/);
  assert.match(pendingHtml, /Proposed \(/);
  assert.match(pendingHtml, /data-def-action="certify"/);
  assert.match(pendingHtml, /Certify proposed version/);

  // 3. Reader role cannot see Certify, Edit definition, or + New definition controls
  const readerHtml = renderWorkspaceDefinitionsHtml({
    can_edit: false,
    query: '',
    definitions: [{
      object_id: 'def-arr',
      term: 'ARR',
      revision: baseRevision,
      certification: { revision: certifiedRevision, certified_by: 'user-alice', certified_at: 1730000005000 },
    }],
    opened: {
      object_id: 'def-arr',
      current: {
        revision: baseRevision,
        term: 'ARR',
        meaning: 'Annualized recurring subscription revenue excluding one-time setup fees.',
        source: 'stripe.subscriptions + billing.v2',
        author: { user_id: 'user-alice', principal_id: 'agent-1' },
        occurred_at_server: 1730000010000,
      },
      certified: {
        revision: certifiedRevision,
        term: 'ARR',
        meaning: 'Annualized recurring subscription revenue.',
        source: 'stripe.subscriptions',
        certified_by: 'user-alice',
        certified_at: 1730000005000,
      },
      proposal_pending: true,
    },
    creating: false,
    busy: false,
    notice: '',
    names,
  });
  assert.match(readerHtml, /data-def-diff/);
  assert.doesNotMatch(readerHtml, /data-def-action="certify"/);
  assert.doesNotMatch(readerHtml, /data-def-update-form/);
  assert.doesNotMatch(readerHtml, /data-def-action="new"/);
});

test('renderWorkspaceDefinitionsHtml escapes hostile HTML in term, meaning, source and notice', () => {
  const html = renderWorkspaceDefinitionsHtml({
    can_edit: true,
    query: '',
    definitions: [{ object_id: 'def-xss', term: '<script>alert(1)</script>', revision: baseRevision, certification: null }],
    opened: {
      object_id: 'def-xss',
      current: {
        revision: baseRevision,
        term: '<script>alert(1)</script>',
        meaning: '<img src=x onerror=alert(2)>',
        source: '"><svg onload=alert(3)>',
        author: { user_id: 'user-alice', principal_id: null },
        occurred_at_server: 1730000000000,
      },
      certified: null,
      proposal_pending: true,
    },
    creating: false,
    busy: false,
    notice: '<b>bad notice</b>',
  });
  assert.doesNotMatch(html, /<script>|<img|<svg|<b>bad notice<\/b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /hh-def-badge--proposed" data-def-status>Proposed</);
  assert.match(html, /Certify definition/);
});

test('mountWorkspaceDefinitions stays hidden if server does not support definitions_search, and certifies on human click', async () => {
  const makeHarness = () => {
    const listeners = new Map();
    const container = {
      className: '',
      hidden: false,
      innerHTML: '',
      dataset: {},
      attributes: new Map(),
      setAttribute(k, v) { this.attributes.set(k, v); },
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type) { listeners.delete(type); },
      contains() { return true; },
      remove() { this.removed = true; },
    };
    const afterNode = { nextSibling: null };
    const hostParent = {
      ownerDocument: {
        createElement() { return container; },
      },
      insertBefore(node) { this.inserted = node; },
    };
    return { container, afterNode, hostParent, listeners };
  };

  // 1. Graceful progressive enhancement when definitions_search is unsupported
  const unsupported = makeHarness();
  mountWorkspaceDefinitions(unsupported.hostParent, unsupported.afterNode, true, async () => ({ status: 'refused', reason: 'unknown_tool' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(unsupported.container.hidden, true);

  // 2. Certify click sends household_definition_certify with current revision and reloads
  const harness = makeHarness();
  const calls = [];
  let certifiedNow = false;
  const unmount = mountWorkspaceDefinitions(harness.hostParent, harness.afterNode, true, async (command) => {
    calls.push(command);
    if (command.kind === 'household_tool' && command.tool === 'definitions_search') {
      return {
        status: 'ok',
        definitions: [{
          object_id: 'def-arr',
          term: 'ARR',
          revision: baseRevision,
          certification: {
            revision: certifiedNow ? baseRevision : certifiedRevision,
            certified_by: 'user-1',
            certified_at: 1730000005000,
          },
        }],
        next_offset: null,
      };
    }
    if (command.kind === 'household_tool' && command.tool === 'definition_read') {
      return {
        status: 'ok',
        object_id: 'def-arr',
        current: {
          revision: baseRevision,
          term: 'ARR',
          meaning: 'Updated meaning',
          source: 'stripe.subscriptions',
          author: { user_id: 'user-1', principal_id: 'agent-1' },
          occurred_at_server: 1730000010000,
        },
        certified: certifiedNow
          ? {
              revision: baseRevision,
              term: 'ARR',
              meaning: 'Updated meaning',
              source: 'stripe.subscriptions',
              certified_by: 'user-1',
              certified_at: 1730000020000,
            }
          : {
              revision: certifiedRevision,
              term: 'ARR',
              meaning: 'Original meaning',
              source: 'stripe.subscriptions',
              certified_by: 'user-1',
              certified_at: 1730000005000,
            },
        proposal_pending: !certifiedNow,
      };
    }
    if (command.kind === 'household_definition_certify') {
      certifiedNow = true;
      return { status: 'committed', object_id: command.object_id, revision: baseRevision };
    }
    return { status: 'refused' };
  });

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(harness.container.hidden, false);
  assert.match(harness.container.innerHTML, /Proposal pending/);

  // Simulate human click on Certify button
  const clickHandler = harness.listeners.get('click');
  const fakeButton = {
    disabled: false,
    dataset: { defAction: 'certify', defTarget: 'def-arr' },
    closest(selector) {
      return selector === 'button[data-def-action]' ? this : null;
    },
  };
  clickHandler({ target: fakeButton });
  await new Promise((r) => setTimeout(r, 20));

  const certifyCall = calls.find((c) => c.kind === 'household_definition_certify');
  assert.deepEqual(certifyCall, {
    kind: 'household_definition_certify',
    object_id: 'def-arr',
    revision: baseRevision,
  });
  assert.match(harness.container.innerHTML, /Certified\./);
  assert.match(harness.container.innerHTML, /hh-def-badge--certified" data-def-status>Certified</);

  unmount();
  assert.equal(harness.container.removed, true);
});

test('workspaceDefinitionRefusalNotice maps C2 refusal codes to clear messages', () => {
  assert.match(workspaceDefinitionRefusalNotice('definition_not_current'), /newer version/i);
  assert.match(workspaceDefinitionRefusalNotice('human_confirmation_required'), /Only a workspace member/i);
  assert.match(workspaceDefinitionRefusalNotice('content_read_only'), /reader access/i);
});
