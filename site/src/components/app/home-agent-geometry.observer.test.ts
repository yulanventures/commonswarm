import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import {
  agentOrb,
  notice,
  queueRow,
  statusLine,
  switchRow,
} from "../../lib/home-primitives.ts";

const primitiveStub = `
export function personAvatar(doc) { return doc.createElement("span"); }
export function agentOrb(doc, a, opts) {
  const el = doc.createElement("span");
  el.dataset.hmOrb = "";
  el.style.cssText = "display:inline-flex;inline-size:"+opts.size+"px;block-size:"+opts.size+"px;flex:none;";
  el.textContent = a.name;
  return el;
}
export function capsule(doc) { return doc.createElement("span"); }
export function statusLine(doc, s) {
  const el = doc.createElement("div");
  el.dataset.hmStatus = s.kind;
  el.textContent = s.word + " " + s.detail;
  return el;
}
export function objectCard(doc) { return doc.createElement("a"); }
export function needsYouCard(doc) { return doc.createElement("article"); }
export function choiceChips(doc) { return doc.createElement("fieldset"); }
export function switchRow(doc, s, onToggle) {
  if (s.state === "always" || s.state === "never") {
    const p = doc.createElement("p");
    p.textContent = s.label + " " + (s.state === "always" ? "Always" : "Never");
    return p;
  }
  const button = doc.createElement("button");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", s.state === "on" ? "true" : "false");
  button.textContent = s.label;
  button.addEventListener("click", () => onToggle(s));
  return button;
}
export function queueRow(doc, q, onAction) {
  const li = doc.createElement("li");
  const link = doc.createElement("a");
  link.href = q.href;
  link.textContent = q.title;
  li.append(link);
  const buttons = [
    ["up", "up", "Move up"],
    ["down", "down", "Move down"],
    ["startNow", "start-now", "Start now"],
    ["notYet", "not-yet", "Not yet"],
    ["release", "release", "Release"],
  ];
  for (const [flag, action, label] of buttons) {
    if (!q.may[flag]) continue;
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => onAction(action, q));
    li.append(button);
  }
  return li;
}
export function notice(doc, text) {
  const el = doc.createElement("p");
  el.textContent = text;
  return el;
}
`;

const implemented = [queueRow, switchRow, notice, agentOrb, statusLine].every(
  (fn) => !/\bpending\s*\(/.test(Function.prototype.toString.call(fn)),
);

type Geometry = {
  width: number;
  overflow: boolean;
  laneTouchTargets: boolean;
  primitiveTouchTargets: boolean;
  usedRealPrimitives: boolean;
  stubForcesTouchSize: boolean;
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
  foreignFixButtons: number;
  missingTitle: string;
};

nodeTest("geometry stubs never pin 44px; the observer uses real primitives once they exist", () => {
  assert.equal(primitiveStub.includes("minHeight"), false);
  assert.equal(primitiveStub.includes("minWidth"), false);
  assert.equal(primitiveStub.includes("44px"), false);
  const pending = [queueRow, switchRow, notice, agentOrb, statusLine].some(
    (fn) => /\bpending\s*\(/.test(Function.prototype.toString.call(fn)),
  );
  assert.equal(implemented, !pending);
});

test("Agent view meets 44px targets, wraps at 320 and 390, and keeps hostile text as text", { timeout: 60_000 }, async () => {
  assert.equal(primitiveStub.includes("minHeight"), false);
  assert.equal(primitiveStub.includes("minWidth"), false);
  assert.equal(primitiveStub.includes("44px"), false);
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
    plugins: implemented ? [] : [{
      name: "lane-a-primitive-stubs",
      setup(plugin) {
        plugin.onLoad({ filter: /home-primitives\.ts$/ }, () => ({ contents: primitiveStub, loader: "ts" }));
      },
    }],
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script);
  if (!implemented) {
    assert.equal(/min(?:Height|Width)\s*=\s*"44px"/.test(script), false);
  }
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
        const usedRealPrimitives = ${implemented ? "true" : "false"};
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
          may: { steer: true },
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
          facts: { model: 'Muse Spark', receive: 'Checks messages when Nikki chats with it.', lastActive: 'Active 2 hours ago', listsAndDocs: { id: 'lists', label: 'Lists & docs', detail: '', state: 'on' }, postsHere: null },
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
        const page = HomeAgent.agentPage(document, working, { onManage() {}, onQueueAction() {}, onFix() {}, onListsToggle() {} });
        root.append(page);
        const overflow = page.scrollWidth > page.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1;
        const laneTouchTargets = meetsTouch(visible(page, '.hm-agent__todo-link, .hm-agent__home, .hm-agent__action, .hm-agent__manage'));
        const primitiveNodes = visible(page, '[data-hm-up-next] button, [data-hm-not-yet] button, [data-hm-lists] button, [data-hm-lists] [role="switch"]');
        const primitiveTouchTargets = meetsTouch(primitiveNodes);
        const stubForcesTouchSize = !usedRealPrimitives && primitiveNodes.some((node) => {
          const box = node.getBoundingClientRect();
          return box.height >= 44 && box.width >= 44;
        });
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
        root.replaceChildren();
        const cut = HomeAgent.agentPage(document, disconnected, { onManage() {}, onQueueAction() {}, onFix() {}, onListsToggle() {} });
        root.append(cut);
        const banner = cut.querySelector('[data-hm-banner]') ? cut.querySelector('[data-hm-banner]').textContent : '';
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
          usedRealPrimitives,
          stubForcesTouchSize,
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
          banner,
          foreignFixButtons,
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
      assert.equal(geometry.usedRealPrimitives, implemented);
      assert.equal(geometry.laneTouchTargets, true, `${width}px lane-owned agent controls meet the 44px minimum`);
      if (implemented) {
        assert.equal(geometry.primitiveTouchTargets, true, `${width}px queue and switch controls from home-primitives meet the 44px minimum`);
      } else {
        assert.equal(geometry.stubForcesTouchSize, false, `${width}px stubs must not pin queue or switch controls at 44px`);
      }
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
      assert.equal(geometry.banner, "Disconnected: key turned off. Nothing in its line moves until it reconnects.");
      assert.equal(geometry.missingTitle, "Nothing with this link in Home.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
