import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { join } from "node:path";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

type Geometry = {
  width: number; scrollWidth: number; cardOverflow: boolean;
  order: string[]; columnActions: number; hostileElements: number; hostileSharedText: boolean; shared: string[];
  streamOverflow: boolean; streamTargets: boolean; dividers: string[]; hostileAuthorText: boolean; extrasCount: number;
};

// CI only: build the production DOM builders and check them in a real layout engine. The shared primitives
// (home-primitives.ts) come from lane P, so this runs after both lanes are merged.
test("the Details column shows only what the workspace shares, and stream decorations keep hostile text as text", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-workspace-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({ absWorkingDir: root, bundle: true, format: "iife", globalName: "HomeWorkspace", platform: "browser", write: false,
    stdin: { contents: `export * from "./src/lib/home-side-cards"; export * from "./src/lib/home-stream";`, resolveDir: root, loader: "ts" } });
  const script = bundle.outputFiles[0]?.text; assert.ok(script);
  const [tokens, primitives, workspace] = await Promise.all([read("../../styles/tokens.css"), read("../../styles/home/primitives.css"), read("../../styles/home/workspace.css")]);
  const hostile = "<img src=x onerror=\"document.title=1\">";
  const longWord = "Supercalifragilisticexpialidocious".repeat(4);
  const data = { hostile, longWord };
  try {
    await writeFile(fixture, `<!doctype html><html><head><style>
      * { box-sizing: border-box; } body { margin: 0; font-family: sans-serif; }
      ${tokens} ${primitives} ${workspace}
      #column { width: min(22rem, 100%); } #stream { width: 100%; margin: 0; padding: 0; list-style: none; }
    </style></head><body><div id="column"></div><ol id="stream"></ol>
      <script>${script}</script><script>
      (async () => {
        const data = ${JSON.stringify(data).replace(/</gu, "\\u003c")};
        const person = (id, name, you = false) => ({ id, name, firstName: name.split(' ')[0], initials: name.slice(0, 2).toUpperCase(), you, role: 'member' });
        const agent = (id, label, yours) => ({ id, name: label, label, nestedLabel: label, ownerId: 'tom', ownerFirstName: 'Tom', ownerInitial: 'T', yours, tint: 0, hosted: false, dashed: false,
          state: { kind: 'idle', word: 'Idle', detail: 'Active 2 hours ago', attention: false, fix: { action: null, allowed: false, askWho: null, sentence: '' } } });
        const vm = { sample: false, workspaceName: data.hostile + ' Home',
          sharedAgents: [{ agent: agent('a1', 'Your Claude', true), until: null }, { agent: agent('a2', 'Nikki’s Muse', false), until: null }, { agent: agent('a3', data.longWord, true), until: '12/1/2026' }] };
        const main = HomeWorkspace.buildSideCards(document, vm); document.getElementById('column').append(main);
        const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        const cardOverflow = [...document.querySelectorAll('.hm-side-card')].some((element) => element.scrollWidth > element.clientWidth + 1);

        const now = Date.parse('2026-10-05T15:00:00Z');
        const stream = document.getElementById('stream');
        const signals = [
          { id: 's1', kind: 'note', body: 'x', about: null, createdAt: '2026-10-03T10:00:00Z', when: '10:00 am', author: person('p1', data.hostile + ' Rao'), addressedToViewer: false, answered: false, attachments: [] },
          { id: 's2', kind: 'ask', body: data.hostile + ' Which plumber ' + data.longWord + '?', about: 'todo:3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b', createdAt: '2026-10-04T10:00:00Z', when: 'Yesterday', author: agent('a2', 'Nikki’s Muse', false),
            addressedToViewer: true, answered: false, attachments: [{ fileId: 'f1', versionN: 1, name: data.longWord + '.pdf', contentType: 'application/pdf', sizeBytes: 214000, href: '#f1' }] },
          { id: 's3', kind: 'note', body: 'plain', about: 'field trial', createdAt: '2026-10-05T10:00:00Z', when: '10:00 am', author: person('me', 'Tom Rao', true), addressedToViewer: false, answered: false, attachments: [] },
        ];
        const context = { workspace: { id: 'w', name: 'Home', href: '#w' }, todos: new Map([['3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b', { id: '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b', title: 'Call the plumber', href: '#t', meta: 'Added by Nikki', who: null, done: false }]]) };
        let extrasCount = 0;
        for (const row of HomeWorkspace.groupByDay(signals, now, 'en-US', 'UTC')) {
          if (row.type === 'divider') { stream.append(HomeWorkspace.buildDayDivider(document, row.label, row.key)); continue; }
          const li = document.createElement('li'); li.append(HomeWorkspace.buildAuthorLine(document, row.item));
          const extras = HomeWorkspace.buildStreamExtras(document, HomeWorkspace.deriveStreamExtras(row.item, context), () => {});
          if (extras) { li.append(extras); extrasCount += 1; }
          stream.append(li);
        }
        const streamTargets = [...stream.querySelectorAll('a, button')].filter(shown).every((element) => element.getBoundingClientRect().height >= 43.5 && element.getBoundingClientRect().width >= 43.5);
        const metrics = { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cardOverflow,
          order: [...main.children].map((child) => child.dataset.sideCard || '?'), columnActions: main.querySelectorAll('a, button, input').length,
          hostileElements: document.querySelectorAll('img').length, hostileSharedText: main.textContent.includes(data.hostile),
          shared: [...main.querySelectorAll('[data-side-card=shared] p')].map((p) => p.textContent),
          streamOverflow: stream.scrollWidth > document.documentElement.clientWidth + 1, streamTargets,
          dividers: [...stream.querySelectorAll('[data-day-divider]')].map((d) => d.textContent), hostileAuthorText: stream.querySelector('.hm-author__name').textContent.includes(data.hostile), extrasCount };
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
      })();
      </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [390]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `${width}px: the production builders must finish their DOM work`);
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;

      // To-dos, Lists, Files and Wiki live in the workspace tabs; the column keeps only what is shared here.
      assert.deepEqual(geometry.order, ["shared"]);
      assert.equal(geometry.columnActions, 0, "the workspace details column has no actions of its own");
      assert.deepEqual(geometry.shared, [
        `Everyone in ${hostile} Home sees what is posted here, including what agents post.`,
        "Your Claude can use Lists & docs here, until you withdraw it.",
        `${longWord} can use Lists & docs here until 12/1/2026, or until you withdraw it.`,
      ], "only the viewer's own agents are listed");
      assert.equal(geometry.cardOverflow, false); assert.equal(geometry.scrollWidth <= geometry.width, true);
      assert.equal(geometry.hostileElements, 0); assert.equal(geometry.hostileSharedText, true); assert.equal(geometry.hostileAuthorText, true);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
