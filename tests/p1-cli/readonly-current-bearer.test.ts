/** Read-only commands (resume, listen status and canary, session status/stop/start, the revoke
 *  fallback) send the newest bearer in the lineage store, never a root a renewal superseded, and
 *  never renew to get it. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentAgentBearer } from "../../src/cli.js";
import { agentCredentialStore, credentialLineageKey } from "../../src/cloud/agent-credential.js";
import { cloudTarget } from "../../src/cloud/config.js";

const cloud = cloudTarget("http://127.0.0.1:9", "synthetic-anon-key");
const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const principal = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const run = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const rootId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const root = `swm_agt_${"r".repeat(43)}`;
const successor = `swm_agt_${"s".repeat(43)}`;
const agent = { token: root, tokenId: rootId, principalId: principal, runId: run, expiresAt: Date.now() - 60_000 };

test("after a renewal, a read-only command uses the stored successor without renewing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-readonly-bearer-"));
  const previous = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.SWARM_AGENT_STATE_DIR; else process.env.SWARM_AGENT_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => { fetched.push(String(input)); throw new Error("no network in this test"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  assert.equal(await currentAgentBearer(cloud, workspace, agent), root, "no renewal yet: the token given");

  const store = await agentCredentialStore({ target: cloud, lineageKey: credentialLineageKey(root), stateDirectory: directory });
  await store.write({ version: 1, token: successor, tokenId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", principalId: principal, runId: run,
    rootTokenId: rootId, generation: 1, issuedAt: Date.now() - 2 * 3_600_000, expiresAt: Date.now() - 3_600_000,
    horizonExpiresAt: null, successorsRemaining: null, pendingRenewal: null });
  const before = await readdir(directory);
  assert.equal(await currentAgentBearer(cloud, workspace, agent), successor, "after a renewal: the successor, even though it has expired too");
  assert.deepEqual(fetched, [], "reading the bearer never renews or calls the network");
  assert.deepEqual((await readdir(directory)).filter(name => !name.endsWith(".lock")).sort(), before.filter(name => !name.endsWith(".lock")).sort(),
    "the store is only read");

  const otherLineage = { ...agent, principalId: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
  assert.equal(await currentAgentBearer(cloud, workspace, otherLineage), root, "a record for another agent is ignored");
});
