import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { templates } from "./templates.mjs";
import { renderTemplate } from "./render.mjs";
import { PUBLISHED_TEMPLATE_KEYS, publishTemplates } from "./publish.mjs";

const actions = (text) => [...text.matchAll(/{{(.*?)}}/gs)].map((match) => match[1]);

test("the sign-in email carries the code and keeps the link", async () => {
  const magicLink = templates.find((template) => template.key === "magic_link");
  const html = await renderTemplate(magicLink);
  assert.equal(html.split("{{ .Token }}").length - 1, 1, "the code appears once, in the body");
  assert.ok(html.includes('href="{{ .ConfirmationURL }}"'), "the sign-in button still links");
  assert.match(magicLink.subject, /{{ \.Token }}/, "the code is in the subject, as for the security code");
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

test("publish writes exactly the rendered templates GoTrue loads from the site", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "commonswarm-auth-email-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await publishTemplates(outputDir);
  assert.deepEqual(PUBLISHED_TEMPLATE_KEYS, ["magic_link"]);
  for (const key of PUBLISHED_TEMPLATE_KEYS) {
    const template = templates.find((candidate) => candidate.key === key);
    assert.equal(await readFile(join(outputDir, `${key}.html`), "utf8"), await renderTemplate(template));
  }
});
