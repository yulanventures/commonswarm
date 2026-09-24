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
  assert.throws(() => paste(documentUrl), /must not contain 12 or more consecutive characters of the join credential/, documentUrl);

test("the secret body fixture is exactly 43 base64url characters", () => {
  assert.match(SECRET_BODY, /^[A-Za-z0-9_-]{43}$/);
});

test("the whole H0 agent paste matches the reviewed golden text", { timeout: 10000 }, () => {
  /* READ BEFORE UPDATING: this is what a human copies. A golden pins whatever the paste says, errors
   * included, so diff it against the register endpoint's contract, not only against your intent. */
  assert.equal(
    paste(DOCUMENT_URL),
    [
      "This non-MCP handoff sends a join credential through the model. For MCP hosts, a person can use cswarm mcp code and cswarm mcp connect instead.",
      "First fetch this agent document; reading it requires no login or key:",
      DOCUMENT_URL,
      "Then call register once as that document describes, using this single-purpose join credential:",
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
  const urlIntro = lines.findIndex((line) => line.startsWith("First fetch this agent document"));
  assert.equal(lines[urlIntro + 1], DOCUMENT_URL, "the URL directly follows the fetch sentence");
  /* ONLY ONE LINE ends in "credential:". An arm noted the fetch line once did too, so an agent
   * taking "the line after `credential:`" would have picked the URL first. */
  assert.deepEqual(
    lines.map((line, index) => [line, index] as const).filter(([line]) => /credential:$/i.test(line)).map(([, i]) => i),
    [credentialIntro],
  );
});

test("the returned URL is the canonical form that was validated, not the raw input", { timeout: 10000 }, () => {
  const lines = paste("https://CommonSwarm.com").split("\n");
  const urlIntro = lines.findIndex(line => line.startsWith("First fetch this agent document"));
  assert.equal(lines[urlIntro + 1], "https://commonswarm.com/");
});

test("a document URL with a query string is refused", () => {
  assert.throws(() => paste(`${DOCUMENT_URL}?x=1`), /must not contain a query string/);
  /* A bare `?` parses to an EMPTY search, so only the raw check catches it. */
  assert.throws(() => paste(`${DOCUMENT_URL}?`), /must not contain a query string/);
});

test("a document URL with a fragment is refused", () => {
  assert.throws(() => paste(`${DOCUMENT_URL}#frag`), /must not contain a fragment/);
  /* A bare `#` parses to an EMPTY hash, so only the raw check catches it. */
  assert.throws(() => paste(`${DOCUMENT_URL}#`), /must not contain a fragment/);
});

test("a document URL carrying userinfo is refused", () => {
  /* Shows commonswarm.com to a human and fetches attacker.example. */
  assert.throws(() => paste("https://commonswarm.com@attacker.example/agent/h0-doc"), /must not contain userinfo/);
  assert.throws(() => paste("https://user:pass@commonswarm.com/agent/h0-doc"), /must not contain userinfo/);
  /* Password-only: the username is EMPTY, so a username-only check would pass it. */
  assert.throws(() => paste("https://:pass@commonswarm.com/agent/h0-doc"), /must not contain userinfo/);
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
  /* TAB and NEWLINE splits into pieces SHORTER than the window: the URL parser strips tab, CR and
   * LF, so the secret is contiguous ONLY in the parsed href. An arm showed dropping href from the
   * haystack left every case green. The first version of these two lines split the body into two
   * 21-character halves — each half already matched a 12-character window in the RAW input, so they
   * passed without href and proved nothing about it. Six-character chunks can only match once the
   * parser joins them. */
  const chunked = (separator: string) => SECRET_BODY.match(/.{1,6}/g)!.join(separator);
  refusesSecret(`${DOCUMENT_URL}/${chunked("\t")}`);
  refusesSecret(`${DOCUMENT_URL}/${chunked("\n")}`);
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

test("four or more nested percent-encoding layers are refused; three still decode", () => {
  /* The first version returned a still-encoded value after its last decode round, which hid a secret
   * behind enough layers. An arm found it. The boundary is MEASURED, not reasoned: layers 1-3 decode
   * to a stable value inside the round limit, layer 4 does not. `%41` is a VALID escape for "A";
   * an earlier draft of this test wrapped an INVALID escape and passed by hitting the
   * malformed-escape refusal instead of the one it names. */
  const layered = (layers: number) => {
    let segment = "%41";
    for (let i = 1; i < layers; i++) segment = segment.replace("%", "%25");
    return `${DOCUMENT_URL}/${segment}`;
  };
  assert.doesNotThrow(() => paste(layered(3)), "three layers must decode normally");
  for (const layers of [4, 6]) {
    assert.throws(() => paste(layered(layers)), /excessively nested percent-encoding/, `${layers} layers`);
  }
});
