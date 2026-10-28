/** Reached by `npm --prefix site test` through the recursive component-observer glob. */
import assert from "node:assert/strict";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

import { revertedStyles, startDistServer } from "./mobile-feed-layout.fixture.js";

type Rect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type LayoutMeasurement = {
  /** Everything above the reading area: the workspace header (or phone bar) plus any stream rows still shown. */
  combinedHeaderHeight: number;
  /** Where the reading area starts: the transcript's top, or below the stream head and filter row while they show. */
  transcriptTop: number;
  /** Ruling 2: the stream head and filter row are hidden in the signed-in default; the ⋯ menu carries their controls. */
  headVisible: boolean;
  toolbarVisible: boolean;
  feedMenu: boolean;
  feedControls: string[];
  navigationOpen: boolean;
  navigationTargets: Rect[];
  workspaceHeader: Rect;
  sendUncovered: boolean;
  phoneNav: Rect | null;
  navItems: string[];
  peopleDoor: boolean;
  composer: Rect;
  header: Rect;
  input: Rect;
  send: Rect;
  toolbar: Rect;
  menu: {
    bottom: number;
    items: Array<{ bottom: number; label: string; top: number }>;
    top: number;
  };
  transcriptToHeaderRatio: number;
  transcriptVisibleHeight: number;
  feedListPaddingBlockStart: string;
  feedMore: Rect | null;
  feedMoreToFirstRowGap: number | null;
  feedViewScrollTop: number;
  firstRow: Rect | null;
  viewport: { height: number; width: number };
  shell: {
    app: Rect;
    channel: Rect;
    channelBody: Rect;
    frame: Rect;
    product: Rect;
    root: Rect;
  };
};

