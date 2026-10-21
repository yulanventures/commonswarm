import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OrgChannelAuthorityState } from '../../src/protocol/org-channels-contract.js';
import { ORG_ROLE_LABELS, ORG_SWITCHER_ACTIONS, type OrgDomDocument, type OrgDomElement, buildOrgHeaderSwitcherDom, deriveOrgHeaderSwitcherVM, renderOrgHeaderSwitcherHtml, renderOrgLogoBadgeHtml } from '../../site/src/components/app/live-dashboard/org-shell/org-header-switcher.js';
import { PRESERVED_SHELL_HOOKS, bindWorkspaceChannelNavDom, deriveWorkspaceChannelNavVM, formatUnreadCountPill, renderKylonOrgShellHtml, renderModeContextualListPaneHtml, renderWorkspaceSwitcherMenuHtml } from '../../site/src/components/app/live-dashboard/org-shell/workspace-channel-nav.js';

const eq = assert.equal, deq = assert.deepEqual, REPO_ROOT = resolve(import.meta.dirname, '../..'), ORG_SHELL_DIR = 'site/src/components/app/live-dashboard/org-shell';

function fixture(): OrgChannelAuthorityState {
  const now = '2026-10-21T00:00:00Z';
  const org = (id: string, slug: string, display_name: string, logo_object_key: string | null = null, created_by = 'u-tom') => ({
    id, slug, display_name, logo_object_key, ...(logo_object_key ? { logo_updated_at: now } : {}), created_by, created_at: now, updated_at: now,
  });
  const ws = (workspace_id: string, org_id: string, slug: string, name: string, join_policy?: 'open' | 'invite_only') => ({ workspace_id, org_id, slug, name, ...(join_policy ? { join_policy } : {}) });
  const ch = (channel_id: string, slug: string, visibility: 'workspace' | 'private') => ({
    channel_id, workspace_id: 'ws-build', slug, topic: slug, visibility, join_policy: (visibility === 'private' ? 'invite_only' : 'open') as 'open' | 'invite_only',
  });
  return {
    privateChannelsEnabled: true,
    organizations: [
      org('org-yulan', 'yulan', 'Yulan Ventures', 'orgs/org-yulan/logo/64.png'), org('org-household', 'household', 'Langridge Household'),
      org('org-studio', 'ridge-studio', 'Ridge Partner Studio', null, 'u-partner'), org('org-audit', 'external-audit', 'External Design Review', null, 'u-auditor'),
    ],
    workspaces: [
      ws('ws-build', 'org-yulan', 'commonswarm-build', 'CommonSwarm Build'), ws('ws-ops', 'org-yulan', 'operations', 'Operations'),
      ws('ws-open', 'org-yulan', 'customer-advisory', 'Customer Advisory', 'open'), ws('ws-home', 'org-household', 'family-hub', 'Family Hub'),
      ws('ws-studio', 'org-studio', 'design-systems', 'Design Systems'), ws('ws-audit-granted', 'org-audit', 'shared-review', 'Shared Review Room'),
      ws('ws-audit-internal', 'org-audit', 'internal-audit', 'Internal Audit Only'),
    ],
    channels: [ch('ch-gen', 'general', 'workspace'), ch('ch-design', 'design', 'workspace'), ch('ch-sec', 'sec-incident', 'private'), ch('ch-hidden-priv', 'exec-comp', 'private')],
    agentIdentities: [{ id: 'ag-argon', owner_user_id: 'u-tom', display_name: 'Argon', created_at: now }],
    orgMemberships: ([['org-yulan','user','u-tom','owner'],['org-household','user','u-tom','admin'],['org-studio','user','u-tom','member'],['org-audit','user','u-tom','guest'],['org-yulan','user','u-member','member'],['org-yulan','user','u-guest','guest'],['org-yulan','agent','ag-argon','admin']] as const).map(([org_id, principal_kind, principal_id, role]) => ({ org_id, principal_kind, principal_id, role, created_at: now })),
    workspaceGrants: ([['ws-build','org-yulan','u-tom','owner'],['ws-ops','org-yulan','u-tom','owner'],['ws-home','org-household','u-tom','admin'],['ws-studio','org-studio','u-tom','member'],['ws-audit-granted','org-audit','u-tom','guest'],['ws-build','org-yulan','u-member','member'],['ws-build','org-yulan','u-guest','guest']] as const).map(([workspace_id, org_id, principal_id, role]) => ({ workspace_id, org_id, principal_kind: 'user' as const, principal_id, role, created_at: now })),
    channelMemberships: [{ channel_id: 'ch-sec', workspace_id: 'ws-build', principal_kind: 'user', principal_id: 'u-tom', role: 'owner', notify_pref: 'all', joined_at: now }],
  };
}

