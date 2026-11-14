// Verify only (never merge): count release markers in the built site.
import { test } from "node:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const MARKERS = {
  "new": ["Attachments aren't available in private channels.", "AttachmentsRefused", "could not confirm this channel is open", "Remove the files to send this message.", "sort_rank,visibility", "channel_id,visibility", "attachRefused", "data-attach-refused"],
  "earlier": ["dashboard__thread-faces", "dashboard__thread-last", "hm-lead-pill__body", "workspace_channel_policy_set", "channel_reorder", "channel_star_reorder", "data-rail-reorder", "data-rail-drop", "data-channel-star", "Every message", "hm-channel-star", "cswarm-member:", "cswarm-signals:", "Uploading file", "private_channel_attachments_unsupported"]
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const count = (text, needle) => text.split(needle).length - 1;

test("marker counts in the built site", (t) => {
  if (!existsSync(dist)) { t.diagnostic("MARKERS no dist"); return; }
  const appHtml = readFileSync(join(dist, "app", "index.html"), "utf8");
  // Everything reachable from /app: follow /_astro/ references through the chunks.
  const seen = new Set();
  const queue = [...appHtml.matchAll(/\/_astro\/[A-Za-z0-9_.@-]+\.(?:js|css)/g)].map((m) => m[0]);
  while (queue.length > 0) {
    const ref = queue.pop();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const file = join(dist, ref);
    if (!existsSync(file) || !ref.endsWith(".js")) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/["'`](?:\.\/|\/_astro\/)([A-Za-z0-9_.@-]+\.(?:js|css))["'`]/g)) queue.push(`/_astro/${m[1]}`);
  }
  const reach = { js: "", css: "" };
  for (const ref of seen) {
    const file = join(dist, ref);
    if (!existsSync(file)) continue;
    reach[ref.endsWith(".js") ? "js" : "css"] += readFileSync(file, "utf8") + "\n";
  }
  const all = { js: "", css: "" };
  for (const file of walk(dist)) {
    if (file.endsWith(".js")) all.js += readFileSync(file, "utf8") + "\n";
    else if (file.endsWith(".css")) all.css += readFileSync(file, "utf8") + "\n";
  }
  const line = (s) => { t.diagnostic(s); console.log(s); };
  line(`MARKERS reach files js=${[...seen].filter((r) => r.endsWith(".js")).length} css=${[...seen].filter((r) => r.endsWith(".css")).length}`);
  for (const group of Object.keys(MARKERS)) {
    for (const marker of MARKERS[group]) {
      line(`MARKERS ${JSON.stringify({ group, marker, appJs: count(reach.js, marker), appCss: count(reach.css, marker), appHtml: count(appHtml, marker), allJs: count(all.js, marker), allCss: count(all.css, marker) })}`);
    }
  }
});
