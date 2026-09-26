/**
 * Every file:line this lane's comments cite must still point at what they claim.
 *
 * WHY THIS EXISTS. A review arm found that the standing-grant follow-up carried citations that
 * were correct when they were written — verified line by line against origin/main @ e3df06b —
 * and wrong by the time they landed, because the lane they were rebuilt on top of
 * (20260904000001_standing_grant_resume + its command-function changes) inserted ~275 lines
 * into supabase/functions/command/index.ts and pushed every later line down. Nothing about the
 * claims was wrong. The NUMBERS were, and only a human re-reading each one could tell.
 *
 * AGENTS.md already says "measure the artifact, not its name" and "an enumeration inside a
 * message must be generated, not typed". A line number is the same shape of defect: a hand-typed
 * pointer with no control on it, which drifts the moment anything above it moves, and which the
 * next reader trusts because it looks precise.
 *
 * So each entry below is a citation some comment makes, plus the token that must appear at that
 * line. When a citation drifts, this test names it. It does NOT check that the comment's
 * REASONING is right — only that the pointer still resolves. Read the prose yourself.
 *
 * Reached by `npm test` (named in the literal list) and by `npm run test:p1-cli` (glob).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

test("lane record marks the retired parent rule and reconciles Fold 1 probe counts", { timeout: 1_000 }, () => {
  const record = readFileSync(new URL("docs/evidence/2026-09-24-item-g-lane2a/LANE.md", root), "utf8");
  assert.match(record, /^\| Parent orphan evidence \(superseded by Fold 1 F3\) \|/m);
  const fold1 = record.split("## Fold 1\n")[1]?.split("The test controls live")[0];
  assert.ok(fold1);
  const rows = fold1.match(/^\| F\d+ \|.*$/gm) ?? [];
  assert.equal(rows.length, 7);
  const listed = rows.reduce((count, row) => count + (row.match(/exit 1/g)?.length ?? 0), 0);
  const counts = record.match(/table lists (\d+) reverted behaviours;.*there were (\d+) unique probes/);
  assert.ok(counts);
  assert.equal(Number(counts[1]), listed);
  assert.equal(Number(counts[2]), listed - 1, "F3 and F4 share the EPERM probe");
});

interface Citation {
  /** Where the citing comment lives, for the failure message. */
  citedBy: string;
  file: string;
  /** 1-based, inclusive. A single line is [n, n]. */
  lines: [number, number];
  /** Must appear somewhere inside that range. */
  contains: string;
}

const CITATIONS: Citation[] = [
  // src/cli.ts — C9 lazy ACP host loads (no static import on the session path)
  {
    citedBy: "identity client r6 C9 (lazy host/claude load)",
    file: "src/cli.ts",
    lines: [423, 423],
    contains: "import(\"./host/claude.js\")",
  },
  {
    citedBy: "identity client r6 C9 (lazy host/codex load)",
    file: "src/cli.ts",
    lines: [427, 427],
    contains: "import(\"./host/codex.js\")",
  },
  {
    citedBy: "identity client r6 C9 (lazy host/opencode load)",
    file: "src/cli.ts",
    lines: [431, 431],
    contains: "import(\"./host/opencode.js\")",
  },
  {
    citedBy: "identity client r6 C9 (claude canary classifier, host-free)",
    file: "src/cli.ts",
    lines: [415, 415],
    contains: "classifyClaudeCanaryFailure",
  },
  {
    citedBy: "identity client r6 C9 (explicit Claude executable path)",
    file: "src/cli.ts",
    lines: [6581, 6581],
    contains: "(await loadHostClaude()).resolveClaudeExecutable",
  },
  {
    citedBy: "identity client r6 C9 (explicit Codex executable path)",
    file: "src/cli.ts",
    lines: [6607, 6607],
    contains: "(await loadHostCodex()).resolveCodexExecutable",
  },
  {
    citedBy: "identity client r6 C9 (explicit OpenCode executable path)",
    file: "src/cli.ts",
    lines: [7229, 7229],
    contains: "(await loadHostOpenCode()).resolveOpenCodeExecutable",
  },
  // site/src/lib/agent-connect.ts — mintedHorizon and the retired-constant note
  {
    citedBy: "site/src/lib/agent-connect.ts (mintedHorizon)",
    file: "supabase/functions/command/index.ts",
    lines: [10906, 10906],
    contains: "horizon_expires_at: prepared.command.renewal_horizon_ms === null",
  },
  {
    citedBy: "site/src/lib/agent-connect.ts (mintedHorizon, replay)",
    file: "supabase/functions/command/index.ts",
    lines: [2712, 2712],
    contains: "horizon_expires_at: response.horizon_expires_at as string | null",
  },
  /* Two citations in agent-connect.ts had NO entry here, and both had drifted on main before the
     join-credential lane moved the file again: this table checks only the citations listed in it,
     never the citing file's prose. Added so these two are checked from now on. */
  {
    citedBy: "site/src/lib/agent-connect.ts (the mint's device binding)",
    file: "supabase/functions/command/index.ts",
    lines: [3241, 3250],
    contains: "device.revoked_at !== null",
  },
  {
    citedBy: "site/src/lib/agent-connect.ts (the agent scope check)",
    file: "supabase/functions/command/index.ts",
    lines: [9321, 9321],
    contains: "!auth.agent.scopes.includes(validation.command.kind)",
  },
  {
    citedBy: "site/src/lib/agent-connect.ts (the 400 message)",
    file: "supabase/functions/command/index.ts",
    lines: [2465, 2481],
    contains: "const valid = exactKeys(cmd, [",
  },
  // site/src/components/connect/agent-connect-mint.observer.test.ts
  {
    citedBy: "agent-connect-mint.observer.test.ts (timeboxed fallback, validator)",
    file: "supabase/functions/command/index.ts",
    lines: [2468, 2468],
    contains: '? "timeboxed"',
  },
  {
    citedBy: "agent-connect-mint.observer.test.ts (timeboxed fallback, prepared)",
    file: "supabase/functions/command/index.ts",
    lines: [3427, 3427],
    contains: 'renewal_kind: wire.renewal_kind ?? "timeboxed"',
  },
  {
    citedBy: "agent-connect-mint.observer.test.ts (standing needs an ABSENT horizon)",
    file: "supabase/functions/command/index.ts",
    lines: [2474, 2474],
    contains: 'renewalKind === "standing" && cmd.renewal_horizon_ms === undefined',
  },
  {
    citedBy: "agent-connect-mint.observer.test.ts (the 400)",
    file: "supabase/functions/command/index.ts",
    lines: [2528, 2528],
    contains: "mint_agent_token fields are malformed or out of bounds",
  },
  {
    citedBy: "agent-connect-mint.observer.test.ts (standing binds to the request device)",
    file: "supabase/functions/command/index.ts",
    lines: [4630, 4630],
    contains: "standing ? prepared.wire.device_id : null",
  },
  // supabase/functions/command/index.ts — the resume handler's own comment
  {
    citedBy: "command/index.ts (resume handler, the pattern it copies)",
    file: "supabase/functions/command/index.ts",
    lines: [3681, 3681],
    contains: "grant_preflight_code: (preflight[0]?.code ?? null)",
  },
  {
    citedBy: "command/index.ts (resume handler) + p1-server test",
    file: "supabase/migrations/20260904000001_standing_grant_resume.sql",
    lines: [551, 606],
    contains: "RETURN 'renewal_grant_not_suspended'",
  },
  {
    citedBy: "command/index.ts (resume handler, the mutation it precedes)",
    file: "supabase/migrations/20260904000001_standing_grant_resume.sql",
    lines: [608, 612],
    contains: "UPDATE swarm.renewal_grants",
  },
  {
    citedBy: "p1-server test (NULL is the success value)",
    file: "supabase/migrations/20260904000001_standing_grant_resume.sql",
    lines: [614, 614],
    contains: "RETURN NULL;",
  },
  // src/protocol/workspace-commands.ts — the one definition of "paused"
  {
    citedBy: "src/protocol/workspace-commands.ts (suspension_active)",
    file: "supabase/migrations/20260904000001_standing_grant_resume.sql",
    lines: [85, 89],
    contains: "GENERATED ALWAYS AS (",
  },
];