interface FakeEl extends OrgDomElement { children: Array<FakeEl | string>; attrs: Map<string, string>; trigger(type: string, event?: { key?: string; preventDefault?(): void }): void; }

function fakeDoc(): { doc: OrgDomDocument; getFocused: () => FakeEl | null } {
  let focused: FakeEl | null = null;
  const makeEl = (tag: string): FakeEl => {
    const attrs = new Map<string, string>(), children: Array<FakeEl | string> = [], dataset: Record<string, string | undefined> = {}, ls = new Map<string, Array<(e: { key?: string; preventDefault?(): void }) => void>>();
    const el: FakeEl = {
      tagName: tag.toUpperCase(), className: '', id: '', textContent: null, hidden: false, dataset, children, attrs,
      setAttribute: (k, v) => { attrs.set(k, v); }, getAttribute: (k) => attrs.get(k) ?? null,
      append: (...n) => { children.push(...(n as Array<FakeEl | string>)); }, focus: () => { focused = el; },
      addEventListener: (t, fn) => { ls.set(t, [...(ls.get(t) ?? []), fn]); },
      trigger: (t, ev = { preventDefault() {} }) => { for (const fn of ls.get(t) ?? []) fn(ev); },
    };
    return el;
  };
  return { doc: { createElement: makeEl }, getFocused: () => focused };
}

const u = (principal_id: string) => ({ principal_kind: 'user' as const, principal_id });
const ag = (principal_id: string) => ({ principal_kind: 'agent' as const, principal_id });

