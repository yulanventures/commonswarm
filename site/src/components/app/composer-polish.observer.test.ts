/** Kylon composer focus, contained controls and short-reply usability.
 * Uses the existing built-app server and bundled-browser CI guard. No new app seam.
 * General autosize/failure/draft persistence belongs to composer-sprint-browser;
 * transcript end-gap and its 12px contract belong to feed-composer-clearance.
 */
import assert from "node:assert/strict";
import { browserTest as test, findChrome, launchChrome } from "../../../tests/chrome.js";
import { startComposerPolishServer } from "./composer-polish.fixture.js";

type FocusProbe = { visible: boolean; quiet: boolean; active: boolean; contrast: number; blurred: string; focused: string };
type SendProbe = { contained: boolean; target: boolean; uncovered: boolean; inViewport: boolean; focusClear: boolean | null; textClear: boolean; width: number; height: number };
type ReplyProbe = { active: boolean; audience: boolean; cancel: boolean; history: boolean; draft: boolean; internalScroll: boolean; historyHeight: number; inputHeight: number };
type DisclosureProbe = { authorAccessible: boolean; named: boolean; opened: boolean; detailReadable: boolean; replyStable: boolean; closed: boolean };
type Sample = { focus: FocusProbe; send: SendProbe };
type Negative<T> = { before: T; during: T; restored: T; resolvedTargets: number };
type Measurement = {
  runs: number;
  viewport: { width: number; height: number; theme: string };
  ordinary: Sample[];
  focusMissing: Negative<FocusProbe>;
  focusHalo: Negative<FocusProbe>;
  sendOutside: Negative<SendProbe>;
  sendSmall: Negative<SendProbe>;
  textUnderControls: Negative<SendProbe>;
  shortReply: { short: ReplyProbe; long: ReplyProbe; overlap: Negative<ReplyProbe>; cancelled: boolean; draftSurvivedCancel: boolean } | null;
  disclosure: DisclosureProbe;
  success: { statusText: string; statusVisible: boolean; feedbackHidden: boolean };
};

