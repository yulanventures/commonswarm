/**
 * Real Chromium lifecycle witness for revealable password fields on /app and /invite.
 *
 * Verifies against the built site (dist/) that every revealable password field:
 * - disables browser text assistance (spellcheck, autocorrect, autocapitalize, writingsuggestions)
 *   both in initial markup and while revealed (type="text"), without altering autocomplete,
 * - remasks synchronously on pagehide departure,
 * - stays masked on persisted pageshow (bfcache restore) even if tampered before restore,
 * - still succeeds on a fresh explicit reveal click as the positive control.
 *
 * CI only: browserTest skips unless RUN_BROWSER_TESTS=1, and CI builds the site before this suite.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "./chrome.js";
import { launchPlaywrightChromium } from "./chrome.js";
import type { Page } from "playwright-core";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

interface FieldSnapshot {
  type: string;
  value: string;
  autocomplete: string | null;
  spellcheckProp: boolean;
  spellcheckAttr: string | null;
  autocorrect: string | null;
  autocapitalize: string | null;
  writingsuggestions: string | null;
  ariaPressed: string | null;
  buttonText: string;
  ariaLabel: string | null;
}

async function readFieldSnapshot(page: Page, inputId: string): Promise<FieldSnapshot> {
  return await page.evaluate((id: string) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const button = document.querySelector<HTMLButtonElement>(`[data-password-toggle="${id}"]`);
    if (!input || !button) {
      throw new Error(`Missing password input or toggle for #${id}`);
    }
    return {
      type: input.type,
      value: input.value,
      autocomplete: input.getAttribute("autocomplete"),
      spellcheckProp: input.spellcheck,
      spellcheckAttr: input.getAttribute("spellcheck"),
      autocorrect: input.getAttribute("autocorrect"),
      autocapitalize: input.getAttribute("autocapitalize"),
      writingsuggestions: input.getAttribute("writingsuggestions"),
      ariaPressed: button.getAttribute("aria-pressed"),
      buttonText: (button.textContent ?? "").trim(),
      ariaLabel: button.getAttribute("aria-label"),
    };
  }, inputId);
}

function assertOptOutsAndAutocomplete(
  snapshot: FieldSnapshot,
  expectedAutocomplete: string,
  label: string,
): void {
  assert.equal(snapshot.autocomplete, expectedAutocomplete, `${label}: autocomplete`);
  assert.equal(snapshot.spellcheckProp, false, `${label}: input.spellcheck`);
  assert.equal(snapshot.spellcheckAttr, "false", `${label}: spellcheck attr`);
  assert.equal(snapshot.autocorrect, "off", `${label}: autocorrect attr`);
  assert.equal(snapshot.autocapitalize, "none", `${label}: autocapitalize attr`);
  assert.equal(snapshot.writingsuggestions, "false", `${label}: writingsuggestions attr`);
}

function assertMasked(snapshot: FieldSnapshot, expectedAutocomplete: string, label: string): void {
  assert.equal(snapshot.type, "password", `${label}: type`);
  assert.equal(snapshot.ariaPressed, "false", `${label}: aria-pressed`);
  assert.equal(snapshot.buttonText, "Show", `${label}: button text`);
  assert.equal(snapshot.ariaLabel, "Show password", `${label}: aria-label`);
  assertOptOutsAndAutocomplete(snapshot, expectedAutocomplete, label);
}

function assertRevealed(snapshot: FieldSnapshot, expectedAutocomplete: string, label: string): void {
  assert.equal(snapshot.type, "text", `${label}: type`);
  assert.equal(snapshot.ariaPressed, "true", `${label}: aria-pressed`);
  assert.equal(snapshot.buttonText, "Hide", `${label}: button text`);
  assert.equal(snapshot.ariaLabel, "Hide password", `${label}: aria-label`);
  assertOptOutsAndAutocomplete(snapshot, expectedAutocomplete, label);
}

async function verifyPasswordFieldLifecycle(
  page: Page,
  inputId: string,
  expectedAutocomplete: string,
): Promise<void> {
  const dummyPassword = "dummy-pass-123456";
  const toggleSelector = `[data-password-toggle="${inputId}"]`;

  // 1. Initial masked state with opt-outs and autocomplete preserved.
  const initial = await readFieldSnapshot(page, inputId);
  assertMasked(initial, expectedAutocomplete, `${inputId} initial`);

  // 2. Fill dummy password and tamper with assistance attrs before clicking Show.
  await page.fill(`#${inputId}`, dummyPassword);
  await page.evaluate((id: string) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) throw new Error(`Missing #${id}`);
    input.spellcheck = true;
    input.setAttribute("spellcheck", "true");
    input.setAttribute("autocorrect", "on");
    input.setAttribute("autocapitalize", "sentences");
    input.setAttribute("writingsuggestions", "true");
  }, inputId);

  await page.click(toggleSelector);
  const revealed = await readFieldSnapshot(page, inputId);
  assertRevealed(revealed, expectedAutocomplete, `${inputId} revealed`);
  assert.equal(revealed.value, dummyPassword, `${inputId} revealed value`);

  // 3. Synchronous pagehide departure remasks immediately in the same turn.
  const afterPageHide: FieldSnapshot = await page.evaluate((id: string) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const button = document.querySelector<HTMLButtonElement>(`[data-password-toggle="${id}"]`);
    if (!input || !button) throw new Error(`Missing #${id}`);
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    return {
      type: input.type,
      value: input.value,
      autocomplete: input.getAttribute("autocomplete"),
      spellcheckProp: input.spellcheck,
      spellcheckAttr: input.getAttribute("spellcheck"),
      autocorrect: input.getAttribute("autocorrect"),
      autocapitalize: input.getAttribute("autocapitalize"),
      writingsuggestions: input.getAttribute("writingsuggestions"),
      ariaPressed: button.getAttribute("aria-pressed"),
      buttonText: (button.textContent ?? "").trim(),
      ariaLabel: button.getAttribute("aria-label"),
    };
  }, inputId);
  assertMasked(afterPageHide, expectedAutocomplete, `${inputId} after pagehide`);
  assert.equal(afterPageHide.value, dummyPassword, `${inputId} pagehide preserves value`);

  // 4. Persisted pageshow (bfcache restore) keeps the field masked even if tampered beforehand.
  const afterPersistedPageShow: FieldSnapshot = await page.evaluate((id: string) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const button = document.querySelector<HTMLButtonElement>(`[data-password-toggle="${id}"]`);
    if (!input || !button) throw new Error(`Missing #${id}`);
    input.type = "text";
    button.setAttribute("aria-pressed", "true");
    button.textContent = "Hide";
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    return {
      type: input.type,
      value: input.value,
      autocomplete: input.getAttribute("autocomplete"),
      spellcheckProp: input.spellcheck,
      spellcheckAttr: input.getAttribute("spellcheck"),
      autocorrect: input.getAttribute("autocorrect"),
      autocapitalize: input.getAttribute("autocapitalize"),
      writingsuggestions: input.getAttribute("writingsuggestions"),
      ariaPressed: button.getAttribute("aria-pressed"),
      buttonText: (button.textContent ?? "").trim(),
      ariaLabel: button.getAttribute("aria-label"),
    };
  }, inputId);
  assertMasked(afterPersistedPageShow, expectedAutocomplete, `${inputId} after persisted pageshow`);
  assert.equal(afterPersistedPageShow.value, dummyPassword, `${inputId} pageshow preserves value`);

  // 5. Fresh explicit reveal control: clicking Show again reveals cleanly with opt-outs pinned.
  await page.click(toggleSelector);
  const reRevealed = await readFieldSnapshot(page, inputId);
  assertRevealed(reRevealed, expectedAutocomplete, `${inputId} fresh reveal control`);
  assert.equal(reRevealed.value, dummyPassword, `${inputId} fresh reveal value`);
}

test(
  "revealable password fields on /app and /invite pin text-assistance opt-outs and remask on pagehide and persisted pageshow",
  { timeout: 120_000 },
  async () => {
    const dist = fileURLToPath(new URL("../dist/", import.meta.url));
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url!, "http://127.0.0.1").pathname);
      const relative = normalize(path).replace(/^([/\\])+/u, "");
      const candidates = extname(relative) ? [relative] : [join(relative, "index.html")];
      void (async () => {
        for (const candidate of candidates) {
          const file = join(dist, candidate);
          if (!file.startsWith(dist)) break;
          try {
            const body = await readFile(file);
            response.writeHead(200, {
              "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
            });
            response.end(body);
            return;
          } catch {
            /* try next candidate */
          }
        }
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("not found");
      })();
    });

    const { chromium } = await import("playwright-core");
    const browser = await launchPlaywrightChromium(chromium);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
      try {
        // Check all three revealable password fields on /app.
        const appPage = await context.newPage();
        try {
          await appPage.goto(`${baseUrl}/app`, { waitUntil: "load" });
          await appPage.waitForFunction(() => {
            const root = document.querySelector<HTMLElement>("live-dashboard");
            const toggle = document.querySelector<HTMLButtonElement>(
              '[data-password-toggle="dashboard-password"]',
            );
            return Boolean(
              root &&
                root.dataset.state &&
                root.dataset.state !== "loading" &&
                toggle?.getAttribute("aria-pressed") === "false",
            );
          });

          // 1. #dashboard-password (sign-in panel)
          await appPage.evaluate(() => {
            const signedOut = document.querySelector<HTMLElement>(
              '.dashboard__root > [data-panel="signed-out"]',
            );
            const choices = document.querySelector<HTMLElement>('[data-auth-view="choices"]');
            if (signedOut) signedOut.hidden = false;
            if (choices) choices.hidden = false;
            for (const el of document.querySelectorAll<HTMLElement>("[data-signin-only]")) {
              el.hidden = false;
            }
            const input = document.getElementById("dashboard-password") as HTMLInputElement | null;
            const btn = document.querySelector<HTMLButtonElement>(
              '[data-password-toggle="dashboard-password"]',
            );
            if (input) input.disabled = false;
            if (btn) btn.disabled = false;
          });
          await verifyPasswordFieldLifecycle(appPage, "dashboard-password", "current-password");

          // 2. #dashboard-new-password (change-password dialog)
          await appPage.evaluate(() => {
            const dialog = document.querySelector<HTMLDialogElement>("[data-password-dialog]");
            if (dialog && !dialog.open) dialog.showModal();
          });
          await verifyPasswordFieldLifecycle(appPage, "dashboard-new-password", "new-password");
          await appPage.evaluate(() => {
            const dialog = document.querySelector<HTMLDialogElement>("[data-password-dialog]");
            if (dialog?.open) dialog.close();
          });

          // 3. #add-account-password (add-account dialog)
          await appPage.evaluate(() => {
            const dialog = document.querySelector<HTMLDialogElement>("[data-add-account-dialog]");
            const entry = document.querySelector<HTMLElement>("[data-add-account-entry]");
            if (entry) entry.hidden = false;
            if (dialog && !dialog.open) dialog.showModal();
          });
          await verifyPasswordFieldLifecycle(appPage, "add-account-password", "current-password");
          await appPage.evaluate(() => {
            const dialog = document.querySelector<HTMLDialogElement>("[data-add-account-dialog]");
            if (dialog?.open) dialog.close();
          });
        } finally {
          await appPage.close();
        }

        // Check #invite-password on /invite.
        const invitePage = await context.newPage();
        try {
          await invitePage.goto(`${baseUrl}/invite`, { waitUntil: "load" });
          await invitePage.waitForFunction(() => {
            const root = document.querySelector<HTMLElement>("invite-onramp");
            const toggle = document.querySelector<HTMLButtonElement>(
              '[data-password-toggle="invite-password"]',
            );
            return Boolean(
              root &&
                root.dataset.state &&
                root.dataset.state !== "loading" &&
                toggle?.getAttribute("aria-pressed") === "false",
            );
          });
          await invitePage.evaluate(() => {
            for (const view of document.querySelectorAll<HTMLElement>("invite-onramp [data-view]")) {
              view.hidden = view.dataset.view !== "auth";
            }
          });
          await verifyPasswordFieldLifecycle(invitePage, "invite-password", "current-password");
        } finally {
          await invitePage.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
