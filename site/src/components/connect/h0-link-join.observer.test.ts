/**
 * Add an agent invite. The site test script globs this file.
 *
 * Flag off keeps today's handoff. Flag on mints, checks the paste by
 * properties, shows the credential once, and revokes.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import ts from "typescript";
import {
  joinInviteBeforeDoneSentences,
  joinInviteLimitSentence,
  joinInviteLiveLimitMessage,
  joinInviteLostMintMessage,
  joinInviteResultLead,
  joinSeatNoun,
} from "../../../../src/protocol/agent-join-limits";
import { WEB_CLIENT_VERSION } from "../../lib/commonswarm";
import { LINK_JOIN_LOAD_ERROR, callLinkJoin } from "../../lib/h0-link-join-load";
import {
  concealJoinInvite,
  dismissShownJoin,
  shownJoinAfterRevoke,
} from "../../lib/h0-link-join-flag-meaning";
import { assertJoinLimitsMatchEnforcement } from "../../../../tests/p1-cli/h0-link-join-limits";

const DEPLOYMENT_URL = "https://api.commonswarm.com";
const WORKSPACE = "9c8b7a65-4321-4def-8abc-0123456789ab";
const JOIN_ID = "11111111-1111-4111-8111-111111111111";
const LOCATOR = "b".repeat(22);
const SECRET_BODY = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4O";
const SECRET = `swm_join_${SECRET_BODY}`;
const EXPIRES = "2026-09-23T12:00:00.000Z";

const TODAY_ACTIONS = [
  "retry",
  "create-another",
  "mint",
  "copy",
  "download-connection",
  "done",
];
const TODAY_HEADINGS = [
  "Name your agent.",
  "Checking your session…",
  "Not available",
  "Creating your agent prompt.",
  "Your agent prompt is ready.",
];

(globalThis as { document?: unknown }).document = {
  querySelector(selector: string) {
    if (selector.includes("commonswarm:url")) return { content: DEPLOYMENT_URL };
    if (selector.includes("commonswarm:anon-key")) return { content: "anon-test-key" };
    return null;
  },
};

const {
  mintJoinInvite,
  revokeJoinInvite,
  revealFromMintBody,
  startJoinMint,
  startJoinRevoke,
  shownSeatCap,
  JOIN_INVITE_REVOKED_MESSAGE,
  JoinInviteError,
  JoinInviteWithheld,
  JoinInviteAlreadyRevoked,
} = await import("../../lib/h0-link-join");

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface RevokeApi {
  workspaceId: () => string;
  session: () => Promise<unknown>;
  tryBegin: () => boolean;
  end: () => void;
  setMintPending: (pending: boolean) => void;
  showInvite: () => void;
  formError: (message: string | null) => void;
  note: (message: string) => void;
  markRevoked: (message: string, inviteId: string) => void;
  inviteId: () => string | null;
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
    seat_cap: 10,
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
const COMMANDS = readFileSync(
  fileURLToPath(new URL("../../../../src/protocol/workspace-commands.ts", import.meta.url)),
  "utf8",
);
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

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(`\n    ${signature}`);
  assert.ok(start !== -1, signature);
  let end = source.length;
  for (const mark of ["\n    #", "\n    async #"]) {
    const at = source.indexOf(mark, start + signature.length);
    if (at !== -1 && at < end) end = at;
  }
  return source.slice(start + 1, end);
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

function workspaceCommandKeys(kind: string): string[] {
  const file = ts.createSourceFile("workspace-commands.ts", COMMANDS, ts.ScriptTarget.Latest, true);
  const found: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeLiteralNode(node)) {
      const names: string[] = [];
      let kindValue: string | undefined;
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || member.name === undefined) continue;
        const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
          ? member.name.text
          : undefined;
        if (name === undefined) continue;
        names.push(name);
        if (
          name === "kind"
          && member.type
          && ts.isLiteralTypeNode(member.type)
          && ts.isStringLiteral(member.type.literal)
        ) {
          kindValue = member.type.literal.text;
        }
      }
      if (kindValue === kind) found.push(names);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(found.length, 1, `workspace command shape ${kind}`);
  return found[0]!.slice().sort();
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function revokeApi(state: { inviteId: string | null; wrote: boolean; message: string }): RevokeApi {
  return {
    workspaceId: () => WORKSPACE,
    session: async () => SESSION,
    tryBegin: () => true,
    end: () => {},
    setMintPending: () => {},
    showInvite: () => {},
    formError: () => {},
    note: (message: string) => {
      state.wrote = true;
      state.message = message;
    },
    markRevoked: (message) => {
      state.wrote = true;
      state.message = message;
    },
    inviteId: () => state.inviteId,
  };
}

test("the invite flag is on only for the string 1", () => {
  const expr = FLAG.match(/export const h0LinkJoinEnabled = (.+);/)?.[1];
  assert.equal(expr, 'import.meta.env.PUBLIC_H0_LINK_JOIN === "1"');
  const compiled = new Function(
    "flag",
    `return ${expr.replace("import.meta.env.PUBLIC_H0_LINK_JOIN", "flag")};`,
  ) as (flag: string | undefined) => boolean;
  for (const flag of [undefined, "", "0", "true", " 1", "yes", "1 ", "01", "2"]) {
    assert.equal(compiled(flag), false, JSON.stringify(flag));
  }
  assert.equal(compiled("1"), true);
});

test("flag off matches today's Add an agent controls and token handoff", () => {
  const stripped = stripFlagged(CONNECT);
  assert.deepEqual(dataActions(template(CONNECT)), [
    ...TODAY_ACTIONS.slice(0, 3),
    "mint-join",
    ...TODAY_ACTIONS.slice(3, 5),
    "revoke-join",
    "done",
  ]);
  assert.deepEqual(dataActions(template(stripped)), TODAY_ACTIONS);
  assert.deepEqual(headings(template(stripped)), TODAY_HEADINGS);
  const copy = copyMethod(CONNECT);
  assert.equal(copyMethod(stripped), copy);
  assert.match(copy, /navigator\.clipboard\.writeText\(this\.#prompt\)/);
  assert.match(copy, /Copied\. Paste the whole prompt into your AI assistant\./);
  assert.doesNotMatch(copy, /h0LinkJoinEnabled|inviteId|loadLinkJoin/);
  assert.match(stripped, /this\.#prompt = dashboardAgentPrompt\(promptInput\)/);
  assert.match(CONNECT, /#copyLabel = "Copy prompt"/);
  assert.equal(stripped.includes("loadLinkJoin()"), false);
  assert.equal(stripped.includes("startJoinMint("), false);
  assert.equal(stripped.includes("startJoinRevoke("), false);
  assert.equal(CONNECT.includes('from "../../lib/h0-link-join"'), false);
  assert.match(CONNECT, /const joining = loadLinkJoin\(\)/);
  assert.doesNotMatch(CONNECT, /h0\/agent-doc/);
  assert.doesNotMatch(CONNECT, /mint_agent_join_credential/);
  assert.doesNotMatch(CONNECT, /joinCredential/);
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

test("the invite sentence is the current server limits", async () => {
  await assertJoinLimitsMatchEnforcement();
  assert.equal(
    joinInviteLimitSentence(),
    "Up to 10 agents can join. This invite lasts 24 hours.",
  );
  const fn = LIMITS.slice(
    LIMITS.indexOf("export function joinInviteLimitSentence"),
    LIMITS.indexOf("export function joinInviteResultLead"),
  );
  assert.match(fn, /AGENT_JOIN_SEAT_CAP_MAX/);
  assert.match(fn, /AGENT_JOIN_TTL_MAX_HOURS/);
  assert.match(fn, /joinSeatNoun\(/);
  assert.doesNotMatch(fn, /\d/);
  assert.doesNotMatch(fn, /agents/);
  const lead = joinInviteResultLead({
    seatCap: 1,
    expiresAt: EXPIRES,
  });
  assert.match(lead, /Up to 1 agent can join/);
  assert.doesNotMatch(lead, /Up to 1 agents/);
  assert.equal(joinSeatNoun(1), "agent");
  assert.equal(joinSeatNoun(2), "agents");
  assert.match(lead, new RegExp(EXPIRES));
  assert.match(lead, /This page shows the credential once/);
  for (const sentence of joinInviteBeforeDoneSentences()) {
    assert.equal(lead.includes(sentence), true, sentence);
  }
  assert.equal(joinInviteBeforeDoneSentences()[0], "Done leaves the invite active.");
  const show = methodBody(CONNECT, "#showJoinInvite(");
  assert.match(show, /querySelector\("\.ac__result-lead"\)/);
  assert.match(show, /lead\.textContent = reveal\.lead/);
  assert.match(CONNECT, /joinInviteLimitSentence\(\)/);
  assert.match(CONNECT, /The joining agent chooses its name/);
});

test("mint sends the join credential command and no credential", async () => {
  const reveal = await mintJoinInvite({
    session: SESSION,
    workspaceId: WORKSPACE,
    commandId: "web_test_command",
  });
  assert.equal(sent.length, 1);
  const envelope = JSON.parse(sent[0]!.body) as Record<string, unknown>;
  const command = envelope.command as Record<string, unknown>;
  assert.deepEqual(command, {
    kind: "mint_agent_join_credential",
    seat_cap: 10,
    ttl_hours: 24,
  });
  assert.deepEqual(Object.keys(command).sort(), workspaceCommandKeys("mint_agent_join_credential"));
  assert.equal(envelope.workspace_id, WORKSPACE);
  assert.deepEqual(envelope.stream, { kind: "workspace" });
  assert.equal(envelope.client_version, WEB_CLIENT_VERSION);
  assert.equal(envelope.command_id, "web_test_command");
  assert.equal(sent[0]!.url, `${DEPLOYMENT_URL}/functions/v1/command`);
  assert.equal(sent[0]!.headers.authorization, "Bearer jwt-test");
  assert.equal(sent[0]!.headers.apikey, "anon-test-key");
  assert.equal(sent[0]!.body.includes(SECRET), false);
  assert.equal(sent[0]!.body.includes(LOCATOR), false);
  assert.equal(sent[0]!.url.includes("h0/agent-doc"), false);

  assert.equal(reveal.documentUrl, `${DEPLOYMENT_URL}/functions/v1/h0/agent-doc/${LOCATOR}`);
  const paste = reveal.paste;
  assert.equal(typeof paste, "string");
  assert.ok(paste);
  assert.equal(countOf(paste, SECRET), 1);
  assert.equal(paste.includes(reveal.documentUrl), true);
  assert.equal(reveal.documentUrl.includes(SECRET), false);
  assert.equal(SECRET_BODY.length, 43);
  for (let i = 0; i + 12 <= SECRET_BODY.length; i += 1) {
    const piece = SECRET_BODY.slice(i, i + 12);
    assert.equal(
      reveal.documentUrl.toLowerCase().includes(piece.toLowerCase()),
      false,
      piece,
    );
  }
  assert.equal(reveal.withheld, false);
  assert.equal(reveal.inviteId, JOIN_ID);
  assert.match(reveal.lead, new RegExp(EXPIRES));
  assert.match(reveal.lead, /This page shows the credential once/);
});

test("the shown seat cap stays inside 1..10", () => {
  assert.equal(shownSeatCap(1, 7), 1);
  assert.equal(shownSeatCap(10, 7), 10);
  for (const bad of [0, -1, 11, 1.5, Number.NaN, "10", null, undefined]) {
    assert.equal(shownSeatCap(bad, 7), 7, JSON.stringify(bad));
  }
  const low = revealFromMintBody({ ...acceptedMint(), seat_cap: 0 }, DEPLOYMENT_URL);
  assert.equal(low.lead.includes("Up to 10 agents can join."), true);
  assert.equal(low.lead.includes("Up to 0 agents"), false);
  const one = revealFromMintBody({ ...acceptedMint(), seat_cap: 1 }, DEPLOYMENT_URL);
  assert.equal(one.lead.includes("Up to 1 agent can join."), true);
  assert.equal(one.lead.includes("Up to 1 agents"), false);
  const two = revealFromMintBody({ ...acceptedMint(), seat_cap: 2 }, DEPLOYMENT_URL);
  assert.equal(two.lead.includes("Up to 2 agents can join."), true);
});

test("a missing credential is not shown again, and a locator that carries it is refused", () => {
  const missing = revealFromMintBody({
    ...acceptedMint(),
    join_credential: undefined,
  }, DEPLOYMENT_URL);
  assert.equal(missing.withheld, true);
  assert.equal(missing.paste, null);
  assert.equal(missing.inviteId, JOIN_ID);
  assert.equal(JSON.stringify(missing).includes("swm_join_"), false);
  for (const sentence of joinInviteBeforeDoneSentences()) {
    assert.equal(missing.lead.includes(sentence), true, sentence);
  }

  const overlapping = SECRET_BODY.slice(0, 22);
  assert.equal(overlapping.length, 22);
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
      for (const sentence of joinInviteBeforeDoneSentences()) {
        assert.equal(error.message.includes(sentence), true, sentence);
      }
      return true;
    },
  );
});

test("the paste is shown once: conceal drops it and keeps the id for revoke", () => {
  const reveal = revealFromMintBody(acceptedMint(), DEPLOYMENT_URL);
  assert.ok(reveal.paste);
  const hidden = concealJoinInvite({
    paste: reveal.paste,
    inviteId: reveal.inviteId,
  });
  assert.equal(hidden.paste, null);
  assert.equal(hidden.inviteId, JOIN_ID);
  assert.equal(JSON.stringify(hidden).includes(SECRET), false);
  assert.match(CONNECT, /this\.#prompt = reveal\.paste/);
  assert.match(CONNECT, /this\.#text\("prompt", reveal\.paste\)/);
  assert.match(CONNECT, /concealJoinInvite\(/);
  assert.match(CONNECT, /this\.#text\("prompt", ""\)/);
  const forget = methodBody(CONNECT, "#forget()");
  assert.match(forget, /concealJoinInvite\(/);
  assert.match(forget, /dismissShownJoin\(/);
  assert.match(forget, /this\.#text\("prompt", ""\)/);
});

test("revoke sends the revoke command and nothing else", async () => {
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
  assert.deepEqual(command, {
    kind: "revoke_agent_join_credential",
    join_credential_id: "11111111-1111-4111-8111-11111111111a",
  });
  assert.deepEqual(
    Object.keys(command).sort(),
    workspaceCommandKeys("revoke_agent_join_credential"),
  );
  assert.equal(envelope.workspace_id, WORKSPACE);
  assert.deepEqual(envelope.stream, { kind: "workspace" });
  assert.equal(envelope.client_version, WEB_CLIENT_VERSION);
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
      assert.equal(error.message, JOIN_INVITE_REVOKED_MESSAGE);
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(error.message.toLowerCase().includes("active"), false);
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
      assert.ok(error instanceof JoinInviteError);
      assert.equal(error.message.includes(SECRET), false);
      assert.match(error.message, /Nothing was created/);
      assert.equal(error.message.includes("may already exist"), false);
      return true;
    },
  );
});

test("Done then a revoke result does not turn the invite back on", () => {
  const gone = dismissShownJoin({
    inviteId: JOIN_ID,
    joinActive: true,
    prompt: SECRET,
  });
  assert.equal(gone.joinActive, false);
  assert.equal(gone.inviteId, null);
  assert.equal(gone.prompt, null);
  assert.equal(shownJoinAfterRevoke(gone, JOIN_ID), null);

  const shown = { inviteId: JOIN_ID, joinActive: true, prompt: SECRET };
  const applied = shownJoinAfterRevoke(shown, JOIN_ID);
  assert.ok(applied);
  assert.equal(applied.joinActive, true);
  assert.equal(applied.inviteId, JOIN_ID);
  assert.equal(applied.prompt, null);
  assert.equal(JSON.stringify(applied).includes(SECRET), false);
  assert.equal(shownJoinAfterRevoke(shown, "22222222-2222-4222-8222-222222222222"), null);

  const revoked = methodBody(CONNECT, "#markJoinRevoked(");
  const guard = revoked.indexOf("if (next === null) return;");
  const active = revoked.indexOf("this.#joinActive = next.joinActive");
  const lead = revoked.indexOf("lead.textContent = message");
  assert.ok(guard !== -1 && active > guard && lead > guard);
  assert.match(revoked, /shownJoinAfterRevoke\(/);
  assert.doesNotMatch(revoked, /#joinActive = true/);
  assert.match(revoked, /querySelector\("\.ac__result-lead"\)/);
  assert.equal(
    JOIN_INVITE_REVOKED_MESSAGE,
    "This invite is revoked. It can no longer be used to join.",
  );
  assert.equal(JOIN_INVITE_REVOKED_MESSAGE.toLowerCase().includes("active"), false);
});

test("a revoke in flight that finishes after Done does not write invite state", async () => {
  const state = { inviteId: JOIN_ID as string | null, wrote: false, message: "" };
  let release!: (value: { status: number; text: () => Promise<string> }) => void;
  const pending = new Promise<{ status: number; text: () => Promise<string> }>((resolve) => {
    release = resolve;
  });
  let markFetched!: () => void;
  const fetched = new Promise<void>((resolve) => {
    markFetched = resolve;
  });
  globalThis.fetch = (async () => {
    markFetched();
    return pending;
  }) as typeof fetch;

  const running = startJoinRevoke(revokeApi(state));
  await Promise.race([
    fetched,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("revoke did not reach the deployment")), 1000);
    }),
  ]);
  const dismissed = dismissShownJoin({
    inviteId: state.inviteId,
    joinActive: true,
    prompt: SECRET,
  });
  state.inviteId = dismissed.inviteId;
  release({ status: 200, text: async () => JSON.stringify({ status: "accepted" }) });
  await running;
  assert.equal(state.wrote, false);
  assert.equal(state.inviteId, null);
  assert.equal(dismissed.joinActive, false);
});

test("a failed revoke that finishes after Done does not write a note", async () => {
  const state = { inviteId: JOIN_ID as string | null, wrote: false, message: "" };
  let release!: (value: { status: number; text: () => Promise<string> }) => void;
  const pending = new Promise<{ status: number; text: () => Promise<string> }>((resolve) => {
    release = resolve;
  });
  let markFetched!: () => void;
  const fetched = new Promise<void>((resolve) => {
    markFetched = resolve;
  });
  globalThis.fetch = (async () => {
    markFetched();
    return pending;
  }) as typeof fetch;

  const running = startJoinRevoke(revokeApi(state));
  await fetched;
  state.inviteId = dismissShownJoin({
    inviteId: state.inviteId,
    joinActive: true,
    prompt: SECRET,
  }).inviteId;
  release({ status: 400, text: async () => JSON.stringify({ error: "bad", join_credential: SECRET }) });
  await running;
  assert.equal(state.wrote, false);
  assert.equal(state.message.includes(SECRET), false);
});

test("a revoke that finishes while the invite is shown replaces the active sentence", async () => {
  const state = { inviteId: JOIN_ID as string | null, wrote: false, message: "" };
  await startJoinRevoke(revokeApi(state));
  assert.equal(state.wrote, true);
  assert.equal(state.message, "This invite is revoked. It can no longer be used to join.");
  assert.equal(state.message.includes("Done leaves the invite active."), false);
  const before = joinInviteResultLead({ seatCap: 10, expiresAt: EXPIRES });
  assert.equal(before.includes("Done leaves the invite active."), true);
  assert.equal(before === state.message, false);
});

function mintFormApi(state: { message: string | null }) {
  return {
    workspaceId: () => WORKSPACE,
    session: async () => SESSION,
    tryBegin: () => true,
    end: () => {},
    setMintPending: () => {},
    showInvite: () => {
      throw new Error("invite was shown");
    },
    formError: (message: string | null) => {
      state.message = message;
    },
    note: () => {},
    markRevoked: () => {},
    inviteId: () => null,
  };
}

async function waitUntil(description: string, predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(description);
}

test("a live-invite refusal uses the wire error and branches on scope", async () => {
  const identity = joinInviteLiveLimitMessage("identity");
  const workspace = joinInviteLiveLimitMessage("workspace");
  assert.ok(identity);
  assert.ok(workspace);

  status = 403;
  payload = { error: "join_credential_limit_reached", scope: "identity", limit: 5 };
  await assert.rejects(
    () => mintJoinInvite({ session: SESSION, workspaceId: WORKSPACE, commandId: "web_limit_identity" }),
    (error: unknown) => {
      assert.ok(error instanceof JoinInviteError);
      assert.equal(error.message, identity);
      assert.equal(/revoke/i.test(error.message), false);
      assert.equal(error.message.includes("workspace"), false);
      return true;
    },
  );

  payload = { error: "join_credential_limit_reached", scope: "workspace", limit: 20 };
  await assert.rejects(
    () => mintJoinInvite({ session: SESSION, workspaceId: WORKSPACE, commandId: "web_limit_workspace" }),
    (error: unknown) => {
      assert.ok(error instanceof JoinInviteError);
      assert.equal(error.message, workspace);
      assert.equal(/revoke/i.test(error.message), false);
      assert.match(error.message, /this workspace/i);
      return true;
    },
  );

  payload = { error: "agent_join_live_limit_reached", scope: "identity", limit: 5 };
  await assert.rejects(
    () => mintJoinInvite({ session: SESSION, workspaceId: WORKSPACE, commandId: "web_limit_audit_reason" }),
    (error: unknown) => {
      assert.ok(error instanceof JoinInviteError);
      assert.notEqual(error.message, identity);
      assert.match(error.message, /Nothing new was added/);
      return true;
    },
  );

  payload = { error: "join_credential_limit_reached" };
  await assert.rejects(
    () => mintJoinInvite({ session: SESSION, workspaceId: WORKSPACE, commandId: "web_limit_no_scope" }),
    (error: unknown) => {
      assert.ok(error instanceof JoinInviteError);
      assert.notEqual(error.message, identity);
      assert.notEqual(error.message, workspace);
      assert.equal(/revoke/i.test(error.message), false);
      return true;
    },
  );
});

test("a lost mint says an invite may already exist", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  const state = { message: null as string | null };
  await startJoinMint(mintFormApi(state));
  assert.equal(state.message, joinInviteLostMintMessage());
  assert.match(state.message, /may already exist/);
  assert.match(state.message, /will expire on its own/);
  assert.equal(state.message.includes("No invite was created"), false);
  assert.equal(state.message.includes("Nothing was added"), false);
});

test("a mint body that never ends stops with the lost-mint error when the deadline passes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let bodyReadStarted = false;
  let bodySignal: AbortSignal | null = null;
  globalThis.fetch = (async (_url: string, init?: { signal?: AbortSignal }) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    bodySignal = signal;
    return {
      status: 200,
      text: () => {
        bodyReadStarted = true;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("response body timed out");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    };
  }) as typeof fetch;

  const state = { message: null as string | null };
  const pending = startJoinMint(mintFormApi(state));
  await waitUntil("the mint body read", () => bodyReadStarted);
  assert.equal(bodySignal?.aborted, false);
  t.mock.timers.tick(29_999);
  assert.equal(bodySignal?.aborted, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(bodySignal?.aborted, true);
  assert.equal(state.message, joinInviteLostMintMessage());
  assert.equal(state.message?.includes("No invite was created"), false);
});

test("a 401 mint says no invite was created", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 401,
        text: async () => JSON.stringify({ error: "unauthenticated" }),
      };
    }
    return { status: 204, ok: true, text: async () => "", json: async () => ({}) };
  }) as typeof fetch;
  const state = { message: null as string | null };
  await startJoinMint(mintFormApi(state));
  assert.match(state.message ?? "", /No invite was created/);
  assert.equal((state.message ?? "").includes("may already exist"), false);
});

test("a failed invite-module import shows a plain error", async () => {
  const seen: string[] = [];
  callLinkJoin(null, () => {
    seen.push("ran");
  }, () => {
    seen.push("error");
  });
  assert.deepEqual(seen, []);

  const loaded = Promise.reject(new Error("failed to fetch /private/secret.js"));
  callLinkJoin(loaded, () => {
    seen.push("ran");
  }, (message) => {
    seen.push(message);
  });
  await loaded.catch(() => undefined);
  await Promise.resolve();
  assert.deepEqual(seen, [LINK_JOIN_LOAD_ERROR]);
  assert.equal(LINK_JOIN_LOAD_ERROR.includes("secret"), false);
  assert.equal(LINK_JOIN_LOAD_ERROR.includes("failed to fetch"), false);

  const wire = methodBody(CONNECT, "#wire()");
  assert.match(wire, /callLinkJoin\(joining, \(\) => undefined, showJoinLoadError\)/);
  assert.match(wire, /void module\.startJoinMint\(api\)/);
  assert.match(wire, /void module\.startJoinRevoke\(api\)/);
  assert.match(wire, /api\.formError\(message\)/);
  assert.equal(wire.includes("void joining?.then"), false);
});
