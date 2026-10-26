import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("remove_member edge security seams remain reachable and fail closed", async () => {
  const source = await readFile(
    "supabase/functions/command/index.ts",
    "utf8",
  );
  assert.match(
    source,
    /"remove_member",\s*\n\s*"archive_workspace",\s*\n\s*"create_agent_principal"/,
  );
  assert.equal(
    (source.match(
      /"remove_member",\s*\n\s*"archive_workspace",\s*\n\s*"create_agent_principal"/g,
    ) ?? [])
      .length,
    2,
    "remove_member and archive_workspace must remain in both registries",
  );
  assert.match(
    source,
    /exactKeys\(cmd, \["kind", "user_id"\]\)/,
  );
  assert.match(source, /authClient\.auth\.getClaims\(credential\)/);
  assert.match(source, /newestInteractiveAmrSeconds\(claimsData\.claims\)/);
  assert.match(source, /commandNeedsFreshInteractiveAuth\(command\.kind\)/);
  assert.match(source, /freshInteractiveAuthRefusal\(/);
  assert.match(source, /reason: freshAuth\.error/);
  assert.match(source, /error: freshAuth\.error/);
  assert.match(source, /FROM swarm\.repositories/);
  assert.match(source, /landing_authority_user_id = \$\{wire\.user_id\}/);
  assert.doesNotMatch(
    source,
    /landingAuthorityChangeResolved:\s*\(\)\s*=>\s*true/,
  );
  assert.match(source, /event\.type === "MemberRemoved"/);
  assert.match(source, /updated\.length !== 1/);
  assert.match(
    source,
    /SET revoked_at = \$\{new Date\(payload\.revoked_at\)\}/,
  );
  assert.match(
    source,
    /event\.type === "MemberRemoved"[\s\S]*?UPDATE swarm\.memberships[\s\S]*?WHERE workspace_id = \$\{route\.workspaceId\}::uuid[\s\S]*?AND user_id = \$\{payload\.user_id\}::uuid[\s\S]*?AND revoked_at IS NULL[\s\S]*?RETURNING user_id/,
    "MemberRemoved projection must stay scoped to one live membership in the routed workspace",
  );
});

test("fresh-auth helper cannot be weakened to JWT iat or token refresh", async () => {
  const source = await readFile(
    "supabase/functions/command/fresh-auth.ts",
    "utf8",
  );
  assert.match(source, /FRESH_INTERACTIVE_AUTH_SECONDS = 300/);
  assert.match(source, /FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS = 5/);
  assert.match(
    source,
    /ageSeconds >= -FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS/,
  );
  assert.doesNotMatch(source, /token_refresh/);
  assert.doesNotMatch(source, /\.iat\b/);
  for (
    const method of [
      "oauth",
      "password",
      "otp",
      "totp",
      "sso/saml",
      "magiclink",
      "email/signup",
    ]
  ) {
    assert.match(source, new RegExp(`"${method}"`));
  }
  for (const alias of ["sso", "saml", "email", "signup"]) {
    assert.doesNotMatch(source, new RegExp(`"${alias}"`));
  }
});

function assertReplayBeforeFreshAuth(source: string): void {
  // Pin the live command path: step 7 is the idempotency lookup/replay, and
  // remove_member freshness must only run after that step completes. An earlier
  // existingRows in another route must not mask a reordered fresh-auth gate.
  const step7 = source.indexOf("await beforeStep(7);");
  assert.ok(step7 >= 0, "idempotency step 7 must remain reachable");
  const afterStep7 = source.indexOf("await afterStep(7);", step7);
  assert.ok(afterStep7 > step7, "idempotency step 7 must complete");
  const between = source.slice(step7, afterStep7);
  assert.match(
    between,
    /SELECT workspace_id, stream_id, request_hash, response\s+FROM swarm\.idempotency_keys/,
  );
  assert.match(
    between,
    // Mint/renew replays refresh owner policy fields; membership commands keep
    // their stored response. Both remain decided replays before fresh auth.
    /\? decided\(replayResult\(kind\s*===\s*"mint_agent_token" \|\| kind\s*===\s*RENEW_AGENT_TOKEN_KIND\s*\? await currentLocalPolicyResponse\(tx,\s*storedResponse\(existing\.response\),\s*localState\.localPlan\)\s*:\s*storedResponse\(existing\.response\), kind\)\)/,
  );
  assert.doesNotMatch(
    between,
    /commandNeedsFreshInteractiveAuth|freshInteractiveAuthRefusal|command\.kind === "remove_member"|command\.kind === "change_role"/,
    "fresh-auth must not run inside the idempotency step",
  );
  // Search from step 7, not from the gate: an earlier ledger insert must fail
  // even if another valid ledger insert remains after the refusal.
  const ledgerAt = source.indexOf("INSERT INTO swarm.idempotency_keys", afterStep7);
  assert.ok(ledgerAt > afterStep7, "the first later ledger write must remain reachable");
  const after = source.slice(afterStep7, ledgerAt);
  assert.match(
    after,
    /^await afterStep\(7\);\s*if \(commandNeedsFreshInteractiveAuth\(command\.kind\)\) \{\s*const serverTime = await tx/,
    "fresh-auth must immediately follow idempotency completion",
  );
  assert.match(after, /freshInteractiveAuthRefusal\(\s*command\.kind,/);
  assert.match(after, /if \(freshAuth !== null\)/);
  assert.match(after, /message: freshAuth\.message/);
  const gateAt = source.indexOf("freshInteractiveAuthRefusal(", afterStep7);
  assert.ok(gateAt > afterStep7 && gateAt < ledgerAt, "fresh auth must precede the first ledger write");
  const refusal = after.match(/if \(freshAuth !== null\) \{\s*await insertAudit\(tx, \{[\s\S]*?\}\);\s*return \{\s*status: 401,\s*body: \{\s*error: freshAuth\.error,\s*message: freshAuth\.message,\s*\},\s*\};\s*\}/);
  assert.ok(refusal, "the complete fresh-auth refusal and 401 return must precede the first ledger write");
  assert.doesNotMatch(
    after.slice(0, refusal.index! + refusal[0].length),
    /command\.kind === "remove_member"|command\.kind === "change_role"/,
    "the gate must follow the shared kind set, not one hard-coded kind",
  );
}

test("idempotency replay is resolved before remove_member fresh-auth refusal", async () => {
  const source = await readFile("supabase/functions/command/index.ts", "utf8");
  assertReplayBeforeFreshAuth(source);
});

test("fresh-auth ordering rejects a ledger write before the gate or its refusal return", async () => {
  const source = await readFile("supabase/functions/command/index.ts", "utf8");
  const insert = 'await tx`INSERT INTO swarm.idempotency_keys (command_id) VALUES (${commandId})`;';
  for (const [name, marker] of [
    ["before gate", "await afterStep(7);"],
    ["inside refusal before 401", "if (freshAuth !== null) {"],
  ]) {
    const mutated = source.replace(marker!, `${marker}\n${insert}`);
    assert.notEqual(mutated, source, `${name}: mutation must change the source`);
    assert.throws(() => assertReplayBeforeFreshAuth(mutated), assert.AssertionError, name);
  }
});

test("fresh-login refusal preserves pending remove_member command id", async () => {
  const source = await readFile("src/cloud/pending-command.ts", "utf8");
  const start = source.indexOf(
    "if (error instanceof ReauthenticationRequired) {",
  );
  assert.ok(start >= 0, "ReauthenticationRequired branch must remain reachable");
  const end = source.indexOf("}", start);
  const block = source.slice(start, end + 1);
  assert.match(block, /throw error;/);
  assert.doesNotMatch(
    block,
    /clearPendingCommand/,
    "ReauthenticationRequired must not clear the pending command id",
  );
  assert.match(
    source,
    /A fresh-login refusal is explicitly not ledgered/,
  );
});

test("change_role is registered beside remove_member and projects one membership", async () => {
  const source = await readFile(
    "supabase/functions/command/index.ts",
    "utf8",
  );
  for (const name of ["COMMAND_KINDS", "CONNECT_COMMAND_KINDS"]) {
    const match = source.match(
      new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`),
    );
    assert.ok(match, `${name} must exist`);
    assert.match(
      match[1],
      /"change_role"/,
      `${name} must accept change_role`,
    );
  }
  assert.match(
    source,
    /exactKeys\(cmd, \["kind", "user_id", "role"\]\)/,
  );
  assert.match(
    source,
    /wire\.kind === "remove_member" \|\| wire\.kind === "change_role"/,
  );
  assert.match(
    source,
    /event\.type === "MemberRoleChanged"[\s\S]*?UPDATE swarm\.memberships[\s\S]*?SET role = \$\{payload\.to_role\}[\s\S]*?WHERE workspace_id = \$\{route\.workspaceId\}::uuid[\s\S]*?AND user_id = \$\{payload\.user_id\}::uuid[\s\S]*?AND role = \$\{payload\.from_role\}[\s\S]*?AND revoked_at IS NULL[\s\S]*?RETURNING user_id/,
    "MemberRoleChanged projection must change exactly one live membership in the routed workspace",
  );
});

test("MemberRemoved event timestamp is the projection write timestamp", async () => {
  const commands = await readFile("src/protocol/workspace-commands.ts", "utf8");
  const edge = await readFile(
    "supabase/functions/command/index.ts",
    "utf8",
  );
  assert.match(
    commands,
    /case 'remove_member':[\s\S]*?env\(ctx, 'MemberRemoved', \{ user_id: cmd\.user_id, revoked_at: ctx\.now \}/,
  );
  assert.match(
    edge,
    /SET revoked_at = \$\{new Date\(payload\.revoked_at\)\}/,
  );
});
