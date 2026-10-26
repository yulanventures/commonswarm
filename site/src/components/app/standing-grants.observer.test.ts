import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Resume client sends the existing command and uses the public stable refusal", async () => {
  const { runInNewContext } = await import("node:vm");
  const { default: ts } = await import("typescript");
  const client = await readFile(new URL("../../lib/commonswarm.ts", import.meta.url), "utf8");
  const start = client.indexOf("export async function resumeRenewalGrant(");
  const end = client.indexOf("export interface PendingMemberInvite", start);
  assert.ok(start >= 0 && end > start);
  const calls: unknown[][] = [];
  let result: { status: number; body: Record<string, string> } = { status: 200, body: { status: "accepted" } };
  const source = client.slice(start, end).replace("export async", "async");
  const compiled = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
  const resume = runInNewContext(`${compiled}; resumeRenewalGrant`, { postCommand: async (...args: unknown[]) => { calls.push(args); return result; } });
  const session = { user: { id: "member" } };
  await resume(session, "request", "workspace", "key-id");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]?.slice(0, 4))), [session, "request", { kind: "resume_renewal_grant", renewal_grant_id: "key-id" }, { workspace_id: "workspace", stream: { kind: "workspace" } }]);
  result = { status: 403, body: { error: "forbidden" } };
  await assert.rejects(resume(session, "request-2", "workspace", "key-id"), /This key cannot be resumed with your current access\. Nothing was changed\./);
  result = { status: 503, body: { error: "unavailable" } };
  await assert.rejects(resume(session, "request-3", "workspace", "key-id"), /Resume was not confirmed\. Reload to check/);
});