const frameScript = (
  reverted: boolean,
  empty: boolean,
  pending: boolean,
  more: boolean,
  todos: boolean,
  shellScript: string,
): string => `<script>
  const frame = document.querySelector("iframe");
  const reportError = (value) => {
    document.documentElement.dataset.layoutError = btoa(String(value));
  };
  const runMeasurement = async () => {
    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    const settle = () => new Promise((resolve) => view.setTimeout(resolve, 80));
    ${reverted ? `doc.head.insertAdjacentHTML("beforeend", ${JSON.stringify(revertedStyles)});` : ""}
    const app = doc.querySelector("live-dashboard");
    app.dataset.state = "channel";
    doc.querySelectorAll(".dashboard__root > [data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== "channel";
    });
    // Actual built markup/CSS, with boot omitted: invented data never authenticates or changes Sample.
    doc.querySelector("[data-sample-notice]").hidden = true;
    doc.querySelector('[data-sample-chip]')?.setAttribute('hidden', '');
    const source = doc.createElement('script'); source.textContent = ${JSON.stringify(shellScript)}; doc.head.append(source);
    const H = view.MobileShell;
    const workspace = { id: 'fixture-w', name: 'Invented workspace', todosAvailable: ${JSON.stringify(todos)} };
    const host = H.createKylonHost(app, () => {});
    const vm = { sample: false, workspaceId: workspace.id, name: workspace.name, people: [], pane: 'chat', todosAvailable: workspace.todosAvailable,
      hrefs: { chat:'/app?w=fixture-w', todos:'/app?w=fixture-w&v=todos', lists:'/app?w=fixture-w&v=lists', files:'/app?w=fixture-w&v=files', wiki:'/app?w=fixture-w&v=wiki', workspaces:'/app?v=catchup' },
      menu: { settings:true, adminAccess:true } };
    const callbacks = { openPeople: () => {}, menu: () => {},
      feedMenu: () => ({ channels: [{ id: '', label: 'All messages', current: true }], mayCreateChannel: true,
        filters: [{ value: 'all', label: 'All', current: true }, { value: 'broadcast', label: 'Broadcast', current: false }],
        refresh: { label: 'Refresh observer data' } }), feed: () => {} };
    host.replaceHeader(() => H.replaceHomeRegion(doc.querySelector('[data-home-workspace-shell]'), 'shell', [
      H.buildPhoneTopBar(doc,vm,callbacks), H.buildWorkspaceHeader(doc,vm,callbacks), H.buildWorkspaceNav(doc,vm,callbacks,'tablet')]));
    H.replaceHomeRegion(doc.querySelector('[data-home-phone-nav]'), 'phone-nav', [H.buildWorkspaceNav(doc,vm,callbacks,'phone')]);
    host.sync(H.projectHomeLayout('channel', { view: 'chat', workspaceId: workspace.id }, [workspace], false));
    // Account layout only: callbacks stand in for runtime wiring, never sign-in/sign-out behavior.
    const accountMenu = doc.querySelector('[data-user-menu]');
    doc.querySelector('[data-user-menu-trigger]').addEventListener('click', () => { accountMenu.hidden = !accountMenu.hidden; });
    doc.querySelectorAll('[data-rail-account]').forEach(node => { node.textContent = 'Invented account'; });
    doc.querySelector('.hm-frame').classList.remove('hm-frame--catchup');
    doc.querySelector('.dashboard__channel').hidden = false;
    doc.querySelector('[data-home-catchup]').hidden = true;
    doc.querySelector('[data-home-route-pane]').hidden = true;
    doc.querySelectorAll("[data-channel-view]").forEach((section) => {
      section.hidden = section.dataset.channelView !== ${JSON.stringify(empty ? "feed-empty" : "feed")};
    });
    /* Invented signed-in account state for geometry only; no authentication is exercised. */
    doc.querySelectorAll("[data-signout]").forEach((button) => { button.hidden = false; });
    const people = doc.querySelector('[data-roster-open]');
    people.setAttribute('aria-label', ${JSON.stringify(pending ? "People & agents · 3 pending access" : "People & agents")});
    const live = doc.querySelector("[data-live-chip]");
    live.hidden = false;
    const updates = doc.querySelector("[data-update-count]");
    updates.hidden = false;
    updates.textContent = "25+ updates";
    doc.querySelector("[data-refresh]").hidden = false;
    /* The load-older control must sit close to the list, without a second header-sized gap. */
    doc.querySelector("[data-feed-more]").hidden = ${JSON.stringify(!more)};
    const composer = doc.querySelector("[data-composer]");
    composer.hidden = false;
    const list = doc.querySelector("[data-feed-list]");
    list.replaceChildren(...Array.from({ length: ${empty ? 0 : 40} }, (_, index) => {
      const row = doc.createElement("li");
      row.className = "dashboard__message";
      const avatar = doc.createElement("span");
      avatar.className = "dashboard__message-avatar";
      avatar.textContent = "AG";
      const body = doc.createElement("article");
      body.className = "dashboard__message-body";
      const meta = doc.createElement("header");
      meta.className = "dashboard__message-meta";
      const author = doc.createElement("strong");
      author.textContent = "Agent " + (index + 1);
      const message = doc.createElement("div");
      message.className = "dashboard__message-markdown";
      message.textContent = "Rendered transcript row " + (index + 1) +
        " with enough copy to exercise live feed geometry.";
      meta.append(author);
      body.append(meta, message);
      row.append(avatar, body);
      return row;
    }));
    /* Same signed-in default input as LiveDashboard.syncFeedChrome. The taller negative
       control retains visible feed controls but restores the old head/filter rows. */
    ${reverted ? "" : `doc.querySelector(".hm-frame").setAttribute("data-feed-quiet", "");`}
    await doc.fonts.ready;
    await settle();
    /* The real feed deliberately opens at the newest message. This fixture replaces that
       transcript with oldest-first geometry, so reset the inherited
       scroll only after the replacement and font layout have settled. "At rest" below then
       measures the first synthetic row, with a known scroll position. */
    doc.querySelector(".dashboard__feed-view").scrollTop = 0;
    await settle();
    const rect = (selector) => {
      const box = doc.querySelector(selector).getBoundingClientRect();
      return {
        bottom: box.bottom,
        height: box.height,
        left: box.left,
        right: box.right,
        top: box.top,
        width: box.width,
      };
    };
    /* The account popover is a grid. A stray placement on any item reorders what the reader
       sees while DOM and focus order stay put, and on a phone this menu is the only Sign out.
       Open it and report each item in DOM order, so a text grep is not the control. */
    doc.querySelector("[data-user-menu-trigger]").click();
    await settle();
    const menuBox = doc.querySelector("[data-user-menu]").getBoundingClientRect();
    const menuItems = [...doc.querySelector("[data-user-menu]").children].filter((item) => item.getClientRects().length > 0).map((item) => ({
      label: (item.textContent || "").trim().slice(0, 20),
      top: item.getBoundingClientRect().top,
      bottom: item.getBoundingClientRect().bottom,
    }));
    const menu = {
      bottom: menuBox.bottom,
      items: menuItems,
      top: menuBox.top,
    };
    doc.querySelector("[data-user-menu-trigger]").click();
    await settle();
    const feedMore = doc.querySelector("[data-feed-more]");
    const firstRow = doc.querySelector("[data-feed-list] > li");
    const visible = node => !!node && node.getClientRects().length > 0;
    const phone = view.innerWidth <= 832;
    const workspaceSelector = phone ? '.cs-org-phone-bar' : '[data-home-workspace-shell]';
    const feedTrigger = [...doc.querySelectorAll('.cs-kylon-workspace-menu .hm-menu__trigger, [data-home-workspace-shell] .hm-menu__trigger')].find(visible);
    feedTrigger?.click(); await settle();
    const feedControls = [...doc.querySelectorAll('.hm-menu__list [role^="menuitem"]')].filter(visible).map(node => node.textContent.trim());
    feedTrigger?.click(); await settle();
    const nav = doc.querySelector('[data-home-workspace-nav="phone"]');
    const phoneNav = visible(nav) ? rect('[data-home-workspace-nav="phone"]') : null;
    let navigationOpen = false, navItems = [], navigationTargets = [], peopleDoor = false;
    if (phone) {
      doc.querySelector('.cs-org-phone-bar > button').click(); await settle();
      const dialog = doc.querySelector('.cs-org-drawer');
      navigationOpen = dialog.matches(':modal');
      const links = [...dialog.querySelectorAll('a.cs-org-product')].filter(visible);
      navItems = links.map(node => node.textContent.trim());
      navigationTargets = links.map(node => { const box = node.getBoundingClientRect(); return { bottom:box.bottom, height:box.height, left:box.left, right:box.right, top:box.top, width:box.width }; });
      peopleDoor = navItems.includes('People & agents');
      dialog.querySelector('[aria-label="Close navigation"]').click(); await settle();
    }
    const header = rect(".dashboard__channel-head");
    const toolbar = rect(".dashboard__feed-toolbar");
    const composerBox = rect("[data-composer]");
    const headVisible = header.height > 0, toolbarVisible = toolbar.height > 0;
    const transcriptTop = Math.max(rect(".dashboard__feed-view").top, headVisible ? header.bottom : 0, toolbarVisible ? toolbar.bottom : 0);
    const workspaceTop = rect(workspaceSelector).top;
    const combinedHeaderHeight = transcriptTop - workspaceTop;
    const transcriptVisibleHeight = composerBox.top - transcriptTop;
    document.documentElement.dataset.layoutMeasurement = btoa(JSON.stringify({
      combinedHeaderHeight,
      transcriptTop,
      headVisible,
      toolbarVisible,
      feedMenu: visible(feedTrigger), feedControls, navigationOpen, navigationTargets,
      workspaceHeader: rect(workspaceSelector),
      sendUncovered: Boolean(doc.elementFromPoint(rect("[data-composer-send]").left + rect("[data-composer-send]").width / 2, rect("[data-composer-send]").top + rect("[data-composer-send]").height / 2)?.closest("[data-composer-send]")),
      phoneNav, navItems, peopleDoor,
      composer: composerBox,
      feedListPaddingBlockStart:
        view.getComputedStyle(doc.querySelector("[data-feed-list]")).paddingBlockStart,
      feedMore: feedMore.hidden ? null : rect("[data-feed-more]"),
      feedViewScrollTop: doc.querySelector(".dashboard__feed-view").scrollTop,
      feedMoreToFirstRowGap: feedMore.hidden || !firstRow
        ? null
        : firstRow.getBoundingClientRect().top - feedMore.getBoundingClientRect().bottom,
      firstRow: firstRow ? rect("[data-feed-list] > li") : null,
      header,
      input: rect(".dashboard__composer-input"),
      menu,
      send: rect("[data-composer-send]"),
      toolbar,
      transcriptToHeaderRatio: transcriptVisibleHeight / combinedHeaderHeight,
      transcriptVisibleHeight,
      viewport: { height: view.innerHeight, width: view.innerWidth },
      shell: {
        app: rect("live-dashboard"),
        channel: rect(".dashboard__channel"),
        channelBody: rect(".dashboard__channel-body"),
        frame: rect(".dashboard__frame"),
        product: rect(".dashboard__product"),
        root: rect(".dashboard__root"),
      },
    }));
  };
  const start = () => void runMeasurement().catch((error) => reportError(error?.stack ?? error));
  frame.addEventListener("load", start, { once: true });
  if (frame.contentDocument?.readyState === "complete" && frame.contentWindow?.location.pathname === "/__fixture") start();
</script>`;

