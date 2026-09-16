import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { h0AgentPaste } from "../../src/h0/paste.js";
import { H0_VERB_NAMES } from "../../src/h0/verbs.js";

const JOIN_CREDENTIAL = `swm_join_${"A".repeat(43)}`;
const DOCUMENT_URL = "https://commonswarm.com/agent/h0-doc";

test("the whole H0 agent paste matches the reviewed golden text", () => {
  assert.equal(
    h0AgentPaste({ joinCredential: JOIN_CREDENTIAL, documentUrl: DOCUMENT_URL }),
    [
      "Fetch the agent document at the URL below.",
      `The single-purpose join credential is ${JOIN_CREDENTIAL}; use it only to register.`,
      DOCUMENT_URL,
    ].join("\n"),
  );
});

test("a document URL with a query string is refused", () => {
  assert.throws(
    () => h0AgentPaste({ joinCredential: JOIN_CREDENTIAL, documentUrl: `${DOCUMENT_URL}?x=1` }),
    /documentUrl must not contain a query string/,
  );
});

test("a document URL with a fragment is refused", () => {
  assert.throws(
    () => h0AgentPaste({ joinCredential: JOIN_CREDENTIAL, documentUrl: `${DOCUMENT_URL}#frag` }),
    /documentUrl must not contain a fragment/,
  );
});

test("a document URL containing the join credential is refused", () => {
  assert.throws(
    () => h0AgentPaste({
      joinCredential: JOIN_CREDENTIAL,
      documentUrl: `${DOCUMENT_URL}/${JOIN_CREDENTIAL}`,
    }),
    /documentUrl must not contain the join credential/,
  );
});

test("a malformed join credential is refused", () => {
  for (const joinCredential of [
    `swm_agt_${"A".repeat(43)}`,
    `swm_join_${"A".repeat(42)}`,
    `swm_join_${"A".repeat(44)}`,
    `swm_join_${"A".repeat(42)}.`,
  ]) {
    assert.throws(
      () => h0AgentPaste({ joinCredential, documentUrl: DOCUMENT_URL }),
      /joinCredential must be swm_join_ followed by 43 base64url characters/,
    );
  }
});

test("the pre-auth verb is not a string literal in the paste source", () => {
  const source = readFileSync(new URL("../../src/h0/paste.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile(
    "src/h0/paste.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const typedVerbLiterals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      /* EVERY H0 verb name, read from the table — not the typed word "register". The first
       * version searched for today's name only, so a renamed verb typed into this source would
       * have passed a test whose whole job is to stop typed verb names. */
      for (const verb of H0_VERB_NAMES) {
        if (new RegExp(`\\b${verb}\\b`).test(node.text)) typedVerbLiterals.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.deepEqual(typedVerbLiterals, []);
});

test("a plaintext document URL is refused unless the host is loopback", () => {
  /* The agent reads the register endpoint from this document, so plaintext here means the join
   * credential is POSTed in cleartext. */
  for (const documentUrl of [
    "http://commonswarm.com/agent/h0-doc",
    "http://api.commonswarm.com/functions/v1/h0/agent-doc/abc",
    "ftp://commonswarm.com/agent/h0-doc",
  ]) {
    assert.throws(
      () => h0AgentPaste({ joinCredential: JOIN_CREDENTIAL, documentUrl }),
      /documentUrl must be HTTPS/,
      documentUrl,
    );
  }
  for (const documentUrl of [
    "http://127.0.0.1:54321/functions/v1/h0/agent-doc/abc",
    "http://localhost:54321/functions/v1/h0/agent-doc/abc",
  ]) {
    assert.doesNotThrow(() => h0AgentPaste({ joinCredential: JOIN_CREDENTIAL, documentUrl }), documentUrl);
  }
});

test("a document URL carrying only the secret BODY of the credential is refused", () => {
  /* The prefix is public; the 43 characters are the secret. Use a credential whose body is
   * distinguishable from the prefix so the check cannot pass by matching the prefix alone. */
  const credential = `swm_join_${"Zq9-".repeat(10)}Zq9`;
  const body = credential.slice("swm_join_".length);
  assert.throws(
    () => h0AgentPaste({ joinCredential: credential, documentUrl: `${DOCUMENT_URL}/${body}` }),
    /documentUrl must not contain the join credential/,
  );
});
