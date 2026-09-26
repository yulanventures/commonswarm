import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { providerFixtures } from "../../../scripts/provider-fixtures.js";
import {
  AUTH_PROVIDERS,
  authProvider,
  signInDoors,
} from "../../lib/auth-providers.js";

test("signed-out /app onramp is cold-stranger, provider-first, free, draft-legal", async () => {
  const source = await readFile(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  const panelStart = source.indexOf('data-panel="signed-out"');
  assert.ok(panelStart >= 0, "signed-out panel must exist");
  const panelEnd = source.indexOf('data-panel="create"', panelStart);
  assert.ok(panelEnd > panelStart);
  const panel = source.slice(panelStart, panelEnd);

  assert.match(panel, /data-signed-out-onramp/);
  assert.match(panel, /Sign up free or log in<\/h1>/);
  assert.match(panel, /<p class="dashboard__eyebrow">CommonSwarm<\/p>/);
  assert.match(panel, /Continue with \{signInMethods\}\./);
  assert.match(
    source,
    /const signInMethods = signInDoors\(await enabledProvidersForBuild\(\{/,
  );
  assert.match(panel, /The free plan includes 10 workspaces and requires no card\./);
  assert.doesNotMatch(panel, /open the same account/);
  assert.doesNotMatch(panel, /workspaces you belong to/i);
  assert.doesNotMatch(panel, /invitation/i);

  /*
   * The OAuth control is GENERATED here, so this pins the COMPONENT's position, not a label.
   * The claim it used to make — "Sign in with GitHub" appears after the email field — cannot be
   * made against the source any more and must not be restated as if it could: the label and the
   * provider set now come from auth-providers.ts and the deployment. The built page is checked
   * below instead, which is where a label exists.
   */
  const email = panel.indexOf('id="dashboard-email"');
  const providerButtons = panel.indexOf("<ProviderButtons");
  assert.ok(
    providerButtons >= 0 && email > providerButtons,
    "the generated provider buttons must precede email in the shared auth view",
  );
  /*
   * Astro's braced JSX-style template comments are compiled away, so they are not markup. They
   * ARE text in this file, and the comment beside these buttons NAMES the control it replaced.
   * Strip those comments before asserting, or this control goes red on the sentence that
   * explains why it exists.
   */
  const markup = panel.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  assert.doesNotMatch(
    markup,
    /data-signin-github|Sign in with GitHub/,
    "the signed-out panel must not hand-write a provider button or its label",
  );
  assert.match(panel, /data-auth-view="choices">/);
  assert.doesNotMatch(panel, /data-auth-view="choices" hidden/);
  assert.match(panel, /Email me a sign-in link/);
  assert.match(panel, /No password\. The link returns you to this page\./);
  assert.match(panel, /Use a different address/);

  assert.match(panel, /href="\/terms"/);
  assert.match(panel, /href="\/privacy"/);
  assert.match(panel, /drafts published for review \(not yet in force\)/);
  assert.doesNotMatch(panel, /by using this service you agree/i);

  /*
   * The handler is bound to the panel's own generated buttons, by the generic attribute. A
   * looser `/signInWithProvider\(/` would also match the re-authentication handler further down
   * the file, so it would stay green with this panel's handler deleted.
   */
  assert.match(source, /\[data-signed-out-onramp\] \[data-signin-provider\]/);
  assert.match(source, /signInWithProvider\(\s*\n?\s*button\.dataset\.signinProvider/);
  assert.doesNotMatch(
    source,
    /signInWithGitHub/,
    "the named GitHub wrapper is gone from this page; a dead import would keep it in the bundle",
  );
  assert.match(source, /showAuthView\("choices"\)/);
});

/*
 * The BUILT panel, because the label a reader sees exists only after the build.
 *
 * The source test above cannot say what the buttons read: the component renders one per
 * provider the fixture reported at build time. So this reads the all-providers fixture and asserts
 * the panel's buttons are exactly the providers AUTH_PROVIDERS names, with its labels character
 * for character. The ordinary offline build intentionally renders no provider buttons; this test
 * asks the local GoTrue-shaped fixture for every provider so it never depends on site/.env or a
 * deployment.
 */
test("the built signed-out panel offers generated provider buttons", async () => {
  const fixture = (await providerFixtures())
    .find(({ enabled }) => enabled.length === AUTH_PROVIDERS.length);
  assert.ok(fixture, "the provider fixtures must include the all-providers state");
  const html = await readFile(
    new URL("app/index.html", fixture.dir),
    "utf8",
  );
  const start = html.indexOf('data-signed-out-onramp');
  assert.ok(start >= 0, "the all-providers fixture has no signed-out panel");
  const end = html.indexOf('data-panel="create"', start);
  assert.ok(end > start, "the signed-out panel has no end in the built page");
  const panel = html.slice(start, end);

  assert.match(
    panel,
    new RegExp(
      `Continue with ${signInDoors(fixture.enabled.map(authProvider))}`
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
    "the sign-in sentence must name the same doors as the rendered provider buttons",
  );

  const ids = [...new Set(
    [...panel.matchAll(/data-signin-provider="([^"]+)"/g)].map((match) => match[1] as string),
  )];
  assert.deepEqual(
    ids,
    AUTH_PROVIDERS.map((provider) => provider.id),
    "the signed-out buttons must preserve the deliberate provider order",
  );
  for (const id of ids) {
    const provider = authProvider(id);
    assert.match(
      panel,
      new RegExp(
        `<button[^>]*data-signin-provider="${provider.id}"[^>]*>\\s*` +
          `${provider.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</button>`,
      ),
      `the ${id} button must read exactly "${provider.label}", the label in auth-providers.ts`,
    );
  }
  assert.ok(
    ids.every((id) => AUTH_PROVIDERS.some((provider) => provider.id === id)),
    "every rendered button must be a provider AUTH_PROVIDERS names",
  );
  const providerAt = panel.indexOf("data-signin-provider");
  const dividerAt = panel.indexOf("dashboard__auth-divider");
  const emailAt = panel.indexOf('id="dashboard-email"');
  assert.ok(
    providerAt >= 0 && dividerAt > providerAt && emailAt > dividerAt,
    "the built choices view must put providers first, then the divider, then email",
  );
  assert.match(
    panel,
    /<button class="dashboard__button dashboard__button--secondary" type="submit">\s*Email me a sign-in link/,
    "the email submit must remain available without competing with the first provider button",
  );
});

test("the signed-out divider disappears when no provider is enabled", async () => {
  const fixture = (await providerFixtures()).find(({ enabled }) => enabled.length === 0);
  assert.ok(fixture, "the provider fixtures must include the no-providers state");
  const html = await readFile(new URL("app/index.html", fixture.dir), "utf8");
  const start = html.indexOf("data-signed-out-onramp");
  const end = html.indexOf('data-panel="create"', start);
  assert.ok(start >= 0 && end > start);
  const panel = html.slice(start, end);
  assert.doesNotMatch(panel, /data-signin-provider/);
  assert.doesNotMatch(
    panel,
    /dashboard__auth-divider/,
    "the provider/email divider must not promise a choice when no OAuth provider rendered",
  );
  assert.match(
    panel,
    new RegExp(`Continue with ${signInDoors([])}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the offline build must promise only the emailed-link door it renders",
  );
  assert.match(panel, /id="dashboard-email"/, "email remains available without OAuth providers");
});
