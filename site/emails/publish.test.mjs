import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { templates } from "./templates.mjs";
import { renderTemplate } from "./render.mjs";
import { PUBLISHED_TEMPLATE_KEYS, publishTemplates } from "./publish.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const actions = (text) => [...text.matchAll(/{{(.*?)}}/gs)].map((match) => match[1]);
const magicLink = templates.find((template) => template.key === "magic_link");

test("the sign-in email carries the code in its body only, and keeps the link", async () => {
  const html = await renderTemplate(magicLink);
  assert.equal(html.split("{{ .Token }}").length - 1, 1, "the code appears once, in the body");
  assert.ok(html.includes('href="{{ .ConfirmationURL }}"'), "the sign-in button still links");
  // The code grants a session: it must not reach lock-screen previews or mail metadata.
  assert.deepEqual(actions(magicLink.subject), [], "the subject is fixed text");
  assert.deepEqual(actions(magicLink.preheader), [], "the preheader is fixed text");
  assert.ok(!html.includes(`${magicLink.preheader}{{`), "no field follows the preheader");
  assert.match(html, /once in total/, "the email says the code and the button work once between them");
  assert.match(html, /10 minutes/, "the email states the pinned expiry");
});

test("every template uses only plain fields it declares, so GoTrue parses it instead of falling back", async () => {
  for (const template of templates) {
    const html = await renderTemplate(template);
    for (const action of [...actions(html), ...actions(template.subject)]) {
      const field = /^ \.([A-Za-z]+) $/.exec(action)?.[1];
      assert.ok(field, `${template.key}: "{{${action}}}" is not a plain {{ .Field }}`);
      assert.ok(template.variables.includes(field), `${template.key}: ${field} is used but not declared`);
    }
  }
});

test("the release artifact is exactly the rendered templates, with their pinned digests", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "commonswarm-auth-email-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await publishTemplates(outputDir);
  assert.deepEqual(PUBLISHED_TEMPLATE_KEYS, ["magic_link"]);
  assert.deepEqual((await readdir(outputDir)).sort(), ["SHA256SUMS", "magic_link.html"]);
  const sums = await readFile(join(outputDir, "SHA256SUMS"), "utf8");
  for (const key of PUBLISHED_TEMPLATE_KEYS) {
    const template = templates.find((candidate) => candidate.key === key);
    const html = await renderTemplate(template);
    assert.equal(await readFile(join(outputDir, `${key}.html`), "utf8"), html);
    assert.ok(sums.includes(`${createHash("sha256").update(html).digest("hex")}  ${key}.html\n`));
  }
});

test("GoTrue's templates are served read-only on an internal network only GoTrue joins, never from the site", async () => {
  const compose = await readFile(join(repoRoot, "deploy/supabase-stack/compose.yaml"), "utf8");
  const start = compose.indexOf("\n  auth-templates:\n");
  assert.ok(start > 0, "the stack defines the auth-templates service");
  const block = compose.slice(start + 1, compose.indexOf("\n  postgrest:\n", start));
  assert.match(block, /image: caddy:[0-9.]+-alpine@sha256:[0-9a-f]{64}\n/, "the server image is pinned by digest");
  assert.match(block, /read_only: true/);
  assert.match(block, /:\/srv\/auth-templates:ro\n/, "the reviewed bytes are mounted read-only");
  assert.doesNotMatch(block, /ports:/, "no host port: only GoTrue's network reaches it");
  // Isolated from the shared bridge: its only network is internal, and GoTrue is its only peer.
  assert.match(block, /    networks:\n      auth-templates-net: \{\}\n/, "auth-templates joins only its own network");
  assert.doesNotMatch(block, /commonswarm-net/, "auth-templates is not on the shared bridge");
  const members = [...compose.matchAll(/^  ([a-z-]+):\n(?:(?!^  [a-z-]+:\n)[\s\S])*?^      auth-templates-net:/gm)].map((m) => m[1]);
  assert.deepEqual(members.sort(), ["auth-templates", "gotrue"], "only GoTrue shares that network");
  const networks = compose.slice(compose.search(/^networks:$/m));
  assert.match(networks, /\n  auth-templates-net:\n    internal: true\n/, "the network is internal: no gateway, no route out");
  const sitePackage = await readFile(join(repoRoot, "site/package.json"), "utf8");
  assert.doesNotMatch(sitePackage, /publish\.mjs|auth-email/, "site builds never publish auth templates");
});
