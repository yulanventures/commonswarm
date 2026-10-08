import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { join } from "node:path";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
type Geometry = {
  width: number;
  overflow: boolean;
  laneTouchTargets: boolean;
  primitiveTouchTargets: boolean;
  hostileElements: number;
  hostileText: boolean;
  hostileInTitle: boolean;
  hostileInDoing: boolean;
  hostileInQueue: boolean;
  hostileInGate: boolean;
  hostileInModel: boolean;
  hostileInActivity: boolean;
  readonlySteerButtons: number;
  sampleSteerButtons: number;
  sampleManage: number;
  banner: string;
  bannerTone: string;
  foreignFixButtons: number;
  fixSentenceCount: number;
  foreignPosts: number;
  unreportedActivity: number;
  missingTitle: string;
};

test("Agent view meets 44px targets, wraps at 320 and 390, and keeps hostile text as text", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-agent-geometry-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
    bundle: true,
    entryPoints: ["src/lib/home-agent.ts"],
    format: "iife",
    globalName: "HomeAgent",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script);
  const tokens = await readFile(new URL("../../styles/tokens.css", import.meta.url), "utf8");
  const primitivesCss = await readFile(new URL("../../styles/home/primitives.css", import.meta.url), "utf8");
  const css = await readFile(new URL("../../styles/home/agent.css", import.meta.url), "utf8");
  try {
    await writeFile(fixture, `<!doctype html><html><head><style>
      * { box-sizing: border-box; } body { margin: 0; font-family: sans-serif; }
      ${tokens} ${primitivesCss} ${css}
    </style></head><body><div id="root"></div>
      <script>${script}</script><script>
      (async () => {
        const hostile = '<img src=x onerror="document.title=1">';
        const mayOn = { up: true, down: true, startNow: true, notYet: true, release: true };
        const mayOff = { up: false, down: false, startNow: false, notYet: false, release: false };
        const state = (kind, word, detail, attention, fix) => ({
          kind, word, detail, attention, fix,
        });
        const agent = (overrides) => ({
          id: 'agent', name: 'Claude ' + hostile, label: 'Your Claude ' + hostile, nestedLabel: 'Claude',
          ownerId: 'tom', ownerFirstName: 'Tom', ownerInitial: 'T', yours: true, tint: 0, hosted: true,
          state: state('working', 'Working', "Doing ‘Book plumber’ since 9:40 am", false,
            { action: null, allowed: false, askWho: null, sentence: '' }),
          ...overrides,
        });
        const working = {
          found: true, sample: false, homeHref: '?v=catchup', agent: agent(),
          ownership: 'Tom’s agent (you)', receive: 'Checks messages when you chat with it.',
          workspaceName: 'Home',
          doingNow: { todoId: 'now', title: 'Compare flights ' + hostile, href: '#now', meta: 'From you', detail: 'Checking bags.' },
          upNext: [
            { todoId: 'one', position: 1, title: 'Order filters ' + hostile, href: '#one', meta: 'From Nikki', may: mayOn },
            { todoId: 'two', position: 2, title: 'Read the draft', href: '#two', meta: 'From Marcus', may: mayOn },
            { todoId: 'three', position: 3, title: 'Book plumber', href: '#three', meta: 'From you', may: mayOn },
          ],
          notYet: [{ todoId: 'hold', position: 0, title: 'Renew passports', href: '#hold', meta: 'From you',
            gate: 'On hold until ‘Get quotes’ is done. ' + hostile, may: mayOn }],
          atSetTime: [{ todoId: 'later', title: 'Send the note', href: '#later', whenLine: 'Joins Claude’s line at 9:00 pm. Claude sees it the next time it checks.' }],
          doneRecently: [{ todoId: 'done', title: 'Pay the bill', href: '#done', meta: 'Done by your Claude · 10:40 am' }],
          facts: {
            model: 'Claude ' + hostile, receive: 'Checks messages when you chat with it.', lastActive: 'Active 2 hours ago',
            listsAndDocs: { id: 'lists', label: 'Lists & docs', detail: 'Allowed until you withdraw it.', state: 'on' },
            postsHere: { id: 'posts', label: 'What it posts here', detail: 'Always', state: 'always' },
          },
          activity: { ageLabel: 'Live now', phaseLabel: 'Tool running', toolTitle: 'Read files ' + hostile, emptyMessage: null },
          may: { steer: true, remove: true }, workPolicy: 'owner',
        };
        const nikki = {
          found: true, sample: false, homeHref: '?v=catchup',
          agent: agent({
            id: 'muse', name: 'Muse', label: 'Nikki’s Muse', nestedLabel: 'Muse', ownerId: 'nikki',
            ownerFirstName: 'Nikki', ownerInitial: 'N', yours: false, tint: 1,
            state: state('idle', 'Idle', 'Active 2 hours ago', true, { action: 'resume', allowed: true, askWho: 'Nikki', sentence: 'Ask Nikki to resume it.' }),
          }),
          ownership: 'Nikki’s agent', receive: 'Checks messages when Nikki chats with it.',
          workspaceName: 'Home', doingNow: null,
          upNext: [{ todoId: 'one', position: 1, title: 'Order filters', href: '#one', meta: 'From Nikki', may: mayOn }],
          notYet: [{ todoId: 'hold', position: 0, title: 'Hold', href: '#hold', meta: 'From Nikki', gate: 'On hold until Friday.', may: mayOn }],
          atSetTime: [], doneRecently: [],
          facts: { model: 'Muse Spark', receive: 'Checks messages when Nikki chats with it.', lastActive: 'Active 2 hours ago', listsAndDocs: { id: 'lists', label: 'Lists & docs', detail: '', state: 'on' }, postsHere: {id:'posts',label:'What it posts here',detail:'',state:'always'} },
          activity: { ageLabel: 'No frames received', phaseLabel: null, toolTitle: null, emptyMessage: 'No activity frames received' },
          may: { steer: true },
        };
        const disconnected = {
          ...working,
          doingNow: null,
          upNext: [{ todoId: 'one', position: 1, title: 'Order filters', href: '#one', meta: 'From you', may: mayOff }],
          notYet: [], atSetTime: [], doneRecently: [],
          agent: agent({
            state: state('disconnected', 'Disconnected', 'Key turned off', true,
              { action: 'new-key', allowed: true, askWho: null, sentence: 'It needs a new key to connect again.' }),
          }),
        };
        const sample = {
          ...working,
          sample: true,
          agent: agent({
            state: state('disconnected', 'Disconnected', 'Key turned off', true,
              { action: 'resume', allowed: true, askWho: null, sentence: 'Resume it so it can connect again.' }),
          }),
        };
        const missing = { found: false, homeHref: '?v=catchup' };
        const root = document.getElementById('root');
        const visible = (element, selector) => [...element.querySelectorAll(selector)].filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        const meetsTouch = (nodes) => nodes.length > 0 && nodes.every((node) => {
          const box = node.getBoundingClientRect();
          return box.height >= 44 && box.width >= 44;
        });
        const page = HomeAgent.agentPage(document, working, { onManage() {}, onQueueAction() {}, onFix() {}, onListsToggle() {}, onWorkPolicy() {}, onRemove() {} });
        root.append(page);
        const overflow = page.scrollWidth > page.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1;
        const laneTouchTargets = meetsTouch(visible(page, '.hm-agent__todo-link, .hm-agent__home, .hm-agent__action, .hm-agent__manage, .hm-agent__policy-change, .hm-agent__remove'));
        const primitiveNodes = visible(page, '[data-hm-up-next] button, [data-hm-not-yet] button, [data-hm-lists] button, [data-hm-lists] [role="switch"]');
        const primitiveTouchTargets = meetsTouch(primitiveNodes);
        const hostileElements = page.querySelectorAll('img').length;
        const hostileText = page.textContent.includes(hostile);
        const hostileInTitle = page.querySelector('h1').textContent.includes(hostile);
        const hostileInDoing = page.querySelector('[data-hm-doing] a').textContent.includes(hostile);
        const hostileInQueue = page.querySelector('[data-hm-up-next] a').textContent.includes(hostile);
        const hostileInGate = page.querySelector('[data-hm-gate]').textContent.includes(hostile);
        const hostileInModel = [...page.querySelectorAll('[data-hm-fact="model"]')].some((node) => {
          const value = node.nextElementSibling;
          return value && value.textContent.includes(hostile);
        });
        const hostileInActivity = page.querySelector('[data-agent-activity]').textContent.includes(hostile);
        root.replaceChildren();
        const other = HomeAgent.agentPage(document, nikki, { onManage() {}, onQueueAction() {}, onFix() {}, onListsToggle() {} });
        root.append(other);
        const readonlySteerButtons = other.querySelectorAll('[data-hm-up-next] button, [data-hm-not-yet] button').length;
        const foreignFixButtons = other.querySelectorAll('[data-hm-fix-action]').length;
        const fixSentenceCount = other.textContent.split('Ask Nikki to resume it.').length - 1;
        const foreignPosts = other.querySelectorAll('[data-switch-id="posts"]').length;
        root.replaceChildren(HomeAgent.agentPage(document, {...working,activity:null}, {}));
        const unreportedActivity = root.querySelectorAll('[data-hm-activity]').length;
        root.replaceChildren();
        const cut = HomeAgent.agentPage(document, disconnected, { onManage() {}, onQueueAction() {}, onFix() {}, onListsToggle() {} });
        root.append(cut);
        const bannerTone = cut.querySelector('[data-hm-banner] .hm-notice-tone').textContent;
        const banner = cut.querySelector('[data-hm-banner]') ? cut.querySelector('[data-hm-banner] .hm-notice-text').textContent : '';
        root.replaceChildren();
        const preview = HomeAgent.agentPage(document, sample, { onManage() {}, onQueueAction() {}, onFix() {}, onListsToggle() {} });
        root.append(preview);
        const sampleSteerButtons = preview.querySelectorAll('[data-hm-up-next] button, [data-hm-not-yet] button, [data-hm-fix-action]').length;
        const sampleManage = preview.querySelectorAll('[data-hm-manage]').length;
        root.replaceChildren();
        const lost = HomeAgent.agentPage(document, missing, {});
        root.append(lost);
        const metrics = {
          width: innerWidth,
          overflow,
          laneTouchTargets,
          primitiveTouchTargets,
          hostileElements,
          hostileText,
          hostileInTitle,
          hostileInDoing,
          hostileInQueue,
          hostileInGate,
          hostileInModel,
          hostileInActivity,
          readonlySteerButtons,
          sampleSteerButtons,
          sampleManage,
          banner, bannerTone,
          foreignFixButtons,
          fixSentenceCount,
          foreignPosts,
          unreportedActivity,
          missingTitle: lost.querySelector('h1').textContent,
        };
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
      })();
      </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [320, 390, 1440]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `the agent builder must finish its DOM interactions at ${width}px`);
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
      assert.equal(geometry.width, width);
      assert.equal(geometry.overflow, false, `${width}px must not overflow horizontally`);
      assert.equal(geometry.laneTouchTargets, true, `${width}px lane-owned agent controls meet the 44px minimum`);
      assert.equal(geometry.primitiveTouchTargets, true, `${width}px real queue and switch controls meet the independent 44px minimum`);
      assert.equal(geometry.hostileElements, 0);
      assert.equal(geometry.hostileText, true);
      assert.equal(geometry.hostileInTitle, true);
      assert.equal(geometry.hostileInDoing, true);
      assert.equal(geometry.hostileInQueue, true);
      assert.equal(geometry.hostileInGate, true);
      assert.equal(geometry.hostileInModel, true);
      assert.equal(geometry.hostileInActivity, true);
      assert.equal(geometry.readonlySteerButtons, 0);
      assert.equal(geometry.sampleSteerButtons, 0);
      assert.equal(geometry.sampleManage, 0);
      assert.equal(geometry.foreignFixButtons, 0);
      assert.equal(geometry.fixSentenceCount, 1, "What to do owns the fix sentence; the status pill must not repeat it");
      assert.equal(geometry.foreignPosts, 0, "the locked posts row is only for your own agent");
      assert.equal(geometry.unreportedActivity, 0, "no activity section until activity was reported");
      assert.equal(geometry.bannerTone, "Attention: ");
      assert.equal(geometry.banner, "Disconnected: key turned off. Nothing in its line moves until it reconnects.");
      assert.equal(geometry.missingTitle, "Nothing with this link in Home.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
