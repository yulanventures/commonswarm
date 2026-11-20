import assert from "node:assert/strict";
import test from "node:test";
import {
  isLocalEdgeWorkerRetiredResponse,
  parseLocalEdgeJsonBody,
  withLocalEdgeWorkerRetiredRetry,
  type LocalEdgeRawResponse,
} from "./support/local-edge-retry.js";

function raw(status: number, bodyOrText: Record<string, unknown> | string): LocalEdgeRawResponse {
  const text = typeof bodyOrText === "string" ? bodyOrText : JSON.stringify(bodyOrText);
  return { status, text, body: parseLocalEdgeJsonBody(text) };
}

test("isLocalEdgeWorkerRetiredResponse matches stock dev-router WorkerAlreadyRetired 500s only", () => {
  // Exact shape captured in #491 / run 44629682486 attempt 1
  assert.equal(
    isLocalEdgeWorkerRetiredResponse(
      raw(500, { code: "INTERNAL_ERROR", message: "WorkerAlreadyRetired: worker retired" }),
      "",
    ),
    true,
  );
  assert.equal(
    isLocalEdgeWorkerRetiredResponse(
      raw(500, { code: "WORKER_ERROR", message: "Function failed" }),
      "2026-11-19 error: WorkerAlreadyRetired",
    ),
    true,
  );
  assert.equal(
    isLocalEdgeWorkerRetiredResponse(
      raw(500, ""),
      "WorkerAlreadyRetired",
    ),
    true,
  );

  // Never matches real command/index.ts responses even when logs mention WorkerAlreadyRetired
  assert.equal(
    isLocalEdgeWorkerRetiredResponse(
      raw(500, { error: "internal_error", message: "boom" }),
      "WorkerAlreadyRetired",
    ),
    false,
  );
  assert.equal(
    isLocalEdgeWorkerRetiredResponse(
      raw(503, { error: "temporarily_unavailable" }),
      "WorkerAlreadyRetired",
    ),
    false,
  );
  assert.equal(
    isLocalEdgeWorkerRetiredResponse(
      raw(200, { ok: false, status: "rejected", reason: "not_acquirable" }),
      "WorkerAlreadyRetired",
    ),
    false,
  );
  // Never matches unrelated dev-router 500 without WorkerAlreadyRetired evidence
  assert.equal(
    isLocalEdgeWorkerRetiredResponse(
      raw(500, { code: "INTERNAL_ERROR", message: "something else" }),
      "ordinary boot log",
    ),
    false,
  );
});

test("withLocalEdgeWorkerRetiredRetry retries exactly once on WorkerAlreadyRetired and surfaces persistent failures", async () => {
  let logs = "boot\n";
  let calls = 0;
  const recovered = await withLocalEdgeWorkerRetiredRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        logs += "WorkerAlreadyRetired\n";
        return raw(500, { code: "INTERNAL_ERROR", message: "retired" });
      }
      return raw(200, { ok: true, status: "accepted", event_ids: ["e1"] });
    },
    () => logs,
  );
  assert.equal(calls, 2);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body?.status, "accepted");

  // Second consecutive WorkerAlreadyRetired is NOT retried a third time
  let calls2 = 0;
  const persistent = await withLocalEdgeWorkerRetiredRetry(
    async () => {
      calls2 += 1;
      return raw(500, { code: "INTERNAL_ERROR", message: "WorkerAlreadyRetired" });
    },
    () => "",
  );
  assert.equal(calls2, 2);
  assert.equal(persistent.status, 500);

  // Real command 500 is never retried
  let calls3 = 0;
  const real500 = await withLocalEdgeWorkerRetiredRetry(
    async () => {
      calls3 += 1;
      return raw(500, { error: "internal_error" });
    },
    () => "WorkerAlreadyRetired",
  );
  assert.equal(calls3, 1);
  assert.equal(real500.status, 500);
});
