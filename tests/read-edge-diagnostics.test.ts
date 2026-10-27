import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  extractSafeDiagnostics,
  firstForbiddenDiagnosticKey,
  FORBIDDEN_DIAGNOSTIC_KEYS,
  formatReadFailureLog,
  isRetryableErrorCode,
  newRequestId,
  publicReadErrorBody,
  type SafeReadDiagnostics,
} from "../supabase/functions/read/diagnostics.js";

const SECRET_TOKEN = "swm_agt_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const SECRET_HASH_HEX =
  "deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRET_QUERY =
  "SELECT * FROM swarm_read.signals WHERE about = 'SECRET_ABOUT_VALUE'";
const SECRET_PARAM = "SECRET_QUERY_VALUE_42";

/** Build a postgres.js-shaped PostgresError without importing Deno-only modules. */
function fakePostgresError(fields: {
  message?: string;
  code?: string;
  severity?: string;
  routine?: string;
  constraint_name?: string;
  detail?: string;
  hint?: string;
  query?: string;
  parameters?: unknown[];
}): Error {
  const error = new Error(
    fields.message ??
      `duplicate key value violates unique constraint "${fields.constraint_name ?? "x"}"`,
  );
  error.name = "PostgresError";
  Object.assign(error, {
    severity: fields.severity ?? "ERROR",
    code: fields.code ?? "23505",
    routine: fields.routine ?? "_bt_check_unique",
    constraint_name: fields.constraint_name ?? "signals_pkey",
    detail: fields.detail ?? `Key (about)=(${SECRET_PARAM}) already exists.`,
    hint: fields.hint ?? "Check the token in Authorization.",
    // Non-enumerable on real postgres.js errors; set both ways to prove we never copy them.
    query: fields.query ?? SECRET_QUERY,
    parameters: fields.parameters ?? [SECRET_PARAM, SECRET_TOKEN],
  });
  Object.defineProperty(error, "query", {
    value: fields.query ?? SECRET_QUERY,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(error, "parameters", {
    value: fields.parameters ?? [SECRET_PARAM, SECRET_TOKEN],
    enumerable: false,
    configurable: true,
  });
  return error;
}

function fakeConnectionError(code: string): Error {
  const error = Object.assign(
    new Error(`write ${code} 127.0.0.1:5432`),
    {
      code,
      errno: code,
      address: "127.0.0.1",
      port: 5432,
    },
  );
  return error;
}

function assertNoSecrets(text: string): void {
  assert.equal(text.includes(SECRET_TOKEN), false, "must not leak agent token");
  assert.equal(text.includes(SECRET_HASH_HEX), false, "must not leak hash");
  assert.equal(text.includes(SECRET_QUERY), false, "must not leak SQL query");
  assert.equal(text.includes(SECRET_PARAM), false, "must not leak query values");
  assert.equal(
    text.toLowerCase().includes("authorization"),
    false,
    "must not mention authorization",
  );
  assert.equal(text.includes("Bearer "), false, "must not leak bearer header");
}

test("newRequestId returns a UUID-shaped correlation id", () => {
  const id = newRequestId();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.notEqual(newRequestId(), id);
});

test("extractSafeDiagnostics keeps Postgres identity fields and drops secrets", () => {
  const requestId = "11111111-2222-4333-8444-555555555555";
  const error = fakePostgresError({
    message: `token ${SECRET_TOKEN} hash ${SECRET_HASH_HEX}`,
    code: "23505",
    severity: "ERROR",
    routine: "_bt_check_unique",
    constraint_name: "signals_pkey",
  });
  const diag = extractSafeDiagnostics(error, "query", requestId);

  assert.deepEqual(diag, {
    event: "read_request_failure",
    request_id: requestId,
    phase: "query",
    name: "PostgresError",
    code: "23505",
    severity: "ERROR",
    routine: "_bt_check_unique",
    constraint: "signals_pkey",
    retryable: false,
  } satisfies SafeReadDiagnostics);

  assert.equal(firstForbiddenDiagnosticKey(diag as unknown as Record<string, unknown>), null);
  for (const key of FORBIDDEN_DIAGNOSTIC_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(diag, key),
      false,
      `forbidden key present: ${key}`,
    );
  }

  const logLine = formatReadFailureLog(diag);
  assertNoSecrets(logLine);
  assert.equal(logLine.includes('"phase":"query"'), true);
  assert.equal(logLine.includes('"code":"23505"'), true);
  assert.equal(logLine.includes(requestId), true);
});

test("extractSafeDiagnostics classifies connection failures as retryable", () => {
  const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  for (
    const code of [
      "CONNECT_TIMEOUT",
      "CONNECTION_CLOSED",
      "CONNECTION_ENDED",
      "CONNECTION_DESTROYED",
    ]
  ) {
    const diag = extractSafeDiagnostics(
      fakeConnectionError(code),
      "session_setup",
      requestId,
    );
    assert.equal(diag.code, code);
    assert.equal(diag.retryable, true, code);
    assert.equal(diag.phase, "session_setup");
    assert.equal(diag.severity, null);
    assert.equal(diag.routine, null);
    assert.equal(diag.constraint, null);
    assertNoSecrets(formatReadFailureLog(diag));
    // Connection address/port must not be copied into diagnostics.
    assert.equal(formatReadFailureLog(diag).includes("127.0.0.1"), false);
    assert.equal(formatReadFailureLog(diag).includes("5432"), false);
  }
});

test("isRetryableErrorCode covers SQLSTATE connection class and known codes", () => {
  assert.equal(isRetryableErrorCode("08006"), true);
  assert.equal(isRetryableErrorCode("40001"), true);
  assert.equal(isRetryableErrorCode("40P01"), true);
  assert.equal(isRetryableErrorCode("55P03"), true);
  assert.equal(isRetryableErrorCode("57014"), true);
  assert.equal(isRetryableErrorCode("23505"), false);
  assert.equal(isRetryableErrorCode("42P01"), false);
  assert.equal(isRetryableErrorCode(null), false);
});

test("publicReadErrorBody stays generic with request_id and retryable only", () => {
  const diag = extractSafeDiagnostics(
    fakePostgresError({ code: "08006", severity: "FATAL", routine: "auth_failed" }),
    "credential_lookup",
    "99999999-aaaa-4bbb-8ccc-dddddddddddd",
  );
  const body = publicReadErrorBody(diag);
  assert.deepEqual(body, {
    error: "internal_error",
    request_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
    retryable: true,
  });
  assert.equal(Object.keys(body).sort().join(","), "error,request_id,retryable");
  assertNoSecrets(JSON.stringify(body));
  // Public body must not leak Postgres identity fields.
  assert.equal(JSON.stringify(body).includes("08006"), false);
  assert.equal(JSON.stringify(body).includes("FATAL"), false);
  assert.equal(JSON.stringify(body).includes("auth_failed"), false);
});

test("handler phase is preserved across phases including top_level fallback", () => {
  const phases = [
    "auth",
    "parse",
    "session_setup",
    "credential_lookup",
    "membership",
    "query",
    "top_level",
  ] as const;
  for (const phase of phases) {
    const diag = extractSafeDiagnostics(new Error("boom"), phase, "id");
    assert.equal(diag.phase, phase);
    assert.equal(diag.name, "Error");
    assert.equal(diag.code, null);
  }
  // Unknown phase collapses to top_level rather than inventing a free-form string.
  const collapsed = extractSafeDiagnostics(
    new Error("boom"),
    "invented" as "query",
    "id",
  );
  assert.equal(collapsed.phase, "top_level");
});

test("non-Error throws produce name unknown and no secrets", () => {
  const diag = extractSafeDiagnostics(
    { code: "57014", token: SECRET_TOKEN, authorization: "Bearer x", body: { a: 1 } },
    "query",
    "corr-1",
  );
  assert.equal(diag.name, "unknown");
  assert.equal(diag.code, "57014");
  assert.equal(diag.retryable, true);
  // Input object may carry secrets; diagnostics object must not.
  assert.equal(firstForbiddenDiagnosticKey(diag as unknown as Record<string, unknown>), null);
  assertNoSecrets(formatReadFailureLog(diag));
});

test("read/index.ts wires structured diagnostics (source contract)", () => {
  const source = readFileSync(
    join(process.cwd(), "supabase/functions/read/index.ts"),
    "utf8",
  );
  assert.match(source, /from "\.\/diagnostics\.ts"/);
  assert.match(source, /extractSafeDiagnostics/);
  assert.match(source, /publicReadErrorBody/);
  assert.match(source, /formatReadFailureLog/);
  assert.match(source, /newRequestId/);
  // Old unstructured log must be gone.
  assert.equal(source.includes('"read function failure"'), false);
  // Phase markers for the main handler steps (setPhase("…") call sites).
  for (
    const phase of [
      "auth",
      "parse",
      "session_setup",
      "credential_lookup",
      "membership",
      "query",
    ]
  ) {
    assert.match(
      source,
      new RegExp(`setPhase\\("${phase}"\\)`),
      `missing phase marker: ${phase}`,
    );
  }
  assert.match(source, /let phase: ReadHandlerPhase = "top_level"/);
});



test("the read function keeps browser CORS wired — preflight branch and response wrap", () => {
  /* 2026-08-31: the dashboard became this function's first browser caller
   * (renewal_grants). The function 405'd the preflight with no CORS headers,
   * every browser fetch died as TypeError, and the whole channel view failed
   * for every signed-in member. The unit-tested cors.ts module cannot catch
   * an unwired serve path, so this pins the wiring itself. */
  const source = readFileSync(
    join(import.meta.dirname, "../supabase/functions/read/index.ts"),
    "utf8",
  );
  assert.match(source, /from "\.\.\/command\/cors\.ts"/);
  assert.match(
    source,
    /request\.method === "OPTIONS"[\s\S]{0,120}commandPreflight\(/,
  );
  assert.match(source, /withCommandCors\(request, response/);
});

function assertTransactionOpenings(name: "read" | "command", source: string): void {
  // Parse every opening, including single quotes, unparenthesized arrows and
  // options held in a constant. Counting only known-good spellings lets an
  // additional transaction with different isolation silently escape the guard.
  const file = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const inventory: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(file) === "db" && node.expression.name.text === "begin") {
      const callback = node.arguments.at(-1);
      assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body), `${name}: BEGIN callback`);
      const body = callback.body.getText(file);
      const parameter = callback.parameters[0]!.name.getText(file);
      let isolation: string | undefined;
      if (node.arguments.length === 2) {
        const option = node.arguments[0]!;
        if (ts.isStringLiteral(option)) isolation = option.text;
        else {
          assert.equal(option.getText(file), "HOSTED_TRANSACTION_ISOLATION");
          const declaration = file.statements.flatMap(statement => ts.isVariableStatement(statement)
            ? [...statement.declarationList.declarations] : [])
            .find(declaration => declaration.name.getText(file) === "HOSTED_TRANSACTION_ISOLATION");
          assert.ok(declaration?.initializer && ts.isStringLiteral(declaration.initializer));
          isolation = declaration.initializer.text;
        }
        assert.equal(isolation, "isolation level read committed", `${name}: every explicit BEGIN isolation`);
      } else assert.equal(node.arguments.length, 1);

      // Failure-only audit transactions and the independent purge drain retain
      // their default isolation. The worker delivery path arrived after folding
      // and uses default isolation with folded setTransaction setup.
      // None may hide an explicit SERIALIZABLE option.
      const audit = callback.body.statements.length === 2
        && /^await (?:recordAdminFailure|adminSecurityFailure)\(/.test(callback.body.statements[1]!.getText(file));
      const drain = /await drainFilePurgeQueue\(/.test(body);
      let owner: ts.Node | undefined = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      const worker = owner && ts.isFunctionDeclaration(owner) && owner.name?.text === "handleAdminWorkerCommand" && !audit;
      if (audit || drain || worker) assert.equal(isolation, undefined, `${name}: default-isolation exception`);
      else assert.equal(isolation, "isolation level read committed", `${name}: request BEGIN isolation`);
      inventory.push(audit ? "audit" : drain ? "drain" : worker ? "worker" : "request");

      if (name === "read") {
        assert.match(body, /await operation\(tx\)/);
      } else if (drain) {
        assert.match(body, /set_config\('role', 'swarm_command', true\)/);
        assert.match(body, /set_config\('search_path', 'swarm, pg_catalog', true\)/);
      } else {
        assert.ok(body.includes(`await setTransaction(${parameter})`)
          || body.includes(`await adminDbRole(${parameter}, 'swarm_command')`),
        `${name}: each BEGIN installs its transaction settings`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.deepEqual(inventory.sort(), name === "read" ? ["request"]
    : ["audit", "audit", "audit", "audit", "drain", "request", "request", "request", "request", "request", "worker"],
  `${name}: all request, failure-audit, drain and worker transactions are accounted for`);

  if (name === "read") {
    // The read wrapper delegates setup to each operation callback.
    const visitRead = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === "withReadTransaction") {
        const callback = node.arguments[0];
        assert.ok(callback && ts.isArrowFunction(callback));
        assert.match(callback.body.getText(file), /await setReadTransaction\(tx\)/);
      }
      ts.forEachChild(node, visitRead);
    };
    visitRead(file);
  }
}

function assertRoundTripFold(readSource: string, commandSource: string): void {
  assertTransactionOpenings("read", readSource);
  assertTransactionOpenings("command", commandSource);
  assert.match(
    readSource,
    /async function setReadTransaction[\s\S]{0,500}set_config\('role', 'swarm_read', true\)[\s\S]{0,200}set_config\('search_path', 'swarm_read, swarm, pg_catalog', true\)[\s\S]{0,200}set_config\('lock_timeout', '5s', true\)/,
  );
  assert.equal(
    readSource.includes("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"),
    false,
  );
  assert.match(
    commandSource,
    /async function setTransaction[\s\S]{0,500}set_config\('role', 'swarm_command', true\)[\s\S]{0,200}set_config\('search_path', 'swarm, pg_catalog', true\)[\s\S]{0,200}set_config\('lock_timeout', '5s', true\)/,
  );
  const adminRole = readFileSync(join(process.cwd(), "supabase/functions/_shared/admin-oauth-db.ts"), "utf8");
  assert.match(adminRole, /async function adminDbRole[\s\S]{0,250}set_config\('role', \$\{role\}, true\)[\s\S]{0,150}set_config\('search_path', 'pg_catalog', true\)[\s\S]{0,150}set_config\('lock_timeout', '5s', true\)/);
}

/** Every edge function: no transaction opens with a bare BEGIN followed by separate SET statements. */
const EDGE_FUNCTIONS = ["command", "read", "capability", "activity"] as const;

function assertNoUnfoldedSetup(name: string, source: string): void {
  assert.equal(
    /(unsafe\(\s*"|\w`\s*)SET (TRANSACTION|LOCAL ROLE|LOCAL lock_timeout)/.test(source),
    false,
    `${name}: a transaction still sends SET TRANSACTION, SET LOCAL ROLE, or SET LOCAL lock_timeout as its own round trip`,
  );
  const bareBegins = [...source.matchAll(/db\.begin\(async \((\w+)\) => \{\s*await \1(\.unsafe\(|`\s*SELECT\s+set_config\('role')/g)].length;
  const drainOnly = name === "command" ? 1 : 0;
  assert.equal(bareBegins, drainOnly, `${name}: a request transaction opens with BEGIN and sets its isolation level separately`);
}

test("read and command fold transaction setup without changing its settings", () => {
  const readSource = readFileSync(
    join(process.cwd(), "supabase/functions/read/index.ts"),
    "utf8",
  );
  const commandSource = readFileSync(
    join(process.cwd(), "supabase/functions/command/index.ts"),
    "utf8",
  );
  assertRoundTripFold(readSource, commandSource);
});

test("every edge function folds its transaction setup (activity has a 5 s client budget)", () => {
  for (const name of EDGE_FUNCTIONS) {
    assertNoUnfoldedSetup(name, readFileSync(join(process.cwd(), `supabase/functions/${name}/index.ts`), "utf8"));
  }
  const activity = readFileSync(join(process.cwd(), "supabase/functions/activity/index.ts"), "utf8");
  const capability = readFileSync(join(process.cwd(), "supabase/functions/capability/index.ts"), "utf8");
  const ROLE = { activity: "swarm_command", capability: "swarm_capability" } as const;
  for (const [name, source] of [["activity", activity], ["capability", capability]] as const) {
    assert.equal([...source.matchAll(/db\.begin\("isolation level read committed", async \(tx\) =>/g)].length, 1, `${name}: BEGIN carries the isolation level`);
    const pinsRole = (text: string) => text.includes(`set_config('role', '${ROLE[name]}', true)`);
    assert.ok(pinsRole(source), `${name}: the transaction sets role ${ROLE[name]}`);
    assert.equal(pinsRole(source.replace(`set_config('role', '${ROLE[name]}', true)`, "set_config('role', 'postgres', true)")), false, `${name}: mutation (role postgres) must be caught`);
    assert.throws(
      () => assertNoUnfoldedSetup(name, source.replace(/SELECT\s+set_config\('role', '(\w+)', true\),/, (_m, role) => `SET LOCAL ROLE ${role}\`; await tx\`SELECT`)),
      assert.AssertionError,
      `${name}: mutation (tagged SET LOCAL ROLE) must fail`,
    );
    assert.throws(
      () => assertNoUnfoldedSetup(name, source.replace(/SELECT\s+set_config\('role', '(\w+)', true\),/, (_m, role) => `SELECT 1;\`; await tx.unsafe("SET LOCAL ROLE ${role}"); await tx\`SELECT`)),
      assert.AssertionError,
      `${name}: mutation (role back to its own SET LOCAL ROLE) must fail`,
    );
  }
});

test("round-trip fold controls reject each latency regression", () => {
  const readSource = readFileSync(
    join(process.cwd(), "supabase/functions/read/index.ts"),
    "utf8",
  );
  const commandSource = readFileSync(
    join(process.cwd(), "supabase/functions/command/index.ts"),
    "utf8",
  );
  assertRoundTripFold(readSource, commandSource);
  const mutations = [
    {
      name: "read BEGIN options removed",
      read: readSource.replace(
        'db.begin("isolation level read committed", async (tx) =>',
        "db.begin(async (tx) =>",
      ),
      command: commandSource,
    },
    {
      name: "read role setting removed",
      read: readSource.replace(
        "set_config('role', 'swarm_read', true)",
        "current_role::text",
      ),
      command: commandSource,
    },
    {
      name: "command BEGIN options removed",
      read: readSource,
      command: commandSource.replace(
        'db.begin("isolation level read committed", async (tx) =>',
        "db.begin(async (tx) =>",
      ),
    },
    {
      name: "admin command BEGIN options removed",
      read: readSource,
      command: commandSource.replace(
        'db.begin("isolation level read committed", async tx =>',
        "db.begin(async tx =>",
      ),
    },
    {
      name: "single-quoted admin OAuth BEGIN changed to SERIALIZABLE",
      read: readSource,
      command: commandSource.replace(
        "db.begin('isolation level read committed', async tx =>",
        "db.begin('isolation level serializable', async tx =>",
      ),
    },
    {
      name: "extra REPEATABLE READ opening",
      read: readSource,
      command: commandSource + '\n db.begin("isolation level repeatable read", async (tx) => { await setTransaction(tx); });',
    },
    {
      name: "hosted isolation constant changed",
      read: readSource,
      command: commandSource.replace(
        'const HOSTED_TRANSACTION_ISOLATION = "isolation level read committed"',
        'const HOSTED_TRANSACTION_ISOLATION = "isolation level serializable"',
      ),
    },
    {
      name: "admin OAuth setup removed",
      read: readSource,
      command: commandSource.replace("await adminDbRole(tx, 'swarm_command');", "await Promise.resolve();"),
    },
    {
      name: "command search path removed",
      read: readSource,
      command: commandSource.replace(
        "set_config('search_path', 'swarm, pg_catalog', true)",
        "current_setting('search_path')",
      ),
    },
  ];
  for (const mutation of mutations) {
    assert.ok(mutation.read !== readSource || mutation.command !== commandSource, `${mutation.name}: mutation must change the source`);
    assert.throws(
      () => assertRoundTripFold(mutation.read, mutation.command),
      assert.AssertionError,
      mutation.name,
    );
  }
});