test('switcher renders 4 role tiers, unread totals, ARIA, keyboard nav, and callbacks', () => {
  const s = fixture(), tom = u('u-tom');
  const vm = deriveOrgHeaderSwitcherVM(s, tom, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', switcherOpen: true, unreadCounts: { 'ch-design': 3, 'ch-sec': 2 }, orgUnreadCounts: { 'org-household': 4 } });
  deq(vm.organizations.map((o) => [o.slug, o.role, o.roleLabel, o.current, o.unreadCount, o.unreadBadge]), [
    ['yulan', 'owner', 'Owner', true, 5, '5'], ['household', 'admin', 'Admin', false, 4, '4'], ['ridge-studio', 'member', 'Member', false, 0, null], ['external-audit', 'guest', 'Guest', false, 0, null],
  ]);
  const { identityHtml, popoverHtml } = renderOrgHeaderSwitcherHtml(vm);
  for (const r of [/id="org-trigger"/, /role="menu"/, /role="menuitemradio" aria-checked="true"/, /data-org-unread-count="5"/]) assert.match(identityHtml + popoverHtml, r);
  for (const r of ['owner', 'admin', 'member', 'guest'] as const) assert.match(popoverHtml, new RegExp(`data-org-item-role-badge="${r}">${ORG_ROLE_LABELS[r]}<`));
  for (const act of ORG_SWITCHER_ACTIONS) assert.ok(popoverHtml.includes(act.label));
  const { doc, getFocused } = fakeDoc(), calls: string[] = [];
  const dom = buildOrgHeaderSwitcherDom(doc, vm, {
    onSelectOrg: (id, slug) => calls.push(`select:${id}:${slug}`), onToggleOrgSwitcher: (open) => calls.push(`toggle:${open}`),
    onOpenOrgMembers: () => calls.push('act:m'), onOpenOrgSettingsLogo: () => calls.push('act:s'), onCreateOrganization: () => calls.push('act:n'),
  });
  const orgTrigger = (dom.identityEl as FakeEl).children[0] as FakeEl, pop = dom.popoverEl as FakeEl, btns = pop.children.filter((c): c is FakeEl => typeof c !== 'string');
  eq(pop.attrs.get('role'), 'menu'); eq(pop.dataset.anchorTop, '58px'); eq(pop.dataset.anchorLeft, '64px');
  eq(btns[0]?.attrs.get('role'), 'menuitemradio'); eq(btns[0]?.attrs.get('aria-checked'), 'true'); eq(btns[0]?.dataset.orgUnreadCount, '5');
  pop.trigger('keydown', { key: 'ArrowDown' }); eq(getFocused()?.dataset.orgSlug, 'household');
  pop.trigger('keydown', { key: 'ArrowUp' }); eq(getFocused()?.dataset.orgSlug, 'yulan');
  pop.trigger('keydown', { key: 'Escape' }); eq(pop.hidden, true); eq(getFocused(), orgTrigger);
  for (const b of btns.filter((x) => x.dataset.orgAction)) b.trigger('click');
  for (const a of ['act:m', 'act:s', 'act:n']) assert.ok(calls.includes(a));
});

test('org logo renders 32x32 image when logo_object_key is set and placeholder when null', () => {
  const s = fixture(), tom = u('u-tom');
  const logo = renderOrgLogoBadgeHtml(deriveOrgHeaderSwitcherVM(s, tom, { activeOrgId: 'org-yulan' }).activeOrg, 32);
  assert.match(logo, /data-org-logo="orgs\/org-yulan\/logo\/64\.png"/); assert.doesNotMatch(logo, /data-org-logo-upload-placeholder/);
  const ph = renderOrgLogoBadgeHtml(deriveOrgHeaderSwitcherVM(s, tom, { activeOrgId: 'org-household' }).activeOrg, 32);
  for (const r of [/data-org-logo-placeholder="LH"/, /role="img"/, /aria-label="Upload organization logo for Langridge Household"/]) assert.match(ph, r);
});

test('workspace selector enforces canReadWorkspace and blocks revoked user/agent grants', () => {
  const s = fixture(), mem = u('u-member'), gst = u('u-guest'), agn = ag('ag-argon');
  const mNav = deriveWorkspaceChannelNavVM(s, mem, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-open', workspaceMenuOpen: true });
  eq(mNav.activeWorkspace?.workspaceId, 'ws-build'); eq(mNav.activeWorkspace?.granted, true); eq(mNav.header.activeWorkspace?.workspaceId, 'ws-build');
  deq(mNav.workspaces.map((w) => [w.slug, w.granted, w.joinable]), [['commonswarm-build', true, false], ['customer-advisory', false, true]]);
  const revU: OrgChannelAuthorityState = {
    ...s,
    workspaceGrants: [
      ...s.workspaceGrants.map((g) => (g.workspace_id === 'ws-build' && g.principal_id === 'u-member' ? { ...g, revoked_at: '2026-10-21T01:00:00Z' } : g)),
      { workspace_id: 'ws-ops', org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-member', role: 'member', created_at: '2026-10-21T00:00:00Z', revoked_at: '2026-10-21T01:00:00Z' },
    ],
  };
  deq(deriveWorkspaceChannelNavVM(revU, mem, { activeOrgId: 'org-yulan' }).workspaces.map((w) => [w.slug, w.granted, w.joinable]), [['customer-advisory', false, true]]);
  deq(deriveWorkspaceChannelNavVM(s, agn, { activeOrgId: 'org-yulan' }).workspaces.map((w) => [w.slug, w.granted, w.joinable]), [['commonswarm-build', true, false], ['operations', true, false]]);
  const revO: OrgChannelAuthorityState = { ...s, workspaceGrants: s.workspaceGrants.map((g) => (g.workspace_id === 'ws-ops' && g.principal_id === 'u-tom' ? { ...g, revoked_at: '2026-10-21T01:00:00Z' } : g)) };
  deq(deriveWorkspaceChannelNavVM(revO, agn, { activeOrgId: 'org-yulan' }).workspaces.map((w) => [w.slug, w.granted, w.joinable]), [['commonswarm-build', true, false]]);
  const gNav = deriveWorkspaceChannelNavVM(s, gst, { activeOrgId: 'org-yulan', workspaceMenuOpen: true });
  deq(gNav.workspaces.map((w) => w.slug), ['commonswarm-build']);
  assert.doesNotMatch(renderWorkspaceSwitcherMenuHtml(gNav), /\+ New Workspace/);
  assert.doesNotMatch(renderModeContextualListPaneHtml(gNav), /Create channel|\+ New Channel/);
});

test('privateChannelsEnabled defaults to false (fail-closed), member filters work, and topbar reflects mode', () => {
  const s = fixture(), tom = u('u-tom');
  deq(deriveWorkspaceChannelNavVM({ ...s, privateChannelsEnabled: undefined }, tom, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build' }).channels.map((c) => c.slug), ['general', 'design']);
  const chatVm = deriveWorkspaceChannelNavVM(s, tom, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', activeChannelId: 'ch-sec', mode: 'chat', unreadCounts: { 'ch-design': 3, 'ch-sec': 150 }, threadsByChannel: { 'ch-sec': [{ threadId: 'th-1', title: 'Audit log check', replyCount: 2 }] } });
  deq(chatVm.channels.map((c) => [c.slug, c.visibility, c.prefix, c.unreadBadge, c.current]), [['general', 'workspace', '#', null, false], ['design', 'workspace', '#', '3', false], ['sec-incident', 'private', 'lock', '99+', true]]);
  eq(formatUnreadCountPill(0), null); eq(formatUnreadCountPill(120), '99+');
  assert.doesNotMatch(renderModeContextualListPaneHtml(chatVm), /cs-workspace-quick-links/);
  const privHtml = renderKylonOrgShellHtml(chatVm);
  for (const r of [/<span id="screen-title" data-channel-name>sec-incident<\/span>/, /id="screen-visibility-badge">Private<\/span>/, /data-room-symbol="lock"/]) assert.match(privHtml, r);
  const agVm = deriveWorkspaceChannelNavVM(s, tom, { activeOrgId: 'org-yulan', mode: 'members', memberFilter: 'agents' });
  deq(agVm.members.map((m) => m.displayName), ['Argon']);
  const agPane = renderModeContextualListPaneHtml(agVm);
  assert.match(agPane, /data-member-filter="agents" aria-pressed="true"/);
  assert.doesNotMatch(agPane, /data-channel-list/);
  deq(deriveWorkspaceChannelNavVM(s, tom, { activeOrgId: 'org-yulan', mode: 'members', memberFilter: 'guests' }).members.map((m) => m.principalId), ['u-guest']);
  const wikiVm = deriveWorkspaceChannelNavVM(s, tom, { activeOrgId: 'org-yulan', mode: 'wiki', mobileDrawerOpen: true });
  eq(wikiVm.wikiDocuments.length, 0);
  const wikiPane = renderModeContextualListPaneHtml(wikiVm);
  assert.match(wikiPane, /data-wiki-empty="true"/); assert.doesNotMatch(wikiPane, /data-channel-list/);
  const wikiHtml = renderKylonOrgShellHtml(wikiVm);
  for (const r of [/<span id="screen-title" data-channel-name>Wiki<\/span>/, /id="sidebar"[^>]*role="dialog" aria-modal="true"/, /id="main" tabindex="-1" inert/]) assert.match(wikiHtml, r);
});

test('all 38 preserved hooks, scoped Kylon v0.3 CSS, and <= 4,500 token budget', () => {
  assert.equal(PRESERVED_SHELL_HOOKS.length, 38);
  const s = fixture(), tom = u('u-tom');
  const spec = readFileSync(resolve(REPO_ROOT, `${ORG_SHELL_DIR}/specimen.html`), 'utf8');
  const up = (h: string) => h.replace(/<div[^>]*data-home-rail-slot[^>]*>[\s\S]*?<\/div>/, '<div data-home-rail-slot>r</div>').replace(/<div[^>]*data-home-workspace-shell[^>]*>[\s\S]*?<\/div>/, '<div data-home-workspace-shell="ws-build">s</div>').replace(/<(?:p|span)[^>]*data-rail-account[^>]*>[\s\S]*?<\/(?:p|span)>/, '<span data-rail-account>a</span>').replace(/<span id="screen-title" data-channel-name>[\s\S]*?<\/span>/, '<span id="screen-title" data-channel-name>c</span>').replace(/<p class="topic" id="screen-topic" data-channel-description>[\s\S]*?<\/p>/, '<p class="topic" id="screen-topic" data-channel-description>t</p>');
  const uSpec = up(spec);
  for (const mode of ['chat', 'members', 'wiki'] as const) {
    const sh = renderKylonOrgShellHtml(deriveWorkspaceChannelNavVM(s, tom, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build', mode })), uSh = up(sh);
    assert.doesNotMatch(sh, /data-home-rail-slot[^>]*hidden|data-home-workspace-shell[^>]*hidden|<use href="#i-/);
    for (const p of [/data-theme-toggle/, /data-user-menu-trigger/, /id="hm-ws-title"/, /id="hm-phone-title"/, /id="screen-visibility-badge"/, /<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M/]) assert.match(uSh, p);
    if (mode === 'chat') { assert.match(sh, /data-channel-id="ch-gen"/); assert.doesNotMatch(sh, /data-channel-id="ch-gen"[^>]*data-channel-place/); }
    for (const hook of PRESERVED_SHELL_HOOKS) {
      const n = hook.startsWith('#') ? `id="${hook.slice(1)}"` : hook.slice(1, -1);
      assert.ok(uSh.includes(n)); assert.ok(uSpec.includes(n));
    }
  }
  const chatVm = deriveWorkspaceChannelNavVM(s, tom, { activeOrgId: 'org-yulan', activeWorkspaceId: 'ws-build' });
  const sel: Array<string | null> = [], cbs: string[] = [];
  const mk = (dataset: Record<string, string> = {}) => {
    const attrs = new Map<string, string>(), ls: Array<() => void> = [];
    return { dataset, textContent: '', hidden: false, attrs, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k), addEventListener: (_t: string, fn: () => void) => ls.push(fn), click: () => ls.forEach((fn) => fn()) };
  };
  const allP = mk({ channelPlace: '' }), rGen = mk({ channelId: 'ch-gen', channel: 'general', channelVisibility: 'workspace' }), rSec = mk({ channelId: 'ch-sec', channel: 'sec-incident', channelVisibility: 'private' });
  const places = [allP], tNode = mk(), bNode = mk(), sNode = mk({ roomSymbol: '#' });
  allP.addEventListener('click', () => sel.push(null));
  for (const ch of chatVm.channels) { const lp = mk({ channelPlace: ch.channelId }); lp.addEventListener('click', () => sel.push(ch.channelId)); places.push(lp); }
  bindWorkspaceChannelNavDom((q) => (q === '[data-channel-id]' ? [rGen, rSec] : q === '[data-channel-place]' ? places : q === '[data-channel-place=""]' ? [allP] : q.includes('channel-name') ? [tNode] : q === '#screen-visibility-badge' ? [bNode] : q.includes('room-symbol') ? [sNode] : []), chatVm, { onSelectChannel: (id, sl) => cbs.push(`${id}:${sl ?? ''}`) });
  rSec.click();
  deq(sel, ['ch-sec']); deq(cbs, ['ch-sec:sec-incident']);
  eq(rSec.attrs.get('aria-current'), 'page'); eq(tNode.textContent, 'sec-incident'); eq(bNode.hidden, false); eq(sNode.dataset.roomSymbol, 'lock'); eq(sNode.textContent, 'lock');
  rGen.click();
  eq(bNode.hidden, true); eq(sNode.dataset.roomSymbol, '#'); eq(sNode.textContent, '#');
  allP.click();
  deq(sel, ['ch-sec', 'ch-gen', null]); eq(rSec.attrs.get('aria-current'), undefined);
  const css = readFileSync(resolve(REPO_ROOT, `${ORG_SHELL_DIR}/org-shell.css`), 'utf8');
  assert.doesNotMatch(css, /\/Users\/|^body\s*\{/m);
  for (const [t, v] of [['--cs-canvas', '#f5f5f2'], ['--cs-surface', '#ffffff'], ['--cs-subtle', '#f5f5f2'], ['--cs-selected', '#eeefea'], ['--cs-ink', '#282720'], ['--cs-secondary', '#655e53'], ['--cs-muted', '#716b60'], ['--cs-line', '#e9e7e2'], ['--cs-control', '#7e887c'], ['--cs-accent', '#697344'], ['--cs-focus', '#586339'], ['--cs-rail', '52px'], ['--cs-sidebar', '390px'], ['--cs-radius-panel', '0px']] as const) assert.match(css, new RegExp(`${t}:\\s*${v}`));
  for (const p of ['org-header-switcher.ts', 'workspace-channel-nav.ts', 'org-shell.css', 'specimen.html'].map((f) => `${ORG_SHELL_DIR}/${f}`).concat('tests/org-channels/slice4-ui-shell.test.ts')) {
    const c = readFileSync(resolve(REPO_ROOT, p), 'utf8');
    assert.ok(Math.ceil(c.length / 4) <= 4500, p);
  }
});
