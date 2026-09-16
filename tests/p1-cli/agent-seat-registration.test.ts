/** Pure and structural controls for H0 seat registration. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AGENT_TOKEN_MAX_TTL_MS,
  decideWorkspace,
  H0_SEAT_TOKEN_TTL_MS,
  type DecideWorkspaceCtx,
  type WorkspaceCommand,
} from "../../src/protocol/workspace-commands.js";
import type { WorkspaceState } from "../../src/protocol/workspace-events.js";

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const OWNER = "00000000-0000-4000-8000-000000000001";
const REGISTRAR = "00000000-0000-4000-8000-000000000002";
const REGISTRAR_RUN = "00000000-0000-4000-8000-000000000003";
const WORKSPACE = "00000000-0000-4000-8000-000000000004";
const STREAM = "00000000-0000-4000-8000-000000000005";
const SCOPES = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
  "post_signal",
];

function state(): WorkspaceState {
  return {
    workspace: {
      workspace_id: WORKSPACE,
      name: "H0",
      created_by: OWNER,
      created_at: 1,
      archived_at: null,
    },
    members: {
      [OWNER]: {
        user_id: OWNER,
        role: "owner",
        invited_by: null,
        joined_at: 1,
        revoked_at: null,
      },
    },
    invitations: {},
    principals: {
      "00000000-0000-4000-8000-000000000099": {
        principal_id: "00000000-0000-4000-8000-000000000099",
        owner_user_id: OWNER,
        name: "duplicate label",
        model: null,
        created_at: 1,
        revoked_at: null,
      },
    },
    tokens: {},
    owners_count: 1,
  };
}

function context(
  kind: "human" | "agent" | "join",
  memberRole: "owner" | null = "owner",
): DecideWorkspaceCtx {
  let seq = 0;
  return {
    now: 10_000,
    actor: {
      user: OWNER,
      agent_principal: kind === "join" ? REGISTRAR : null,
      run: kind === "join" ? REGISTRAR_RUN : null,
    },
    credential_kind: kind,
    presenting_token_id: null,
    command_id: "register-command",
    workspace_id: WORKSPACE,
    stream_id: STREAM,
    operatorAllowed: () => false,
    role: () => memberRole,
    inviteeAlreadyMember: () => false,
    identityVerified: () => true,
    humanRights: () => SCOPES,
    landingAuthorityChangeResolved: () => true,
    nextSeq: () => ++seq,
    nextEventId: () => `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  };
}

function registerCommand(): WorkspaceCommand {
  return {
    kind: "register_agent_seat",
    attempt_id: "00000000-0000-4000-8000-000000000010",
    principal_id: "00000000-0000-4000-8000-000000000011",
    run_id: "00000000-0000-4000-8000-000000000012",
    token_id: "00000000-0000-4000-8000-000000000013",
    name: "duplicate label",
    scopes: [...SCOPES],
    ttl_ms: H0_SEAT_TOKEN_TTL_MS,
  };
}

test("the reducer admits only a join credential for register_agent_seat", () => {
  const accepted = decideWorkspace(state(), registerCommand(), context("join"));
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.deepEqual(
      accepted.events.map((event) => event.type),
      ["AgentPrincipalCreated", "AgentTokenMinted"],
    );
    for (const event of accepted.events) {
      assert.equal(event.actor_user, OWNER);
      assert.equal(event.actor_agent_principal, REGISTRAR);
      assert.equal(event.actor_run, REGISTRAR_RUN);
    }
    assert.equal(
      (accepted.events[0].payload as { name: string }).name,
      "duplicate label",
      "duplicate display labels are deliberate",
    );
  }

  for (const kind of ["human", "agent"] as const) {
    const refused = decideWorkspace(state(), registerCommand(), context(kind));
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.class, "authz");
      assert.equal(refused.reason, "credential_kind_forbidden");
    }
  }
});

test("the reducer refuses registration when the credential owner is not a live member", () => {
  const refused = decideWorkspace(state(), registerCommand(), context("join", null));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.class, "authz");
    assert.equal(refused.reason, "bad_state");
    assert.match(refused.detail, /not a current workspace member/);
    assert.deepEqual(refused.events, []);
  }
});

test("a join credential is refused for every non-registration reducer kind", () => {
  const other: WorkspaceCommand = {
    /* submit_feedback is deliberately open to both ordinary credential kinds,
     * so the join exact-kind gate is the only reason this command is refused. */
    kind: "submit_feedback",
    feedback_id: "00000000-0000-4000-8000-000000000014",
    category: "bug",
    body: "other command",
    context: null,
  };
  const refused = decideWorkspace(state(), other, context("join"));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.class, "authz");
    assert.equal(refused.reason, "credential_kind_forbidden");
    assert.deepEqual(refused.events, []);
  }
});