const measureAt = async (
  chrome: string,
  origin: string,
  width: number,
  height: number,
  reverted: boolean,
  empty = false,
  pending = false,
  more = false,
  todos = false,
): Promise<LayoutMeasurement> => {
  const { stdout, stderr } = await launchChrome(chrome, [
    "--single-process",
    "--no-zygote",
    "--run-all-compositor-stages-before-draw",
    "--window-size=1600,1200",
    "--virtual-time-budget=8000",
    "--dump-dom",
    `${origin}/__measure?width=${width}&height=${height}&reverted=${reverted ? 1 : 0}&empty=${empty ? 1 : 0}&pending=${pending ? 1 : 0}&more=${more ? 1 : 0}&todos=${todos ? 1 : 0}`,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const encoded = stdout.match(/data-layout-measurement="([^"]+)"/)?.[1];
  const encodedError = stdout.match(/data-layout-error="([^"]+)"/)?.[1];
  assert.ok(
    encoded,
    `${width}x${height}: Chrome did not return layout measurements\n` +
      `page error: ${encodedError ? Buffer.from(encodedError, "base64").toString("utf8") : "none"}\n` +
      `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-2_000)}`,
  );
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as LayoutMeasurement;
};

/* The real Kylon phone header keeps the original workspace menu and puts route links in its
 * native drawer. Keep that header compact, feed controls reachable and the first message clear.
 * The reverted-header fixture adds height to these same elements and must fail this rule. */
