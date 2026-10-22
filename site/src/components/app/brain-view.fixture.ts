import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { HOSTILE_MARKDOWN_BLOCKS } from "../../lib/message-markdown-fixtures.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");

export const BRAIN_BODY_MARKDOWN = [
  "# Architecture",
  "## Working agreement",
  "### Read path",
  "#### Details",
  "- versioned\n- shared",
  "1. Read\n2. Write",
  "Use `cswarm brain get architecture` and [the guide](https://example.com/guide).",
  '```ts\nconst safe = "<tag>";\n```',
  "| left | right |\n| --- | --- |",
  "![diagram](https://example.com/diagram.png)",
  HOSTILE_MARKDOWN_BLOCKS,
].join("\n\n").replaceAll("\n", "\r\n") + "  ";

const BOUNDED_BRAIN_MARKDOWN =
  `${"> ".repeat(12)}bottom\n` + Array.from({ length: 9_999 }, () => "line").join("\n");

export interface BrainViewSnapshot {
  recovery: { cases: Record<string, unknown>[]; allPassed: boolean };
  paneClosedOnForeignFile: boolean;
  staleSaveRefused: boolean;
  boundedBlockquoteCount: number;
  boundedBreakCount: number;
  boundedHtmlLength: number;
  boundedShortened: boolean;
  dangerousElementCount: number;
  defaultRendered: boolean;
  historyCount: number;
  linkRel: string;
  linkTarget: string;
  listDetails: string[];
  listTopics: string[];
  panelLabel: string;
  rawModeShown: boolean;
  rawText: string;
  renderedHtml: string;
  saveCount: number;
  savedMarkdown: string;
  status: string;
  title: string;
  versionAfterSave: string;
}

