import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOrganizationMenu, buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceMenu, buildWorkspacePicker, capsuleSubline, organizationMenuItems, joinNames, menuFocusIndex, organizationWorkspaces, shellDoors, workspaceMenuItems, workspaceNavItems } from "./home-shell.ts";
import { homeStructureKey, refreshHomeShellSeatStatus } from "./home-focus.ts";

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
    ["Wiki", "Workspace settings", "Admin access"]);
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


test("workspace picker retains sibling workspaces, excludes archived entries and selects the requested workspace", () => {
  const element = tag => ({ tag, children: [], attrs: {}, listeners: {}, dataset: {}, open: false,
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    focus() { this.focused = true; },
  });
  const selected = [];
  const picker = buildWorkspacePicker({ createElement: element }, [
    { id: "one", name: "First", orgId: "same", archived: false },
    { id: "two", name: "Second", orgId: "same", archived: false },
    { id: "three", name: "Third", orgId: "other", archived: false },
    { id: "gone", name: "Archived", orgId: "same", archived: true },
  ], "two", id => selected.push(id));
  const [trigger, list] = picker.children;
  assert.equal(trigger.children[0].textContent, "Second");
  assert.deepEqual(list.children.map(item => [item.value, item.attrs["aria-current"]]),
    [["one", undefined], ["two", "page"], ["three", undefined]]);
  picker.open = true; list.children[0].listeners.click();
  assert.deepEqual(selected, ["one"]); assert.equal(picker.open, false);
  picker.open = true; let prevented = false, stopped = false;
  picker.listeners.keydown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(picker.open, false); assert.equal(trigger.focused, true); assert.ok(prevented && stopped);
});

test("the workspace picker ends with New workspace, which opens the existing flow", () => {
  const element = tag => ({ tag, children: [], attrs: {}, listeners: {}, dataset: {}, open: false, href: "",
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    focus() { this.focused = true; },
  });
  const opened = [];
  const picker = buildWorkspacePicker({ createElement: element }, [{ id: "one", name: "First", archived: false }], "one", () => {},
    { href: "/app?v=new", open: () => opened.push("new") });
  const [, list] = picker.children;
  const create = list.children.at(-1);
  assert.equal(create.tag, "a");
  assert.equal(create.textContent, "New workspace");
  assert.equal(create.href, "/app?v=new");
  picker.open = true;
  let prevented = false;
  create.listeners.click({ button: 0, preventDefault() { prevented = true; } });
  assert.deepEqual(opened, ["new"]); assert.equal(prevented, true); assert.equal(picker.open, false);
});

test("signed in, each picker row adds a settings gear beside the unchanged workspace item", () => {
  const element = tag => ({ tag, children: [], attrs: {}, listeners: {}, dataset: {}, open: false, value: "", type: "", title: "",
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    focus() { this.focused = true; },
  });
  const doc = { createElement: element, createElementNS: (_ns, tag) => element(tag) };
  const selected = [], opened = [];
  const picker = buildWorkspacePicker(doc, [
    { id: "one", name: "First", archived: false },
    { id: "gone", name: "Archived", archived: true },
    { id: "two", name: "Second", archived: false },
  ], "one", id => selected.push(id), undefined, (id, opener) => opened.push([id, opener]));
  const [, list] = picker.children;
  assert.deepEqual(list.children.map(row => [row.tag, row.className]),
    [["div", "cs-workspace-picker__row"], ["div", "cs-workspace-picker__row"]]);
  const [item, gear] = list.children[1].children;
  assert.deepEqual([item.tag, item.className, item.type, item.value, item.textContent], ["button", "cs-workspace-picker__item", "button", "two", "Second"]);
  assert.deepEqual([gear.tag, gear.className, gear.type, gear.dataset.workspacePickerSettings, gear.title],
    ["button", "cs-workspace-picker__settings", "button", "two", "Workspace settings"]);
  assert.deepEqual(gear.attrs, { "aria-label": "Workspace settings, Second", "aria-haspopup": "dialog", "aria-controls": "dashboard-workspace-details" });
  assert.equal(list.children[0].children[0].attrs["aria-current"], "page");
  // The channel header's gear glyph: one svg holding its path and circle.
  assert.equal(gear.children.length, 1); assert.equal(gear.children[0].tag, "svg");
  assert.deepEqual(gear.children[0].children.map(child => child.tag), ["path", "circle"]);

  picker.open = true; gear.listeners.click();
  assert.equal(picker.open, false);
  assert.deepEqual(opened, [["two", gear]]); assert.deepEqual(selected, []);
  picker.open = true; item.listeners.click();
  assert.equal(picker.open, false); assert.deepEqual(selected, ["two"]); assert.equal(opened.length, 1);
});

