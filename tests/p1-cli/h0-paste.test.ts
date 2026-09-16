/*
 * Controls on the paste a human copies to invite an agent.
 *
 * Gate: tests/p1-cli/**\/*.test.ts is globbed by `npm run test:p1-cli`. `npm test` does not run it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { h0AgentPaste } from "../../src/h0/paste.js";
import { H0_VERB_NAMES } from "../../src/h0/verbs.js";

/* A body with mixed case and every base64url symbol class, so a case-folding or prefix-only check
 * cannot pass by accident. 43 characters. */
const SECRET_BODY = "Zq9-Kx7_Wm3LpRt5Vb2NcYh8Jd4Gf6Sa1Qe0Uo-Ti_X";
const JOIN_CREDENTIAL = `swm_join_${SECRET_BODY}`;
const DOCUMENT_URL = "https://commonswarm.com/agent/h0-doc";
const paste = (documentUrl: string, joinCredential = JOIN_CREDENTIAL) =>
  h0AgentPaste({ joinCredential, documentUrl });
const refusesSecret = (documentUrl: string) =>
  assert.throws(() => paste(documentUrl), /must not contain the join credential or any part of it/, documentUrl);

test("the secret body fixture is exactly 43 base64url characters", () => {
  assert.match(SECRET_BODY, /^[A-Za-z0-9_-]{43}$/);
});

test("the whole H0 agent paste matches the reviewed golden text", () => {
  /* READ BEFORE UPDATING: this is what a human copies. A golden pins whatever the paste says, errors
   * included, so diff it against the register endpoint's contract, not only against your intent. */
  assert.equal(
    paste(DOCUMENT_URL),
    [
      "Fetch the agent document at this URL; fetching it needs no credential:",
      DOCUMENT_URL,
      "Then call register once, sending only this single-purpose join credential:",
      JOIN_CREDENTIAL,
    ].join("\n"),
  );
});

test("each value is on its own line, directly under the sentence that names it", () => {
  /* An earlier version ended a sentence with the credential and a semicolon; a model extracting the
   * token can take the semicolon with it. */
  const lines = paste(DOCUMENT_URL).split("\n");
  assert.equal(lines.filter((line) => line === JOIN_CREDENTIAL).length, 1);
  assert.equal(lines.filter((line) => line.includes(SECRET_BODY)).length, 1);
  /* An arm noted the URL once sat under a line ending "credential:". Each colon now introduces the
   * value on the very next line, and only that value. */
  const credentialIntro = lines.findIndex((line) => line.endsWith("join credential:"));
  assert.equal(lines[credentialIntro + 1], JOIN_CREDENTIAL, "the credential directly follows its label");
  const urlIntro = lines.findIndex((line) => line.startsWith("Fetch the agent document"));
  assert.equal(lines[urlIntro + 1], DOCUMENT_URL, "the URL directly follows the fetch sentence");
});

test("the returned URL is the canonical form that was validated, not the raw input", () => {
  const lines = paste("https://CommonSwarm.com").split("\n");
  assert.equal(lines[1], "https://commonswarm.com/");
});

test("a document URL with a query string is refused", () => {
  assert.throws(() => paste(`${DOCUMENT_URL}?x=1`), /must not contain a query string/);
});

test("a document URL with a fragment is refused", () => {
  assert.throws(() => paste(`${DOCUMENT_URL}#frag`), /must not contain a fragment/);
});

test("a document URL carrying userinfo is refused", () => {
  /* Shows commonswarm.com to a human and fetches attacker.example. */
  assert.throws(() => paste("https://commonswarm.com@attacker.example/agent/h0-doc"), /must not contain userinfo/);
  assert.throws(() => paste("https://user:pass@commonswarm.com/agent/h0-doc"), /must not contain userinfo/);
});

test("a malformed percent-escape is refused rather than skipping the decoded check", () => {
  /* The first version fell back to the undecoded string, which turned the decoded check off. */
  assert.throws(() => paste(`${DOCUMENT_URL}/bad%FF`), /malformed percent-escape/);
});

