/** cswarm todo parsing and the cswarm object argument hint (src/cloud/todo-cli.ts). The wire and the
 * command itself are in tests/p1-cli/todo-cli.test.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkedToolArguments, fileText, householdArgumentsHint, HouseholdArgumentsError, mentionCount, oneSource, partyLabel,
  resolveTodoParty, schemaShape, terminalLine, todoBaseVersion, todoCommentBody, todoDue, todoFailureText, todoIdArgument,
  todoLimit, todoNotes, todoOffset, todoRefusalNextStep, todoSection, todoStart, todoTitle, TODO_ID_RE,
} from "../src/cloud/todo-cli.js";
import { HOUSEHOLD_TOOL_REGISTRY, HouseholdToolInputError } from "../src/protocol/household-tool-registry.js";
import { MENTION_MAX_RECIPIENTS } from "../src/protocol/mention-address.js";
import { TODO_COMMENT_LIMIT, TODO_MENTIONS_LIMIT, TODO_NOTES_LIMIT, TODO_TITLE_LIMIT } from "../src/protocol/household-todo-policy.js";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const seat = "seat_0000000000000000000000";

test("the to-do id is the registry's uuid form, lowercased", () => {
  const registry = HOUSEHOLD_TOOL_REGISTRY.find((row) => row.name === "todo_read")!.inputSchema.properties!.todo_id!;
  assert.equal(registry.pattern, TODO_ID_RE.source, "same pattern as the server's schema");
  assert.equal(todoIdArgument("ABCDEF00-0000-0000-0000-000000000000", "cswarm todo read"), "abcdef00-0000-0000-0000-000000000000",
    "a UUID outside versions 1-8 still passes, as on the server");
  assert.throws(() => todoIdArgument(undefined, "cswarm todo read"), /cswarm todo read needs the to-do id: cswarm todo read <todo-id>/);
  assert.throws(() => todoIdArgument("milk", "cswarm todo done"), /cswarm todo done takes a to-do id, which is a UUID/);
});

test("page, version and section flags take exactly the server's ranges", () => {
  assert.equal(todoLimit(undefined), undefined);
  assert.equal(todoLimit("1"), 1); assert.equal(todoLimit("50"), 50);
  for (const bad of ["0", "51", "1.5", "-1", "five", ""]) assert.throws(() => todoLimit(bad), /--limit takes a whole number, 1 to 50/, bad);
  assert.equal(todoOffset("0"), 0);
  assert.throws(() => todoOffset("-1"), /--offset takes a whole number, 0 or more/);
  assert.throws(() => todoOffset("9".repeat(20), "comment-offset"), /--comment-offset takes a whole number/);
  assert.equal(todoBaseVersion("3"), 3);
  assert.throws(() => todoBaseVersion("0"), /--base-version takes a whole number, 1 or more/);
  assert.equal(todoSection("not_yet"), "not_yet");
  assert.throws(() => todoSection("later"), /--section takes working, up_next, not_yet or requests/);
  assert.equal(todoStart("now"), "now");
  assert.throws(() => todoStart("soon"), /--start takes queue/);
});

test("dates, titles, notes and comments follow the server's rules", () => {
  assert.equal(todoDue("2028-02-29"), "2028-02-29");
  for (const bad of ["2026-02-29", "2026-13-01", "26-01-01", "2026-1-01", "tomorrow"]) assert.throws(() => todoDue(bad), /--due takes a calendar date/, bad);
  assert.equal(todoTitle("😀".repeat(TODO_TITLE_LIMIT)), "😀".repeat(TODO_TITLE_LIMIT), "characters, not UTF-16 units");
  assert.throws(() => todoTitle("x".repeat(TODO_TITLE_LIMIT + 1)), /at most 200/);
  assert.throws(() => todoTitle("  "), /cannot be empty/);
  assert.throws(() => todoTitle("a\tb"), /one line of text/);
  assert.equal(todoNotes("a\n\tb"), "a\n\tb");
  assert.throws(() => todoNotes("x".repeat(TODO_NOTES_LIMIT + 1)), /at most 4000/);
  assert.throws(() => todoNotes("bell\u0007"), /control characters/);
  assert.throws(() => todoCommentBody(" \n "), /cannot be empty/);
  assert.throws(() => todoCommentBody("x".repeat(TODO_COMMENT_LIMIT + 1)), /at most 4000/);
  assert.equal(fileText("one\r\ntwo\r\n\n"), "one\ntwo");
});

test("one source of text, or none when optional", () => {
  assert.equal(oneSource([{ label: "a", present: false }, { label: "b", present: true }], true, "the comment"), 1);
  assert.equal(oneSource([{ label: "a", present: false }, { label: "b", present: false }], false, "the notes"), null);
  assert.throws(() => oneSource([{ label: "a", present: false }, { label: "b", present: false }], true, "the comment"), /Give the comment as a or b/);
  assert.throws(() => oneSource([{ label: "a", present: true }, { label: "b", present: true }], false, "the notes"), /Give the notes one way: a or b, not both/);
});

test("names resolve like @mentions: case and accents folded, ids exact, ambiguity named", () => {
  const roster = [
    { kind: "user" as const, id: uid(2), name: "İpek" },
    { kind: "agent" as const, id: uid(3).toUpperCase(), name: "Helper" },
    { kind: "agent" as const, id: uid(6), name: "Twin" },
    { kind: "user" as const, id: uid(7), name: "twin" },
  ];
  assert.deepEqual(resolveTodoParty("ipek", roster, "assign"), { kind: "user", id: uid(2) });
  assert.deepEqual(resolveTodoParty("@HELPER", roster, "assign"), { kind: "agent", id: uid(3) });
  assert.deepEqual(resolveTodoParty(uid(3), roster, "agent", ["agent"]), { kind: "agent", id: uid(3) });
  assert.deepEqual(resolveTodoParty("twin", roster, "agent", ["agent"]), { kind: "agent", id: uid(6) }, "kinds narrow the match");
  assert.throws(() => resolveTodoParty("Twin", roster, "assign"), new RegExp(`names more than one person or agent here; use one of these ids: agent ${uid(6)}, person ${uid(7)}`));
  assert.throws(() => resolveTodoParty("ipek", roster, "agent", ["agent"]), /--agent "ipek" is not an agent in this workspace/);
  assert.throws(() => resolveTodoParty(uid(9), roster, "assignee"), /is not a person or agent in this workspace/);
});

test("the comment mention cap is the message mention cap", () => {
  assert.equal(TODO_MENTIONS_LIMIT, MENTION_MAX_RECIPIENTS);
  const party = { kind: "user" as const, id: uid(2) };
  assert.equal(mentionCount(Array(TODO_MENTIONS_LIMIT).fill(party)).length, TODO_MENTIONS_LIMIT);
  assert.throws(() => mentionCount(Array(TODO_MENTIONS_LIMIT + 1).fill(party)), /at most 8/);
});

test("checked arguments pass the registry; a failure keeps invalid_arguments and adds the hint", () => {
  assert.deepEqual(checkedToolArguments("todo_list", { seat, scope: "open" }), { seat, scope: "open" });
  try {
    checkedToolArguments("todo_list", { seat, scope: "some" });
    assert.fail("accepted");
  } catch (error) {
    assert.ok(error instanceof HouseholdArgumentsError && error instanceof HouseholdToolInputError);
    assert.equal(error.code, "invalid_arguments");
    assert.equal(error.message, `Household tool input refused: invalid_arguments. scope must be "open"|"all". todo_list takes scope, assignee?, offset?, limit?.`);
  }
  assert.throws(() => checkedToolArguments("no_such_tool", { seat }), (error: unknown) => error instanceof HouseholdToolInputError
    && !(error instanceof HouseholdArgumentsError) && error.code === "unknown_tool");
});

test("the hint covers each refusal path: missing, unknown, wrong form, rule-only and not an object", () => {
  assert.equal(householdArgumentsHint("todo_set_state", { seat, todo_id: uid(4) }),
    "Missing request_id <8-72 of A-Z a-z 0-9 _ -> (a new one for each write, such as a UUID); base_version <integer ≥ 1>; state \"open\"|\"doing\"|\"done\"|\"dropped\". todo_set_state takes request_id, todo_id, base_version, state.");
  const unknown = householdArgumentsHint("todo_read", { seat, todo_id: uid(4), a: 1, b: 2, c: 3, d: 4, e: 5, ["x".repeat(60)]: 6 });
  assert.match(unknown, /^Not accepted: "a", "b", "c", "d", "e" and 1 more\. todo_read takes todo_id, comment_offset\?\.$/);
  assert.match(householdArgumentsHint("todo_read", { seat, ["k".repeat(60)]: 1, todo_id: uid(4) }), new RegExp(`"${"k".repeat(40)}…"`));
  assert.match(householdArgumentsHint("todo_comment", { seat, request_id: "abcdefgh", target: { kind: "doc", id: "" }, body: "x" }),
    /^target must be \{"kind":"todo","id":<uuid>\} \| \{"kind":"list"\|"doc"\|"file","id":<text 1-255 chars>\}\./);
  assert.match(householdArgumentsHint("todo_create", { seat: "seat_x", request_id: "abcdefgh", title: "x" }), /^Leave out seat; cswarm fills it in\./);
  assert.match(householdArgumentsHint("object_create", { seat, request_id: "abcdefgh", object_id: "a", title: "t",
    content: { kind: "list", items: [{ item_id: "a", text: "x", order: 1, checked: false }] } }), /^Every key has the right form, but a value breaks a rule/);
  assert.match(householdArgumentsHint("todo_list", [1]), /^The input file must hold one JSON object\. todo_list takes/);
  assert.match(householdArgumentsHint("todo_list", { seat, scope: "open", limit: 99 }), /^limit must be <integer 1-50>\./);
  assert.match(householdArgumentsHint("todo_create", { seat, request_id: "abcdefgh", title: "x", due_on: "soon" }), /due_on must be <YYYY-MM-DD> \| null\./);
  assert.doesNotMatch(householdArgumentsHint("todo_create", { seat, request_id: "abcdefgh", title: "x", due_on: "SECRET_VALUE" }), /SECRET_VALUE/);
});

test("every household tool's schema has a printable shape", () => {
  for (const row of HOUSEHOLD_TOOL_REGISTRY) {
    for (const [key, schema] of Object.entries(row.inputSchema.properties!)) {
      const shape = schemaShape(schema, 1);
      assert.ok(shape.length > 0 && shape.length < 400 && !shape.includes("<value>"), `${row.name}.${key}: ${shape}`);
    }
  }
});

test("terminal text and next steps", () => {
  assert.equal(terminalLine("a\u001b[31mb‮c\nd"), "ab c d");
  assert.equal(partyLabel({ kind: "agent", id: uid(3) }, new Map([[`agent:${uid(3)}`, "Help\u001b[2Jer"]])), `Helper (agent ${uid(3)})`);
  assert.equal(partyLabel({ kind: "user", id: uid(2) }), `person ${uid(2)}`);
  assert.match(todoRefusalNextStep("principal_required")!, /cswarm todo queue --agent <name\|id>/);
  assert.match(todoRefusalNextStep("invalid_transition", uid(4))!, new RegExp(`cswarm todo read ${uid(4)} shows its state`));
  assert.match(todoRefusalNextStep("content_consent_required")!, /ask its owner|Ask this agent's owner/i, "falls back to the shared household step");
  assert.equal(todoFailureText({ status: "unknown", request_id: "req_00001", reason: "transport_interrupted" }, uid(4)),
    `the outcome is unknown (transport_interrupted) for request req_00001. Check with cswarm todo read ${uid(4)} before trying again.`);
  assert.equal(todoFailureText({ status: "refused", reason: "not_assignee" }, uid(4)),
    `refused: not_assignee. It is assigned to someone else, and only they can start it; cswarm todo read ${uid(4)} shows who.`);
});
