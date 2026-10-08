import assert from "node:assert/strict";
import { test } from "node:test";
import { PICKER_CLOSED, TAG_HIGHLIGHT_FOOTER, activeDescendant, assignOptions, chipKey, chipStop, commentSegments, filterOptions, insertTag, mentionQuery,
  personNames, pickerKey, pickerOpen, pickerOptionId, tagLabel, tagOptions, tagsInBody } from "./home-pickers.ts";

const state = (over = {}) => ({ kind: "idle", word: "Idle", detail: "Active 2 hours ago", attention: false,
  fix: { action: null, allowed: false, askWho: null, sentence: "" }, ...over });
const person = (id, name, over = {}) => ({ id, name, firstName: name.split(" ")[0], initials: "XX", you: false, role: "member", ...over });
const agent = (id, label, owner, over = {}) => ({ id, name: id, label, nestedLabel: id, ownerId: owner?.id ?? null, ownerFirstName: owner?.firstName ?? null,
  ownerInitial: "X", yours: false, tint: 0, hosted: false, state: state(), ...over });
const tom = person("tom", "Tom Langridge", { you: true, role: "owner" });
const nikki = person("nikki", "Nikki Sato", { role: "admin" });
const claude = agent("claude", "Your Claude", tom, { yours: true, state: state({ kind: "working", word: "Working", detail: "Doing ‘Budget sheet’ since 9:40 am" }) });
const dot = agent("dot", "Your dot", tom, { yours: true, state: state({ kind: "disconnected", word: "Disconnected", detail: "Key turned off", attention: true }) });
const muse = agent("muse", "Nikki’s Muse", nikki);
const orphan = agent("old", "Claude (owner left)", null);
// Nikki's group comes first in the input: the picker must still put the viewer first.
const people = { groups: [{ person: nikki, agents: [muse] }, { person: tom, agents: [claude, dot] }], other: [orphan] };
const row = (option) => [option.value, option.label, option.caption, option.group, option.disabled];

test("assign picker: you and your agents first, possessive labels, and the four spec captions", () => {
  const options = assignOptions(people, { lineCount: (id) => (id === "claude" ? 2 : null), goesAsRequest: (id) => id === "muse" });
  assert.deepEqual(options.map(row), [
    ["tom", "Tom (you)", "Person · no line order", "tom", false],
    ["claude", "Your Claude", "Working · 2 in line", "tom", false],
    ["dot", "Your dot", "Disconnected · nothing moves until it reconnects", "tom", false],
    ["nikki", "Nikki", "Person · no line order", "nikki", false],
    ["muse", "Nikki’s Muse", "Goes to Nikki as a request", "nikki", false],
  ]);
  assert.ok(!options.some((option) => option.value === "old"), "an agent whose owner left is not offered for assignment");
});

test("assign captions leave unknown counts out and say request only when the server flag is set", () => {
  const options = assignOptions(people);
  assert.equal(options.find((option) => option.value === "claude").caption, "Working");
  assert.equal(options.find((option) => option.value === "muse").caption, "Idle");
  const withCount = assignOptions(people, { lineCount: () => 0 });
  assert.equal(withCount.find((option) => option.value === "muse").caption, "Idle · 0 in line", "a measured zero is still shown");
  const waiting = agent("w", "Your Wren", tom, { yours: true, state: state({ kind: "disconnected", word: "Not picking up", detail: "A message has waited since 10:05 am" }) });
  assert.equal(assignOptions({ groups: [{ person: tom, agents: [waiting] }] })[1].caption, "Not picking up · nothing moves until it checks its messages");
  const museOff = { ...muse, state: dot.state };
  assert.equal(assignOptions({ groups: [{ person: nikki, agents: [museOff] }] }, { goesAsRequest: () => true })[1].caption, "Goes to Nikki as a request · Disconnected");
  assert.equal(assignOptions({ groups: [{ person: tom, agents: [claude] }] }, { goesAsRequest: () => true })[1].caption, "Working",
    "your own agent never goes as a request");
});

test("shared first names fall back to full names; invited people and unused keys cannot be picked", () => {
  const samA = person("a", "Sam Lee"); const samB = person("b", "Sam Ortiz", { you: true });
  const invited = person("c", "Ada Park", { dashed: true }); const fresh = agent("n", "Ada’s Nova", invited, { dashed: true });
  const options = assignOptions({ groups: [{ person: samA, agents: [] }, { person: samB, agents: [] }, { person: invited, agents: [fresh] }] });
  assert.deepEqual(options.map((option) => [option.label, option.disabled]), [["Sam Ortiz (you)", false], ["Ada", true], ["Ada’s Nova", true], ["Sam Lee", false]]);
});