const measurementPage = (url: URL): string | null => {
  if (url.pathname !== "/__measure") return null;
  const width = Number(url.searchParams.get("width"));
  const height = Number(url.searchParams.get("height"));
  const theme = url.searchParams.get("theme");
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || !["light", "dark"].includes(theme ?? "")) {
    return "<!doctype html><title>Invalid measurement</title>";
  }
  return `<!doctype html><html><body style="margin:0"><iframe title="Composer measurement viewport" src="/app" style="border:0;width:${width}px;height:${height}px"></iframe><script>
    const theme = ${JSON.stringify(theme)};
    ${String.raw`
    const frame = document.querySelector("iframe");
    let measurementRuns = 0;
    const runMeasurement = async () => {
      measurementRuns += 1;
      const doc = frame.contentDocument, view = frame.contentWindow;
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          if (predicate()) return;
          await new Promise(resolve => view.setTimeout(resolve, 25));
        }
        throw new Error("Timed out waiting for " + label);
      };
      const settle = () => new Promise(resolve => view.setTimeout(resolve, 40));
      await waitFor(() => !doc.querySelector("[data-composer]")?.hidden && doc.querySelectorAll("[data-feed-list] > li").length > 0, "sample composer");
      doc.documentElement.dataset.theme = theme;
      await doc.fonts.ready;
      const form = doc.querySelector("[data-composer]"), shell = doc.querySelector(".dashboard__composer-input");
      const input = doc.querySelector("[data-composer-input]"), send = doc.querySelector("[data-composer-send]");
      const status = doc.querySelector("[data-composer-status]"), feedback = doc.querySelector("[data-composer-feedback]");
      const channelHeading = doc.querySelector("[data-channel-name]");
      // The channel heading may legitimately be hidden by phone chrome. A
      // fixture-only body focus sink still exercises actual field blur.
      const focusSink = channelHeading?.getClientRects().length && view.getComputedStyle(channelHeading).visibility === "visible" ? channelHeading : doc.body;
      const scroller = doc.querySelector(".dashboard__feed-view");
      if (!form || !shell || !input || !send || !status || !feedback || !focusSink || !scroller) throw new Error("Composer fixture incomplete");
      // The initial desktop autofocus is queued. Require three stable turns,
      // retaining the original race defense rather than measuring one blur.
      const settleFocus = async (target, predicate, label) => {
        let stableTurns = 0;
        for (let attempt = 0; attempt < 160; attempt += 1) {
          target.focus({ preventScroll: true });
          await new Promise(resolve => view.setTimeout(resolve, 25));
          stableTurns = predicate() ? stableTurns + 1 : 0;
          if (stableTurns >= 3) return;
        }
        throw new Error("Timed out waiting for stable " + label);
      };
      const killTransitions = doc.createElement("style");
      killTransitions.textContent = "* { transition:none !important; animation:none !important; }";
      doc.head.append(killTransitions);
      focusSink.setAttribute("tabindex", "-1");
      const setInput = async value => {
        input.value = value;
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(new view.InputEvent("input", { bubbles:true, inputType:"insertText" }));
        await settle();
      };
      const rect = element => element.getBoundingClientRect();
      const visible = element => {
        if (!element || element.hidden || element.closest("[hidden]")) return false;
        const b = rect(element), s = view.getComputedStyle(element);
        return b.width > 0 && b.height > 0 && s.visibility === "visible" && s.display !== "none" && s.clipPath === "none";
      };
      const inViewport = element => {
        const b = rect(element);
        return visible(element) && b.top >= -.5 && b.left >= -.5 && b.right <= view.innerWidth + .5 && b.bottom <= view.innerHeight + .5;
      };
      const uncovered = element => {
        if (!inViewport(element)) return false;
        const b = rect(element), hit = doc.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return hit === element || element.contains(hit);
      };
      const shadows = value => value === "none" ? [] : value.split(/,(?![^(]*\))/).map(part => {
        const color = part.match(/rgba?\([^)]*\)/)?.[0] ?? "transparent";
        const lengths = (part.replace(/rgba?\([^)]*\)/g, "").match(/-?\d+(?:\.\d+)?px/g) ?? []).map(Number.parseFloat);
        return { inset:part.includes("inset"), color, blur:lengths[2] ?? 0, spread:lengths[3] ?? 0 };
      });
      const luminance = color => {
        const parts = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        if (parts.length !== 3) return null;
        const linear = parts.map(n => { const s = n / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
        return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
      };
      const contrast = (a, b) => {
        const x = luminance(a), y = luminance(b);
        return x === null || y === null ? 0 : (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
      };
      const readFocus = async () => {
        await settleFocus(focusSink, () => doc.activeElement === focusSink && !shell.matches(":focus-within"), "blurred composer");
        const blurred = view.getComputedStyle(shell, "::before").boxShadow;
        await settleFocus(input, () => doc.activeElement === input && shell.matches(":focus-within"), "focused composer");
        const fieldStyle = view.getComputedStyle(shell, "::before"), fieldShadows = shadows(fieldStyle.boxShadow);
        const own = [view.getComputedStyle(input), view.getComputedStyle(shell)];
        const inset = fieldShadows.filter(s => s.inset && s.spread >= 1.5 && s.spread <= 3 && s.blur === 0);
        const ratio = inset.length === 1 ? contrast(inset[0].color, fieldStyle.backgroundColor) : 0;
        const noOutline = style => style.outlineStyle === "none" || Number.parseFloat(style.outlineWidth) === 0;
        return {
          visible:fieldStyle.content !== "none" && inset.length === 1 && ratio >= 3 && fieldStyle.boxShadow !== blurred,
          quiet:own.every(s => noOutline(s) && shadows(s.boxShadow).every(p => p.inset)) && fieldShadows.every(s => s.inset) && noOutline(fieldStyle),
          active:doc.activeElement === input && input.matches(":focus-visible"), contrast:ratio, blurred, focused:fieldStyle.boxShadow,
        };
      };
      const fieldRect = () => {
        const b = rect(shell), s = view.getComputedStyle(shell), p = view.getComputedStyle(shell, "::before");
        const number = value => Number.parseFloat(value) || 0;
        if (p.content === "none" || p.position !== "absolute") throw new Error("No painted composer field to measure");
        return { left:b.left + number(s.borderLeftWidth) + number(p.left), right:b.right - number(s.borderRightWidth) - number(p.right), top:b.top + number(s.borderTopWidth) + number(p.top), bottom:b.bottom - number(s.borderBottomWidth) - number(p.bottom) };
      };
      const readSend = async () => {
        let focusClear = null;
        if (!send.disabled) {
          await settleFocus(send, () => doc.activeElement === send && send.matches(":focus-visible"), "focused Send");
          const b = rect(send), style = view.getComputedStyle(send);
          const extent = Number.parseFloat(style.outlineWidth) + Math.max(0, Number.parseFloat(style.outlineOffset));
          let clipped = false;
          for (let parent = send.parentElement; parent; parent = parent.parentElement) {
            const ps = view.getComputedStyle(parent), r = rect(parent);
            if (/hidden|clip|auto|scroll/.test(ps.overflowX) && (b.left - extent < r.left - .5 || b.right + extent > r.right + .5)) clipped = true;
            if (/hidden|clip|auto|scroll/.test(ps.overflowY) && (b.top - extent < r.top - .5 || b.bottom + extent > r.bottom + .5)) clipped = true;
          }
          focusClear = style.outlineStyle !== "none" && extent > 0 && !clipped;
        }
        const b = rect(send), f = fieldRect(), text = rect(input), textStyle = view.getComputedStyle(input);
        const attach = doc.querySelector("[data-composer-attach]");
        const controlsLeft = Math.min(b.left, visible(attach) ? rect(attach).left : b.left);
        const textRight = text.right - Number.parseFloat(textStyle.paddingRight) - Number.parseFloat(textStyle.borderRightWidth);
        return { contained:b.left >= f.left - .5 && b.right <= f.right + .5 && b.top >= f.top - .5 && b.bottom <= f.bottom + .5,
          target:b.width >= 43.9 && b.height >= 43.9, uncovered:uncovered(send), inViewport:inViewport(send), focusClear, textClear:textRight <= controlsLeft + .5, width:b.width, height:b.height };
      };
      // Isolated same-DOM controls. A missing selector or boot failure is an
      // error, never the negative result. Restore and remeasure each positive.
      const mutate = async (selector, css, measure) => {
        const resolvedTargets = doc.querySelectorAll(selector).length;
        if (resolvedTargets !== 1) throw new Error("Mutation target not unique: " + selector);
        const before = await measure(), style = doc.createElement("style");
        style.textContent = css; doc.head.append(style);
        let during;
        try { await settle(); during = await measure(); } finally { style.remove(); }
        await settle();
        return { before, during, restored:await measure(), resolvedTargets };
      };
      const ordinary = [];
      for (const draft of ["", "First line\nSecond line"]) {
        await setInput(draft);
        ordinary.push({ focus:await readFocus(), send:await readSend() });
      }
      const scope = "live-dashboard.dashboard[data-kylon-shell] .hm-frame ";
      const focusMissing = await mutate(".dashboard__composer-input", scope + ".dashboard__composer-input:focus-within::before{box-shadow:none!important;border-color:transparent!important;outline:none!important}", readFocus);
      const focusHalo = await mutate("[data-composer-input]", scope + "[data-composer-input]:focus{outline:8px solid magenta!important;box-shadow:0 0 0 12px magenta!important}", readFocus);
      const sendOutside = await mutate("[data-composer-send]", scope + "[data-composer-send]{transform:translateX(80px)!important}", readSend);
      const sendSmall = await mutate("[data-composer-send]", scope + "[data-composer-send]{inline-size:20px!important;block-size:20px!important;min-inline-size:0!important;min-block-size:0!important}", readSend);

      const textUnderControls = await mutate("[data-composer-input]", scope + "[data-composer-input]{padding-inline-end:0!important}", readSend);

      // The semantic owner already tests author labels and receipt truth. Here
      // test only their distinct rendered access/native disclosure stability.
      const row = Array.from(doc.querySelectorAll("[data-feed-list] > li")).find(el => el.querySelector(".dashboard__message-receipt > summary") && el.querySelector("[data-message-reply]"));
      if (!row) throw new Error("Sample has no real receipt plus Reply row; cannot claim disclosure coverage");
      const summary = row.querySelector(".dashboard__message-receipt > summary"), details = summary.parentElement;
      const reply = row.querySelector("[data-message-reply]");
      const author = row.querySelector(".hm-author__name button,.hm-author__name a,.dashboard__message-author");
      if (!author) throw new Error("Real row has no author/profile control");
      author.scrollIntoView({ block:"center" }); author.focus({ preventScroll:true }); await settle();
      const authorAccessible = visible(author) && uncovered(author) && doc.activeElement === author && !!(author.getAttribute("aria-label") || author.textContent).trim();
      summary.scrollIntoView({ block:"center" }); summary.focus({ preventScroll:true }); await settle();
      const label = summary.getAttribute("aria-label") || "";
      const named = label.trim().length > 0 && visible(summary) && uncovered(summary);
      const before = { top:rect(reply).top - rect(summary).top, left:rect(reply).left - rect(summary).left };
      summary.click(); await settle();
      const opened = details.open;
      const content = Array.from(details.children).filter(el => el !== summary);
      const detailReadable = content.some(el => visible(el) && el.textContent.trim().length > 0);
      const after = { top:rect(reply).top - rect(summary).top, left:rect(reply).left - rect(summary).left };
      const replyStable = visible(reply) && Math.abs(after.top - before.top) <= 1 && Math.abs(after.left - before.left) <= 1;
      summary.click(); await settle(); summary.focus({ preventScroll:true });
      const disclosure = { authorAccessible, named, opened, detailReadable, replyStable, closed:!details.open && doc.activeElement === summary && summary.getAttribute("aria-label") === label };

      let shortReply = null;
      if (view.innerHeight <= 568) {
        // Enter through the actual existing Reply action. No hidden-state DOM
        // insertion, global dashboard function export, or backend mock.
        reply.scrollIntoView({ block:"center" }); reply.click();
        await waitFor(() => !doc.querySelector("[data-composer-reply]")?.hidden && !doc.querySelector("[data-composer-to]")?.hidden, "real reply and audience");
        const cancel = doc.querySelector("[data-composer-reply-cancel]"), audience = doc.querySelector("[data-composer-to]");
        const note = doc.querySelector("[data-composer-to-note]"), target = doc.querySelector("[data-composer-reply-target-text]");
        if (!cancel || !audience || !note || !target) throw new Error("Real reply furniture incomplete");
        const readReply = () => {
          const style = view.getComputedStyle(input), historyHeight = Math.max(0, Math.min(rect(scroller).bottom, rect(form).top) - Math.max(0, rect(scroller).top));
          return { active:!doc.querySelector("[data-composer-reply]").hidden && inViewport(target) && !!target.textContent.trim(),
            audience:inViewport(audience) && inViewport(note) && !!note.textContent.trim(), cancel:uncovered(cancel) && rect(cancel).width >= 43.9 && rect(cancel).height >= 43.9,
            history:historyHeight >= 2 * Number.parseFloat(style.lineHeight) && scroller.clientHeight > 0,
            draft:inViewport(input) && input.value === expectedDraft, internalScroll:style.overflowY === "auto" && input.scrollHeight > input.clientHeight + 20 && input.scrollTop > 0,
            historyHeight, inputHeight:rect(input).height };
        };
        let expectedDraft = "A short local reply"; await setInput(expectedDraft);
        const short = readReply();
        expectedDraft = Array.from({ length:40 }, (_, i) => "Local long reply line " + i).join("\n"); await setInput(expectedDraft);
        input.scrollTop = input.scrollHeight; await settle(); const long = readReply();
        const overlap = await mutate("[data-composer-input]", scope + "[data-composer-input]{max-block-size:none!important;block-size:80dvh!important}", readReply);
        cancel.click(); await waitFor(() => doc.querySelector("[data-composer-reply]").hidden, "reply cancelled");
        shortReply = { short, long, overlap, cancelled:doc.activeElement === input, draftSurvivedCancel:input.value === expectedDraft };
      }
      // Preserve the existing no-stale-success-feedback assertion. This is
      // sample-mode posting, never proof of a server delivery receipt.
      await setInput("Successful sample post"); form.requestSubmit(); await settle();
      await waitFor(() => !send.hasAttribute("aria-busy"), "successful sample post"); await settle();
      const success = { feedbackHidden:feedback.hidden, statusText:status.textContent || "", statusVisible:!feedback.hidden && view.getComputedStyle(status).display !== "none" };
      killTransitions.remove();
      document.documentElement.dataset.composerPolishMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({ ordinary, focusMissing, focusHalo, sendOutside, sendSmall, textUnderControls, shortReply, disclosure, success, runs:measurementRuns, viewport:{width:view.innerWidth,height:view.innerHeight,theme} }))));
    };
    let started = false;
    const start = () => { if (started) return; started = true; void runMeasurement().catch(error => {
      document.documentElement.dataset.composerPolishError = btoa(unescape(encodeURIComponent(String(error?.stack || error))));
    }); };
    // Retain the intentional duplicate trigger: the race guard must allow one writer.
    const triggerStart = () => { start(); start(); };
    frame.addEventListener("load", triggerStart, { once:true });
    if (frame.contentDocument?.readyState === "complete" && frame.contentWindow?.location.pathname === "/app") triggerStart();
    `}
  </script></body></html>`;
};

