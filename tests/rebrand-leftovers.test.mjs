import assert from "node:assert/strict";
import { test } from "node:test";
import { auditRebrand, collectInputs } from "../scripts/check-rebrand-leftovers.mjs";

const inputs = collectInputs();
const baseline = auditRebrand(inputs);

test("tracked tree, built site, and release bundles have no live rebrand leftovers", { timeout: 30_000 }, () => {
  assert.deepEqual(baseline.issues, []);
  assert.ok(baseline.counts.tracked >= 1000);
  assert.ok(baseline.counts.rendered >= 10);
  assert.equal(baseline.counts.bundle, 2);
});

const oldOrg = "Ridge" + "-io";
const oldProduct = "co" + "swarm";
const repo = "https://github.com/yulanventures/commonswarm";
const mutations = [
  ["installer default", "install.sh", "yulanventures/commonswarm", `${oldOrg}/commonswarm`],
  ["npm template metadata", "npm/package.template.json", repo, `https://github.com/${oldOrg}/commonswarm`],
  ["staged npm metadata", "dist-npm/package.json", repo, `https://github.com/${oldOrg}/commonswarm`],
  ["npm README", "npm/README.md", repo, `https://github.com/${oldOrg}/commonswarm`],
  ["staged npm README", "dist-npm/README.md", repo, `https://github.com/${oldOrg}/commonswarm`],
  ["shared site URL", "site/src/lib/repository.ts", repo, `https://github.com/${oldOrg}/commonswarm`],
  ["footer link", "site/src/components/SiteFooter.astro", "const REPO = SOURCE_REPOSITORY_URL;", `const REPO = "https://github.com/${oldOrg}/commonswarm";`],
  ["download clone URL", "site/src/components/download/OtherWays.astro", "const SOURCE_REPO = `${SOURCE_REPOSITORY_URL}.git`;", `const SOURCE_REPO = "https://github.com/${oldOrg}/commonswarm.git";`],
  ["SEO source link", "site/src/components/seo/AboutCommonSwarm.astro", "href={SOURCE_REPOSITORY_URL}", `href="https://github.com/${oldOrg}/commonswarm"`],
  ["root README product", "README.md", "`CommonSwarm`, or to any data", `\`${oldProduct}\`, or to any data`],
  ["site README heading", "site/README.md", "# CommonSwarm — website", `# ${oldProduct} — website`],
  ["site README command", "site/README.md", "`cswarm working-on`", `\`${oldProduct} working-on\``],
  ["site README example", "site/README.md", "`cswarm working-on …`", `\`${oldProduct} working-on …\``],
  ["rendered home link", "site/dist/index.html", repo, `https://github.com/${oldOrg}/commonswarm`],
  ["rendered download link", "site/dist/download/index.html", repo, `https://github.com/${oldOrg}/commonswarm`],
  ["rendered SEO link", "site/dist/orchestration/index.html", repo, `https://github.com/${oldOrg}/commonswarm`],
  ["release build option", "scripts/build-release.sh", "--minify --legal-comments=none", "--legal-comments=none"],
  ["release bundle builder path", "dist-release/cswarm", "", "// /Users/builder/Developer/project/node_modules/example.js"],
  ["npm bundle builder path", "dist-npm/cswarm.cjs", "", "// /Users/builder/Developer/project/node_modules/example.js"],
  ["new script organization URL", "scripts/check-rebrand-leftovers.mjs", "", `\nhttps://github.com/${oldOrg}/commonswarm`],
];

for (const [name, path, before, after] of mutations) {
  test(`CONTROL: catches reverted ${name}`, { timeout: 30_000 }, () => {
    const original = inputs.contents.get(path);
    assert.equal(typeof original, "string", `missing ${path}`);
    assert.ok(!before || original.includes(before), `${name}: mutation did not reach fixture`);
    const mutated = new Map(inputs.contents);
    mutated.set(path, before ? original.replace(before, after) : original + after);
    const result = auditRebrand({ ...inputs, contents: mutated });
    assert.ok(result.issues.some((issue) => issue.startsWith(`${path}:`)), `${name}: ${result.issues.join("; ")}`);
  });
}
