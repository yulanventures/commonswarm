import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertInviteDeployment,
  decodeMemberInvite,
  encodeMemberInvite,
  forgetInvite,
  memberInviteUrl,
  recalledInvite,
  rememberInvite,
  type MemberInvitePayload,
} from "../../lib/member-invite";

const payload: MemberInvitePayload = {
  v: 1,
  url: "https://example.supabase.co",
  anon_key: "public-anon-key",
  workspace_id: "3ab184b3-fbb4-5ee9-afad-3842a604439a",
  invitation_token: `swm_inv_${"A".repeat(43)}`,
  workspace_name: "Dogfood Workspace",
  inviter_display_name: "Calvin",
  inviter_user_id: "d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc",
};

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("invite payload is strict, canonical, and fragment-only", () => {
  const encoded = encodeMemberInvite(payload);
  assert.deepEqual(decodeMemberInvite(encoded), payload);
  const link = memberInviteUrl("https://commonswarm.com/app", payload);
  const parsed = new URL(link);
  assert.equal(parsed.pathname, "/invite");
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, `#invite=${encoded}`);
  assert.equal(parsed.href.includes(payload.invitation_token), false);
  assert.throws(() => decodeMemberInvite(`${encoded}=`), /strict base64url/);
  assert.throws(
    () => decodeMemberInvite(`${encoded.slice(0, -1)}!`),
    /strict base64url/,
  );
});

test("invite target is pinned and auth resume storage is erasable", () => {
  assert.doesNotThrow(() =>
    assertInviteDeployment(payload, {
      url: payload.url,
      anonKey: payload.anon_key,
    })
  );
  assert.throws(
    () =>
      assertInviteDeployment(payload, {
        url: "https://other.supabase.co",
        anonKey: payload.anon_key,
      }),
    /different CommonSwarm deployment/,
  );
  const storage = new MemoryStorage();
  const id = "b3e91444-100f-494f-8784-eb1d01fb17e0";
  rememberInvite(payload, storage, id);
  assert.deepEqual(recalledInvite(id, storage), payload);
  forgetInvite(id, storage);
  assert.equal(recalledInvite(id, storage), null);
});

/**
 * What a person reads on the page: the template without its frontmatter, script, style and
 * comments. Attribute values stay in, so a protocol word cannot hide in an aria-label.
 */
function visibleMarkup(source: string): string {
  return source
    .replace(/^---[\s\S]*?\n---\n/, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/** Words the product keeps out of every screen a household member reads. */
const PROTOCOL_WORDS = /\b(?:seat\w*|grant\w*|claim\w*|oauth|mcp|signal\w*|principal\w*)\b/i;

test("/invite retains fragment hygiene and requires independent human consent", async () => {
  const source = await readFile(new URL("./InviteOnramp.astro", import.meta.url), "utf8");
  assert.match(source, /A teammate<\/span> invited you to/);
  assert.match(source, /Sign in as yourself[\s\S]*Choose what you share[\s\S]*Connect your own agents/);
  assert.match(source, /payload\.inviter_user_id === session\.user\.id/);
  assert.match(source, /data-independent-consent/);
  assert.match(source, /data-confirm-join/);
  assert.match(source, /prepareAcceptance/);
  assert.match(source, /forgetInvite/);
  assert.match(source, /history\.replaceState/);
  assert.match(
    source,
    /if \(encoded\) \{\s*history\.replaceState\(null, "", new URL\("\/invite"/,
  );
  assert.match(source, /data-view="join-error"/);
  assert.match(source, /data-retry-join/);
  // After joining she connects her own agents through the shared host picker. The one-time-key
  // flow is not on the joiner's path, and no protocol word is in anything she reads.
  assert.match(source, /<AgentHostPicker audience="joiner"/);
  assert.doesNotMatch(source, /AgentConnect/);
  assert.doesNotMatch(visibleMarkup(source), PROTOCOL_WORDS);
  assert.doesNotMatch(source, /searchParams\.set\([^,]+,\s*payload\.invitation_token/);
  assert.doesNotMatch(source, /innerHTML/);
});
