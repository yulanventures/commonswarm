import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_ORIGIN,
  APP_URL,
  classifyNavigation,
  getAllowedDevOrigin,
  isAllowedExternalUrl,
  isAllowedSignInUrl,
  isAppOriginUrl,
  isPermissionAllowed,
  OVERRIDE_ENV_VAR,
  resolveAppUrl,
  SIGN_IN_HOSTS,
} from "./policy.js";

const APP_NAV_NO_GESTURE = {
  source: "navigate",
  isMainFrame: true,
  initiatorIsMainFrame: true,
  initiatorOrigin: APP_ORIGIN,
  initiatorUrl: APP_URL,
  hasUserGesture: false,
} as const;

const APP_NAV_WITH_GESTURE = {
  ...APP_NAV_NO_GESTURE,
  hasUserGesture: true,
} as const;

const APP_NEW_WINDOW_NO_GESTURE = {
  source: "new_window",
  isMainFrame: true,
  initiatorIsMainFrame: true,
  initiatorOrigin: APP_ORIGIN,
  initiatorUrl: APP_URL,
  hasUserGesture: false,
  mainFrameHasSubframes: false,
} as const;

const APP_NEW_WINDOW_WITH_GESTURE = {
  ...APP_NEW_WINDOW_NO_GESTURE,
  hasUserGesture: true,
} as const;

test("classifyNavigation allows the CommonSwarm app origin on any path from app main frame", () => {
  for (const opts of [
    APP_NAV_NO_GESTURE,
    APP_NAV_WITH_GESTURE,
    APP_NEW_WINDOW_NO_GESTURE,
    APP_NEW_WINDOW_WITH_GESTURE,
  ]) {
    assert.equal(classifyNavigation("https://commonswarm.com", opts), "in_app");
    assert.equal(classifyNavigation("https://commonswarm.com/app", opts), "in_app");
    assert.equal(classifyNavigation("https://commonswarm.com/invite?token=abc#section", opts), "in_app");
    assert.equal(classifyNavigation("https://commonswarm.com/support", opts), "in_app");
  }
});

test("classifyNavigation ignores subframe navigations and redirects and blocks subframe new_window", () => {
  for (const url of [
    "https://foreign.example/frame",
    "https://commonswarm.com/app",
    "https://api.commonswarm.com/auth/v1/authorize?provider=github",
    "http://127.0.0.1:9999/subframe",
    "javascript:alert(1)",
  ]) {
    assert.equal(
      classifyNavigation(url, {
        source: "navigate",
        isMainFrame: false,
        initiatorIsMainFrame: false,
        initiatorOrigin: "https://foreign.example",
        hasUserGesture: true,
      }),
      "ignore",
      `expected subframe navigate to ${url} to be ignored`,
    );
    assert.equal(
      classifyNavigation(url, {
        source: "redirect",
        isMainFrame: false,
        continuingTrustedNavigation: true,
        previousNavigationUrl: APP_URL,
        hasUserGesture: true,
      }),
      "ignore",
      `expected subframe redirect to ${url} to be ignored`,
    );
    assert.equal(
      classifyNavigation(url, {
        source: "new_window",
        isMainFrame: false,
        initiatorIsMainFrame: false,
        initiatorOrigin: "https://foreign.example",
        hasUserGesture: true,
      }),
      "blocked",
      `expected subframe new_window to ${url} to be blocked`,
    );
  }
});