test("secret material with 12 contiguous characters of the body is refused, in many shapes", () => {
  const percent = (s: string) => [...s].map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).join("");
  refusesSecret(`${DOCUMENT_URL}/${JOIN_CREDENTIAL}`);                         // whole credential
  refusesSecret(`${DOCUMENT_URL}/${SECRET_BODY}`);                             // body without its prefix
  refusesSecret(`${DOCUMENT_URL}/${SECRET_BODY.slice(0, 42)}`);                // all but one character
  refusesSecret(`${DOCUMENT_URL}/${SECRET_BODY.slice(0, 21)}/${SECRET_BODY.slice(21)}`); // split in two
  refusesSecret(`${DOCUMENT_URL}/${SECRET_BODY.slice(10, 22)}`);               // one 12-character window
  refusesSecret(`${DOCUMENT_URL}/${SECRET_BODY.toLowerCase()}`);               // case-folded
  refusesSecret(`${DOCUMENT_URL}/${percent(SECRET_BODY.slice(0, 20))}`);       // percent-encoded
  refusesSecret(`${DOCUMENT_URL}/${percent(SECRET_BODY.slice(0, 20)).replaceAll("%", "%25")}`); // double
});

test("THE STATED LIMIT: pieces shorter than 12 characters are not refused", () => {
  /* Two jobs. It is the positive control for the window — the check must not refuse ordinary URLs by
   * accident. And it pins the limit the source states, so the limit cannot silently change: a
   * secret chopped into 11-character chunks passes this guard. An arm caught an earlier test name
   * claiming "every shape a coding mistake could produce". */
  const chunks = SECRET_BODY.match(/.{1,11}/g)!;
  assert.doesNotThrow(() => paste(`${DOCUMENT_URL}/${chunks.join("/")}`));
  assert.doesNotThrow(() => paste(`${DOCUMENT_URL}/${SECRET_BODY.slice(0, 11)}`));
});

test("a malformed join credential is refused", () => {
  for (const joinCredential of [
    `swm_agt_${SECRET_BODY}`,
    `swm_join_${SECRET_BODY.slice(0, 42)}`,
    `swm_join_${SECRET_BODY}A`,
    `swm_join_${SECRET_BODY.slice(0, 42)}.`,
  ]) {
    assert.throws(() => paste(DOCUMENT_URL, joinCredential), /joinCredential must be swm_join_ followed by 43 base64url characters/);
  }
});

test("a plaintext document URL is refused unless the host is loopback", () => {
  for (const documentUrl of [
    "http://commonswarm.com/agent/h0-doc",
    "http://api.commonswarm.com/functions/v1/h0/agent-doc/abc",
    "ftp://commonswarm.com/agent/h0-doc",
  ]) {
    assert.throws(() => paste(documentUrl), /documentUrl must be HTTPS/, documentUrl);
  }
  for (const documentUrl of [
    "http://127.0.0.1:54321/functions/v1/h0/agent-doc/abc",
    "http://localhost:54321/functions/v1/h0/agent-doc/abc",
    "http://[::1]:54321/functions/v1/h0/agent-doc/abc",
  ]) {
    assert.doesNotThrow(() => paste(documentUrl), documentUrl);
  }
});

test("no H0 verb name is typed as a string literal in the paste source", () => {
  /* EVERY verb name, read from the table, matched as a whole word inside string and template
   * literals by AST. Known limit, stated: this catches a typed name, not one assembled at runtime
   * from pieces ("reg" + "ister") — that is fighting the test, not a plausible slip. */
  const source = readFileSync(new URL("../../src/h0/paste.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("src/h0/paste.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const typed: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const verb of H0_VERB_NAMES) {
        if (new RegExp(`\\b${verb}\\b`, "i").test(node.text)) typed.push(`${verb}: ${node.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.deepEqual(typed, []);
});
