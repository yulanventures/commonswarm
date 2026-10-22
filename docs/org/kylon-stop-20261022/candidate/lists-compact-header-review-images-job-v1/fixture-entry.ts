/* Authorized invented composition only; no account, request, auth/bootstrap or file capability. */
import {createHouseholdObjectsController,mountHouseholdObjects,type HouseholdWorkspaceView,type HouseholdActions} from '__APP__/site/src/lib/household-objects-view.ts';
import {buildHomeRail,type HomeRailVM} from '__APP__/site/src/lib/home-rail.ts';
import {buildSideCards,type SideCardsVM} from '__APP__/site/src/lib/home-side-cards.ts';
import {buildPhoneTopBar,buildWorkspaceHeader,buildWorkspaceNav,type ShellCallbacks} from '__APP__/site/src/lib/home-shell.ts';
import {replaceHomeRegion} from '__APP__/site/src/lib/home-focus.ts';
import {createKylonHost} from '__APP__/site/src/lib/kylon-shell/host.ts';
import {projectHomeLayout} from '__APP__/site/src/lib/kylon-shell/projection.ts';
import {routeHref,type HomeRoute} from '__APP__/site/src/lib/home-route.ts';
import type {PersonVM,CapsuleVM} from '__APP__/site/src/lib/home-types.ts';
import type {HouseholdContent} from '__APP__/src/protocol/household-object-events.ts';
import {actualShellVM,actualPresentation,actualInventedAccessPresentation,actualEmptyAgentPresentation} from './native-owner.ts';
const mode=new URL(location.href).searchParams.get('mode');
if(mode!=='list'&&mode!=='document')throw Error('Known controlled composition required');
const app=document.querySelector<HTMLElement>('live-dashboard.dashboard[data-kylon-shell]');
if(!app||app.dataset.state!=='loading'||app.querySelector('[data-kylon-live-layout]'))throw Error('Native unbooted Dashboard required');
const one=<T extends Element=HTMLElement>(s:string):T=>{const e=app.querySelector<T>(s);if(!e)throw Error('Unique native target missing '+s);return e;};
const all=<T extends Element=HTMLElement>(s:string):T[]=>[...app.querySelectorAll<T>(s)];
const refresh=one<HTMLElement>('[data-refresh]'),description=one<HTMLElement>('[data-channel-description]');
const householdRoot=one<HTMLElement>('[data-household-objects]');
const initial={refreshHidden:refresh.hidden,refresh,description,householdRoot,frame:one<HTMLElement>('.hm-frame'),account:one<HTMLElement>('[data-user-menu-root]')};
const calls:{kind:string;value?:string}[]=[];
const record=(kind:string,value?:string)=>calls.push({kind,value});
// Retain native controls, focus and scroll. Every interaction intention refuses locally,
// including controller staging before it could change this normal composition.
const refuseEvent=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();record('refused-'+event.type);};
for(const type of ['click','submit','beforeinput','input','change','drop','paste'])document.addEventListener(type,refuseEvent,true);
const workspace={id:'invented-fieldwork',name:'Fieldwork',todosAvailable:false};
const owner:PersonVM={id:'invented-rowan',name:'Rowan Ellis',firstName:'Rowan',initials:'RE',you:true,role:'owner'};
const groups:CapsuleVM[]=[{person:owner,agents:[]}];
const route:HomeRoute={view:'lists',workspaceId:workspace.id};
const href=(view:'chat'|'lists'|'files'|'wiki')=>routeHref({view,workspaceId:workspace.id});
const host=createKylonHost(app,value=>record('refused-navigation',value));
const native=actualPresentation(app,one,all,route);
const note=one<HTMLElement>('[data-sample-notice]'),noteText=note.querySelector('.notice > span');
if(!noteText||!note.hidden)throw Error('Native hidden sample notice required for authorized composition');
host.sync(projectHomeLayout('channel',route,[workspace],false));
const rail:HomeRailVM={sample:false,catchUp:{href:routeHref({view:'catchup'}),current:false,needsYou:null},
 workspaces:[{id:workspace.id,name:workspace.name,href:href('chat'),current:true,needsYou:null}],people:{title:'People & agents',groups,other:[]}};
host.refreshTodoContext(()=>replaceHomeRegion(one('[data-home-rail-slot]'),'rail',[buildHomeRail(document,rail,{
 navigate:value=>record('refused-navigation',value),openPerson:id=>record('refused-person',id),openAgent:id=>record('refused-agent',id),
},{newWorkspaceHref:routeHref({view:'new'})})]));
const vm=actualShellVM(workspace,groups,route);
const callbacks:ShellCallbacks={navigate:value=>record('refused-navigation',value),back:()=>record('refused-back'),
 openPeople:()=>record('refused-people'),menu:item=>record('refused-menu',item),account:native.accountMenuState,accountAction:action=>record('refused-account',action)};
