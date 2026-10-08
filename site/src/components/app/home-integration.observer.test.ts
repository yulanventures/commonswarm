import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { HomeToolsUnavailable, HomeCommandRefused } from '../../lib/home/client';
import { CommandOutcomeUnknown, FreshLoginRequired, WorkspaceRoleRefused, BROWSER_SIGNAL_COLUMNS, browserSignalFromRow } from '../../lib/commonswarm';
import { createLatestRead } from '../../lib/latest-read';
import { buildAuthorLine, buildStreamExtras, deriveStreamExtras } from '../../lib/home-stream';
import { homeParty, mapHomePeople, homeAskAnswered } from '../../lib/home-map';
import { peopleRoleBeginSave, peopleRoleErrorCode, peopleRoleFinishSave, peopleRoleReceipt, peopleRoleRefusal } from '../../lib/people-dialog-view';
import { addAgentOwnershipLine, agentLabelInSentence, personFirstName } from '../../lib/home-names';
import { canStartThread, THREAD_REPLY_CONTROL_LABEL, threadReplyPlace, threadReplyTargetText } from '../../lib/thread-reply';
import { channelLabel } from '../../lib/channels';
import { parentRoute } from '../../lib/home-route';

/** Execute the dashboard's read/write lifecycle, replacing only the DOM paint boundaries.
 * No browser, model, network or customer data. Expected surface states come from UI-SPEC 3.3. */
