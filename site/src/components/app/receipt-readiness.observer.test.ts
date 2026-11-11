/** Real site DOM/transport proof with synthetic HTTP: the receipt-loaded marker across a seen acknowledgement. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build, type Plugin } from "esbuild";
import ts from "typescript";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

// Authoring gate: data-receipt-loaded is what the hover audit waits on before it takes rest. The credible regression is
// a receipt read that was already in flight when this viewer's seen report was acknowledged: it carries pre-acknowledgement
// data (Sent), and marking the row loaded from it lets the audit measure while the real re-read is still owed (it later
// flips the row to Seen). Only HTTP is synthetic: the real app boots, renders the feed, reports the row seen through its
// own IntersectionObserver and reporter, reads receipts through its own client, and writes the marker.
function installReceiptFixture() {
  const w = window as any;
  const owner = "33333333-3333-4333-8333-333333333333";
  const agent = "22222222-2222-4222-8222-222222222222";
  const workspace = "11111111-1111-4111-8111-111111111111";
  const signal = "99999999-9999-4999-8999-999999999999";
  const recent = new Date(Date.now() - 60000).toISOString();
  const before = new Date(Date.now() - 86400000).toISOString();
  const user = { id: owner, aud: "authenticated", role: "authenticated",
    email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: before };
  // Every receipt read is held until the observer releases it, and answers with the seen state AT REQUEST TIME.
  const f = w.receiptFixture = { owner, workspace, signal, seen: false, ackedAt: 0, clock: 0,
    reads: [] as Array<{ at: number; seen: boolean; release: () => void; released: boolean }>,
    unreadAfterAck: 0, unexpected: [] as string[] };
  // The reporter only reports while the document has focus; a headless page may not hold it.
  Object.defineProperty(document, "hasFocus", { value: () => true });
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") { f.unexpected.push(url.href); return Response.json({}, { status: 404 }); }
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/rest/v1/rpc/signal_delivery_receipts") {
      const read = { at: ++f.clock, seen: f.seen, release: () => {}, released: false };
      await new Promise<void>(resolve => { read.release = () => { read.released = true; resolve(); }; f.reads.push(read); });
      return Response.json({ addressed: true, receipts: [{ recipient_user_id: owner, display_name: "Synthetic owner",
        seen_at: read.seen ? new Date().toISOString() : null }] });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "signals_seen") {
      if (body.command.signal_ids?.includes(signal)) { f.seen = true; f.ackedAt = ++f.clock; }
      return Response.json({ status: "accepted" });
    }
    if (url.pathname === "/rest/v1/rpc/channel_unread") {
      if (f.ackedAt) f.unreadAfterAck++;
      return Response.json({ workspace_id: workspace, generated_at: new Date().toISOString(), channels: [{ channel_id: null, slug: "general", unread: null }] });
    }
    if (url.pathname === "/rest/v1/rpc/decision_queue") return Response.json({ workspace_id: workspace, generated_at: new Date().toISOString(), total: 0, truncated: false, asks: [] });
    if (url.pathname === "/rest/v1/rpc/home_overview") return Response.json({ viewer_user_id: owner, generated_at: new Date().toISOString(), workspaces: [{
      workspace_id: workspace, name: "Home", role: "owner", last_seen_at: recent, new_messages: 0, content: null,
      people: [{ user_id: owner, display_name: "Synthetic owner", role: "owner", is_viewer: true, agents: [] }],
      needs_you: { asks: [], assigned: [], waiting: [] } }] });
    if (url.pathname === "/rest/v1/workspaces") return Response.json([{ workspace_id: workspace, org_id: workspace, name: "Home", archived_at: null }]);
    if (url.pathname === "/rest/v1/member_profiles") return Response.json([{ user_id: owner, display_name: "Synthetic owner", role: "owner" }]);
    if (url.pathname === "/rest/v1/agent_principals") return Response.json([{ principal_id: agent, name: "Synthetic assistant", model: null,
      transport: "local", turn_only: false, owner_user_id: owner, revoked_at: null, workspace_id: workspace, created_at: before }]);
    if (url.pathname === "/rest/v1/signals") return Response.json([{ id: signal, from: agent, from_kind: "agent", to: null, to_agent: null,
      kind: "note", body: "A note to everyone.", about: null, until: null, created_at: recent, attachments: [], channel_id: null,
      thread_root_id: null, broadcast_to_channel: false, in_reply_to: null }]);
    if (url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    if (url.pathname === "/functions/v1/read") return Response.json(body?.resource === "pending_access" ? { pending: [], agents: [] } : { grants: [] });
    if (url.pathname === "/functions/v1/command") return Response.json({ status: "refused", reason: "content_consent_required" });
    f.unexpected.push(request.method + " " + url.pathname);
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };
  localStorage.setItem("sb-api-auth-token", JSON.stringify({ access_token: "synthetic-human",
    refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user }));
}

async function observeReceiptReadiness() {
  const w = window as any, f = w.receiptFixture;
  const tick = async () => { const r = fetch("/__observer-tick"); await r; };
  const steps: string[] = [];
  const receipt = () => document.querySelector<HTMLElement>(`[data-signal-id="${f.signal}"] .dashboard__message-receipt`);
  const state = () => `${receipt()?.dataset.receiptState ?? "none"}:${receipt()?.dataset.receiptLoaded ?? "unmarked"}`;
  const wait = async (predicate: () => unknown, name: string) => {
    for (let i = 0; i < 600; i++) { if (predicate()) { steps.push(name + " " + state()); return; } await tick(); }
    throw new Error("timed out at " + name + "; receipt " + state() + "; reads " + JSON.stringify(f.reads.map((r: any) => [r.at, r.seen, r.released])) +
      "; ackedAt " + f.ackedAt + "; unexpected " + f.unexpected.join(", "));
  };
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message + "; receipt " + state() + "; steps " + steps.join(" | ")); };
  try {
    // 1. The row renders, its first receipt read is held (no data yet), and the row is reported seen and acknowledged.
    await wait(() => receipt(), "row rendered");
    await wait(() => f.reads.length >= 1, "first read in flight");
    await wait(() => f.ackedAt > 0 && f.unreadAfterAck > 0, "seen acknowledged and handled");
    for (let i = 0; i < 10; i++) await tick();
    const first = f.reads[0];
    check(first.at < f.ackedAt && !first.seen, "the first read must be in flight before the acknowledgement");
    check(receipt()?.dataset.receiptLoaded === "false", "no read has completed yet");
    // 2. Release the pre-acknowledgement read (Sent). It must not settle the row: a re-read is still owed.
    first.release();
    await wait(() => receipt()?.dataset.receiptState === "sent", "pre-ack Sent rendered");
    for (let i = 0; i < 10; i++) await tick();
    check(receipt()?.dataset.receiptLoaded === "false", "a read begun before the acknowledgement marked the row loaded");
    // 3. The re-read the acknowledgement asked for begins after it, answers Seen, and only then is the row loaded.
    await wait(() => f.reads.some((r: any) => r.at > f.ackedAt), "post-ack read in flight");
    const fresh = f.reads.find((r: any) => r.at > f.ackedAt);
    check(fresh.seen, "the post-ack read answers seen");
    check(receipt()?.dataset.receiptLoaded === "false", "loaded before the post-ack read completed");
    fresh.release();
    await wait(() => receipt()?.dataset.receiptState === "seen" && receipt()?.dataset.receiptLoaded === "true", "post-ack Seen loaded");
    document.documentElement.dataset.receiptObservation = JSON.stringify({ ok: true, steps, unexpected: f.unexpected });
  } catch (error) {
    document.documentElement.dataset.receiptObservation = JSON.stringify({ error: String(error), steps, unexpected: f.unexpected });
  } finally {
    for (const read of f.reads) if (!read.released) read.release();
  }
}

test("a receipt read begun before this viewer's seen acknowledgement never marks the row loaded", { timeout: 180_000 }, async () => {
  const component = fileURLToPath(new URL("./LiveDashboard.astro", import.meta.url));
  const scripts = new Map<string, string[]>(), styles: string[] = [];
  const compiler: Plugin = { name: "existing-astro-container", setup(builder) {
    builder.onLoad({ filter: /\.astro$/ }, async args => {
      const compiled = transform(await readFile(args.path, "utf8"), { filename: args.path,
        internalURL: "astro/compiler-runtime", resultScopedSlot: true, resolvePath: specifier => specifier });
      assert.deepEqual(compiled.diagnostics.filter(d => d.severity === "error"), []);
      scripts.set(args.path, compiled.scripts.map(s => s.code).filter((code): code is string => typeof code === "string"));
      styles.push(...compiled.css);
      return { contents: compiled.code.replace(/import "[^"\n]+\?astro&type=style[^"\n]+";\n/gu, ""), loader: "ts", resolveDir: dirname(args.path) };
    });
    builder.onLoad({ filter: /\.css$/ }, async args => { styles.push(await readFile(args.path, "utf8")); return { contents: "", loader: "js" }; });
  } };
  const rendered = await build({ entryPoints: [component], bundle: true, write: false, format: "esm", platform: "node",
    plugins: [compiler], external: ["astro/compiler-runtime"], define: { "import.meta.env": "{}" } });
  const code = rendered.outputFiles[0]!.text.replaceAll('"astro/compiler-runtime"',
    JSON.stringify(new URL("../../../node_modules/astro/dist/runtime/compiler/index.js", import.meta.url).href));
  const module = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const container = await AstroContainer.create({ resolve: async () => "/app.js" });
  const markup = await container.renderToString(module.default);
  const bundled: string[] = [];
  for (const [path, contents] of scripts) for (const content of contents) {
    bundled.push((await build({ stdin: { contents: content, loader: "ts", resolveDir: dirname(path) }, bundle: true, write: false,
      format: "iife", platform: "browser", define: { "import.meta.env": JSON.stringify({ PUBLIC_H0_LINK_JOIN: "0" }) } })).outputFiles[0]!.text);
  }
  const testSource = await readFile(new URL(import.meta.url), "utf8");
  const ast = ts.createSourceFile("fixture.ts", testSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const compileFixture = async (name: string) => {
    const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(found, "test fixture function " + name);
    return (await build({ stdin: { contents: found.getText(ast) + "\nvoid " + name + "();", loader: "ts", resolveDir: dirname(component) },
      bundle: true, write: false, platform: "browser", format: "iife" })).outputFiles[0]!.text;
  };
  const app = "<!doctype html><html><head><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" +
    styles.join("\n") + "</style><script>" + await compileFixture("installReceiptFixture") + "</script></head><body>" + markup +
    "<script>" + await compileFixture("observeReceiptReadiness") + "</script></body></html>";
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") { setTimeout(() => { response.writeHead(204); response.end(); }, 2); return; }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript" : "text/html" });
    response.end(request.url === "/app.js" ? bundled.join("\n") : app);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const { stdout } = await launchChrome(await findChrome(), ["--window-size=1280,900", "--virtual-time-budget=120000", "--dump-dom",
      "http://127.0.0.1:" + address.port + "/app?w=11111111-1111-4111-8111-111111111111"], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    const raw = stdout.match(/data-receipt-observation="([^"]*)"/)?.[1];
    assert.ok(raw, "the rendered app must finish the observation: " + stdout.slice(0, 1000));
    const result = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
