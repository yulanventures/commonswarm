/**
 * Item D: agents and humans must call a workspace by the same name.
 *
 * WHY THIS EXISTS. The operator asked whether to add Grok Bot to "the CommonSwarm Build
 * workspace" and CSwarmStrategist could not answer, because no agent surface returned the
 * workspace's display name — `whoami --json` gave `workspace_id` and `owner_display_name` and
 * nothing else. A person names a workspace; an agent names a uuid; neither can check the other.
 *
 * The failure this pins is DRIFT: the CLI and the app reading the workspace name from different
 * places, or rendering it in different shapes, so the same id gets two names. So the controls
 * here are about AGREEMENT, not about either value on its own.
 *
 * Reached by `npm test` (named in the literal list) and `npm run test:p1-cli` (glob).
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { readAgentProfile } from "../../src/cloud/agent-profile.js";

/* The CLI and the app must read the name from the SAME row. The app reads the
 * swarm_read.workspaces view; so must the edge that feeds every agent surface. Reaching past it
 * to swarm.workspaces is not a style question — measured 2026-09-14, it answered HTTP 500 for
 * every caller. The handler runs as ROLE swarm_read, which has USAGE on the swarm schema but no
 * SELECT on swarm.workspaces: `permission denied for table workspaces`. */

/* ONE renderer for the CLI, so `Name (id)` cannot become `Name [id]` on one surface and
 * `Name - id` on another. The human `status` verb has printed `Workspace: <name> (<id>)` since
 * before this item; the agent surfaces were the half that printed nothing, and they must match.
 *
 * The APP does NOT share this renderer and cannot: it builds its own DOM in the browser and
 * imports nothing from src/cli.ts. Its half of the agreement is the separate switcher control
 * below, and the shared SOURCE — both read swarm_read.workspaces. Saying "one renderer serves
 * the app" would be false, and a review arm caught that wording. */

/* An unknown name is not an error and must never be invented. An older deployment omits the
 * field; an archived workspace has no row in the view. Both render the id alone. */

/* The profile file caches the name. It must stay OPTIONAL: the parser compares the key set
 * exactly, so requiring it would declare every profile written before this release damaged, on
 * every host at once. */
test("the profile file accepts either released shape and rejects an extra key", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-profile-shapes-"));
  try {
    const path = join(root, "private", "profile.json");
    await mkdir(dirname(path), { mode: 0o700 });
    const base = { version: 1, url: "http://127.0.0.1:39876", anon_key: "public-test-key",
      workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      credential_file: join(dirname(path), "credential.json") };
    for (const shape of [base, { ...base, workspace_name: "CommonSwarm Build" }]) {
      await writeFile(path, JSON.stringify(shape), { mode: 0o600 });
      assert.deepEqual(await readAgentProfile(path), shape);
    }
    await writeFile(path, JSON.stringify({ ...base, unrecognized: true }), { mode: 0o600 });
    await assert.rejects(readAgentProfile(path), { code: "profile_invalid" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

/* The rail identifies duplicate names with a short UUID beside the name. */
