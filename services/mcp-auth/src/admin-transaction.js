import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const requests = new AsyncLocalStorage();
const roles = new AsyncLocalStorage();
const savepoints = new AsyncLocalStorage();
const ALLOWED_ROLES = new Set(["commonswarm_oauth_runtime", "swarm_command"]);

export class AdminTransactionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function adminTransactionContext(required = true) {
  const scope = requests.getStore();
  if (!scope || scope.closed) {
    if (required) throw new AdminTransactionError("admin_transaction_required");
    return undefined;
  }
  return scope;
}

// Each query carries its role, including provider Promise.all paths. Serialize
// role selection and the query together so one asynchronous step cannot borrow
// another step's command privileges. The physical client never leaves this file.
export function adminQuery(sql, values) {
  const scope = adminTransactionContext();
  if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SET|RESET|SAVEPOINT|RELEASE)\b/iu.test(sql)) {
    throw new AdminTransactionError("admin_transaction_control_forbidden");
  }
  const role = roles.getStore() ?? "commonswarm_oauth_runtime";
  const operation = scope.tail.then(async () => {
    if (scope.closed || scope.failure) throw scope.failure ?? new AdminTransactionError("admin_transaction_required");
    await scope.physical.query(`SET LOCAL ROLE ${role}`);
    return scope.physical.query(sql, values);
  });
  scope.tail = operation.catch(error => { scope.failure ??= error; });
  scope.pending.add(operation);
  operation.then(() => scope.pending.delete(operation), () => scope.pending.delete(operation));
  return operation;
}
export function withAdminRole(role, callback) {
  adminTransactionContext();
  if (!ALLOWED_ROLES.has(role)) throw new AdminTransactionError("admin_role_forbidden");
  return roles.run(role, callback);
}

// The adapter and consent store join, rather than send nested BEGIN/COMMIT.
// A failed inner step poisons the entire unit, even if the provider catches it.
export async function joinAdminTransaction(callback) {
  const scope = adminTransactionContext();
  const parent = savepoints.getStore();
  if (scope.savepoint && parent !== scope.savepoint) {
    scope.failure ??= new AdminTransactionError("admin_parallel_nested_transaction_forbidden");
    throw scope.failure;
  }
  const name = `admin_step_${++scope.savepointNumber}`;
  const prior = scope.savepoint;
  scope.savepoint = name;
  try {
    await scope.tail;
    if (scope.failure) throw scope.failure;
    await scope.physical.query(`SAVEPOINT ${name}`);
    const result = await savepoints.run(name, () => callback(scope.client));
    await scope.tail;
    if (scope.failure) throw scope.failure;
    await scope.physical.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await scope.tail;
    await scope.physical.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    scope.failure ??= error;
    throw error;
  } finally { scope.savepoint = prior; }
}
export function scopedAdminPool() {
  return { query: adminQuery, connect: async () => {
    const scope = adminTransactionContext();
    return { query: adminQuery, release() {}, processID: scope.physical.processID };
  } };
}

// Covers Koa's eventual response AND interactionFinished's direct res.end.
// Never monkey-patch the provider or permit a streaming escape hatch.
export function bufferAdminResponse(response, maxBytes = 64 * 1024) {
  const originals = Object.fromEntries(["writeHead", "write", "end", "flushHeaders"]
    .map(name => [name, response[name]]));
  const operations = [];
  let bytes = 0, ended = false, failure;
  const refuse = code => { failure ??= new AdminTransactionError(code); throw failure; };
  const append = (name, args) => {
    if (ended) refuse("admin_response_already_ended");
    if (args[0] != null) bytes += Buffer.isBuffer(args[0]) ? args[0].length
      : Buffer.byteLength(args[0], typeof args[1] === "string" ? args[1] : undefined);
    if (bytes > maxBytes) refuse("admin_response_too_large");
    // Copy buffers: callers cannot mutate staged bytes after signing/ledgering.
    operations.push([name, args.map(arg => Buffer.isBuffer(arg) ? Buffer.from(arg) : arg)]);
    ended ||= name === "end";
  };
  response.writeHead = function (status, message, headers) {
    this.statusCode = status;
    if (typeof message === "string") this.statusMessage = message;
    for (const [key, value] of Object.entries(typeof message === "object" ? message : headers ?? {})) this.setHeader(key, value);
    return this;
  };
  response.write = function (...args) { append("write", args); return true; };
  response.end = function (...args) { append("end", args); return this; };
  response.flushHeaders = () => refuse("admin_response_flush_forbidden");
  const restore = () => Object.assign(response, originals);
  return {
    get staged() { return ended; },
    assertReady() {
      if (failure) throw failure;
      if (!ended || response.headersSent) refuse("admin_response_incomplete");
    },
    release() {
      this.assertReady(); restore();
      for (const [name, args] of operations) originals[name].apply(response, args);
      operations.length = 0;
    },
    discard() {
      restore(); operations.length = 0;
      for (const name of response.getHeaderNames()) response.removeHeader(name);
    },
  };
}

export class AdminTransactionCoordinator {
  constructor(pool) { this.pool = pool; }
  async run(response, callback, capability) {
    if (adminTransactionContext(false)) throw new AdminTransactionError("admin_nested_unit_forbidden");
    const physical = await this.pool.connect();
    const held = bufferAdminResponse(response);
    const scope = { physical, client: { query: adminQuery }, capability,
      requestId: randomUUID(), closed: false, failure: null, tail: Promise.resolve(),
      pending: new Set(), savepointNumber: 0, savepoint: null, fenceCommittedOnError: false };
    let committing = false, committed = false, unknown = false;
    try {
      await physical.query("BEGIN");
      const principal = (await physical.query("SELECT session_user AS principal")).rows[0]?.principal;
      if (principal !== "commonswarm_admin_issuer") throw new AdminTransactionError("admin_issuer_role_required");
      await requests.run(scope, async () => {
        await callback(scope);
        await scope.tail;
        if (scope.pending.size) throw new AdminTransactionError("admin_unawaited_write");
        if (scope.failure) throw scope.failure;
        held.assertReady();
        if (response.statusCode >= 400 && !scope.fenceCommittedOnError) {
          throw new AdminTransactionError("admin_provider_refused");
        }
      });
      committing = true;
      const result = await physical.query("COMMIT");
      if (result.command !== "COMMIT") throw new AdminTransactionError("admin_commit_rolled_back");
      committed = true; scope.closed = true;
      held.release();
      return { outcome: "committed", requestId: scope.requestId };
    } catch (error) {
      // A returned ROLLBACK tag is determinate. A thrown COMMIT is
      // unknown: do not retry issuance or expose any of the staged credentials.
      unknown = committed || (committing && error.code !== "admin_commit_rolled_back");
      await scope.tail;
      scope.closed = true;
      if (!unknown) await physical.query("ROLLBACK").catch(() => {});
      held.discard();
      if (!response.destroyed) {
        response.statusCode = 503;
        response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "no-store");
        const clientCode = ["invalid_grant","invalid_scope","unauthorized_client","consent_receipt_invalid"].includes(error.code) ? error.code : null;
        if (!unknown && clientCode) response.statusCode = error.status ?? 400;
        response.end(JSON.stringify({ error: unknown ? "issuance_outcome_unknown" : clientCode ?? "temporarily_unavailable",
          request_id: scope.requestId }));
      }
      return { outcome: unknown ? "unknown" : "refused", requestId: scope.requestId };
    } finally { scope.closed = true; physical.release(unknown); }
  }
}
