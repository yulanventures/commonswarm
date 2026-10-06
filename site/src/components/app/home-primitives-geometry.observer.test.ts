import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { homeFixture } from "./home-fixture.js";

const script = String.raw`
const P = HomeView, root = document.querySelector('#fixture');
const hostile = '<img src=x onerror="document.title=1"><script>document.title=2</script>';
const person = { id:'tom', name:'Tom '+hostile, firstName:'Tom', initials:'TL', you:true, role:'owner' };
const state = { kind:'idle', word:'Idle', detail:'No activity reported yet', attention:false, fix:{action:null,allowed:false,askWho:null,sentence:''} };
const agent = { id:'claude', name:'Claude', label:'Your Claude', nestedLabel:'Claude', ownerId:'tom', ownerFirstName:'Tom', ownerInitial:'T', yours:true, tint:0, hosted:true, state };
let choices = [], switches = [], actions = [];
root.append(P.personAvatar(document, person, 48), P.agentOrb(document, agent, {size:60,badge:true}));
root.append(P.capsule(document, {person, agents:[agent,agent,agent,agent]}, {compact:true,onOpen:()=>actions.push('capsule')}));
const states = [{...state,kind:'working',word:'Working',detail:'Doing ‘Budget’ since 9:40 am'}, state,
 {...state,kind:'disconnected',word:'Disconnected',detail:'Key turned off',attention:true,fix:{action:'new-key',allowed:true,askWho:null,sentence:'Get a new key.'}}];
for (const s of states) for (const form of ['word','line','pill']) root.append(P.statusLine(document,s,{form}));
for (const kind of ['todo','list','doc','file']) root.append(P.objectCard(document,{kind,id:kind,title:'A'.repeat(200)+hostile,href:'/app?w=W',meta:'Added by Nikki',who:agent,done:kind==='todo'}));
const card = {id:'need',kind:'ask',workspace:{id:'W',name:'Home '+hostile,href:'/app?w=W'},from:agent,what:'Claude asked you: ‘'+hostile+'’',when:'10:05 am',primary:{label:'Reply',action:'reply'},secondary:{label:'Open',href:'/app?w=W'}};
root.append(P.needsYouCard(document,card,(action)=>actions.push(action)));
const choice = P.choiceChips(document,{name:'start',legend:'When?',value:null,options:[{value:'free',label:'When it’s free'},{value:'now',label:'Now'},{value:'later',label:hostile,hint:'A'.repeat(200)}]},value=>choices.push(value)); root.append(choice);
const noPreselection = choice.querySelectorAll('input:checked').length === 0;
choice.querySelector('input[value="now"]').click();
const checkedMark = getComputedStyle(choice.querySelector('input:checked').parentElement.querySelector('.hm-choice-check')).visibility;
const sw = P.switchRow(document,{id:'access',label:'Lists & docs',detail:hostile,state:'off'},()=>switches.push('off')); root.append(sw); sw.click();
root.append(P.switchRow(document,{id:'always',label:'What it posts here',detail:'',state:'always'},()=>switches.push('always')));
root.append(P.switchRow(document,{id:'busy',label:'Lists & docs',detail:'Checking',state:'on',busy:true},()=>switches.push('busy')));
const queue = document.createElement('ul'); root.append(queue);
const q = {todoId:'T',position:2,title:'Book plumber '+hostile,href:'/app?w=W&todo=T',meta:'Added by Nikki · due Fri',may:{up:true,down:true,startNow:true,notYet:true,release:false}};
const onQueue = action => { actions.push(action); if(action==='up') queue.replaceChildren(P.queueRow(document,{...q,position:1},onQueue)); };
queue.append(P.queueRow(document,q,onQueue));
queue.querySelector('[data-queue-action="up"]').click();
const movedFocus = document.activeElement.dataset.queueAction === 'up';
const movedReceipt = queue.querySelector('[aria-live="polite"]').textContent;
const readOnly = P.queueRow(document,{...q,todoId:'readonly',may:{up:false,down:false,startNow:false,notYet:false,release:false}},()=>actions.push('readonly')); queue.append(readOnly);
for (const tone of ['info','warning','danger','success']) root.append(P.notice(document,hostile,tone));
const sample = document.createElement('section'); root.append(sample);
sample.append(P.capsule(document,{person,agents:[agent],sample:true},{onOpen:()=>actions.push('sample')}),
 P.needsYouCard(document,{...card,id:'sample',sample:true},()=>actions.push('sample')),
 P.objectCard(document,{kind:'file',id:'sample',title:hostile,href:'/app',meta:'',who:null,sample:true}),
 P.queueRow(document,{...q,todoId:'sample',sample:true},()=>actions.push('sample')),
 P.switchRow(document,{id:'sample',label:'Lists & docs',detail:'',state:'on',sample:true},()=>actions.push('sample')),
 P.choiceChips(document,{name:'sample',legend:'When?',value:'now',options:[{value:'now',label:'Now'}],sample:true},()=>actions.push('sample')));
const visible = element => element.getClientRects().length > 0;
const targets = [...root.querySelectorAll('button,a,label:has(input)')].filter(visible);
const bounds = targets.map(element => ({kind:element.tagName,label:element.textContent,width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height}));
const metrics = { width:innerWidth, overflow:document.documentElement.scrollWidth > innerWidth,
 targets:bounds, hostileElements:root.querySelectorAll('img,script').length, hostileText:root.querySelector('.hm-object-title').textContent.includes(hostile),
 states:[...root.querySelectorAll('.hm-status')].map(element=>({word:element.querySelector('.hm-status-word').textContent,shape:element.querySelector('.hm-status-shape').dataset.shape,label:element.getAttribute('aria-label')})),
 noPreselection,checkedMark,choices,switches,actions,movedFocus,movedReceipt,readOnlyButtons:readOnly.querySelectorAll('button').length,
 sampleActions:sample.querySelectorAll('button,a,input').length,alwaysRole:root.querySelector('[data-switch-id="always"]').getAttribute('role'),
 busyDisabled:root.querySelector('[data-switch-id="busy"]').disabled,doneWord:root.querySelector('[data-done="true"]').textContent.includes('Done'),
 doneStrike:getComputedStyle(root.querySelector('[data-done="true"] .hm-object-title')).textDecorationLine,
 capsulePlus:root.querySelector('.hm-capsule-more').textContent,ownerBadgeHidden:root.querySelector('.hm-owner-badge').getAttribute('aria-hidden') };
document.documentElement.dataset.metrics=btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
`;