test("classifyNavigation cancels main-frame navigations started by non-app or non-main-frame initiators", () => {
  const untrustedInitiators = [
    {
      label: "subframe at foreign origin",
      initiatorIsMainFrame: false,
      initiatorOrigin: "https://foreign.example",
      initiatorUrl: "https://foreign.example/embed",
    },
    {
      label: "subframe even at app origin",
      initiatorIsMainFrame: false,
      initiatorOrigin: APP_ORIGIN,
      initiatorUrl: APP_URL,
    },
    {
      label: "missing initiator",
      initiatorIsMainFrame: false,
      initiatorOrigin: null,
      initiatorUrl: null,
    },
    {
      label: "foreign main frame",
      initiatorIsMainFrame: true,
      initiatorOrigin: "https://example.com",
      initiatorUrl: "https://example.com/page",
    },
    {
      label: "opaque origin",
      initiatorIsMainFrame: true,
      initiatorOrigin: "null",
      initiatorUrl: "about:blank",
    },
    {
      label: "unlisted path on sign-in host",
      initiatorIsMainFrame: true,
      initiatorOrigin: "https://github.com",
      initiatorUrl: "https://github.com/yulanventures/commonswarm",
    },
    {
      label: "mismatched initiatorOrigin and initiatorUrl",
      initiatorIsMainFrame: true,
      initiatorOrigin: APP_ORIGIN,
      initiatorUrl: "https://evil.example/spoof",
    },
  ];

  for (const init of untrustedInitiators) {
    for (const target of [
      "https://commonswarm.com/app",
      "https://api.commonswarm.com/auth/v1/authorize?provider=github",
      "https://github.com/login/oauth/authorize?client_id=abc",
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc",
      "https://example.com/external",
    ]) {
      assert.equal(
        classifyNavigation(target, {
          source: "navigate",
          isMainFrame: true,
          ...init,
          hasUserGesture: true,
        }),
        "blocked",
        `expected main-frame nav to ${target} from ${init.label} to be blocked`,
      );
      assert.equal(
        classifyNavigation(target, {
          source: "new_window",
          isMainFrame: true,
          ...init,
          hasUserGesture: true,
          mainFrameHasSubframes: false,
        }),
        "blocked",
        `expected new_window to ${target} from ${init.label} to be blocked`,
      );
    }
  }
});

test("classifyNavigation allows every allow-listed sign-in host path on navigate from app main frame", () => {
  assert.equal(SIGN_IN_HOSTS.length, 3);
  for (const entry of SIGN_IN_HOSTS) {
    assert.ok(entry.reason.length > 0, `missing reason for ${entry.host}`);
    assert.ok(entry.paths.length > 0, `missing paths for ${entry.host}`);
    for (const pathEntry of entry.paths) {
      assert.ok(pathEntry.reason.length > 0, `missing reason for ${entry.host}${pathEntry.prefix}`);
      const samplePath = pathEntry.prefix.endsWith("/")
        ? `${pathEntry.prefix}step`
        : pathEntry.prefix;
      const target = `https://${entry.host}${samplePath}`;
      assert.equal(
        classifyNavigation(target, APP_NAV_NO_GESTURE),
        "in_app",
        `expected ${target} to be in_app on navigate from app main frame`,
      );
      assert.equal(
        classifyNavigation(target, APP_NEW_WINDOW_WITH_GESTURE),
        "external",
        `expected ${target} to be external for new_window with user gesture`,
      );
      assert.equal(
        classifyNavigation(target, APP_NEW_WINDOW_NO_GESTURE),
        "blocked",
        `expected ${target} to be blocked for new_window without user gesture`,
      );
    }
    assert.equal(
      classifyNavigation(`https://${entry.host}/not-an-auth-path`, APP_NAV_WITH_GESTURE),
      "external",
      `expected unlisted path on ${entry.host} to be external with gesture`,
    );
    assert.equal(
      classifyNavigation(`https://${entry.host}/not-an-auth-path`, APP_NAV_NO_GESTURE),
      "blocked",
      `expected unlisted path on ${entry.host} to be blocked without gesture`,
    );
  }
});

