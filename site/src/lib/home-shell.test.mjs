import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOrganizationMenu, capsuleSubline, organizationMenuItems, joinNames, menuFocusIndex, organizationWorkspaces, shellDoors, workspaceMenuItems, workspaceNavItems } from "./home-shell.ts";

const person = (id, name, you = false) => ({ id, name, firstName: name.split(" ")[0], initials: "XX", you, role: "member" });
const agent = (id, nestedLabel) => ({ id, name: nestedLabel, label: nestedLabel, nestedLabel, ownerId: null, ownerFirstName: null, ownerInitial: "",
  yours: false, tint: 0, hosted: false, state: { kind: "idle", word: "Idle", detail: "", attention: false, fix: { action: null, allowed: false, askWho: null, sentence: "" } } });
const hrefs = { chat: "?w=h", todos: "?w=h&v=todos", lists: "?w=h&v=lists", files: "?w=h&v=files", wiki: "?w=h&v=wiki", workspaces: "?v=catchup" };

test("names join in plain English", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Claude"]), "Claude");
  assert.equal(joinNames(["Claude", "dot"]), "Claude and dot");
  assert.equal(joinNames(["Claude", "dot", "Grok"]), "Claude, dot and Grok");
});

test("the capsule subline puts you first, counts agents for two people, then +N", () => {
  const tom = { person: person("tom", "Tom Langridge", true), agents: [agent("c", "Claude"), agent("d", "dot")] };
  const nikki = { person: person("nikki", "Nikki Hale"), agents: [agent("m", "Muse")] };
  const priya = { person: person("priya", "Priya Shah"), agents: [] };
  const alex = { person: person("alex", "Alex Doe"), agents: [] };
  assert.equal(capsuleSubline([nikki, tom]), "You with 2 agents · Nikki with 1 agent");
  assert.equal(capsuleSubline([priya, nikki, tom]), "You with 2 agents · Nikki with 1 agent · +1");
  assert.equal(capsuleSubline([priya, nikki, alex, tom]), "You with 2 agents · Alex · +2");
  assert.equal(capsuleSubline([{ ...tom, agents: Array.from({ length: 17 }, (_, i) => agent(String(i), 'Long Agent Name ' + i)) }, nikki]),
    "You with 17 agents · Nikki with 1 agent", "larger rosters keep truthful counts rather than an expanding name sentence");
  assert.equal(capsuleSubline([{ person: person("tom", "Tom", true), agents: [] }]), "You");
  assert.equal(capsuleSubline([]), "");
});

test("the nav is Chat, To-dos, Lists, Files as links, with To-dos left out while its read is absent", () => {
  assert.deepEqual(workspaceNavItems({ pane: "lists", hrefs, todosAvailable: true }), [
    { pane: "chat", label: "Chat", href: "?w=h", current: false },
    { pane: "todos", label: "To-dos", href: "?w=h&v=todos", current: false },
    { pane: "lists", label: "Lists", href: "?w=h&v=lists", current: true },
    { pane: "files", label: "Files", href: "?w=h&v=files", current: false },
  ]);
  assert.deepEqual(workspaceNavItems({ pane: "chat", hrefs, todosAvailable: false }).map((item) => [item.label, item.current]),
    [["Chat", true], ["Lists", false], ["Files", false]]);
  assert.deepEqual(workspaceNavItems({ pane: "todos", hrefs, todosAvailable: false }).filter((item) => item.current), [],
    "an absent to-dos read never marks another pane current in its place");
});

test("the ⋯ menu offers Wiki, and the management doors only where allowed", () => {
  assert.deepEqual(workspaceMenuItems({ sample: false, menu: { settings: true, adminAccess: true } }).map((entry) => entry.label),
    ["Wiki", "Workspace settings", "Admin access and history"]);
  assert.deepEqual(workspaceMenuItems({ sample: false, menu: { settings: true, adminAccess: false } }).map((entry) => entry.item), ["wiki", "settings"]);
  assert.deepEqual(workspaceMenuItems({ sample: false, menu: { settings: false, adminAccess: true } }).map((entry) => entry.item), ["wiki", "admin-access"]);
  assert.deepEqual(workspaceMenuItems({ sample: false, menu: { settings: false, adminAccess: false } }).map((entry) => entry.item), ["wiki"]);
});

test("a sample renders no doors: no menu items, no ⋯ button and no People & agents button", () => {
  for (const menu of [{ settings: true, adminAccess: true }, { settings: false, adminAccess: false }]) {
    assert.deepEqual(workspaceMenuItems({ sample: true, menu }), [], "not even Wiki");
    assert.deepEqual(shellDoors({ sample: true, menu }), { people: false, menu: false });
  }
  assert.deepEqual(shellDoors({ sample: false, menu: { settings: false, adminAccess: false } }), { people: true, menu: true }, "a real workspace keeps People & agents and Wiki");
});

