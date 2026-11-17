import assert from "node:assert/strict";
import { test } from "node:test";

import { connectedHosts, joinAttemptMatch, lastHost, rememberJoinedHost, rememberLastHost } from "./add-agent.ts";

const memory = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
};
const refusing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

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

test("the last app and the apps that joined are remembered in this browser only while they still hold", () => {
  const store = memory();
  assert.equal(lastHost(store), "");
  rememberLastHost(store, "codex");
  assert.equal(lastHost(store), "codex");
  rememberJoinedHost(store, { workspaceId: "W", hostId: "claude", principalId: "a" });
  rememberJoinedHost(store, { workspaceId: "W", hostId: "grok", principalId: "b" });
  rememberJoinedHost(store, { workspaceId: "X", hostId: "codex", principalId: "c" });
  assert.deepEqual(connectedHosts(store, "W", ["a", "b"]), ["claude", "grok"]);
  assert.deepEqual(connectedHosts(store, "W", ["b"]), ["grok"], "an app whose agent left this workspace is not connected");
  assert.deepEqual(connectedHosts(store, "X", ["a", "b"]), [], "another workspace's joins do not count");
  rememberJoinedHost(store, { workspaceId: "W", hostId: "muse", principalId: "a" });
  assert.deepEqual(connectedHosts(store, "W", ["a"]), ["muse"], "one agent is remembered once, by its latest app");
  store.setItem("commonswarm:add-agent:joined", "not json");
  assert.deepEqual(connectedHosts(store, "W", ["a"]), []);
  for (const store of [null, refusing]) {
    rememberLastHost(store, "claude");
    rememberJoinedHost(store, { workspaceId: "W", hostId: "claude", principalId: "a" });
    assert.equal(lastHost(store), "");
    assert.deepEqual(connectedHosts(store, "W", ["a"]), []);
  }
});