test("classifyNavigation never opens shell.openExternal on any redirect and cancels unexpected redirects", () => {
  for (const unexpectedTarget of [
    "https://example.com/unexpected",
    "https://github.com/yulanventures/commonswarm/pull/1",
    "https://api.commonswarm.com/functions/v1/command",
    "https://accounts.google.com/ManageAccount",
    "https://commonswarm.com.evil.example/app",
    "https://user:pass@commonswarm.com/app",
    "http://commonswarm.com/app",
    "file:///etc/passwd",
  ]) {
    assert.equal(
      classifyNavigation(unexpectedTarget, {
        source: "redirect",
        isMainFrame: true,
        continuingTrustedNavigation: true,
        previousNavigationUrl: "https://api.commonswarm.com/auth/v1/authorize?provider=github",
        hasUserGesture: true,
      }),
      "blocked",
      `expected redirect to ${unexpectedTarget} to be blocked (never external)`,
    );
  }

  // Redirect without an active trusted main-frame navigation is always blocked
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc", {
      source: "redirect",
      isMainFrame: true,
      continuingTrustedNavigation: false,
      previousNavigationUrl: APP_URL,
    }),
    "blocked",
  );
  assert.equal(
    classifyNavigation("https://commonswarm.com/app", {
      source: "redirect",
      isMainFrame: true,
      continuingTrustedNavigation: false,
      previousNavigationUrl: null,
    }),
    "blocked",
  );
  // Redirect reporting a non-main-frame initiator is blocked even if continuingTrustedNavigation is true
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc", {
      source: "redirect",
      isMainFrame: true,
      initiatorIsMainFrame: false,
      continuingTrustedNavigation: true,
      previousNavigationUrl: APP_URL,
    }),
    "blocked",
  );
});

test("classifyNavigation allows the full OAuth navigate and redirect chain and blocks external escapes from sign-in hosts", () => {
  const steps: ReadonlyArray<{ url: string; source: "navigate" | "redirect" }> = [
    { url: "https://api.commonswarm.com/auth/v1/authorize?provider=github", source: "navigate" },
    { url: "https://github.com/login/oauth/authorize?client_id=abc", source: "redirect" },
    { url: "https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize", source: "redirect" },
    { url: "https://github.com/session", source: "navigate" },
    { url: "https://github.com/sessions/two-factor/app", source: "navigate" },
    { url: "https://api.commonswarm.com/auth/v1/callback?code=123", source: "redirect" },
    { url: "https://commonswarm.com/app?code=123", source: "redirect" },
  ];

  let previousUrl = APP_URL;
  for (const step of steps) {
    const disposition =
      step.source === "redirect"
        ? classifyNavigation(step.url, {
            source: "redirect",
            isMainFrame: true,
            continuingTrustedNavigation: true,
            previousNavigationUrl: previousUrl,
          })
        : classifyNavigation(step.url, {
            source: "navigate",
            isMainFrame: true,
            initiatorIsMainFrame: true,
            initiatorOrigin: new URL(previousUrl).origin,
            initiatorUrl: previousUrl,
          });
    assert.equal(disposition, "in_app", `expected ${step.source} ${previousUrl} -> ${step.url} to be in_app`);
    previousUrl = step.url;
  }

  // While on a sign-in host, arbitrary external links cannot invoke shell.openExternal even with a user gesture
  assert.equal(
    classifyNavigation("https://example.com/terms", {
      source: "navigate",
      isMainFrame: true,
      initiatorIsMainFrame: true,
      initiatorOrigin: "https://github.com",
      initiatorUrl: "https://github.com/login",
      hasUserGesture: true,
    }),
    "blocked",
  );
});

test("classifyNavigation requires a real user gesture to open external https links", () => {
  const externalUrls = [
    "https://example.com/docs",
    "https://docs.github.com/en",
    "https://github.com/yulanventures/commonswarm/pull/1",
    "https://github.com/login/../yulanventures/commonswarm/pull/1",
    "https://commonswarm.com.evil.example/app",
    "https://commonswarm.com:8443/app",
  ];

  for (const url of externalUrls) {
    assert.equal(classifyNavigation(url, APP_NAV_WITH_GESTURE), "external", `navigate+gesture ${url}`);
    assert.equal(classifyNavigation(url, APP_NAV_NO_GESTURE), "blocked", `navigate no gesture ${url}`);
    assert.equal(classifyNavigation(url, APP_NEW_WINDOW_WITH_GESTURE), "external", `new_window+gesture ${url}`);
    assert.equal(classifyNavigation(url, APP_NEW_WINDOW_NO_GESTURE), "blocked", `new_window no gesture ${url}`);
  }
});