const assertPhoneHeaderRule = (measurement: LayoutMeasurement, width: number): void => {
  const appBar = measurement.shell.channel.top;
  /* Positive control on the same invocation: without a real app bar the comparison below is
   * satisfied by two zeroes, so it would pass hardest when nothing rendered at all. */
  assert.ok(
    appBar >= 40 && appBar <= 100,
    `${width}px density: the app bar is not a one-row bar (${appBar}px), so the rule below ` +
      `is not measuring anything: ${JSON.stringify(measurement.shell)}`,
  );
  /* Phone-Space.dc.html: the stream starts right under the top bar. While the stream rows are hidden
     (ruling 2) nothing may sit between them; while they show, together they stay under one bar's height. */
  const below = measurement.transcriptTop - appBar;
  assert.ok(
    measurement.headVisible || measurement.toolbarVisible ? below <= appBar : below <= 0.5,
    `${width}px density: ${below}px of header sits between the ${appBar}px workspace bar and the transcript`,
  );
  /* Positive control: hiding the rows must not hide their controls. The ⋯ menu that now holds the view
     switch, the filters and refresh is on screen in the bar. */
  assert.ok(
    measurement.feedMenu,
    `${width}px density: no ⋯ menu in the workspace bar, so the stream's controls are unreachable`,
  );
  /* At rest the first message must clear the channel header and the filter row. */
  assert.equal(
    measurement.feedViewScrollTop,
    0,
    `${width}px density: the transcript is already scrolled, so "at rest" is not what was measured`,
  );
  assert.ok(
    measurement.firstRow !== null && measurement.firstRow.height > 0,
    `${width}px density: there is no first message, so the clearance below measures nothing`,
  );
  assert.ok(
    measurement.firstRow.top >= measurement.transcriptTop - 0.5,
    `${width}px density: ${(measurement.transcriptTop - measurement.firstRow.top).toFixed(1)}px ` +
      "of the first message sits under the header rows at rest: " +
      JSON.stringify({ firstRow: measurement.firstRow, header: measurement.header, toolbar: measurement.toolbar }),
  );
  /* ~~transcript + channel head + bottom nav >= 600px~~, retired 2026-10-07 with the rows. The floor is
     now the reading height Phone-Space.dc.html leaves at 844px: 844 − the 106px header (50 + 44 + 12)
     − the 67px composer (1 + 10 + 46 + 10) − the 75px bottom bar (1 + 8 + 44 + 22) = 596px. */
  if (measurement.viewport.height === 844) assert.ok(
    measurement.transcriptVisibleHeight >= 596,
    `${width}px density: transcript is too short: ${JSON.stringify(measurement)}`,
  );
};