/** Bundles the live brain controller and runs its list/read/edit flow in Chrome. */
export async function runBrainViewFixture(): Promise<BrainViewSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-brain-view-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    stdin: { resolveDir: siteRoot, loader: "ts", contents: `
      export { brainTopics, createBrainView } from './src/lib/brain-view.ts';
      export { SessionExpired, AuthRecoveryRequired, BrowserReadTimedOut, NoDeployment,
        CommandOutcomeUnknown, WorkspaceOutcomeUnknown } from './src/lib/commonswarm.ts';` },
    format: "iife",
    globalName: "BrainView",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "the live brain controller must bundle for its browser fixture");
  const files = [
    {
      fileId: "10000000-0000-4000-8000-000000000001",
      name: "brain--architecture.md",
      currentVersion: 2,
      sizeBytes: 64,
      uploadedByKind: "agent",
      uploadedBy: "20000000-0000-4000-8000-000000000001",
      committedAt: "2026-08-31T16:00:00.000Z",
      tombstonedAt: null,
    },
    {
      fileId: "10000000-0000-4000-8000-000000000002",
      name: "ordinary-plan.md",
      currentVersion: 4,
      sizeBytes: 128,
      uploadedByKind: "user",
      uploadedBy: "30000000-0000-4000-8000-000000000001",
      committedAt: "2026-08-31T15:00:00.000Z",
      tombstonedAt: null,
    },
  ];
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <ul data-brain-list hidden></ul>
    <p data-brain-empty></p>
    <article data-brain-detail hidden>
      <h2 data-brain-title tabindex="-1"></h2><p data-brain-meta></p>
      <p data-brain-error hidden></p>
      <button type="button" data-brain-retry hidden>Retry</button>
      <p data-brain-body-mode hidden>
        <span>Rendered from markdown</span> ·
        <button type="button" aria-pressed="false" data-brain-raw-toggle disabled>Raw</button>
      </p>
      <div data-brain-markdown></div>
      <pre data-brain-raw hidden></pre>
      <button type="button" data-brain-edit>Edit</button>
      <form data-brain-form hidden>
        <textarea data-brain-textarea></textarea>
        <button type="submit" data-brain-save>Save new version</button>
        <button type="button" data-brain-cancel>Cancel</button>
      </form>
      <p data-brain-status></p>
      <details data-brain-history><summary>Version history</summary><ul data-brain-history-list></ul></details>
    </article>
    <script>${script}</script>
    <script>
      window.alert = () => {};
      let failureContext = () => ({ stage: "setup" });
      (async () => {
        const one = (selector) => document.querySelector(selector);
        const targets = {
          list: one("[data-brain-list]"), empty: one("[data-brain-empty]"),
          detail: one("[data-brain-detail]"), title: one("[data-brain-title]"),
          meta: one("[data-brain-meta]"), bodyMode: one("[data-brain-body-mode]"),
          markdown: one("[data-brain-markdown]"), raw: one("[data-brain-raw]"),
          rawToggle: one("[data-brain-raw-toggle]"),
          error: one("[data-brain-error]"), retry: one("[data-brain-retry]"), edit: one("[data-brain-edit]"),
          form: one("[data-brain-form]"), textarea: one("[data-brain-textarea]"),
          save: one("[data-brain-save]"), cancel: one("[data-brain-cancel]"),
          status: one("[data-brain-status]"), history: one("[data-brain-history]"),
          historyList: one("[data-brain-history-list]"),
        };
        const contents = new Map([
          [1, ${JSON.stringify(BOUNDED_BRAIN_MARKDOWN)}],
          [2, ${JSON.stringify(BRAIN_BODY_MARKDOWN)}],
        ]);
        const saves = [];
        const reads = [];
        let readFailure = null, holdRead = false, pendingRead = null;
        let stage = "setup";
        const diagnostics = () => ({ stage, readyState: document.readyState,
          saveCount: saves.length, status: targets.status.textContent,
          error: targets.error.textContent, errorHidden: targets.error.hidden,
          saveDisabled: targets.save.disabled, saveLabel: targets.save.textContent,
          formHidden: targets.form.hidden, detailHidden: targets.detail.hidden,
          metadata: targets.meta.textContent, bodyModeHidden: targets.bodyMode.hidden,
          rawToggleDisabled: targets.rawToggle.disabled,
          retryHidden: targets.retry.hidden, retryDisabled: targets.retry.disabled,
          retryLabel: targets.retry.textContent, active: document.activeElement?.tagName,
          readCount: reads.length, lastRead: reads.at(-1),
          historyCount: targets.historyList.querySelectorAll("a").length });
        failureContext = diagnostics;
        const waitFor = async (name, predicate) => {
          stage = name;
          const deadline = performance.now() + 2000;
          while (!predicate()) {
            if (!targets.error.hidden || performance.now() >= deadline) {
              throw new Error("Brain readiness failed: " + JSON.stringify(diagnostics()));
            }
            // Poll pacing only; observed controller state, not elapsed time, permits success.
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        const topics = BrainView.brainTopics(${JSON.stringify(files)}, () => "Atlas");
        const view = BrainView.createBrainView(targets, {
          now: Date.parse("2026-08-31T18:00:00.000Z"),
          read: (topic, version) => {
            reads.push({ fileId: topic.fileId, version });
            if (readFailure) { const error = readFailure; readFailure = null; return Promise.reject(error); }
            if (holdRead) {
              let resolve, reject;
              const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
              pendingRead = { promise, resolve, reject }; return promise;
            }
            return Promise.resolve(contents.get(version) || "# older");
          },
          save: async (topic, markdown) => {
            saves.push(markdown);
            const saved = {
              ...topic,
              currentVersion: topic.currentVersion + 1,
              committedAt: "2026-08-31T18:00:00.000Z",
              updaterName: "Dana",
            };
            contents.set(saved.currentVersion, markdown);
            return saved;
          },
        });
        view.setTopics(topics);
        const initialTopics = Array.from(document.querySelectorAll("[data-brain-topic]"), (node) => node.querySelector("strong").textContent);
        const initialDetails = Array.from(document.querySelectorAll("[data-brain-topic]"), (node) => node.querySelector("span").textContent);
        await view.open("architecture");
        const rendered = one("[data-brain-markdown]");
        const raw = one("[data-brain-raw]");
        const rawToggle = one("[data-brain-raw-toggle]");
        const defaultRendered = !rendered.hidden && raw.hidden && rawToggle.getAttribute("aria-pressed") === "false";
        const renderedHtml = rendered.innerHTML;
        const dangerousElementCount = rendered.querySelectorAll("img, script, iframe, [onerror]").length;
        const safeLink = rendered.querySelector('a[href="https://example.com/guide"]');
        const linkRel = safeLink?.rel || "";
        const linkTarget = safeLink?.target || "";
        const panelLabel = one("[data-brain-body-mode]").textContent.replace(/\\s+/g, " ").trim();
        rawToggle.click();
        const rawText = raw.textContent;
        const rawModeShown = rendered.hidden && !raw.hidden && rawToggle.getAttribute("aria-pressed") === "true";
        rawToggle.click();
        one("[data-brain-edit]").click();
        one("[data-brain-textarea]").value = "**File layer**\\n\\nUse the existing file verbs.\\n\\n<img src=x>";
        one("[data-brain-form]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await waitFor("confirmed v3 save and reread", () => !targets.save.disabled && targets.form.hidden
          && targets.status.textContent === "Saved architecture as v3."
          && targets.meta.textContent.includes("3 versions") && targets.meta.textContent.includes("Dana")
          && !targets.bodyMode.hidden && !targets.rawToggle.disabled);
        const statusAfterSave = one("[data-brain-status]").textContent;
        const metaAfterSave = one("[data-brain-meta]").textContent;
        await view.open("architecture", 1);
        const boundedBlockquoteCount = one("[data-brain-markdown]").querySelectorAll("blockquote").length;
        const boundedBreakCount = one("[data-brain-markdown]").querySelectorAll("br").length;
        const boundedHtmlLength = one("[data-brain-markdown]").innerHTML.length;
        const boundedShortened = one("[data-brain-markdown]").textContent.includes("Message shortened for safe display.");
        /* Workspace-switch counterexample from the a0b6734 review: same slug,
           DIFFERENT fileId (workspace B). The pane must close, and a save with
           stale state must refuse. */
        const foreignTopics = topics.map((topic) => ({ ...topic, fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
        const savesBeforeSwitch = saves.length;
        one("[data-brain-edit]").click();
        one("[data-brain-textarea]").value = "workspace A secret";
        view.setTopics(foreignTopics);
        const paneClosedOnForeignFile = one("[data-brain-detail]").hidden && one("[data-brain-form]").hidden;
        one("[data-brain-form]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        stage = "immediate stale-file refusal";
        if (targets.error.hidden || targets.error.textContent !== "This topic changed underneath the editor. Reopen it, then save."
          || !targets.detail.hidden || !targets.form.hidden || saves.length !== savesBeforeSwitch) {
          throw new Error("Brain stale-file refusal failed: " + JSON.stringify(diagnostics()));
        }
        const staleSaveRefused = saves.length === savesBeforeSwitch;
        const snapshot = {
          recovery: { cases: [], allPassed: false },
          paneClosedOnForeignFile,
          staleSaveRefused,
          boundedBlockquoteCount,
          boundedBreakCount,
          boundedHtmlLength,
          boundedShortened,
          dangerousElementCount,
          defaultRendered,
          historyCount: document.querySelectorAll("[data-brain-history-list] a").length,
          linkRel,
          linkTarget,
          listDetails: initialDetails,
          listTopics: initialTopics,
          panelLabel,
          rawModeShown,
          rawText,
          renderedHtml,
          saveCount: saves.length,
          savedMarkdown: saves[0] || "",
          status: statusAfterSave,
          title: one("[data-brain-title]").textContent,
          versionAfterSave: metaAfterSave,
        };
        const recovery = snapshot.recovery;
        const expect = (name, condition, facts = {}) => {
          stage = name;
          recovery.cases.push({ name, pass: !!condition, ...facts });
          if (!condition) throw new Error("Brain recovery failed: " + JSON.stringify({ name, facts, ...diagnostics() }));
        };
        const unavailable = "This page could not be loaded. Try again.";
        stage = "read recovery";
        const failRead = async (error, version = 1) => { holdRead = false; view.setTopics(topics); readFailure = error; await view.open("architecture", version); };
        await failRead(new TypeError("Transport detail must never be displayed"));
        expect("plain transport failure", targets.error.textContent === unavailable && !targets.error.hidden && !targets.retry.hidden && !targets.retry.disabled && targets.meta.textContent.includes("viewing v1"));
        const count = reads.length;
        holdRead = true; targets.retry.focus(); targets.retry.click(); targets.retry.click();
        expect("pending Retry is one exact older-version read", !targets.retry.hidden && targets.retry.disabled && targets.retry.textContent === "Retrying…" &&
          reads.length === count + 1 && reads.at(-1).fileId === topics[0].fileId && reads.at(-1).version === 1);
        let pending = pendingRead;
        pending.reject(new TypeError("Another transport detail must never be displayed"));
        await pending.promise.catch(() => {}); // The actual controller subscribed first to this same read promise.
        expect("repeat failure restores Retry focus", targets.error.textContent === unavailable && !targets.retry.hidden && !targets.retry.disabled && document.activeElement === targets.retry);
        targets.retry.click(); pending = pendingRead; pending.resolve("# Recovered v1"); await pending.promise;
        expect("successful retry keeps v1 and returns title focus", targets.retry.hidden && !targets.bodyMode.hidden && targets.edit.hidden &&
          targets.markdown.textContent.includes("Recovered v1") && document.activeElement === targets.title && reads.at(-1).version === 1);
        const refused = [new BrainView.SessionExpired(), new BrainView.AuthRecoveryRequired(), new BrainView.BrowserReadTimedOut("Wiki page read"),
          new BrainView.NoDeployment(), new BrainView.CommandOutcomeUnknown("CommonSwarm accepted the download without returning a usable storage path."),
          new BrainView.WorkspaceOutcomeUnknown("CommonSwarm could not read this result. Reload to check."),
          new Error("File download was refused: workspace_access_refused."), new Error("Topic download failed (HTTP 403).")];
        for (const error of refused) {
          await failRead(error);
          expect("preserves " + error.name + " refusal", targets.error.textContent === error.message && !targets.retry.hidden && !targets.retry.disabled);
        }
        await failRead(new TypeError("Not public")); holdRead = true; targets.retry.focus(); targets.retry.click(); pending = pendingRead;
        const other = targets.history.querySelector("summary"); other.focus(); pending.resolve("# Recovered without stealing focus"); await pending.promise;
        expect("retry does not steal a moved focus", document.activeElement === other && targets.retry.hidden);
        await failRead(new TypeError("Not public")); holdRead = true; targets.retry.focus(); targets.retry.click(); pending = pendingRead;
        holdRead = false; await view.open("architecture", 2); const newerBody = targets.markdown.textContent;
        pending.resolve("# Stale v1 must not replace v2"); await pending.promise;
        expect("new version retires old retry response", targets.retry.hidden && targets.markdown.textContent === newerBody && reads.at(-1).version === 2);
        await failRead(new TypeError("Not public")); holdRead = true; targets.retry.focus(); targets.retry.click(); pending = pendingRead;
        view.setTopics(topics);
        pending.resolve("# Retired generation must not paint"); await pending.promise;
        expect("same-file refresh retains safe exact-version recovery", !targets.retry.hidden && !targets.retry.disabled && targets.error.textContent === unavailable && targets.bodyMode.hidden);
        holdRead = false; targets.retry.click();
        await waitFor("same-file exact-version retry completed", () => targets.retry.hidden && !targets.bodyMode.hidden);
        expect("refresh retry retains requested version", reads.at(-1).version === 1 && targets.edit.hidden);
        await failRead(new TypeError("Not public")); holdRead = true; targets.retry.focus(); targets.retry.click(); pending = pendingRead;
        view.setTopics(foreignTopics); const foreignCount = reads.length;
        targets.retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        pending.resolve("# Foreign workspace stale read"); await pending.promise;
        expect("foreign-file stale Retry and response are inert", reads.length === foreignCount && targets.retry.hidden && targets.detail.hidden && targets.bodyMode.hidden);
        await failRead(new TypeError("Not public"), 2); view.setTopics(topics.map(topic => ({ ...topic, currentVersion: 1 })));
        const retiredCount = reads.length; targets.retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect("unavailable selected version cannot retry latest", targets.retry.hidden && reads.length === retiredCount);
        expect("read recovery never saves", saves.length === savesBeforeSwitch);
        recovery.allPassed = true;
        document.documentElement.dataset.fixture = encodeURIComponent(JSON.stringify(snapshot));
      })().catch((error) => {
        document.documentElement.dataset.fixtureError = encodeURIComponent(JSON.stringify({
          error: String(error), ...failureContext(),
        }));
      });
    </script>
  </body>
</html>`;

  try {
    await writeFile(fixture, html, "utf8");
    const chrome = await findChrome();
    const { stdout } = await launchChrome(chrome, [
      "--single-process",
      "--no-zygote",
      "--allow-file-access-from-files",
      /* The snapshot is published after the save and workspace-switch promises settle.
         `--dump-dom` otherwise races that asynchronous work under Chrome's CI process model. */
      "--virtual-time-budget=5000",
      "--dump-dom",
      `file://${fixture}`,
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const failure = stdout.match(/data-fixture-error="([^"]+)"/)?.[1];
    assert.equal(failure, undefined, failure ? decodeURIComponent(failure) : "brain fixture failed");
    const encoded = stdout.match(/data-fixture="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the live brain-view snapshot");
    return JSON.parse(decodeURIComponent(encoded)) as BrainViewSnapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
