/** The invitations card: a second tap where Decline was declines nothing. Synthetic HTTP only. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { browserTest as test, findChrome, launchChrome } from "../../../tests/chrome.js";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";

function installInvitationFixture() {
  const w = window as any;
  const recipient = "33333333-3333-4333-8333-333333333333", invitation = "66666666-6666-4666-8666-666666666666";
  const user = { id: recipient, aud: "authenticated", role: "authenticated", email: "synthetic@example.test",
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const f = w.invitationFixture = { invitation, declines: [] as string[], unexpected: [] as string[], errors: [] as string[] };
  window.addEventListener("error", event => { f.errors.push(event.message); });
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") { f.unexpected.push(url.origin + url.pathname); return Response.json({}, { status: 404 }); }
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/functions/v1/read" && body?.resource === "human_invitations") {
      return Response.json({ invitations: f.declines.length ? [] : [{ invitation_id: invitation, workspace_id: "11111111-1111-4111-8111-111111111111",
        workspace_name: "Allotment group", inviter_display_name: "Sam Rivera", expires_at: new Date(Date.now() + 86_400_000).toISOString() }] });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "household_invitation" && body.command.action === "decline") {
      f.declines.push(String(body.command.invitation?.invitation_id));
      return Response.json({ status: "declined", invitation_id: invitation });
    }
    f.unexpected.push(request.method + " " + url.pathname + " " + String(body?.command?.action ?? body?.resource ?? ""));
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };
  localStorage.setItem("sb-api-auth-token", JSON.stringify({ access_token: "synthetic-human", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user }));
}

async function observeDecline() {
  const f = (window as any).invitationFixture;
  const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>("human-invitation-inbox " + selector);
  const visible = (el: Element | null): el is HTMLElement => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
  let stage = "boot";
  const wait = async (name: string, predicate: () => unknown) => {
    stage = name;
    const now = async () => (await (await fetch("/__observer-tick")).json()).now;
    const until = await now() + 10_000;
    while (!predicate()) { if (await now() >= until) throw new Error("timed out at " + name); }
  };
  const settle = async () => { for (let i = 0; i < 5; i++) await fetch("/__observer-tick"); };
  /* A tap goes to whatever is painted at that point, as a finger does. */
  const tapAt = (x: number, y: number) => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    (hit?.closest<HTMLElement>("button") ?? hit)?.click();
    return hit;
  };
  try {
    await wait("invitation row", () => visible(one("[data-row-decline]")));
    const opener = one<HTMLButtonElement>("[data-row-decline]")!;
    /* The points a finger could have used on Decline: its centre and just inside the middle of each edge. */
    const box = opener.getBoundingClientRect(), midX = box.left + box.width / 2, midY = box.top + box.height / 2;
    const points = [[midX, midY], [box.left + 4, midY], [box.right - 4, midY], [midX, box.top + 4], [midX, box.bottom - 4]] as const;
    for (const [x, y] of points) {
      if (!visible(one("[data-row-decline]"))) { one<HTMLButtonElement>("[data-row-keep]")?.click(); await wait("question closed", () => visible(one("[data-row-decline]"))); }
      const now = one<HTMLButtonElement>("[data-row-decline]")!.getBoundingClientRect();
      check(Math.abs(now.left - box.left) < 1 && Math.abs(now.top - box.top) < 1, "Decline moved between openings");
      check(tapAt(x, y)?.closest("[data-row-decline]"), "the first tap did not reach Decline");
      await wait("question open", () => visible(one("[data-row-decline-confirm]")));
      check(document.activeElement === one("[data-row-keep]"), "Keep it does not hold focus when the question opens");
      const second = tapAt(x, y);
      check(!second?.closest("[data-row-decline-confirm]"), "a second tap at the same point lands on Decline invitation");
      await settle();
      check(f.declines.length === 0, "a second tap at the same point declined the invitation");
    }
    if (!visible(one("[data-row-decline-confirm]"))) { one<HTMLButtonElement>("[data-row-decline]")!.click(); await wait("question reopened", () => visible(one("[data-row-decline-confirm]"))); }
    const confirm = one<HTMLButtonElement>("[data-row-decline-confirm]")!, target = confirm.getBoundingClientRect();
    check(target.width >= 44 && target.height >= 44, "Decline invitation is below 44px");
    check(tapAt(target.left + target.width / 2, target.top + target.height / 2)?.closest("[data-row-decline-confirm]"), "Decline invitation is not reachable by a tap");
    await wait("declined", () => f.declines.length > 0 && !one("[data-invitation-row]"));
    await settle();
    check(f.declines.length === 1 && f.declines[0] === f.invitation, "a deliberate Decline invitation did not send exactly one decline for this invitation");
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    document.documentElement.dataset.declineObservation = JSON.stringify({ ok: true, width: innerWidth });
  } catch (error) {
    document.documentElement.dataset.declineObservation = JSON.stringify({ error: String(error), stage, declines: f.declines, unexpected: f.unexpected, errors: f.errors,
      card: document.querySelector("human-invitation-inbox")?.outerHTML.slice(0, 400) });
  }
}

test("a second tap where Decline was never declines; a deliberate Decline invitation declines once", { timeout: 180_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./HumanInvitationInbox.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL(import.meta.url), "installInvitationFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeDecline");
  /* corner: the card floats above the composer and grows upward. top: it sits above the create form and grows downward. */
  const page = (placement: string) => "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + "</script></head><body>" + (placement === "top" ? "<live-dashboard data-state='create'></live-dashboard>" : "") + markup +
    "<script type='module'>" + observe + "</script></body></html>";
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (request.url === "/app.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); response.end(bundled.join("\n")); return; }
    if (request.url?.startsWith("/fonts/")) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page(new URL(request.url ?? "/", "http://fixture.invalid").searchParams.get("placement") ?? "corner"));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const chrome = await findChrome(), outcomes: Record<string, unknown> = {};
    for (const [width, height] of [[360, 740], [390, 844], [1024, 1366]] as const) for (const placement of ["corner", "top"] as const) {
      const { stdout } = await launchChrome(chrome, [`--window-size=${width},${height}`, "--virtual-time-budget=60000", "--dump-dom",
        `http://127.0.0.1:${address.port}/app?placement=${placement}`], { timeout: 60000, maxBuffer: 12 * 1024 * 1024 });
      const raw = stdout.match(/data-decline-observation="([^"]*)"/)?.[1];
      outcomes[`${width}-${placement}`] = raw ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")) : { error: "observer did not finish" };
    }
    assert.deepEqual(Object.entries(outcomes).filter(([, v]: [string, any]) => !v.ok), [], JSON.stringify(outcomes));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
