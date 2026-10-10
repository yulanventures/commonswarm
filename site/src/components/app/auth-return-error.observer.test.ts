/** CI only: shared headless launcher, fresh profile, no installed Chrome app. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { build } from "esbuild";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

/*
 * The real sign-in view with an expired-link error in the address. Chrome loads the component's own
 * markup and its bundled script; only the HTTP boundary is stubbed. The same error is fed in the hash
 * (implicit flow) and in the query string, and a control load carries none.
 */
const EXPIRED = "That sign-in link has expired or was already used.";
const ERROR = "error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";

interface Observation {
  error?: string;
  messageVisible: boolean;
  messageText: string;
  resendVisible: boolean;
  focusedWithoutAddress: string;
  otpRequests: { email: string }[];
  emailSentVisible: boolean;
  sentTo: string;
  messageAfterSend: boolean;
  reboot?: { signedInState: string; signedOutState: string; choicesVisible: boolean; messageVisible: boolean; messageText: string };
}

const observe = `<script>
  const waitFor = async (predicate) => {
    for (let tries = 0; tries < 250; ++tries) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for the sign-in view");
  };
  const one = selector => document.querySelector(selector);
  const shown = node => { if (!node) return false; const box = node.getBoundingClientRect(); return !node.hidden && box.width > 0 && box.height > 0; };
  const report = result => { document.documentElement.dataset.authObservation = btoa(unescape(encodeURIComponent(JSON.stringify(result)))); };
  (async () => {
    await waitFor(() => shown(one('[data-auth-view="choices"]')) && shown(one("#dashboard-email")));
    const box = one("[data-auth-link-error]"), resend = one("[data-auth-resend]");
    const messageVisible = shown(box), messageText = one("[data-auth-link-error-text]").textContent;
    const resendVisible = shown(resend);
    let focusedWithoutAddress = "";
    if (resendVisible) {
      resend.click();
      focusedWithoutAddress = document.activeElement && document.activeElement.id || "";
      one("#dashboard-email").value = "synthetic@example.test";
      resend.click();
      await waitFor(() => shown(one('[data-auth-view="email-sent"]')));
    }
    let reboot;
    if (__REBOOT__) {
      // Another document signs in and then out through the real auth client; each broadcast makes this page boot again.
      const app = one("live-dashboard");
      const other = src => new Promise(resolve => { const frame = document.createElement("iframe"); frame.onload = resolve; frame.src = src; document.body.append(frame); });
      await other("/signin");
      await waitFor(() => app.dataset.state !== "signed-out" && app.dataset.state !== "loading");
      const signedInState = app.dataset.state;
      await other("/signout");
      await waitFor(() => app.dataset.state === "signed-out");
      reboot = { signedInState, signedOutState: app.dataset.state, choicesVisible: shown(one('[data-auth-view="choices"]')), messageVisible: shown(box), messageText: one("[data-auth-link-error-text]").textContent };
    }
    report({
      reboot, messageVisible, messageText, resendVisible, focusedWithoutAddress, otpRequests: window.otpRequests,
      emailSentVisible: shown(one('[data-auth-view="email-sent"]')), sentTo: one("[data-auth-email]").textContent,
      messageAfterSend: shown(box),
    });
  })().catch(error => report({ error: String(error) }));
</script>`;

