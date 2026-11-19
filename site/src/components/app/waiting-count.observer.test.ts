/** Real site DOM/transport proof with synthetic HTTP: the Waiting on you count across every workspace. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

// Authoring gate: Waiting on you is the one place a person sees, from any channel, that something waits for them in a
// workspace they are not looking at. The credible regressions are (1) a question in a workspace past the first few
// never reaching the count, or the control being drawn only inside the phone's navigation drawer; (2) the count keeping
// an answered question; (3) a workspace the overview left out being counted as zero, so the control says "0" while a
// question may be waiting there. Only HTTP is synthetic: the real app boots signed in on workspace one's chat, reads
// the overview, the decision queue and the choices through its own clients, draws the control, opens Catch up from it
// and sends the answer through its own command path. Backend admission and the overview's SQL are owned by server suites.
function installWaitingFixture() {
  const w = window as any;
  const owner = "33333333-3333-4333-8333-333333333333";
  const agent = "22222222-2222-4222-8222-222222222222";
  const org = "55555555-5555-4555-8555-555555555555";
  const ask = "99999999-9999-4999-8999-999999999999";
  // Nine workspaces in one organization. The app opens on the first; the question is in the ninth.
  const ids = Array.from({ length: 9 }, (_, i) => `aaaaaaa${i + 1}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  const scenario = new URL(location.href).searchParams.get("case") || "answer-desktop";
  const recent = new Date(Date.now() - 60000).toISOString();
  const before = new Date(Date.now() - 86400000).toISOString();
  const until = new Date(Date.now() + 86400000).toISOString();
  const question = "Ship the newsletter today?";
  const user = { id: owner, aud: "authenticated", role: "authenticated",
    email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: before };
  // answer-*: every workspace is in the overview and the ninth has one question, which the observer answers.
  // uncounted-one-*: the overview leaves the fifth workspace out; the ninth has its question.
  // uncounted-none-*: the overview leaves the fifth workspace out; nothing waits anywhere it did count.
  const f = w.waitingFixture = { scenario, phone: scenario.endsWith("-phone"), owner, ids, ask, question,
    asked: !scenario.startsWith("uncounted-none"), uncounted: scenario.startsWith("uncounted-"), answered: false,
    overviewReads: 0, answers: [] as any[], log: [] as string[], unexpected: [] as string[] };
  const open = (id: unknown) => id === ids[8] && f.asked && !f.answered;
  const number = (id: unknown) => ids.indexOf(String(id)) + 1;
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") { f.unexpected.push(url.href); return Response.json({}, { status: 404 }); }
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/rest/v1/rpc/home_overview") {
      f.overviewReads++; f.log.push("overview");
      return Response.json({ viewer_user_id: owner, generated_at: new Date().toISOString(),
        workspaces: ids.filter(id => !(f.uncounted && id === ids[4])).map(id => ({
          workspace_id: id, name: "Workspace " + number(id), role: "owner", last_seen_at: recent, new_messages: 0, content: null,
          // No agents on the roster: an agent of the viewer's that needs fixing would be counted too.
          people: [{ user_id: owner, display_name: "Synthetic owner", role: "owner", is_viewer: true, agents: [] }],
          needs_you: { asks: open(id) ? [{ signal_id: ask, from: { kind: "agent", id: agent }, created_at: recent, until }] : [],
            assigned: [], waiting: [] } })) });
    }
    if (url.pathname === "/rest/v1/rpc/decision_queue") {
      const id = body?.p_workspace_id; f.log.push("queue:" + number(id));
      return Response.json({ workspace_id: id, generated_at: new Date().toISOString(), total: open(id) ? 1 : 0, truncated: false,
        asks: open(id) ? [{ signal_id: ask, from: { kind: "agent", id: agent, name: "Scout" }, body: question,
          created_at: recent, until, reraised: null }] : [] });
    }
    if (url.pathname === "/rest/v1/rpc/ask_choices") {
      f.log.push("choices:" + number(body?.p_workspace_id));
      return Response.json({ asks: body?.p_workspace_id === ids[8] && (body?.p_signal_ids ?? []).includes(ask) ? [{ signal_id: ask, multi: false,
        options: [{ id: "yes", label: "Yes, ship it" }, { id: "no", label: "Not yet" }],
        answer: f.answered ? { option_id: "yes", by_viewer: true } : null }] : [] });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "answer_choice") {
      // From here on the ninth workspace has nothing waiting, in the overview and in its queue.
      f.answers.push(body); f.answered = true; f.log.push("answer");
      return Response.json({ status: "accepted", choice_answer: { option_id: body.command.option_id } });
    }
    if (url.pathname === "/rest/v1/rpc/channel_unread") return Response.json({ workspace_id: body?.p_workspace_id ?? ids[0],
      generated_at: new Date().toISOString(), channels: [{ channel_id: null, slug: "general", unread: null }] });
    if (url.pathname === "/rest/v1/workspaces") return Response.json(ids.map(id => (
      { workspace_id: id, org_id: org, name: "Workspace " + number(id), archived_at: null })));
    if (url.pathname === "/rest/v1/member_profiles") return Response.json([{ user_id: owner, display_name: "Synthetic owner", role: "owner" }]);
    // Signals, channels, rosters, files and the rest: every workspace is quiet.
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

async function observeWaitingCount() {
  const w = window as any, f = w.waitingFixture;
  const tick = async () => { const r = fetch("/__observer-tick"); await r; };
  const steps: string[] = [];
  // Every count and name drawn on either copy of the control, from before the app boots: "never zero" covers the whole run.
  const texts = new Set<string>(), names = new Set<string>();
  const sample = () => {
    for (const link of Array.from(document.querySelectorAll<HTMLElement>("a.cs-waiting"))) {
      texts.add(link.querySelector("[data-waiting-count]")?.textContent ?? ""); names.add(link.getAttribute("aria-label") ?? "");
    }
  };
  new MutationObserver(sample).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label"] });
  const shown = (node: Element | null | undefined): boolean => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).display !== "none";
  };
  // The header and the phone bar are rebuilt on navigation, so the control is looked up live at each step.
  const phoneCopy = () => document.querySelector<HTMLAnchorElement>(".cs-org-phone-bar a.cs-waiting--phone");
  const deskCopy = () => document.querySelector<HTMLAnchorElement>("[data-home-workspace-shell] .hm-ws-header__actions > a.cs-waiting");
  // Catch up has no workspace header; on a desktop its own copy sits at the same far-right spot.
  const pageCopy = () => document.querySelector<HTMLAnchorElement>("[data-home-catchup] > a.cs-waiting--page");
  const read = (link: Element | null) => [link?.querySelector("[data-waiting-count]")?.textContent ?? null, link?.getAttribute("aria-label") ?? null].join("|");
  const control = () => f.phone ? phoneCopy() : deskCopy();
  const count = () => control()?.querySelector<HTMLElement>("[data-waiting-count]")?.textContent ?? null;
  const name = () => control()?.getAttribute("aria-label") ?? null;
  const route = (key: string) => new URLSearchParams(location.search).get(key);
  const state = () => "count " + JSON.stringify(count()) + ", name " + JSON.stringify(name()) + ", displayed " + shown(control()) + ", at " + location.search +
    ", requests " + f.log.join(" ") + ", steps " + steps.join(" | ");
  const wait = async (predicate: () => unknown, label: string) => {
    for (let i = 0; i < 600; i++) { if (predicate()) { steps.push(label); return; } await tick(); }
    throw new Error("timed out at " + label + "; " + state());
  };
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message + "; " + state()); };
  try {
    check(f.phone ? innerWidth <= 832 : innerWidth > 1024, "the viewport is " + innerWidth + " px wide, not a " + (f.phone ? "phone" : "desktop"));
    if (f.scenario.startsWith("uncounted-")) {
      const one = f.scenario.startsWith("uncounted-one");
      await wait(() => shown(control()) && f.overviewReads > 0 && (!one || count() === "1+"), one ? "the minimum is drawn" : "the control is drawn and the overview answered");
      // With nothing waiting, the expected reading is also what is drawn before any read. So let the reads finish: no
      // further overview read and no change on the control for thirty ticks.
      let stable = 0, last = "";
      for (let i = 0; stable < 30; i++) {
        if (i > 900) throw new Error("the count never settled; " + state());
        await tick();
        const now = f.overviewReads + "|" + count() + "|" + name();
        stable = now === last ? stable + 1 : 0; last = now;
      }
      sample();
      check(shown(control()), "the control is not displayed");
      if (one) check(count() === "1+" && name() === "Waiting on you 1+, still counting", "one known question with a workspace uncounted must read 1+");
      else check(count() === "" && name() === "Waiting on you, still counting", "nothing known with a workspace uncounted must draw no number");
      check(!texts.has("0") && !names.has("Waiting on you 0"), "an uncounted workspace was drawn as zero: counts " +
        JSON.stringify(Array.from(texts)) + ", names " + JSON.stringify(Array.from(names)));
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    // 1. Workspace one's chat has no question; the ninth workspace's question is counted from here.
    await wait(() => shown(control()) && count() === "1", "the ninth workspace's question is counted");
    check(route("w") === f.ids[0] && route("v") === null, "the app is not on workspace one's chat");
    check(name() === "Waiting on you 1", "the control's name is not its words and its number");
    if (f.phone) check(!control()!.closest("dialog.cs-org-drawer"), "the phone control is inside the navigation drawer");
    else {
      check(!shown(phoneCopy()), "the phone copy is displayed on a desktop");
      check(deskCopy()!.parentElement!.lastElementChild === deskCopy(), "the header control is not the last thing in the header's actions");
    }
    // 2. In a channel view, the control opens the Waiting on you right column (desktop) or modal sheet (phone)
    //    starting in This channel without leaving Workspace 1's chat.
    control()!.click();
    const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
    const sheet = () => document.querySelector<HTMLDialogElement>("dialog#cs-waiting-sheet");
    const switchAll = () => panel()?.querySelector<HTMLButtonElement>('[data-waiting-switch-scope="all"]') ?? null;
    await wait(
      () => route("w") === f.ids[0] && route("v") === null && (f.phone ? !!sheet()?.open : shown(panel())) && shown(switchAll()),
      "Waiting on you opens in This channel and offers Show all workspaces",
    );
    check(control()!.getAttribute("aria-expanded") === "true", "control aria-expanded is not true when open");
    if (f.phone) {
      check(panel()!.parentElement === sheet(), "phone panel is not inside the modal dialog sheet");
    } else {
      check(!sheet()?.open, "desktop opened the phone modal sheet instead of the right column");
    }
    // Switching to All workspaces lists the ninth workspace's question with its choices right in the card.
    switchAll()!.click();
    const card = () => panel()?.querySelector<HTMLElement>(`[data-waiting-card="${f.ask}"]`) ?? null;
    const options = () => Array.from(card()?.querySelectorAll<HTMLButtonElement>("button[data-decision-option]") ?? []);
    await wait(() => shown(card()) && options().length === 2, "Waiting on you lists the ninth workspace's question with its choices");
    check(card()!.dataset.waitingWorkspace === f.ids[8] && card()!.textContent!.includes(f.question), "the card is not the ninth workspace's question: " + card()!.textContent);
    check(options().map(option => option.dataset.decisionOption).join() === "yes,no", "the card's choices are not the stored ones");
    check(f.answers.length === 0, "an answer was sent before a choice was clicked");
    // 3. One choice sends one answer_choice for that ask, in the ninth workspace.
    options()[0]!.click();
    await wait(() => f.answers.length > 0, "the answer reached the command endpoint");
    const sent = f.answers[0];
    check(f.answers.length === 1 && sent.workspace_id === f.ids[8] && sent.command.kind === "answer_choice" && sent.command.signal_id === f.ask &&
      sent.command.option_id === "yes", "the answer names the wrong workspace, ask or option: " + JSON.stringify(f.answers));
    // 4. The card leaves immediately, Sent is announced, and the panel settles on Nothing waiting on you.
    await wait(() => !panel()?.querySelector(`[data-waiting-card="${f.ask}"]`) &&
      panel()?.querySelector("[data-waiting-status]")?.textContent === "Sent" &&
      panel()?.querySelector(".cs-waiting-panel__state-text")?.textContent === "Nothing waiting on you.", "the answered question left the panel and announced Sent");
    // 5. Closing on phone returns focus to the channel header Waiting on you control.
    if (f.phone) {
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-close]")!.click();
      await wait(() => !sheet()?.open && document.activeElement === control(), "closing phone sheet returned focus to header control");
    }
    // 6. The top-bar count updates to zero.
    await wait(() => shown(control()) && count() === "0", "the count reads zero after the answer");
    check(name() === "Waiting on you 0", "the control's name did not follow the count");
    check(f.answers.length === 1 && !document.querySelector(`[data-waiting-card="${f.ask}"]`), "the question came back or was answered twice");
    document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
  } catch (error) {
    document.documentElement.dataset.waitingObservation = JSON.stringify({ error: String(error), scenario: f.scenario, steps, unexpected: f.unexpected });
  }
}

/** Boots the real app once per scenario at its viewport and returns each scenario's observation. */
async function runWaitingScenarios(scenarios: readonly string[]): Promise<Record<string, any>> {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const compileFixture = (name: string) => compileFixtureFunction(new URL(import.meta.url), name);
  const app = "<!doctype html><html><head><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" +
    styles.join("\n") + "</style><script>" + await compileFixture("installWaitingFixture") + "</script></head><body>" + markup +
    "<script>" + await compileFixture("observeWaitingCount") + "</script></body></html>";
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") { setTimeout(() => { response.writeHead(204); response.end(); }, 2); return; }
    if (request.url?.startsWith("/fonts/")) { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript" : "text/html" });
    response.end(request.url === "/app.js" ? bundled.join("\n") : app);
  });
  const outcomes: Record<string, any> = {};
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const chrome = await findChrome();
    for (const scenario of scenarios) {
      // A phone (390 x 844) draws the control in the shell's top bar; a desktop (1280 x 800) in the workspace header.
      const size = scenario.endsWith("-phone") ? "390,844" : "1280,800";
      const { stdout } = await launchChrome(chrome, [`--window-size=${size}`, "--virtual-time-budget=120000", "--dump-dom",
        "http://127.0.0.1:" + address.port + "/app?w=aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa&case=" + scenario], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
      const raw = stdout.match(/data-waiting-observation="([^"]*)"/)?.[1];
      outcomes[scenario] = raw ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"))
        : { error: "the rendered app did not finish the observation: " + stdout.slice(0, 400) };
    }
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
  return outcomes;
}

// Every scenario runs and is reported, so one failure never hides another's outcome.
const failures = (outcomes: Record<string, any>) => Object.entries(outcomes).filter(([, result]) => result.error !== undefined || result.ok !== true);

test("Waiting on you: a question in the ninth workspace shows in the count from a quiet channel, and the count updates after it is answered", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["answer-phone", "answer-desktop"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting on you: an uncounted workspace makes the count a minimum, never zero", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["uncounted-one-phone", "uncounted-one-desktop", "uncounted-none-phone", "uncounted-none-desktop"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});