test("without openSettings (sample mode) the picker has no gear and builds no svg", () => {
  let svgs = 0;
  const element = tag => ({ tag, children: [], attrs: {}, listeners: {}, dataset: {}, open: false, value: "",
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  });
  const picker = buildWorkspacePicker({ createElement: element, createElementNS: () => { svgs++; return element("svg"); } },
    [{ id: "sample", name: "Sample", archived: false }], "sample", () => {});
  const [, list] = picker.children;
  assert.deepEqual(list.children.map(item => [item.tag, item.className, item.value]), [["button", "cs-workspace-picker__item", "sample"]]);
  assert.equal(svgs, 0);
  const all = node => [node, ...node.children.flatMap(all)];
  assert.ok(!all(picker).some(node => node.className === "cs-workspace-picker__settings" || node.className === "cs-workspace-picker__row"));
});

test("People & agents header buttons include the displayed member count in their accessible name", () => {
  const element = tag => ({
    tag, className: "", textContent: "", href: "", id: "", type: "", title: "", tabIndex: 0,
    children: [], attrs: {}, listeners: {}, dataset: {}, style: {},
    append(...children) { this.children.push(...children); },
    prepend(...children) { this.children.unshift(...children); },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  });
  const doc = { createElement: element, createElementNS: (_ns, tag) => element(tag) };
  const all = node => (node && typeof node === "object" ? [node, ...(node.children ?? []).flatMap(all)] : []);
  const vm = {
    sample: false, workspaceId: "w1", name: "Studio", pane: "chat", todosAvailable: false, hrefs,
    menu: { settings: false, adminAccess: false },
    people: [{ person: person("p1", "Alex Doe", true), agents: [agent("a1", "Claude")] }],
    otherAgents: [agent("a2", "Codex")],
  };
  const callbacks = { openPeople() {}, navigate() {}, menu() {} };
  const desktop = buildWorkspaceHeader(doc, vm, callbacks);
  const desktopPeople = all(desktop).find(n => n.className === "hm-ws-header__people");
  const textOf = node => typeof node === "string" ? node : (node.textContent || "") + (node.children ?? []).map(textOf).join("");
  assert.equal(desktopPeople?.attrs["aria-label"], "People & agents, 3");
  assert.equal(desktopPeople?.attrs["aria-description"], undefined);
  assert.equal(textOf(desktopPeople), "3", "decorative avatar initials stay out of the button text");

  const phone = buildPhoneTopBar(doc, vm, callbacks);
  const phonePeople = all(phone).find(n => n.className === "hm-phone-bar__people");
  assert.equal(phonePeople?.attrs["aria-label"], "People & agents, 3");
  assert.equal(phonePeople?.attrs["aria-description"], undefined);
  assert.equal(textOf(phonePeople), "3");
});

