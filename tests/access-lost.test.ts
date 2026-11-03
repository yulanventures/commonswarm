import assert from "node:assert/strict";
import test from "node:test";
import {
  AccessLostLimiter,
  accessRef,
  logAccessLost,
  reportHostedSeatRefused,
  // @ts-expect-error TS5097: exercise the Deno source through tsx.
} from "../supabase/functions/_shared/access-lost.ts";
// @ts-expect-error TS5097: exercise the Deno source through tsx.
import { reportRevokedLocalCredential } from "../supabase/functions/_shared/agent-auth.ts";

const AT = Date.parse("2026-11-03T10:00:00.000Z");
const PRINCIPAL = "abcdef01-2222-4333-8444-555555555555";
const OWNER = "fedcba98-2222-4333-8444-555555555555";
const GRANT = "GrAnT_id-with-a-long-secret-ish-tail";

function captureStderr<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { lines.push(String(line)); };
  return run().then(value => ({ value, lines }), error => { throw error; })
    .finally(() => { console.error = original; });
}

test("access_lost line is the stable shape with 8-character refs only", () => {
  const lines: string[] = [];
  const emitted = logAccessLost({ class: "local_renewal_superseded", principal_ref: PRINCIPAL,
    owner_ref: null, grant_ref: null }, AT, (line: string) => lines.push(line), new AccessLostLimiter());
  assert.equal(emitted, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], JSON.stringify({ event: "access_lost", class: "local_renewal_superseded",
    principal_ref: "abcdef01", owner_ref: null, grant_ref: null, at: "2026-11-03T10:00:00.000Z" }));
  assert.equal(accessRef("short"), null);
  assert.equal(accessRef("has space in it"), null);
  assert.equal(accessRef(undefined), null);
});

test("one line per (class, ref) per 60 seconds, bounded keys", () => {
  const lines: string[] = [];
  const limiter = new AccessLostLimiter();
  const write = (line: string) => lines.push(line);
  const emit = (principal: string, now: number) => logAccessLost({ class: "local_credential_revoked",
    principal_ref: principal, owner_ref: null, grant_ref: null }, now, write, limiter);
  for (let i = 0; i < 10; i++) emit(PRINCIPAL, AT + i);
  emit(OWNER, AT);
  logAccessLost({ class: "local_renewal_superseded", principal_ref: PRINCIPAL, owner_ref: null,
    grant_ref: null }, AT, write, limiter);
  assert.equal(lines.length, 3);
  assert.equal(emit(PRINCIPAL, AT + 59_999), false);
  assert.equal(emit(PRINCIPAL, AT + 60_000), true);

  const small = new AccessLostLimiter(60_000, 2);
  assert.equal(small.allow("a", AT), true);
  assert.equal(small.allow("b", AT), true);
  assert.equal(small.allow("c", AT), false, "full of live keys refuses a new key (hard ceiling)");
  assert.equal(small.allow("a", AT + 1), false, "a live key is never evicted, so it stays inside its interval");
  assert.equal(small.allow("c", AT + 60_000), true, "expired keys are pruned, then new keys are admitted");
});

test("hosted seat refusal emits only for a retired provider family", async () => {
  const token = { providerGrantId: GRANT, subject: OWNER };
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const probed: string[] = [];
  const retired = async (id: string) => { probed.push(id); return { active: false }; };
  const active = async (id: string) => { probed.push(id); return { active: true }; };

  assert.equal(await reportHostedSeatRefused("rate_limited", token, retired, AT, write), false);
  assert.equal(await reportHostedSeatRefused("hosted_seat_revoked", token, retired, AT, write), false);
  assert.deepEqual(probed, [], "other codes never query provider status");

  const activeToken = { providerGrantId: "ActiveGrant-0000", subject: OWNER };
  assert.equal(await reportHostedSeatRefused("hosted_seat_forbidden", activeToken, active, AT, write), false);

  assert.equal(await reportHostedSeatRefused("hosted_grant_forbidden", token, retired, AT, write), true);
  assert.deepEqual(JSON.parse(lines[0]!), { event: "access_lost", class: "hosted_seat_refused",
    principal_ref: null, owner_ref: "fedcba98", grant_ref: "GrAnT_id", at: "2026-11-03T10:00:00.000Z" });
  assert.equal(lines[0]!.includes("secret"), false);

  // A looping client costs at most one status query per grant per interval.
  for (let i = 0; i < 5; i++) await reportHostedSeatRefused("hosted_seat_forbidden", token, retired, AT + i, write);
  assert.equal(lines.length, 1);
  assert.equal(probed.filter(id => id === GRANT).length, 1);
  assert.equal(await reportHostedSeatRefused("hosted_seat_forbidden", token, retired, AT + 60_000, write), true);

  const failing = { providerGrantId: "FailingGrant-000", subject: OWNER };
  assert.equal(await reportHostedSeatRefused("hosted_seat_forbidden", failing,
    async () => { throw new Error("db down"); }, AT, write), false);
});

function fakeTx(rows: unknown[], statements: string[]) {
  return async <T>(run: (tx: never) => Promise<T>): Promise<T> => {
    const tx = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      statements.push(strings.join("?"));
      return Promise.resolve(rows);
    };
    return await run(tx as never);
  };
}

function hash(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i) & 0xff);
}

test("revoked local credential emits the row's principal and owner prefixes", async () => {
  const statements: string[] = [];
  const presented = hash(1);
  const { lines } = await captureStderr(() => reportRevokedLocalCredential(
    fakeTx([{ principal_id: PRINCIPAL, owner_user_id: OWNER, revoked: true }], statements), presented, AT));
  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /WHERE t\.token_hash=\? AND p\.transport='local'/u);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { event: "access_lost", class: "local_credential_revoked",
    principal_ref: "abcdef01", owner_ref: "fedcba98", grant_ref: null, at: "2026-11-03T10:00:00.000Z" });
  const hex = Array.from(presented, b => b.toString(16).padStart(2, "0")).join("");
  assert.equal(lines[0]!.includes(hex.slice(0, 16)), false, "no part of the hash is logged");

  // The same presented hash is not looked up again inside the interval.
  const again = await captureStderr(() => reportRevokedLocalCredential(
    fakeTx([{ principal_id: PRINCIPAL, owner_user_id: OWNER, revoked: true }], statements), presented, AT + 1));
  assert.equal(statements.length, 1);
  assert.deepEqual(again.lines, []);
});

test("unknown, live or failing lookups never emit or throw", async () => {
  const statements: string[] = [];
  for (const [seed, rows] of [[2, []], [3, [{ principal_id: PRINCIPAL, owner_user_id: OWNER, revoked: false }]]] as const) {
    const { lines } = await captureStderr(() => reportRevokedLocalCredential(fakeTx([...rows], statements), hash(seed), AT));
    assert.deepEqual(lines, []);
  }
  assert.equal(statements.length, 2);
  const failing = async () => { throw new Error("connection refused"); };
  const { lines } = await captureStderr(() => reportRevokedLocalCredential(failing, hash(4), AT));
  assert.deepEqual(lines, []);
  const { lines: short } = await captureStderr(() => reportRevokedLocalCredential(
    fakeTx([{ principal_id: PRINCIPAL, owner_user_id: OWNER, revoked: true }], statements), new Uint8Array(4), AT));
  assert.deepEqual(short, []);
  assert.equal(statements.length, 2, "a malformed hash is never looked up");
});