test("home primitives have 44px targets, plain hostile text and explicit states at 320 and 390", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-primitives-"));
  const fixture = join(directory, "index.html");
  try {
    const chrome = await findChrome();
    for (const theme of ["light", "dark"] as const) {
      await writeFile(fixture, await homeFixture({ entryPoint: "src/lib/home-primitives.ts", script, theme }));
      for (const width of [320, 390]) {
        const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
          { maxBuffer: 10 * 1024 * 1024, timeout: 12_000, killSignal: "SIGKILL" });
        const encoded = stdout.match(/<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
        assert.ok(encoded, `${theme}/${width}: the real builders completed their DOM interactions`);
        const m = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        assert.equal(m.width, width); assert.equal(m.overflow, false, `${theme}/${width}: no horizontal overflow`);
        assert.ok(m.targets.length > 10);
        for (const target of m.targets) assert.ok(target.width >= 44 && target.height >= 44, `${theme}/${width}: ${JSON.stringify(target)}`);
        assert.equal(m.hostileElements, 0); assert.equal(m.hostileText, true);
        assert.deepEqual(m.states.map((s: {word:string;shape:string})=>[s.word,s.shape]), [
          ["Working","dot"],["Working","dot"],["Working","dot"],["Idle","ring"],["Idle","ring"],["Idle","ring"],
          ["Disconnected","diamond"],["Disconnected","diamond"],["Disconnected","diamond"],
        ]);
        assert.ok(m.states.every((s: {label:string}) => /Doing|activity|Key turned off/u.test(s.label)));
        assert.equal(m.noPreselection, true); assert.equal(m.checkedMark, "visible"); assert.deepEqual(m.choices, ["now"]);
        assert.deepEqual(m.switches, ["off"]); assert.equal(m.alwaysRole, null); assert.equal(m.busyDisabled, true);
        assert.equal(m.movedFocus, true); assert.equal(m.movedReceipt, `Moved ‘Book plumber <img src=x onerror="document.title=1"><script>document.title=2</script>’ to 1st.`);
        assert.equal(m.readOnlyButtons, 0); assert.equal(m.sampleActions, 0);
        assert.equal(m.doneWord, true); assert.match(m.doneStrike, /line-through/u);
        assert.equal(m.capsulePlus, "+1"); assert.equal(m.ownerBadgeHidden, "true");
      }
    }
  } finally {
    // Delete only the absolute mkdtemp directory created above, through the host's rm guard.
    const root = await realpath(tmpdir()), owned = await realpath(directory);
    assert.ok(owned.startsWith(`${root}/commonswarm-home-primitives-`));
    await promisify(execFile)("rm", ["-rf", owned]);
  }
});
