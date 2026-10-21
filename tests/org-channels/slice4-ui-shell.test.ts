import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OrgChannelAuthorityState } from '../../src/protocol/org-channels-contract.js';
import {
  ORG_ROLE_LABELS,
  ORG_SWITCHER_ACTIONS,
  type OrgDomDocument,
  type OrgDomElement,
  buildOrgHeaderSwitcherDom,
  deriveOrgHeaderSwitcherVM,
  renderOrgHeaderSwitcherHtml,
  renderOrgLogoBadgeHtml,
} from '../../site/src/components/app/live-dashboard/org-shell/org-header-switcher.js';
import {
  PRESERVED_SHELL_HOOKS,
  deriveWorkspaceChannelNavVM,
  formatUnreadCountPill,
  renderKylonOrgShellHtml,
  renderModeContextualListPaneHtml,
  renderWorkspaceSwitcherMenuHtml,
} from '../../site/src/components/app/live-dashboard/org-shell/workspace-channel-nav.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function createMultiOrgFixture(): OrgChannelAuthorityState {
  const now = '2026-10-21T00:00:00Z';
  const org = (id: string, slug: string, display_name: string, logo_object_key: string | null = null, created_by = 'u-tom') => ({
    id, slug, display_name, logo_object_key, ...(logo_object_key ? { logo_updated_at: now } : {}), created_by, created_at: now, updated_at: now,
  });
  const ws = (workspace_id: string, org_id: string, slug: string, name: string) => ({ workspace_id, org_id, slug, name });
  const ch = (channel_id: string, slug: string, topic: string, visibility: 'workspace' | 'private') => ({
    channel_id, workspace_id: 'ws-build', slug, topic, visibility, join_policy: (visibility === 'private' ? 'invite_only' : 'open') as 'open' | 'invite_only',
  });
  const om = (org_id: string, principal_kind: 'user' | 'agent', principal_id: string, role: 'owner' | 'admin' | 'member' | 'guest') => ({
    org_id, principal_kind, principal_id, role, created_at: now,
  });
  const wg = (workspace_id: string, org_id: string, principal_id: string, role: 'owner' | 'admin' | 'member' | 'guest') => ({
    workspace_id, org_id, principal_kind: 'user' as const, principal_id, role, created_at: now,
  });
  return {
    privateChannelsEnabled: true,
    organizations: [
      org('org-yulan', 'yulan', 'Yulan Ventures', 'orgs/org-yulan/logo/64.png'),
      org('org-household', 'household', 'Langridge Household'),
      org('org-studio', 'ridge-studio', 'Ridge Partner Studio', null, 'u-partner'),
      org('org-audit', 'external-audit', 'External Design Review', null, 'u-auditor'),
    ],
    workspaces: [
      ws('ws-build', 'org-yulan', 'commonswarm-build', 'CommonSwarm Build'),
      ws('ws-ops', 'org-yulan', 'operations', 'Operations'),
      ws('ws-open', 'org-yulan', 'customer-advisory', 'Customer Advisory'),
      ws('ws-home', 'org-household', 'family-hub', 'Family Hub'),
      ws('ws-studio', 'org-studio', 'design-systems', 'Design Systems'),
      ws('ws-audit-granted', 'org-audit', 'shared-review', 'Shared Review Room'),
      ws('ws-audit-internal', 'org-audit', 'internal-audit', 'Internal Audit Only'),
    ],
    channels: [
      ch('ch-gen', 'general', 'Shared coordination across people and agents', 'workspace'),
      ch('ch-design', 'design', 'Kylon shell geometry and token review', 'workspace'),
      ch('ch-sec', 'sec-incident', 'Private incident coordination', 'private'),
      ch('ch-hidden-priv', 'exec-comp', 'Restricted private channel', 'private'),
    ],
    agentIdentities: [{ id: 'ag-argon', owner_user_id: 'u-tom', display_name: 'Argon', created_at: now }],
    orgMemberships: [
      om('org-yulan', 'user', 'u-tom', 'owner'), om('org-household', 'user', 'u-tom', 'admin'),
      om('org-studio', 'user', 'u-tom', 'member'), om('org-audit', 'user', 'u-tom', 'guest'),
      om('org-yulan', 'user', 'u-member', 'member'), om('org-yulan', 'user', 'u-guest', 'guest'),
      om('org-yulan', 'agent', 'ag-argon', 'admin'),
    ],
    workspaceGrants: [
      wg('ws-build', 'org-yulan', 'u-tom', 'owner'), wg('ws-ops', 'org-yulan', 'u-tom', 'owner'),
      wg('ws-home', 'org-household', 'u-tom', 'admin'), wg('ws-studio', 'org-studio', 'u-tom', 'member'),
      wg('ws-audit-granted', 'org-audit', 'u-tom', 'guest'), wg('ws-build', 'org-yulan', 'u-member', 'member'),
      wg('ws-build', 'org-yulan', 'u-guest', 'guest'),
    ],
    channelMemberships: [
      { channel_id: 'ch-sec', workspace_id: 'ws-build', principal_kind: 'user', principal_id: 'u-tom', role: 'owner', notify_pref: 'all', joined_at: now },
    ],
  };
}