host.replaceHeader(()=>replaceHomeRegion(one('[data-home-workspace-shell]'),'shell',[
 buildPhoneTopBar(document,vm,callbacks),buildWorkspaceHeader(document,vm,callbacks),buildWorkspaceNav(document,vm,callbacks,'tablet'),
]));
replaceHomeRegion(one('[data-home-phone-nav]'),'phone-nav',[buildWorkspaceNav(document,vm,callbacks,'phone')]);
const author={user_id:owner.id,principal_id:null,run_id:null,connection_id:null,grant_id:null};
const version=(id:string,title:string,content:HouseholdContent)=>({revision:{workspace_id:workspace.id,object_id:id,token:'invented-revision-'+id},
 title,author,occurred_at_server:Date.parse('2026-10-22T12:00:00Z'),live:true,content});
const list=version('supplies','Field supplies',{kind:'list',items:[
 {item_id:'notebook',text:'Waterproof notebook and pencils',order:0,checked:false},
 {item_id:'bottles',text:'Clean sample bottles',order:1,checked:true},
 {item_id:'labels',text:'Labels and permanent marker',order:2,checked:false},
 {item_id:'gloves',text:'Reusable gloves',order:3,checked:false},
 {item_id:'map',text:'Printed trail map',order:4,checked:true},
]});
const doc=version('notes','Sampling notes',{kind:'doc',markdown:'## Before leaving\nCheck the weather and pack the field supplies. Keep each sample bottle sealed until it is needed.\n\n## At the stream\nRecord the location, time and water temperature in the notebook. Label each bottle before collecting the sample.\n\n- Work from the same marked point.\n- Keep the notebook dry.\n- Bring all equipment home.\n\n## After the visit\nReview the observations together and add any missing details.'});
const household:HouseholdWorkspaceView={workspace_id:workspace.id,name:workspace.name,audience:[owner.name],viewer_user_id:owner.id,
 content_role:'editor',operations:['read','create','update'],names:{people:{[owner.id]:owner.name},agents:{}},objects:[
 {object_id:'supplies',kind:'list',current:list,history:[list],next_history_cursor:null},
 {object_id:'notes',kind:'doc',current:doc,history:[doc],next_history_cursor:null},
]};
const refusal=async(kind:string):Promise<never>=>{record('refused-'+kind);throw Error('Controlled composition has no backend capability.');};
const actions:HouseholdActions={save:()=>refusal('save'),readRevision:()=>refusal('revision-read'),recoverDraft:()=>refusal('draft-recovery'),
 readHistory:()=>refusal('history-read'),reloadObject:()=>refusal('reload')};
// Exact source presentation owners receive explicit local booleans. No household_access
// or connections response is fabricated, and no admission/controller bootstrap is run.
actualInventedAccessPresentation(one,true,true,()=>owner.role);
actualEmptyAgentPresentation(one);
const controller=createHouseholdObjectsController(household,actions);
const unmount=mountHouseholdObjects(householdRoot,controller);
if(!controller.select(mode==='list'?'supplies':'notes'))throw Error('Native selected-object composition refused');
const sideVM:SideCardsVM={sample:false,workspaceName:workspace.name,todos:null,objects:{state:'ready',lists:[
 {kind:'list',id:'supplies',title:list.title,href:href('lists'),meta:'5 items',who:owner},
 {kind:'doc',id:'notes',title:doc.title,href:href('lists'),meta:'Document',who:owner},
],files:[]},sharedAgents:[],hrefs:{lists:href('lists'),files:href('files'),wiki:href('wiki')}};
host.refreshTodoContext(()=>replaceHomeRegion(one('[data-home-side-slot]'),'side',[buildSideCards(document,sideVM,{
 onComplete:()=>record('refused-todo'),onAddTodo:()=>record('refused-add'),onOpenLists:()=>record('refused-lists'),
})]));
const read=()=>({mode,scope:'AUTHORIZED INVENTED native editor composition; no functional authorization or acceptance',
 hostMounted:host.mounted,calls:[...calls],selectedId:controller.getState().selected_id,saveState:controller.getState().save_state,
 workspace:household,initialRefreshHidden:initial.refreshHidden,refreshHidden:refresh.hidden,agents:0,connections:0,
 chromeIdentity:{refresh:one('[data-refresh]')===initial.refresh,description:one('[data-channel-description]')===initial.description,
 householdRoot:one('[data-household-objects]')===initial.householdRoot,frame:one('.hm-frame')===initial.frame,account:one('[data-user-menu-root]')===initial.account,
 moved:refresh.parentElement===one('.dashboard__lists-head')&&description.parentElement===refresh.parentElement},
 access:{inventedCurrent:true,inventedConfirmed:true,consentHidden:one<HTMLElement>('[data-household-consent]').hidden,approvalsHidden:one<HTMLElement>('[data-household-agents]').hidden},
 todoRead:'absent',fileCount:0,notice:{text:noteText.textContent,hidden:note.hidden}});
Object.assign(window,{listsFixture:{read},listsFixtureReady:true});
window.addEventListener('pagehide',()=>{unmount();host.suspend();},{once:true});
