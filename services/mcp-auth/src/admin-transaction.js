import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AdminOAuthError, oauthErrorResponse } from "./admin-oauth-error.js";

const requests = new AsyncLocalStorage();
const roles = new AsyncLocalStorage();
const savepoints = new AsyncLocalStorage();
const ALLOWED_ROLES = new Set(["commonswarm_oauth_runtime", "swarm_command"]);

export class AdminTransactionError extends AdminOAuthError {
  constructor(code) { super(code, 503); }
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

// pg 8 does not accept an AbortSignal for Pool.connect/query. Race acquisition
// with cleanup of a late client, and end the acquired client on cancellation.
// Client.end() destroys an active-query socket and rejects its queued queries.
function abortable(work, signal) {
  if (!signal) return work;
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  return Promise.race([work, cancelled]).finally(() => signal.removeEventListener("abort", listener));
}

export class AdminTransactionCoordinator {
  constructor(pool, { adminIssuanceEnabled = false } = {}) {
    this.pool = pool; this.adminIssuanceEnabled = adminIssuanceEnabled;
  }
  async run(response, callback, capability, { signal } = {}) {
    if (adminTransactionContext(false)) throw new AdminTransactionError("admin_nested_unit_forbidden");
    signal?.throwIfAborted();
    const acquisition = this.pool.connect();
    let raw;
    try { raw = await abortable(acquisition, signal); }
    catch (error) {
      acquisition.then(client => client.release(true), () => {});
      throw error;
    }
    const physical = { query: (...args) => {
      signal?.throwIfAborted();
      return raw.query(...args);
    }, processID: raw.processID };
    const held = bufferAdminResponse(response);
    const scope = { coordinator: this, physical, client: { query: adminQuery }, capability,
      requestId: randomUUID(), closed: false, failure: null, tail: Promise.resolve(),
      pending: new Set(), savepointNumber: 0, savepoint: null, fenceCommittedOnError: false };
    let committing = false, committed = false, unknown = false, rollbackFailed = false;
    const abort = () => {
      scope.closed = true;
      scope.failure ??= signal.reason;
      void raw.end().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await abortable(physical.query("BEGIN"), signal);
      const principal = (await abortable(physical.query("SELECT session_user AS principal"), signal)).rows[0]?.principal;
      if (principal !== "commonswarm_admin_issuer") throw new AdminTransactionError("admin_issuer_role_required");
      await abortable(requests.run(scope, async () => {
        await callback(scope);
        await scope.tail;
        if (scope.pending.size) throw new AdminTransactionError("admin_unawaited_write");
        if (scope.failure) throw scope.failure;
        held.assertReady();
        if (response.statusCode >= 400 && !scope.fenceCommittedOnError) {
          throw new AdminTransactionError("admin_provider_refused");
        }
      }), signal);
      committing = true;
      const result = await abortable(physical.query("COMMIT"), signal);
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
      // A failed rollback can leave transaction locks and local roles active.
      // Never return that connection to the pool for another issuance/revoke.
      if (!unknown && !signal?.aborted) await physical.query("ROLLBACK").catch(() => { rollbackFailed = true; });
      held.discard();
      if (!response.destroyed) {
        const refusal = unknown ? null : oauthErrorResponse(error);
        response.statusCode = refusal?.status ?? 503;
        response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify({ ...(unknown ? { error: "issuance_outcome_unknown" }
          : refusal?.body ?? { error: "temporarily_unavailable" }),
          request_id: scope.requestId }));
      }
      // Private result for ingress diagnostics. The public response above never
      // exposes this error (including PostgreSQL messages or staged credentials).
      return { outcome: unknown ? "unknown" : "refused", requestId: scope.requestId, cause: error };
    } finally {
      scope.closed = true;
      signal?.removeEventListener("abort", abort);
      raw.release(unknown || rollbackFailed || signal?.aborted === true);
    }
  }
}
