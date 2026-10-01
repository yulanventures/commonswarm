// Real adapters and database; stdout is restricted to fixed assertion labels.
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
function check(ok, label) {
  stage = label;
  if (!ok) throw new Error("assertion");
}
const {
  db,
  handleRequest,
  handleAdminRuntimeCommand,
  handleAdminWorkerRuntimeCommand,
} = await import("../../supabase/functions/command/index.ts");
const { adminTransaction } = await import(
  "../../supabase/functions/command/admin-delegation.ts"
);
const policy = await import("../../supabase/functions/_shared/protocol.js");
const { loadAgentCredential } = await import(
  "../../supabase/functions/_shared/agent-auth.ts"
);
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
const transact = (input, auth) =>
  db.begin(async (tx) => {
    await tx`SELECT set_config('role','swarm_command',true),set_config('search_path','swarm,pg_catalog',true)`;
    return adminTransaction(tx, input, auth);
  });
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
  return { status: response.status, body: await response.json() };
}
async function hash(secret) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
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
    check(row.n === 1, "single durable workspace");
    const [stream] =
      await db`SELECT head_seq FROM swarm.streams WHERE workspace_id=${workspace}::uuid AND kind='workspace'`;
    check(Number(stream.head_seq) === 2, "reducer complete workspace event");
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
      "recipient-bound pending invitation",
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
      "revocation never refunds issuance",
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
    const auth = async (credential) =>
      db.begin(async (tx) => {
        await tx`SELECT set_config('role','swarm_command',true)`;
        return loadAgentCredential(tx, await hash(credential));
      });
    check(await auth(worker.credential), "worker authenticates positive");
    if (scenario === "renewal") {
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
      check(row.n === 0, "rollback no principal");
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
  console.log("ADMIN_ROUTINE_SERVER_OK");
} catch {
  console.log("ADMIN_ROUTINE_SERVER_FAILED " + stage);
  Deno.exitCode = 1;
} finally {
  await db.end();
}
