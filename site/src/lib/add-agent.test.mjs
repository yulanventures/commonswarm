import assert from "node:assert/strict";
import { test } from "node:test";

import { connectedHosts, forgetAddAgent, joinAttemptMatch, lastHost, rememberJoinedHost, rememberLastHost } from "./add-agent.ts";

const memory = () => {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};
const refusing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };

test("the waiting line takes this attempt's agent: mine, new, hosted, and the typed name when there is one", () => {
  const agents = [
    { principalId: "old", name: "RidgeHQ Lead", ownerUserId: "me", transport: "hosted_mcp" },
    { principalId: "theirs", name: "RidgeHQ Lead", ownerUserId: "them", transport: "hosted_mcp" },
    { principalId: "key", name: "Scout", ownerUserId: "me", transport: "local" },
    { principalId: "new", name: "Trip Planner", ownerUserId: "me", transport: "hosted_mcp" },
  ];
  const attempt = (name) => joinAttemptMatch(agents, { ownerUserId: "me", known: new Set(["old"]), name })?.principalId ?? null;
  assert.equal(attempt(""), "new", "a blank name takes the new hosted agent of mine");
  assert.equal(attempt("  trip PLANNER "), "new", "a typed name matches ignoring case and outer spaces");
  assert.equal(attempt("RidgeHQ Lead"), null, "an agent that was already here, or someone else's, is not this attempt");
  assert.equal(attempt("Scout"), null, "a key agent never answers a connector attempt");
});

test("what the panel remembers is kept per account, holds only ids, and is forgotten at sign-out", () => {
  const store = memory();
  assert.equal(lastHost(store, "A"), "");
  rememberLastHost(store, "A", "codex");
  rememberLastHost(store, "B", "claude");
  rememberLastHost(store, "", "grok");
  assert.equal(lastHost(store, "A"), "codex");
  assert.equal(lastHost(store, "B"), "claude", "one account's last app is not another's");
  assert.equal(lastHost(store, ""), "", "no account, nothing remembered");
  rememberJoinedHost(store, { userId: "A", workspaceId: "W", hostId: "claude", principalId: "a" });
  rememberJoinedHost(store, { userId: "A", workspaceId: "W", hostId: "grok", principalId: "b" });
  rememberJoinedHost(store, { userId: "A", workspaceId: "X", hostId: "codex", principalId: "c" });
  rememberJoinedHost(store, { userId: "B", workspaceId: "W", hostId: "muse", principalId: "d" });
  assert.deepEqual(connectedHosts(store, "A", "W", ["a", "b", "d"]), ["claude", "grok"]);
  assert.deepEqual(connectedHosts(store, "B", "W", ["a", "b", "d"]), ["muse"], "B sees none of A's apps");
  assert.deepEqual(connectedHosts(store, "A", "W", ["b"]), ["grok"], "an app whose agent left this workspace is not connected");
  assert.deepEqual(connectedHosts(store, "A", "X", ["a", "b"]), [], "another workspace's joins do not count");
  rememberJoinedHost(store, { userId: "A", workspaceId: "W", hostId: "muse", principalId: "a" });
  assert.deepEqual(connectedHosts(store, "A", "W", ["a"]), ["muse"], "one agent is remembered once, by its latest app");

  /* The exact contents: ids only, never a token, a key or a name. */
  assert.deepEqual([...store.values.keys()].sort(), ["commonswarm:add-agent:joined", "commonswarm:add-agent:last-host"]);
  assert.deepEqual(JSON.parse(store.values.get("commonswarm:add-agent:last-host")), { A: "codex", B: "claude" });
  for (const record of JSON.parse(store.values.get("commonswarm:add-agent:joined"))) {
    assert.deepEqual(Object.keys(record).sort(), ["hostId", "principalId", "userId", "workspaceId"]);
  }

  forgetAddAgent(store, "A");
  assert.equal(lastHost(store, "A"), "");
  assert.deepEqual(connectedHosts(store, "A", "W", ["a", "b"]), []);
  assert.equal(lastHost(store, "B"), "claude", "signing A out keeps B's");
  assert.deepEqual(connectedHosts(store, "B", "W", ["d"]), ["muse"]);
  forgetAddAgent(store, "B");
  assert.deepEqual([...store.values.keys()], [], "nothing is left once every account has signed out");

  store.setItem("commonswarm:add-agent:joined", "not json");
  store.setItem("commonswarm:add-agent:last-host", "[1]");
  assert.deepEqual(connectedHosts(store, "A", "W", ["a"]), []);
  assert.equal(lastHost(store, "A"), "");
  for (const store of [null, refusing]) {
    rememberLastHost(store, "A", "claude");
    rememberJoinedHost(store, { userId: "A", workspaceId: "W", hostId: "claude", principalId: "a" });
    forgetAddAgent(store, "A");
    assert.equal(lastHost(store, "A"), "");
    assert.deepEqual(connectedHosts(store, "A", "W", ["a"]), []);
  }
});
