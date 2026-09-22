/**
 * Add an agent invite. The site test script globs this file.
 *
 * Flag off is today's handoff. Flag on mints, builds the paste with h0AgentPaste,
 * keeps the credential out of the document URL, shows it once, and revokes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { h0AgentPaste } from "../../../../src/h0/paste";
import {
  AGENT_JOIN_SEAT_CAP_MAX,
  AGENT_JOIN_SEAT_CAP_MIN,
  AGENT_JOIN_TTL_MAX_HOURS,
  AGENT_JOIN_TTL_MIN_HOURS,
  joinInviteLimitSentence,
  joinInviteResultLead,
  mintAgentJoinCredentialCommand,
  MINT_AGENT_JOIN_CREDENTIAL_FIELDS,
  revokeAgentJoinCredentialCommand,
  REVOKE_AGENT_JOIN_CREDENTIAL_FIELDS,
} from "../../../../src/protocol/agent-join-limits";
import { h0AgentDocumentUrl } from "../../../../src/protocol/h0-agent-document-url";
import { CLIENT_PROTOCOL_VERSION } from "../../lib/commonswarm";
import {
  concealJoinInvite,
  h0LinkJoinFlagEnabled,
  selectAddAgentHandoff,
} from "../../lib/h0-link-join-flag-meaning";
import { dashboardAgentPrompt } from "./agent-prompt";
import { assertJoinLimitsMatchEnforcement } from "../../../../tests/p1-cli/h0-link-join-limits";

const DEPLOYMENT_URL = "https://api.commonswarm.com";
const WORKSPACE = "9c8b7a65-4321-4def-8abc-0123456789ab";
const JOIN_ID = "11111111-1111-4111-8111-111111111111";
const LOCATOR = "b".repeat(22);
const SECRET = `swm_join_${"A".repeat(43)}`;
const EXPIRES = "2026-09-23T12:00:00.000Z";

const TOKEN = `swm_agt_${"A_".repeat(21) + "A"}`;
const TODAY = {
  credential: {
    principalId: "11111111-1111-4111-8111-111111111111",
    principalName: "Observer",
    tokenId: "22222222-2222-4222-8222-222222222222",
    runId: "33333333-3333-4333-8333-333333333333",
    token: TOKEN,
    expiresAt: Date.parse("2099-07-29T23:00:00Z"),
    renews: true,
    horizonExpiresAt: null,
    grantKind: "standing" as const,
  },
  workspaceId: "44444444-4444-4444-8444-444444444444",
  workspaceName: "Observer room",
  deploymentUrl: "https://example.supabase.co",
  anonKey: "TEST_ONLY_PUBLIC_KEY",
};

(globalThis as { document?: unknown }).document = {
  querySelector(selector: string) {
    if (selector.includes("commonswarm:url")) return { content: DEPLOYMENT_URL };
    if (selector.includes("commonswarm:anon-key")) return { content: "anon-test-key" };
    return null;
  },
};

const { mintJoinInvite, revokeJoinInvite, revealFromMintBody, JoinInviteWithheld, JoinInviteAlreadyRevoked } =
  await import("../../lib/h0-link-join");

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const sent: Sent[] = [];
let status = 200;
let payload: Record<string, unknown> = {};
const realFetch = globalThis.fetch;

function acceptedMint(): Record<string, unknown> {
  return {
    status: "accepted",
    ok: true,
    event_ids: [],
    join_credential_id: JOIN_ID,
    locator: LOCATOR,
    seat_cap: AGENT_JOIN_SEAT_CAP_MAX,
    seats_used: 0,
    expires_at: EXPIRES,
    events: [],
    min_client_version: "0.1.0",
    join_credential: SECRET,
  };
}

beforeEach(() => {
  sent.length = 0;
  status = 200;
  payload = acceptedMint();
  globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { status, text: async () => JSON.stringify(payload) };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const SESSION = { access_token: "jwt-test", user: { id: "user" } } as never;
const CONNECT = readFileSync(new URL("./AgentConnect.astro", import.meta.url), "utf8");
const LIMITS = readFileSync(
  fileURLToPath(new URL("../../../../src/protocol/agent-join-limits.ts", import.meta.url)),
  "utf8",
);
const FLAG = readFileSync(new URL("../../lib/h0-link-join-flag.ts", import.meta.url), "utf8");
const REPO = fileURLToPath(new URL("../../../..", import.meta.url));

function stripFlagged(source: string): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    const ifAt = source.indexOf("if (h0LinkJoinEnabled)", i);
    const exprAt = source.indexOf("{h0LinkJoinEnabled &&", i);
    let at = -1;
    let kind: "if" | "expr" = "if";
    if (ifAt === -1 && exprAt === -1) {
      result += source.slice(i);
      break;
    }
    if (ifAt === -1 || (exprAt !== -1 && exprAt < ifAt)) {
      at = exprAt;
      kind = "expr";
    } else {
      at = ifAt;
      kind = "if";
    }
    result += source.slice(i, at);
    const open = kind === "expr" ? at : source.indexOf("{", at);
    result += "";
    i = matchBrace(source, open) + 1;
  }
  return result;
}

function matchBrace(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced brace");
}

function template(source: string): string {
  const start = source.indexOf("<agent-connect");
  const end = source.indexOf("</agent-connect>");
  return source.slice(start, end);
}

function dataActions(html: string): string[] {
  return [...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]!);
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h2\b[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1]!.trim());
}

function copyMethod(source: string): string {
  const start = source.indexOf("    async #copy()");
  const end = source.indexOf("\n  }\n", start);
  assert.ok(start !== -1 && end !== -1);
  return source.slice(start, end);
}

function filesContaining(needle: string): string[] {
  const found: string[] = [];
  const skip = new Set(["node_modules", "dist", ".git", "docs"]);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|astro|md|mjs|js)$/.test(name)) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes(needle)) found.push(relative(REPO, path));
    }
  };
  walk(join(REPO, "site"));
  walk(join(REPO, "src"));
  walk(join(REPO, "tests"));
  return found.sort();
}

test("the invite flag is off unless the value is exactly 1, and off keeps today's prompt", () => {
  for (const flag of [undefined, "", "0", "true", "yes", "1 ", "01", "2"]) {
    assert.equal(h0LinkJoinFlagEnabled(flag), false, JSON.stringify(flag));
  }
  assert.equal(h0LinkJoinFlagEnabled("1"), true);
  const today = dashboardAgentPrompt(TODAY);
  assert.equal(selectAddAgentHandoff(false, today, "JOIN PASTE"), today);
  assert.equal(selectAddAgentHandoff(true, today, "JOIN PASTE"), "JOIN PASTE");

  const expr = FLAG.match(/export const h0LinkJoinEnabled = (.+);/)?.[1];
  assert.ok(expr);
  const compiled = new Function(
    "flag",
    `return ${expr.replace("import.meta.env.PUBLIC_H0_LINK_JOIN", "flag")};`,
  ) as (flag: string | undefined) => boolean;
  for (const flag of [undefined, "", "0", "true", "1"]) {
    assert.equal(compiled(flag), h0LinkJoinFlagEnabled(flag));
  }
});

test("flag off matches today's Add an agent controls and token handoff", () => {
  const main = execFileSync(
    "git",
    ["show", "a103a512:site/src/components/connect/AgentConnect.astro"],
    { encoding: "utf8" },
  );
  const stripped = stripFlagged(CONNECT);
  assert.deepEqual(dataActions(template(stripped)), dataActions(template(main)));
  assert.deepEqual(headings(template(stripped)), headings(template(main)));
  assert.equal(copyMethod(CONNECT), copyMethod(main));
  assert.match(stripped, /this\.#prompt = dashboardAgentPrompt\(promptInput\)/);
  assert.match(CONNECT, /#copyLabel = "Copy prompt"/);
  assert.equal(stripped.includes("attachLinkJoin("), false);
  assert.doesNotMatch(CONNECT, /h0\/agent-doc/);
  assert.doesNotMatch(CONNECT, /mint_agent_join_credential/);
});

test("PUBLIC_H0_LINK_JOIN is read in one file", () => {
  const hits = filesContaining("PUBLIC_H0_LINK_JOIN");
  assert.deepEqual(hits, [
    "site/README.md",
    "site/src/components/connect/h0-link-join.observer.test.ts",
    "site/src/lib/h0-link-join-flag.ts",
  ]);
  assert.equal(FLAG.match(/import\.meta\.env\.PUBLIC_H0_LINK_JOIN/g)?.length, 1);
});

test("the invite sentence is built from the server limits", () => {
  assertJoinLimitsMatchEnforcement();
  assert.equal(
    joinInviteLimitSentence(),
    `Up to ${AGENT_JOIN_SEAT_CAP_MAX} agents can join. This invite lasts ${AGENT_JOIN_TTL_MAX_HOURS} hours.`,
  );
  const fn = LIMITS.slice(
    LIMITS.indexOf("export function joinInviteLimitSentence"),
    LIMITS.indexOf("export function joinInviteResultLead"),
  );
  assert.match(fn, /AGENT_JOIN_SEAT_CAP_MAX/);
  assert.match(fn, /AGENT_JOIN_TTL_MAX_HOURS/);
  assert.doesNotMatch(fn, /\d/);
  const lead = joinInviteResultLead({
    seatCap: AGENT_JOIN_SEAT_CAP_MIN,
    expiresAt: EXPIRES,
  });
  assert.match(lead, new RegExp(`Up to ${AGENT_JOIN_SEAT_CAP_MIN} agents can join`));
  assert.match(lead, new RegExp(EXPIRES));
  assert.match(CONNECT, /joinInviteLimitSentence\(\)/);
  assert.match(CONNECT, /The joining agent chooses its name/);
});

test("mint sends seat_cap and ttl_hours inside the server limits and no credential", async () => {
  const reveal = await mintJoinInvite({
    session: SESSION,
    workspaceId: WORKSPACE,
    commandId: "web_test_command",
  });
  assert.equal(sent.length, 1);
  const envelope = JSON.parse(sent[0]!.body) as Record<string, unknown>;
  const command = envelope.command as Record<string, unknown>;
  assert.deepEqual(command, mintAgentJoinCredentialCommand());
  assert.deepEqual(Object.keys(command).sort(), [...MINT_AGENT_JOIN_CREDENTIAL_FIELDS].sort());
  assert.equal(command.seat_cap, AGENT_JOIN_SEAT_CAP_MAX);
  assert.equal(command.ttl_hours, AGENT_JOIN_TTL_MAX_HOURS);
  assert.ok((command.seat_cap as number) >= AGENT_JOIN_SEAT_CAP_MIN);
  assert.ok((command.ttl_hours as number) >= AGENT_JOIN_TTL_MIN_HOURS);
  assert.equal(envelope.workspace_id, WORKSPACE);
  assert.deepEqual(envelope.stream, { kind: "workspace" });
  assert.equal(envelope.client_version, CLIENT_PROTOCOL_VERSION);
  assert.equal(envelope.command_id, "web_test_command");
  assert.equal(sent[0]!.url, `${DEPLOYMENT_URL}/functions/v1/command`);
  assert.equal(sent[0]!.headers.authorization, "Bearer jwt-test");
  assert.equal(sent[0]!.headers.apikey, "anon-test-key");
  assert.equal(sent[0]!.body.includes(SECRET), false);
  assert.equal(sent[0]!.body.includes(LOCATOR), false);
  assert.equal(sent[0]!.url.includes("h0/agent-doc"), false);

  const documentUrl = h0AgentDocumentUrl(DEPLOYMENT_URL, LOCATOR);
  assert.equal(reveal.documentUrl, documentUrl);
  assert.equal(reveal.documentUrl, `${DEPLOYMENT_URL}/functions/v1/h0/agent-doc/${LOCATOR}`);
  assert.equal(reveal.paste, h0AgentPaste({
    joinCredential: SECRET,
    documentUrl,
  }));
  assert.equal(reveal.paste?.includes(SECRET), true);
  assert.equal(reveal.documentUrl.includes(SECRET), false);
  assert.equal(reveal.documentUrl.includes("swm_join_"), false);
  assert.equal(reveal.withheld, false);
  assert.match(reveal.lead, new RegExp(EXPIRES));
  assert.match(reveal.lead, /This page shows the credential once/);
});

test("a missing credential is not shown again, and a locator that carries it is refused", () => {
  const missing = revealFromMintBody({
    ...acceptedMint(),
    join_credential: undefined,
  }, DEPLOYMENT_URL);
  assert.equal(missing.withheld, true);
  assert.equal(missing.paste, null);
  assert.equal(missing.joinCredentialId, JOIN_ID);
  assert.equal(JSON.stringify(missing).includes("swm_join_"), false);

  const overlapping = "A".repeat(22);
  assert.throws(
    () => revealFromMintBody({
      ...acceptedMint(),
      locator: overlapping,
      join_credential: SECRET,
    }, DEPLOYMENT_URL),
    (error: unknown) => {
      assert.ok(error instanceof JoinInviteWithheld);
      assert.equal(error.joinCredentialId, JOIN_ID);
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(error.message.includes(overlapping), false);
      return true;
    },
  );
});

test("the paste is shown once: conceal drops it and keeps the id for revoke", () => {
  const reveal = revealFromMintBody(acceptedMint(), DEPLOYMENT_URL);
  const hidden = concealJoinInvite({
    paste: reveal.paste,
    joinCredentialId: reveal.joinCredentialId,
  });
  assert.equal(hidden.paste, null);
  assert.equal(hidden.joinCredentialId, JOIN_ID);
  assert.equal(JSON.stringify(hidden).includes(SECRET), false);
  assert.match(CONNECT, /this\.#prompt = reveal\.paste/);
  assert.match(CONNECT, /this\.#text\("prompt", reveal\.paste\)/);
  assert.match(CONNECT, /concealJoinInvite\(/);
  assert.match(CONNECT, /this\.#text\("prompt", ""\)/);
});

test("revoke sends join_credential_id and nothing else", async () => {
  const mixed = "11111111-1111-4111-8111-11111111111A";
  await revokeJoinInvite({
    session: SESSION,
    workspaceId: WORKSPACE,
    joinCredentialId: mixed,
    commandId: "web_revoke_command",
  });
  assert.equal(sent.length, 1);
  const envelope = JSON.parse(sent[0]!.body) as Record<string, unknown>;
  const command = envelope.command as Record<string, unknown>;
  assert.deepEqual(command, revokeAgentJoinCredentialCommand(mixed));
  assert.deepEqual(Object.keys(command).sort(), [...REVOKE_AGENT_JOIN_CREDENTIAL_FIELDS].sort());
  assert.equal(command.join_credential_id, mixed.toLowerCase());
  assert.equal(envelope.workspace_id, WORKSPACE);
  assert.deepEqual(envelope.stream, { kind: "workspace" });
  assert.equal(envelope.client_version, CLIENT_PROTOCOL_VERSION);
  assert.equal(envelope.command_id, "web_revoke_command");
  assert.equal(sent[0]!.url, `${DEPLOYMENT_URL}/functions/v1/command`);
  assert.equal(sent[0]!.body.includes(SECRET), false);
  assert.equal(sent[0]!.body.includes("h0/agent-doc"), false);
});

test("a revoke the server already finished is the revoked state, and errors omit the credential", async () => {
  status = 409;
  payload = { error: "already_revoked", join_credential: SECRET };
  await assert.rejects(
    () => revokeJoinInvite({
      session: SESSION,
      workspaceId: WORKSPACE,
      joinCredentialId: JOIN_ID,
      commandId: "web_revoke_again",
    }),
    (error: unknown) => {
      assert.ok(error instanceof JoinInviteAlreadyRevoked);
      assert.equal(error.message.includes(SECRET), false);
      return true;
    },
  );

  status = 400;
  payload = { error: "bad", join_credential: SECRET };
  await assert.rejects(
    () => mintJoinInvite({
      session: SESSION,
      workspaceId: WORKSPACE,
      commandId: "web_mint_again",
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.message.includes(SECRET), false);
      return true;
    },
  );
});