test("workspace header and ⋯ menu expose conversation members only when Step 2b data is present", () => {
  const element = tag => ({
    tag, children: [], attrs: {}, listeners: {}, dataset: {}, className: "", textContent: "", title: "", hidden: false,
    classList: { add() {} },
    append(...children) { this.children.push(...children); },
    prepend(...children) { this.children.unshift(...children); },
    remove() {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector(sel) {
      const flat = n => [n, ...n.children.flatMap(flat)];
      if (sel === ".hm-member-stack__count") return flat(this).find(n => n.className === "hm-member-stack__count") ?? null;
      return null;
    },
    focus() {},
  });
  const doc = { createElement: element, createElementNS: (_ns, tag) => element(tag), defaultView: { matchMedia: () => ({ matches: false }) } };
  const flat = node => [node, ...node.children.flatMap(flat)];
  let openedWith = null;
  const baseVm = {
    sample: false, workspaceId: "ws-1", name: "Home", pane: "chat",
    people: [{ person: person("u1", "Owner", true), agents: [] }],
    hrefs, todosAvailable: true, menu: { settings: true, adminAccess: false },
    channelTitle: "#ops",
    conversationMembers: { count: 3, label: "#ops members" },
  };
  const header = buildWorkspaceHeader(doc, baseVm, {
    openPeople: () => {},
    openConversationMembers: (btn) => { openedWith = btn; },
    menu: () => {},
  });
  const btn = flat(header).find(n => Object.hasOwn(n.dataset, "conversationMembersOpen"));
  assert.ok(btn, "desktop header should render conversationMembers button");
  assert.equal(btn.attrs["aria-label"], "#ops members (3)");
  btn.listeners.click();
  assert.equal(openedWith, btn);

  const withoutStep2b = buildWorkspaceHeader(doc, { ...baseVm, conversationMembers: undefined }, {
    openPeople: () => {},
    openConversationMembers: () => {},
    menu: () => {},
  });
  assert.equal(flat(withoutStep2b).find(n => Object.hasOwn(n.dataset, "conversationMembersOpen")), undefined);

  const actions = [];
  const menuWrap = buildWorkspaceMenu(doc, baseVm, {
    openPeople: () => {},
    menu: () => {},
    feedMenu: () => ({
      channels: [{ id: "general", label: "#general", current: true }],
      mayCreateChannel: true,
      conversationMembers: { label: "Members (3)" },
      filters: [{ value: "all", label: "All", current: true }],
      refresh: null,
    }),
    feed: (action) => actions.push(action),
  }, "hm-ws");
  const trigger = flat(menuWrap).find(n => n.className === "hm-menu__trigger");
  trigger.listeners.click();
  const menuItem = flat(menuWrap).find(n => Object.hasOwn(n.dataset, "menuConversationMembers"));
  assert.ok(menuItem, "⋯ menu should expose Members item");
  assert.equal(menuItem.textContent, "Members (3)");
  menuItem.listeners.click();
  assert.deepEqual(actions, [{ kind: "conversation-members" }]);
});

test("C2 agent DM header renders live seat status on desktop and phone and updates in place without changing structure key", () => {
  const flat = node => [node, ...node.children.flatMap(flat)];
  const element = (tag) => ({
    tag, className: "", textContent: "", title: "", hidden: false, type: "", id: "",
    dataset: {}, attrs: {}, children: [], listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...items) { this.children.push(...items.filter(Boolean)); },
    prepend(...items) { this.children.unshift(...items.filter(Boolean)); },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector(sel) {
      if (sel === ".hm-member-stack__count") return flat(this).find(n => n.className === "hm-member-stack__count") ?? null;
      if (sel === ".hm-dm-seat-status__shape") return flat(this).find(n => n.className === "hm-dm-seat-status__shape") ?? null;
      if (sel === ".hm-dm-seat-status__text") return flat(this).find(n => n.className === "hm-dm-seat-status__text") ?? null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "[data-dm-seat-status]") return flat(this).filter(n => Object.hasOwn(n.dataset, "dmSeatStatus"));
      return [];
    },
    focus() {},
  });
  const doc = { createElement: element, createElementNS: (_ns, tag) => element(tag), defaultView: { matchMedia: () => ({ matches: false }) } };
  const vmWorking = {
    sample: false, workspaceId: "ws-1", name: "Home", pane: "chat",
    people: [{ person: person("u1", "Owner", true), agents: [] }],
    hrefs, todosAvailable: true, menu: { settings: true, adminAccess: false },
    channelTitle: "Wren",
    dmSeatStatus: { kind: "working", line: "Working · 3 min", indicator: "dot", attention: false },
  };
  const desktop = buildWorkspaceHeader(doc, vmWorking, { openPeople: () => {}, menu: () => {} });
  const phone = buildPhoneTopBar(doc, vmWorking, { openPeople: () => {}, menu: () => {} });
  for (const [label, root] of [["desktop", desktop], ["phone", phone]]) {
    const line = flat(root).find(n => Object.hasOwn(n.dataset, "dmSeatStatus"));
    assert.ok(line, `${label} agent DM header must render [data-dm-seat-status]`);
    assert.ok(Object.hasOwn(line.dataset, "channelHeaderDescription"), `${label} seat status must carry data-channel-header-description for phone projection`);
    assert.equal(line.dataset.dmSeatStatus, "working");
    assert.equal(line.dataset.indicator, "dot");
    assert.equal(line.dataset.attention, "false");
    assert.equal(line.querySelector(".hm-dm-seat-status__shape").dataset.shape, "dot");
    assert.equal(line.querySelector(".hm-dm-seat-status__text").textContent, "Working · 3 min");
  }

  // Live tick updates line & indicator in place while keeping homeStructureKey identical.
  const vmWaiting = {
    ...vmWorking,
    dmSeatStatus: { kind: "waiting", line: "Waiting since 10:42 · 2 unseen", indicator: "diamond", attention: true },
  };
  assert.equal(homeStructureKey(vmWorking), homeStructureKey(vmWaiting), "live seat status ticks keep shell structure key stable");
  refreshHomeShellSeatStatus(desktop, vmWaiting);
  const updated = desktop.querySelectorAll("[data-dm-seat-status]")[0];
  assert.equal(updated.dataset.dmSeatStatus, "waiting");
  assert.equal(updated.dataset.indicator, "diamond");
  assert.equal(updated.dataset.attention, "true");
  assert.equal(updated.querySelector(".hm-dm-seat-status__shape").dataset.shape, "diamond");
  assert.equal(updated.querySelector(".hm-dm-seat-status__text").textContent, "Waiting since 10:42 · 2 unseen");
});