test("classifyNavigation blocks new_window when mainFrameHasSubframes is true or omitted, and allows without subframes", () => {
  const targets = [
    "https://example.com/from-frame",
    "https://example.com/docs",
    "https://commonswarm.com/app",
    "https://commonswarm.com/invite",
  ];

  for (const url of targets) {
    assert.equal(
      classifyNavigation(url, {
        ...APP_NEW_WINDOW_WITH_GESTURE,
        mainFrameHasSubframes: true,
      }),
      "blocked",
      `expected new_window to ${url} to be dropped when a subframe is present even with a gesture`,
    );

    const { mainFrameHasSubframes: _omitted, ...withoutSubframeFlag } = APP_NEW_WINDOW_WITH_GESTURE;
    assert.equal(
      classifyNavigation(url, withoutSubframeFlag),
      "blocked",
      `expected new_window to ${url} to fail closed when mainFrameHasSubframes is omitted`,
    );
  }

  assert.equal(
    classifyNavigation("https://example.com/from-frame", {
      ...APP_NEW_WINDOW_WITH_GESTURE,
      mainFrameHasSubframes: false,
    }),
    "external",
  );
  assert.equal(
    classifyNavigation("https://commonswarm.com/app", {
      ...APP_NEW_WINDOW_WITH_GESTURE,
      mainFrameHasSubframes: false,
    }),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://example.com/from-frame", {
      ...APP_NEW_WINDOW_NO_GESTURE,
      mainFrameHasSubframes: false,
    }),
    "blocked",
  );
});

test("classifyNavigation blocks non-https, dangerous schemes, credentials, and malformed input even with a gesture", () => {
  const blockedUrls = [
    "http://commonswarm.com",
    "http://commonswarm.com/app",
    "http://api.commonswarm.com/auth/v1/authorize",
    "http://example.com",
    "http://localhost:4321/app",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "commonswarm://open",
    "mailto:ops@commonswarm.com",
    "https://user:pass@commonswarm.com/app",
    "https://user@example.com/docs",
    "https://user:pass@example.com/docs",
    "https://github.com@evil.example/login",
    "",
    "   ",
    "not a url",
    "://missing-scheme",
  ];

  for (const url of blockedUrls) {
    assert.equal(classifyNavigation(url, APP_NAV_WITH_GESTURE), "blocked", `navigate ${url}`);
    assert.equal(classifyNavigation(url, APP_NEW_WINDOW_WITH_GESTURE), "blocked", `new_window ${url}`);
    assert.equal(
      classifyNavigation(url, {
        source: "redirect",
        isMainFrame: true,
        continuingTrustedNavigation: true,
        previousNavigationUrl: APP_URL,
      }),
      "blocked",
      `redirect ${url}`,
    );
  }
});

test("classifyNavigation allows bundled offline page to retry only the app origin", () => {
  const offlineOpts = {
    source: "navigate",
    isMainFrame: true,
    initiatorIsMainFrame: true,
    initiatorOrigin: "null",
    initiatorUrl: "file:///app/static/offline.html?target=https%3A%2F%2Fcommonswarm.com%2Fapp",
    initiatorIsOfflinePage: true,
    hasUserGesture: true,
  } as const;

  assert.equal(classifyNavigation("https://commonswarm.com/app", offlineOpts), "in_app");
  assert.equal(classifyNavigation("https://api.commonswarm.com/auth/v1/authorize", offlineOpts), "blocked");
  assert.equal(classifyNavigation("https://example.com/docs", offlineOpts), "blocked");
});

