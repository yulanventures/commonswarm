/**
 * Channel leads in the live dashboard: the Channel lead select in a channel's settings, Save's set_channel_lead,
 * and the header's lead pill. Runs the dashboard's own functions, lifted from LiveDashboard.astro, in a vm with a
 * small DOM stand-in; the command edge is a stub. No browser, network or customer data.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { CommandOutcomeUnknown } from '../../lib/commonswarm';
import { GENERAL_CHANNEL_ID, channelById, channelSubmitProblem, channelSubmitSlug, mayManageChannel } from '../../lib/channels';
import {
  CommandAttempts, SET_LEAD_LABEL, channelLead, channelLeadFromValue, channelLeadOptions, channelLeadValue, namedChannelLead,
} from '../../lib/channel-lead';

/** `optional`: declarations an older source may lack, so a test run against it fails on behaviour, not on a missing name. */
async function dashboardFunctions(names: string[], optional: string[] = []): Promise<string> {
  const raw = await readFile(new URL('./LiveDashboard.astro', import.meta.url), 'utf8');
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
  const ast = ts.createSourceFile('dashboard.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && [...names, ...optional].includes(node.name.text)) found.set(node.name.text, `const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `production declaration ${name}`);
  return ts.transpileModule([...optional.filter(name => found.has(name)), ...names].map(name => found.get(name)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

/** Just enough DOM: children, dataset hooks, listeners, focus. A select's value must name one of its options. */
const focused: El[] = [];
class El {
  children: El[] = []; parent: El | null = null; dataset: Record<string, string> = {}; attrs = new Map<string, string>();
  listeners = new Map<string, () => void>(); textContent = ''; className = ''; title = ''; type = ''; hidden = false;
  disabled = false; open = false; #value = '';
  constructor(readonly tag: string) {}
  get options(): El[] { return this.children; }
  get value(): string { return this.#value; }
  set value(next: string) { this.#value = this.tag !== 'select' || this.children.some(option => option.value === next) ? next : ''; }
  append(...nodes: El[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  insertBefore(node: El, before: El | null) {
    if (!before) { this.append(node); return; }
    node.remove(); node.parent = this; this.children.splice(this.children.indexOf(before), 0, node);
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  replaceChildren(...nodes: El[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(name: string, handler: () => void) { this.listeners.set(name, handler); }
  click() { this.listeners.get('click')?.(); }
  focus() { focused.push(this); }
  showModal() { this.open = true; }
  descendants(): El[] { return this.children.flatMap(node => [node, ...node.descendants()]); }
  querySelector(selector: string): El | null {
    const hook = selector.match(/^\[data-([a-z-]+)\]$/)?.[1];
    assert.ok(hook, `fixture selector ${selector}`);
    const key = hook.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return this.descendants().find(node => Object.hasOwn(node.dataset, key)) ?? null;
  }
}
class Option extends El { constructor(label: string, value: string) { super('option'); this.textContent = label; this.value = value; } }

const U1 = 'u1', U2 = 'u2';
const ATLAS = 'a-atlas', BUILDER = 'a-builder', HOSTED = 'a-hosted', TURN = 'a-turn';
const OPEN = 'c-open', LOCKED = 'c-locked', OTHER = 'c-other';
const channelRow = (channelId: string, slug: string, extra: Record<string, unknown> = {}) => ({ channelId, workspaceId: 'w1', slug, purpose: null,
  createdByPrincipal: U1, createdByKind: 'user', createdAt: '2026-11-01T00:00:00Z', archivedAt: null, visibility: 'open', ...extra });

async function dashboard(overrides: Record<string, unknown> = {}) {
  const calls = { setChannelLead: [] as unknown[][], updateChannel: [] as unknown[][], errors: [] as string[], held: [] as boolean[],
    finished: 0, refreshed: [] as unknown[][], entity: [] as unknown[][], opened: [] as unknown[][], roster: 0, members: [] as unknown[][] };
  const nodes = new Map<string, El>();
  const node = (selector: string, tag: string) => { const el = new El(tag); nodes.set(selector, el); return el; };
  const dialog = node('[data-channel-dialog]', 'dialog');
  const select = node('[data-channel-lead-select]', 'select'), label = node('[data-channel-lead-label]', 'label');
  const slug = node('[data-channel-rename-slug]', 'input'), description = node('[data-channel-edit-description]', 'textarea');
  const save = node('[data-channel-rename-submit]', 'button');
  const copy = node('[data-home-workspace-shell] .hm-ws-header__copy', 'div');
  let uuid = 0;
  const context = createContext({
    GENERAL_CHANNEL_ID, channelById, channelSubmitProblem, channelSubmitSlug, mayManageChannel,
    CommandAttempts, SET_LEAD_LABEL, channelLead, channelLeadFromValue, channelLeadOptions, channelLeadValue, namedChannelLead,
    Option,
    document: { createElement: (tag: string) => new El(tag) },
    one: (selector: string) => nodes.get(selector) ?? null,
    uuid: () => `cmd-${++uuid}`,
    readableError: (error: Error) => error.message,
    setChannelDialogError: (message: string) => { calls.errors.push(message); },
    holdChannelDialog: (pending: boolean) => { calls.held.push(pending); },
    finishChannelCommand: () => { calls.finished++; dialog.open = false; },
    refreshChannels: async (...args: unknown[]) => { calls.refreshed.push(args); },
    renderChannelRail: () => {}, renderChannelHead: () => {}, renderHomeShell: () => {}, renderChannelDirectoryDialog: () => {},
    activeChannelArchived: () => false,
    openEntityPanel: (...args: unknown[]) => { calls.entity.push(args); },
    openRosterDialog: () => { calls.roster++; },
    updateChannel: async (...args: unknown[]) => { calls.updateChannel.push(args); throw new Error('channel_update was not expected'); },
    setChannelLead: async (...args: unknown[]) => { calls.setChannelLead.push(args); return { ok: true, channel: null }; },
    channelAgentMemberIds: async (...args: unknown[]) => { calls.members.push(args); return []; },
    ...overrides,
  });
  runInContext(`
    let sampleMode = false, session = { user: { id: '${U1}' } }, activeWorkspaceId = 'w1', requestVersion = 1;
    let homeRoute = { view: 'chat', workspaceId: 'w1' }, activeDm = null, activeChannelId = null, unknownChannelId = null;
    let workspaces = [{ id: 'w1', name: 'Home', leadAgentPrincipalId: '${ATLAS}' }, { id: 'w2', name: 'Studio', leadAgentPrincipalId: null }];
    let members = [{ userId: '${U1}', name: 'Owner', role: 'owner' }, { userId: '${U2}', name: 'Member', role: 'member' }];
    let agents = [
      { principalId: '${BUILDER}', name: 'Builder', model: null, transport: 'local', turnOnly: false, ownerUserId: '${U1}' },
      { principalId: '${ATLAS}', name: 'Atlas', model: null, transport: 'local', turnOnly: false, ownerUserId: '${U1}' },
      { principalId: '${HOSTED}', name: 'Hosted helper', model: null, transport: 'hosted_mcp', turnOnly: true, ownerUserId: '${U1}' },
      { principalId: '${TURN}', name: 'Turn taker', model: null, transport: 'local', turnOnly: true, ownerUserId: '${U1}' },
    ];
    let channels = ${JSON.stringify([channelRow(OPEN, 'design'), channelRow(LOCKED, 'quotes', { visibility: 'private', leadMode: 'agent', leadAgentPrincipalId: BUILDER }),
      channelRow(OTHER, 'garden', { createdByPrincipal: 'u3' })])};
    let channelsLoaded = true, railArchivedOpen = false;
    let managedChannelId = null, channelDialogOriginal = null, channelDialogPending = false, channelDialogEpoch = 0;
    const privateChannelAgentIds = new Map(), privateChannelMemberReads = new Map();
    const channelLeadAttempts = new CommandAttempts();
  `, context);
  runInContext(await dashboardFunctions(['activeWorkspaceLeadAgent', 'viewerMaySetWorkspaceLead', 'viewerWorkspaceRole', 'viewerMayManageChannel',
    'activeChannel', 'syncChannelLeadPill', 'channelSettingsChanges', 'channelLeadChange', 'syncChannelSettingsSubmit', 'renderChannelLeadSelect',
    'privateMembersKey', 'knownPrivateChannelMembers', 'readPrivateChannelMembers', 'privateChannelMembersFor',
    'loadChannelLeadMembers', 'channelDialogOwns', 'applyChannelResult', 'submitChannelSettings'], ['forgetPrivateChannelMembers']), context);
  const run = <T = unknown>(code: string): T => runInContext(code, context) as T;
  /** The settings dialog as openChannelDialog leaves it, without its focus and return bookkeeping. */
  const openSettings = (channelId: string) => {
    run(`channelDialogEpoch++; managedChannelId = '${channelId}';
      { const channel = channelById(channels, managedChannelId); loadChannelLeadMembers(channel);
        renderChannelLeadSelect(channel, viewerMayManageChannel(channel), false);
        channelDialogOriginal = { slug: channel.slug, purpose: channel.purpose, lead: channelLeadValue(channelLead(channel)) }; }`);
    dialog.open = true;
    slug.value = run<string>(`channelById(channels, '${channelId}').slug`); description.value = '';
  };
  const options = () => select.children.map(option => option.disabled ? [option.value, option.textContent, 'disabled'] : [option.value, option.textContent]);
  const pill = () => copy.children.find(child => Object.hasOwn(child.dataset, 'channelLeadPill')) ?? null;
  const pillText = () => { const found = pill(); return found ? found.descendants().map(n => n.textContent).filter(Boolean).join('|') : null; };
  return { calls, context, run, dialog, select, label, save, copy, openSettings, options, pill, pillText };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
/** A value made inside the vm, as plain data this realm can compare. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('the Channel lead select offers the workspace lead, No lead and the agents that may lead, and only to managers', async () => {
  const d = await dashboard();
  d.openSettings(OPEN);
  assert.equal(d.select.hidden, false); assert.equal(d.label.hidden, false);
  assert.deepEqual(d.options(), [['workspace', 'Workspace lead (Atlas)'], ['none', 'No lead'], [`agent:${ATLAS}`, 'Atlas'], [`agent:${BUILDER}`, 'Builder']],
    'hosted and turn-only agents are not offered');
  assert.equal(d.select.value, 'workspace', 'an unset channel shows the default');
  assert.equal(d.calls.members.length, 0, 'an open channel reads no members');

  // A member who did not create the channel: no control at all.
  d.run(`session = { user: { id: '${U2}' } };`);
  d.openSettings(OTHER);
  assert.equal(d.select.hidden, true); assert.equal(d.label.hidden, true); assert.equal(d.select.children.length, 0);
  assert.equal(d.run('channelLeadChange()'), null);
  // The member who created it manages it.
  d.run(`channels = channels.map(row => row.channelId === '${OTHER}' ? { ...row, createdByPrincipal: '${U2}' } : row);`);
  d.openSettings(OTHER);
  assert.equal(d.select.hidden, false);
});

test('a private channel offers only its member agents, keeping the stored lead while they load and naming no unconfirmed lead', async () => {
  let answer!: (ids: string[]) => void;
  const d = await dashboard({ channelAgentMemberIds: (...args: unknown[]) => { d.calls.members.push(args); return new Promise(resolve => { answer = resolve; }); } });
  d.openSettings(LOCKED);
  assert.deepEqual(d.calls.members, [['w1', LOCKED]]);
  assert.deepEqual(d.options(), [['workspace', 'Workspace lead'], ['none', 'No lead'], [`agent:${BUILDER}`, 'Builder']],
    'before members are known the workspace lead is not named');
  assert.equal(d.select.value, `agent:${BUILDER}`, 'the stored lead is selected before members are known');
  d.select.value = 'none';
  answer([BUILDER]); await tick();
  assert.deepEqual(d.options(), [['workspace', 'Workspace lead (none)'], ['none', 'No lead'], [`agent:${BUILDER}`, 'Builder']],
    'Atlas is not a member: it is not offered and leads nobody here as the workspace lead');
  assert.equal(d.select.value, 'none', 'the members read keeps what the person chose');

  // An answer for a dialog that has since closed changes nothing.
  d.openSettings(LOCKED);
  d.run('channelDialogEpoch++;');
  answer([BUILDER, ATLAS]); await tick();
  assert.deepEqual(d.options().map(([value]) => value), ['workspace', 'none', `agent:${BUILDER}`]);
});

test('a stored lead that may not lead here is kept on show, disabled, and never sent', async () => {
  const d = await dashboard({ channelAgentMemberIds: async (...args: unknown[]) => { d.calls.members.push(args); return [ATLAS]; } });
  // The private channel's stored lead (Builder) is not a member any more.
  d.openSettings(LOCKED); await tick();
  assert.deepEqual(d.options(), [['workspace', 'Workspace lead (Atlas)'], ['none', 'No lead'], [`agent:${ATLAS}`, 'Atlas'], [`agent:${BUILDER}`, 'Builder', 'disabled']],
    'the members read redrew the select');
  assert.equal(d.select.value, `agent:${BUILDER}`, 'the selection does not jump');
  // A choice that became disabled under the person (here: shown after they picked it) is not a change to send.
  d.run(`channelDialogOriginal = { ...channelDialogOriginal, lead: 'none' };`);
  assert.equal(d.run('channelLeadChange()'), null);
  d.select.value = `agent:${ATLAS}`;
  assert.deepEqual(plain(d.run('channelLeadChange()')), { mode: 'agent', principalId: ATLAS });
});

test('an archived channel shows its lead with the select disabled, and Save stays off', async () => {
  const d = await dashboard();
  d.run(`channels = channels.map(row => row.channelId === '${OPEN}' ? { ...row, archivedAt: '2026-11-02T00:00:00Z' } : row);`);
  d.openSettings(OPEN);
  assert.equal(d.select.hidden, false);
  assert.equal(d.select.disabled, true);
  d.select.value = 'none';
  assert.equal(d.run('channelLeadChange()'), null);
  d.run('syncChannelSettingsSubmit()');
  assert.equal(d.save.disabled, true);
  // Not archived: enabled.
  d.openSettings(OTHER);
  assert.equal(d.select.disabled, false);
});

test('Save sends set_channel_lead alone when only the lead changed, and paints the accepted channel', async () => {
  const d = await dashboard({ setChannelLead: async (...args: unknown[]) => {
    d.calls.setChannelLead.push(args);
    return { ok: true, channel: { ...d.run<Record<string, unknown>>(`channelById(channels, '${OPEN}')`), leadMode: 'agent', leadAgentPrincipalId: BUILDER } };
  } });
  d.run(`activeChannelId = '${OPEN}';`);
  d.openSettings(OPEN);
  assert.equal(d.run('channelLeadChange()'), null);
  d.select.value = `agent:${BUILDER}`;
  d.run('syncChannelSettingsSubmit()');
  assert.equal(d.save.disabled, false, 'a changed lead alone enables Save');
  await d.run<Promise<void>>('submitChannelSettings()');
  assert.equal(d.calls.updateChannel.length, 0, 'name and description unchanged: no channel_update');
  assert.deepEqual(plain(d.calls.setChannelLead.map(([, id, workspace, channel, lead]) => [id, workspace, channel, lead])),
    [['cmd-1', 'w1', OPEN, { mode: 'agent', principalId: BUILDER }]]);
  assert.equal(d.calls.finished, 1);
  assert.deepEqual(plain(d.run(`(({ leadMode, leadAgentPrincipalId }) => [leadMode, leadAgentPrincipalId])(channelById(channels, '${OPEN}'))`)), ['agent', BUILDER]);
  d.run('syncChannelLeadPill()');
  assert.equal(d.pillText(), 'B|Builder');
  assert.equal(d.pill()?.dataset.leadAgent, BUILDER);

  // A later rename's answer carries no lead: the channel keeps the one it has.
  d.run(`applyChannelResult({ ...channelById(channels, '${OPEN}'), slug: 'design-2', leadMode: undefined, leadAgentPrincipalId: undefined }, 'w1', 1)`);
  assert.deepEqual(plain(d.run(`(({ slug, leadMode, leadAgentPrincipalId }) => [slug, leadMode, leadAgentPrincipalId])(channelById(channels, '${OPEN}'))`)),
    ['design-2', 'agent', BUILDER]);
});

test('a refusal shows the server\'s sentence and keeps the selection; a lost answer retries with the same command id', async () => {
  const refusal = 'A channel lead must be a live local agent in this workspace that is not turn-only and can read this channel. Nothing changed.';
  const answers: Array<() => unknown> = [
    () => ({ ok: false, status: 403, message: refusal }),
    () => { throw new CommandOutcomeUnknown('CommonSwarm lost contact before it could read the result.'); },
    () => { throw new CommandOutcomeUnknown('CommonSwarm lost contact before it could read the result.'); },
    () => ({ ok: false, status: 404, message: 'No such channel.' }),
  ];
  const d = await dashboard({ setChannelLead: async (...args: unknown[]) => { d.calls.setChannelLead.push(args); return answers.shift()!(); } });
  d.openSettings(OPEN);
  d.select.value = `agent:${ATLAS}`;
  await d.run<Promise<void>>('submitChannelSettings()');
  assert.equal(d.calls.errors.at(-1), refusal);
  assert.equal(d.dialog.open, true); assert.equal(d.calls.finished, 0);
  assert.equal(d.select.value, `agent:${ATLAS}`, 'the selection stays');
  assert.deepEqual(d.calls.held, [true, false]);
  assert.equal(focused.at(-1), d.select);
  assert.deepEqual(d.run(`channelLead(channelById(channels, '${OPEN}'))`), { mode: 'workspace' }, 'nothing was painted');

  await d.run<Promise<void>>('submitChannelSettings()');
  await d.run<Promise<void>>('submitChannelSettings()');
  d.select.value = 'none';
  await d.run<Promise<void>>('submitChannelSettings()');
  assert.deepEqual(plain(d.calls.setChannelLead.map(([, id, , , lead]) => [id, lead])), [
    ['cmd-1', { mode: 'agent', principalId: ATLAS }],
    ['cmd-2', { mode: 'agent', principalId: ATLAS }], // the refusal was an answer: a new attempt
    ['cmd-2', { mode: 'agent', principalId: ATLAS }], // no answer: the same id again
    ['cmd-3', { mode: 'none' }], // another selection: a new attempt
  ]);
  assert.deepEqual(d.calls.errors.filter(Boolean), [refusal, 'CommonSwarm lost contact before it could read the result.',
    'CommonSwarm lost contact before it could read the result.', 'No such channel.']);
});

test('a name change and a lead change both go, and a refused lead does not resend the accepted name', async () => {
  const d = await dashboard({
    updateChannel: async (...args: unknown[]) => { d.calls.updateChannel.push(args); return { ...d.run<Record<string, unknown>>(`channelById(channels, '${OPEN}')`), slug: 'studio' }; },
    setChannelLead: async (...args: unknown[]) => { d.calls.setChannelLead.push(args); return { ok: false, status: 403, message: 'Refused.' }; },
  });
  d.openSettings(OPEN);
  (d.run('one')as (s: string) => El)('[data-channel-rename-slug]').value = 'studio';
  d.select.value = 'none';
  await d.run<Promise<void>>('submitChannelSettings()');
  assert.deepEqual(plain(d.calls.updateChannel.map(([, , , , changes]) => changes)), [{ slug: 'studio' }]);
  assert.equal(d.calls.setChannelLead.length, 1);
  assert.deepEqual(plain(d.run('channelSettingsChanges()')), {}, 'the accepted name is now the original');
  await d.run<Promise<void>>('submitChannelSettings()');
  assert.equal(d.calls.updateChannel.length, 1);
  assert.equal(d.calls.setChannelLead.length, 2);
});

test('an answer that lands after the workspace, the account or the channel moved on paints nothing', async () => {
  for (const move of [
    `activeWorkspaceId = 'w2'; requestVersion++;`,
    `session = { user: { id: '${U2}' } };`,
    `channelDialogEpoch++; managedChannelId = '${OTHER}';`,
  ]) {
    let answer!: (result: unknown) => void;
    const d = await dashboard({ setChannelLead: (...args: unknown[]) => { d.calls.setChannelLead.push(args); return new Promise(resolve => { answer = resolve; }); } });
    d.openSettings(OPEN);
    d.select.value = `agent:${BUILDER}`;
    const saving = d.run<Promise<void>>('submitChannelSettings()');
    await tick();
    d.run(move);
    answer({ ok: true, channel: { ...d.run<Record<string, unknown>>(`channelById(channels, '${OPEN}')`), leadMode: 'agent', leadAgentPrincipalId: BUILDER } });
    await saving;
    assert.deepEqual(d.run(`channelLead(channelById(channels, '${OPEN}'))`), { mode: 'workspace' }, move);
    assert.equal(d.calls.finished, 0, move);
    assert.deepEqual(d.calls.errors.filter(Boolean), [], move);
    // Only a channel move in the same workspace and account reads the list again, so the accepted lead arrives from the server.
    assert.deepEqual(d.calls.refreshed, move.includes('managedChannelId') ? [['w1', 1, true]] : [], move);
  }
  // A refusal for a closed dialog says nothing either.
  let answer!: (result: unknown) => void;
  const d = await dashboard({ setChannelLead: () => new Promise(resolve => { answer = resolve; }) });
  d.openSettings(OPEN);
  d.select.value = 'none';
  const saving = d.run<Promise<void>>('submitChannelSettings()');
  await tick();
  d.run('channelDialogEpoch++;');
  answer({ ok: false, status: 403, message: 'Refused.' });
  await saving;
  assert.deepEqual(d.calls.errors.filter(Boolean), []);
});

test('the header pill names each channel\'s lead, stays quiet for No lead, and #general keeps the workspace lead', async () => {
  const d = await dashboard({ openChannelDialog: (...args: unknown[]) => { d.calls.opened.push(args); } });
  const set = (id: string, patch: string) => d.run(`channels = channels.map(row => row.channelId === '${id}' ? { ...row, ${patch} } : row);`);
  const sync = () => d.run('syncChannelLeadPill()');
  const opensSettings = (id: string) => {
    const before = d.calls.roster;
    d.pill()!.click();
    assert.deepEqual(d.calls.opened.at(-1)?.slice(0, 2), ['settings', id]);
    assert.equal(d.calls.opened.at(-1)?.[3], 'lead');
    assert.equal(d.calls.roster, before, 'a channel\'s Set lead never opens People & agents');
  };

  d.run(`activeChannelId = '${GENERAL_CHANNEL_ID}';`); sync();
  assert.equal(d.pillText(), 'A|Atlas', '#general: the workspace lead');
  d.pill()!.click();
  assert.deepEqual(plain(d.calls.entity.at(-1)?.[0]), { kind: 'agent', id: ATLAS });
  d.run('activeChannelId = null;'); sync();
  assert.equal(d.pillText(), 'A|Atlas', 'All messages: the workspace lead');

  d.run(`activeChannelId = '${OPEN}';`); sync();
  assert.equal(d.pillText(), 'A|Atlas', 'a channel on the workspace lead');
  set(OPEN, `leadMode: 'agent', leadAgentPrincipalId: '${BUILDER}'`); sync();
  assert.equal(d.pillText(), 'B|Builder', 'a channel with its own lead');
  assert.equal(d.pill()?.getAttribute('aria-label'), 'Lead: Builder');
  d.pill()!.click();
  assert.deepEqual(plain(d.calls.entity.at(-1)?.[0]), { kind: 'agent', id: BUILDER });
  assert.equal(d.copy.children.filter(child => Object.hasOwn(child.dataset, 'channelLeadPill')).length, 1, 'one pill, redrawn in place');

  set(OPEN, `leadMode: 'none', leadAgentPrincipalId: null`); sync();
  assert.equal(d.pill(), null, 'No lead is a choice: nothing, even for a manager');

  set(OPEN, `leadMode: 'agent', leadAgentPrincipalId: '${HOSTED}'`); sync();
  assert.equal(d.pillText(), SET_LEAD_LABEL, 'a lead that may not lead is missing: the manager may set one');
  assert.equal(d.pill()?.dataset.leadUnset, '');
  opensSettings(OPEN);
  set(OPEN, `leadMode: 'agent', leadAgentPrincipalId: 'a-gone'`); sync();
  assert.equal(d.pillText(), SET_LEAD_LABEL, 'a lead no longer on the roster is missing');

  // The workspace has no lead: in a named channel on the workspace lead, Set lead goes to the channel's settings.
  set(OPEN, `leadMode: 'workspace', leadAgentPrincipalId: null`);
  d.run(`workspaces[0].leadAgentPrincipalId = null;`); sync();
  assert.equal(d.pillText(), SET_LEAD_LABEL);
  opensSettings(OPEN);
  // ...and in #general, to People & agents, as before.
  d.run(`activeChannelId = '${GENERAL_CHANNEL_ID}';`); sync();
  assert.equal(d.pillText(), SET_LEAD_LABEL);
  d.pill()!.click();
  assert.equal(d.calls.roster, 1);
  d.run(`workspaces[0].leadAgentPrincipalId = '${ATLAS}'; activeChannelId = '${OPEN}';`);

  set(OPEN, `leadMode: 'agent', leadAgentPrincipalId: '${HOSTED}', archivedAt: '2026-11-02T00:00:00Z'`); sync();
  assert.equal(d.pill(), null, 'an archived channel takes no posts: no Set lead');
  set(OPEN, `archivedAt: null`); d.run(`session = { user: { id: '${U2}' } };`); sync();
  assert.equal(d.pill(), null, 'a missing lead, for someone who cannot manage the channel: no pill');

  // A channel that has not been read yet names nobody.
  d.run(`activeChannelId = 'c-not-read';`); sync();
  assert.equal(d.pill(), null);

  // Unchanged: only owners and admins get #general's Set lead.
  d.run(`session = { user: { id: '${U1}' } }; workspaces[0].leadAgentPrincipalId = null; activeChannelId = '${GENERAL_CHANNEL_ID}';`);
  d.run(`members = members.map(m => ({ ...m, role: 'member' }));`); sync();
  assert.equal(d.pill(), null);
  d.run(`activeDm = { kind: 'agent', id: '${ATLAS}' }; workspaces[0].leadAgentPrincipalId = '${ATLAS}';`); sync();
  assert.equal(d.pill(), null, 'a direct message names no lead');
});

test('a private channel\'s header names only a member lead, and nothing until its members are known', async () => {
  const answers: Array<(ids: string[] | Error) => void> = [];
  const d = await dashboard({
    openChannelDialog: (...args: unknown[]) => { d.calls.opened.push(args); },
    channelAgentMemberIds: (...args: unknown[]) => {
      d.calls.members.push(args);
      return new Promise((resolve, reject) => { answers.push(value => value instanceof Error ? reject(value) : resolve(value)); });
    },
  });
  const sync = () => d.run('syncChannelLeadPill()');
  d.run(`channels = channels.map(row => row.channelId === '${LOCKED}' ? { ...row, leadMode: 'workspace', leadAgentPrincipalId: null } : row);
    activeChannelId = '${LOCKED}';`);
  sync(); sync();
  assert.equal(d.pill(), null, 'nothing while the members are not known');
  assert.deepEqual(d.calls.members, [['w1', LOCKED]], 'read once');
  answers.shift()!([BUILDER]); await tick();
  assert.equal(d.pillText(), SET_LEAD_LABEL, 'the workspace lead (Atlas) is not a member: the lead is missing, and the read redrew the header');
  d.pill()!.click();
  assert.deepEqual(d.calls.opened.at(-1)?.slice(0, 2), ['settings', LOCKED]);

  d.run(`channels = channels.map(row => row.channelId === '${LOCKED}' ? { ...row, leadMode: 'agent', leadAgentPrincipalId: '${BUILDER}' } : row);`); sync();
  assert.equal(d.pillText(), 'B|Builder', 'a member lead is named');
  assert.equal(d.calls.members.length, 1, 'the known members are reused');

  // Opening the channel's settings reads its members again; the header follows the newer answer.
  d.openSettings(LOCKED);
  assert.equal(d.calls.members.length, 2);
  answers.shift()!([ATLAS]); await tick();
  assert.equal(d.pillText(), SET_LEAD_LABEL, 'Builder left the channel');

  // Another workspace keys its own read; an answer that lands after the workspace changed is dropped.
  d.run(`channels = channels.map(row => row.channelId === '${LOCKED}' ? { ...row, workspaceId: 'w2' } : row);
    activeWorkspaceId = 'w2'; workspaces[1].leadAgentPrincipalId = '${ATLAS}';`);
  sync();
  assert.equal(d.pill(), null);
  assert.deepEqual(d.calls.members.at(-1), ['w2', LOCKED]);
  d.run(`activeWorkspaceId = 'w1';`);
  answers.shift()!([ATLAS]); await tick();
  d.run(`activeWorkspaceId = 'w2';`); sync();
  assert.equal(d.pill(), null, 'the answer for w2 landed while w1 was open: not kept');

  // A failed read leaves the header quiet, without reading again on every redraw.
  d.run(`session = { user: { id: '${U2}' } }; members = members.map(m => ({ ...m, role: 'owner' }));`);
  sync();
  const reads = d.calls.members.length;
  answers.shift()!(new Error('offline')); await tick();
  sync(); sync();
  assert.equal(d.pill(), null);
  assert.equal(d.calls.members.length, reads);
});

test('only the latest members read writes: an older answer after a newer one, or any answer after a reset, changes nothing', async () => {
  const held: Array<(ids: string[]) => void> = [];
  const d = await dashboard({ channelAgentMemberIds: (...args: unknown[]) => {
    d.calls.members.push(args);
    return new Promise(resolve => { held.push(resolve); });
  } });
  const cached = () => plain([...(d.run<Set<string> | null>(`knownPrivateChannelMembers('${LOCKED}')`) ?? [])]);
  // A private channel led by Builder. The header starts read A; opening its settings starts read B.
  d.run(`activeChannelId = '${LOCKED}';`);
  d.run('syncChannelLeadPill()');
  d.openSettings(LOCKED);
  assert.equal(held.length, 2);
  const [readA, readB] = held;
  readB!([ATLAS]); await tick();
  assert.deepEqual(cached(), [ATLAS]);
  assert.equal(d.pillText(), SET_LEAD_LABEL, 'the newer read: Builder is not a member');
  assert.deepEqual(d.options().at(-1), [`agent:${BUILDER}`, 'Builder', 'disabled']);
  readA!([BUILDER]); await tick();
  assert.deepEqual(cached(), [ATLAS], 'the older read answered last: B\'s members stay');
  assert.equal(d.pillText(), SET_LEAD_LABEL, 'the header does not name a lead the newer read excluded');
  assert.deepEqual(d.options().at(-1), [`agent:${BUILDER}`, 'Builder', 'disabled']);

  // A reset (workspace or account) between reads: the same channel is read again, then the retired read answers.
  d.openSettings(LOCKED);
  const retired = held.at(-1)!;
  d.run(`typeof forgetPrivateChannelMembers === 'function' ? forgetPrivateChannelMembers() : privateChannelAgentIds.clear(); requestVersion++;`);
  d.run('syncChannelLeadPill()');
  assert.equal(d.pill(), null, 'after the reset nothing is known');
  const fresh = held.at(-1)!;
  assert.notEqual(fresh, retired, 'the header read the channel again');
  fresh([ATLAS]); await tick();
  assert.equal(d.pillText(), SET_LEAD_LABEL);
  retired([BUILDER]); await tick();
  assert.deepEqual(cached(), [ATLAS], 'the read from before the reset writes nothing');
  assert.equal(d.pillText(), SET_LEAD_LABEL);

  // A retired read that answers into a cache the reset emptied writes nothing either.
  d.openSettings(LOCKED);
  const beforeReset = held.at(-1)!;
  d.run(`typeof forgetPrivateChannelMembers === 'function' ? forgetPrivateChannelMembers() : privateChannelAgentIds.clear(); requestVersion++;`);
  beforeReset([BUILDER]); await tick();
  assert.deepEqual(cached(), [], 'nothing written after the reset');
  d.run('syncChannelLeadPill()');
  assert.equal(d.pill(), null);
});

test('Set lead opens the channel\'s settings with the Channel lead select focused', async () => {
  const d = await dashboard();
  runInContext(`
    let channelDialogReturn = null, channelDialogMode = 'create', channelDialogSucceeded = false, channelArchiveBackToSettings = false;
    const layout = { closeNavigation() {} }, viewerMayCreateChannel = () => true, closeChannelDirectory = () => {};
    const channelFocusReturn = opener => ({ selector: '[data-channel-lead-pill]', element: opener, drawer: false });
    const renderChannelDialog = () => { const channel = channelById(channels, managedChannelId); renderChannelLeadSelect(channel, viewerMayManageChannel(channel), false); };
  `, d.context);
  runInContext(await dashboardFunctions(['openChannelDialog']), d.context);
  d.run(`channels = channels.map(row => row.channelId === '${OPEN}' ? { ...row, leadMode: 'none', leadAgentPrincipalId: null } : row); activeChannelId = '${OPEN}';`);
  // The pill's own click, wired to the real openChannelDialog.
  d.run(`(() => { const pill = document.createElement('button'); openChannelDialog('settings', '${OPEN}', pill, 'lead'); })()`);
  assert.equal(d.dialog.open, true);
  assert.equal(d.run('managedChannelId'), OPEN);
  assert.equal(focused.at(-1), d.select);
  assert.equal(d.select.value, 'none');
});