const assertDensity = (measurement: LayoutMeasurement, width: number): void => {
  /* The later composer sprint added the visible TO and keyboard-hint rows. The
   * accepted empty composer leaves 607.9px of transcript at 1440x900. This floor keeps a
   * small regression margin while the reverted-density control below still has to fail. */
  if (width !== 1440) {
    assertPhoneHeaderRule(measurement, width);
    return;
  }
  /* The workspace header and any stream rows share this compactness budget. The reverted
   * variant restores the old rows at their old heights and must still fail the density checks. */
  /* ~~headerMin: 110~~, retired 2026-10-07 (home visual lane). It was the 2026-09 build's own
   * measurement, not a requirement: the floor only exists so an unrendered header cannot pass.
   * The canvas (Space.dc.html) draws no channel head and no filter row at all; its only header is
   * the workspace header above them, which this band does not count. A floor of 110 therefore
   * failed the lane for moving TOWARD the mockup (CI 37680538386: 48px head + 41px filter row =
   * 89px). The floor is now one 44px tap row, and the channel head must be present, which is the
   * same positive control the phone rule uses. headerMax and every reading-space check stand, and
   * the reverted fixture (a 140px head and a 96px filter row) still fails the band. */
  /* DERIVED FROM Space.dc.html (2026-10-07, ruling 2). The canvas has one header above the stream:
   * 16 + the 28px title at 1.1 (30.8) + 2 + the 14px subline at 1.45 (20.3) + 16 + a 1px rule = 86.1px,
   * so the band's ceiling is 87. Its floor stays the 44px tap row that proves a header rendered.
   * At 1440x900 that header and the 111.85px composer leave 900 − 86.1 − 111.85 = 702.05px to read,
   * a ratio of 8.15. ~~headerMax 125, ratioMin 5, transcriptMin 600~~ measured the head and filter
   * rows the canvas does not have. */
  const limits = { headerMax: 87, headerMin: 44, ratioMin: 8, transcriptMin: 702 };
  assert.ok(
    measurement.workspaceHeader.height >= 44,
    `${width}px density: the workspace header is missing: ` + JSON.stringify(measurement.workspaceHeader),
  );
  assert.ok(measurement.feedMenu, `${width}px density: no ⋯ menu, so the stream's controls are unreachable`);
  const referenceTranscript = measurement.transcriptVisibleHeight;
  assert.ok(
    measurement.combinedHeaderHeight >= limits.headerMin &&
      measurement.combinedHeaderHeight <= limits.headerMax,
    `${width}px density: header is outside its usable band: ${JSON.stringify(measurement)}`,
  );
  assert.ok(
    referenceTranscript >= limits.transcriptMin,
    `${width}px density: transcript is too short: ${JSON.stringify(measurement)}`,
  );
  assert.ok(
    measurement.transcriptVisibleHeight / measurement.combinedHeaderHeight >= limits.ratioMin,
    `${width}px density: transcript/header ratio is too low: ${JSON.stringify(measurement)}`,
  );
};