const measure = async (chrome: string, origin: string, width: number, height: number, theme: string): Promise<Measurement> => {
  const { stdout, stderr } = await launchChrome(chrome, [
    "--single-process", "--no-zygote", "--run-all-compositor-stages-before-draw", "--window-size=1600,1200",
    "--virtual-time-budget=20000", "--dump-dom", `${origin}/__measure?width=${width}&height=${height}&theme=${theme}`,
  ], { maxBuffer:12 * 1024 * 1024, timeout:35_000, killSignal:"SIGKILL" });
  const encoded = stdout.match(/data-composer-polish-measurement="([^"]+)"/)?.[1];
  const error = stdout.match(/data-composer-polish-error="([^"]+)"/)?.[1];
  assert.ok(encoded, `${width}x${height}/${theme}: no measurement; error:${error ? Buffer.from(error, "base64").toString("utf8") : "none"}; stderr:${stderr.slice(-1000)}; DOM:${stdout.slice(-2000)}`);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Measurement;
};
const assertFocus = (p: FocusProbe): void => {
  assert.equal(p.active, true, "focus-active: textarea was not actually focus-visible");
  assert.equal(p.visible, true, `focus-missing: no changed meaningful field indicator: ${JSON.stringify(p)}`);
  assert.equal(p.quiet, true, `focus-halo: stacked outer focus indicators: ${JSON.stringify(p)}`);
};
const assertSend = (p: SendProbe): void => {
  assert.equal(p.target, true, `send-target: real Send is below44px: ${JSON.stringify(p)}`);
  assert.equal(p.contained, true, `send-contained: real Send left painted field: ${JSON.stringify(p)}`);
  assert.equal(p.textClear, true, `text-reservation: editable line extends under Attach/Send: ${JSON.stringify(p)}`);
  if (p.focusClear !== null) assert.equal(p.focusClear, true, `send-focus: enabled Send focus was clipped or absent: ${JSON.stringify(p)}`);
  assert.equal(p.inViewport && p.uncovered, true, `send-access: Send left viewport or is obstructed: ${JSON.stringify(p)}`);
};
const assertReply = (p: ReplyProbe, long = false): void => {
  assert.equal(p.active && p.audience && p.cancel && p.history && p.draft, true, `short-reply: audience/Cancel/history/draft unusable: ${JSON.stringify(p)}`);
  if (long) assert.equal(p.internalScroll, true, `reply-scroll: long draft not internally reachable: ${JSON.stringify(p)}`);
};
const assertNegative = <T>(p: Negative<T>, check: (value: T) => void, expected: RegExp): void => {
  assert.equal(p.resolvedTargets, 1, "negative control did not reach one real target");
  check(p.before);
  assert.throws(() => check(p.during), expected, "negative control failed to expose the intended defect");
  check(p.restored);
};