test("resolveAppUrl accepts override only when unpackaged and only for allowed origins", () => {
  assert.equal(resolveAppUrl({ isPackaged: false, env: {} }), APP_URL);
  assert.equal(resolveAppUrl({ isPackaged: true, env: {} }), APP_URL);

  // Accepted when unpackaged
  assert.equal(
    resolveAppUrl({
      isPackaged: false,
      env: { [OVERRIDE_ENV_VAR]: "http://localhost:4321/app" },
    }),
    "http://localhost:4321/app",
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: false,
      env: { [OVERRIDE_ENV_VAR]: "http://localhost/app" },
    }),
    "http://localhost/app",
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: false,
      env: { [OVERRIDE_ENV_VAR]: "http://127.0.0.1:4321/app" },
    }),
    "http://127.0.0.1:4321/app",
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: false,
      env: { [OVERRIDE_ENV_VAR]: "https://commonswarm.com/invite" },
    }),
    "https://commonswarm.com/invite",
  );

  // Ignored when packaged, even for allowed origins
  assert.equal(
    resolveAppUrl({
      isPackaged: true,
      env: { [OVERRIDE_ENV_VAR]: "http://localhost:4321/app" },
    }),
    APP_URL,
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: true,
      env: { [OVERRIDE_ENV_VAR]: "http://127.0.0.1:4321/app" },
    }),
    APP_URL,
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: true,
      env: { [OVERRIDE_ENV_VAR]: "https://commonswarm.com/invite" },
    }),
    APP_URL,
  );

  // Rejected origins and malformed values when unpackaged
  for (const rejected of [
    "https://evil.example/app",
    "https://commonswarm.com.evil.example/app",
    "https://commonswarm.com:8443/app",
    "http://commonswarm.com/app",
    "http://127.0.0.2:4321/app",
    "https://localhost:4321/app",
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "http://user:pass@localhost:4321/app",
    "not a url",
  ]) {
    assert.equal(
      resolveAppUrl({
        isPackaged: false,
        env: { [OVERRIDE_ENV_VAR]: rejected },
      }),
      APP_URL,
      `expected override ${rejected} to be rejected`,
    );
  }
});

test("allowedDevOrigin permits only the matching local dev origin in unpackaged mode", () => {
  const devOrigin = getAllowedDevOrigin("http://127.0.0.1:4321/app", false);
  assert.equal(devOrigin, "http://127.0.0.1:4321");
  assert.equal(getAllowedDevOrigin("http://127.0.0.1:4321/app", true), null);
  assert.equal(getAllowedDevOrigin("https://commonswarm.com/app", false), null);

  const fromDevMain = {
    source: "navigate",
    isMainFrame: true,
    initiatorIsMainFrame: true,
    initiatorOrigin: devOrigin,
    initiatorUrl: "http://127.0.0.1:4321/app",
    allowedDevOrigin: devOrigin,
  } as const;

  assert.equal(classifyNavigation("http://127.0.0.1:4321/invite", fromDevMain), "in_app");
  assert.equal(
    classifyNavigation("http://127.0.0.1:4321/invite", {
      ...fromDevMain,
      source: "new_window",
      mainFrameHasSubframes: false,
    }),
    "in_app",
  );
  assert.equal(classifyNavigation("http://127.0.0.1:9999/other", fromDevMain), "blocked");
  assert.equal(classifyNavigation("http://commonswarm.com/app", fromDevMain), "blocked");
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/authorize?provider=github", fromDevMain),
    "in_app",
  );
});

