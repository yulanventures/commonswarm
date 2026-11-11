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
  const later = "88888888-8888-4888-8888-888888888888";
  const scenario = new URL(location.href).searchParams.get("case") || "pre-ack";
  const recent = new Date(Date.now() - 60000).toISOString();
  const before = new Date(Date.now() - 86400000).toISOString();
  const user = { id: owner, aud: "authenticated", role: "authenticated",
    email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: before };
  // Every receipt read is held until the observer releases it, and answers with the seen state AT REQUEST TIME.
  const f = w.receiptFixture = { owner, workspace, signal, later, root: "55555555-5555-4555-8555-555555555555", scenario, seen: false, ackedAt: 0, clock: 0, withLater: false, seenIds: new Set<string>(),
    reads: [] as Array<{ at: number; id: string; seen: boolean; release: () => void; released: boolean }>,
    log: [] as string[], unreadAfterAck: 0, unexpected: [] as string[] };
  // pre-ack: one note to the viewer, whose own read is in flight at the acknowledgement.
  // dropped-refresh: the held read is for the owner's note to an agent (never reported seen); a note to the viewer arrives
  // and is acknowledged while that read holds the slot, so the refresh it asks for is dropped and must run after.
  // beyond-eight: ten notes from the owner to the assistant are on screen and never read; a pass reads at most eight, and
  // the remaining two must be read without waiting for the feed's next poll. Reads answer at once.
  // awaiting-beyond-eight: ten notes to the viewer are read, reported seen together and acknowledged; all ten owe a re-read,
  // and all ten must be re-read without waiting for the feed's next poll. Reads answer at once.
  // 17 = 2 x the 8-row pass cap + 1, so one extra pass after the first cannot finish it.
  const many = Array.from({ length: 17 }, (_, i) => `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`);
  // scroll-into-view: 24 notes from the owner to the assistant (never reported seen); the feed opens at the newest, and
  // scrolling to the oldest brings unread rows into view, which must be read without waiting for a feed poll.
  const scrolled = Array.from({ length: 24 }, (_, i) => `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`);
  // thread-expand: the owner's note to the assistant with 17 replies to the assistant, collapsed; opening the thread
  // brings them into view, and every reply on screen must be read without waiting for a feed poll.
  const root = "55555555-5555-4555-8555-555555555555";
  const replies = Array.from({ length: 17 }, (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`);
  const row = (id: string, to: string | null, toAgent: string | null, from: string, fromKind: string, body: string) => ({ id, from, from_kind: fromKind,
    to, to_agent: toAgent, kind: "note", body, about: null, until: null, created_at: recent, attachments: [], channel_id: null,
    thread_root_id: null, broadcast_to_channel: false, in_reply_to: null });
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
      const id = String(body?.p_signal_id ?? "");
      const read = { at: ++f.clock, id, seen: f.seen, release: () => {}, released: false };
      f.log.push("read:" + id.slice(0, 2));
      if (["beyond-eight", "scroll-into-view", "thread-expand"].includes(scenario)) { f.log.push("read-id:" + id); return Response.json(null); }
      if (scenario === "awaiting-beyond-eight") {
        f.log.push("read-id:" + id);
        return Response.json({ addressed: true, receipts: [{ recipient_user_id: owner, display_name: "Synthetic owner",
          seen_at: f.seenIds.has(id) ? new Date().toISOString() : null }] });
      }
      await new Promise<void>(resolve => { read.release = () => { read.released = true; resolve(); }; f.reads.push(read); });
      if (scenario === "dropped-refresh" && id === signal) return Response.json(null);
      return Response.json({ addressed: true, receipts: [{ recipient_user_id: owner, display_name: "Synthetic owner",
        seen_at: read.seen ? new Date().toISOString() : null }] });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "signals_seen" && scenario === "awaiting-beyond-eight") {
      for (const id of body.command.signal_ids ?? []) f.seenIds.add(String(id));
      f.ackedAt = ++f.clock; f.log.push("ack:" + (body.command.signal_ids ?? []).join(","));
      return Response.json({ status: "accepted" });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "signals_seen") {
      const target = scenario === "dropped-refresh" ? later : signal;
      if (body.command.signal_ids?.includes(target)) { f.seen = true; f.ackedAt = ++f.clock; f.log.push("ack"); }
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
    // A note directed to this viewer: the audience whose receipt is one human row that goes Sent to Seen.
    if (url.pathname === "/rest/v1/signals") {
      f.log.push("signals");
      if (scenario === "pre-ack") return Response.json([row(signal, owner, null, agent, "agent", "A note for you.")]);
      if (scenario === "beyond-eight") return Response.json(many.map((id, i) => row(id, null, agent, owner, "user", "Note " + i + " for the assistant.")));
      if (scenario === "awaiting-beyond-eight") return Response.json(many.map((id, i) => row(id, owner, null, agent, "agent", "Note " + i + " for you.")));
      if (scenario === "scroll-into-view") return Response.json(scrolled.map((id, i) => ({ ...row(id, null, agent, owner, "user", "Older note " + i + " for the assistant."),
        created_at: new Date(Date.now() - 60000 - i * 60000).toISOString() })));
      if (scenario === "thread-expand") return Response.json([...replies.map((id, i) => ({ ...row(id, null, agent, owner, "user", "Reply " + i),
        thread_root_id: root, in_reply_to: root, created_at: new Date(Date.now() - 30000 + i * 1000).toISOString() })),
        { ...row(root, null, agent, owner, "user", "A thread for the assistant."), created_at: new Date(Date.now() - 60000).toISOString() }]);
      const rows = [row(signal, null, agent, owner, "user", "A note for the assistant.")];
      if (f.withLater) rows.unshift({ ...row(later, owner, null, agent, "agent", "A note for you."), created_at: new Date().toISOString() });
      return Response.json(rows);
    }
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
    const feedView = () => document.querySelector<HTMLElement>(".dashboard__feed-view");
    const onScreen = () => { const v = feedView()!.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>("[data-signal-id]")).filter(row => { const r = row.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && Math.min(r.bottom, v.bottom) > Math.max(r.top, v.top); }).map(row => row.dataset.signalId!); };
    const readIds = () => new Set(f.log.filter((e: string) => e.startsWith("read-id:")).map((e: string) => e.slice(8)));
    // Each row in `ids` must get its first read after `from` and before the first feed poll after `from`.
    const readBeforePoll = async (ids: string[], from: number, name: string) => {
      const verdict = () => ids.map(id => {
        const read = f.log.findIndex((e: string, i: number) => i > from && e === "read-id:" + id);
        const poll = f.log.findIndex((e: string, i: number) => i > from && e === "signals");
        return read !== -1 && (poll === -1 || read < poll) ? "ok" : read === -1 && poll === -1 ? "pending" : "late";
      });
      await wait(() => !verdict().includes("pending"), name);
      const late = verdict().filter(v => v === "late").length;
      check(late === 0, name + ": " + late + " of " + ids.length + " rows waited for a feed poll");
    };
    if (f.scenario === "scroll-into-view" || f.scenario === "thread-expand") {
      // This page renders the app without its full-height shell, so the feed view would grow to fit every row. Hold it to
      // a fixed height, as the app's own layout does, so the scroll case starts with rows that are genuinely off screen.
      if (f.scenario === "scroll-into-view") { const view = feedView(); check(view, "feed view rendered");
        view!.style.height = "320px"; view!.style.maxHeight = "320px"; view!.style.overflowY = "auto"; }
      await wait(() => document.querySelectorAll("[data-signal-id]").length >= (f.scenario === "thread-expand" ? 1 : 24), "rows rendered");
      if (f.scenario === "thread-expand") {
        // A pass also reads rows off screen (eight at a time), and so does every feed poll, so the collapsed replies are
        // read in the background. Open the thread right after the first pass, before a poll, so most replies are unread.
        await wait(() => readIds().size >= 8, "the first pass read");
        // Open only once that pass has ended (its rebuild marks the root loaded): opened mid-pass, the pass's own drain
        // reads the replies, and the case would not show that opening the thread asks for them.
        const rootReceipt = () => Array.from(document.querySelectorAll<HTMLElement>(`[data-signal-id="${f.root}"] .dashboard__message-receipt`))
          .find(d => d.closest("[data-signal-id]")?.getAttribute("data-signal-id") === f.root);
        await wait(() => rootReceipt()?.dataset.receiptLoaded === "true", "the first pass ended");
        for (let i = 0; i < 10; i++) await tick();
      } else {
        // Let the reads of the rows on screen at load finish.
        let stable = 0, size = -1;
        while (stable < 20) { await tick(); const n = readIds().size; stable = n === size ? stable + 1 : 0; size = n; }
      }
      const before = readIds();
      const from = f.log.length - 1;
      if (f.scenario === "scroll-into-view") {
        const view = feedView()!;
        check(view.scrollHeight > view.clientHeight + 100, "the feed must overflow before scrolling: " + view.clientHeight + "/" + view.scrollHeight + " px");
        view.scrollTop = 0;
      }
      else {
        const toggle = document.querySelector<HTMLButtonElement>(`[data-thread-toggle="${f.root}"]`);
        const repliesList = document.getElementById(`dashboard-thread-${f.root}`);
        check(toggle && repliesList, "thread toggle and replies rendered");
        check(toggle!.getAttribute("aria-expanded") === "false" && repliesList!.hidden, "the thread starts collapsed: aria-expanded " +
          toggle!.getAttribute("aria-expanded") + ", hidden " + repliesList!.hidden);
        toggle!.click();
        for (let i = 0; i < 3; i++) await tick();
        check(toggle!.getAttribute("aria-expanded") === "true" && !repliesList!.hidden, "the thread opened: aria-expanded " +
          toggle!.getAttribute("aria-expanded") + ", hidden " + repliesList!.hidden);
        steps.push("collapsed before the click, open after it");
        document.getElementById(`dashboard-thread-${f.root}`)?.scrollIntoView({ block: "start" });
      }
      for (let i = 0; i < 3; i++) await tick();
      const fresh = onScreen().filter(id => !before.has(id));
      const view = feedView()!;
      const short = (ids: Iterable<string>) => Array.from(ids).map(id => id.slice(-4)).join(",");
      steps.push("read before: " + short(before) + "; newly on screen and unread: " + short(fresh));
      // Passes also prefetch rows off screen, so how many are still unread when they come into view varies; what this case
      // proves is that every one that is unread gets read before the next poll, so it needs at least one.
      check(fresh.length >= 1, "rows newly on screen and never read: " + fresh.length +
        " (feed view " + view.clientHeight + "/" + view.scrollHeight + " px, scrollTop " + view.scrollTop + ", rows " +
        document.querySelectorAll("[data-signal-id]").length + ", read before " + before.size + ", on screen " + onScreen().length + ")");
      await readBeforePoll(fresh, from, f.scenario === "thread-expand" ? "replies opened into view" : "rows scrolled into view");
      steps.push("read after: " + short(Array.from(readIds()).filter(id => !before.has(id))));
      document.documentElement.dataset.receiptObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario === "beyond-eight") {
      await wait(() => document.querySelectorAll(".dashboard__message-receipt").length >= 17, "seventeen rows rendered");
      const visible = onScreen();
      check(visible.length >= 17, "all seventeen rows on screen: " + visible.length);
      // Passes of at most eight: the ninth to seventeenth first reads must follow, not wait for the feed's next poll.
      const firstReadOf = () => { const seen = new Set<string>(); const at: number[] = [];
        f.log.forEach((e: string, i: number) => { if (e.startsWith("read-id:") && !seen.has(e)) { seen.add(e); at.push(i); } }); return at; };
      await wait(() => firstReadOf().length >= 17, "all seventeen rows read");
      const at = firstReadOf();
      const polls = f.log.slice(at[7]! + 1, at[16]!).filter((e: string) => e === "signals").length;
      check(polls === 0, "rows beyond the first eight waited for a feed poll: " + polls + " poll(s) between the eighth and seventeenth first reads; rows " +
        document.querySelectorAll("[data-signal-id]").length);
      document.documentElement.dataset.receiptObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario === "awaiting-beyond-eight") {
      await wait(() => document.querySelectorAll(".dashboard__message-receipt").length >= 17, "seventeen rows rendered");
      await wait(() => f.seenIds.size >= 17 && f.unreadAfterAck > 0, "all seventeen reported seen and acknowledged");
      // Each row must be re-read after the acknowledgement that covered it and before the feed's next poll after it.
      const verdict = () => Array.from(f.seenIds as Set<string>).map((id: string) => {
        const ack = f.log.findIndex((e: string) => e.startsWith("ack:") && e.slice(4).split(",").includes(id));
        const read = f.log.findIndex((e: string, i: number) => i > ack && e === "read-id:" + id);
        const poll = f.log.findIndex((e: string, i: number) => i > ack && e === "signals");
        return read !== -1 && (poll === -1 || read < poll) ? "ok" : read === -1 && poll === -1 ? "pending" : "late";
      });
      await wait(() => !verdict().includes("pending"), "every acknowledged row re-read or a poll passed");
      const late = verdict().filter(v => v === "late").length;
      check(late === 0, "rows owing a re-read beyond the first eight waited for the next feed poll: " + late + " of " + f.seenIds.size);
      await wait(() => Array.from(document.querySelectorAll<HTMLElement>(".dashboard__message-receipt"))
        .every(d => d.dataset.receiptState === "seen" && d.dataset.receiptLoaded === "true"), "all seventeen Seen and loaded");
      document.documentElement.dataset.receiptObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario === "dropped-refresh") {
      const laterReceipt = () => document.querySelector<HTMLElement>(`[data-signal-id="${f.later}"] .dashboard__message-receipt`);
      // 1. The owner's note to the assistant renders and its receipt read is held: it holds the read slot.
      await wait(() => receipt(), "agent-addressed row rendered");
      await wait(() => f.reads.length >= 1, "its read in flight");
      check(f.reads.every((r: any) => r.id === f.signal), "only the held row is being read");
      // 2. A note to the viewer arrives by the feed's own poll, is reported seen and acknowledged while that read holds the slot.
      f.withLater = true;
      await wait(() => laterReceipt(), "note to the viewer rendered");
      await wait(() => f.ackedAt > 0 && f.unreadAfterAck > 0, "its seen acknowledged and handled");
      for (let i = 0; i < 10; i++) await tick();
      check(!f.reads.some((r: any) => r.id === f.later), "no read of the new note while the slot is held");
      check(laterReceipt()?.dataset.receiptLoaded === "false", "the new note is not loaded before any read");
      // 3. Releasing the held read runs the refreshes asked for meanwhile: the new note is read before the next feed poll.
      const releasedAt = f.log.length;
      f.reads[0].release();
      await wait(() => f.reads.some((r: any) => r.id === f.later), "the new note's read in flight");
      const after = f.log.slice(releasedAt);
      check(after.indexOf("read:" + f.later.slice(0, 2)) !== -1 && (after.indexOf("signals") === -1 || after.indexOf("read:" + f.later.slice(0, 2)) < after.indexOf("signals")),
        "the refresh dropped while the read held the slot waited for the next feed poll: " + after.join(" "));
      check(laterReceipt()?.dataset.receiptLoaded === "false", "loaded before its read completed");
      f.reads.find((r: any) => r.id === f.later).release();
      await wait(() => laterReceipt()?.dataset.receiptState === "seen" && laterReceipt()?.dataset.receiptLoaded === "true", "new note Seen and loaded");
      document.documentElement.dataset.receiptObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
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
    document.documentElement.dataset.receiptObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
  } catch (error) {
    document.documentElement.dataset.receiptObservation = JSON.stringify({ error: String(error), scenario: f.scenario, steps, unexpected: f.unexpected });
  } finally {
    for (const read of f.reads) if (!read.released) read.release();
  }
}

test("receipt reads: a pre-acknowledgement read never marks a row loaded; dropped refreshes, rows past the pass cap and rows brought into view are read without waiting for a poll", { timeout: 180_000 }, async () => {
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
    const chrome = await findChrome();
    const outcomes: Record<string, unknown> = {};
    for (const scenario of ["pre-ack", "dropped-refresh", "beyond-eight", "awaiting-beyond-eight", "scroll-into-view", "thread-expand"]) {
      // The seventeen-row cases need every row on screen at once.
      const height = ["beyond-eight", "awaiting-beyond-eight", "thread-expand"].includes(scenario) ? 2400 : 900;
      const { stdout } = await launchChrome(chrome, [`--window-size=1280,${height}`, "--virtual-time-budget=120000", "--dump-dom",
        "http://127.0.0.1:" + address.port + "/app?w=11111111-1111-4111-8111-111111111111&case=" + scenario], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
      const raw = stdout.match(/data-receipt-observation="([^"]*)"/)?.[1];
      outcomes[scenario] = raw ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"))
        : { error: "the rendered app did not finish the observation: " + stdout.slice(0, 400) };
    }
    // Every case runs and is reported, so one failure never hides another's outcome.
    const failed = Object.entries(outcomes).filter(([, result]: [string, any]) => result.error !== undefined || result.ok !== true);
    assert.deepEqual(failed, [], JSON.stringify(outcomes));
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