test("Kylon composer keeps quiet focus, contained Send and usable short replies in the built app", { timeout:180_000 }, async () => {
  const chrome = await findChrome(), server = await startComposerPolishServer(measurementPage);
  try {
    // Four processes, at most140s launcher budget, within the180s CI test budget.
    // Phone mechanics/keyboard variants are already owned by sprint-browser.
    for (const [width, height, theme] of [[1440, 900, "light"], [390, 844, "dark"], [320, 568, "light"], [735, 424, "dark"]] as const) {
      const m = await measure(chrome, server.origin, width, height, theme);
      assert.equal(m.runs, 1, "measurement race: more than one writer used the frame");
      assert.deepEqual(m.viewport, { width, height, theme });
      assert.equal(m.ordinary.length, 2, "empty/two-line states were not reconciled");
      for (const state of m.ordinary) { assertFocus(state.focus); assertSend(state.send); }
      assert.equal(m.ordinary[1].send.focusClear, true, "enabled Send focus was not measured");
      assertNegative(m.focusMissing, assertFocus, /focus-missing/);
      assertNegative(m.focusHalo, assertFocus, /focus-halo/);
      assertNegative(m.sendOutside, assertSend, /send-contained/);
      assertNegative(m.sendSmall, assertSend, /send-target/);
      assertNegative(m.textUnderControls, assertSend, /text-reservation/);
      for (const [name, passed] of Object.entries(m.disclosure)) assert.equal(passed, true, `rendered-disclosure:${name}: ${JSON.stringify(m.disclosure)}`);
      if (height <= 568) {
        assert.ok(m.shortReply, "short reply case missing");
        assertReply(m.shortReply.short); assertReply(m.shortReply.long, true);
        assertNegative(m.shortReply.overlap, value => assertReply(value, true), /short-reply/);
        assert.equal(m.shortReply.cancelled, true, "Cancel did not return focus to input");
        assert.equal(m.shortReply.draftSurvivedCancel, true, "Cancel lost the unsent draft");
      }
      assert.equal(m.success.statusText.trim(), "", "successful send left stale status text");
      assert.equal(m.success.statusVisible, false, "successful send left status visible");
      assert.equal(m.success.feedbackHidden, true, "successful send left feedback open");
      console.log(`composer-kylon-polish ${JSON.stringify(m)}`);
    }
  } finally { await server.close(); }
});
