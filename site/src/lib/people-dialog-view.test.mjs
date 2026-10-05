import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { peopleDialogGroups, peopleDialogCounts, peopleDialogAccessUntil, peopleDialogCanAct, peopleConfirmationCopy,
  peopleDialogRoleOptions, peopleRoleSelfConfirmCopy, peopleRoleReceipt, peopleRoleRefusal, peopleRoleErrorCode, peopleDialogApplyFocus,
  peopleRoleBeginSave, peopleRoleFinishSave, peopleFirstName, PEOPLE_ROLE_REFUSAL_CODES } from "./people-dialog-view.ts";
const person = (id, name, role = "member", own = false, mayRemove = false) => ({ id, name, role, own, mayRemove });
const agent = (id, ownerId, overrides = {}) => ({ id, ownerId, name: id, app: null, model: null, ownerName: ownerId === "tom" ? "Tom Langridge" : "Mei Langridge", own: false, mayManage: false, liveKey: false, access: null, accessReadState: "succeeded", status: { kind: "active", attention: false, fix: { allowed: false } }, ...overrides });
const model = () => ({ people: [person("tom", "Tom Langridge", "owner"), person("mei", "Mei Langridge")], agents: [agent("Claude", "tom"), agent("Dot", "mei", { app: "ChatGPT" }), agent("Muse", "mei", { model: "Muse Spark" }), agent("Orphan", "gone")], invites: [{ id: "invite", kind: "invite", name: "friend@example.test", detail: "Invite sent · expires in 6 days", mayCancel: false }], sample: false });