test("isPermissionAllowed grants notifications only for app origin in the main frame and fails closed", () => {
  // Missing or empty requester URL: deny
  assert.equal(isPermissionAllowed({ permission: "notifications", requestingUrl: undefined, isMainFrame: true }), false);
  assert.equal(isPermissionAllowed({ permission: "notifications", requestingUrl: null, isMainFrame: true }), false);
  assert.equal(isPermissionAllowed({ permission: "notifications", requestingUrl: "", isMainFrame: true }), false);
  assert.equal(isPermissionAllowed({ permission: "notifications", requestingUrl: "   ", isMainFrame: true }), false);

  // Foreign requester URL: deny (main frame or subframe)
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://evil.example/page", isMainFrame: true }),
    false,
  );
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://evil.example/page", isMainFrame: false }),
    false,
  );
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://github.com/login", isMainFrame: true }),
    false,
  );

  // App origin from subframe: deny
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://commonswarm.com/app", isMainFrame: false }),
    false,
  );

  // App origin with credentials: deny
  assert.equal(
    isPermissionAllowed({
      permission: "notifications",
      requestingUrl: "https://user:pass@commonswarm.com/app",
      isMainFrame: true,
    }),
    false,
  );

  // Non-notification permission from app main frame: deny
  assert.equal(
    isPermissionAllowed({ permission: "geolocation", requestingUrl: "https://commonswarm.com/app", isMainFrame: true }),
    false,
  );
  assert.equal(
    isPermissionAllowed({ permission: "media", requestingUrl: "https://commonswarm.com/app", isMainFrame: true }),
    false,
  );
  assert.equal(
    isPermissionAllowed({ permission: "openExternal", requestingUrl: "https://commonswarm.com/app", isMainFrame: true }),
    false,
  );

  // App origin from main frame: allow
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://commonswarm.com/app", isMainFrame: true }),
    true,
  );
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://commonswarm.com", isMainFrame: true }),
    true,
  );

  // Unpackaged local dev origin: allow matching main frame only, deny other port or subframe
  const devOpts = { allowedDevOrigin: "http://127.0.0.1:4321" };
  assert.equal(
    isPermissionAllowed({
      ...devOpts,
      permission: "notifications",
      requestingUrl: "http://127.0.0.1:4321/app",
      isMainFrame: true,
    }),
    true,
  );
  assert.equal(
    isPermissionAllowed({
      ...devOpts,
      permission: "notifications",
      requestingUrl: "http://127.0.0.1:4321/app",
      isMainFrame: false,
    }),
    false,
  );
  assert.equal(
    isPermissionAllowed({
      ...devOpts,
      permission: "notifications",
      requestingUrl: "http://127.0.0.1:9999/frame",
      isMainFrame: false,
    }),
    false,
  );
  assert.equal(
    isPermissionAllowed({
      ...devOpts,
      permission: "notifications",
      requestingUrl: "http://127.0.0.1:9999/frame",
      isMainFrame: true,
    }),
    false,
  );
});

test("isAppOriginUrl, isAllowedSignInUrl, and isAllowedExternalUrl enforce host and scheme rules", () => {
  assert.equal(isAppOriginUrl("https://commonswarm.com/app"), true);
  assert.equal(isAppOriginUrl("https://github.com/login"), false);
  assert.equal(isAppOriginUrl("https://accounts.google.com/o/oauth2/v2/auth"), false);
  assert.equal(isAppOriginUrl("https://api.commonswarm.com/auth/v1/authorize"), false);

  assert.equal(isAllowedSignInUrl("https://api.commonswarm.com/auth/v1/authorize"), true);
  assert.equal(isAllowedSignInUrl("https://github.com/login"), true);
  assert.equal(isAllowedSignInUrl("https://github.com/yulanventures/commonswarm"), false);

  assert.equal(isAllowedExternalUrl("https://commonswarm.com/support"), true);
  assert.equal(isAllowedExternalUrl("https://example.com"), true);
  assert.equal(isAllowedExternalUrl("https://user:pass@example.com"), false);
  assert.equal(isAllowedExternalUrl("https://user@example.com"), false);
  assert.equal(isAllowedExternalUrl("http://example.com"), false);
  assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("mailto:ops@commonswarm.com"), false);
  assert.equal(isAllowedExternalUrl("not a url"), false);
});
