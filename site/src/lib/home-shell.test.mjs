import assert from "node:assert/strict";
import { test } from "node:test";
import { capsuleSubline, joinNames, menuFocusIndex, shellDoors, workspaceMenuItems, workspaceNavItems } from "./home-shell.ts";

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

test("the capsule subline puts you first, names two people, then +N", () => {
  const tom = { person: person("tom", "Tom Langridge", true), agents: [agent("c", "Claude"), agent("d", "dot")] };
  const nikki = { person: person("nikki", "Nikki Hale"), agents: [agent("m", "Muse")] };
  const priya = { person: person("priya", "Priya Shah"), agents: [] };
  const alex = { person: person("alex", "Alex Doe"), agents: [] };
  assert.equal(capsuleSubline([nikki, tom]), "You with Claude and dot · Nikki with Muse");
  assert.equal(capsuleSubline([priya, nikki, tom]), "You with Claude and dot · Nikki with Muse · +1");
  assert.equal(capsuleSubline([priya, nikki, alex, tom]), "You with Claude and dot · Alex · +2");
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