test("a request caption names the owner by full name when two people share a first name (UI-SPEC 2.3)", () => {
  const samLee = person("sl", "Sam Lee"); const samOrtiz = person("so", "Sam Ortiz");
  const leeMuse = agent("muse-sl", "Sam Lee’s Muse", samLee); const ortizMuse = agent("muse-so", "Sam Ortiz’s Muse", samOrtiz);
  const options = assignOptions({ groups: [{ person: samOrtiz, agents: [ortizMuse] }, { person: samLee, agents: [leeMuse] }, { person: tom, agents: [] }] },
    { goesAsRequest: () => true });
  assert.equal(options.find((option) => option.value === "muse-sl").caption, "Goes to Sam Lee as a request");
  assert.equal(options.find((option) => option.value === "muse-so").caption, "Goes to Sam Ortiz as a request");
  // Control: a first name nobody shares stays short.
  const solo = assignOptions({ groups: [{ person: samLee, agents: [leeMuse] }, { person: tom, agents: [] }] }, { goesAsRequest: () => true });
  assert.equal(solo.find((option) => option.value === "muse-sl").caption, "Goes to Sam as a request");
});

test("tag picker: status word for agents, role for people, other agents last", () => {
  assert.deepEqual(tagOptions(people).map((option) => [option.value, option.label, option.caption, option.group]), [
    ["tom", "Tom (you)", "Owner", "tom"], ["claude", "Your Claude", "Working", "tom"], ["dot", "Your dot", "Disconnected", "tom"],
    ["nikki", "Nikki", "Admin", "nikki"], ["muse", "Nikki’s Muse", "Idle", "nikki"], ["old", "Claude (owner left)", "Idle", "other"],
  ]);
  assert.equal(TAG_HIGHLIGHT_FOOTER, "A tag here highlights the name. To ask them directly, write in chat.");
  assert.deepEqual(filterOptions(tagOptions(people), "  MUS ").map((option) => option.value), ["muse"]);
  assert.equal(filterOptions(tagOptions(people), "").length, 6);
});

test("combobox keyboard model: Up and Down move and wrap, skip disabled rows, Enter picks, Escape restores focus", () => {
  const options = [{ value: "a", kind: "person", label: "A", caption: "", group: "g", disabled: false },
    { value: "b", kind: "agent", label: "B", caption: "", group: "g", disabled: true },
    { value: "c", kind: "agent", label: "C", caption: "", group: "g", disabled: false }];
  let result = pickerKey(PICKER_CLOSED, "ArrowDown", options);
  assert.deepEqual(result, { state: { open: true, active: 0 }, effect: null, handled: true });
  result = pickerKey(result.state, "ArrowDown", options); assert.equal(result.state.active, 2, "the disabled row is skipped");
  result = pickerKey(result.state, "ArrowDown", options); assert.equal(result.state.active, 0, "Down wraps to the top");
  result = pickerKey(result.state, "ArrowUp", options); assert.equal(result.state.active, 2, "Up wraps to the bottom");
  assert.equal(pickerKey(result.state, "Home", options).state.active, 0);
  assert.equal(pickerKey({ open: true, active: 0 }, "End", options).state.active, 2);
  const picked = pickerKey(result.state, "Enter", options);
  assert.deepEqual(picked, { state: { open: false, active: null }, effect: { kind: "select", option: options[2] }, handled: true });
  assert.deepEqual(pickerKey({ open: true, active: 0 }, "Escape", options), { state: PICKER_CLOSED, effect: { kind: "close", restoreFocus: true }, handled: true });
  assert.deepEqual(pickerKey({ open: true, active: 0 }, "Tab", options), { state: PICKER_CLOSED, effect: { kind: "close", restoreFocus: false }, handled: false });
  assert.deepEqual(pickerKey({ open: true, active: null }, "Enter", options), { state: { open: true, active: null }, effect: null, handled: true });
  assert.deepEqual(pickerKey(PICKER_CLOSED, "Escape", options), { state: PICKER_CLOSED, effect: null, handled: false });
  assert.deepEqual(pickerKey(PICKER_CLOSED, "ArrowUp", options).state, { open: true, active: 2 });
  assert.deepEqual(pickerKey({ open: true, active: 0 }, "x", options).handled, false);
});