test("counts separate people, agents and attention without asserting health", () => {
  const data = model(); data.agents[2].status.attention = true;
  assert.equal(peopleDialogCounts(data), "2 people · 4 agents · 1 need attention");
  data.agents[2].status.attention = false; assert.equal(peopleDialogCounts(data), "2 people · 4 agents");
  assert.equal(peopleDialogCounts({ ...data, people: [data.people[0]], agents: [] }), "1 person · 0 agents");
});
test("grouping filters people, agents, invitations and matching attention by names and labels", () => {
  const data = model();
  assert.deepEqual(peopleDialogGroups(data, "").groups.map((group) => [group.person.id, group.agents.map((agent) => agent.id)]), [["tom",["Claude"]],["mei",["Dot","Muse"]]]);
  assert.deepEqual(peopleDialogGroups(data, "").other.map((agent) => agent.id), ["Orphan"]);
  assert.deepEqual(peopleDialogGroups(data, "Mei").groups.map((group) => group.agents.map((agent) => agent.id)), [["Dot","Muse"]]);
  assert.deepEqual(peopleDialogGroups(data, "chatgpt").groups[0].agents.map((agent) => agent.id), ["Dot"]);
  assert.deepEqual(peopleDialogGroups(data, "spark").groups[0].agents.map((agent) => agent.id), ["Muse"]);
  assert.equal(peopleDialogGroups(data, "absent").groups.length, 0);
  assert.deepEqual(peopleDialogGroups(data, "FRIEND@example").invites.map((invite) => invite.id), ["invite"]);
  assert.deepEqual(peopleDialogGroups(data, "invite sent").invites, []);
  assert.deepEqual(peopleDialogGroups(data, "re").invites, []);
  assert.deepEqual(peopleDialogGroups(data, "absent").invites, []);
  data.agents[0].status.attention = true; data.agents[2].status.attention = true;
  assert.deepEqual(peopleDialogGroups(data, "spark").attention.map((agent) => agent.id), ["Muse"]);
  assert.deepEqual(peopleDialogGroups(data, "Mei").attention.map((agent) => agent.id), ["Muse"]);
  assert.deepEqual(peopleDialogGroups(data, "absent").attention, []);
});
test("Lists & docs facts require ownership and a successful connections read", () => {
  const value = agent("Muse", "mei", { own: true, access: { until: null } });
  assert.equal(peopleDialogAccessUntil({ ...value, own: false }), null);
  for (const accessReadState of ["pending", "failed"]) {
    for (const access of [null, { until: null }]) {
      const unknown = { ...value, accessReadState, access };
      assert.equal(peopleDialogAccessUntil(unknown), null);
      for (const action of ["allow", "withdraw"]) assert.equal(peopleDialogCanAct({ ...model(), agents: [unknown] }, action, value.id), false);
    }
  }
  assert.equal(peopleDialogAccessUntil(value), "Allowed until you withdraw it.");
  assert.equal(peopleDialogAccessUntil({ ...value, access: { until: "Oct 9, 2026" } }), "Allowed until Oct 9, 2026.");
  assert.equal(peopleDialogAccessUntil({ ...value, access: null }), "Not allowed.");
  assert.equal(peopleDialogCanAct({ ...model(), agents: [{ ...value, access: null }] }, "allow", value.id), true);
  assert.equal(peopleDialogCanAct({ ...model(), agents: [value] }, "withdraw", value.id), true);
});
test("read-only, elevated, owner and sample action gates are distinct", () => {
  const data = model(); const value = data.agents[2];
  for (const action of ["resume","new-key","remove-agent","turn-off-key","withdraw","remove-person","cancel-invite"]) assert.equal(peopleDialogCanAct(data, action, value.id), false);
  value.mayManage = true; value.liveKey = true; value.access = { until: null }; value.status = { kind: "paused", fix: { allowed: true } };
  for (const action of ["resume","remove-agent","turn-off-key"]) assert.equal(peopleDialogCanAct(data, action, value.id), true);
  assert.equal(peopleDialogCanAct(data, "withdraw", value.id), false); assert.equal(peopleDialogCanAct(data, "new-key", value.id), false);
  value.own = true; assert.equal(peopleDialogCanAct(data, "withdraw", value.id), true); assert.equal(peopleDialogCanAct(data, "new-key", value.id), true);
  value.status.kind = "key-off"; value.liveKey = false; assert.equal(peopleDialogCanAct(data, "resume", value.id), false); assert.equal(peopleDialogCanAct(data, "turn-off-key", value.id), false);
  data.people[1].mayRemove = true; assert.equal(peopleDialogCanAct(data, "remove-person", "mei"), true);
  data.people[1].own = true; assert.equal(peopleDialogCanAct(data, "remove-person", "mei"), false);
  data.invites[0].mayCancel = true; assert.equal(peopleDialogCanAct(data, "cancel-invite", "invite"), true);
  data.sample = true; for (const action of ["new-key","remove-agent","withdraw","connected-apps","allow"]) assert.equal(peopleDialogCanAct(data, action, value.id), false);
  assert.equal(peopleDialogCanAct(data, "cancel-invite", "invite"), false);
});
test("confirm consequences distinguish permanent identity removal, key timing and reversible access", () => {
  const removed = peopleConfirmationCopy("remove-agent", { name: "Muse", hosted: true });
  assert.deepEqual(removed.stops, ["Muse will lose access to this space. Its identity and every connection will end.", "This cannot be undone."]);
  assert.deepEqual(removed.stays, ["Its history stays as “Muse (removed)”.", "Its owner can connect a new agent with the same name."]);
  assert.equal(peopleConfirmationCopy("turn-off-key", { name: "Muse" }).stops[0], "Muse stops when its current access ends.");
  assert.equal(peopleConfirmationCopy("withdraw", { name: "Muse" }).stays[0], "Existing lists, docs and history stay.");
  assert.equal(peopleConfirmationCopy("remove-person", { name: "Mei" }).stays[0], "History stays. Their other spaces are unaffected.");
  assert.equal(peopleConfirmationCopy("cancel-invite", { name: "Mei", kind: "invite" }).title, "Cancel this invitation?");
  assert.equal(peopleConfirmationCopy("cancel-invite", { name: "Muse", kind: "agent" }).title, "Cancel this unused key?");
});