const assertInsideViewport = (measurement: LayoutMeasurement, todosAvailable = false): void => {
  assert.equal(measurement.sendUncovered, true, "the account door and other controls must leave Send clickable at its centre");
  assert.ok(measurement.feedControls.includes("All messages") && measurement.feedControls.includes("Broadcast") &&
    measurement.feedControls.includes("Refresh observer data"), "the visible menu retains channel, filter and refresh controls");
  if (measurement.viewport.width <= 832) {
    assert.equal(measurement.navigationOpen, true, "the real phone navigation must open as a native modal");
    assert.deepEqual(measurement.navItems, ["Catch up", "Chat", "People & agents", ...(todosAvailable ? ["To-dos"] : []), "Lists", "Files", "Wiki"],
      "To-dos appears only when its read exists; the phone keeps the projected native route links");
    assert.equal(measurement.peopleDoor, true);
    assert.ok(measurement.navigationTargets.every(target => target.height >= 44 && target.width >= 44 &&
      target.left >= -0.1 && target.right <= measurement.viewport.width + 0.1 && target.top >= -0.1 &&
      target.bottom <= measurement.viewport.height + 0.1), "phone route links retain visible 44px targets");
    assert.ok(measurement.input.height >= 44 && measurement.send.height >= 44 && measurement.send.width >= 44,
      "the narrow composer keeps its editable field and Send targets");
  }
  if (measurement.phoneNav) {
    assert.ok(measurement.phoneNav.height >= 44);
    assert.ok(measurement.composer.bottom <= measurement.phoneNav.top + 0.5, "the composer stays above bottom navigation");
  }
  for (const [name, rect] of Object.entries({
    composer: measurement.composer,
    input: measurement.input,
    send: measurement.send,
    ...(measurement.phoneNav ? { navigation: measurement.phoneNav } : {}),
  })) {
    assert.ok(
      rect.bottom <= measurement.viewport.height + 0.1 &&
        rect.left >= -0.1 &&
        rect.right <= measurement.viewport.width + 0.1,
      `${name} is outside the viewport: ${JSON.stringify({ rect, viewport: measurement.viewport })}`,
    );
  }
};

test("the live feed header stays compact and the narrow composer stays in view", async () => {
  const chrome = await findChrome();
  const server = await startDistServer(frameScript);
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const current = await measureAt(chrome, server.origin, width, height, false);
      const reverted = await measureAt(chrome, server.origin, width, height, true);
      assert.equal(current.viewport.width, width, `${width}px iframe width drifted`);
      assert.equal(current.viewport.height, height, `${width}px iframe height drifted`);
      assertDensity(current, width);
      assertInsideViewport(current);
      assert.equal(reverted.feedMenu, true, "the negative control retains the visible feed menu");
      assert.deepEqual(reverted.feedControls, current.feedControls, "the negative control retains the same feed controls");
      /* A larger header must consume reading space within the same bounded frame. */
      if (width === 1440) {
        assert.ok(
          current.transcriptVisibleHeight >= reverted.transcriptVisibleHeight + 30,
          `${width}px: transcript did not gain at least 30px: ${JSON.stringify({ current, reverted })}`,
        );
      }
      assert.ok(
        current.combinedHeaderHeight <= reverted.combinedHeaderHeight - 25,
        `${width}px: header did not lose at least 25px: ${JSON.stringify({ current, reverted })}`,
      );
      assert.throws(
        () => assertDensity(reverted, width),
        /density/,
        `${width}px: reverted density unexpectedly passed`,
      );
      if (width === 390) assert.ok(reverted.transcriptVisibleHeight < current.transcriptVisibleHeight,
        "a taller header must take reading space from the phone");
      console.log(`mobile-feed-layout ${width}px ${JSON.stringify({ current, reverted })}`);
    }
  } finally {
    await server.close();
  }
});