test("assign chips keyboard model: arrows move focus only, wrap and skip disabled chips; Space and Enter pick", () => {
  const options = [{ value: "a", kind: "person", label: "A", caption: "", group: "g", disabled: false },
    { value: "b", kind: "agent", label: "B", caption: "", group: "g", disabled: true },
    { value: "c", kind: "agent", label: "C", caption: "", group: "h", disabled: false }];
  assert.deepEqual(chipKey(options, 0, "ArrowRight"), { focus: 2, select: null, handled: true }, "the disabled chip is skipped, nothing is picked");
  assert.deepEqual(chipKey(options, 0, "ArrowDown"), { focus: 2, select: null, handled: true });
  assert.equal(chipKey(options, 2, "ArrowRight").focus, 0, "Right wraps to the first chip");
  assert.equal(chipKey(options, 0, "ArrowLeft").focus, 2, "Left wraps to the last chip");
  assert.equal(chipKey(options, 2, "ArrowUp").focus, 0);
  assert.equal(chipKey(options, 2, "Home").focus, 0); assert.equal(chipKey(options, 0, "End").focus, 2);
  assert.deepEqual(chipKey(options, 2, " "), { focus: 2, select: options[2], handled: true });
  assert.deepEqual(chipKey(options, 0, "Enter"), { focus: 0, select: options[0], handled: true });
  assert.deepEqual(chipKey(options, 1, "Enter"), { focus: 1, select: null, handled: true }, "a disabled chip is never picked");
  assert.deepEqual(chipKey(options, 0, "Escape"), { focus: 0, select: null, handled: false });
  assert.deepEqual(chipKey(options, 0, "Tab"), { focus: 0, select: null, handled: false }, "Tab leaves the group");
});

test("the chips' one tab stop is the current assignee when it can be picked, otherwise the first chip that can", () => {
  const options = assignOptions(people);
  assert.equal(options[chipStop(options, "muse")].value, "muse");
  assert.equal(chipStop(options, "absent"), 0); assert.equal(chipStop(options, null), 0);
  const disabledFirst = [{ value: "x", kind: "person", label: "X", caption: "", group: "g", disabled: true },
    { value: "y", kind: "person", label: "Y", caption: "", group: "g", disabled: false }];
  assert.equal(chipStop(disabledFirst, "x"), 1, "a current value that cannot be picked does not take the stop");
  assert.equal(chipStop([disabledFirst[0]], "x"), null);
});

test("opening starts on the current value when it can be picked", () => {
  const options = assignOptions(people);
  assert.equal(options[pickerOpen(options, "muse").active].value, "muse");
  assert.equal(pickerOpen(options, "absent").active, 0);
  assert.equal(options[pickerKey(PICKER_CLOSED, "ArrowDown", options, "nikki").state.active].value, "nikki");
  const none = [{ value: "x", kind: "person", label: "X", caption: "", group: "g", disabled: true }];
  assert.deepEqual(pickerOpen(none), { open: true, active: null });
  assert.deepEqual(pickerKey({ open: true, active: null }, "ArrowDown", none).state, { open: true, active: null });
});

test("aria-activedescendant ids are stable, DOM-safe, and absent while closed", () => {
  const option = { value: "a b/1", kind: "agent", label: "Odd", caption: "", group: "g", disabled: false };
  assert.equal(pickerOptionId("hm-pick", option), "hm-pick-agent-a_b_1");
  assert.equal(pickerOptionId("hm-pick", { kind: "person", value: "tom" }), "hm-pick-person-tom");
  assert.equal(activeDescendant("hm-pick", { open: true, active: 0 }, [option]), "hm-pick-agent-a_b_1");
  assert.equal(activeDescendant("hm-pick", PICKER_CLOSED, [option]), null);
  assert.equal(activeDescendant("hm-pick", { open: true, active: null }, [option]), null);
});

