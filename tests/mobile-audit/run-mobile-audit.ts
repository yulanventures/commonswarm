/**
 * Mobile audit runner (CS-MOBILE-AUDIT-20261103). CI ONLY: the `mobile-audit` suite in
 * .github/workflows/server-suite.yml starts the local stack, builds the site against it and runs
 * this file. It refuses to run without RUN_BROWSER_TESTS=1 and refuses non-loopback targets.
 *
 * For each screen x viewport x theme it records horizontal overflow, small tap targets and
 * horizontally clipped controls, and takes a viewport screenshot. It is report-only: findings go
 * into mobile-audit-report.json and the process exits 0 unless the harness itself cannot run.
 *
 * Witnesses (audit-checks.ts) are recorded beside the raw lists and never filter them: read-only
 * geometry after the primary screenshot (front overlay and what it covers, small-target facts, link
 * label fragments, disclosure summaries, overlap points), then native-key keyboard witnesses last.
 * Witness findings are report-only; the job fails on capture errors and on the fixture matrix. The one exception is
 * hover stability (hover-witness.ts): a hover or focus that moves or resizes anything fails the job, at the six
 * audit viewports and in a desktop pass at 1280 and 1440 wide with a mouse.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { CONFLICT_DOC, postRefreshNote, seedHeavyWorkspace, setHouseholdDoc } from "./seed-heavy-workspace.js";
import { browserTest as test, launchPlaywrightChromium } from "../../site/tests/chrome.js";
import { CHECKS, GEOMETRY_WITNESS, runActivationWitness, runKeyboardWitness, witnessSummary, type ActivationSpec, type DeclaredOverlay, type KeyboardSpec } from "./audit-checks.js";
// The fixture regression matrix registers first, so a broken witness contract fails before the long run.
import { matrixResult } from "./witness-matrix.js";
import { hoverSummary, runHoverWitness, type HoverResult, type HoverSpec } from "./hover-witness.js";
import { runPictureChecks, type PictureCheck } from "./picture-check.js";

assert.equal(process.env.RUN_BROWSER_TESTS, "1", "the mobile audit runs in CI only (RUN_BROWSER_TESTS=1)");
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "site/dist");
const OUT = resolve(process.env.MOBILE_AUDIT_OUT ?? join(ROOT, "site/mobile-audit/out"));
const SITE_PORT = 4329;

export const VIEWPORTS = [
  { width: 360, height: 740 }, { width: 390, height: 844 }, { width: 430, height: 932 },
  { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1024, height: 1366 },
] as const;
export const THEMES = ["light", "dark"] as const;
/**
 * Targeted diagnostics, set only on a never-merge diagnostic branch: capture only these screens at these sizes
 * (mobile and desktop), each once with normal polling and once more with delivery receipts frozen. The frozen pass
 * is a control for comparison, never acceptance; every entry it writes carries freeze: true.
 */
const DIAGNOSTIC = null as { screens: string[]; sizes: string[] } | null;
const PASSES = DIAGNOSTIC ? [false, true] : [false];
/** The few Playwright route members the freeze control uses (Playwright is loaded dynamically, untyped). */
type FrozenResponse = { status: number; headers: Record<string, string>; body: Buffer };
type Route = { request(): { postData(): string | null; resourceType(): string }; continue(): Promise<void>; fulfill(response: FrozenResponse): Promise<void>;
  fetch(): Promise<{ status(): number; headers(): Record<string, string>; body(): Promise<Buffer> }> };
const diagnosed = (id: string, size: string) => !DIAGNOSTIC || (DIAGNOSTIC.screens.includes(id) && DIAGNOSTIC.sizes.includes(size));

/** One setup step; fields run in this order: media, waitFor, advance, hover, click, contextmenu, type (with text), select (with
 *  option), press, scroll, wait, settle.
 *  advance: the owner saves the doc's fixed current text (CONFLICT_DOC) from outside the page, so the page's own next save
 *  meets a newer revision. A screen with an advance step is reset to the base text before it opens (see openScreen).
 *  contextmenu: a real right-click on the element (the browser's own contextmenu event at the pointer); no click follows.
 *  select: a native <select> whose value becomes `option`, through the browser's own input and change events.
 *  settle: wait until the page's reads have finished (see `settle` below) before the next step.
 *  media: a CSS media query, evaluated by the page's own matchMedia; the step runs only where it
 *  matches (for example a phone-only drawer open), and where it matches its other fields still fail
 *  when their element is missing.
 *  waitFor: a selector that must become visible first (non-strict, first match, up to 30 s). */
type Step = { media?: string; waitFor?: string; advance?: { workspace: string; object: string }; hover?: string; click?: string; contextmenu?: string; type?: string; text?: string; select?: string;
  option?: string; press?: string; wait?: number; scroll?: string; settle?: true };
export interface Screen { id: string; kind: "view" | "dialog" | "route"; path: string; setup?: Step[]; ready?: string; signedOut?: boolean; status?: "pending"; reason?: string; states?: string[];
  /** Captured with JavaScript off (signed out): the page as a browser without scripts renders it, <noscript> included. */
  noJs?: true;
  /** Captured signed in as the seeded second viewer (seed.invitee) instead of the owner. */
  viewer?: "invitee";
  /** Selectors that must be wholly inside the viewport at capture, after settling (one more scroll is allowed). */
  frame?: string[];
  /** Seed steps (seed.json "steps") that must have been accepted; otherwise the capture is an error. */
  requiresSeed?: string[];
  /** The app's own update poll (a fetch of its page path) is answered with the served page plus one more /_astro/ asset,
   *  as after a deploy; the page's navigation itself is served unchanged. */
  newBuild?: true }

/** Starter list, replaced by site/mobile-audit/screens.json (the Designer's manifest) when present. */
const STARTER: Screen[] = [
  { id: "app.signin", kind: "view", path: "/app", ready: "[data-panel=signed-out]:not([hidden])", signedOut: true },
  { id: "app.catchup", kind: "view", path: "/app?v=catchup" },
  { id: "app.chat.general", kind: "view", path: "/app?w={workspace}&c={channel.general}" },
  { id: "app.chat.group", kind: "view", path: "/app?w={workspace}&c={channel.group}" },
  { id: "app.chat.long", kind: "view", path: "/app?w={workspace}&c={channel.long}" },
  { id: "app.chat.dm", kind: "view", path: "/app?w={workspace}", setup: [{ click: "[data-rail-agent=\"{agent}\"]" }, { wait: 600 }] },
  { id: "app.todos", kind: "view", path: "/app?w={workspace}&v=todos" },
  { id: "app.lists", kind: "view", path: "/app?w={workspace}&v=lists" },
  { id: "app.definitions", kind: "view", path: "/app?w={workspace}&v=lists", setup: [{ scroll: ".household-definitions" }, { wait: 400 }] },
  { id: "app.files", kind: "view", path: "/app?w={workspace}&v=files" },
  { id: "app.wiki", kind: "view", path: "/app?w={workspace}&v=wiki" },
  { id: "app.people", kind: "view", path: "/app?w={workspace}&v=people" },
  { id: "app.agent", kind: "view", path: "/app?w={workspace}&agent={agent}" },
  { id: "app.empty", kind: "view", path: "/app?w={emptyWorkspace}" },
  { id: "dialog.workspace-settings", kind: "dialog", path: "/app?w={workspace}", setup: [{ click: "[data-workspace-details-trigger]" }, { wait: 500 }] },
  { id: "dialog.command-palette", kind: "dialog", path: "/app?w={workspace}", setup: [{ press: "ControlOrMeta+k" }, { wait: 500 }] },
  { id: "menu.account", kind: "dialog", path: "/app?w={workspace}", setup: [{ click: "[data-user-menu-trigger]" }, { wait: 400 }] },
];