/* A separate case, not another width in the loop above: the short-viewport block at 36rem of
   height changes the composer and the head's padding, and the smallest phone is where a floor
   that is 8px too generous stops fitting. Found by measuring: the short-viewport block once put
   the taller padding back and made the head 61px against a 57px app bar. The transcript floor
   in the shared rule does not apply at 568px of screen, so this case asserts the rule's other
   three parts and the viewport containment. */
test("the smallest phone fits the workspace header, channel menu, composer and native navigation", async () => {
  const chrome = await findChrome();
  const server = await startDistServer(frameScript);
  try {
    /* Keep the pending roster input while measuring the real header and native route doors. */
    const measurement = await measureAt(chrome, server.origin, 320, 568, false, false, true);
    assert.deepEqual(measurement.viewport, { width: 320, height: 568 });
    const appBar = measurement.shell.channel.top;
    assert.ok(
      appBar >= 40 && appBar <= 100,
      `320x568: the app bar is not a one-row bar (${appBar}px), so the rule below is not ` +
        `measuring anything: ${JSON.stringify(measurement.shell)}`,
    );
    /* Ruling 2: the stream starts right under the bar, and the ⋯ menu holds the rows' controls. */
    assert.ok(
      measurement.transcriptTop - appBar <= 0.5,
      `320x568: ${measurement.transcriptTop - appBar}px of header sits between the ${appBar}px workspace bar and the transcript`,
    );
    assert.ok(measurement.feedMenu, `320x568: no ⋯ menu in the bar: ${JSON.stringify(measurement.shell)}`);
    /* At-rest clearance at the shortest phone: a wrapped header must not cover the first message.
       The shared rule's transcript floor is written for an 844px screen. */
    assert.equal(
      measurement.feedViewScrollTop,
      0,
      "320x568: the transcript is already scrolled, so \"at rest\" is not what was measured",
    );
    assert.ok(
      measurement.firstRow !== null && measurement.firstRow.height > 0,
      "320x568: there is no first message, so the clearance below measures nothing",
    );
    assert.ok(
      measurement.firstRow.top >= measurement.transcriptTop - 0.5,
      `320x568: the first message sits under the header at rest: ${JSON.stringify({
        firstRow: measurement.firstRow,
        header: measurement.header,
        toolbar: measurement.toolbar,
      })}`,
    );
    assertInsideViewport(measurement);
    const withTodos = await measureAt(chrome, server.origin, 320, 568, false, false, true, false, true);
    assertInsideViewport(withTodos, true);
    console.log(`mobile-feed-layout 320px ${JSON.stringify({ measurement, withTodos })}`);
  } finally {
    await server.close();
  }
});

/* A live control, because a text grep is not one: `grid-area`, `order`, or a grouped selector
   can reorder this menu without matching any pattern. What must hold is that the reader sees
   the items in the order the DOM and the focus ring use, and that the whole menu is on screen —
   on a phone this popover is the only Sign out there is. */
test("the account menu paints in DOM order and stays on screen at phone widths", async () => {
  const chrome = await findChrome();
  const server = await startDistServer(frameScript);
  try {
    for (const [width, height] of [[390, 844], [320, 568]]) {
      const measurement = await measureAt(chrome, server.origin, width, height, false);
      const { items } = measurement.menu;
      assert.ok(items.length >= 3, `${width}px: the account menu is missing items`);
      /* Positive control on the same invocation. A closed popover reports zeroes for every
         rectangle, and zeroes satisfy the ordering test below — so without this the control
         would pass hardest exactly when the menu never opened. */
      assert.ok(
        measurement.menu.bottom - measurement.menu.top > 0,
        `${width}px: the account menu did not open, so nothing below was measured`,
      );
      for (const item of items) {
        assert.ok(
          item.bottom - item.top > 0,
          `${width}px: the account menu item "${item.label}" has no box: ${JSON.stringify(items)}`,
        );
      }
      for (const [index, item] of items.entries()) {
        const previous = items[index - 1];
        if (previous) {
          assert.ok(
            item.top >= previous.bottom - 0.1,
            `${width}px: the account menu paints "${item.label}" above "${previous.label}", ` +
              `which is not the order the DOM and the focus ring use: ${JSON.stringify(items)}`,
          );
        }
      }
      assert.ok(
        measurement.menu.top >= -0.1 && measurement.menu.bottom <= height + 0.1,
        `${width}px: the account menu is outside the viewport: ${JSON.stringify(measurement.menu)}`,
      );
    }
  } finally {
    await server.close();
  }
});