test("@ opens the tag picker only at a word start, and a pick writes the tag into the text", () => {
  assert.deepEqual(mentionQuery("Thanks. @Mu", 11), { query: "mu", start: 8 });
  assert.deepEqual(mentionQuery("@", 1), { query: "", start: 0 });
  assert.deepEqual(mentionQuery("line one\n@N", 11), { query: "n", start: 9 });
  assert.equal(mentionQuery("mail me at tom@example.test", 27), null);
  assert.equal(mentionQuery("@Muse done", 10), null, "the caret is past the tag");
  assert.deepEqual(insertTag("Thanks. @Mu", 8, 11, "Nikki’s Muse"), { text: "Thanks. @Nikki’s Muse ", caret: 22 });
  assert.deepEqual(insertTag("@ and more", 0, 1, "Tom (you)"), { text: "@Tom (you)  and more", caret: 11 });
});

test("only tags still in the body are sent, once each", () => {
  const picked = [{ id: "muse", label: "Nikki’s Muse" }, { id: "tom", label: "Tom (you)" }, { id: "muse", label: "Nikki’s Muse" }];
  assert.deepEqual(tagsInBody("Can @Nikki’s Muse check?", picked), [{ id: "muse", label: "Nikki’s Muse" }]);
  assert.deepEqual(tagsInBody("No tags now", picked), []);
  const nikkiThenMuse = [{ id: "nikki", label: "Nikki" }, { id: "muse", label: "Nikki’s Muse" }];
  assert.deepEqual(tagsInBody("Ask @Nikki’s Muse", nikkiThenMuse), [{ id: "muse", label: "Nikki’s Muse" }], "a longer tag does not also send the shorter one");
  assert.deepEqual(tagsInBody("Ask @Nikki’s Muse and @Nikki", nikkiThenMuse).map((tag) => tag.id), ["muse", "nikki"]);
});

test("a tag of the viewer writes the name without the picker's (you)", () => {
  assert.equal(tagLabel({ kind: "person", label: "Tom (you)" }), "Tom");
  assert.equal(tagLabel({ kind: "person", label: "Nikki" }), "Nikki");
  assert.equal(tagLabel({ kind: "agent", label: "Your Claude" }), "Your Claude");
});

test("comment bodies split into text and tag pieces; hostile text stays a plain string", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const tags = [{ id: "n", label: "Nikki" }, { id: "m", label: "Nikki’s Muse" }];
  assert.deepEqual(commentSegments(`@Nikki’s Muse and @Nikki: ${hostile}`, tags), [
    { text: "@Nikki’s Muse", tag: tags[1] }, { text: " and ", tag: null }, { text: "@Nikki", tag: tags[0] }, { text: `: ${hostile}`, tag: null },
  ]);
  assert.deepEqual(commentSegments("plain", []), [{ text: "plain", tag: null }]);
  assert.deepEqual(commentSegments("", tags), []);
  assert.equal(commentSegments(`x ${hostile} @Nikki`, tags).map((piece) => piece.text).join(""), `x ${hostile} @Nikki`, "nothing is lost or added");
});

test("a tag is a whole word: a longer word or an address that starts the same is not the tag", () => {
  const nikkiTag = [{ id: "nikki", label: "Nikki" }];
  assert.deepEqual(tagsInBody("@Nikki can you?", nikkiTag), nikkiTag, "positive control");
  assert.deepEqual(tagsInBody("@Nikki, @Nikki. (@Nikki)", nikkiTag), nikkiTag, "punctuation ends a tag");
  assert.deepEqual(tagsInBody("Ask @NikkiNew", nikkiTag), [], "the text after the pick was edited into another word");
  assert.deepEqual(tagsInBody("Ask @Nikki2", nikkiTag), []);
  assert.deepEqual(tagsInBody("mail tom@Nikki", nikkiTag), [], "an @ inside a word is not a tag");
  assert.deepEqual(commentSegments("@NikkiNew", nikkiTag), [{ text: "@NikkiNew", tag: null }]);
  assert.deepEqual(tagsInBody("Ask @Nikki’s Muse", [{ id: "muse", label: "Nikki’s Muse" }]).map((tag) => tag.id), ["muse"]);
});

test("person names: first names, full names only where shared, and no (you) outside the picker", () => {
  const samA = person("a", "Sam Lee"); const samB = person("b", "Sam Ortiz", { you: true });
  assert.deepEqual([...personNames([{ person: samA, agents: [] }, { person: samB, agents: [] }, { person: nikki, agents: [] }])],
    [["a", "Sam Lee"], ["b", "Sam Ortiz"], ["nikki", "Nikki"]]);
});