/** Overlay roots the generic rules cannot recognise, counted only while shown. */
const DECLARED_OVERLAYS: Record<string, DeclaredOverlay[]> = {
  "app.entity-detail": ["[data-entity-panel]:not([hidden])"],
  "nav.workspace-picker": ["[data-workspace-picker][open] .cs-workspace-picker__list"],
  "nav.workspace-switch": ["[data-workspace-picker][open] .cs-workspace-picker__list"],
  "menu.account": ["[data-user-menu]:not([hidden])"],
  // The invitation inbox is a fixed corner card above the composer when the viewer already has a workspace.
  "app.invitation-inbox": ['human-invitation-inbox[data-placement="corner"]:not([hidden])'],
  // The update notice is a fixed <aside> card floating over the feed and composer.
  "app.update-toast": ["[data-update-notice]:not([hidden])"],
  // An opened receipt is a card over the message: the row's floating tool bar for a settled receipt, the badge's own
  // card for a problem one.
  "menu.receipt": [".dashboard__message-tools:has(> .dashboard__message-receipt[data-receipt-quiet][open])",
    ".dashboard__message-receipt:not([data-receipt-quiet])[open]"],
  // The right-click menu (lib/context-menu.ts) is created on open and removed on close, never hidden.
  "menu.context": ['.cs-context-menu[role="menu"]'],
  // Only between 52rem and 1399px is the channel details panel a side sheet over the main column: phones
  // use a native dialog, and from 1400px it is an ordinary column beside the main one.
  "dialog.details-sheet": [{ selector: ".hm-frame > #cs-channel-details.hm-frame__side", media: "(width > 52rem) and (width <= 1399px)" }],
};
/** Keyboard witnesses, by screen. They start from the focus the app itself set, or the document entry. */
const KEYBOARD_WITNESSES: Record<string, KeyboardSpec[]> = {
  "app.people": [
    {
      name: "people-modal-native-document-boundary",
      start: { active: 'dialog[data-roster-dialog][open] #dashboard-roster-title' },
      keys: [{ key: "Tab", expect: 'dialog[data-roster-dialog][open] [data-roster-close]' }],
      // Chromium's native reverse-tab crosses document entry before returning to the last modal
      // control. Record that state, then require re-entry below; never accept a background control.
      activate: { key: "Shift+Tab", expect: { active: "body" } },
    },
    {
      name: "people-modal-native-reentry-and-escape",
      start: "document",
      keys: [{ key: "Shift+Tab", expect: 'dialog[data-roster-dialog][open] [data-pd-focus="page-workspaces"]' }],
      activate: { key: "Escape", expect: { active: ':is([data-roster-open], button[aria-label="Open navigation"])', inView: ':is([data-roster-open], button[aria-label="Open navigation"]):focus' } },
    },
  ],
  "dialog.people-confirm": [{
    name: "people-confirm-escape-keeps-roster",
    start: { active: 'dialog[data-people-confirm][open] .pd-confirm-actions > button:first-child' },
    keys: [
      { key: "Tab", expect: 'dialog[data-people-confirm][open] .pd-confirm-actions > button:last-child' },
      { key: "Shift+Tab", expect: 'dialog[data-people-confirm][open] .pd-confirm-actions > button:first-child' },
    ],
    activate: { key: "Escape", expect: { active: 'dialog[data-roster-dialog][open] [data-pd-focus="row-remove-agent-{agent}"]' } },
  }],
  // Lowering your own role: the app focuses Go back; Escape goes back to the role select, nothing is saved.
  "dialog.role-confirm": [{
    name: "role-confirm-escape-keeps-role",
    start: { active: 'dialog[data-role-confirm="{owner}"][open] [data-role-confirm-back="{owner}"]' },
    keys: [
      { key: "Tab", expect: 'dialog[data-role-confirm="{owner}"][open] [data-confirm-role="{owner}"]' },
      { key: "Shift+Tab", expect: 'dialog[data-role-confirm="{owner}"][open] [data-role-confirm-back="{owner}"]' },
    ],
    activate: { key: "Escape", expect: { active: 'dialog[data-roster-dialog][open] [data-people-detail] select[data-role-select="{owner}"]' } },
  }],
  // The right-click menu focuses its first item; arrows move between items, and Escape returns focus to the row it opened
  // from (finish(true) in lib/context-menu.ts). Nothing is run.
  "menu.context": [{
    name: "context-menu-escape-returns-to-row",
    start: { active: '.cs-context-menu[role="menu"] > .cs-context-menu__item:first-of-type' },
    keys: [
      { key: "ArrowDown", expect: '.cs-context-menu[role="menu"] > .cs-context-menu__item:nth-of-type(2)' },
      { key: "ArrowUp", expect: '.cs-context-menu[role="menu"] > .cs-context-menu__item:first-of-type' },
    ],
    activate: { key: "Escape", expect: { active: '[data-rail-agent="{agent}"]', inView: '[data-rail-agent="{agent}"]' } },
  }],
  // The review dialog opens on its heading; Tab reaches the first role, then leaves the radio group for the consent checkbox,
  // which must be revealed (not under the Join and Not now bar). Escape (like Not now) closes it without joining; the inbox then
  // checks again and returns focus to the invitation's Review button.
  "dialog.invitation-review": [{
    name: "invitation-review-escape-returns-to-review",
    start: { active: "dialog.human-invitations__dialog[data-review-dialog][open] [data-review-heading]" },
    keys: [
      { key: "Tab", expect: "dialog.human-invitations__dialog[data-review-dialog][open] .human-invitations__choice:first-child input[data-role]" },
      { key: "Tab", expect: "dialog.human-invitations__dialog[data-review-dialog][open] input[data-consent]" },
    ],
    activate: { key: "Escape", expect: { active: 'human-invitation-inbox[data-placement="corner"]:not([hidden]) [data-row-review]', inView: 'human-invitation-inbox [data-row-review]' } },
  }],
  "dialog.people-admin-access": [{
    name: "people-admin-escape-keeps-roster",
    start: { active: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] .sa-confirm__footer > button[type="button"]:not([hidden])' },
    keys: [
      { key: "Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] [data-seat-admin-grant]:not([hidden]):not([disabled])' },
      { key: "Shift+Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] .sa-confirm__footer > button[type="button"]:not([hidden])' },
    ],
    activate: { key: "Escape", expect: { active: 'dialog[data-roster-dialog][open] [data-people-detail] [data-seat-admin-toggle="workspace"]:not([disabled])' } },
  }],
  "dialog.admin-access": [
    {
      name: "seat-admin-confirm-escape",
      start: { active: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] .sa-confirm__footer > button[type="button"]:not([hidden])' },
      keys: [
        { key: "Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] [data-seat-admin-grant]:not([hidden]):not([disabled])' },
        { key: "Shift+Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] .sa-confirm__footer > button[type="button"]:not([hidden])' },
        { key: "Shift+Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] [data-seat-admin-duration]:not([disabled])' },
        { key: "Shift+Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] [data-seat-admin-scope]:not([disabled])' },
        { key: "Shift+Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] .sa-confirm__body[tabindex="0"]' },
        { key: "Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] [data-seat-admin-scope]:not([disabled])' },
        { key: "Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] [data-seat-admin-duration]:not([disabled])' },
        { key: "Tab", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] .sa-confirm__footer > button[type="button"]:not([hidden])' },
      ],
      activate: {
        key: "Escape",
        expect: {
          active: '[data-home-route-pane]:not([hidden]) [data-hm-agent="{agent}"] [data-seat-admin-slot="{agent}"][data-seat-admin-surface="agent"]:not([hidden]) [data-seat-admin="ready"] [data-seat-admin-toggle="workspace"]:not([disabled])[aria-checked="false"]',
          inView: '[data-home-route-pane]:not([hidden]) [data-hm-agent="{agent}"] [data-seat-admin-slot="{agent}"][data-seat-admin-surface="agent"]:not([hidden]) [data-seat-admin="ready"] [data-seat-admin-toggle="workspace"]',
        },
      },
    },
    {
      name: "seat-admin-confirm-cancel",
      start: { active: '[data-home-route-pane]:not([hidden]) [data-hm-agent="{agent}"] [data-seat-admin-slot="{agent}"][data-seat-admin-surface="agent"]:not([hidden]) [data-seat-admin="ready"] [data-seat-admin-toggle="workspace"]:not([disabled])[aria-checked="false"]' },
      keys: [
        { key: "Enter", expect: 'dialog.sa-confirm[data-seat-admin-confirm="workspace"][open] .sa-confirm__footer > button[type="button"]:not([hidden])' },
      ],
      activate: {
        key: "Enter",
        expect: {
          active: '[data-home-route-pane]:not([hidden]) [data-hm-agent="{agent}"] [data-seat-admin-slot="{agent}"][data-seat-admin-surface="agent"]:not([hidden]) [data-seat-admin="ready"] [data-seat-admin-toggle="workspace"]:not([disabled])[aria-checked="false"]',
          inView: '[data-home-route-pane]:not([hidden]) [data-hm-agent="{agent}"] [data-seat-admin-slot="{agent}"][data-seat-admin-surface="agent"]:not([hidden]) [data-seat-admin="ready"] [data-seat-admin-toggle="workspace"]',
        },
      },
    },
  ],
  "menu.provider": [{
    name: "provider-back",
    start: { active: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-detail="claude"] .hm-ahp__title-anchor' },
    keys: [{ key: "Shift+Tab", expect: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-detail="claude"] > [data-ahp-back]' }],
    activate: { key: "Enter", expect: { active: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-host="claude"]' } },
  }],
  "app.add-agent.existing": [{
    name: "existing-back",
    start: { active: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-existing-view]:not([hidden]) [data-ahp-existing-title]' },
    keys: [
      { key: "Shift+Tab", expect: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-existing-view]:not([hidden]) > [data-ahp-existing-back]' },
      { key: "Tab", expect: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-existing-list] .pd-agent-choice:first-child .pd-choice-add' },
      { key: "Shift+Tab", expect: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-existing-view]:not([hidden]) > [data-ahp-existing-back]' },
    ],
    activate: { key: "Enter", expect: { active: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-existing]' } },
  }],
  "route.terms": [{
    name: "skip-link",
    start: "document",
    keys: [{ key: "Tab", expect: "a.skip-link" }],
    activate: { key: "Enter", expect: { hash: "#main", inView: "#main" } },
  }],
};

/** Wait (up to 10 s) until no page read is pending and none finished in the last 400 ms, so a view that
 *  re-renders when its read returns has done so. Resolves false instead of throwing when reads never quiet. */
type Settleable = { waitForFunction: (fn: () => boolean, arg: undefined, options: { timeout: number }) => Promise<unknown> };
const settle = (page: Settleable) => page.waitForFunction(() => {
  const w = globalThis as unknown as { __auditPendingFetches?: number; __auditLastFetchDoneAt?: number };
  return (w.__auditPendingFetches ?? 0) === 0 && performance.now() - (w.__auditLastFetchDoneAt ?? 0) >= 400;
}, undefined, { timeout: 10_000 }).then(() => true, () => false);

/** Hover-stability witnesses, by screen (owner request, Nov 10): hovering or focusing a row must not move or resize
 *  anything. Unlike the other witnesses, a shift fails the audit. `require` names rows that must be measured in every
 *  mode the spec runs ({...} is filled from the seed): in the general channel, the owner's two reported cases, an
 *  agent's message addressed to the viewer and the viewer's own message addressed to an agent. */
const FEED_ROWS = ".dashboard__feed > .dashboard__message";
const ADDRESSED = ':has(.dashboard__message-target:is([data-target-kind="agent"], [data-target-kind="person"]))';
const HOVER_WITNESSES: Record<string, HoverSpec[]> = {
  "app.chat.general": [
    { name: "feed", rows: FEED_ROWS, prefer: ADDRESSED, focus: true,
      require: ['[data-signal-id="{message.addressedAgent}"]', '[data-signal-id="{message.addressedOwn}"]'] },
    // A grouped row's author is a focus-reveal: focusing it must not put it back into the flow.
    // An addressed grouped message keeps its persistent header (#382); focusing its author must not move anything.
    { name: "grouped", rows: FEED_ROWS, prefer: "[data-stream-grouped]", require: ['[data-signal-id="{message.groupedOwn}"][data-stream-grouped]'], max: 1,
      focus: true, focusTarget: ".hm-author .dashboard__message-author" },
    // An unaddressed grouped message: its author is a focus-revealed floating label, which must not move anything either.
    { name: "grouped-unaddressed", rows: FEED_ROWS, prefer: '[data-signal-id="{message.groupedBroadcast}"]',
      require: ['[data-signal-id="{message.groupedBroadcast}"][data-stream-grouped]'], max: 1,
      focus: true, focusTarget: ".hm-author .dashboard__message-author" },
    { name: "rail", rows: ":is([data-rail-channel], [data-rail-agent], [data-rail-person])", max: 6, focus: true },
    // A focused Show more survives a real feed rebuild: the control is created a frame after its row. Last, because the
    // note it posts rebuilds this page's feed; runHovers expires the note as soon as the spec finishes.
    { name: "show-more", rows: FEED_ROWS, prefer: '[data-signal-id="{message.long}"]', require: ['[data-signal-id="{message.long}"]'], max: 1,
      focus: true, focusTarget: ".dashboard__message-toggle", focusAcrossRebuild: true },
  ],
  "app.chat.group": [{ name: "feed", rows: FEED_ROWS, prefer: ADDRESSED, max: 6, focus: true },
    // A problem receipt is a badge beside its message (on the avatar, or in the gutter of a grouped one): hovering the
    // row or focusing the badge must not move anything.
    { name: "problem-receipt", rows: FEED_ROWS, prefer: '[data-signal-id="{message.failedOwn}"]', max: 2, focus: true,
      focusTarget: ".dashboard__message-receipt:not([data-receipt-quiet]) > summary",
      require: ['[data-signal-id="{message.failedOwn}"]:has(.dashboard__message-receipt:not([data-receipt-quiet]))',
        '[data-signal-id="{message.failedGrouped}"][data-stream-grouped]:has(.dashboard__message-receipt:not([data-receipt-quiet]))'] }],
  "app.chat.dm": [{ name: "feed", rows: FEED_ROWS, max: 6, focus: true }],
  "app.thread": [{ name: "feed", rows: FEED_ROWS, max: 6, focus: true }],
  "app.todos": [{ name: "todos", rows: ":is([data-todo-row], [data-home-todo])", max: 6, focus: true }],
  "app.files": [{ name: "files", rows: ".dashboard__file-row", max: 6, focus: true }],
  "app.lists": [{ name: "lists", rows: '[data-hh-action="select"]', max: 6, focus: true }],
  "dialog.command-palette": [{ name: "palette", rows: ".cp-item", max: 6 }],
  // The composer's text inset and controls must not change when it takes focus.
  "app.composer": [{ name: "composer", rows: ".dashboard__composer", max: 1, focus: true, focusTarget: "[data-composer-input]",
    require: [".dashboard__composer"] }],
  // The provider detail's Back control is visually hidden until focused; focusing it must not move the detail.
  "menu.provider": [{ name: "provider-back", rows: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-detail="claude"]', max: 1,
    focus: true, focusTarget: ":scope > [data-ahp-back]", require: ['[data-ahp-detail="claude"]'] }],
  "app.add-agent.existing": [{ name: "existing-agents", rows: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-existing-list] .pd-agent-choice', max: 6,
    focus: true, focusTarget: ".pd-choice-add", require: ['[data-ahp-existing-list] .pd-agent-choice'] }],
};
/** Desktop widths for the hover pass only (the owner's screenshots are desktop), with a mouse and no touch. */
const HOVER_VIEWPORTS = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }] as const;

/** Activation witnesses, by screen: a native tap on each link's visible label must open its own page. */
const ACTIVATION_WITNESSES: Record<string, ActivationSpec[]> = {
  "app.signin": [
    { name: "terms", link: '[data-panel="signed-out"] .dashboard__legal-note a[href="/terms"]', expect: { path: "/terms" } },
    { name: "privacy", link: '[data-panel="signed-out"] .dashboard__legal-note a[href="/privacy"]', expect: { path: "/privacy" } },
  ],
};

const loopback = (value: string) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
const fill = (value: string, ids: Record<string, string>) => value.replace(/\{([a-zA-Z.]+)\}/g, (_, key: string) => ids[key] ?? `missing-${key}`);

function screens(): Screen[] {
  const manifest = join(ROOT, "site/mobile-audit/screens.json");
  if (!existsSync(manifest)) return STARTER;
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { screens?: Screen[] } | Screen[];
  return Array.isArray(parsed) ? parsed : parsed.screens ?? STARTER;
}

/** Static server for the built site: /app -> dist/app/index.html, assets by path. Loopback only. */
function serveDist(): Promise<() => Promise<void>> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".md": "text/markdown" };
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, path);
    if (!file.startsWith(DIST)) { response.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file)) { response.writeHead(404).end("not found"); return; }
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise(done => server.listen(SITE_PORT, "127.0.0.1", () => done(() => new Promise(close => server.close(() => close())))));
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(DIST, "app/index.html")), "build the site against the local stack first");
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, string>;
  const env = { apiUrl: status.API_URL!, anonKey: status.ANON_KEY!, serviceRoleKey: status.SERVICE_ROLE_KEY!, dbUrl: status.DB_URL! };
  for (const url of [env.apiUrl, env.dbUrl]) assert.ok(loopback(url), "local stack only");
  mkdirSync(join(OUT, "shots"), { recursive: true });

  const envDir = mkdtempSync(join(tmpdir(), "cswarm-mobile-audit-"));
  const envFile = join(envDir, "functions.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_SELF_SERVE=1\nSWARM_SEAT_ADMIN=1\n");
  let functionLogs = "";
  const functions = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    { cwd: ROOT, env: { ...process.env, SWARM_ENV: "test", SWARM_SELF_SERVE: "1", SWARM_SEAT_ADMIN: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const cliState = observeFunctionCli(functions);
  const capture = (chunk: Buffer) => { functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000); };
  functions.stdout?.on("data", capture); functions.stderr?.on("data", capture);
  const closeSite = await serveDist();
  const report: Record<string, unknown>[] = [];
  let seedNotes: string[] = [];
  let captureErrors = -1;
  let witnessFailures = -1;
  let hoverFailures = -1;
  const hoverDesktop: Record<string, unknown>[] = [];
  /** Diagnostic mode only: per frozen pass, how many receipt RPC calls the control intercepted, fetched and replayed. */
  const freezeCounts: Array<{ pass: string; viewport: string; theme: string; intercepted: number; fetched: number; replayed: number }> = [];
  const inviteeFreezeCounts: typeof freezeCounts = [];
  const pictures: { viewport: string; theme: string; checks: PictureCheck[]; error: string | null }[] = [];
  let pictureFailures = -1;
  const hoverShots: string[] = [];
  try {
    for (const fn of ["command", "read"]) {
      await awaitFunctionRunning({ url: `${env.apiUrl}/functions/v1/${fn}`, fetcher: fetch, timeoutMs: 60_000,
        sleep: ms => delay(ms), now: () => Date.now(), diagnostics: () => functionLogs.slice(-4000), cliState });
    }
    const seed = await seedHeavyWorkspace(env);
    seedNotes = seed.notes;
    writeFileSync(join(OUT, "seed.json"), JSON.stringify({ ids: seed.ids, notes: seed.notes, steps: seed.steps }, null, 2));
    console.log(JSON.stringify({ phase: "seeded", steps: seed.steps.length, notes: seed.notes.length }));

    const runPool = async <T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
      const results = new Array<R>(items.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await worker(items[index]!);
        }
      }));
      return results;
    };
    /* A hover spec that makes the app refresh (focusAcrossRebuild) posts a note to the general feed and removes it when
       the spec ends. Every other open page showing that feed picks the note up, and loses it again, in the middle of its
       own measurement: the list scrolls under a held pointer or the rows around a measured one move. So a screen with
       such a spec is captured by itself, after the pooled ones. Results keep the order the screens were given in. */
    const postsRefreshNote = (id: string) => (HOVER_WITNESSES[id] ?? []).some(spec => spec.focusAcrossRebuild);
    const runScreens = async <T extends { id: string }, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> => {
      const done = new Map<T, R>();
      const pooled = items.filter(item => !postsRefreshNote(item.id));
      (await runPool(pooled, 3, worker)).forEach((result, index) => done.set(pooled[index]!, result));
      for (const item of items) if (postsRefreshNote(item.id)) done.set(item, await worker(item));
      return items.map(item => done.get(item)!);
    };

    // Installed only in the CI job (npm install --no-save), so it stays out of the lockfile and typecheck.
    const playwrightModule = "playwright";
    const { chromium } = await import(playwrightModule) as { chromium: Parameters<typeof launchPlaywrightChromium<any>>[0] };
    const browser = await launchPlaywrightChromium<any>(chromium);
    try {
      // Sign in once per viewer through the real form (password sign-in, #271); reuse its storage everywhere.
      const signIn = async (who: { email: string; password: string }) => {
        const signInContext = await browser.newContext();
        const signInPage = await signInContext.newPage();
        await signInPage.goto(`http://127.0.0.1:${SITE_PORT}/app`);
        await signInPage.waitForSelector("[data-signin-form]", { timeout: 30_000 });
        await signInPage.fill("#dashboard-email", who.email);
        await signInPage.fill("#dashboard-password", who.password);
        await signInPage.click("[data-password-signin]");
        await signInPage.waitForFunction(() => document.querySelector("live-dashboard")?.getAttribute("data-state") !== "signed-out"
          && document.querySelector("live-dashboard")?.getAttribute("data-state") !== "loading", undefined, { timeout: 30_000 });
        const state = await signInContext.storageState();
        await signInContext.close();
        return state;
      };
      const storage = await signIn(seed.owner);
      // The second viewer exists only when its invitation seed step was accepted; its screens require that step.
      const inviteeStorage = seed.invitee ? await signIn(seed.invitee) : null;

      /** One unsigned and one signed-in context, with the audit's page hooks and an explicit stored theme. */
      const openContexts = async (viewport: { width: number; height: number }, theme: string, hasTouch = true, freeze = false) => {
        const phone = viewport.width < 768 || viewport.height < 500;
        const context = await browser.newContext({ viewport, colorScheme: theme, hasTouch, isMobile: phone, deviceScaleFactor: 1 });
        // Init scripts never run with JavaScript off; the capture gives CHECKS its __name shim itself.
        const noScript = await browser.newContext({ viewport, colorScheme: theme, hasTouch, isMobile: phone, deviceScaleFactor: 1, javaScriptEnabled: false });
        const signedIn = await browser.newContext({ viewport, colorScheme: theme, hasTouch, isMobile: phone, deviceScaleFactor: 1, storageState: storage });
        const invitee = await browser.newContext({ viewport, colorScheme: theme, hasTouch, isMobile: phone, deviceScaleFactor: 1, ...(inviteeStorage ? { storageState: inviteeStorage } : {}) });
        // Diagnostic control only. The app reads receipts through the swarm_read RPC
        // (site/src/lib/commonswarm.ts browserDeliveryReceipts -> /rest/v1/rpc/signal_delivery_receipts). Each distinct
        // request body is fetched once; every later call, including one already in flight, gets that first response.
        // Counts prove the control was exercised: intercepted = every receipt call seen, fetched = first responses,
        // replayed = calls answered from the first response.
        // Each signed-in viewer gets its own cache and its own counts: a response is never replayed to another identity.
        const freezeReceipts = async (viewer: typeof signedIn, stats: { intercepted: number; fetched: number; replayed: number }) => {
          const frozen = new Map<string, Promise<FrozenResponse>>();
          await viewer.route("**/rest/v1/rpc/signal_delivery_receipts*", async (route: Route) => {
            stats.intercepted += 1;
            const key = route.request().postData() ?? "";
            let first = frozen.get(key);
            if (first) stats.replayed += 1;
            else {
              stats.fetched += 1;
              first = route.fetch().then(async response => ({ status: response.status(), headers: response.headers(), body: await response.body() }));
              frozen.set(key, first);
            }
            return route.fulfill(await first);
          });
        };
        const freezeStats = { intercepted: 0, fetched: 0, replayed: 0 };
        const inviteeFreezeStats = { intercepted: 0, fetched: 0, replayed: 0 };
        if (freeze) { await freezeReceipts(signedIn, freezeStats); await freezeReceipts(invitee, inviteeFreezeStats); }
        // tsx (esbuild keepNames) wraps nested functions in __name(); CHECKS runs in the page, so give it a no-op.
        // Also track in-flight fetches so background post-hydration loads (loadHomeWorkspace, householdDashboard,
        // skills, definitions) settle before setup steps interact with the DOM.
        for (const c of [context, signedIn, invitee]) await c.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f); window.addEventListener('storage', (e) => { if (e.key && e.key.includes('auth-token')) e.stopImmediatePropagation(); }, true); if (typeof globalThis.BroadcastChannel === 'function') { const OrigBC = globalThis.BroadcastChannel; globalThis.BroadcastChannel = class extends OrigBC { addEventListener(type, listener, opts) { if (type === 'message') return; return super.addEventListener(type, listener, opts); } set onmessage(_fn) {} }; } if (!globalThis.__auditFetchWrapped && typeof globalThis.fetch === 'function') { globalThis.__auditFetchWrapped = true; globalThis.__auditPendingFetches = 0; globalThis.__auditLastFetchDoneAt = 0; const orig = globalThis.fetch.bind(globalThis); globalThis.fetch = (...args) => { globalThis.__auditPendingFetches += 1; const path = String(args[0] && args[0].url ? args[0].url : args[0]).replace(/^[a-z]+:\\/\\/[^/]+/i, '').split('?')[0].slice(0, 80); const id = (globalThis.__auditFetchId = (globalThis.__auditFetchId || 0) + 1); (globalThis.__auditInflight = globalThis.__auditInflight || new Map()).set(id, path); let traced = null; try { const sent = args[1] && typeof args[1].body === 'string' ? JSON.parse(args[1].body) : null; if (path.endsWith('/rpc/signal_delivery_receipts') && sent) traced = { what: 'receipt-read', ids: [String(sent.p_signal_id || '')] }; else if (path.endsWith('/functions/v1/command') && sent && sent.command && sent.command.kind === 'signals_seen') traced = { what: 'seen-report', ids: (sent.command.signal_ids || []).map(String) }; } catch (e) {} const trace = (globalThis.__auditTrace = globalThis.__auditTrace || []); if (traced) { traced.n = id; traced.start = Math.round(performance.now()); trace.push(traced); if (trace.length > 300) trace.shift(); } const started = orig(...args); if (traced) started.then(async (response) => { traced.end = Math.round(performance.now()); traced.http = response.status; try { const answer = await response.clone().json(); traced.answer = traced.what === 'seen-report' ? String(answer && answer.status) : (answer === null ? 'null' : Array.isArray(answer && answer.receipts) ? 'receipts:' + answer.receipts.map((row) => row && row.seen_at ? 'seen' : 'unseen').join('+') : 'other'); } catch (e) { traced.answer = 'unreadable'; } }, (error) => { traced.end = Math.round(performance.now()); traced.answer = 'network-error'; }); return started.finally(() => { globalThis.__auditPendingFetches = Math.max(0, globalThis.__auditPendingFetches - 1); globalThis.__auditLastFetchDoneAt = performance.now(); globalThis.__auditInflight.delete(id); const recent = (globalThis.__auditRecentFetches = globalThis.__auditRecentFetches || []); recent.push([path, Math.round(performance.now())]); if (recent.length > 12) recent.shift(); }); }; }" });
        // The app is dark-first: with no stored preference it opens dark whatever the OS says
        // (app.astro). Store this theme explicitly so light captures are really light; each item
        // also records the effective theme, so a mismatch is visible rather than silent.
        for (const c of [context, signedIn, invitee]) {
          await c.addInitScript({ content: `try { localStorage.setItem("commonswarm:theme", ${JSON.stringify(theme)}); for (const k of Object.keys(localStorage)) { if (k.startsWith("commonswarm:composer-draft:")) localStorage.removeItem(k); } } catch {}` });
        }
        return { context, signedIn, noScript, invitee, freezeStats, inviteeFreezeStats };
      };

      /** Open one manifest screen: load, wait for the app, run its setup steps, check ready, settle, re-check ready.
       *  Returns whether reads settled. Shared by the main captures and the desktop hover pass. */
      const openScreen = async (page: any, screen: Screen): Promise<boolean> => {
        if (screen.newBuild) {
          const appPath = new URL(fill(screen.path, seed.ids), "http://x").pathname;
          await page.route((url: URL) => url.pathname === appPath, async (route: Route) => {
            if (route.request().resourceType() !== "fetch") return route.continue();
            const served = await route.fetch();
            const html = (await served.body()).toString("utf8");
            const asset = '<script type="module" src="/_astro/audit-next-build.js"></script>';
            const body = html.includes("</head>") ? html.replace("</head>", `${asset}</head>`) : `${asset}${html}`;
            return route.fulfill({ status: served.status(), headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(body, "utf8") });
          });
        }
        // The save-conflict doc opens at its fixed base text in every capture.
        for (const step of screen.setup ?? []) {
          if (step.advance) await setHouseholdDoc(env, seed.owner, fill(step.advance.workspace, seed.ids), fill(step.advance.object, seed.ids), CONFLICT_DOC.base);
        }
        await page.goto(`http://127.0.0.1:${SITE_PORT}${fill(screen.path, seed.ids)}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => {
          const app = document.querySelector("live-dashboard");
          if (!app) return true;
          if (app.getAttribute("data-state") === "loading") return false;
          const channelVisible = !app.querySelector<HTMLElement>(".dashboard__channel")?.hidden;
          return !(channelVisible && app.getAttribute("data-channel-view") === "feed-pending");
        }, undefined, { timeout: 30_000 });
        await page.waitForFunction(({ id, hasWorkspace }: { id: string; hasWorkspace: boolean }) => {
          if (hasWorkspace && !document.querySelector('[data-home-workspace-shell] [data-home-pane="todos"]')) return false;
          if (id.startsWith("app.definitions") && !document.querySelector('.household-definitions [data-def-action="select"]')) return false;
          if (id.startsWith("app.skills") && !document.querySelector(".household-skills [data-skill-action]")) return false;
          if (id === "app.lists" && !document.querySelector('[data-household-objects] [data-hh-action="select"]')) return false;
          const w = globalThis as unknown as { __auditPendingFetches?: number; __auditLastFetchDoneAt?: number };
          return (w.__auditPendingFetches ?? 0) === 0 && performance.now() - (w.__auditLastFetchDoneAt ?? 0) >= 400;
        }, { id: screen.id, hasWorkspace: screen.path.includes("?w=") }, { timeout: screen.path.includes("v=lists") ? 45_000 : 30_000 }).catch(() => {});
        await page.waitForTimeout(screen.path.startsWith("/app") ? 250 : 50);
        for (const step of screen.setup ?? []) {
          if (step.media && !(await page.evaluate((query: string) => window.matchMedia(query).matches, step.media))) continue;
          if (step.waitFor) await page.waitForSelector(fill(step.waitFor, seed.ids), { state: "visible", timeout: 30_000 });
          if (step.advance) await setHouseholdDoc(env, seed.owner, fill(step.advance.workspace, seed.ids), fill(step.advance.object, seed.ids), CONFLICT_DOC.current);
          if (step.hover) await page.hover(fill(step.hover, seed.ids), { timeout: 8_000 });
          if (step.click) {
            const target = fill(step.click, seed.ids);
            if ((target.startsWith(".cs-kylon-workspace-menu") || target === "[data-user-menu-trigger]" || target === "[data-account-agents-open]" || target.startsWith("[data-rail-channel-menu="))
              && await page.evaluate(() => window.matchMedia("(width <= 52rem)").matches && !document.querySelector("dialog.cs-org-drawer[open]"))) {
              await page.click('button[aria-label="Open navigation"]', { timeout: 5_000 }).catch(() => {});
              await page.waitForSelector("dialog.cs-org-drawer[open]", { state: "visible", timeout: 5_000 }).catch(() => {});
            }
            if (target === '[data-brain-topic="overview"]') {
              const waitBrainTopicLoaded = async () => {
                for (let attempt = 0; attempt < 3; attempt++) {
                  await page.waitForSelector("[data-brain-detail]:not([hidden]) :is([data-brain-body-mode]:not([hidden]), [data-brain-retry]:not([hidden]):not([disabled]))", { state: "visible", timeout: 15_000 }).catch(() => {});
                  const loaded = await page.evaluate(() => {
                    const md = document.querySelector<HTMLElement>("[data-brain-detail]:not([hidden]) [data-brain-markdown]:not([hidden])");
                    return Boolean(md && md.childElementCount > 0 && document.querySelector("[data-brain-body-mode]:not([hidden])"));
                  });
                  if (loaded) break;
                  if (await page.evaluate(() => Boolean(document.querySelector("[data-brain-retry]:not([hidden]):not([disabled])")))) {
                    await page.click("[data-brain-retry]", { timeout: 5_000 }).catch(() => {});
                  } else {
                    await page.click(target, { timeout: 8_000 }).catch(() => {});
                  }
                }
              };
              await page.click(target, { timeout: 8_000 });
              await waitBrainTopicLoaded();
              if (screen.id === "app.wiki.topic" && await page.evaluate(() => window.matchMedia("(width <= 52rem)").matches)) {
                await page.click("[data-brain-back]", { timeout: 8_000 });
                await page.waitForSelector('[data-channel-view="brain"][data-brain-selection="index"] [data-brain-topic="overview"]', { state: "visible", timeout: 8_000 });
                await page.click(target, { timeout: 8_000 });
                await waitBrainTopicLoaded();
              }
            } else if (target.startsWith("[data-rail-channel-menu=")) {
              for (let attempt = 0; attempt < 3; attempt++) {
                if (await page.evaluate(() => window.matchMedia("(width <= 52rem)").matches && !document.querySelector("dialog.cs-org-drawer[open]"))) {
                  await page.click('button[aria-label="Open navigation"]', { timeout: 5_000 }).catch(() => {});
                  await page.waitForSelector("dialog.cs-org-drawer[open]", { state: "visible", timeout: 5_000 }).catch(() => {});
                }
                await page.locator(target).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
                await page.waitForTimeout(150);
                await page.click(target, { timeout: 8_000 });
                const menuVisible = await page.waitForSelector('.cs-context-menu[role="menu"] [role="menuitem"]', { state: "visible", timeout: 1_500 }).then(() => true, () => false);
                if (menuVisible) break;
              }
            } else {
              await page.click(target, { timeout: 8_000 });
              if (target === 'button[aria-label="Open navigation"]') {
                const drawerOpen = await page.waitForSelector("dialog.cs-org-drawer[open]", { state: "visible", timeout: 1_500 }).then(() => true, () => false);
                if (!drawerOpen) await page.click(target, { timeout: 5_000 }).catch(() => {});
              } else if (target.endsWith(".hm-menu__trigger")) {
                const menuOpen = await page.waitForSelector(":is(.cs-kylon-workspace-menu, .hm-ws-header) .hm-menu__list:not([hidden])", { state: "visible", timeout: 1_500 }).then(() => true, () => false);
                if (!menuOpen) await page.click(target, { timeout: 5_000 }).catch(() => {});
              } else if (target === "[data-user-menu-trigger]") {
                const userMenuOpen = await page.waitForSelector("[data-user-menu]:not([hidden])", { state: "visible", timeout: 1_500 }).then(() => true, () => false);
                if (!userMenuOpen) await page.click(target, { timeout: 5_000 }).catch(() => {});
              } else if (target.startsWith('[data-def-action="select"]')) {
                const selected = await page.waitForSelector(`${target}[aria-current="true"]`, { state: "visible", timeout: 10_000 }).then(() => true, () => false);
                if (!selected) {
                  await page.click(target, { timeout: 5_000 }).catch(() => {});
                  await page.waitForSelector(`${target}[aria-current="true"]`, { state: "visible", timeout: 15_000 }).catch(() => {});
                }
              }
            }
          }
          if (step.contextmenu) await page.click(fill(step.contextmenu, seed.ids), { button: "right", timeout: 8_000 });
          if (step.type) await page.fill(fill(step.type, seed.ids), step.text ?? "");
          if (step.select) await page.selectOption(fill(step.select, seed.ids), step.option ?? "", { timeout: 8_000 });
          if (step.press) await page.keyboard.press(step.press);
          if (step.scroll) {
            const scrollTarget = fill(step.scroll, seed.ids);
            try { await page.locator(scrollTarget).first().scrollIntoViewIfNeeded({ timeout: 8_000 }); }
            catch { await page.waitForTimeout(300); await page.locator(scrollTarget).first().scrollIntoViewIfNeeded({ timeout: 8_000 }); }
          }
          if (step.wait) await page.waitForTimeout(step.wait);
          if (step.settle) await settle(page);
        }
        // Ready is checked AFTER setup, so a dialog's ready selector can name the opened dialog.
        if (screen.ready) await page.waitForSelector(fill(screen.ready, seed.ids), { state: "visible", timeout: 30_000 });
        // Let reads the setup started finish (and their re-renders land) before measuring: a dialog can
        // render, then render again when its read returns (workspace settings and its organizations).
        const settled = await settle(page);
        // The declared state must still be on screen after settling: a re-render that closed it would
        // otherwise be measured and photographed as if it were that state. Losing it is a capture error.
        if (screen.ready && !(await page.waitForSelector(fill(screen.ready, seed.ids), { state: "visible", timeout: 5_000 }).then(() => true, () => false))) {
          throw new Error(`ready state lost after settling: ${screen.ready}`);
        }
        // What the capture is for must actually be in the picture: scroll the first part that is not into view once, settle, and
        // check again.
        if (screen.frame?.length) {
          const parts = screen.frame.map(selector => fill(selector, seed.ids));
          const outside = () => page.evaluate((list: string[]) => list.filter(selector => {
            const el = document.querySelector(selector);
            if (!el) return true;
            const r = el.getBoundingClientRect();
            return r.width === 0 || r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth;
          }), parts) as Promise<string[]>;
          let missing = await outside();
          if (missing.length) {
            await page.locator(missing[0]!).first().evaluate((el: Element) => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
            await settle(page);
            missing = await outside();
          }
          if (missing.length) throw new Error(`not in frame after settling: ${missing.join(" | ")}`);
        }
        return settled;
      };

      /** Hover witnesses for one capture; the first addressed row is photographed at rest and on hover. */
      // The frozen diagnostic control writes its own images; the normal names never change.
      const runHovers = async (page: any, id: string, state: string, size: string, theme: string, specs: HoverSpec[], variant = "") => {
        const results: HoverResult[] = [];
        let expireNote: (() => Promise<void>) | null = null;
        // Keep the app's own focus for the keyboard witnesses that start from it afterwards.
        await page.evaluate(() => document.activeElement?.setAttribute("data-audit-hover-restore", ""));
        for (const spec of specs) {
          const filled = { ...spec, ...(spec.require ? { require: spec.require.map(selector => fill(selector, seed.ids)) } : {}),
            ...(spec.prefer ? { prefer: fill(spec.prefer, seed.ids) } : {}) };
          results.push(await runHoverWitness(page, filled, spec.prefer ? async (label: string) => {
            const shot = `shots/${id}--${state}--${size}--${theme}${variant}--${label}.png`;
            await page.screenshot({ path: join(OUT, shot) });
            hoverShots.push(shot);
          } : undefined, spec.focusAcrossRebuild ? async () => { expireNote = await postRefreshNote(env, seed.ids); } : undefined));
          // The note this spec posted ends as soon as the spec does, before any later page can open with it showing.
          const expire = expireNote as (() => Promise<void>) | null; // assigned inside the callback above
          if (expire) { await expire(); expireNote = null; }
        }
        await page.mouse.move(1, 1);
        await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>("[data-audit-hover-restore]");
          el?.removeAttribute("data-audit-hover-restore");
          if (el && el !== document.body) el.focus({ preventScroll: true });
        });
        return results;
      };

      for (const freeze of PASSES) for (const theme of THEMES) for (const viewport of VIEWPORTS) {
        const size = `${viewport.width}x${viewport.height}`;
        if (!screens().some(s => diagnosed(s.id, size))) continue;
        const { context, signedIn, noScript, invitee, freezeStats, inviteeFreezeStats } = await openContexts(viewport, theme, true, freeze);
        const batch = await runScreens(screens().filter(s => diagnosed(s.id, size)), async (screen) => {
          // The capture's identity follows the manifest entry's declared states (e.g. "empty").
          const state = screen.states?.length ? screen.states.join("+") : "default";
          const entry: Record<string, unknown> = { viewport: size, theme, id: screen.id, state, screenshot: null, error: null, ...(freeze ? { freeze } : {}) };
          if (screen.status === "pending") return { ...entry, error: "pending", reason: screen.reason ?? null };
          const unmet = (screen.requiresSeed ?? []).filter(step => !seed.steps.includes(step));
          if (unmet.length) return { ...entry, error: `seed precondition unmet: ${unmet.join(", ")}` };
          const page = await (screen.noJs ? noScript : screen.signedOut ? context : screen.viewer === "invitee" ? invitee : signedIn).newPage();
          try {
            entry.settledBeforeChecks = await openScreen(page, screen);
            // The page's own scripts are off, not the audit's: give CHECKS and the witness their __name shim (a string, so
            // tsx cannot wrap it in __name itself).
            if (screen.noJs) await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
            Object.assign(entry, await page.evaluate(CHECKS));
            const shot = `shots/${screen.id}--${state}--${size}--${theme}${freeze ? "--frozen" : ""}.png`;
            await page.screenshot({ path: join(OUT, shot) });
            entry.screenshot = shot;
            // Witnesses: read-only geometry first, then native-key keyboard witnesses, which change state.
            try { entry.witness = await page.evaluate(GEOMETRY_WITNESS, DECLARED_OVERLAYS[screen.id] ?? []); }
            catch (error) { entry.witness = { error: String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300) }; }
            const hoverSpecs = HOVER_WITNESSES[screen.id] ?? [];
            if (hoverSpecs.length) entry.hover = await runHovers(page, screen.id, state, size, theme, hoverSpecs, freeze ? "--frozen" : "");
            const keyboardSpecs = KEYBOARD_WITNESSES[screen.id] ?? [];
            if (keyboardSpecs.length) {
              // Pointer to a corner first, so :hover cannot stand in for focus.
              await page.mouse.move(1, 1);
              entry.keyboard = [];
              for (const spec of keyboardSpecs) {
                const filled: KeyboardSpec = {
                  ...spec,
                  start: spec.start === "document" ? "document" : { active: fill(spec.start.active, seed.ids) },
                  keys: spec.keys.map(step => ({ ...step, expect: fill(step.expect, seed.ids) })),
                  ...(spec.activate ? {
                    activate: {
                      ...spec.activate,
                      expect: {
                        ...spec.activate.expect,
                        ...(spec.activate.expect.active ? { active: fill(spec.activate.expect.active, seed.ids) } : {}),
                        ...(spec.activate.expect.inView ? { inView: fill(spec.activate.expect.inView, seed.ids) } : {}),
                      },
                    },
                  } : {}),
                };
                (entry.keyboard as unknown[]).push(await runKeyboardWitness(page, filled));
              }
            }
            // Activation last: it navigates away and back.
            const activationSpecs = ACTIVATION_WITNESSES[screen.id] ?? [];
            if (activationSpecs.length) {
              entry.activation = [];
              for (const spec of activationSpecs) (entry.activation as unknown[]).push(await runActivationWitness(page, spec));
            }
          } catch (error) {
            entry.error = String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300);
            console.log(JSON.stringify({ phase: "capture-error", viewport: size, theme, id: screen.id, error: entry.error }));
            try { const shot = `shots/${screen.id}--${state}--${size}--${theme}${freeze ? "--frozen" : ""}--error.png`; await page.screenshot({ path: join(OUT, shot) }); entry.screenshot = shot; } catch { /* page gone */ }
          } finally { await page.close(); }
          return entry;
        });
        report.push(...batch);
        if (freeze) freezeCounts.push({ pass: "mobile", viewport: size, theme, ...freezeStats });
        // The second viewer's frozen captures are recorded apart and are not part of the exercised-control assertion: they count
        // as controlled only where this entry shows receipt calls intercepted and replayed.
        if (freeze && batch.some(r => screens().find(s => s.id === r.id)?.viewer === "invitee")) inviteeFreezeCounts.push({ pass: "mobile", viewport: size, theme, ...inviteeFreezeStats });
        console.log(JSON.stringify({ phase: "viewport-done", viewport: size, theme, errors: batch.filter(r => r.error && r.error !== "pending").length }));
        await context.close(); await signedIn.close(); await noScript.close(); await invitee.close();
      }
      // Desktop hover pass: only the screens with hover witnesses, at desktop widths, mouse only.
      const hoverScreens = screens().filter(s => HOVER_WITNESSES[s.id] && s.status !== "pending" && !(s.requiresSeed ?? []).some(step => !seed.steps.includes(step)));
      for (const freeze of PASSES) for (const theme of THEMES) for (const viewport of HOVER_VIEWPORTS) {
        const size = `${viewport.width}x${viewport.height}`;
        if (!hoverScreens.some(s => diagnosed(s.id, size))) continue;
        const { context, signedIn, noScript, invitee, freezeStats } = await openContexts(viewport, theme, false, freeze);
        const batch = await runScreens(hoverScreens.filter(s => diagnosed(s.id, size)), async (screen) => {
          const state = screen.states?.length ? screen.states.join("+") : "default";
          const entry: Record<string, unknown> = { viewport: size, theme, id: screen.id, state, error: null, ...(freeze ? { freeze } : {}) };
          const page = await (screen.signedOut ? context : screen.viewer === "invitee" ? invitee : signedIn).newPage();
          try {
            entry.settledBeforeChecks = await openScreen(page, screen);
            entry.hover = await runHovers(page, screen.id, state, size, theme, HOVER_WITNESSES[screen.id]!, freeze ? "--frozen" : "");
          } catch (error) {
            entry.error = String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300);
            console.log(JSON.stringify({ phase: "hover-capture-error", viewport: size, theme, id: screen.id, error: entry.error }));
          } finally { await page.close(); }
          return entry;
        });
        hoverDesktop.push(...batch);
        if (freeze) freezeCounts.push({ pass: "desktop", viewport: size, theme, ...freezeStats });
        await context.close(); await signedIn.close(); await noScript.close(); await invitee.close();
      }
      // Picture check: the seeded message with one PNG and one text file, on a desktop with a mouse and on a phone.
      const general = screens().find(s => s.id === "app.chat.general");
      for (const [viewport, theme, desktop] of [[{ width: 1280, height: 800 }, "light", true], [{ width: 390, height: 844 }, "dark", false]] as const) {
        const size = `${viewport.width}x${viewport.height}`;
        if (!general || !seed.steps.includes("seed_picture")) { pictures.push({ viewport: size, theme, checks: [], error: "picture seed or general channel screen missing" }); continue; }
        const { context, signedIn, noScript, invitee } = await openContexts(viewport, theme, !desktop);
        const result = await runPictureChecks(async (setup) => {
          const page = await signedIn.newPage();
          await setup(page);
          await openScreen(page, general);
          return page;
        }, async (page, label) => {
          const shot = `shots/app.chat.general--${label}--${size}--${theme}.png`;
          await page.screenshot({ path: join(OUT, shot) });
          hoverShots.push(shot);
        }, { click: desktop });
        pictures.push({ viewport: size, theme, ...result });
        await context.close(); await signedIn.close(); await noScript.close(); await invitee.close();
      }
    } finally { await browser.close(); }
  } finally {
    const summary = { screens: new Set(report.map(r => r.id)).size, items: report.length,
      withOverflow: report.filter(r => ((r.overflow as { offenders?: unknown[] } | undefined)?.offenders?.length ?? 0) > 0).length,
      withSmallTargets: report.filter(r => ((r.tapTargets as unknown[] | undefined)?.length ?? 0) > 0).length,
      withObscured: report.filter(r => ((r.obscured as unknown[] | undefined)?.length ?? 0) > 0).length,
      withOverlaps: report.filter(r => ((r.overlaps as unknown[] | undefined)?.length ?? 0) > 0).length,
      withCollapsedText: report.filter(r => ((r.collapsed as unknown[] | undefined)?.length ?? 0) > 0).length,
      withBypassedInteractions: report.filter(r => ((r.bypassedInteractions as unknown[] | undefined)?.length ?? 0) > 0).length,
      themeMismatches: report.filter(r => r.effectiveTheme !== undefined && r.effectiveTheme !== r.theme).length,
      errors: report.filter(r => r.error && r.error !== "pending").length,
      // Witness counters, appended; every key above keeps its meaning.
      witnesses: witnessSummary(report),
      // Hover stability: the six audit viewports plus the desktop pass. shifted, error and desktop capture errors fail.
      hover: { ...hoverSummary([...report, ...hoverDesktop].flatMap(r => (r.hover as HoverResult[] | undefined) ?? [])),
        desktopCaptures: hoverDesktop.length, desktopCaptureErrors: hoverDesktop.filter(r => r.error).length, shots: hoverShots.length },
      // Chat pictures in the served app: every check must hold.
      pictures: { runs: pictures.length, checks: pictures.reduce((n, r) => n + r.checks.length, 0),
        failedChecks: pictures.reduce((n, r) => n + r.checks.filter(c => !c.ok).length, 0), errors: pictures.filter(r => r.error).length } };
    writeFileSync(join(OUT, "mobile-audit-report.json"), JSON.stringify({ run: process.env.GITHUB_RUN_ID ?? "local", summary, seedNotes, items: report, hoverDesktop, pictures,
      ...(DIAGNOSTIC ? { diagnostic: { ...DIAGNOSTIC, freeze: freezeCounts, inviteeFreeze: inviteeFreezeCounts } } : {}) }, null, 2));
    console.log(JSON.stringify(summary));
    captureErrors = summary.errors;
    witnessFailures = summary.witnesses.witnessErrors + summary.witnesses.keyboard.error + summary.witnesses.activation.error;
    hoverFailures = summary.hover.shifted + summary.hover.error + summary.hover.desktopCaptureErrors;
    pictureFailures = summary.pictures.failedChecks + summary.pictures.errors + (summary.pictures.runs === 2 ? 0 : 1);
    await closeSite();
    functions.kill();
    await delay(1_000);
    if (functions.exitCode === null) functions.kill("SIGKILL");
    rmSync(envDir, { recursive: true, force: true });
  }
  // Fail after the report and screenshots are written (the upload step still runs), so a green
  // workflow can never hide a missing capture or a witness that could not measure. Pending entries
  // are not errors, and measured witness findings (blocked, obscured, mixed...) stay report-only.
  assert.equal(captureErrors, 0, `${captureErrors} capture(s) failed; see mobile-audit-report.json items[].error`);
  assert.equal(witnessFailures, 0, `${witnessFailures} witness measurement(s) failed; see items[].witness.error and items[].keyboard[] / items[].activation[] outcome "error"`);
  // The one witness whose finding fails the job (owner request): a hover or focus that moves or resizes anything.
  assert.equal(hoverFailures, 0, `${hoverFailures} hover witness(es) shifted layout or could not measure; see items[].hover[] and hoverDesktop[]`);
  assert.equal(pictureFailures, 0, `${pictureFailures} chat picture check(s) failed; see pictures[]`);
  // A frozen diagnostic pass that never intercepted and replayed a receipt call controlled nothing.
  if (DIAGNOSTIC) {
    const idle = freezeCounts.filter(c => c.intercepted === 0 || c.replayed === 0);
    assert.ok(freezeCounts.length > 0 && idle.length === 0,
      `the receipt freeze control was not exercised in ${idle.map(c => `${c.pass} ${c.viewport} ${c.theme}`).join(", ") || "any pass"}; see diagnostic.freeze`);
  }
}

// Registered as one gated browser case: nothing starts unless RUN_BROWSER_TESTS=1 (CI only).
// 75 minutes: twelve viewport batches with hover witnesses take about four minutes each, then the desktop hover
// pass and the picture check. The workflow job cap must stay above this.
test("mobile audit: seed, capture every manifest screen at six viewports in both themes", { timeout: 75 * 60_000 }, async () => {
  // The fixture matrix runs first; a witness that fails its own fixtures would make the long run meaningless.
  assert.ok(matrixResult.done && matrixResult.failed.length === 0,
    `the witness fixture matrix did not pass (${matrixResult.failed.join("; ") || "it did not finish"}); not starting the audit`);
  await main();
});