interface FakeEl extends OrgDomElement {
  children: Array<FakeEl | string>;
  attrs: Map<string, string>;
  trigger(type: string, event?: { key?: string; preventDefault?(): void }): void;
}

function createFakeDomDoc(): { doc: OrgDomDocument; getFocused: () => FakeEl | null } {
  let focused: FakeEl | null = null;
  const makeEl = (tag: string): FakeEl => {
    const attrs = new Map<string, string>();
    const children: Array<FakeEl | string> = [];
    const dataset: Record<string, string | undefined> = {};
    const listeners = new Map<string, Array<(event: { key?: string; preventDefault?(): void }) => void>>();
    const el: FakeEl = {
      tagName: tag.toUpperCase(), className: '', id: '', textContent: null, hidden: false, dataset, children, attrs,
      setAttribute(name: string, value: string) { attrs.set(name, value); },
      getAttribute(name: string) { return attrs.get(name) ?? null; },
      append(...nodes: Array<OrgDomElement | string>) { children.push(...(nodes as Array<FakeEl | string>)); },
      focus() { focused = el; },
      addEventListener(type: string, fn: (event: { key?: string; preventDefault?(): void }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      trigger(type: string, event: { key?: string; preventDefault?(): void } = { preventDefault() {} }) {
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
    };
    return el;
  };
  return { doc: { createElement: makeEl }, getFocused: () => focused };
}

test('multi-org switcher renders 4 role tiers, org unread totals, menu ARIA roles, keyboard navigation, and action callbacks', () => {
  const state = createMultiOrgFixture();
  const caller = { principal_kind: 'user' as const, principal_id: 'u-tom' };
  const vm = deriveOrgHeaderSwitcherVM(state, caller, {
    activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', switcherOpen: true,
    unreadCounts: { design: 3, 'sec-incident': 2 }, orgUnreadCounts: { household: 4 },
  });

  assert.deepEqual(
    vm.organizations.map((o) => [o.slug, o.role, o.roleLabel, o.current, o.unreadCount, o.unreadBadge]),
    [
      ['yulan', 'owner', 'Owner', true, 5, '5'],
      ['household', 'admin', 'Admin', false, 4, '4'],
      ['ridge-studio', 'member', 'Member', false, 0, null],
      ['external-audit', 'guest', 'Guest', false, 0, null],
    ],
  );

  const { identityHtml, popoverHtml } = renderOrgHeaderSwitcherHtml(vm);
  assert.match(identityHtml, /id="org-trigger"/);
  assert.match(popoverHtml, /role="menu"/);
  assert.match(popoverHtml, /role="menuitemradio" aria-checked="true"/);
  assert.match(popoverHtml, /data-org-unread-count="5"/);
  for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
    assert.match(popoverHtml, new RegExp(`data-org-item-role-badge="${role}">${ORG_ROLE_LABELS[role]}<`));
  }
  for (const act of ORG_SWITCHER_ACTIONS) assert.ok(popoverHtml.includes(act.label));

  const { doc, getFocused } = createFakeDomDoc();
  const calls: string[] = [];
  const dom = buildOrgHeaderSwitcherDom(doc, vm, {
    onSelectOrg: (id, slug) => calls.push(`select:${id}:${slug}`),
    onToggleOrgSwitcher: (open) => calls.push(`toggle:${open}`),
    onOpenOrgMembers: () => calls.push('action:org-members'),
    onOpenOrgSettingsLogo: () => calls.push('action:org-settings-logo'),
    onCreateOrganization: () => calls.push('action:new-organization'),
  });
  const orgTrigger = (dom.identityEl as FakeEl).children[0] as FakeEl;
  const pop = dom.popoverEl as FakeEl;
  const popButtons = pop.children.filter((c): c is FakeEl => typeof c !== 'string');

  assert.equal(pop.attrs.get('role'), 'menu');
  assert.equal(popButtons[0]?.attrs.get('role'), 'menuitemradio');
  assert.equal(popButtons[0]?.attrs.get('aria-checked'), 'true');
  assert.equal(popButtons[0]?.dataset.orgUnreadCount, '5');

  pop.trigger('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(getFocused()?.dataset.orgSlug, 'household');
  pop.trigger('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(getFocused()?.dataset.orgSlug, 'yulan');
  pop.trigger('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(pop.hidden, true);
  assert.equal(getFocused(), orgTrigger);

  for (const actBtn of popButtons.filter((b) => b.dataset.orgAction)) actBtn.trigger('click');
  assert.ok(calls.includes('action:org-members'));
  assert.ok(calls.includes('action:org-settings-logo'));
  assert.ok(calls.includes('action:new-organization'));
});

test('org logo renders 32x32 rounded-square image when logo_object_key is set and named upload placeholder when null', () => {
  const state = createMultiOrgFixture();
  const caller = { principal_kind: 'user' as const, principal_id: 'u-tom' };

  const withLogoVm = deriveOrgHeaderSwitcherVM(state, caller, { activeOrgId: 'org-yulan' });
  const withLogoHtml = renderOrgLogoBadgeHtml(withLogoVm.activeOrg, 32);
  assert.match(withLogoHtml, /data-org-logo="orgs\/org-yulan\/logo\/64\.png"/);
  assert.doesNotMatch(withLogoHtml, /data-org-logo-upload-placeholder/);

  const withoutLogoVm = deriveOrgHeaderSwitcherVM(state, caller, { activeOrgId: 'org-household' });
  const placeholderHtml = renderOrgLogoBadgeHtml(withoutLogoVm.activeOrg, 32);
  assert.match(placeholderHtml, /data-org-logo-placeholder="LH"/);
  assert.match(placeholderHtml, /role="img"/);
  assert.match(placeholderHtml, /aria-label="Upload organization logo for Langridge Household"/);
});

test('workspace selector enforces canReadWorkspace and blocks revoked user or owner-revoked agent grants from appearing joinable', () => {
  const state = createMultiOrgFixture();
  const memberCaller = { principal_kind: 'user' as const, principal_id: 'u-member' };
  const guestCaller = { principal_kind: 'user' as const, principal_id: 'u-guest' };
  const agentCaller = { principal_kind: 'agent' as const, principal_id: 'ag-argon' };

  const memberNav = deriveWorkspaceChannelNavVM(state, memberCaller, { activeOrgId: 'org-yulan', workspaceMenuOpen: true });
  assert.deepEqual(
    memberNav.workspaces.map((w) => [w.slug, w.granted, w.joinable]),
    [['commonswarm-build', true, false], ['operations', false, true], ['customer-advisory', false, true]],
  );

  const revokedUserState: OrgChannelAuthorityState = {
    ...state,
    workspaceGrants: [
      ...state.workspaceGrants.map((g) => g.workspace_id === 'ws-build' && g.principal_id === 'u-member' ? { ...g, revoked_at: '2026-10-21T01:00:00Z' } : g),
      { workspace_id: 'ws-ops', org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-member', role: 'member', created_at: '2026-10-21T00:00:00Z', revoked_at: '2026-10-21T01:00:00Z' },
    ],
  };
  const revokedMemberNav = deriveWorkspaceChannelNavVM(revokedUserState, memberCaller, { activeOrgId: 'org-yulan' });
  assert.deepEqual(revokedMemberNav.workspaces.map((w) => [w.slug, w.granted, w.joinable]), [['customer-advisory', false, true]]);

  const agentBefore = deriveWorkspaceChannelNavVM(state, agentCaller, { activeOrgId: 'org-yulan' });
  assert.deepEqual(agentBefore.workspaces.map((w) => [w.slug, w.granted, w.joinable]), [['commonswarm-build', true, false], ['operations', true, false]]);

  const ownerRevokedState: OrgChannelAuthorityState = {
    ...state,
    workspaceGrants: state.workspaceGrants.map((g) => g.workspace_id === 'ws-ops' && g.principal_id === 'u-tom' ? { ...g, revoked_at: '2026-10-21T01:00:00Z' } : g),
  };
  const agentAfterOwnerRevoke = deriveWorkspaceChannelNavVM(ownerRevokedState, agentCaller, { activeOrgId: 'org-yulan' });
  assert.deepEqual(agentAfterOwnerRevoke.workspaces.map((w) => [w.slug, w.granted, w.joinable]), [['commonswarm-build', true, false]]);

  const guestNav = deriveWorkspaceChannelNavVM(state, guestCaller, { activeOrgId: 'org-yulan', workspaceMenuOpen: true });
  assert.deepEqual(guestNav.workspaces.map((w) => w.slug), ['commonswarm-build']);
  assert.doesNotMatch(renderWorkspaceSwitcherMenuHtml(guestNav), /\+ New Workspace/);
});

test('privateChannelsEnabled defaults to false (fail-closed), member filters work, and topbar reflects mode', () => {
  const state = createMultiOrgFixture();
  const caller = { principal_kind: 'user' as const, principal_id: 'u-tom' };

  const defaultOffVm = deriveWorkspaceChannelNavVM({ ...state, privateChannelsEnabled: undefined }, caller, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build' });
  assert.deepEqual(defaultOffVm.channels.map((c) => c.slug), ['general', 'design']);

  const chatVm = deriveWorkspaceChannelNavVM(state, caller, {
    activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', activeChannelId: 'ch-sec', mode: 'chat',
    unreadCounts: { design: 3, 'sec-incident': 150 },
    threadsByChannel: { 'sec-incident': [{ threadId: 'th-1', title: 'Audit log check', replyCount: 2 }] },
  });
  assert.deepEqual(
    chatVm.channels.map((c) => [c.slug, c.visibility, c.prefix, c.unreadBadge, c.current]),
    [['general', 'workspace', '#', null, false], ['design', 'workspace', '#', '3', false], ['sec-incident', 'private', 'lock', '99+', true]],
  );
  assert.equal(formatUnreadCountPill(0), null);
  assert.equal(formatUnreadCountPill(120), '99+');

  const chatPaneHtml = renderModeContextualListPaneHtml(chatVm);
  assert.doesNotMatch(chatPaneHtml, /cs-workspace-quick-links/);

  const privShellHtml = renderKylonOrgShellHtml(chatVm);
  assert.match(privShellHtml, /<span id="screen-title">sec-incident<\/span>/);
  assert.match(privShellHtml, /id="screen-visibility-badge">Private<\/span>/);
  assert.match(privShellHtml, /data-room-symbol="lock"/);

  const agentsOnlyVm = deriveWorkspaceChannelNavVM(state, caller, { activeOrgId: 'org-yulan', mode: 'members', memberFilter: 'agents' });
  assert.deepEqual(agentsOnlyVm.members.map((m) => m.displayName), ['Argon']);
  const agentsPaneHtml = renderModeContextualListPaneHtml(agentsOnlyVm);
  assert.match(agentsPaneHtml, /data-member-filter="agents" aria-pressed="true"/);
  assert.doesNotMatch(agentsPaneHtml, /data-channel-list/);

  const guestsOnlyVm = deriveWorkspaceChannelNavVM(state, caller, { activeOrgId: 'org-yulan', mode: 'members', memberFilter: 'guests' });
  assert.deepEqual(guestsOnlyVm.members.map((m) => m.principalId), ['u-guest']);

  const wikiVm = deriveWorkspaceChannelNavVM(state, caller, { activeOrgId: 'org-yulan', mode: 'wiki', mobileDrawerOpen: true });
  assert.doesNotMatch(renderModeContextualListPaneHtml(wikiVm), /data-channel-list/);
  const wikiShellHtml = renderKylonOrgShellHtml(wikiVm);
  assert.match(wikiShellHtml, /<span id="screen-title">Wiki<\/span>/);
  assert.match(wikiShellHtml, /id="sidebar"[^>]*role="dialog" aria-modal="true"/);
  assert.match(wikiShellHtml, /id="main" tabindex="-1" inert/);
});

test('all 38 preserved hooks across chat/members/wiki modes, scoped Kylon v0.3 CSS, and <= 4,500 token budget', () => {
  assert.equal(PRESERVED_SHELL_HOOKS.length, 38);
  const state = createMultiOrgFixture();
  const caller = { principal_kind: 'user' as const, principal_id: 'u-tom' };
  const specimenHtml = readFileSync(resolve(REPO_ROOT, 'site/src/components/app/live-dashboard/org-shell/specimen.html'), 'utf8');

  for (const mode of ['chat', 'members', 'wiki'] as const) {
    const vm = deriveWorkspaceChannelNavVM(state, caller, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', mode });
    const shellHtml = renderKylonOrgShellHtml(vm);
    assert.doesNotMatch(shellHtml, /class="app[^"]*"[^>]*data-home-workspace-shell/);
    assert.doesNotMatch(shellHtml, /class="workspace"[^>]*data-home-route-pane/);
    for (const hook of PRESERVED_SHELL_HOOKS) {
      const needle = hook.startsWith('#') ? `id="${hook.slice(1)}"` : hook.slice(1, -1);
      assert.ok(shellHtml.includes(needle), `shellHtml (${mode}) missing preserved hook ${hook}`);
      assert.ok(specimenHtml.includes(needle), `specimen.html missing preserved hook ${hook}`);
    }
  }

  const css = readFileSync(resolve(REPO_ROOT, 'site/src/components/app/live-dashboard/org-shell/org-shell.css'), 'utf8');
  assert.doesNotMatch(css, /\/Users\//);
  assert.doesNotMatch(css, /^body\s*\{/m);
  for (const [token, val] of [
    ['--cs-canvas', '#f5f5f2'], ['--cs-surface', '#ffffff'], ['--cs-subtle', '#f5f5f2'], ['--cs-selected', '#eeefea'],
    ['--cs-ink', '#282720'], ['--cs-secondary', '#655e53'], ['--cs-muted', '#716b60'], ['--cs-line', '#e9e7e2'],
    ['--cs-control', '#7e887c'], ['--cs-accent', '#697344'], ['--cs-focus', '#586339'],
    ['--cs-rail', '52px'], ['--cs-sidebar', '390px'], ['--cs-radius-panel', '0px'],
  ] as const) {
    assert.match(css, new RegExp(`${token}:\\s*${val}`));
  }

  for (const relPath of [
    'site/src/components/app/live-dashboard/org-shell/org-header-switcher.ts',
    'site/src/components/app/live-dashboard/org-shell/workspace-channel-nav.ts',
    'site/src/components/app/live-dashboard/org-shell/org-shell.css',
    'site/src/components/app/live-dashboard/org-shell/specimen.html',
    'tests/org-channels/slice4-ui-shell.test.ts',
  ]) {
    const content = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
    const estimatedTokens = Math.ceil(content.length / 4);
    assert.ok(estimatedTokens <= 4500, `${relPath} exceeds 4,500 tokens: ${estimatedTokens} tokens (${content.length} chars)`);
  }
});
