import assert from "node:assert/strict";
import { Server, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";

import { ISSUER } from "../src/provider.js";
import { createPostgresRegistrationStore } from "../src/registration.js";
import { startServer } from "../src/server.js";

const HOUR = 60 * 60 * 1000;
const DB_ERROR = Object.assign(new Error("synthetic database connection details must stay private"), {
  code: "ENOTFOUND", hostname: "private-db.example.test",
  connectionString: "postgres://synthetic-user:synthetic-password@private-db.example.test/db",
});

async function harness(t, { enabled = true, unavailable = false } = {}) {
  const logs = [];
  const queries = [];
  const clients = new Map();
  const intervals = [];
  let down = unavailable;
  t.mock.method(console, "error", (line) => logs.push(line));
  t.mock.method(Pool.prototype, "query", async (sql, values) => {
    queries.push(sql);
    if (down) throw DB_ERROR;
    if (sql.includes("WHERE expires_at <= statement_timestamp()")) return { rowCount: 2, rows: [] };
    if (sql.startsWith("INSERT INTO commonswarm_oauth.registered_clients")) {
      clients.set(values[0], JSON.parse(values[1]));
      return { rowCount: 1, rows: [] };
    }
    throw new Error("unexpected fixture database operation");
  });
  // Exercise the real startup and request handler without listening on a port.
  t.mock.method(Server.prototype, "listen", function (_port, _host, callback) {
    queueMicrotask(callback);
    return this;
  });
  // Own only this scheduler boundary. Node 22's MockTimers warning is emitted
  // asynchronously through console.error and contaminates the privacy assertion.
  const activeIntervals = new Map();
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const unref = t.mock.fn();
    const timer = { unref };
    activeIntervals.set(timer, callback);
    intervals.push({ unref, delay });
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => activeIntervals.delete(timer));
  const config = {
    publicAuthorizationEnabled: enabled, issuer: ISSUER, database: {},
    allowedOrigins: new Set([ISSUER]), gotrueUrl: "https://auth.example.test",
    gotrueProvider: "google", supabaseAnonKey: "synthetic-anon-key",
    port: 0, maxBodyBytes: 64 * 1024, requestTimeoutMs: 10_000,
  };
  const running = await startServer({ config, writeLog: (line) => logs.push(line),
    managementCommand: async () => { throw new Error("unexpected management command"); },
    managementWorkspaceReader: async () => { throw new Error("unexpected workspace read"); },
  });
  t.after(async () => {
    running.server.emit("close");
    assert.equal(activeIntervals.size, 0, "server close cancels hourly cleanup");
    await running.pool.end();
  });
  return { ...running, logs, queries, clients, intervals,
    recover: () => { down = false; },
    async tick() {
      for (const callback of activeIntervals.values()) callback();
      await nextTurn();
    },
  };
}

async function register(running) {
  const socket = new PassThrough();
  socket.encrypted = true;
  const body = Buffer.from(JSON.stringify({
    redirect_uris: ["https://client.example.test/callback"],
  }));
  const request = Readable.from([body]);
  Object.assign(request, {
    method: "POST", url: "/reg", httpVersionMajor: 1, httpVersionMinor: 1, socket,
    headers: { host: new URL(ISSUER).host, "x-forwarded-proto": "https",
      "content-type": "application/json", "content-length": String(body.length),
      accept: "application/json" },
  });
  const response = new ServerResponse(request);
  response.body = "";
  response.end = (body = "") => {
    response.body += String(body);
    response.finished = true;
    response.emit("finish");
  };
  await running.server.listeners("request")[0](request, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

test("database outage cannot abort startup or hourly cleanup; registration still fails closed", async (t) => {
  const h = await harness(t, { unavailable: true });
  assert.ok(h.registrationStore, "startup completes with registration enabled");
  assert.equal(h.queries.length, 1);
  const failureLine = "mcp-auth registration cleanup failed (ENOTFOUND)";
  assert.deepEqual(h.logs, [failureLine], "cleanup logs only the code, without database details");
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].delay, HOUR);
  assert.equal(h.intervals[0].unref.mock.callCount(), 1);

  await h.tick();
  assert.equal(h.queries.length, 2, "the next hourly interval retries the failed cleanup");
  assert.deepEqual(h.logs, [failureLine, failureLine], "one safe line per cleanup failure");

  const failed = await register(h);
  assert.equal(h.queries.length, 3, "registration reaches the unavailable database");
  assert.match(h.queries.at(-1), /^INSERT INTO commonswarm_oauth\.registered_clients/u);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, "server_error");
  assert.equal(failed.body.client_id, undefined);
  assert.equal(h.clients.size, 0);

  h.recover();
  const logCount = h.logs.length;
  await h.tick();
  assert.equal(h.queries.length, 4, "cleanup keeps retrying after recovery");
  assert.equal(h.logs.length, logCount, "successful cleanup produces no failure log");
  const registered = await register(h);
  assert.equal(registered.status, 201);
  assert.equal(typeof registered.body.client_id, "string");
  assert.ok(h.clients.has(registered.body.client_id), "recovery persists a new registration");
});

test("working database supports startup, expiry cleanup, and registration", async (t) => {
  const h = await harness(t);
  assert.equal(h.queries.length, 1);
  assert.deepEqual(h.logs, []);
  assert.equal(await h.registrationStore.cleanup(), 2, "cleanup preserves the removed-row count");
  await h.tick();
  assert.equal(h.queries.length, 3);
  assert.deepEqual(h.logs, []);
  const registered = await register(h);
  assert.equal(registered.status, 201);
  assert.ok(h.clients.has(registered.body.client_id));
});

test("disabled public authorization creates no registration store, timer, or query", async (t) => {
  const h = await harness(t, { enabled: false, unavailable: true });
  assert.equal(h.registrationStore, undefined);
  assert.deepEqual(h.intervals, []);
  assert.deepEqual(h.queries, []);
  await h.tick();
  const disabled = await register(h);
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.error, "authorization_service_disabled");
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.logs.filter((line) => line.includes("cleanup")), []);
});

test("cleanup does not log missing or unsafe database error codes", async (t) => {
  const lines = [];
  t.mock.method(console, "error", (line) => lines.push(line));
  for (const code of [undefined, 42, DB_ERROR.connectionString, "ENOTFOUND\nprivate-db.example.test"]) {
    const store = createPostgresRegistrationStore({
      async query() { throw { code, message: DB_ERROR.message, hostname: DB_ERROR.hostname }; },
    });
    await store.cleanup();
  }
  assert.deepEqual(lines, Array(4).fill("mcp-auth registration cleanup failed (UNKNOWN)"));
});