test("menu keys move focus with wrap-around; other keys are not the menu's", () => {
  assert.equal(menuFocusIndex(-1, "ArrowDown", 3), 0);
  assert.equal(menuFocusIndex(0, "ArrowDown", 3), 1);
  assert.equal(menuFocusIndex(2, "ArrowDown", 3), 0);
  assert.equal(menuFocusIndex(-1, "ArrowUp", 3), 2);
  assert.equal(menuFocusIndex(0, "ArrowUp", 3), 2);
  assert.equal(menuFocusIndex(1, "Home", 3), 0);
  assert.equal(menuFocusIndex(0, "End", 3), 2);
  assert.equal(menuFocusIndex(0, "Enter", 3), null);
  assert.equal(menuFocusIndex(0, "ArrowDown", 0), null);
});

test("shell copy uses plain words only", () => {
  const copy = [
    ...workspaceMenuItems({ sample: false, menu: { settings: true, adminAccess: true } }).map((entry) => entry.label),
    ...workspaceNavItems({ pane: "chat", hrefs, todosAvailable: true }).map((item) => item.label),
  ].join(" ");
  assert.doesNotMatch(copy, /online|offline|seat|grant|token|turn|wake|principal/iu);
});

test("organization choices include only live readable workspaces, deduplicate orgs and keep the selected workspace", () => {
  const workspaces = [
    { id: "a", name: "A", orgId: "org-a", orgName: "Alpha", archived: false },
    { id: "b", name: "B", orgId: "org-a", orgName: "Alpha", archived: false },
    { id: "c", name: "C", orgId: "org-c", orgName: "Other", archived: false },
    { id: "closed", name: "Closed", orgId: "closed-org", orgName: "Closed", archived: true },
  ];
  assert.deepEqual(organizationMenuItems(workspaces, "b"), [
    { id: "org-a", name: "Alpha", workspaceId: "b", current: true },
    { id: "org-c", name: "Other", workspaceId: "c", current: false },
  ]);
  assert.deepEqual(organizationMenuItems(workspaces, "", "org-c").map(org => org.current), [false, true],
    "Catch up retains the organization selected before leaving a workspace");
  assert.deepEqual(organizationMenuItems(workspaces.slice(0, 2), "", "removed-org").map(org => org.current), [true],
    "removal falls back to a readable organization");
  assert.deepEqual(organizationMenuItems([], ""), []);
  assert.deepEqual(organizationMenuItems([{ id: "sample", name: "Sample", archived: false }], "sample"),
    [{ id: "sample", name: "Sample", workspaceId: "sample", current: true }], "sample workspaces retain a local identity");
});


test("organization menu renders safe names and the checked choice, and sends workspace selection", () => {
  const element = tag => ({ tag, children: [], attrs: {}, listeners: {}, dataset: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  });
  const selected = [];
  const menu = buildOrganizationMenu({ createElement: element }, [
    { id: "one", name: "<img src=x>", workspaceId: "space-one", current: false },
    { id: "two", name: "Yulan", workspaceId: "space-two", current: true },
  ], workspaceId => selected.push(workspaceId));
  assert.equal(menu.attrs.role, "group");
  assert.equal(menu.attrs["aria-label"], "Organizations");
  assert.deepEqual(menu.children.map(button => [button.attrs.role, button.attrs["aria-checked"]]),
    [["menuitemradio", "false"], ["menuitemradio", "true"]]);
  assert.equal(menu.children[0].children[1].textContent, "<img src=x>", "the org name is text, never markup");
  assert.equal(menu.children[1].children[0].textContent, "Y");
  assert.equal(menu.children[1].children[2].textContent, "✓");
  menu.children[0].listeners.click();
  assert.deepEqual(selected, ["space-one"], "an org selects its readable workspace through the caller");
});

test("organization rail keeps siblings and excludes other and archived workspaces after a move",()=>{
  const a={id:"a",orgId:"one",archived:false};
  const b={id:"b",orgId:"one",archived:false};
  const c={id:"c",orgId:"two",archived:false};
  const closed={id:"closed",orgId:"one",archived:true};
  assert.deepEqual(organizationWorkspaces([a,b,c,closed],"one"),[a,b]);
  assert.deepEqual(organizationWorkspaces([a,{...b,orgId:"two"},c,closed],"two"),[{...b,orgId:"two"},c]);
  assert.deepEqual(organizationWorkspaces([{id:"sample",archived:false}],"sample"),[{id:"sample",archived:false}]);
});
