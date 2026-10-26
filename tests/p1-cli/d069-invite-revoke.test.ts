import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

/* D-069. An invitation is a bearer capability with a TTL of up to seven days, and it was the only
 * capability in this product that could not be withdrawn — `principal revoke`, `token revoke` and
 * `link revoke` all existed. The reducer and the command edge had supported `revoke_invitation`
 * the whole time (9 references in the edge, 0 in the CLI, against a control proving the grep
 * worked). Nothing reached it, so a link that was forwarded, pasted into a chat, or read over a
 * shoulder had no remedy at all.
 *
 * Verified end to end against production before these were written: a fresh invitation was
 * created, revoked ("Invitation revoked. The link no longer works…"), and a replay of the same
 * revoke refused with `invitation_not_live` — which is what proves the first call changed state
 * rather than merely returning success. Two further live refusals confirmed the authority checks:
 * `role_forbidden` from a member of someone else's workspace, and `invitation_not_live` for an
 * invitation the invitee had already accepted.
 *
 * These tests hold the CLI surface, which is the part that was missing. */

async function cli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const INVITATION = "00000000-0000-4000-8000-000000000009";

test("D-069: `invite revoke` reaches its work — the subcommand and its flag exist", async () => {
  const result = await cli([
    "invite",
    "revoke",
    "--workspace-id",
    WORKSPACE,
    "--invitation-id",
    INVITATION,
  ]);

  assert.doesNotMatch(result.stderr, /unknown option: --invitation-id/);
  assert.doesNotMatch(result.stderr, /too many positional arguments/);

  // CONTROL, same subcommand and shape. Without it, the assertions above are equally satisfied
  // by a verb that validates nothing. The control carries a VALUE because an unrecognised flag
  // is not in BOOLEAN_FLAGS and would otherwise be rejected by the parser before the shape gate,
  // testing the parser rather than the validator.
  const control = await cli([
    "invite",
    "revoke",
    "--workspace-id",
    WORKSPACE,
    "--invitation-id",
    INVITATION,
    "--not-a-real-flag",
    "x",
  ]);
  assert.match(control.stderr, /unknown option: --not-a-real-flag/);
});
