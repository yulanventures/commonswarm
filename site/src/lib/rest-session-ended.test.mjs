import assert from "node:assert/strict";
import { test } from "node:test";
import { isRestSessionEnded } from "./commonswarm.ts";

// CS-E04: PostgREST refuses a human token whose session ended with 401 and code session_not_found.
const response = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

test("only PostgREST's exact session-ended refusal counts", async () => {
  assert.equal(await isRestSessionEnded(response(401, { code: "session_not_found", message: "This sign-in has ended." })), true);
  for (const other of [
    response(401, { code: "PGRST301", message: "JWT expired" }),
    response(401, {}),
    response(401),
    response(403, { code: "session_not_found" }),
    response(200, [{ code: "session_not_found" }]),
  ]) {
    assert.equal(await isRestSessionEnded(other), false);
  }
});

test("the response body stays readable for the caller", async () => {
  const refused = response(401, { code: "session_not_found" });
  await isRestSessionEnded(refused);
  assert.deepEqual(await refused.json(), { code: "session_not_found" });
});

test("a PostgREST refusal only schedules the identity-safe check, never a direct sign-out", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./commonswarm.ts", import.meta.url), "utf8");
  assert.match(source, /if \(url\.pathname\.includes\("\/rest\/v1\/"\) && await isRestSessionEnded\(response\)\) checkSessionAfterRestRefusal\(\);/);
  assert.match(source, /function checkSessionAfterRestRefusal\(verify: \(\) => Promise<unknown> = \(\) => verifiedSession\(\)\)/);
  const body = source.slice(source.indexOf("function checkSessionAfterRestRefusal"), source.indexOf("const authFetch"));
  assert.doesNotMatch(body, /signOut|removeItem|_removeSession/, "removal happens only inside the SDK's verified check");
});
