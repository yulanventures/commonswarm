import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

type PaneSnapshot = {
  listsVisible: boolean;
  feedVisible: boolean;
  pendingVisible: boolean;
  errorVisible: boolean;
  inviteVisible: boolean;
  noAgentsVisible: boolean;
  channelView: string;
  listsText: string;
  feedText: string;
  setupText: string;
  search: string;
};

type PaneMetrics = {
  width: number;
  search: string;
  state: string;
  signals: boolean;
  receipts: boolean;
  openingReads: { signals: boolean; receipts: boolean };
  opening: PaneSnapshot;
  before: PaneSnapshot;
  after: PaneSnapshot | null;
  created: PaneSnapshot | null;
  error?: string;
};

const USER = "11111111-1111-4111-8111-111111111111";

// CI only. The production dashboard, not a copy of the decision, has to keep Lists up.
test("lists at 1440 stays visible after the feed and receipt reads", { timeout: 90_000 }, async () => {
  const component = fileURLToPath(new URL("./LiveDashboard.astro", import.meta.url));
  const raw = await readFile(component, "utf8");
  const script = raw.split("<script>")[1]?.split("</script>")[0];
  assert.ok(script);
  const bundle = (await build({
    stdin: { contents: script, loader: "ts", resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "LiveDashboard.script.ts" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: {
      "import.meta.env": JSON.stringify({
        PUBLIC_SUPABASE_URL: "https://api.test.invalid",
        PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key",
      }),
    },
  })).outputFiles[0]?.text;
  assert.ok(bundle, "LiveDashboard must bundle");
  assert.match(bundle, /paneForRoute/);
  assert.match(bundle, /applyRoute/);
  assert.doesNotMatch(bundle, /backgroundRefreshMayChangeView/);

  const user = {
    id: USER,
    aud: "authenticated",
    role: "authenticated",
    email: "synthetic@example.test",
    app_metadata: {},
    user_metadata: { user_name: "Tom" },
    created_at: "2026-10-01T00:00:00.000Z",
  };
  const signal = {
    id: "sig-1",
    from: "agent-1",
    from_kind: "agent",
    to: null,
    to_agent: null,
    kind: "note",
    body: "Hello from the fixture",
    about: null,
    until: null,
    created_at: "2026-10-05T12:00:00.000Z",
    attachments: [],
    channel_id: null,
    thread_root_id: null,
    broadcast_to_channel: false,
    in_reply_to: null,
  };
  const principal = {
    principal_id: "agent-1",
    name: "Ada",
    model: null,
    transport: "local",
    turn_only: false,
    owner_user_id: USER,
    revoked_at: null,
    workspace_id: "W",
    created_at: "2026-10-01T00:00:00.000Z",
  };
  const markup = `<!doctype html><html><head><style>
    [hidden] { display: none !important; }
    section { display: block; min-height: 48px; }
  </style></head><body>
    <live-dashboard class="dashboard" data-state="loading">
      <div class="dashboard__root">
        <section data-panel="loading"><p data-loading-label>Loading</p></section>
        <section data-panel="signed-out" hidden><p data-auth-error hidden></p><button type="button" data-signout>Sign out</button></section>
        <section data-panel="create" hidden><h1 data-create-title></h1><strong data-account-name></strong><form data-create-form></form></section>
        <section data-panel="workspace-error" hidden><p data-workspace-error></p><button type="button" data-retry-workspaces>Try again</button><button type="button" data-signout>Sign out</button></section>
        <section data-panel="channel" hidden>
          <div class="hm-frame">
            <div data-home-rail-slot></div>
            <div data-home-catchup hidden></div>
            <div data-home-workspace-shell></div>
            <div data-home-side-slot></div>
            <div data-home-phone-bar></div>
            <nav data-home-workspace-nav="phone"></nav>
            <div class="dashboard__channel">
              <h2 data-channel-name>Channel</h2>
              <p data-channel-description></p>
              <p data-channel-id></p>
              <button type="button" data-refresh hidden>Refresh</button>
              <span data-update-count hidden></span>
              <span data-broadcast-count></span>
              <span data-direct-count></span>
              <p data-channel-receipt hidden></p>
              <p data-live-chip hidden>Live</p>
              <button type="button" data-invite-collaborator>Invite someone</button>
              <section data-channel-view="invite" hidden>
                <button type="button" data-close-invite><span data-close-invite-label>Back to Add an agent</span></button>
                <p data-invite-workspace></p>
                <p data-invite-error hidden></p>
                <p data-invite-status></p>
              </section>
              <section data-channel-view="connect" hidden>
                <button type="button" data-close-connect>Back</button>
                <p data-connect-exit-status hidden></p>
              </section>
              <section data-channel-view="agent-choice" hidden><h1>Add an agent</h1></section>
              <section data-channel-view="no-agents"><h2>Set up your workspace</h2></section>
              <section data-channel-view="feed-pending" hidden><h2>Opening the live channel…</h2></section>
              <section data-channel-view="feed-empty" hidden><h2 data-feed-empty-title></h2><p data-feed-empty-detail></p></section>
              <section data-channel-view="feed-error" hidden><p data-feed-error></p></section>
              <section class="dashboard__feed-view" data-channel-view="feed" hidden>
                <button type="button" data-feed-filter="all" aria-pressed="true">All</button>
                <button type="button" data-feed-filter="broadcast">To everyone</button>
                <button type="button" data-feed-filter="direct-to-you">To you</button>
                <div data-feed-more hidden></div>
                <ol data-feed-list></ol>
              </section>
              <section data-channel-view="objects" hidden><h1>Lists</h1></section>
              <section data-channel-view="files" hidden><h1>Files</h1></section>
              <section data-channel-view="brain" hidden><h1>Wiki</h1></section>
              <form data-composer hidden><textarea data-composer-input></textarea></form>
            </div>
          </div>
        </section>
      </div>
      <form data-channel-create-form>
        <input data-channel-new-slug value="ops" />
        <button type="submit" data-channel-create-submit>Create channel</button>
      </form>
    </live-dashboard>
    <script>
      window.__paneReads = { signals: false, receipts: false, invites: 0 };
      const createdChannels = [];
      let releaseFeedReads = () => {};
      const feedReadsHeld = new Promise((resolve) => { releaseFeedReads = resolve; });
      window.__releaseFeedReads = () => releaseFeedReads();
      const user = ${JSON.stringify(user)};
      const signalRow = ${JSON.stringify(signal)};
      const principalRow = ${JSON.stringify(principal)};
      localStorage.setItem("sb-api-auth-token", JSON.stringify({
        access_token: "synthetic-human", refresh_token: "synthetic-refresh", token_type: "bearer",
        expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
      }));
      window.WebSocket = class {
        constructor() { this.readyState = 1; }
        close() {}
        send() {}
        addEventListener() {}
        removeEventListener() {}
      };
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = request.url;
        let body = null;
        if (request.method !== "GET" && request.method !== "HEAD") {
          try { body = JSON.parse(await request.text()); } catch { body = null; }
        }
        const json = (value, status = 200) => Response.json(value, { status });
        if (url.endsWith("/auth/v1/user")) return json(user);
        if (url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
        if (url.includes("/functions/v1/read")) {
          if (body && body.resource === "renewal_grants") return json({ grants: [] });
          if (body && body.resource === "pending_access") return json({ pending: [] });
          return json({});
        }
        if (url.includes("/rest/v1/rpc/signal_delivery_receipts")) {
          await feedReadsHeld;
          window.__paneReads.receipts = true;
          return json({ addressed: false, receipts: [] });
        }
        if (url.includes("/functions/v1/command")) {
          if (body && body.command && body.command.kind === "channel_create") {
            const row = {
              channel_id: "ch-ops",
              workspace_id: "W",
              slug: body.command.slug,
              purpose: body.command.purpose ?? null,
              created_by_principal: "",
              created_by_kind: "human",
              created_at: "2026-10-06T00:00:00.000Z",
              archived_at: null,
            };
            createdChannels.push(row);
            return json({ status: "accepted", channel: row });
          }
          return json("");
        }
        if (url.includes("/rest/v1/pending_invitations")) {
          window.__paneReads.invites += 1;
          return json([]);
        }
        if (url.includes("/rest/v1/channels")) return json(createdChannels);
        if (url.includes("/rest/v1/workspaces")) return json([{ workspace_id: "W", name: "Home", archived_at: null }]);
        if (url.includes("/rest/v1/agent_principals")) return json([principalRow]);
        if (url.includes("/rest/v1/member_profiles")) return json([{ user_id: user.id, display_name: "Tom", role: "owner" }]);
        if (url.includes("/rest/v1/signals") && request.method === "GET") {
          await feedReadsHeld;
          window.__paneReads.signals = true;
          return json([signalRow]);
        }
        if (url.includes("/rest/v1/")) return json([]);
        return json("");
      };
    </script>
    <script>__DASHBOARD_BUNDLE__</script>
    <script>
      const pane = (name) => document.querySelector('section[data-channel-view="' + name + '"]');
      const visible = (name) => {
        const node = pane(name);
        return !!node && node.getClientRects().length > 0;
      };
      const snap = () => {
        const app = document.querySelector("live-dashboard");
        return {
          listsVisible: visible("objects"),
          feedVisible: visible("feed"),
          pendingVisible: visible("feed-pending"),
          errorVisible: visible("feed-error"),
          inviteVisible: visible("invite"),
          noAgentsVisible: visible("no-agents"),
          channelView: app && app.dataset.channelView || "",
          listsText: (pane("objects") && pane("objects").textContent) || "",
          feedText: (pane("feed") && pane("feed").textContent) || "",
          setupText: (pane("no-agents") && pane("no-agents").textContent) || "",
          search: location.search,
        };
      };
      const report = (result) => {
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(result))));
      };
      const waitFor = async (predicate) => {
        for (let tries = 0; tries < 500; tries += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("timed out");
      };
      (async () => {
        const app = document.querySelector("live-dashboard");
        await waitFor(() => app.dataset.state === "channel");
        const opening = snap();
        const openingReads = { signals: window.__paneReads.signals, receipts: window.__paneReads.receipts };
        window.__releaseFeedReads();
        await waitFor(() => window.__paneReads.signals && window.__paneReads.receipts);
        if (location.search.includes("v=lists")) {
          await waitFor(() => window.__paneReads.invites >= 2);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const before = snap();
        let after = null;
        let created = null;
        if (location.search.includes("v=lists")) {
          document.querySelector("[data-invite-collaborator]").click();
          await waitFor(() => visible("invite"));
          const back = document.querySelector("[data-close-invite]");
          if (!back || !back.textContent.includes("Back to the channel")) {
            throw new Error("close label: " + (back && back.textContent));
          }
          back.click();
          await waitFor(() => visible("feed") && !visible("objects") && !location.search.includes("v=lists"));
          after = snap();
          document.querySelector("[data-home-pane='lists']").click();
          await waitFor(() => visible("objects") && location.search.includes("v=lists"));
          document.querySelector("[data-channel-create-form]").requestSubmit();
          await waitFor(() => (visible("feed") || visible("feed-empty")) && location.search.includes("c=ch-ops") && !location.search.includes("v=lists"));
          created = snap();
        }
        report({
          width: innerWidth,
          search: location.search,
          state: app.dataset.state,
          signals: window.__paneReads.signals,
          receipts: window.__paneReads.receipts,
          openingReads,
          opening,
          before,
          after,
          created,
        });
      })().catch((error) => report({
        width: innerWidth,
        search: location.search,
        state: document.querySelector("live-dashboard")?.dataset.state || "",
        signals: window.__paneReads.signals,
        receipts: window.__paneReads.receipts,
        openingReads: { signals: window.__paneReads.signals, receipts: window.__paneReads.receipts },
        opening: snap(),
        before: snap(),
        after: null,
        created: null,
        error: String(error && error.stack || error),
      }));
    </script>
  </body></html>`;
  const page = markup.replace("__DASHBOARD_BUNDLE__", () => bundle.replace(/<\/script/gi, "<\\/script"));

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-pane-address-"));
  try {
    const chrome = await findChrome();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const load = async (search: string) => {
      const { stdout } = await launchChrome(chrome, [
        `--user-data-dir=${join(directory, search.includes("lists") ? "lists" : "chat")}`,
        "--window-size=1440,900",
        "--virtual-time-budget=30000",
        "--dump-dom",
        `${origin}/app${search}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 45_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `${search} must finish the feed and receipt reads`);
      return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as PaneMetrics;
    };

    const lists = await load("?w=W&v=lists");
    assert.equal(lists.error, undefined, lists.error);
    assert.equal(lists.width, 1440);
    assert.equal(lists.opening.search, "?w=W&v=lists");
    assert.equal(lists.before.search, "?w=W&v=lists");
    assert.equal(lists.state, "channel");
    assert.equal(lists.openingReads.signals, false);
    assert.equal(lists.openingReads.receipts, false);
    assert.equal(lists.opening.setupText.includes("Set up your workspace"), true);
    assert.equal(lists.opening.noAgentsVisible, false);
    assert.equal(lists.opening.listsVisible, true);
    assert.equal(lists.opening.feedVisible, false);
    assert.equal(lists.opening.pendingVisible, false);
    assert.equal(lists.opening.channelView, "objects");
    assert.equal(lists.signals, true);
    assert.equal(lists.receipts, true);
    assert.equal(lists.before.listsVisible, true);
    assert.equal(lists.before.feedVisible, false);
    assert.equal(lists.before.pendingVisible, false);
    assert.equal(lists.before.errorVisible, false);
    assert.equal(lists.before.noAgentsVisible, false);
    assert.equal(lists.before.listsText.includes("Lists"), true);
    assert.ok(lists.after);
    assert.equal(lists.after.search, "?w=W");
    assert.equal(lists.after.listsVisible, false);
    assert.equal(lists.after.feedVisible, true);
    assert.equal(lists.after.pendingVisible, false);
    assert.equal(lists.after.errorVisible, false);
    assert.equal(lists.after.inviteVisible, false);
    assert.equal(lists.after.noAgentsVisible, false);
    assert.equal(lists.after.channelView, "feed");
    assert.ok(lists.created);
    assert.equal(lists.created.search.includes("v=lists"), false);
    assert.equal(lists.created.search.includes("c=ch-ops"), true);
    assert.equal(lists.created.listsVisible, false);
    assert.equal(lists.created.feedVisible || lists.created.channelView === "feed-empty", true);
    assert.equal(lists.created.channelView === "feed" || lists.created.channelView === "feed-empty", true);

    const chat = await load("?w=W");
    assert.equal(chat.error, undefined, chat.error);
    assert.equal(chat.width, 1440);
    assert.equal(chat.search, "?w=W");
    assert.equal(chat.openingReads.signals, false);
    assert.equal(chat.openingReads.receipts, false);
    assert.equal(chat.opening.noAgentsVisible, false);
    assert.equal(chat.opening.pendingVisible, true);
    assert.equal(chat.opening.feedVisible, false);
    assert.equal(chat.opening.listsVisible, false);
    assert.equal(chat.opening.channelView, "feed-pending");
    assert.equal(chat.signals, true);
    assert.equal(chat.receipts, true);
    assert.equal(chat.before.feedVisible, true);
    assert.equal(chat.before.noAgentsVisible, false);
    assert.equal(chat.before.listsVisible, false);
    assert.equal(chat.before.feedText.includes("Hello from the fixture"), true);
    assert.equal(chat.after, null);
    assert.equal(chat.created, null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
