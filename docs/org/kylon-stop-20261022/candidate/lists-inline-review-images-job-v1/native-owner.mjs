/* SOURCE ONLY. Exact AST/byte-bound Dashboard presentation statements; no admission or transport. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const fact = b => ({bytes:Buffer.byteLength(b),sha256:crypto.createHash('sha256').update(b).digest('hex')});
export function nativeOwner({app,prepared,ts,write}) {
  const pins=JSON.parse(fs.readFileSync('/inputs/source-pins.json','utf8'));
  const rel='site/src/components/app/LiveDashboard.astro',file=app+'/'+rel,text=fs.readFileSync(file,'utf8');
  assert.deepEqual(fact(text),pins.sourceFiles[rel]);
  const blocks=[...text.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(blocks.length,1);
  const body=blocks[0][1],offset=blocks[0].index+blocks[0][0].indexOf(body);
  assert.deepEqual(fact(body),pins.dashboardScript);
  const ast=ts.createSourceFile('LiveDashboard-script.ts',body,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length,0);
  const owners=[];
  function declaration(name) {
    const rows=[];function visit(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text===name)rows.push(n);ts.forEachChild(n,visit);}visit(ast);
    assert.equal(rows.length,1,'Unique native declaration '+name);
    const n=rows[0];assert.ok(ts.isArrowFunction(n.initializer)&&ts.isBlock(n.initializer.body));
    assert.deepEqual(fact(n.getText(ast)),pins.ownerDeclarations[name]);return n;
  }
  function bind(key,n) {
    const start=offset+n.getStart(ast),end=offset+n.end,value=n.getText(ast);
    const row={start,end,byteStart:Buffer.byteLength(text.slice(0,start)),byteEnd:Buffer.byteLength(text.slice(0,end)),...fact(value)};
    assert.deepEqual(row,pins.extractions[key],'Exact AST extraction '+key);
    owners.push({key,file,offsetUnits:'UTF-16 code units',...row,text:value});return value;
  }
  function parts(name,indices){const statements=declaration(name).initializer.body.statements;return indices.map(i=>bind(name+'/'+i,statements[i])).join('\n');}
  const shell=parts('renderHomeShell',[4,5]);
  const panel=parts('showPanel',[8,9,10,12,13]);
  const pane=parts('applyHomePane',[0,1,2,3,4,5,7,8,9,10,11,12,13,14,15,16]);
  const sync=bind('syncListsChrome',declaration('syncListsChrome'));
  const account=bind('accountMenuState',declaration('accountMenuState'));
  const channel=parts('showChannelView',[3,4]);
  const composerIf=declaration('showChannelView').initializer.body.statements[5];assert.ok(ts.isIfStatement(composerIf));
  const composer=bind('composer-hidden',composerIf.thenStatement.statements[1]);
  const channelEnd=parts('showChannelView',[7,8,10,11]);
  const activation=parts('activateWorkspaceView',[4,5,6,7]);
  const branch=declaration('activateWorkspaceView').initializer.body.statements[8];assert.ok(ts.isIfStatement(branch));
  assert.equal(branch.expression.getText(ast),'view === "objects"');
  const objectParts=[...branch.thenStatement.statements];assert.equal(objectParts.length,6);
  assert.equal(objectParts[5].getText(ast),'void openHouseholdView();');
  const objectText=objectParts.slice(0,5).map((n,i)=>bind('objects/'+i,n)).join('\n');
  const focus=parts('activateWorkspaceView',[9]);
  // Presentation inputs are explicit booleans, never a fabricated household_access response.
  const access=parts('renderHouseholdAccess',[0,1,2,5,6,9]);
  // Exact empty-connections population prefix; no approval row/handler or invented agent.
  const approvals=parts('renderAgentApprovals',[0,1,2,3,4]);
  assert.deepEqual(owners.map(o=>o.key).sort(),Object.keys(pins.extractions).sort());
  const forbidden=new Set(['session','postCommand','householdDashboard','openHouseholdView','refreshHouseholdAccess','householdCall','localStorage','sessionStorage','fetch','WebSocket','navigateHome','history','householdAccess']);
  for(const {text:value} of owners){
    const check=ts.createSourceFile('slice.ts',value,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    function audit(n){if(ts.isIdentifier(n))assert.ok(!forbidden.has(n.text),'Excluded runtime dependency '+n.text);ts.forEachChild(n,audit);}audit(check);
  }
  const lib=n=>JSON.stringify(app+'/site/src/lib/'+n);
  write(prepared+'/native-owner.ts',`
import type {WorkspaceShellVM,AccountMenuState} from ${lib('home-shell.ts')};
import type {HomeRoute} from ${lib('home-route.ts')};
import {routeHref} from ${lib('home-route.ts')};
import {createListsChrome} from ${lib('lists-chrome.ts')};
export function actualShellVM(workspace,groups,homeRoute:HomeRoute):WorkspaceShellVM {
 const sampleMode=false,currentHomePeople=()=>({groups});
 ${shell}
 return vm;
}
export function actualPresentation(app,one,all,homeRoute:HomeRoute) {
 const sampleMode=false,agents=[],unknownChannelId=null;
 // Normal presentation only: no People Allow visit or access landing is in progress.
 const listsAllowLanding=null;
 const listsChrome=createListsChrome(app);
 const ${sync};
 const ${account};
 {const name='channel';${panel}}
 ${pane}
 const showChannelView=(name:'objects')=>{${channel}\nif(composer){${composer}}\n${channelEnd}};
 {const view='objects';${activation}\n${objectText}\n${focus}}
 return {listsChrome,accountMenuState};
}
export function actualInventedAccessPresentation(one,current:boolean,confirmed:boolean,viewerRole:()=>string) {
 ${access}
}
export function actualEmptyAgentPresentation(one) {
 const householdConnections:readonly unknown[]=[];
 ${approvals}
}
`);
  write(prepared+'/native-owner-lineage.json',{head:pins.head,script:pins.dashboardScript,owners,
    dependencies:['actual native DOM one/all queries','explicit local route and typed shell VMs','real createListsChrome and routeHref','local sampleMode=false and no agents','explicit invented current/confirmed presentation booleans and owner role'],
    excluded:['all original script imports/bootstrap/listeners','auth/session/storage/route/history mutation','full showPanel/applyHomePane/activateWorkspaceView controllers','household_access and connections HTTP responses/requests','openHouseholdView and createHouseholdDashboard admission/loader','unknown/refused admission branches; unchanged in source, not executed','approval connection row construction and actions; zero invented connections'],
    scope:'Authorized invented editor composition ONLY. Native presentation assignments, guarded heading-focus callback, empty-agent prefix and chrome restoration are actual current source; listsAllowLanding is explicitly null for normal presentation. No functional authorization/acceptance claim.'});
}
