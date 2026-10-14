import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const commandUrl = new URL("../supabase/functions/command/index.ts", import.meta.url);
const readUrl = new URL("../supabase/functions/read/index.ts", import.meta.url);
const authUrl = new URL("../supabase/functions/_shared/hosted-seat-auth.ts", import.meta.url);

test("hosted entry points accept opaque capabilities and contain no bearer ladder", async () => {
  const [command, read, auth] = await Promise.all([
    readFile(commandUrl, "utf8"), readFile(readUrl, "utf8"), readFile(authUrl, "utf8"),
  ]);
  const handler = (source: string, name: string): string => {
    const file = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
    const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body, `missing handler ${name}`);
    return declaration.getText(file);
  };
  assert.doesNotMatch(handler(command, "handleHostedCommand"), /Request|bearer|getUser|getClaims/);
  assert.doesNotMatch(handler(read, "handleHostedRead"), /Request|bearer|getUser|getClaims/);
  assert.match(auth, /const bindings = new WeakMap/);
  assert.match(auth, /bindings\.get\(capability\)/);
  assert.match(auth, /providerStatus\(binding\.providerGrantId\)/);
});

test("public hosted-only refusal precedes the GoTrue positive control", async () => {
  const command = await readFile(commandUrl, "utf8");
  const refusal = command.indexOf("if (publicHostedClaim || bodyClaimsHostedContext");
  const getUser = command.indexOf("authClient.auth.getUser(credential)");
  const getClaims = command.indexOf("authClient.auth.getClaims(credential)");
  assert.ok(refusal >= 0 && refusal < getUser && refusal < getClaims);
  assert.ok(getUser >= 0 && getClaims >= 0);
});

test("every internal operation revalidates durable authorization", async () => {
  const [command, read] = await Promise.all([
    readFile(commandUrl, "utf8"), readFile(readUrl, "utf8"),
  ]);
  assert.match(command, /await revalidateHostedGrantCommand\(tx, capability\)/);
  assert.match(command, /await revalidateHostedSeatCommand\(tx, hostedSeatCapability\)/);
  assert.match(read, /await revalidateHostedSeatRead\(tx, capability\)/);
  assert.match(command, /ledgerCredentialKind: "hosted_seat"/);
  assert.match(command, /'hosted_grant', \$\{grant\.grant_id\}/);
});

test("human hosted-management idempotency keeps UUID users in the text ledger namespace", async () => {
  const command = await readFile(commandUrl, "utf8");
  const start = command.indexOf("async function handleHostedManagement(");
  const end = command.indexOf("\nasync function claimHostedSeat(", start);
  assert.ok(start >= 0 && end > start);
  const management = command.slice(start, end);
  assert.match(management, /principal_id = \$\{auth\.actor\.user\}\s+AND command_id/);
  assert.match(management, /'user', \$\{auth\.actor\.user\}, \$\{body\.command_id\}/);
  assert.doesNotMatch(management, /principal_id = \$\{auth\.actor\.user\}::uuid/);
  assert.doesNotMatch(management, /'user', \$\{auth\.actor\.user\}::uuid/);
});
