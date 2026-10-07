import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function focusFixture() {
  const source = await readFile(new URL("LiveDashboard.astro", import.meta.url), "utf8");
  const file = ts.createSourceFile("dashboard.ts", source.match(/<script>([\s\S]*?)<\/script>/u)![1], ts.ScriptTarget.Latest, true);
  const names = ["homeViewerId", "currentHomePeople", "renderHomeRail", "renderHomeShell", "renderHomeCatchUp",
    "wakeMarkKey", "renderRoster", "hasPendingAccess", "refreshPendingAccess"];
  const declarations = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(file))) declarations.set(node.name.getText(file), node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of names) assert.ok(declarations.has(name), `production ${name} is available`);
  const setup = `
    const one = (selector) => document.querySelector(selector);
    let now = Date.parse('2026-10-05T12:00:00Z'); Date.now = () => now;
    const session = {user:{id:'tom'}}, sampleMode = false, accountName = () => 'Tom';
    let workspaces = [{id:'W',name:'Home'},{id:'X',name:'Trip'}];
    let homeRoute = {view:'chat',workspaceId:'W'}, activeWorkspaceId = 'W', requestVersion = 1;
    let members = [{userId:'tom',name:'Tom',role:'owner'}];
    let agents = [{principalId:'A',name:'Claude',ownerUserId:'tom',transport:'hosted_mcp',
      work:{work:'idle',facts:{transport:'hosted_mcp',turn_only:true,connection:'live',last_activity_at:'2026-10-05T11:47:00Z'}}}];
    let people = new Map(), accessStatuses = [], homeWorkClaims = [], pendingInvites = [], pendingAgents = [];
    let pendingAgentsLoadFailed = false, freshInviteWorkspaceId = '', freshInviteId = '';
    let railExpanded = false, catchUpExpanded = false, homeShellKey = '', homeRailKey = '', homeCatchUpKey = '', renderedWakeMarkKey = '';
    let catchUpData = [], rosterReads = 0, rosterRenders = 0;
    const homeOverviewCounts = new Map(), pendingRefreshGate = new PendingRefreshGate(12000,30000);
    const pendingMemberInvites = async () => [], agentAccessStatuses = async () => [];
    const pendingAgentAccess = async () => [], loadPendingAccess = async read => ({rows:await read(),failed:false});
    const memberRoster = async () => { rosterReads++; return {members:[...members],names:new Map()}; };
    const renderMembers = () => {}, renderPendingAccess = () => {}, renderHeaderRoster = () => {}, renderDialogRoster = () => {}, restoreComposerOnEntry = () => {};
    let syncComposerAddress = () => {};
    const renderSetupChecklist = () => { rosterRenders++; };
    const wakePathMark = () => null, shouldRetireFreshInvite = () => false, retireFreshInviteResult = () => {};
    const navigateHomeHref = () => {}, selectHomePerson = () => {}, navigateHome = () => {}, homeBack = () => {}, openRosterDialog = () => {}, openWorkspaceDetailsDialog = () => {};
    // renderHomeShell's feed-menu dependencies (ruling 2). This fixture has no feed, so the menu offers no feed entries.
    const feedMenuState = () => null, feedMenuAction = () => {}, syncFeedChrome = () => {};
    // renderHomeRail's joined rail (home-map homeRailPeople). The browser fixture imports catchUpRailPeople, which is
    // homeRailPeople(entries); with the view's people as the first source it is the same rail for every state this
    // fixture reaches (catchUpData is empty on its workspace route). Called lazily, so the vm unit test never needs it.
    const homeRailPeople = (entries, current = null) => catchUpRailPeople(current ? [{ detail: { people: current } }, ...entries] : entries);
    const poll = async (elapsed = 30001) => { now += elapsed; await refreshPendingAccess('W',1); return {reads:rosterReads,rendered:rosterRenders}; };
  `;
  const production = (selected = names) => selected.map(name => `const ${declarations.get(name)};`).join("\n");
  return { setup, production };
}

export function assertPollCompleted(progress: { reads: number; rendered: number }, expectedReads: number): void {
  assert.equal(progress.reads, expectedReads, "each poll actually completed a roster read");
  assert.equal(progress.rendered, expectedReads + 1, "initial paint and each poll reached the end of renderRoster");
}