// A second document that signs in with a session the stubbed user endpoint accepts.
const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() };
const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${segment({ alg: "HS256", typ: "JWT" })}.${segment({ sub: user.id, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.${Buffer.from("synthetic").toString("base64url")}`;

// Mock only the HTTP boundary. The component, auth client and email helper are real.
const setup = `<script>
  window.otpRequests = [];
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/auth/v1/user")) return Response.json(${JSON.stringify(user)});
    if (request.url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
    if (request.url.startsWith("https://api.test.invalid/auth/v1/otp")) {
      window.otpRequests.push({ email: (await request.json()).email });
      return Response.json({});
    }
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };
</script>`;

async function observeSignIn(suffix: string, reboot = false): Promise<Observation> {
  const component = fileURLToPath(new URL("./LiveDashboard.astro", import.meta.url));
  const source = await readFile(component, "utf8");
  const script = source.split("<script>")[1]?.split("</script>")[0]; assert.ok(script);
  const bundleScript = async (contents: string) => (await build({
    stdin: { contents, loader: "ts", resolveDir: dirname(component) }, bundle: true, write: false,
    format: "iife", platform: "browser", define: { "import.meta.env": JSON.stringify({ PUBLIC_SUPABASE_URL: "https://api.test.invalid", PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key" }) },
  })).outputFiles[0]!.text;
  const bundle = await bundleScript(script);
  const signIn = await bundleScript(`import { client } from "../../lib/commonswarm"; void client()!.auth.setSession({ access_token: ${JSON.stringify(token)}, refresh_token: "synthetic-refresh" });`);
  const signOut = await bundleScript('import { client } from "../../lib/commonswarm"; void client()!.auth.signOut({ scope: "local" });');
  const markup = source.replace(/^---[\s\S]*?---\n/u, "").split("<script>")[0]!;
  const html = `<!doctype html><html><body>${markup}${setup}<script>${bundle}</script>${observe.replace("__REBOOT__", String(reboot))}</body></html>`;
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    const other = request.url === "/signin" ? signIn : request.url === "/signout" ? signOut : null;
    response.end(other ? `<!doctype html><html><body>${setup}<script>${other}</script></body></html>` : html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = await realpath(tmpdir()), profile = await mkdtemp(join(root, "cswarm-auth-return."));
  try {
    const chrome = await findChrome();
    const address = server.address(); assert.ok(address && typeof address === "object");
    const { stdout } = await launchChrome(chrome, [
      "--password-store=basic", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", `http://127.0.0.1:${address.port}/app${suffix}`,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000, killSignal: "SIGKILL" });
    const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-auth-observation="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
    assert.ok(encoded, "the rendered sign-in view must report its observations");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Observation;
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const resolved = await realpath(profile);
    assert.ok(dirname(resolved) === root && basename(resolved).startsWith("cswarm-auth-return.") && resolved !== process.env.HOME);
    execFileSync("rm", ["-r", resolved], { stdio: "pipe" });
  }
}

for (const [where, suffix] of [["hash", `#${ERROR}`], ["query string", `?${ERROR}`]] as const) {
  test(`an expired sign-in link in the ${where} shows the message and a working Send a new link`, { skip: process.platform === "darwin", timeout: 90000 }, async () => {
    const result = await observeSignIn(suffix);
    assert.equal(result.error, undefined);
    assert.equal(result.messageVisible, true);
    assert.equal(result.messageText, EXPIRED);
    assert.equal(result.resendVisible, true);
    // Without an address the button moves to the address field.
    assert.equal(result.focusedWithoutAddress, "dashboard-email");
    // With an address it submits the email form: one request, then the "email sent" view.
    assert.deepEqual(result.otpRequests, [{ email: "synthetic@example.test" }]);
    assert.equal(result.emailSentVisible, true);
    assert.equal(result.sentTo, "synthetic@example.test");
    assert.equal(result.messageAfterSend, false);
  });
}

test("control: the sign-in view without an auth error shows no message", { skip: process.platform === "darwin", timeout: 90000 }, async () => {
  const result = await observeSignIn("");
  assert.equal(result.error, undefined);
  assert.equal(result.messageVisible, false);
  assert.equal(result.messageText, "");
  assert.equal(result.resendVisible, false);
  assert.deepEqual(result.otpRequests, []);
});

test("a later signed-out boot in the same tab does not show the returned error again", { skip: process.platform === "darwin", timeout: 90000 }, async () => {
  const result = await observeSignIn(`#${ERROR}`, true);
  assert.equal(result.error, undefined);
  assert.equal(result.messageVisible, true);
  assert.equal(result.messageText, EXPIRED);
  assert.ok(result.reboot, "the page must report the re-boot");
  // Positive control: the page left the signed-out panel for a signed-in boot, then booted signed-out again.
  assert.notEqual(result.reboot.signedInState, "signed-out");
  assert.equal(result.reboot.signedOutState, "signed-out");
  assert.equal(result.reboot.choicesVisible, true);
  assert.equal(result.reboot.messageVisible, false);
  assert.equal(result.reboot.messageText, "");
});