async function dashboardFunctions(names: string[]): Promise<string> {
  const raw = await readFile(new URL('./LiveDashboard.astro', import.meta.url), 'utf8');
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
  const ast = ts.createSourceFile('dashboard.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) found.set(node.name.text, `const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `production declaration ${name}`);
  return ts.transpileModule(names.map(name => found.get(name)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test('standalone details hide the account door and restore the same DOM to workspace navigation', async () => {
  const trigger = {}, menu = {};
  const account = { parentElement: null as unknown, hidden: false, trigger, menu };
  const content = {}, railContent = {};
  const container = (children: unknown[]) => ({
    children,
    append(node: typeof account) {
      detach(node); this.children.push(node); node.parentElement = this;
    },
    prepend(node: typeof account) {
      detach(node); this.children.unshift(node); node.parentElement = this;
    },
  });
  const detach = (node: typeof account) => {
    const parent = node.parentElement as ReturnType<typeof container> | null;
    if (parent) parent.children.splice(parent.children.indexOf(node), 1);
  };
  const rail = container([account, railContent]), main = container([content]);
  account.parentElement = rail;
  let standalone = false;
  const frame = { toggleAttribute(_name: string, enabled: boolean) { standalone = enabled; } };
  const nodes = new Map<string, unknown>([['.hm-frame', frame], ['[data-user-menu-root]', account],
    ['.hm-frame__main', main], ['.hm-frame__rail', rail]]);
  const context = createContext({ one: (selector: string) => nodes.get(selector) });
  runInContext("let homeRoute={view:'todo'}; const app={dataset:{state:'channel',channelView:'feed'}};", context);
  runInContext(await dashboardFunctions(['syncStandalonePage']), context);
  const sync = (statement = '') => runInContext(`${statement}; syncStandalonePage();`, context);
  sync();
  assert.equal(standalone, true);
  assert.deepEqual(main.children, [content, account], 'the intact account DOM is parked after page content');
  assert.equal(account.hidden, true, 'the account control is hidden from rendering and keyboard navigation');
  assert.deepEqual(rail.children, [railContent]);
  sync("homeRoute={view:'add-agent'}; app.dataset.channelView='agent-choice'");
  assert.equal(standalone, true);
  assert.deepEqual(main.children, [content, account], 'repainting retains the existing door without duplication');
  assert.equal(account.hidden, true, 'the add-agent picker also hides the account control');
  for (const view of ['invite', 'connect', 'feed']) {
    sync(`app.dataset.channelView='${view}'`);
    assert.equal(standalone, false, `${view} uses its workspace frame`);
    assert.deepEqual(rail.children, [account, railContent]);
    assert.equal(account.hidden, false, `${view} restores visible account access`);
  }
  for (const view of ['todos', 'chat', 'catchup', 'agent', 'people']) {
    sync("homeRoute={view:'todo'}");
    sync(`homeRoute={view:'${view}'}`);
    assert.equal(standalone, false, `${view} keeps workspace navigation`);
    assert.deepEqual(rail.children, [account, railContent]);
    assert.equal(account.hidden, false, `${view} restores visible account access`);
  }
  sync("homeRoute={view:'todo'}");
  runInContext('syncStandalonePage(true)', context);
  assert.equal(standalone, false, 'leaving the channel restores account access before the create panel borrows the rail');
  assert.deepEqual(rail.children, [account, railContent]);
  assert.equal(account.hidden, false, 'the create panel receives visible account access');
  sync("app.dataset.state='signed-out'");
  assert.equal(standalone, false);
  assert.deepEqual(main.children, [content]);
  assert.equal(account.hidden, false);
  assert.equal(account.trigger, trigger, 'restoration preserves the original trigger and its handlers');
  assert.equal(account.menu, menu, 'restoration preserves the original menu and its handlers');
});

async function readFixture(server: unknown, postCommand?: (...args: unknown[]) => Promise<unknown>) {
  const context = createContext({ server, postCommand, createLatestRead, HomeToolsUnavailable, HomeCommandRefused });
  runInContext(`
    let activeWorkspaceId = 'W', homeWorkspaceGeneration = 1, homeWorkspaceRead = 0;
    let homeTodosState = 'pending', homeTodoRows = [], homeTodoRead = null, homeQueue = null, homeQueueRead = 'pending', homeObjects = {state:'pending'}, homeTodoReceipt = '';
    let workspaces = [{id:'W',name:'Home'}], homeRoute = {view:'todos'}, agents = [];
    let sampleMode = true, session = null, requestVersion = 1, householdAccessGeneration = 1;
    const accessReads = createLatestRead(), uuid = () => 'R';
    let householdAccess = {workspaceId:'W',status:'ok',contentRole:'editor'};
    const homeServer = () => server;
    const paints = [], renderHomeRail = () => {}, renderHomeShell = () => {}, renderHomeSide = () => {}, renderHomeObjectPane = () => {}, renderFeed = () => {};
    const loadHouseholdConnections = async () => {}, householdCall = () => async () => ({status:'ok',objects:[],next_offset:null});
    const applyHomePane = () => paints.push({available:workspaces[0].todosAvailable, state:homeTodosState, titles:homeTodoRows.map(row=>row.title)});
  `, context);
  runInContext(await dashboardFunctions(['householdScope', 'householdCurrent', 'readHouseholdAccess', 'homeRefusalCopy', 'homeTodosAvailable', 'loadHomeWorkspace']), context);
  return { context, load: () => runInContext('loadHomeWorkspace()', context), state: () => JSON.parse(runInContext('JSON.stringify({state:homeTodosState,rows:homeTodoRows,paints})', context)) };
}
const overview = async () => ({ generated_at: '2026-10-05T12:00:00Z', workspaces: [] });
test('only absent to-do tools hide the surface; overview absence leaves working tools available', async () => {
  const absent = await readFixture({ overview, listTodos: async () => { throw new HomeToolsUnavailable(); } }); await absent.load();
  assert.equal(absent.state().state, 'absent'); assert.equal(absent.state().paints.at(-1).available, false);
  const withoutOverview = await readFixture({ overview: async () => { throw new HomeToolsUnavailable(); },
    listTodos: async () => ({ todos: [{ title: 'Book plumber' }], next_offset: null }) }); await withoutOverview.load();
  assert.equal(withoutOverview.state().state, 'ready'); assert.equal(withoutOverview.state().paints.at(-1).available, true);
  assert.deepEqual(withoutOverview.state().paints.at(-1).titles, ['Book plumber']);
  const ready = await readFixture({ overview, listTodos: async () => ({ todos: [{ title: 'Book plumber' }], next_offset: null }) }); await ready.load();
  assert.equal(ready.state().state, 'ready'); assert.equal(ready.state().paints.at(-1).available, true);
  assert.deepEqual(ready.state().paints.at(-1).titles, ['Book plumber']);
  const refused = await readFixture({ overview, listTodos: async () => { throw new HomeCommandRefused('content_consent_required'); } }); await refused.load();
  assert.equal(refused.state().state, 'refused'); assert.deepEqual(refused.state().rows, []);
});
test('a slow workspace read cannot publish its rows after a workspace change', async () => {
  let finish!: (value: unknown) => void;
  const fixture = await readFixture({ overview, listTodos: () => new Promise(resolve => { finish = resolve; }) });
  const load = fixture.load();
  runInContext("activeWorkspaceId = 'X'; ++homeWorkspaceGeneration;", fixture.context);
  finish({ todos: [{ title: 'Private old-workspace title' }], next_offset: null }); await load;
  assert.deepEqual(fixture.state().rows, []); assert.deepEqual(fixture.state().paints, []);
});
test('failed access checks cannot discard available to-dos or invent editor access', async () => {
  const fixture = await readFixture({ overview, listTodos: async () => ({todos:[{title:'Book plumber'}],next_offset:null}) },
    async () => { throw new Error('transport'); });
  runInContext("sampleMode=false; session={user:{id:'tom'}};", fixture.context);
  await fixture.load();
  assert.equal(fixture.state().state, 'ready');
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(householdAccess)', fixture.context)), {workspaceId:'W',status:'unknown',contentRole:null});
});
test('a home read cannot overwrite newer Lists access or a new account in the same workspace', async () => {
  for (const change of ["accessReads.next()", "++householdAccessGeneration", "session={user:{id:'nikki'}}", "++requestVersion"]) {
    let finish!: (value: unknown) => void;
    const fixture = await readFixture({overview, listTodos:async()=>({todos:[],next_offset:null})},
      () => new Promise(resolve => {finish=resolve;}));
    runInContext("sampleMode=false; session={user:{id:'tom'}}; householdAccess={workspaceId:'W',status:'ok',contentRole:'reader'};", fixture.context);
    const loading = fixture.load();
    runInContext(change, fixture.context);
    finish({status:200,body:{status:'ok',content_role:'editor'}});
    await loading;
    assert.equal(runInContext('householdAccess.contentRole', fixture.context), 'reader', change);
  }
  const current = await readFixture({overview, listTodos:async()=>({todos:[],next_offset:null})},
    async () => ({status:200,body:{status:'ok',content_role:'editor'}}));
  runInContext("sampleMode=false; session={user:{id:'tom'}}; householdAccess={workspaceId:'W',status:'ok',contentRole:'reader'};", current.context);
  await current.load();
  assert.equal(runInContext('householdAccess.contentRole', current.context), 'editor');
});
test('a routed To-dos pane becomes visible after rendering and hides again when tools are absent', async () => {
  const slot = { hidden: true, replaceChildren() {} };
  const context = createContext({ slot });
  runInContext(`
    const activeWorkspaceId='W', workspaces=[{id:'W',name:'Home'}], homeRoute={view:'todos'};
    let homeTodosState='ready'; const homeTodoReceipt='', homeTodoFilter='open', homeTodoSave='idle', sampleMode=false;
    const one=()=>slot, homeTodoContext=()=>({now:0,editor:true,people:{groups:[]}}), homeTodoModels=()=>[];
    const personNames=()=>new Map(), todosPane=()=>({}), document={}, replaceHomeRegion=()=>{}, parkPeopleHosts=()=>{};
  `, context);
  runInContext(await dashboardFunctions(['renderHomeObjectPane']), context);
  runInContext('renderHomeObjectPane()', context);
  assert.equal(slot.hidden, false);
  runInContext("homeTodosState='absent'; renderHomeObjectPane();", context);
  assert.equal(slot.hidden, true);
});
async function routedTodoFixture() {
  const context = createContext({});
  runInContext(`
    const buttons = [], slot = {hidden:true, append(node) {buttons.push(node);}};
    const activeWorkspaceId='W', workspaces=[{id:'W',name:'Home'}], homeRoute={view:'todo'}, sampleMode=false;
    const homeTodosState='ready', homeTodoReceipt='', homeQueueRead='ready', homeTodoSave='idle', homeTodoNotice=null, homeGateEditorId=null;
    const homePolicies=new Map(), homeQueue=null, homeTodoRows=[];
    const ctx={now:0, viewerId:'tom', editor:true, people:{groups:[{person:{id:'tom',firstName:'Tom'}}]}};
    const homeTodoRead={todo:{todo_id:'T',offer:{offer_id:'O',decider_user_id:'tom'}}};
    const one=()=>slot, homeTodoContext=()=>ctx, routeHref=()=>'?w=W', mapHomeTodo=()=>({id:'T',title:'Book plumber',assignee:null});
    let receivedVM, receipt;
    const todoView=(doc,vm)=>{receivedVM=vm; return {};}, replaceHomeRegion=()=>{}, parkPeopleHosts=()=>{};
    const homeWrite=async(run,copy)=>{await run({answerRequest:async(w,input)=>{globalThis.answer=input.answer; return {}; }},'R'); receipt=copy({},[]);};
    const document={createElement(){return {setAttribute(name,value){this[name]=value;},addEventListener(name,fn){this[name]=fn;}};}};
  `, context);
  runInContext(await dashboardFunctions(['renderHomeObjectPane']), context);
  runInContext('renderHomeObjectPane()', context);
  return context;
}
test('the request answer receipt speaks to the decider, and buttons name the to-do', async () => {
  const context = await routedTodoFixture();
  await runInContext('buttons.find(button=>button.textContent === "Decline").click()', context);
  assert.equal(runInContext('answer', context), 'decline');
  assert.equal(runInContext('receipt', context), 'Declined.');
  assert.equal(runInContext('buttons[1]["aria-label"]', context), 'Decline ‘Book plumber’');
  await runInContext('buttons.find(button=>button.textContent === "Accept").click()', context);
  assert.equal(runInContext('answer', context), 'accept');
  assert.equal(runInContext('receipt', context), 'Accepted.');
});
test('the first assignment picker uses owner requests until a measured policy allows anyone', async () => {
  const context = await routedTodoFixture();
  assert.equal(runInContext('receivedVM.facts.goesAsRequest("muse")', context), true);
  runInContext('homePolicies.set("muse","anyone");', context);
  assert.equal(runInContext('receivedVM.facts.goesAsRequest("muse")', context), false);
  runInContext('homePolicies.set("muse","owner");', context);
  assert.equal(runInContext('receivedVM.facts.goesAsRequest("muse")', context), true);
});
test('workspace and channel composers keep their own addresses when a thread closes', async () => {
  const input = { placeholder: '', setAttribute() {} };
  const context = createContext({ input });
  runInContext(`
    const one=selector=>selector==='[data-composer-input]' ? input : null;
    let channel=null, threadReplyRoot=null;
    const activeChannel=()=>channel, channelLabel=slug=>slug==='everyone' ? 'everyone' : '#'+slug;
    const threadReplyPlaceOf=()=>({kind:'unfiled'}), threadReplyBlock=()=>null, threadReplyMayBroadcast=()=>false;
  `, context);
  runInContext(await dashboardFunctions(['syncComposerPlacement']), context);
  runInContext('syncComposerPlacement()', context);
  assert.equal(input.placeholder, 'Write to everyone, or type @ to tag a person or an agent');
  runInContext("channel={slug:'mobile'}; syncComposerPlacement();", context);
  assert.equal(input.placeholder, 'Message #mobile');
  runInContext("channel={slug:'everyone'}; threadReplyRoot={}; syncComposerPlacement();", context);
  assert.equal(input.placeholder, 'Reply in this thread');
  runInContext('threadReplyRoot=null; syncComposerPlacement();', context);
  assert.equal(input.placeholder, 'Message everyone');
  runInContext('channel=null; threadReplyRoot={}; syncComposerPlacement();', context);
  assert.equal(input.placeholder, 'Reply in this thread');
  runInContext('threadReplyRoot=null; syncComposerPlacement();', context);
  assert.equal(input.placeholder, 'Write to everyone, or type @ to tag a person or an agent');
});

/** Record the row builder's tree operations. Sanitizing and topic parsing are separate
 * boundaries: this regression checks that their returned tree remains in the message. */
class RowNode {
  children: RowNode[] = []; parent: RowNode | null = null; textContent = ''; className = '';
  dataset: Record<string, string> = {}; attributes = new Map<string, string>(); handlers = new Map<string, () => void>();
  classes = new Set<string>(); classList = { add: (name: string) => this.classes.add(name),
    toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  style = { setProperty() {} }; scrollHeight = 240; clientHeight = 80; connected = false;
  constructor(readonly tag: string) {}
  get isConnected(): boolean { return this.connected || !!this.parent?.isConnected; }
  get firstElementChild(): RowNode | null { return this.children[0] ?? null; }
  append(...nodes: (RowNode | string)[]) { for (const node of nodes) {
    if (typeof node === 'string') { const text = new RowNode('#text'); text.textContent = node; this.append(text); }
    else { node.remove(); node.parent = this; this.children.push(node); }
  } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  replaceChildren(...nodes: RowNode[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  after(node: RowNode) { if (this.parent) { const parent = this.parent; node.remove(); node.parent = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); } }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, handler); }
  descendants(): RowNode[] { return this.children.flatMap(node => [node, ...node.descendants()]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string) { return this.descendants().filter(node => selector.startsWith('.')
    ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector); }
}
test('replying from a stream row preserves the agent ownership label and the root channel', async () => {
  const document = { createElement: (tag: string) => new RowNode(tag) };
  const input = { placeholder: '', setAttribute() {}, focus() {} };
  const target = { textContent: '' };
  const context = createContext({ document, HTMLElement: RowNode, input, target, mapHomePeople, homeParty,
    buildAuthorLine, buildStreamExtras, deriveStreamExtras, canStartThread, THREAD_REPLY_CONTROL_LABEL,
    threadReplyPlace, threadReplyTargetText, agentLabelInSentence, homeAskAnswered, channelLabel, window: { requestAnimationFrame() {} },
    setSanitizedMessageMarkdown: (node: RowNode, body: string) => { node.textContent = body; }, linkifyBrainTopics() {},
  });
  runInContext(`
    const sampleMode=false, session=null, activeWorkspaceId='W', activeChannelId=null, viewerId='tom', now=0;
    const roster=[{principalId:'orbit',name:'Orbit',ownerUserId:'tom',transport:'hosted_mcp'},
      {principalId:'river',name:'River',ownerUserId:'tom',transport:'hosted_mcp'},
      {principalId:'muse',name:'Muse',ownerUserId:'nikki',transport:'hosted_mcp'}];
    const members=[{userId:'tom',name:'Tom',role:'owner'},{userId:'nikki',name:'Nikki',role:'member'}];
    const homePeople=mapHomePeople({viewerId,members,agents:roster,access:[],signals:[],now,sample:false});
    const people=new Map(members.map(member=>[member.userId,member.name])), agentById=new Map(roster.map(agent=>[agent.principalId,agent]));
    const feedWasEmpty=false, previousSignalIds=new Set(), visualMentions=new Map();
    const removedAgentOwners=new Map();
    const agents=roster, channels=[{channelId:'mobile',slug:'mobile'}], signals=[], expandedSignalIds=new Set(), expandedThreadIds=new Set();
    const MESSAGE_COLLAPSE_LINES=6, streamTodos=new Map(), streamWorkspace={id:'W',name:'Home',href:'?w=W'};
    const channelById=(rows,id)=>rows.find(row=>row.channelId===id)??null, activeChannel=()=>null;
    const signalIsDirectToViewer=()=>false, initials=()=>'', kindLabel=kind=>kind, markAgentAvatar=()=>{};
    const formatTime=()=>({absolute:'Oct 5',relative:'Now'}), brainTopicNames=()=>[], appendDeliveryReceipt=()=>{};
    const entityName=entity=>agentById.get(entity.id).name;
    const entityControl=name=>{const node=document.createElement('button'); node.textContent=name; return node;};
    const one=selector=>selector==='[data-composer-input]'?input:selector==='[data-composer-reply-target-text]'?target:null;
    let threadReplyRoot=null; const composerSending=false, threadReplyBlock=()=>null, threadReplyMayBroadcast=()=>false;
    const retireComposerIntentOnAddressMove=()=>{}, syncComposerAddress=()=>{}, renderFeed=()=>{}, selectChannel=()=>{};
  `, context);
  runInContext(await dashboardFunctions(['threadReplyPlaceOf', 'syncComposerPlacement', 'setThreadReplyRoot', 'buildMessageRow']), context);
  for (const [id, channelId, expected] of [
    ['orbit', null, 'Replying to your Orbit in All messages.'],
    ['river', 'mobile', 'Replying to your River in #mobile.'],
    ['muse', null, 'Replying to Nikki’s Muse in All messages.'],
  ] as const) {
    const row = runInContext(`buildMessageRow({id:'S-${id}',from:'${id}',fromKind:'agent',kind:'note',body:'Hello',
      to:null,toAgent:null,about:null,attachments:[],channelId:${JSON.stringify(channelId)},until:null,threadRootId:null,
      createdAt:'2026-10-05T12:00:00Z'},false)`, context) as RowNode;
    const reply = row.querySelector('.dashboard__message-reply');
    assert.ok(reply, `${id}: the eligible root offers a reply`);
    reply.handlers.get('click')!();
    assert.equal(target.textContent, expected, `${id}: the row's author and root channel reach the reply bar`);
    assert.equal(input.placeholder, 'Reply in this thread');
    runInContext('setThreadReplyRoot(null)', context);
  }
});
test('an ask card keeps the full sanitized question, links, topic controls and Show more', async () => {
  const document = { createElement: (tag: string) => new RowNode(tag) };
  const frames: (() => void)[] = [];
  const question = 'Which option should we take? '.repeat(24) + '[Read the options](https://example.test/options) Budget';
  let withoutTitle = false;
  const context = createContext({ document, HTMLElement: RowNode, buildAuthorLine,
    buildStreamExtras: (...args: Parameters<typeof buildStreamExtras>) => { const result = buildStreamExtras(...args); if (withoutTitle) (result as unknown as RowNode)?.querySelector('.hm-needs-title')?.remove(); return result; }, deriveStreamExtras, question, homeAskAnswered,
    window: { requestAnimationFrame: (callback: () => void) => frames.push(callback) },
    setSanitizedMessageMarkdown: (node: RowNode, body: string) => { node.textContent = body;
      const link = document.createElement('a'); link.setAttribute('href', 'https://example.test/options'); node.append(link); },
    linkifyBrainTopics: (node: RowNode) => { const topic = document.createElement('button'); topic.textContent = 'Budget'; node.append(topic); },
  });
  runInContext(`
    const sampleMode=false, session=null, activeWorkspaceId='W', activeChannelId=null, viewerId='tom', now=0;
    const feedWasEmpty=false, previousSignalIds=new Set(), agentById=new Map(), people=new Map(), visualMentions=new Map();
    const removedAgentOwners=new Map([['removed-own','tom'],['removed-other','nikki']]);
    const agents=[], channels=[], signals=[], expandedSignalIds=new Set(), MESSAGE_COLLAPSE_LINES=6, streamTodos=new Map();
    const streamWorkspace={id:'W',name:'Home',href:'?w=W'}, homePeople={};
    const homeParty=()=>({id:'claude',name:'Claude',label:'Your Claude',nestedLabel:'Claude',ownerId:'tom',
      ownerFirstName:'Tom',ownerInitial:'T',yours:true,tint:0,hosted:true,state:{kind:'idle',word:'Idle'}});
    const signalIsDirectToViewer=(signal,viewer)=>signal.to===viewer, initials=()=>'', kindLabel=kind=>kind;
    const formatTime=()=>({absolute:'Oct 5',relative:'Now'}), channelById=()=>null, brainTopicNames=()=>['Budget'];
    const appendDeliveryReceipt=()=>{}, canStartThread=()=>false;
  `, context);
  runInContext(await dashboardFunctions(['buildMessageRow']), context);
  for (const [kind, from, reply, missingTitle] of [['ask','claude',null,false],['note','claude',null,false],['ask','claude','removed-own',false],['ask','claude','removed-other',false],['ask','claude',null,true]] as const) {
    withoutTitle = missingTitle;
    runInContext(`expandedSignalIds.clear(); signals.splice(0, signals.length, ...${reply ? JSON.stringify([{id:'reply',from:reply,fromKind:'agent',kind:'note',inReplyTo:`S-${kind}`}]) : '[]'});`, context);
    const row = runInContext(`buildMessageRow({id:'S-${kind}',from:'claude',fromKind:'agent',kind:'${kind}',body:question,
      to:'tom',toAgent:null,about:null,attachments:[],channelId:null,createdAt:'2026-10-05T12:00:00Z'},false)`, context) as RowNode;
    row.connected = true;
    for (const frame of frames.splice(0)) frame();
    const markdown = row.querySelector('.dashboard__message-markdown');
    assert.ok(markdown, `${kind}: the sanitizer's complete tree stays in the row`);
    assert.equal(row.querySelectorAll('.dashboard__message-markdown').length, 1, 'the question appears once');
    assert.equal(markdown.textContent, question, `${kind}: text beyond the card excerpt remains readable`);
    assert.equal(markdown.querySelector('a')?.getAttribute('href'), 'https://example.test/options');
    assert.equal(markdown.querySelector('button')?.textContent, 'Budget');
    const needsYou = kind === 'ask' && reply !== 'removed-own';
    assert.equal(row.querySelector('.hm-needs-you') !== null, needsYou);
    if (needsYou && !missingTitle) assert.equal(row.querySelector('.hm-needs-title')?.textContent, 'Your Claude asked you:', 'the question appears once, in the sanitized body');
    const toggle = row.querySelector('.dashboard__message-toggle');
    assert.equal(toggle?.textContent, 'Show more'); toggle?.handlers.get('click')?.();
    assert.equal(toggle?.getAttribute('aria-expanded'), 'true');
    assert.equal(markdown.classes.has('dashboard__message-markdown--collapsed'), false);
  }
});
test('a refused or failed to-do read keeps an honest right-column door, while absent tools hide it', async () => {
  const context = createContext({});
  runInContext(`
    const slot={}, activeWorkspaceId='W', workspaces=[{id:'W',name:'Home'}], homeRoute={view:'chat'}, sampleMode=false;
    let homeTodosState='ready', homeTodoReceipt=''; const homeObjects={state:'pending'}, files=[], householdConnectionsReadState='pending';
    const one=()=>slot, homeTodoContext=()=>({now:0,editor:true}), homeTodoModels=()=>[], routeHref=()=>'?w=W';
    let painted; const buildSideCards=(doc,vm)=>{painted=vm; return {};}, document={}, replaceHomeRegion=()=>{};
  `, context);
  runInContext(await dashboardFunctions(['homeTodosAvailable', 'renderHomeSide']), context);
  runInContext('renderHomeSide()', context);
  assert.equal(runInContext('painted.todos.canAdd', context), true);
  for (const state of ['refused', 'failed']) {
    runInContext(`homeTodosState='${state}'; homeTodoReceipt='Open Lists & docs to choose your access.'; renderHomeSide();`, context);
    assert.equal(runInContext('painted.todos.notice', context), 'Open Lists & docs to choose your access.');
    assert.equal(runInContext('painted.todos.canAdd', context), false);
  }
  runInContext("homeTodosState='absent'; renderHomeSide();", context);
  assert.equal(runInContext('painted.todos', context), null);
});
test('an unknown write outcome is shown plainly; a late result never writes to the next workspace', async () => {
  const context = createContext({ HomeCommandRefused, HomeToolsUnavailable, CommandOutcomeUnknown, crypto: { randomUUID: () => 'request-1' } });
  runInContext(`
    let activeWorkspaceId='W', homeWorkspaceGeneration=1, homeNavigation=1, homeTodoSave='idle', homeTodoReceipt='', homeTodoNotice=null, homeTodoRead=null, homeDetailKey='';
    let homeTodosState='ready', homeTodoRows=[], homeQueue=null, homeQueueRead='ready'; const homeRoute={view:'todos'};
    const sampleMode=false, homeServer=()=>({}), workspaces=[{id:'W',name:'Home'}], homePolicies=new Map();
    const renderHomeObjectPane=()=>{}, renderHomeSide=()=>{}, renderHomeShell=()=>{}, all=()=>[], loadHomeWorkspace=async()=>{};
    const TODO_RESULT_UNKNOWN='The result is unknown. Reload to check.', TODO_SAVE_FAILED='Not saved. Check your connection and try again.';
  `, context);
  runInContext(await dashboardFunctions(['homeRefusalCopy', 'homeWrite']), context);
  await runInContext("homeWrite(async () => { throw new CommandOutcomeUnknown('Transport prose'); })", context);
  assert.equal(runInContext('homeTodoSave', context), 'unknown');
  assert.equal(runInContext('homeTodoReceipt', context), 'The result is unknown. Reload to check.');
  await runInContext("homeWrite(async () => ({status:'refused',reason:'owner_only'}))", context);
  assert.equal(runInContext('homeTodoSave', context), 'failed');
  assert.equal(runInContext('homeTodoReceipt', context), 'Only its owner can change its line.');
  const pending = runInContext("homeWrite(() => new Promise(resolve => { globalThis.finishWrite=resolve; }))", context);
  runInContext("activeWorkspaceId='X'; ++homeWorkspaceGeneration; homeTodoReceipt='New workspace'; homeTodoSave='idle'; finishWrite({status:'committed',value:{},notices:[]});", context);
  await pending;
  assert.equal(runInContext('homeTodoReceipt', context), 'New workspace');
  await runInContext("homeWrite(async () => { throw new HomeToolsUnavailable(); })", context);
  assert.equal(runInContext('homeTodosState', context), 'absent');
});


test('the role client posts the change_role envelope, and each reducer refusal is the spec sentence', async () => {
  const protocol = await readFile(new URL('../../../../src/protocol/workspace-commands.ts', import.meta.url), 'utf8');
  const start = protocol.indexOf("case 'change_role': {");
  const body = protocol.slice(start, protocol.indexOf("case 'create_agent_principal'", start));
  const codes = [...new Set([...body.matchAll(/domain\(\s*ctx,\s*cmd\.kind,\s*'([a-z_]+)'/g)].map(match => match[1]))].sort();
  const spec = await readFile(new URL('../../../../docs/design/2026-10-05-consumer-home-ui/UI-SPEC.md', import.meta.url), 'utf8');
  const section = spec.slice(spec.indexOf('### 3.6 '), spec.indexOf('### 3.7 ', spec.indexOf('### 3.6 ')));
  const specCopy = new Map([...section.matchAll(/^\| `([a-z_]+)` \| "([^"]+)" \|$/gm)].map(match => [match[1], match[2]]));
  assert.deepEqual([...specCopy.keys()].sort(), codes);
  assert.equal(codes.length, 5);
  const raw = await readFile(new URL('../../lib/commonswarm.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('client.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'changeWorkspaceRole');
  assert.ok(fn);
  const code = ts.transpileModule(fn.getText(ast).replace(/^export /, ''), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const commands: unknown[][] = [];
  let result: { status: number; body: Record<string, unknown> } = { status: 200, body: { status: 'rejected', ok: false, reason: codes[0] } };
  const context = createContext({ WorkspaceRoleRefused, FreshLoginRequired, postCommand: async (...args: unknown[]) => { commands.push(args); return result; } });
  runInContext(code, context);
  const envelope = { kind: 'change_role', user_id: 'nikki', role: 'admin' };
  for (const reason of codes) {
    const before = commands.length;
    result = { status: 200, body: { status: 'rejected', ok: false, reason } };
    await assert.rejects(runInContext("changeWorkspaceRole({user:{id:'tom'}}, 'command', 'Home-id', 'nikki', 'admin')", context), (error: unknown) => {
      assert.ok(error instanceof WorkspaceRoleRefused);
      assert.equal(peopleRoleRefusal(peopleRoleErrorCode(error), 'Nikki', 'Home'), specCopy.get(reason));
      return true;
    });
    assert.deepEqual(JSON.parse(JSON.stringify(commands[before])), [{ user: { id: 'tom' } }, 'command', envelope, { workspace_id: 'Home-id', stream: { kind: 'workspace' } }]);
  }
  assert.ok(codes.includes('role_forbidden'));
  const forbidden = { status: 403, body: { error: 'role_forbidden' } };
  assert.equal('reason' in forbidden.body, false);
  const beforeForbidden = commands.length;
  result = forbidden;
  await assert.rejects(runInContext("changeWorkspaceRole({user:{id:'tom'}}, 'command', 'Home-id', 'nikki', 'admin')", context), (error: unknown) => {
    assert.ok(error instanceof WorkspaceRoleRefused);
    assert.equal((error as { code: string }).code, forbidden.body.error);
    assert.equal(peopleRoleRefusal(peopleRoleErrorCode(error), 'Nikki', 'Home'), specCopy.get('role_forbidden'));
    return true;
  });
  assert.deepEqual(JSON.parse(JSON.stringify(commands[beforeForbidden])), [{ user: { id: 'tom' } }, 'command', envelope, { workspace_id: 'Home-id', stream: { kind: 'workspace' } }]);
  const processing = { status: 200, body: { status: 'processing' } };
  assert.equal(codes.includes('unknown'), false);
  assert.equal(specCopy.has('unknown'), false);
  const beforeProcessing = commands.length;
  result = processing;
  await assert.rejects(runInContext("changeWorkspaceRole({user:{id:'tom'}}, 'command', 'Home-id', 'nikki', 'admin')", context), (error: unknown) => {
    assert.ok(error instanceof WorkspaceRoleRefused);
    assert.equal((error as { code: string }).code, 'unknown');
    const shown = peopleRoleRefusal(peopleRoleErrorCode(error), 'Nikki', 'Home');
    assert.equal(shown, 'The role change was not confirmed. Reload to check.');
    for (const sentence of specCopy.values()) assert.notEqual(shown, sentence);
    return true;
  });
  assert.deepEqual(JSON.parse(JSON.stringify(commands[beforeProcessing])), [{ user: { id: 'tom' } }, 'command', envelope, { workspace_id: 'Home-id', stream: { kind: 'workspace' } }]);
  const staleSignIn = { status: 401, body: { error: 'fresh_auth_required', message: 'Sign in again, then retry the role change. No membership change was recorded.' } };
  assert.equal(codes.includes('fresh_auth_required'), false, 'fresh sign-in is refused before the reducer');
  assert.equal(specCopy.has('fresh_auth_required'), false);
  const beforeStale = commands.length;
  result = staleSignIn;
  await assert.rejects(runInContext("changeWorkspaceRole({user:{id:'tom'}}, 'command', 'Home-id', 'nikki', 'admin')", context), (error: unknown) => {
    assert.ok(error instanceof FreshLoginRequired);
    assert.equal(error instanceof WorkspaceRoleRefused, false);
    const shown = peopleRoleRefusal(peopleRoleErrorCode(error), 'Nikki', 'Home');
    assert.equal(shown, 'Sign in again, then retry the role change. No membership change was recorded.');
    assert.notEqual(shown, 'The role change was not confirmed. Reload to check.');
    return true;
  });
  assert.deepEqual(JSON.parse(JSON.stringify(commands[beforeStale])), [{ user: { id: 'tom' } }, 'command', envelope, { workspace_id: 'Home-id', stream: { kind: 'workspace' } }]);
});

test('browser reads retain a top-level directed reply reference', () => {
  assert.ok(BROWSER_SIGNAL_COLUMNS.split(',').includes('in_reply_to'));
  const signal = browserSignalFromRow({id:'reply',from:'tom',from_kind:'user',kind:'note',body:'Done',created_at:'2026-10-05T12:00:00Z',in_reply_to:'ask'});
  assert.equal(signal.inReplyTo, 'ask');
});


test('each navigation focuses the visible H1 for that view', async () => {
  const frames: (()=>void)[] = [], selectors: string[] = [], focused: string[] = [];
  const context = createContext({homeViewTitle:()=> 'View · CommonSwarm', window:{requestAnimationFrame:(fn:()=>void)=>frames.push(fn)},
    document:{title:''}, all:(selector:string)=>{selectors.push(selector);return [{getClientRects:()=>[],focus:()=>focused.push('hidden')},{getClientRects:()=>[{}],focus:()=>focused.push(selector)}];}});
  runInContext("let homeRoute, workspaces=[{id:'W',name:'Home'}];",context);
  runInContext(await dashboardFunctions(['focusHomeView']),context);
  const scopes = {catchup:'[data-home-catchup]',chat:'[data-home-workspace-shell]',todos:'[data-home-route-pane]',todo:'[data-home-route-pane]',agent:'[data-home-route-pane]',new:'[data-panel=create]', 'add-agent':'[data-channel-view=agent-choice]',lists:'[data-channel-view=objects]',files:'[data-channel-view=files]',wiki:'[data-channel-view=brain]'};
  for (const [view,scope] of Object.entries(scopes)) {
    runInContext(`homeRoute={view:${JSON.stringify(view)},workspaceId:'W'};focusHomeView();`,context);
    assert.equal(frames.length,1); frames.shift()!();
    assert.equal(selectors.at(-1), `${scope} h1`); assert.equal(focused.at(-1),`${scope} h1`);
  }
});


test('the Add agent poll passes the measured joined time and ignores another owner', async () => {
  const joined: unknown[] = [], intervals: number[] = [];
  let tick: ()=>void = ()=>{};
  const context = createContext({document:{visibilityState:'visible'}, window:{setInterval:(fn:()=>void,ms:number)=>{tick=fn;intervals.push(ms);return 1;},clearInterval(){}},
    one:()=>({showJoined:(value:unknown)=>joined.push(JSON.parse(JSON.stringify(value)))}), renderRoster:()=>{},
    roster:async()=>[{principalId:'foreign',name:'Muse',ownerUserId:'nikki',joinedAt:'2026-10-05T11:31:00Z'},
      {principalId:'own',name:'Claude',ownerUserId:'tom',joinedAt:'2026-10-05T11:32:00Z'}] });
  runInContext("let session={user:{id:'tom'}},activeWorkspaceId='W',requestVersion=1,sampleMode=false,agents=[],hostJoinGeneration=0,hostJoinTimer,hostJoinKnown=new Set(),hostJoinStartedAt=0;const app={dataset:{channelView:'agent-choice'}},householdAccess={status:'ok',workspaceId:'W'};",context);
  runInContext(await dashboardFunctions(['stopHostJoinWatch','startHostJoinWatch']),context);
  runInContext('startHostJoinWatch()',context); tick(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(intervals,[5000]);
  assert.deepEqual(joined,[{name:'Claude',principalId:'own',canApprove:true,joinedAt:'2026-10-05T11:32:00Z'}]);
});


test('an accepted role save stays successful when the roster refresh fails', async () => {
  const raw = await readFile(new URL('./LiveDashboard.astro', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('dashboard.ts', raw.match(/<script>([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  let changeRole: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'changeRole') changeRole = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(changeRole);
  const code = ts.transpileModule(`const changeRole = ${changeRole.getText(ast)};`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const context = createContext({ changeWorkspaceRole: async () => {}, memberRoster: async () => { throw new Error('read failed'); } });
  runInContext("let session={user:{id:'tom'}},activeWorkspaceId='W',sampleMode=false,members=[{userId:'nikki',role:'member'}],memberReauthNext='role'; const peopleDialogState={rolePending:new Map()}, uuid=()=> 'R', one=()=>null; let paints=0; const renderRoster=()=>{paints++;};",context);
  runInContext(code,context);
  await runInContext("changeRole({kind:'change-role',userId:'nikki',role:'admin'})",context);
  assert.equal(runInContext('members[0].role',context),'admin');
  assert.equal(runInContext('memberReauthNext',context),'remove');
  assert.equal(runInContext('paints',context),1,'the accepted command updates facts even if the follow-up read fails');
  runInContext("members[0].role='member';",context);
  for (const blocked of [
    "session=null; activeWorkspaceId='W'; sampleMode=false",
    "session={user:{id:'tom'}}; activeWorkspaceId=''; sampleMode=false",
    "session={user:{id:'tom'}}; activeWorkspaceId='W'; sampleMode=true",
  ]) {
    await assert.rejects(
      () => runInContext(`${blocked}; changeRole({kind:'change-role',userId:'nikki',role:'admin'})`, context),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'role_unavailable');
        return true;
      },
    );
    assert.equal(runInContext('members[0].role', context), 'member', blocked);
  }
});

test('a stale sign-in on role change opens the sign-in path and leaves the role unchanged', async () => {
  const raw = await readFile(new URL('./LiveDashboard.astro', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('dashboard.ts', raw.match(/<script>([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  let changeRole: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'changeRole') changeRole = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(changeRole);
  const code = ts.transpileModule(`const changeRole = ${changeRole.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const shown = { reauthHidden: true, errorHidden: true, errorText: '', focused: '', roleConfirmClosed: false, peopleConfirmClosed: false };
  const context = createContext({
    FreshLoginRequired,
    changeWorkspaceRole: async () => { throw new FreshLoginRequired('Sign in again, then retry the role change. No membership change was recorded.'); },
    memberRoster: async () => { throw new Error('roster must not be read'); },
    readableError: (error: unknown) => error instanceof Error ? error.message : 'CommonSwarm could not complete that request.',
    one: (selector: string) => {
      if (selector === '[data-member-reauth]') return { get hidden() { return shown.reauthHidden; }, set hidden(value: boolean) { shown.reauthHidden = value; } };
      if (selector === '[data-member-error]') return {
        get hidden() { return shown.errorHidden; }, set hidden(value: boolean) { shown.errorHidden = value; },
        get textContent() { return shown.errorText; }, set textContent(value: string) { shown.errorText = value; },
      };
      if (selector === '[data-role-confirm]') return { close: () => { shown.roleConfirmClosed = true; } };
      if (selector === '[data-people-confirm]') return { close: () => { shown.peopleConfirmClosed = true; } };
      if (selector === '[data-member-reauth] button') return { focus: () => { shown.focused = selector; } };
      return null;
    },
  });
  runInContext("let session={user:{id:'tom'}},activeWorkspaceId='W',sampleMode=false,members=[{userId:'nikki',role:'member'}],memberReauthNext='remove'; const peopleDialogState={rolePending:new Map()}, uuid=()=> 'R'; const renderRoster=()=>{ throw new Error('paint must not run'); };", context);
  runInContext(code, context);
  await assert.rejects(
    () => runInContext("changeRole({kind:'change-role',userId:'nikki',role:'admin'})", context),
    (error: unknown) => { assert.ok(error instanceof FreshLoginRequired); return true; },
  );
  assert.equal(shown.reauthHidden, false);
  assert.equal(shown.errorHidden, false);
  assert.equal(shown.errorText, 'Sign in again, then retry the role change. No membership change was recorded.');
  assert.equal(shown.roleConfirmClosed, true);
  assert.equal(shown.peopleConfirmClosed, false);
  assert.equal(shown.focused, '[data-member-reauth] button');
  assert.equal(runInContext('memberReauthNext', context), 'role');
  assert.equal(runInContext('members[0].role', context), 'member');
});

const ROLE_SIGN_IN_EMAIL = 'Check your email. After signing in, return here and press Save again.';
const REMOVE_SIGN_IN_EMAIL = 'Check your email. After signing in, return here and press Remove again.';

function sourceInitializer(source: string, name: string): string {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  let text = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) text = node.initializer.getText(ast);
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name) text = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(text, name);
  return text;
}

function emailReauthHandler(source: string): string {
  const ast = ts.createSourceFile('dashboard.ts', source, ts.ScriptTarget.Latest, true);
  let text = '';
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addEventListener'
      && node.expression.expression.getText(ast).includes('data-member-reauth-email')) {
      text = node.arguments[1]?.getText(ast) ?? '';
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(text, 'email reauth handler');
  return text;
}

test('a stale self-role save ends on sign-in, and the email names Save; removal still names Remove', async () => {
  const dashboard = (await readFile(new URL('./LiveDashboard.astro', import.meta.url), 'utf8')).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(dashboard);
  const view = await readFile(new URL('../../lib/people-dialog-view.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule([
    `const changeRole = ${sourceInitializer(dashboard, 'changeRole')};`,
    `const peopleDialogAction = ${sourceInitializer(dashboard, 'peopleDialogAction')};`,
    `const memberReauthEmailCopy = ${sourceInitializer(dashboard, 'memberReauthEmailCopy')};`,
    `const emailReauth = ${emailReauthHandler(dashboard)};`,
    `const refocusRole = ${sourceInitializer(view, 'refocusRole')};`,
    `const commit = ${sourceInitializer(view, 'commit')};`,
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const focusLog: string[] = [];
  const closed: string[] = [];
  const shown = { reauthHidden: true, errorHidden: true, errorText: '' };
  const stored: string[] = [];
  let roleError: unknown = new FreshLoginRequired('Sign in again, then retry the role change. No membership change was recorded.');
  const context = createContext({
    FreshLoginRequired,
    peopleRoleBeginSave, peopleRoleFinishSave, peopleRoleRefusal, peopleRoleErrorCode, peopleRoleReceipt,
    focusLog, closed,
    changeWorkspaceRole: async () => { throw roleError; },
    removeWorkspaceMember: async () => { throw new FreshLoginRequired(); },
    memberRoster: async () => { throw new Error('roster must not be read'); },
    readableError: (error: unknown) => error instanceof Error ? error.message : 'CommonSwarm could not complete that request.',
    peopleDialogCanAct: () => true,
    peopleDialogModel: () => ({ people: [], agents: [] }),
    signInWithEmail: async () => {},
    URL,
    window: { prompt: () => 'owner@example.test', location: { origin: 'https://example.test' } },
    sessionStorage: { setItem: (key: string) => { stored.push(key); } },
    one: (selector: string) => {
      if (selector === '[data-member-reauth]') return { get hidden() { return shown.reauthHidden; }, set hidden(value: boolean) { shown.reauthHidden = value; } };
      if (selector === '[data-member-error]') return {
        get hidden() { return shown.errorHidden; }, set hidden(value: boolean) { shown.errorHidden = value; },
        get textContent() { return shown.errorText; }, set textContent(value: string) { shown.errorText = value; },
      };
      if (selector === '[data-role-confirm]') return { close: () => { closed.push('role'); } };
      if (selector === '[data-people-confirm]') return { close: () => { closed.push('people'); } };
      if (selector === '[data-member-reauth] button') return { focus: () => { focusLog.push('sign-in-dashboard'); } };
      return null;
    },
    doc: { querySelector: (selector: string) => selector === '[data-member-reauth] button' ? { focus: () => { focusLog.push('sign-in-final'); } } : null },
    detail: { querySelector: (selector: string) => ({ focus: () => { focusLog.push(selector.includes('data-pd-focus') ? 'role-select' : 'heading'); } }) },
  });
  const setup = "let session={user:{id:'tom'}},activeWorkspaceId='W',sampleMode=false,memberReauthNext='remove';"
    + "let members=[{userId:'tom',role:'owner',name:'Tom Langridge'}],draft={userId:'tom',role:'admin',confirming:true};"
    + "const peopleDialogState={rolePending:new Map(),selected:{type:'person',id:'tom'}},state=peopleDialogState,uuid=()=>'R';"
    + "const person={id:'tom',name:'Tom Langridge',role:'owner'},model={workspaceName:'Home'},agents=[],accessStatuses=[];";
  runInContext(setup + code + "const callbacks={render(){focusLog.push('render');},changeRole(change){return changeRole(change);}};", context);
  await runInContext("commit('admin')", context);
  assert.deepEqual(focusLog, ['render', 'sign-in-dashboard', 'render', 'sign-in-final']);
  assert.equal(focusLog.includes('role-select'), false);
  assert.deepEqual(closed, ['role']);
  assert.equal(shown.reauthHidden, false);
  assert.equal(runInContext('memberReauthNext', context), 'role');
  assert.equal(runInContext('members[0].role', context), 'owner');
  assert.equal(runInContext('state.roleDraft.confirming', context), false);
  assert.equal(runInContext('state.roleRefusal.text', context), 'Sign in again, then retry the role change. No membership change was recorded.');
  await runInContext('emailReauth({currentTarget:{disabled:false}})', context);
  assert.equal(shown.errorText, ROLE_SIGN_IN_EMAIL);
  assert.equal(shown.errorText.includes('Remove'), false);
  await assert.rejects(
    () => runInContext("peopleDialogAction('remove-person','nikki',{disabled:false},{})", context),
    (error: unknown) => { assert.ok(error instanceof FreshLoginRequired); return true; },
  );
  assert.equal(runInContext('memberReauthNext', context), 'remove');
  assert.deepEqual(stored, ['commonswarm.pending-member-selection']);
  assert.equal(closed.includes('people'), true);
  await runInContext('emailReauth({currentTarget:{disabled:false}})', context);
  assert.equal(shown.errorText, REMOVE_SIGN_IN_EMAIL);
  assert.equal(shown.errorText.includes('Save'), false);
  focusLog.length = 0; closed.length = 0;
  roleError = Object.assign(new Error('ignored'), { code: 'last_owner' });
  runInContext("peopleDialogState.rolePending=new Map(); peopleDialogState.roleRefusal=null; peopleDialogState.roleDraft=null; draft=null;", context);
  await runInContext("commit('member')", context);
  assert.equal(focusLog.at(-1), 'role-select');
  assert.equal(focusLog.includes('sign-in-final'), false);
  assert.equal(focusLog.includes('sign-in-dashboard'), false);
  assert.deepEqual(closed, []);
  assert.equal(shown.reauthHidden, true);
  assert.equal(runInContext('state.roleRefusal.text', context), 'Home needs at least one owner. Make someone else an owner first.');
});

/* People & agents is a page now (2026-10-07). ~~"falls back to the roster heading"~~ of the dialog:
   on the page an absent target falls back to the page title, and a visit from elsewhere navigates. */
test('an absent People & agents target falls back to the page heading', async () => {
  const frames: (()=>void)[] = [], focused: string[] = [], navigations: unknown[] = []; let rendered = 0;
  const context = createContext({window:{requestAnimationFrame:(fn:()=>void)=>frames.push(fn)},
    one:(selector:string)=>selector==='#pd-page-title'?{focus:()=>focused.push('page')}:null,
    all:()=>[], renderDialogRoster:()=>{ rendered++; }, loadHouseholdConnections:()=>{},
    navigateHome:(route:unknown, mode:string)=>{ navigations.push([route, mode]); return Promise.resolve(); },
    peopleDialogState:{query:'',selected:null,focusApplied:null},sampleMode:true});
  runInContext("let peopleDialogFocus,rosterFilter='',activeWorkspaceId='W',homeRoute={view:'people',workspaceId:'W'};",context);
  runInContext(await dashboardFunctions(['openRosterDialog','focusPeoplePage']),context);
  await runInContext("openRosterDialog({kind:'person',id:'gone'})",context);
  for (const frame of frames) frame();
  assert.deepEqual(focused,['page']);
  assert.equal(rendered,1,'already on the page: it re-renders in place');
  assert.deepEqual(navigations,[]);
  /* Positive control on the same context: from the workspace, the door navigates to the page. */
  runInContext("homeRoute={view:'chat',workspaceId:'W'}",context);
  await runInContext("openRosterDialog()",context);
  assert.deepEqual(JSON.parse(JSON.stringify(navigations)),[[{view:'people',workspaceId:'W'},'push']]);
});


test('past agents owned by the viewer remain answerers beyond the 200-name history window', async () => {
  const ranges: number[][] = [], filters: unknown[][] = [];
  const query = {schema:()=>query,from:()=>query,select:()=>query,order:()=>query,
    eq:(...args:unknown[])=>{filters.push(args);return query;},not:(...args:unknown[])=>{filters.push(args);return query;},
    range:async(start:number,end:number)=>{ranges.push([start,end]);return {data:Array.from({length:start===200?1:100},(_,i)=>({principal_id:`old-${start+i}`}))};}};
  const context = createContext({client:()=>query,sampleMode:false});
  runInContext(await dashboardFunctions(['readRemovedAgentOwners']),context);
  const result = await runInContext("readRemovedAgentOwners('W','tom')",context) as Map<string,string>;
  assert.equal(result.size,201); assert.equal(result.get('old-200'),'tom');
  assert.deepEqual(ranges,[[0,99],[100,199],[200,299]]);
  assert.ok(filters.some(values=>values[0]==='workspace_id'&&values[1]==='W'));
  assert.ok(filters.some(values=>values[0]==='owner_user_id'&&values[1]==='tom'));
  assert.ok(filters.some(values=>values[0]==='revoked_at'&&values[1]==='is'&&values[2]===null));
  for (const statement of ["sampleMode=true; readRemovedAgentOwners('W','tom')", "sampleMode=false; readRemovedAgentOwners('W','')"]) {
    assert.equal((await runInContext(statement,context)).size,0);
    assert.equal(ranges.length,3,'unknown viewers and samples make no read');
  }
});

test('Add agent receives the viewer first name and Home and Done leave that screen', async () => {
  const seen: Array<{ workspaceName?: string; accountEmail?: string; viewerFirstName?: string }> = [];
  const backs: boolean[] = [];
  const context = createContext({
    personFirstName,
    parentRoute,
    seen,
    window: {
      requestAnimationFrame() {},
      history: { state: { home: true, homePrevious: true }, back() { backs.push(true); } },
    },
  });
  runInContext(`
    let sampleMode = false, activeWorkspaceId = 'W', accountLabel = 'tom@example.test';
    let homeRoute = { view: 'add-agent', workspaceId: 'W' };
    const workspaces = [{ id: 'W', name: 'Home' }];
    const members = [{ userId: 'tom', name: 'Tom Langridge', role: 'owner' }];
    const session = { user: { id: 'tom', email: 'tom@example.test', user_metadata: { user_name: 'Tom Langridge' } } };
    const accountName = () => accountLabel;
    const picker = { reset() {}, setContext(value) { seen.push(value); } };
    const one = selector => selector === 'agent-host-picker' ? picker : null;
    const navigated = [], stopped = [];
    const navigateHome = (route, mode) => { navigated.push({ route, mode }); };
    const stopHostJoinWatch = () => { stopped.push('stop'); };
    const showChannelView = () => {};
  `, context);
  runInContext(await dashboardFunctions(['openAgentChoice', 'homeBack', 'leaveAddAgentForHome', 'finishJoinedAgent']), context);
  runInContext('openAgentChoice()', context);
  assert.equal(seen[0]?.viewerFirstName, 'Tom');
  assert.equal(seen[0]?.workspaceName, 'Home');
  assert.equal(seen[0]?.accountEmail, 'tom@example.test');
  assert.equal(addAgentOwnershipLine('Home', seen[0]?.viewerFirstName ?? '', 'agent'),
    'It joins as yours. People in Home see it as Tom’s agent.');
  assert.equal(addAgentOwnershipLine('Home', seen[0]?.viewerFirstName ?? '', 'Claude'),
    'It joins as yours. People in Home see it as Tom’s Claude.');
  runInContext("members.length = 0; accountLabel = 'Tom Langridge'; openAgentChoice();", context);
  assert.equal(seen[1]?.viewerFirstName, 'Tom', 'an account name supplies the first name when the roster has not arrived');
  runInContext("accountLabel = 'tom@example.test'; openAgentChoice();", context);
  assert.equal(seen[2]?.viewerFirstName, '');
  assert.equal(addAgentOwnershipLine('Home', seen[2]?.viewerFirstName ?? '', 'agent'),
    'It joins as yours. People in Home see it as your agent.');
  runInContext("accountLabel = 'your account'; openAgentChoice();", context);
  assert.equal(seen[3]?.viewerFirstName, '');
  assert.equal(addAgentOwnershipLine('Home', seen[3]?.viewerFirstName ?? '', 'agent'),
    'It joins as yours. People in Home see it as your agent.');
  const stopsAfterOpen = runInContext('stopped.length', context) as number;
  const navigated = () => JSON.parse(runInContext('JSON.stringify(navigated)', context) as string) as Array<{ route: { view: string; workspaceId?: string; agentId?: string }; mode: string }>;
  runInContext('leaveAddAgentForHome()', context);
  assert.deepEqual(backs, [true], 'Home uses history.back when the previous entry is ours');
  assert.deepEqual(navigated(), []);
  runInContext('window.history.state = {}; leaveAddAgentForHome();', context);
  assert.deepEqual(navigated()[0], { route: { view: 'catchup' }, mode: 'push' });
  runInContext("finishJoinedAgent('orbit')", context);
  assert.deepEqual(navigated()[1], { route: { view: 'agent', workspaceId: 'W', agentId: 'orbit' }, mode: 'push' });
  runInContext("const before = navigated.length; finishJoinedAgent(''); globalThis.stayed = navigated.length === before;", context);
  assert.equal(runInContext('stayed', context), true);
  assert.equal(runInContext('stopped.length', context), stopsAfterOpen + 4, 'Home, the fallback Home, Done and an empty Done each stop the join watch');
});
