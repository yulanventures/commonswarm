/** The invitation review dialog: scannable workspace/audience, full disclosure above grouped access+consent, unselected on open, reachable at 360px, and Escape returns to Review without joining. Synthetic HTTP only. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";
import { HOUSEHOLD_JOIN_CONSENT_VERSION, HOUSEHOLD_JOIN_DISCLOSURE } from "../../../../src/protocol/household-invitations.ts";

function installReviewFixture() {
  const w = window as any;
  const recipient = "33333333-3333-4333-8333-333333333333";
  const firstId = "66666666-6666-4666-8666-666666666661";
  const secondId = "66666666-6666-4666-8666-666666666662";
  const user = {
    id: recipient, aud: "authenticated", role: "authenticated", email: "synthetic@example.test",
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
  };
  const f = w.reviewFixture = {
    firstId, secondId, previews: [] as string[], accepts: [] as string[], unexpected: [] as string[], errors: [] as string[],
  };
  window.addEventListener("error", event => { f.errors.push(event.message); });
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") { f.unexpected.push(url.origin + url.pathname); return Response.json({}, { status: 404 }); }
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/functions/v1/read" && body?.resource === "human_invitations") {
      return Response.json({
        invitations: [
          {
            invitation_id: firstId, workspace_id: "11111111-1111-4111-8111-111111111111",
            workspace_name: "Allotment group", inviter_display_name: "Sam Rivera",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
          {
            invitation_id: secondId, workspace_id: "11111111-1111-4111-8111-111111111112",
            workspace_name: "Garden club", inviter_display_name: "Mei Tanaka",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ],
      });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "household_invitation") {
      const action = body.command.action;
      if (action === "preview") {
        const id = String(body.command.invitation?.invitation_id ?? "");
        f.previews.push(id);
        return Response.json({
          status: "preview",
          workspace_id: id === secondId ? "11111111-1111-4111-8111-111111111112" : "11111111-1111-4111-8111-111111111111",
          workspace_name: id === secondId ? "Garden club" : "Allotment group",
          invitation_id: id,
          audience: [
            { display_name: "Mei Tanaka", role: "owner" },
            { display_name: "Sam Rivera", role: "member" },
          ],
          disclosure: w.__fixtureDisclosure,
          expires_at: Date.now() + 86_400_000,
          preview_digest: "a".repeat(64),
          consent_version: w.__fixtureConsentVersion,
        });
      }
      if (action === "accept") {
        f.accepts.push(String(body.command.invitation?.invitation_id ?? ""));
        return Response.json({ status: "joined", workspace_name: "Garden club", content_role: body.command.content_role, agents_provisioned_by_join: false });
      }
    }
    f.unexpected.push(request.method + " " + url.pathname + " " + String(body?.command?.action ?? body?.resource ?? ""));
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };
  localStorage.setItem("sb-api-auth-token", JSON.stringify({
    access_token: "synthetic-human", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  }));
}

async function observeReview() {
  const f = (window as any).reviewFixture;
  const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>("human-invitation-inbox " + selector);
  const all = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll<T>("human-invitation-inbox " + selector)];
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
  try {
    await wait("two invitation rows", () => all("[data-invitation-row]").length === 2 && visible(one("[data-row-review]")));
    const secondRow = all("[data-invitation-row]").find(r => r.dataset.invitationRow === f.secondId)!;
    const secondReview = secondRow.querySelector<HTMLButtonElement>("[data-row-review]")!;
    secondReview.click();

    const dialog = one<HTMLDialogElement>("[data-review-dialog]")!;
    await wait("review dialog open", () => dialog.open && visible(one("[data-accept]")));
    await settle();

    check(document.activeElement === one("[data-review-heading]"), "review dialog did not focus its heading on open");

    const roleInputs = all<HTMLInputElement>("[data-role]");
    check(roleInputs.length === 2, "expected Reader and Editor radios");
    check(roleInputs.every(input => !input.checked), "a role radio was preselected on open");
    const consent = one<HTMLInputElement>("[data-consent]")!;
    check(!consent.checked, "join-as-self box was prechecked on open");

    const titleRect = one("[data-review-heading]")!.getBoundingClientRect();
    const audienceRect = one("[data-audience]")!.getBoundingClientRect();
    const disclosure = one("[data-disclosure]")!;
    const disclosureRect = disclosure.getBoundingClientRect();
    const choices = one(".human-invitations__choices")!;
    const choicesRect = choices.getBoundingClientRect();
    const decision = one(".human-invitations__decision")!;
    const consentLabel = one(".human-invitations__consent")!;
    const reviewPort = one("[data-review]")!.getBoundingClientRect();
    const actionsRect = one("[data-review-dialog] > .human-invitations__actions")!.getBoundingClientRect();
    const acceptRect = one("[data-accept]")!.getBoundingClientRect();
    const cancelRect = one("[data-cancel]")!.getBoundingClientRect();

    check(disclosure.querySelectorAll("[data-disclosure-line]").length === 4, "expected all four disclosure sentences visible");
    check(titleRect.bottom <= audienceRect.top + 28, "audience is not immediately scannable after workspace title");
    check(audienceRect.bottom <= disclosureRect.top, "audience does not precede disclosure");
    check(disclosureRect.bottom <= choicesRect.top, "full disclosure does not precede role choices");
    check(decision.contains(choices) && decision.contains(consentLabel), "role choices and join-as-self are not grouped together");

    const choiceCards = all(".human-invitations__choice");
    check(choiceCards.length === 2, "expected two role choice cards");
    const choiceRects = choiceCards.map(card => card.getBoundingClientRect());
    const choicesSideBySide = Math.abs(choiceRects[0]!.top - choiceRects[1]!.top) < 2;
    for (const r of choiceRects) {
      check(r.height >= 44, "role choice card is below 44px");
      check(r.top >= reviewPort.top - 1 && r.bottom <= reviewPort.bottom + 1, "role choice card is clipped outside visible review area");
      check(r.bottom <= actionsRect.top + 1, "role choice card sits behind action bar");
    }
    check(acceptRect.height >= 44 && acceptRect.bottom <= innerHeight + 1 && acceptRect.right <= innerWidth + 1, "Join button is not reachable");
    check(cancelRect.height >= 44 && cancelRect.bottom <= innerHeight + 1 && cancelRect.right <= innerWidth + 1, "Not now button is not reachable");
    check(dialog.scrollWidth <= dialog.clientWidth + 1, "review dialog overflows horizontally");

    // Simulate Escape dismissal via native requestClose (fires cancel then close).
    if (typeof (dialog as any).requestClose === "function") (dialog as any).requestClose();
    else {
      const ev = new Event("cancel", { cancelable: true });
      if (dialog.dispatchEvent(ev)) dialog.close();
    }
    const currentSecondReview = () => all("[data-invitation-row]").find(r => r.dataset.invitationRow === f.secondId)?.querySelector("[data-row-review]") ?? null;
    await wait("dialog closed and focus returned to originating Review", () => !dialog.open && document.activeElement === currentSecondReview());
    await settle();

    check(f.accepts.length === 0, "Escape dismissal sent an accept command");
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    check(f.errors.length === 0, "page errors: " + f.errors.join(","));
    document.documentElement.dataset.reviewObservation = JSON.stringify({
      ok: true, width: innerWidth, height: innerHeight, choicesSideBySide,
    });
  } catch (error) {
    document.documentElement.dataset.reviewObservation = JSON.stringify({
      error: String(error), stage, accepts: f.accepts, unexpected: f.unexpected, errors: f.errors,
    });
  }
}

test("invitation review keeps workspace/audience first, full disclosure before grouped choices+consent, unselected on open, reachable at 360px, and Escape returns to Review without joining", { timeout: 180_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./HumanInvitationInbox.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL(import.meta.url), "installReviewFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeReview");
  const page = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>window.__fixtureDisclosure=" + JSON.stringify(HOUSEHOLD_JOIN_DISCLOSURE) +
    ";window.__fixtureConsentVersion=" + JSON.stringify(HOUSEHOLD_JOIN_CONSENT_VERSION) + ";" + install + "</script></head><body>" + markup +
    "<script type='module'>" + observe + "</script></body></html>";
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (request.url === "/app.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); response.end(bundled.join("\n")); return; }
    if (request.url?.startsWith("/fonts/")) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const chrome = await findChrome(), outcomes: Record<string, any> = {};
    for (const [width, height] of [[360, 740], [390, 844], [1280, 800]] as const) {
      const { stdout } = await launchChrome(chrome, [`--window-size=${width},${height}`, "--virtual-time-budget=60000", "--dump-dom",
        `http://127.0.0.1:${address.port}/app`], { timeout: 60000, maxBuffer: 12 * 1024 * 1024 });
      const raw = stdout.match(/data-review-observation="([^"]*)"/)?.[1];
      outcomes[`${width}x${height}`] = raw ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")) : { error: "observer did not finish" };
    }
    assert.deepEqual(Object.entries(outcomes).filter(([, v]) => !v.ok), [], JSON.stringify(outcomes));
    assert.equal(outcomes["360x740"].choicesSideBySide, false, "360px should stack Reader and Editor");
    assert.equal(outcomes["1280x800"].choicesSideBySide, true, "desktop should show Reader and Editor side by side");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