test("an empty feed keeps the app shell at the dynamic viewport height", async () => {
  const chrome = await findChrome();
  const server = await startDistServer(frameScript);
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const measurement = await measureAt(chrome, server.origin, width, height, false, true);
      assert.deepEqual(measurement.viewport, { width, height });
      for (const name of ["app", "root", "product"] as const) {
        const rect = measurement.shell[name];
        assert.ok(
          Math.abs(rect.height - height) <= 0.1 &&
            Math.abs(rect.top) <= 0.1 &&
            Math.abs(rect.bottom - height) <= 0.1,
          `${width}x${height}: ${name} does not fill the empty app viewport: ${JSON.stringify(rect)}`,
        );
      }
      /* The host moves the original frame below the visible phone header. It must fill
       * the remaining space to the viewport bottom, like its channel children. */
      for (const name of ["frame"] as const) {
        const rect = measurement.shell[name];
        assert.ok(
          rect.height > 0 && Math.abs(rect.bottom - height) <= 0.1,
          `${width}x${height}: ${name} does not flex to the viewport bottom: ${JSON.stringify(rect)}`,
        );
      }
      for (const name of ["channel", "channelBody"] as const) {
        const rect = measurement.shell[name];
        assert.ok(rect.height > 0 && Math.abs(rect.bottom - (measurement.phoneNav?.top ?? height)) <= 0.5, `${name} must reach the bottom navigation or viewport`);
      }
      assert.ok(Math.abs(measurement.composer.bottom - (measurement.phoneNav?.top ?? height)) <= 0.5);
      assertInsideViewport(measurement);
      console.log(`empty-app-shell ${width}x${height} ${JSON.stringify(measurement.shell)}`);
    }
  } finally {
    await server.close();
  }
});

/* The workspace menu stays in the visible header. Showing Load older must not change list padding
   or create a second header-sized gap before the first message. Both cases measure the same
   production shell and keep a visible button as the positive control. */
test("the channel menu stays above older updates without a second clearance gap", async () => {
  const chrome = await findChrome();
  const server = await startDistServer(frameScript);
  try {
    const withMore = await measureAt(chrome, server.origin, 390, 844, false, false, false, true);
    const withoutMore = await measureAt(chrome, server.origin, 390, 844, false, false, false, false);
    /* Positive control on the same invocation: with no visible button there is nothing to pay
       twice, so every assertion below would be satisfied by a knob that did nothing. */
    assert.ok(
      withMore.feedMore !== null && withMore.feedMore.height > 0,
      `load-older is not on screen, so this case measures nothing: ${JSON.stringify(withMore.feedMore)}`,
    );
    assert.equal(
      withoutMore.feedMore,
      null,
      "load-older is showing in the variant that must not show it",
    );
    assert.equal(withoutMore.feedListPaddingBlockStart, withMore.feedListPaddingBlockStart,
      "the in-flow channel menu needs the same list padding with or without older updates");
    assert.ok(
      withMore.feedMoreToFirstRowGap !== null && withMore.feedMoreToFirstRowGap < 20,
      `${withMore.feedMoreToFirstRowGap}px of dead screen sits between load-older and the first ` +
        "message",
    );
    /* The rule the whole block exists for still holds while the button is up. */
    assertPhoneHeaderRule(withMore, 390);
    assertInsideViewport(withMore);
    console.log(`feed-more-clearance ${JSON.stringify({
      gap: withMore.feedMoreToFirstRowGap,
      withMore: withMore.feedListPaddingBlockStart,
      withoutMore: withoutMore.feedListPaddingBlockStart,
    })}`);
  } finally {
    await server.close();
  }
});
