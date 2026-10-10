/** CI-only browser proof of the production roster normalizer, renderer and UUID addressing. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { browserTest as test, findChrome, launchChrome } from '../../../tests/chrome.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

test('hosted chat badges stay distinct, grouped by app, searchable and addressed by UUID', { timeout: 60000 }, async () => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, 'sid-badges-'));
  try {
    const bundled = await build({ absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
      stdin: { contents: `
        export { renderPeopleDialog, peopleDialogGroups } from './src/lib/people-dialog-view.ts';
        export { rosterAgentsFromRows, renderSidebarParticipants } from './src/lib/participant-rail.ts';
        export { hostedContextLabel, hostedContextPeopleLabel, hostedContextChatAuthor } from './src/lib/hosted-context-label.ts';
        export { mapHomePeople, homeParty } from './src/lib/home-map.ts';
        export { buildAuthorLine } from './src/lib/home-stream.ts';
        export { browserSignalCommand } from './src/lib/commonswarm.ts';`,
        resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), loader: 'ts' },
      bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'UI' });
    const tokens = await readFile(new URL('../../styles/tokens.css', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../styles/home/people.css', import.meta.url), 'utf8');
    const dashboard = await readFile(new URL('./LiveDashboard.astro', import.meta.url), 'utf8');
    const componentStyle = dashboard.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1];
    assert.ok(componentStyle);
    const rows = [
      { principal_id: first, name: 'Claude-7K2P', display_name: 'Claude', disambiguator: '7K2P',
        identity_lifetime: 'ephemeral', transport: 'hosted_mcp', owner_user_id: 'owner', app: { client_id: 'claude-app', display_name: 'Claude' } },
      { principal_id: second, name: 'Claude-8N3Q', display_name: 'Claude', disambiguator: '8N3Q',
        identity_lifetime: 'ephemeral', transport: 'hosted_mcp', owner_user_id: 'owner', app: { client_id: 'claude-app', display_name: 'Claude' } },
      { principal_id: '33333333-3333-4333-8333-333333333333', name: 'Marketing-4Z2P', display_name: 'Marketing', disambiguator: '4Z2P',
        identity_lifetime: 'durable', transport: 'hosted_mcp', owner_user_id: 'owner', app: { client_id: 'claude-app', display_name: 'Claude' } },
      { principal_id: '44444444-4444-4444-8444-444444444444', name: 'Claude-9T4R', display_name: 'Claude', disambiguator: '9T4R',
        identity_lifetime: 'ephemeral', transport: 'hosted_mcp', owner_user_id: 'owner', app: { client_id: 'second-claude-app', display_name: 'Claude' } },
      { principal_id: '55555555-5555-4555-8555-555555555555', name: 'Local-7K2P', transport: 'local', owner_user_id: 'owner' },
      { principal_id: '66666666-6666-4666-8666-666666666666', name: 'Local-7K2P', transport: 'local', owner_user_id: 'owner' },
      { principal_id: '77777777-7777-4777-8777-777777777777', name: 'Local-7K2P', transport: 'hosted_mcp', owner_user_id: 'owner' },
      { principal_id: '88888888-8888-4888-8888-888888888888', name: 'Marketing-7K2P', display_name: 'Marketing-7K2P',
        identity_lifetime: 'durable', transport: 'hosted_mcp', owner_user_id: 'owner', app: { client_id: 'claude-app', display_name: 'Claude' } },
    ];
    const fixture = join(directory, 'index.html');
    await writeFile(fixture, `<!doctype html><html><head><style>${tokens}\n${componentStyle}\n${css}</style></head>
      <body><main class="dashboard"><ul id="rail"></ul><div id="roster"></div><section id="detail"></section><div id="chat"></div></main>
      <script>${bundled.outputFiles[0]!.text}</script><script>
      const raw = ${JSON.stringify(rows)};
      const agents = UI.rosterAgentsFromRows(raw), copied = [];
      Object.defineProperty(navigator, 'clipboard', {value: {writeText: async value => copied.push(value)}});
      const exactRoster = agents.map(agent => ({id:agent.principalId,name:agent.name}));
      const model = {people: [{id:'owner',name:'Synthetic owner',role:'owner',own:true,mayRemove:false}],
        agents: agents.map(agent => {
          return {id:agent.principalId,...UI.hostedContextPeopleLabel(agent,exactRoster),
            identityLifetime:agent.identityLifetime,appClientId:agent.app?.client_id,app:agent.app?.display_name,
            ownerId:agent.ownerUserId,ownerName:'Synthetic owner',model:null,hosted:agent.transport==='hosted_mcp',
            own:true,mayManage:false,liveKey:false,access:null,accessReadState:'succeeded',key:null,
            status:{kind:'active',label:'Connected',attention:false,fix:{allowed:false}},lastActive:'Not reported',technical:[],receipt:''};
        }),invites:[],sample:false,pendingFailed:false};
      const state = {selected:null,collapsed:new Set(),query:'',showAllAttention:false};
      const roster = document.querySelector('#roster'), detail = document.querySelector('#detail');
      const callbacks = {render:()=>UI.renderPeopleDialog(roster,detail,model,state,callbacks,{layout:'page'}),
        action:()=>{},saveModel:async()=>{},confirm:()=>{}};
      callbacks.render();
      UI.renderSidebarParticipants(document.querySelector('#rail'), [{userId:'owner',name:'Synthetic owner',role:'owner'}], agents, ()=>'SO');
      const search = UI.peopleDialogGroups(model,'Claude-8N3Q').groups.flatMap(group=>group.agents);
      const command = UI.browserSignalCommand('Synthetic question',search.map(agent=>({kind:'agent',id:agent.id})),'ask');
      const nameRows = [...roster.querySelectorAll('[data-agent-row]')].map(row=>({id:row.dataset.agentRow,
        label:row.querySelector('strong').textContent,badge:row.querySelector('[data-context-badge]')?.textContent??null,
        title:row.querySelector('strong').title,accessible:row.querySelector('button').getAttribute('aria-label')}));
      const appGroups = [...roster.querySelectorAll('[data-chat-app]')].map(group=>({app:group.dataset.chatApp,ids:[...group.querySelectorAll('[data-agent-row]')].map(row=>row.dataset.agentRow)}));
      roster.querySelector('#pd-agent-${second}').click();
      const assurance = detail.textContent.includes('App connection identity; chat not verified');
      [...detail.querySelectorAll('button')].find(button=>button.textContent==='Copy name').click();
      const rail = [...document.querySelectorAll('#rail [data-context-badge]')].map(badge=>badge.textContent);
      const railNames = [...document.querySelectorAll('#rail strong')].map(name=>({label:name.textContent,title:name.title}));
      const durable = roster.querySelector('[data-agent-row="33333333-3333-4333-8333-333333333333"]').textContent;
      const homePeople = UI.mapHomePeople({viewerId:'owner',members:[{userId:'owner',name:'Synthetic owner',role:'owner'}],
        agents,access:[],signals:[],now:Date.parse('2026-10-10T12:00:00Z'),sample:false});
      const chatNames = [raw.find(row=>row.principal_id==='${first}'),raw.find(row=>row.name==='Marketing-7K2P')].map(row=>{
        const agent = agents.find(agent=>agent.principalId===row.principal_id);
        const author = UI.hostedContextChatAuthor(UI.homeParty({kind:'agent',id:agent.principalId},homePeople),agent);
        const line = UI.buildAuthorLine(document,{author,createdAt:'2026-10-10T12:00:00Z',when:'Just now'},36);
        document.querySelector('#chat').append(line);
        return line.querySelector('.hm-author__name').textContent;
      });
      const marketing = roster.querySelector('#pd-agent-88888888-8888-4888-8888-888888888888');
      marketing.click();
      const marketingDetail = detail.textContent;
      [...detail.querySelectorAll('button')].find(button=>button.textContent==='Copy name').click();
      UI.renderPeopleDialog(roster,detail,model,state,callbacks);
      const dialogNames = [...roster.querySelectorAll('[data-agent-row]')].map(row=>({id:row.dataset.agentRow,
        title:row.querySelector('strong').title,accessible:row.querySelector('button').getAttribute('aria-label')}));
      document.documentElement.dataset.receipt = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({nameRows,dialogNames,appGroups,to:command.to,copied,assurance,rail,railNames,durable,chatNames,marketingDetail}))));
      </script></body></html>`, 'utf8');
    const { stdout } = await launchChrome(await findChrome(), ['--allow-file-access-from-files', '--dump-dom', `file://${fixture}`],
      { maxBuffer: 4 * 1024 * 1024, timeout: 20000 });
    const encoded = stdout.match(/data-receipt="([^"]+)"/)?.[1];
    assert.ok(encoded, 'production builders produced a browser receipt');
    const result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.deepEqual(result.appGroups, [
      { app: 'claude-app', ids: [first, second] },
      { app: 'second-claude-app', ids: ['44444444-4444-4444-8444-444444444444'] },
    ]);
    const chats = result.nameRows.filter((row: { id: string }) => [first, second].includes(row.id));
    assert.deepEqual(chats.map((row: { label: string; badge: string }) => [row.label, row.badge]), [['Claude', 'Badge 7K2P'], ['Claude', 'Badge 8N3Q']]);
    assert.deepEqual(chats.map((row: { title: string }) => row.title), ['Claude-7K2P', 'Claude-8N3Q']);
    assert.ok(chats.every((row: { accessible: string; title: string }) => row.accessible.includes(row.title)));
    assert.deepEqual(result.to, [{ kind: 'agent', id: second }]);
    assert.deepEqual(result.copied, ['Claude-8N3Q', 'Marketing-7K2P']);
    assert.equal(result.assurance, true);
    assert.ok(result.durable.includes('Separate agent · Shared across chats'));
    assert.deepEqual(result.rail, ['Badge 7K2P', 'Badge 8N3Q', 'Badge 9T4R', 'Badge 4Z2P']);
    const legacyIds = ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'];
    const legacyLabels = ['Local-7K2P · 55555555', 'Local-7K2P · 66666666', 'Local-7K2P · 77777777'];
    for (const names of [result.nameRows, result.dialogNames]) {
      const legacy = legacyIds.map(id=>names.find((row: {id:string})=>row.id===id));
      assert.deepEqual(legacy.map(row=>row.title), legacyLabels);
      assert.ok(legacy.every((row, index)=>row.accessible.startsWith(legacyLabels[index] + ',')));
      assert.equal(new Set(legacy.map(row=>row.accessible)).size, 3);
    }
    assert.ok(result.nameRows.filter((row: { id: string })=>legacyIds.includes(row.id)).every((row: {badge: string|null})=>row.badge===null));
    assert.ok(legacyLabels.every(label=>result.railNames.some((row: {label:string;title:string})=>row.label===label && row.title===label)));
    const marketing = result.nameRows.find((row: { id: string })=>row.id==='88888888-8888-4888-8888-888888888888');
    assert.equal(marketing.label, 'Marketing-7K2P');
    assert.equal(marketing.title, 'Marketing-7K2P');
    assert.equal(marketing.badge, null);
    assert.ok(marketing.accessible.startsWith('Marketing-7K2P,'));
    assert.ok(result.marketingDetail.includes('Marketing-7K2P'));
    assert.ok(result.railNames.some((row: {label:string;title:string})=>row.label==='Marketing-7K2P' && row.title==='Marketing-7K2P'));
    assert.deepEqual(result.chatNames, ['Claude', 'Marketing-7K2P']);
  } finally {
    const resolved = await realpath(directory);
    const owned = (path: string) => path === directory && dirname(path) === root && path !== homedir() && path !== '/' && path !== '';
    for (const path of ['', '/', homedir(), root, join(root, 'unowned')]) assert.equal(owned(path), false);
    assert.equal(owned(resolved), true);
    execFileSync('rm', ['-r', resolved], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
});