test("registration uses the one principal-ceiling helper after the credential row lock", () => {
  const source = withoutComments(readFileSync(
    new URL("../../supabase/functions/command/index.ts", import.meta.url),
    "utf8",
  ));
  const lockFunction = source.indexOf("async function lockJoinCredential(");
  const rowLock = source.indexOf("FOR UPDATE OF c", lockFunction);
  const register = source.indexOf("async function registerAgentSeat(");
  const credentialLock = source.indexOf("await lockJoinCredential(tx, credentialHash)", register);
  const streamLock = source.indexOf("await lockRegistrationStream(tx, route)", credentialLock);
  const membershipLock = source.indexOf(
    "await lockJoinCredentialOwnerMembership(tx, credential)",
    streamLock,
  );
  const membershipFunction = source.indexOf("async function lockJoinCredentialOwnerMembership(");
  const membershipFunctionEnd = source.indexOf("\n}\n", membershipFunction);
  const membershipFunctionSource = source.slice(membershipFunction, membershipFunctionEnd);
  const attempt = source.indexOf("FROM swarm.agent_join_attempts AS a", register);
  const capCheck = source.indexOf("credential.seats_used >= credential.seat_cap", attempt);
  const ceiling = source.indexOf(
    "lockAndCountLivePrincipals(tx, credential.workspace_id)",
    capCheck,
  );
  const device = source.indexOf("INSERT INTO swarm.devices", ceiling);
  const spend = source.indexOf("SET seats_used = seats_used + 1", device);
  const marker = source.indexOf("INSERT INTO swarm.agent_join_attempts", spend);
  assert.ok(lockFunction > 0 && rowLock > lockFunction);
  assert.ok(register > rowLock);
  assert.ok(credentialLock > register, "registration must lock its credential first");
  assert.ok(streamLock > credentialLock, "the stream lock must follow the credential lock");
  assert.ok(membershipLock > streamLock, "membership is checked after the stream lock");
  assert.ok(
    membershipFunction > rowLock && membershipFunctionSource.includes("FOR SHARE"),
    "the owner membership row must be held FOR SHARE",
  );
  assert.ok(attempt > register, "retry lookup must happen before new-seat checks");
  assert.ok(capCheck > attempt, "seat cap must be checked only for a new attempt");
  assert.ok(ceiling > capCheck, "principal ceiling must follow the seat-cap check");
  assert.ok(device > ceiling, "no seat row may be written before the shared ceiling helper");
  assert.ok(spend > device, "the seat is spent after the complete token projection is written");
  assert.ok(marker > spend, "the H0 seat marker follows the seat spend in the same fold");
  assert.equal(
    source.match(/await lockRegistrationStream\(tx, route\)/g)?.length,
    1,
    "one registration transaction must read one stream frame",
  );
});

