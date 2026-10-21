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
  return {
    privateChannelsEnabled: true,
    organizations: [
      { id: 'org-yulan', slug: 'yulan', display_name: 'Yulan Ventures', logo_object_key: 'orgs/org-yulan/logo/64.png', logo_updated_at: now, created_by: 'u-tom', created_at: now, updated_at: now },
      { id: 'org-household', slug: 'household', display_name: 'Langridge Household', logo_object_key: null, created_by: 'u-tom', created_at: now, updated_at: now },
      { id: 'org-studio', slug: 'ridge-studio', display_name: 'Ridge Partner Studio', logo_object_key: null, created_by: 'u-partner', created_at: now, updated_at: now },
      { id: 'org-audit', slug: 'external-audit', display_name: 'External Design Review', logo_object_key: null, created_by: 'u-auditor', created_at: now, updated_at: now },
    ],
    workspaces: [
      { workspace_id: 'ws-build', org_id: 'org-yulan', slug: 'commonswarm-build', name: 'CommonSwarm Build' },
      { workspace_id: 'ws-ops', org_id: 'org-yulan', slug: 'operations', name: 'Operations' },
      { workspace_id: 'ws-open', org_id: 'org-yulan', slug: 'customer-advisory', name: 'Customer Advisory' },
      { workspace_id: 'ws-home', org_id: 'org-household', slug: 'family-hub', name: 'Family Hub' },
      { workspace_id: 'ws-studio', org_id: 'org-studio', slug: 'design-systems', name: 'Design Systems' },
      { workspace_id: 'ws-audit-granted', org_id: 'org-audit', slug: 'shared-review', name: 'Shared Review Room' },
      { workspace_id: 'ws-audit-internal', org_id: 'org-audit', slug: 'internal-audit', name: 'Internal Audit Only' },
    ],
    channels: [
      { channel_id: 'ch-gen', workspace_id: 'ws-build', slug: 'general', topic: 'Shared coordination across people and agents', visibility: 'workspace', join_policy: 'open' },
      { channel_id: 'ch-design', workspace_id: 'ws-build', slug: 'design', topic: 'Kylon shell geometry and token review', visibility: 'workspace', join_policy: 'open' },
      { channel_id: 'ch-sec', workspace_id: 'ws-build', slug: 'sec-incident', topic: 'Private incident coordination', visibility: 'private', join_policy: 'invite_only' },
      { channel_id: 'ch-hidden-priv', workspace_id: 'ws-build', slug: 'exec-comp', topic: 'Restricted private channel', visibility: 'private', join_policy: 'invite_only' },
    ],
    agentIdentities: [{ id: 'ag-argon', owner_user_id: 'u-tom', display_name: 'Argon', created_at: now }],
    orgMemberships: [
      { org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-tom', role: 'owner', created_at: now },
      { org_id: 'org-household', principal_kind: 'user', principal_id: 'u-tom', role: 'admin', created_at: now },
      { org_id: 'org-studio', principal_kind: 'user', principal_id: 'u-tom', role: 'member', created_at: now },
      { org_id: 'org-audit', principal_kind: 'user', principal_id: 'u-tom', role: 'guest', created_at: now },
      { org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-member', role: 'member', created_at: now },
      { org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-guest', role: 'guest', created_at: now },
      { org_id: 'org-yulan', principal_kind: 'agent', principal_id: 'ag-argon', role: 'admin', created_at: now },
    ],
    workspaceGrants: [
      { workspace_id: 'ws-build', org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-tom', role: 'owner', created_at: now },
      { workspace_id: 'ws-ops', org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-tom', role: 'owner', created_at: now },
      { workspace_id: 'ws-home', org_id: 'org-household', principal_kind: 'user', principal_id: 'u-tom', role: 'admin', created_at: now },
      { workspace_id: 'ws-studio', org_id: 'org-studio', principal_kind: 'user', principal_id: 'u-tom', role: 'member', created_at: now },
      { workspace_id: 'ws-audit-granted', org_id: 'org-audit', principal_kind: 'user', principal_id: 'u-tom', role: 'guest', created_at: now },
      { workspace_id: 'ws-build', org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-member', role: 'member', created_at: now },
      { workspace_id: 'ws-build', org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-guest', role: 'guest', created_at: now },
    ],
    channelMemberships: [
      { channel_id: 'ch-sec', workspace_id: 'ws-build', principal_kind: 'user', principal_id: 'u-tom', role: 'owner', notify_pref: 'all', joined_at: now },
    ],
  };
}

function createFakeDomDoc(): OrgDomDocument {
  const makeEl = (tag: string): OrgDomElement => {
    const attrs = new Map<string, string>();
    const children: Array<OrgDomElement | string> = [];
    const dataset: Record<string, string | undefined> = {};
    return {
      tagName: tag.toUpperCase(),
      className: '',
      id: '',
      textContent: null,
      hidden: false,
      dataset,
      setAttribute(name: string, value: string) { attrs.set(name, value); },
      append(...nodes: Array<OrgDomElement | string>) { children.push(...nodes); },
    };
  };
  return { createElement: makeEl };
}

test('multi-org switcher renders all 4 role tiers (Owner | Admin | Member | Guest) and required switcher actions', () => {
  const state = createMultiOrgFixture();
  const caller = { principal_kind: 'user' as const, principal_id: 'u-tom' };
  const vm = deriveOrgHeaderSwitcherVM(state, caller, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', switcherOpen: true });

  assert.equal(vm.organizations.length, 4);
  assert.deepEqual(
    vm.organizations.map((o) => [o.slug, o.role, o.roleLabel, o.current]),
    [
      ['yulan', 'owner', 'Owner', true],
      ['household', 'admin', 'Admin', false],
      ['ridge-studio', 'member', 'Member', false],
      ['external-audit', 'guest', 'Guest', false],
    ],
  );

  const { identityHtml, popoverHtml } = renderOrgHeaderSwitcherHtml(vm);
  assert.match(identityHtml, /id="org-trigger"/);
  assert.match(identityHtml, /id="org-name"/);
  assert.match(identityHtml, /Yulan Ventures/);
  assert.match(identityHtml, /data-org-role-badge="owner">Owner</);
  assert.match(identityHtml, /id="workspace-trigger"/);
  assert.match(identityHtml, /CommonSwarm Build/);

  for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
    assert.match(popoverHtml, new RegExp(`data-org-item-role-badge="${role}">${ORG_ROLE_LABELS[role]}<`));
  }
  for (const act of ORG_SWITCHER_ACTIONS) {
    assert.ok(popoverHtml.includes(act.label), `missing switcher action: ${act.label}`);
  }

  const dom = buildOrgHeaderSwitcherDom(createFakeDomDoc(), vm);
  assert.equal(dom.identityEl.dataset.orgHeaderIdentity, 'yulan');
  assert.equal(dom.popoverEl.hidden, false);
});

test('org logo renders 32x32 rounded-square image when logo_object_key is set and named upload placeholder when null', () => {
  const state = createMultiOrgFixture();
  const caller = { principal_kind: 'user' as const, principal_id: 'u-tom' };

  const withLogoVm = deriveOrgHeaderSwitcherVM(state, caller, { activeOrgId: 'org-yulan' });
  assert.equal(withLogoVm.activeOrg.hasCustomLogo, true);
  assert.equal(withLogoVm.activeOrg.logoObjectKey, 'orgs/org-yulan/logo/64.png');
  const withLogoHtml = renderOrgLogoBadgeHtml(withLogoVm.activeOrg, 32);
  assert.match(withLogoHtml, /data-org-logo="orgs\/org-yulan\/logo\/64\.png"/);
  assert.match(withLogoHtml, /width="32" height="32"/);
  assert.doesNotMatch(withLogoHtml, /data-org-logo-upload-placeholder/);

  const withoutLogoVm = deriveOrgHeaderSwitcherVM(state, caller, { activeOrgId: 'org-household' });
  assert.equal(withoutLogoVm.activeOrg.hasCustomLogo, false);
  assert.equal(withoutLogoVm.activeOrg.logoObjectKey, null);
  assert.equal(withoutLogoVm.activeOrg.logoInitials, 'LH');
  const placeholderHtml = renderOrgLogoBadgeHtml(withoutLogoVm.activeOrg, 32);
  assert.match(placeholderHtml, /data-org-logo-placeholder="LH"/);
  assert.match(placeholderHtml, /data-org-logo-upload-placeholder="true"/);
  assert.match(placeholderHtml, /aria-label="Upload organization logo for Langridge Household"/);
});

test('workspace selector filters workspaces for Guest vs Member and respects explicit revocation', () => {
  const state = createMultiOrgFixture();
  const memberCaller = { principal_kind: 'user' as const, principal_id: 'u-member' };
  const guestCaller = { principal_kind: 'user' as const, principal_id: 'u-guest' };

  const memberNav = deriveWorkspaceChannelNavVM(state, memberCaller, { activeOrgId: 'org-yulan', workspaceMenuOpen: true });
  assert.equal(memberNav.canCreateWorkspace, true);
  assert.deepEqual(
    memberNav.workspaces.map((w) => [w.slug, w.granted, w.joinable]),
    [
      ['commonswarm-build', true, false],
      ['operations', false, true],
      ['customer-advisory', false, true],
    ],
  );
  const memberWsMenuHtml = renderWorkspaceSwitcherMenuHtml(memberNav);
  assert.match(memberWsMenuHtml, /\+ New Workspace/);
  assert.match(memberWsMenuHtml, /Workspace Members/);

  const guestNav = deriveWorkspaceChannelNavVM(state, guestCaller, { activeOrgId: 'org-yulan', workspaceMenuOpen: true });
  assert.equal(guestNav.canCreateWorkspace, false);
  assert.deepEqual(guestNav.workspaces.map((w) => w.slug), ['commonswarm-build']);
  const guestWsMenuHtml = renderWorkspaceSwitcherMenuHtml(guestNav);
  assert.doesNotMatch(guestWsMenuHtml, /\+ New Workspace/);

  const tomGuestInAudit = deriveWorkspaceChannelNavVM(state, { principal_kind: 'user', principal_id: 'u-tom' }, { activeOrgId: 'org-audit' });
  assert.deepEqual(tomGuestInAudit.workspaces.map((w) => w.slug), ['shared-review']);
});

test('channel navigation renders # public vs lock private channel badges, unread pills, and mode-contextual 390px pane', () => {
  const state = createMultiOrgFixture();
  const caller = { principal_kind: 'user' as const, principal_id: 'u-tom' };

  const chatVm = deriveWorkspaceChannelNavVM(state, caller, {
    activeOrgId: 'org-yulan',
    activeWorkspaceId: 'ws-build',
    activeChannelId: 'ch-sec',
    mode: 'chat',
    unreadCounts: { design: 3, 'sec-incident': 150 },
    threadsByChannel: { 'sec-incident': [{ threadId: 'th-1', title: 'Audit log check', replyCount: 2 }] },
  });

  assert.deepEqual(
    chatVm.channels.map((c) => [c.slug, c.visibility, c.prefix, c.unreadBadge, c.current]),
    [
      ['general', 'workspace', '#', null, false],
      ['design', 'workspace', '#', '3', false],
      ['sec-incident', 'private', 'lock', '99+', true],
    ],
  );
  assert.equal(formatUnreadCountPill(0), null);
  assert.equal(formatUnreadCountPill(7), '7');
  assert.equal(formatUnreadCountPill(120), '99+');

  const chatPaneHtml = renderModeContextualListPaneHtml(chatVm);
  assert.match(chatPaneHtml, /data-mode-pane="chat"/);
  assert.match(chatPaneHtml, /data-channel-prefix="#"/);
  assert.match(chatPaneHtml, /data-channel-prefix="lock"/);
  assert.match(chatPaneHtml, /data-channel-lock-icon="true"/);
  assert.match(chatPaneHtml, /data-channel-unread-count="3">3</);
  assert.match(chatPaneHtml, /data-channel-unread-count="150">99\+</);
  assert.match(chatPaneHtml, /data-channel-threads="sec-incident"/);
  assert.match(chatPaneHtml, /\+ New Channel/);

  const privFilterVm = deriveWorkspaceChannelNavVM(state, caller, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', channelFilter: 'private' });
  assert.deepEqual(privFilterVm.visibleChannels.map((c) => c.slug), ['sec-incident']);

  const membersVm = deriveWorkspaceChannelNavVM(state, caller, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', mode: 'members' });
  const membersPaneHtml = renderModeContextualListPaneHtml(membersVm);
  assert.match(membersPaneHtml, /data-mode-pane="members"/);
  assert.match(membersPaneHtml, /data-org-member-roster="true"/);
  assert.doesNotMatch(membersPaneHtml, /data-channel-list/);

  const wikiVm = deriveWorkspaceChannelNavVM(state, caller, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', mode: 'wiki' });
  const wikiPaneHtml = renderModeContextualListPaneHtml(wikiVm);
  assert.match(wikiPaneHtml, /data-mode-pane="wiki"/);
  assert.match(wikiPaneHtml, /data-wiki-document-list="true"/);
  assert.doesNotMatch(wikiPaneHtml, /data-channel-list/);
});

test('hook preservation, Kylon v0.3 CSS tokens, and <= 4,500 token budget compliance', () => {
  const state = createMultiOrgFixture();
  const caller = { principal_kind: 'user' as const, principal_id: 'u-tom' };
  const vm = deriveWorkspaceChannelNavVM(state, caller, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build' });
  const shellHtml = renderKylonOrgShellHtml(vm);
  const specimenHtml = readFileSync(resolve(REPO_ROOT, 'site/src/components/app/live-dashboard/org-shell/specimen.html'), 'utf8');

  for (const hook of PRESERVED_SHELL_HOOKS) {
    if (hook.startsWith('#')) {
      const id = hook.slice(1);
      assert.ok(shellHtml.includes(`id="${id}"`), `shellHtml missing preserved ID hook ${hook}`);
      assert.ok(specimenHtml.includes(`id="${id}"`), `specimen.html missing preserved ID hook ${hook}`);
    } else {
      const attr = hook.slice(1, -1);
      assert.ok(shellHtml.includes(attr), `shellHtml missing preserved data hook ${hook}`);
      assert.ok(specimenHtml.includes(attr), `specimen.html missing preserved data hook ${hook}`);
    }
  }

  const css = readFileSync(resolve(REPO_ROOT, 'site/src/components/app/live-dashboard/org-shell/org-shell.css'), 'utf8');
  const expectedTokens: Array<[string, string]> = [
    ['--cs-canvas', '#f5f5f2'],
    ['--cs-surface', '#ffffff'],
    ['--cs-subtle', '#f5f5f2'],
    ['--cs-selected', '#eeefea'],
    ['--cs-ink', '#282720'],
    ['--cs-secondary', '#655e53'],
    ['--cs-muted', '#716b60'],
    ['--cs-line', '#e9e7e2'],
    ['--cs-control', '#7e887c'],
    ['--cs-accent', '#697344'],
    ['--cs-focus', '#586339'],
    ['--cs-rail', '52px'],
    ['--cs-sidebar', '390px'],
    ['--cs-radius-panel', '0px'],
  ];
  for (const [token, val] of expectedTokens) {
    assert.match(css, new RegExp(`${token}:\\s*${val}`), `org-shell.css missing ${token}: ${val}`);
  }

  const ownedFiles = [
    'site/src/components/app/live-dashboard/org-shell/org-header-switcher.ts',
    'site/src/components/app/live-dashboard/org-shell/workspace-channel-nav.ts',
    'site/src/components/app/live-dashboard/org-shell/org-shell.css',
    'site/src/components/app/live-dashboard/org-shell/specimen.html',
    'tests/org-channels/slice4-ui-shell.test.ts',
  ];
  for (const relPath of ownedFiles) {
    const content = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
    const estimatedTokens = Math.ceil(content.length / 4);
    assert.ok(
      estimatedTokens <= 4500,
      `${relPath} exceeds 4,500 tokens: ${estimatedTokens} tokens (${content.length} chars)`,
    );
  }
});
