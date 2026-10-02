// Real adapters/database; diagnostics select counts/statuses, never raw bodies.
import { AdminServerDiagnostics } from './admin-server-diagnostics.ts';
const config = JSON.parse(await Deno.readTextFile(Deno.args[0]));
for (const target of [config.local.API_URL, config.local.DB_URL]) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname)) {
    throw new Error("local stack required");
  }
}
Deno.env.set("SWARM_ENV", "test");
Deno.env.set("SWARM_DATABASE_URL", config.local.DB_URL);
Deno.env.set("SUPABASE_URL", config.local.API_URL);
Deno.env.set("SUPABASE_ANON_KEY", config.local.ANON_KEY);
Deno.env.set("SWARM_COMMAND_ALLOWED_ORIGINS", "https://commonswarm.com");
const signing = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...await crypto.subtle.exportKey("jwk", signing.publicKey),
  kid: "routine-local",
  alg: "ES256",
  use: "sig",
};
const upstream = globalThis.fetch;
globalThis.fetch = async (...args) =>
  String(args[0]) === "https://mcp.commonswarm.com/jwks"
    ? new Response(JSON.stringify({ keys: [jwk] }))
    : upstream(...args);
const id = () => crypto.randomUUID();
const b64 = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
const encode = (value) => b64(new TextEncoder().encode(JSON.stringify(value)));
let stage = "setup";
const diagnostics = new AdminServerDiagnostics();
function check(ok, label, observed) {
  stage = label;
  diagnostics.check(ok, observed);
}
const {
  db,
  handleRequest,
  handleAdminRuntimeCommand: adminRuntime,
  handleAdminWorkerRuntimeCommand: workerRuntime,
} = await import("../../supabase/functions/command/index.ts");
async function handleAdminRuntimeCommand(input, ...args) {
  const result = await adminRuntime(input, ...args);
  diagnostics.response(input.command.kind, result.status, result.body);
  return result;
}
async function handleAdminWorkerRuntimeCommand(input, ...args) {
  const result = await workerRuntime(input, ...args);
  diagnostics.response(input.command.kind, result.status, result.body);
  return result;
}
const { adminTransaction } = await import(
  "../../supabase/functions/command/admin-delegation.ts"
);
const policy = await import("../../supabase/functions/_shared/protocol.js");
const { handleRequest: read } = await import("../../supabase/functions/read/index.ts");
async function recovery(resource, workspace_id = null, before = null) {
  const response = await read(new Request("http://127.0.0.1/functions/v1/read", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ resource, workspace_id, before, limit: 1 }),
  }));
  const body = await response.json();
  diagnostics.response(resource, response.status, body);
  check(response.status === 200, "human routine recovery positive control");
  return body;
}
async function history(workspace = null) {
  const actions = [];
  let before = null;
  do {
    const page = await recovery("admin_history", workspace, before);
    actions.push(...page.actions);
    before = page.next_before;
  } while (before);
  return actions;
}
const wire = (command, command_id = id()) => ({
  command_id,
  stream: { kind: "account" },
  resource: policy.ADMIN_RESOURCE,
  command,
});
const human = {
  kind: "human",
  identity: {
    user_id: config.owner,
    session_binding: "a".repeat(64),
    interactive_at_seconds: Date.now() / 1000,
    csrf_verified: true,
  },
};
const transact = async (input, auth) => {
  const outcome = await db.begin(async (tx) => {
    await tx`SELECT set_config('role','swarm_command',true),set_config('search_path','swarm,pg_catalog',true)`;
    return adminTransaction(tx, input, auth);
  });
  diagnostics.response(input.command.kind, outcome.result.status, outcome.result.body);
  return outcome;
};
async function http(input, token) {
  const response = await handleRequest(
    new Request("http://127.0.0.1/functions/v1/command", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );
  const result = { status: response.status, body: await response.json() };
  diagnostics.response(input.command.kind, result.status, result.body);
  return result;
}
try {
  const scenario = Deno.args[1], now = Date.now(), connection = id();
  const manifest = {
    connection_id: connection,
    client_id: "lane-c-runtime",
    resource: policy.ADMIN_RESOURCE,
    mode: "granular",
    registry_version: policy.ADMIN_REGISTRY_VERSION,
    scope_names: [...policy.ADMIN_SCOPE_NAMES],
    workspace_selector: "selected",
    workspace_ids: [config.workspace],
    created_workspace_policy: { scope_names: ["seats:create", "seats:revoke"] },
    target_rules: {
      seat_ids: [],
      own_seats: true,
      grant_created_seats: true,
      recipient_user_ids: [config.owner, config.recipient],
      recipient_connection_ids: [connection],
      transports: ["local", "hosted_mcp"],
    },
    worker_scope_ceiling: ["post_signal"],
    role_ceiling: "member",
    renewal_limits: {
      ...policy.ADMIN_RENEWAL_CEILINGS,
      grant_kinds: ["timeboxed", "standing"],
      principal_ids: [],
      successors_per_worker: 2,
      successors_per_grant: 2,
    },
    issuance_limits: { ...policy.ADMIN_ISSUANCE_CEILINGS, workspaces: 1 },
    expires_at: now + 86400000,
    refresh_deadline: now + 86400000,
  };
  const prepared = (await transact(
    wire({
      kind: "prepare_admin_consent",
      manifest,
      full_account_selected: false,
    }),
    human,
  )).result;
  check(prepared.status === 200, "consent positive control");
  const grant = id();
  check(
    (await transact(
      wire({
        kind: "grant_admin_delegation",
        grant_id: grant,
        consent_receipt_id: prepared.body.consent_receipt_id,
        replaces_grant_id: null,
      }),
      human,
    )).result.status === 200,
    "activation positive control",
  );
  const jwtHead = encode({ alg: "ES256", typ: "at+jwt", kid: jwk.kid }),
    jwtBody = encode({
      iss: "https://mcp.commonswarm.com",
      aud: policy.ADMIN_RESOURCE,
      sub: config.owner,
      grant_id: grant,
      connection_id: connection,
      client_id: manifest.client_id,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 300,
    });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing.privateKey,
    new TextEncoder().encode(`${jwtHead}.${jwtBody}`),
  );
  const proof = `${jwtHead}.${jwtBody}.${b64(new Uint8Array(signature))}`;
  let admin;
  check(
    (await handleAdminRuntimeCommand(
          wire({
            kind: "issue_admin_credential",
            grant_id: grant,
            credential_lineage_id: id(),
          }),
          proof,
          async (value) => {
            admin = value;
          },
        )).status === 200 && admin,
    "admin runtime positive control",
  );
  const call = (command) =>
    http(
      wire({ grant_id: grant, workspace_id: config.workspace, ...command }),
      admin.access_credential,
    );
  const create = async (name = "Local seat") => {
    const result = await call({
      kind: "admin_create_seat",
      name,
      model: null,
      transport: "local",
    });
    check(result.status === 200, "seat creation positive control");
    return result.body.events.find((e) => e.type === "AdminSeatCreated").payload
      .principal_id;
  };
  const events = async () => {
    const [row] =
      await db`SELECT count(*)::integer AS n FROM swarm.admin_events WHERE owner_user_id=${config.owner}::uuid`;
    diagnostics.count("account_events", row.n);
    return row.n;
  };
  if (scenario === "workspace") {
    const workspace = id(),
      input = wire({
        kind: "admin_create_workspace",
        grant_id: grant,
        workspace_id: workspace,
        name: "Created by admin",
      });
    const results = await Promise.all([
      http(input, admin.access_credential),
      http(input, admin.access_credential),
    ]);
    check(results.every((r) => r.status === 200), "concurrent creation retry");
    const [row] =
      await db`SELECT count(*)::integer AS n FROM swarm.workspaces WHERE workspace_id=${workspace}::uuid`;
    check(row.n === 1, "single durable workspace", { workspace_count: row.n });
    const [stream] =
      await db`SELECT head_seq FROM swarm.streams WHERE workspace_id=${workspace}::uuid AND kind='workspace'`;
    check(Number(stream.head_seq) === 2, "reducer complete workspace event", { head_seq: Number(stream.head_seq) });
    const access = await recovery("admin_grants", workspace);
    check(access.grants.length === 1 && access.grants[0].grant_id === grant &&
      access.active.grant_count === 1, "granular created workspace has visible grant and indicator");
    check(!access.grants[0].workspace_ids.includes(workspace), "created association does not widen selected manifest");
    const cards = await history(workspace);
    check(cards.length === 1 && cards[0].action === "admin_create_workspace" &&
      cards[0].outcome === "accepted", "created workspace history shows minimal action card");
    const before = await events();
    check(
      (await http(input, admin.access_credential)).status === 200 &&
        await events() === before,
      "idempotent creation no charge or event",
    );
    check(
      (await http(
        { ...input, command: { ...input.command, name: "Changed" } },
        admin.access_credential,
      )).status === 409,
      "digest conflict",
    );
    check(
      (await http(
        wire({ ...input.command, workspace_id: id() }),
        admin.access_credential,
      )).status === 403,
      "lifetime workspace budget",
    );
    check(
      (await http(
        wire({
          kind: "admin_invite_member",
          grant_id: grant,
          workspace_id: workspace,
          recipient_user_id: config.recipient,
          role: "member",
          ttl_seconds: 3600,
        }),
        admin.access_credential,
      )).status === 403,
      "new workspace limited inheritance",
    );
    const narrowed = (await transact(wire({ kind: "prepare_admin_consent",
      manifest: { ...prepared.body.manifest, created_workspace_policy: { scope_names: [] } },
      full_account_selected: false }), human)).result;
    check(narrowed.status === 200, "created scope narrowing consent");
    check((await transact(wire({ kind: "narrow_admin_delegation", grant_id: grant,
      manifest: narrowed.body.manifest, manifest_digest: narrowed.body.manifest_digest,
      consent_receipt_id: narrowed.body.consent_receipt_id }), human)).result.status === 200,
      "created scope narrowing accepted");
    const narrowedAccess = await recovery("admin_grants", workspace);
    check(narrowedAccess.grants[0]?.grant_id === grant && narrowedAccess.active.grant_count === 0,
      "narrowed created scopes remove active indicator but retain grant history");
    await db`UPDATE swarm.memberships SET revoked_at=statement_timestamp() WHERE workspace_id=${workspace}::uuid AND user_id=${config.owner}::uuid`;
    await db`UPDATE swarm.workspaces SET archived_at=statement_timestamp() WHERE workspace_id=${workspace}::uuid`;
    check((await recovery("admin_grants", workspace)).grants[0]?.grant_id === grant &&
      (await history(workspace)).some(card => card.action === "admin_create_workspace"),
      "created workspace grantor recovery survives archive and membership loss");
  } else if (scenario === "invites") {
    const input = wire({
      kind: "admin_invite_member",
      grant_id: grant,
      workspace_id: config.workspace,
      recipient_user_id: config.recipient,
      role: "member",
      ttl_seconds: 3600,
    });
    check(
      (await http(input, admin.access_credential)).status === 200,
      "recipient invitation positive",
    );
    const before = await events();
    check(
      (await http(input, admin.access_credential)).status === 200 &&
        await events() === before,
      "invitation retry no new event",
    );
    const [invitation] =
      await db`SELECT * FROM swarm.admin_routine_invitations WHERE parent_admin_grant_id=${grant}::uuid`;
    check(
      invitation.recipient_user_id === config.recipient &&
        invitation.projection.delivery_state === "awaiting_authorization",
      "recipient-bound pending invitation", {
        recipient_matches: invitation.recipient_user_id === config.recipient,
        awaiting_authorization: invitation.projection.delivery_state === "awaiting_authorization",
      },
    );
    check(
      (await http(
        wire({ ...input.command, recipient_user_id: id() }),
        admin.access_credential,
      )).status === 403,
      "unapproved recipient refused",
    );
    check(
      (await http(
        wire({ ...input.command, role: "admin" }),
        admin.access_credential,
      )).status === 403,
      "protected role refused",
    );
    check(
      (await call({
        kind: "admin_revoke_invitation",
        invitation_id: invitation.invitation_id,
        reason_code: "cancelled",
      })).status === 200,
      "invitation revocation",
    );
    const agent = await call({
      kind: "admin_issue_agent_invitation",
      intended_owner_user_id: config.owner,
      recipient_connection_id: connection,
      transport: "local",
      seat_limit: 1,
      worker_scope_names: ["post_signal"],
      ttl_seconds: 3600,
    });
    check(agent.status === 200, "agent invitation positive");
    check(
      (await call({
        kind: "admin_revoke_agent_invitation",
        invitation_id: agent.body.events[0].payload.invitation_id,
        reason_code: "cancelled",
      })).status === 200,
      "agent invitation revocation",
    );
    const [state] =
      await db`SELECT projection FROM swarm.admin_accounts WHERE owner_user_id=${config.owner}::uuid`;
    check(
      state.projection.routine.spend[grant].invitations === 2,
      "revocation never refunds issuance", { invitation_spend: state.projection.routine.spend[grant].invitations },
    );
  } else {
    const principal = await create(),
      provision = wire({
        kind: "admin_provision_seat",
        grant_id: grant,
        workspace_id: config.workspace,
        principal_id: principal,
        recipient_connection_id: connection,
        worker_scope_names: ["post_signal"],
        bearer_seconds: 3600,
        horizon_seconds: 86400,
        max_successors: 2,
      });
    check(
      (await http(provision, admin.access_credential)).status === 403,
      "public provisioning cannot deliver bearer",
    );
    let worker;
    const result = await handleAdminWorkerRuntimeCommand(
      wire(provision.command),
      admin.access_credential,
      proof,
      async (value) => {
        worker = value;
      },
    );
    check(result.status === 200 && worker, "private recipient worker delivery");
    check(
      !JSON.stringify(result).includes(worker.credential),
      "worker secret excluded from result",
    );
    const auth = async (credential) => {
      const response = await read(new Request("http://127.0.0.1/functions/v1/read", {
        method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "members", workspace_id: config.workspace }),
      }));
      const body = await response.json();
      diagnostics.response("members", response.status, body);
      check([200, 401, 403].includes(response.status), "worker read reaches authentication boundary");
      if (response.status !== 200) return false;
      check(body.identity?.credential_valid === true && body.identity.principal_id === principal &&
        body.identity.owner_user_id === config.owner && body.identity.workspace_id === config.workspace,
        "worker read verifies recipient identity");
      return true;
    };
    check(await auth(worker.credential), "worker authenticates positive");
    if (scenario === "history") {
      check((await call({ kind: "admin_revoke_seat_credential", principal_id: principal,
        credential_id: worker.credential_id, reason_code: "human_requested" })).status === 200,
        "routine credential revoke accepted");
      check(!await auth(worker.credential), "revoked credential cannot authenticate");
      check((await call({ kind: "admin_revoke_seat", principal_id: principal,
        reason_code: "human_requested" })).status === 200, "routine seat revoke accepted");
    } else if (scenario === "renewal") {
      const input = wire({
        kind: "admin_renew_seat",
        grant_id: grant,
        workspace_id: config.workspace,
        principal_id: principal,
        predecessor_credential_id: worker.credential_id,
        recipient_connection_id: connection,
        worker_scope_names: ["post_signal"],
        bearer_seconds: 3600,
      });
      let successor;
      const renewed = await handleAdminWorkerRuntimeCommand(
        input,
        admin.access_credential,
        proof,
        async (value) => {
          successor = value;
        },
      );
      check(renewed.status === 200 && successor, "bounded renewal positive");
      const before = await events();
      let delivered = false;
      check(
        (await handleAdminWorkerRuntimeCommand(
              input,
              admin.access_credential,
              proof,
              async () => {
                delivered = true;
              },
            )).status === 200 && !delivered && await events() === before,
        "renewal retry no redelivery or spend",
      );
      const replacement = wire({
        kind: "admin_replace_undelivered_seat_credential",
        grant_id: grant,
        workspace_id: config.workspace,
        principal_id: principal,
        credential_id: successor.credential_id,
        recipient_connection_id: connection,
      });
      let replaced;
      check(
        (await handleAdminWorkerRuntimeCommand(
              replacement,
              admin.access_credential,
              proof,
              async (value) => {
                replaced = value;
              },
            )).status === 200 && replaced,
        "bounded undelivered replacement",
      );
      check(
        !await auth(successor.credential),
        "undelivered predecessor retired",
      );
      check(
        await auth(replaced.credential),
        "replacement retains usable lineage",
      );
      const [row] =
        await db`SELECT projection FROM swarm.admin_accounts WHERE owner_user_id=${config.owner}::uuid`;
      check(
        row.projection.routine.spend[grant].successors === 2,
        "replacement consumes grant spend",
      );
    } else if (scenario === "expiry") {
      const shortened = {
        ...prepared.body.manifest,
        expires_at: Date.now() + 2000,
      };
      const receipt = (await transact(
        wire({
          kind: "prepare_admin_consent",
          manifest: shortened,
          full_account_selected: false,
        }),
        human,
      )).result;
      check(receipt.status === 200, "child expiry consent");
      check(
        (await transact(
          wire({
            kind: "narrow_admin_delegation",
            grant_id: grant,
            manifest: receipt.body.manifest,
            manifest_digest: receipt.body.manifest_digest,
            consent_receipt_id: receipt.body.consent_receipt_id,
          }),
          human,
        )).result.status === 200,
        "child expiry narrowing",
      );
      check(
        await auth(worker.credential),
        "child remains live before deadline",
      );
      await new Promise((resolve) => setTimeout(resolve, 2200));
      check(
        !await auth(worker.credential),
        "expired parent fences child before lazy event",
      );
      const [row] =
        await db`SELECT state FROM swarm.admin_grants WHERE grant_id=${grant}::uuid`;
      check(row.state === "active", "expiry probe precedes materialization");
    } else if (scenario === "concurrency") {
      const [created, revoked] = await Promise.all([
        call({
          kind: "admin_create_seat",
          name: "Competing seat",
          model: null,
          transport: "local",
        }),
        transact(
          wire({
            kind: "revoke_admin_delegation",
            grant_id: grant,
            reason_code: "human_revoked",
          }),
          human,
        ),
      ]);
      check(revoked.result.status === 200, "competing human revoke succeeds");
      check(
        created.status === 200 || created.status === 403,
        "competing operation accepted or refused",
      );
      const [terminal] =
        await db`SELECT seq FROM swarm.admin_events WHERE owner_user_id=${config.owner}::uuid AND event->>'type'='AdminDelegationRevoked' ORDER BY seq DESC LIMIT 1`;
      if (created.status === 200) {
        check(
          created.body.events.find((e) => e.type === "AdminSeatCreated").seq <
            Number(terminal.seq),
          "accepted action precedes revoke commit",
        );
      }
      check(
        !await auth(worker.credential),
        "concurrent revoke leaves child stopped",
      );
      check(
        (await call({
          kind: "admin_create_seat",
          name: "After revoke",
          model: null,
          transport: "local",
        })).status === 403,
        "committed revoke refuses later work",
      );
    } else if (scenario === "parent") {
      check(
        (await transact(
          wire({
            kind: "revoke_admin_delegation",
            grant_id: grant,
            reason_code: "human_revoked",
          }),
          human,
        )).result.status === 200,
        "human parent revoke",
      );
      check(
        !await auth(worker.credential),
        "parent revocation fences child authentication",
      );
      check(
        (await call({
          kind: "admin_create_seat",
          name: "Denied",
          model: null,
          transport: "local",
        })).status === 403,
        "parent revocation fences new mutations",
      );
    } else if (scenario === "rollback") {
      const input = wire({
          kind: "admin_create_seat",
          grant_id: grant,
          workspace_id: config.workspace,
          name: "Rolled back",
          model: null,
          transport: "local",
        }),
        before = await events();
      let reached = false;
      await db.begin(async (tx) => {
        await tx`SELECT set_config('role','swarm_command',true)`;
        check(
          (await adminTransaction(tx, input, {
            kind: "access",
            credential: admin.access_credential,
          })).result.status === 200,
          "rollback reaches write",
        );
        reached = true;
        throw new Error("rollback");
      }).catch(() => {});
      check(reached && await events() === before, "rollback no account event");
      const [row] =
        await db`SELECT count(*)::integer AS n FROM swarm.agent_principals WHERE workspace_id=${config.workspace}::uuid AND name='Rolled back'`;
      check(row.n === 0, "rollback no principal", { principal_count: row.n });
    } else if (scenario === "rights") {
      await db`UPDATE swarm.memberships SET role='member' WHERE workspace_id=${config.workspace}::uuid AND user_id=${config.owner}::uuid`;
      check(!await auth(worker.credential), "role loss fences descendant");
      check(
        (await call({
          kind: "admin_revoke_seat",
          principal_id: principal,
          reason_code: "cancelled",
        })).status === 403,
        "role loss fences delegated mutation",
      );
      check(
        (await transact(
          wire({
            kind: "revoke_admin_delegation",
            grant_id: grant,
            reason_code: "human_revoked",
          }),
          human,
        )).result.status === 200,
        "human recovery after rights loss",
      );
    }
  }
  const routineHistory = await db.begin(async tx => {
    await tx`SELECT set_config('role','swarm_command',true)`;
    return await tx`SELECT event_id,type FROM swarm.admin_routine_workspace_events WHERE workspace_id=${config.workspace}::uuid`;
  });
  const expectedHistory = await db`SELECT event_id FROM swarm.events WHERE workspace_id=${config.workspace}::uuid AND grant_id IS NOT NULL AND type=ANY(${policy.ADMIN_ROUTINE_EVENT_TYPES})`;
  check(routineHistory.length === expectedHistory.length &&
    routineHistory.every(row => policy.ADMIN_ROUTINE_EVENT_TYPES.includes(row.type)) &&
    expectedHistory.every(row => routineHistory.some(actual => actual.event_id === row.event_id)),
    "command history contains every delegated routine event and excludes ordinary events", {
      history_count: routineHistory.length, expected_count: expectedHistory.length,
    });
  // Reconcile pages against durable attempts for each real routine scenario.
  // Raw domain events contain recipient/credential fields and must not be cards.
  const cards = await history();
  const stored = await db`SELECT event_id, event FROM swarm.admin_events WHERE owner_user_id=${config.owner}::uuid ORDER BY seq`;
  const audits = stored.filter(row => row.event.type === "AdminActionRecorded");
  check(cards.length === audits.length && new Set(cards.map(card => card.event_id)).size === audits.length &&
    audits.every(row => cards.some(card => card.event_id === row.event_id)), "routine audit pagination has no gaps or duplicates", {
      card_count: cards.length, audit_count: audits.length, distinct_count: new Set(cards.map(card => card.event_id)).size,
    });
  const byId = new Map(stored.map(row => [row.event_id, row.event]));
  for (const card of cards) {
    const event = byId.get(card.event_id);
    check(card.action === event.payload.action && card.outcome === event.payload.outcome &&
      card.workspace_id === event.payload.workspace_id && card.actor_user === event.actor_user &&
      card.grant_id === event.grant_id && card.admin_identity_id === event.admin_identity_id &&
      JSON.stringify(card.related_event_ids) === JSON.stringify(event.payload.related_event_ids),
      "routine history retains action outcome actor and linked domain event IDs", {
        action_matches: card.action === event.payload.action,
        outcome_matches: card.outcome === event.payload.outcome,
        workspace_matches: card.workspace_id === event.payload.workspace_id,
        actor_matches: card.actor_user === event.actor_user,
        grant_matches: card.grant_id === event.grant_id,
        admin_identity_matches: card.admin_identity_id === event.admin_identity_id,
        related_ids_match: JSON.stringify(card.related_event_ids) === JSON.stringify(event.payload.related_event_ids),
        related_id_count: card.related_event_ids.length,
      });
  }
  check(stored.filter(row => policy.ADMIN_ROUTINE_EVENT_TYPES.includes(row.event.type)).every(row =>
    cards.some(card => card.related_event_ids.includes(row.event_id))), "all routine domain events have a visible linked card");
  check(!/request_digest|manifest_digest|policy_check|recipient_user_id|recipient_connection_id|worker_scope_names|access_hash|refresh_hash/.test(JSON.stringify(cards)),
    "routine cards exclude private payload fields");
  if (scenario === "history") {
    check(cards.some(card => card.action === "admin_revoke_seat" && card.outcome === "accepted") &&
      cards.some(card => card.action === "admin_revoke_seat_credential" && card.outcome === "accepted"),
      "human history shows accepted seat and credential revoke");
  }
  console.log("ADMIN_ROUTINE_SERVER_OK");
} catch (error) {
  console.log("ADMIN_ROUTINE_SERVER_FAILED " + stage + " " + JSON.stringify(diagnostics.failure(error)));
  Deno.exitCode = 1;
} finally {
  await db.end();
}
