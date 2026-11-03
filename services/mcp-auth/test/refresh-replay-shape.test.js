import assert from "node:assert/strict";
import { test } from "node:test";

import { openRotation, sealRotation } from "../src/postgres-adapter.js";
import { replayShape } from "../src/provider.js";

const base = "grant_type=refresh_token&refresh_token=R0&client_id=c&resource=https%3A%2F%2Fmcp.commonswarm.com%2Fmcp";

test("replay shape accepts only the supported refresh parameters, each once", () => {
  const shape = replayShape(new URLSearchParams(base));
  assert.equal(shape.refreshToken, "R0");
  assert.equal(shape.clientId, "c");
  for (const refused of [`${base}&grant_type=refresh_token`, `${base}&refresh_token=R1`, `${base}&resource=x`,
    `${base}&client_secret=s`, `${base}&code=x`, base.replace("refresh_token&", "authorization_code&"),
    "grant_type=refresh_token&client_id=c", "grant_type=refresh_token&refresh_token=R0"]) {
    assert.equal(replayShape(new URLSearchParams(refused)), undefined, refused);
  }
});

test("replay fingerprint changes with scope or resource and ignores parameter order", () => {
  const fp = (body) => replayShape(new URLSearchParams(body)).fingerprint;
  assert.equal(fp(base), fp("client_id=c&resource=https%3A%2F%2Fmcp.commonswarm.com%2Fmcp&refresh_token=R0&grant_type=refresh_token"));
  assert.equal(fp(base), fp(base.replace("R0", "R9")), "the token itself is not part of the fingerprint");
  assert.notEqual(fp(base), fp(`${base}&scope=openid`));
  assert.notEqual(fp(base), fp(base.replace("mcp.commonswarm.com", "other.example")));
  assert.notEqual(fp(base), fp(base.replace("client_id=c", "client_id=d")));
});

test("a sealed rotation opens only with the same token, client and fingerprint", () => {
  const sealed = sealRotation("R0", "c", "f", { refresh_token: "R1" });
  assert.deepEqual(openRotation("R0", "c", "f", sealed), { refresh_token: "R1" });
  assert.equal(openRotation("R0", "c", "g", sealed), undefined);
  assert.equal(openRotation("R0", "d", "f", sealed), undefined);
  assert.equal(openRotation("R1", "c", "f", sealed), undefined);
  assert.ok(!JSON.stringify(sealed).includes("R1"));
});