// Role change (UI-SPEC 3.6). Expected strings are the spec's literals, not read back from the code under test.
const roster = (viewerId, roles) => ({ ...model(), people: Object.entries(roles).map(([id, role]) => person(id, id === "nikki" ? "Nikki Shah" : id, role, id === viewerId)) });
test("role select: the owner may set any role for anyone, including themselves", () => {
  const data = roster("tom", { tom: "owner", nikki: "member", sam: "admin", kit: "owner" });
  for (const id of ["tom", "nikki", "sam", "kit"]) assert.deepEqual(peopleDialogRoleOptions(data, id), ["owner", "admin", "member"]);
});
test("role select: an admin never sees Owner, and never edits an owner", () => {
  const data = roster("sam", { tom: "owner", sam: "admin", nikki: "member", lee: "admin" });
  for (const id of ["sam", "nikki", "lee"]) assert.deepEqual(peopleDialogRoleOptions(data, id), ["admin", "member"]);
  assert.deepEqual(peopleDialogRoleOptions(data, "tom"), []);
});
test("role select: members, samples, unknown people and a missing viewer get no control", () => {
  const members = roster("nikki", { tom: "owner", nikki: "member", sam: "admin" });
  for (const id of ["tom", "nikki", "sam"]) assert.deepEqual(peopleDialogRoleOptions(members, id), []);
  const owner = roster("tom", { tom: "owner", nikki: "member" });
  assert.deepEqual(peopleDialogRoleOptions({ ...owner, sample: true }, "nikki"), []);
  assert.deepEqual(peopleDialogRoleOptions(owner, "absent"), []);
  assert.deepEqual(peopleDialogRoleOptions(roster("nobody", { tom: "owner", nikki: "member" }), "nikki"), []);
});
test("role select: lowering your own role asks first, with the spec's question", () => {
  assert.deepEqual(peopleRoleSelfConfirmCopy("admin", "member"), { question: "Make yourself a member? You will no longer manage people here.", button: "Make yourself a member" });
  assert.equal(peopleRoleSelfConfirmCopy("owner", "member")?.question, "Make yourself a member? You will no longer manage people here.");
  assert.equal(peopleRoleSelfConfirmCopy("owner", "admin")?.question, "Make yourself an admin? You will no longer be able to change an owner’s role.");
  for (const [from, to] of [["member", "admin"], ["member", "owner"], ["admin", "owner"], ["member", "member"], ["owner", "owner"]]) assert.equal(peopleRoleSelfConfirmCopy(from, to), null);
});
test("role receipt names the person by first name with the right article", () => {
  assert.equal(peopleRoleReceipt("Nikki Shah", "admin"), "Nikki is now an admin.");
  assert.equal(peopleRoleReceipt("Nikki", "owner"), "Nikki is now an owner.");
  assert.equal(peopleRoleReceipt("  Nikki  Shah ", "member"), "Nikki is now a member.");
});
test("every refusal is keyed on the server code and uses the workspace name and first name", () => {
  const refuse = (code) => peopleRoleRefusal(code, "Nikki Shah", "Home");
  assert.equal(refuse("last_owner"), "Home needs at least one owner. Make someone else an owner first.");
  assert.equal(refuse("role_forbidden"), "Only an owner can change an owner’s role.");
  assert.equal(refuse("member_not_found"), "Nikki is no longer a member. Reload to check.");
  assert.equal(refuse("bad_state"), "Nikki already has that role.");
  assert.equal(refuse("landing_authority_unresolved"), "Nikki approves code changes in this workspace. Hand that to someone else first.");
  assert.equal(peopleRoleRefusal("last_owner", "Nikki", "Summer trip"), "Summer trip needs at least one owner. Make someone else an owner first.");
  assert.equal(peopleRoleRefusal("last_owner", "Nikki"), "This workspace needs at least one owner. Make someone else an owner first.");
  for (const code of [null, "", "teapot"]) assert.equal(refuse(code), "The role change was not confirmed. Reload to check.");
});
test("the refusal code is read from the error's code or reason, never its message", () => {
  assert.equal(peopleRoleErrorCode(Object.assign(new Error("last_owner"), { code: "bad_state" })), "bad_state");
  assert.equal(peopleRoleErrorCode(Object.assign(new Error("x"), { reason: "member_not_found" })), "member_not_found");
  assert.equal(peopleRoleErrorCode({ code: "rejected", reason: "last_owner" }), "last_owner");
  assert.equal(peopleRoleErrorCode({ code: "rejected", reason: "other" }), "rejected");
  assert.equal(peopleRoleErrorCode(new Error("last_owner")), null);
  assert.equal(peopleRoleErrorCode({ code: 409 }), null);
  for (const odd of [null, undefined, "last_owner", 7]) assert.equal(peopleRoleErrorCode(odd), null);
  assert.equal(peopleRoleRefusal(peopleRoleErrorCode(new Error("last_owner")), "Nikki", "Home"), "The role change was not confirmed. Reload to check.");
});
test("the change_role command's own refusal codes all have their own copy", () => {
  const source = readFileSync(new URL("../../../src/protocol/workspace-commands.ts", import.meta.url), "utf8");
  const start = source.indexOf("case 'change_role': {");
  assert.ok(start > 0, "change_role case located");
  const body = source.slice(start, source.indexOf("case 'create_agent_principal'", start));
  const codes = [...new Set([...body.matchAll(/domain\(\s*ctx,\s*cmd\.kind,\s*'([a-z_]+)'/g)].map((match) => match[1]))].sort();
  assert.deepEqual(codes, ["bad_state", "landing_authority_unresolved", "last_owner", "member_not_found", "role_forbidden"]);
  assert.deepEqual([...PEOPLE_ROLE_REFUSAL_CODES].sort(), codes);
  for (const code of codes) assert.notEqual(peopleRoleRefusal(code, "Nikki", "Home"), peopleRoleRefusal(null, "Nikki", "Home"), code);
});
test("focus opens one person or one agent once, and ignores a target that is not there", () => {
  const data = model(); const fresh = () => ({ selected: null, collapsed: new Set(["mei", "tom"]), showAllAttention: false, query: "" });
  const state = fresh();
  assert.equal(peopleDialogApplyFocus(data, state, { kind: "agent", id: "Dot" }), true);
  assert.deepEqual(state.selected, { type: "agent", id: "Dot" }); assert.deepEqual([...state.collapsed], ["tom"]);
  state.selected = null; assert.equal(peopleDialogApplyFocus(data, state, { kind: "agent", id: "Dot" }), false); assert.equal(state.selected, null);
  state.focusApplied = null; assert.equal(peopleDialogApplyFocus(data, state, { kind: "person", id: "tom" }), true);
  assert.deepEqual(state.selected, { type: "person", id: "tom" }); assert.deepEqual([...state.collapsed], []);
  for (const focus of [{ kind: "person", id: "Dot" }, { kind: "agent", id: "mei" }, { kind: "agent", id: "absent" }]) {
    const other = fresh(); assert.equal(peopleDialogApplyFocus(data, other, focus), false); assert.equal(other.selected, null); assert.equal(other.focusApplied, undefined);
  }
});
test("a person has one role save in flight, and a superseded completion is dropped", () => {
  const state = { selected: null, collapsed: new Set(), showAllAttention: false, query: "" };
  const admin = peopleRoleBeginSave(state, "nikki", "admin");
  assert.ok(admin);
  // Owner is submitted before Admin finishes: refused, so the receipt can never name a role that did not win.
  assert.equal(peopleRoleBeginSave(state, "nikki", "owner"), null);
  assert.equal(peopleRoleBeginSave(state, "nikki", "admin"), null);
  // Another person is independent.
  const other = peopleRoleBeginSave(state, "sam", "member"); assert.ok(other);
  assert.equal(peopleRoleFinishSave(state, "nikki", admin), true);
  assert.equal(peopleRoleFinishSave(state, "nikki", admin), false);
  assert.equal(peopleRoleFinishSave(state, "sam", other), true);
  // A save that lost its slot (state replaced, entry cleared) must not report.
  const stale = peopleRoleBeginSave(state, "nikki", "admin"); state.rolePending.clear();
  const fresh = peopleRoleBeginSave(state, "nikki", "owner"); assert.ok(fresh);
  assert.equal(peopleRoleFinishSave(state, "nikki", stale), false);
  assert.equal(state.rolePending.get("nikki"), fresh);
  assert.equal(peopleRoleFinishSave(state, "nikki", fresh), true);
  assert.equal(peopleRoleBeginSave(state, "nikki", "owner") !== null, true);
});
test("every first name in the dialog trims the same way", () => {
  assert.equal(peopleFirstName("  Nikki  Shah "), "Nikki");
  assert.equal(peopleFirstName("Nikki"), "Nikki");
  assert.equal(peopleFirstName("   "), "   ");
});
test("the self-change confirm is a native alertdialog with its own Escape, not an inline group", () => {
  const source = readFileSync(new URL("./people-dialog-view.ts", import.meta.url), "utf8");
  const start = source.indexOf("const roleControl"); const end = source.indexOf("const { groups, other, invites, attention }");
  const body = source.slice(start, end);
  assert.ok(start > 0 && end > start, "roleControl located");
  assert.match(body, /"dialog", "pd-confirm hm-role-confirm"/);
  assert.match(body, /setAttribute\("role", "alertdialog"\)/);
  assert.match(body, /dialog\.oncancel = \(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\)/);
  assert.doesNotMatch(body, /role", "group"/);
  assert.match(source, /confirm\.showModal\(\)/);
});