test("every file:line this lane cites still points at what it claims", { timeout: 5_000 }, () => {
  const failures: string[] = [];
  for (const c of CITATIONS) {
    const path = fileURLToPath(new URL(c.file, root));
    const all = readFileSync(path, "utf8").split("\n");
    const [from, to] = c.lines;
    /* POSITIVE CONTROL: the range has to exist at all. Without this a citation past the end of
       a shrunken file would slice to "" and read as a plain content mismatch, which sends the
       next reader looking for the wrong thing. */
    assert.ok(
      to <= all.length,
      `${c.file}:${from}-${to} is past the end of the file (${all.length} lines)`,
    );
    const slice = all.slice(from - 1, to).join("\n");
    if (!slice.includes(c.contains)) {
      const actual = all.findIndex((line) => line.includes(c.contains));
      failures.push(
        `${c.citedBy}\n    cites ${c.file}:${from}${from === to ? "" : `-${to}`}` +
          ` for ${JSON.stringify(c.contains)}\n    but that text is ` +
          (actual === -1 ? "nowhere in the file" : `at line ${actual + 1}`),
      );
    }
  }
  assert.equal(
    failures.length,
    0,
    `citations drifted:\n\n${failures.join("\n\n")}\n`,
  );
});

test("stdout inspection timeout citation includes the bounded exec option", { timeout: 1_000 }, () => {
  const mapping = JSON.parse(readFileSync(fileURLToPath(new URL("scripts/timeout-table/mapping.json", root)), "utf8"));
  const citation = mapping.refs.HEAD.rows["src/stdout-consumer.ts:timeoutMs"].citation as string;
  const match = citation.match(/^src\/stdout-consumer\.ts:(\d+)-(\d+)$/);
  assert.ok(match, citation);
  const source = readFileSync(fileURLToPath(new URL("src/stdout-consumer.ts", root)), "utf8").split("\n");
  assert.match(source.slice(Number(match[1]) - 1, Number(match[2])).join("\n"), /timeout: timeoutMs/);
});

test("live-session timeout row includes resume and every context-file watcher start", { timeout: 1_000 }, () => {
  const mapping = JSON.parse(readFileSync(fileURLToPath(new URL("scripts/timeout-table/mapping.json", root)), "utf8"));
  const row = mapping.refs.HEAD.rows["src/cloud/live-session-context.ts:timeoutMs"];
  assert.match(row.detail, /every resume/);
  assert.match(row.detail, /every watcher start with a context file on the host/);
  const source = readFileSync(fileURLToPath(new URL("src/cli.ts", root)), "utf8");
  assert.match(source, /verifiedLiveSessionContexts\(/);
});