test("the attempt relation is private, immutable, and pins the full seat identity", () => {
  const sql = withoutComments(readFileSync(
    new URL(
      "../../supabase/migrations/20260916000002_agent_join_attempts.sql",
      import.meta.url,
    ),
    "utf8",
  ));
  assert.match(sql, /PRIMARY KEY \(join_credential_id, attempt_id\)/);
  assert.match(sql, /UNIQUE \(principal_id\)/);
  assert.match(sql, /FOREIGN KEY \(token_id, principal_id, run_id\)/);
  assert.match(sql, /CREATE TRIGGER agent_join_attempts_guard/);
  assert.match(
    sql,
    /IF TG_OP = 'DELETE' THEN\s+RAISE EXCEPTION 'SWARM_AGENT_JOIN_ATTEMPT_IMMUTABLE'\s+USING ERRCODE = '55000';\s+END IF;/,
  );
  assert.match(
    sql,
    /IF NEW\.join_credential_id[\s\S]*?THEN\s+RAISE EXCEPTION 'SWARM_AGENT_JOIN_ATTEMPT_IMMUTABLE'/,
  );
  assert.match(sql, /RAISE EXCEPTION 'SWARM_AGENT_JOIN_ATTEMPT_TOKEN_NOT_REPLACEABLE'/);
  assert.match(
    sql,
    /REVOKE ALL ON TABLE swarm\.agent_join_attempts\s+FROM PUBLIC, anon, authenticated/,
  );
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON swarm\.agent_join_attempts TO swarm_command/);
});

test("the H0 seat token lifetime equals the token ceiling and comes from the protocol bundle", () => {
  const source = readFileSync(
    new URL("../../supabase/functions/command/index.ts", import.meta.url),
    "utf8",
  );
  assert.equal(H0_SEAT_TOKEN_TTL_MS, AGENT_TOKEN_MAX_TTL_MS);
  assert.match(source, /import \{[\s\S]*?H0_SEAT_TOKEN_TTL_MS,[\s\S]*?\} from "\.\.\/_shared\/protocol\.js";/);
  assert.doesNotMatch(source, /(?:const|let|var) H0_SEAT_TOKEN_TTL_MS\b/);
  assert.match(source, /INSERT INTO swarm\.renewal_grants/);
});

test("H0 registration and renewal share one horizon and one stream frame", () => {
  const edge = withoutComments(readFileSync(
    new URL("../../supabase/functions/command/index.ts", import.meta.url),
    "utf8",
  ));
  const protocol = withoutComments(readFileSync(
    new URL("../../src/protocol/workspace-commands.ts", import.meta.url),
    "utf8",
  ));
  const registrationStart = edge.indexOf("async function registerAgentSeat(");
  const registrationSource = edge.slice(registrationStart);
  const grantInsertStart = registrationSource.indexOf("INSERT INTO swarm.renewal_grants");
  const grantInsertEnd = registrationSource.indexOf("await tx", grantInsertStart);
  const grantInsert = registrationSource.slice(grantInsertStart, grantInsertEnd);
  assert.match(
    registrationSource,
    /const expiresAt = new Date\(frame\.now \+ H0_SEAT_TOKEN_TTL_MS\);/,
  );
  assert.match(
    grantInsert,
    /\$\{expiresAt\}/,
    "the initial token expiry must be the grant horizon value",
  );
  assert.doesNotMatch(grantInsert, /RENEWAL_HORIZON_DEFAULT_MS/);
  assert.match(
    edge,
    /const expiresAt = new Date\(Math\.min\([\s\S]*?frame\.now \+ H0_SEAT_TOKEN_TTL_MS,[\s\S]*?existing\.grant_horizon_expires_at\.getTime\(\)/,
    "replacement expiry must be capped by the existing grant horizon",
  );
  assert.match(
    protocol,
    /const expires_at = grant\.kind === 'standing'[\s\S]*?: Math\.min\([\s\S]*?grant\.horizon_expires_at!/,
    "timeboxed renewal successors must be capped by their grant horizon",
  );
  assert.doesNotMatch(protocol, /Nothing renews or re-registers an H0 seat/);
});
