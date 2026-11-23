import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_URL,
  classifyNavigation,
  getAllowedDevOrigin,
  isAllowedExternalUrl,
  isAppOriginUrl,
  OVERRIDE_ENV_VAR,
  resolveAppUrl,
  SIGN_IN_HOSTS,
} from "./policy.js";

const FROM_APP = { source: "navigate", currentUrl: APP_URL } as const;
const NEW_WINDOW = { source: "new_window", currentUrl: APP_URL } as const;

test("classifyNavigation allows the CommonSwarm app origin on any path", () => {
  for (const opts of [FROM_APP, NEW_WINDOW]) {
    assert.equal(classifyNavigation("https://commonswarm.com", opts), "in_app");
    assert.equal(classifyNavigation("https://commonswarm.com/app", opts), "in_app");
    assert.equal(classifyNavigation("https://commonswarm.com/invite?token=abc#section", opts), "in_app");
    assert.equal(classifyNavigation("https://commonswarm.com/support", opts), "in_app");
  }
});

test("classifyNavigation allows every allow-listed sign-in host path on navigate from app origin", () => {
  assert.ok(SIGN_IN_HOSTS.length >= 3);
  for (const entry of SIGN_IN_HOSTS) {
    assert.ok(entry.reason.length > 0, `missing reason for ${entry.host}`);
    assert.ok(entry.paths.length > 0, `missing paths for ${entry.host}`);
    for (const pathEntry of entry.paths) {
      assert.ok(pathEntry.reason.length > 0, `missing reason for ${entry.host}${pathEntry.prefix}`);
      const samplePath = pathEntry.prefix.endsWith("/")
        ? `${pathEntry.prefix}step`
        : pathEntry.prefix;
      assert.equal(
        classifyNavigation(`https://${entry.host}${samplePath}`, FROM_APP),
        "in_app",
        `expected ${entry.host}${samplePath} to be in_app`,
      );
      assert.equal(
        classifyNavigation(`https://${entry.host}${samplePath}`, NEW_WINDOW),
        "external",
        `expected ${entry.host}${samplePath} to be external for new_window`,
      );
    }
    assert.equal(
      classifyNavigation(`https://${entry.host}/not-an-auth-path`, FROM_APP),
      "external",
      `expected unlisted path on ${entry.host} to be external`,
    );
  }
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/authorize?provider=github", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/callback?code=123", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc", FROM_APP),
    "in_app",
  );
});

test("classifyNavigation keeps new_window to app origin only and sends external or sign-in links to system browser", () => {
  assert.equal(
    classifyNavigation("https://github.com/yulanventures/commonswarm/pull/1", NEW_WINDOW),
    "external",
  );
  assert.equal(
    classifyNavigation("https://docs.google.com/document/d/12345/edit", NEW_WINDOW),
    "external",
  );
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc", NEW_WINDOW),
    "external",
  );
});

test("classifyNavigation restricts sign-in hosts to explicit auth paths on navigate", () => {
  assert.equal(
    classifyNavigation("https://github.com/yulanventures/commonswarm/pull/1", FROM_APP),
    "external",
  );
  assert.equal(
    classifyNavigation("https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://github.com/session", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://github.com/sessions/two-factor/app", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://github.com/login/../yulanventures/commonswarm/pull/1", FROM_APP),
    "external",
  );
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/authorize?provider=github", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/functions/v1/command", FROM_APP),
    "external",
  );
  assert.equal(
    classifyNavigation("https://accounts.google.com/v3/signin/rejected", FROM_APP),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://accounts.google.com/ManageAccount", FROM_APP),
    "external",
  );
});

test("classifyNavigation requires app or sign-in currentUrl to enter a sign-in host", () => {
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc", {
      source: "navigate",
      currentUrl: "https://example.com/page",
    }),
    "external",
  );
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/authorize?provider=github", {
      source: "navigate",
      currentUrl: "https://example.com/page",
    }),
    "external",
  );
  assert.equal(
    classifyNavigation("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc", {
      source: "navigate",
      currentUrl: "",
    }),
    "external",
  );
  assert.equal(
    classifyNavigation("https://github.com/login", {
      source: "navigate",
    }),
    "external",
  );
});

test("classifyNavigation allows the full OAuth redirect chain at every step", () => {
  const steps = [
    "https://commonswarm.com/app",
    "https://api.commonswarm.com/auth/v1/authorize?provider=github",
    "https://github.com/login/oauth/authorize?client_id=abc",
    "https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize",
    "https://github.com/session",
    "https://github.com/sessions/two-factor/app",
    "https://api.commonswarm.com/auth/v1/callback?code=123",
    "https://commonswarm.com/app?code=123",
  ];
  for (let i = 1; i < steps.length; i++) {
    const currentUrl = steps[i - 1];
    const nextUrl = steps[i];
    assert.equal(
      classifyNavigation(nextUrl, { source: "navigate", currentUrl }),
      "in_app",
      `expected transition ${currentUrl} -> ${nextUrl} to be in_app`,
    );
  }
});

test("classifyNavigation treats look-alike hosts as external, never in_app", () => {
  assert.equal(classifyNavigation("https://commonswarm.com.evil.example/app", FROM_APP), "external");
  assert.equal(classifyNavigation("https://evilcommonswarm.com/app", FROM_APP), "external");
  assert.equal(classifyNavigation("https://sub.commonswarm.com/app", FROM_APP), "external");
  assert.equal(classifyNavigation("https://github.com.evil.example/login", FROM_APP), "external");
  assert.equal(classifyNavigation("https://evilgithub.com/login", FROM_APP), "external");
  assert.equal(classifyNavigation("https://accounts.google.com.evil.example/", FROM_APP), "external");
  assert.equal(classifyNavigation("https://accounts.google.com.evil.example/o/oauth2/v2/auth", FROM_APP), "external");
  assert.equal(classifyNavigation("https://commonswarm.com:8443/app", FROM_APP), "external");
  assert.equal(classifyNavigation("https://github.com:8443/login", FROM_APP), "external");
  assert.equal(classifyNavigation("https://github.com@evil.example/login", FROM_APP), "blocked");
});

test("classifyNavigation treats other https URLs as external", () => {
  assert.equal(classifyNavigation("https://example.com/docs", FROM_APP), "external");
  assert.equal(classifyNavigation("https://docs.github.com/en", FROM_APP), "external");
});

test("classifyNavigation blocks non-https, dangerous schemes, credentials, and malformed input", () => {
  assert.equal(classifyNavigation("http://commonswarm.com", FROM_APP), "blocked");
  assert.equal(classifyNavigation("http://commonswarm.com/app", FROM_APP), "blocked");
  assert.equal(classifyNavigation("http://api.commonswarm.com/auth/v1/authorize", FROM_APP), "blocked");
  assert.equal(classifyNavigation("http://example.com", FROM_APP), "blocked");
  assert.equal(classifyNavigation("http://localhost:4321/app", FROM_APP), "blocked");
  assert.equal(classifyNavigation("javascript:alert(1)", FROM_APP), "blocked");
  assert.equal(classifyNavigation("data:text/html,<script>alert(1)</script>", FROM_APP), "blocked");
  assert.equal(classifyNavigation("file:///etc/passwd", FROM_APP), "blocked");
  assert.equal(classifyNavigation("commonswarm://open", FROM_APP), "blocked");
  assert.equal(classifyNavigation("mailto:ops@commonswarm.com", FROM_APP), "blocked");
  assert.equal(classifyNavigation("https://user:pass@commonswarm.com/app", FROM_APP), "blocked");
  assert.equal(classifyNavigation("", FROM_APP), "blocked");
  assert.equal(classifyNavigation("   ", FROM_APP), "blocked");
  assert.equal(classifyNavigation("not a url", FROM_APP), "blocked");
  assert.equal(classifyNavigation("://missing-scheme", FROM_APP), "blocked");
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
  const devOrigin = getAllowedDevOrigin("http://localhost:4321/app", false);
  assert.equal(devOrigin, "http://localhost:4321");
  assert.equal(getAllowedDevOrigin("http://localhost:4321/app", true), null);
  assert.equal(getAllowedDevOrigin("https://commonswarm.com/app", false), null);

  assert.equal(
    classifyNavigation("http://localhost:4321/invite", { source: "navigate", allowedDevOrigin: devOrigin }),
    "in_app",
  );
  assert.equal(
    classifyNavigation("http://localhost:4321/invite", { source: "new_window", allowedDevOrigin: devOrigin }),
    "in_app",
  );
  assert.equal(
    classifyNavigation("http://localhost:9999/other", { source: "navigate", allowedDevOrigin: devOrigin }),
    "blocked",
  );
  assert.equal(
    classifyNavigation("http://commonswarm.com/app", { source: "navigate", allowedDevOrigin: devOrigin }),
    "blocked",
  );
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/authorize?provider=github", {
      source: "navigate",
      currentUrl: "http://localhost:4321/app",
      allowedDevOrigin: devOrigin,
    }),
    "in_app",
  );
});

test("isAppOriginUrl excludes third-party sign-in hosts and isAllowedExternalUrl enforces https", () => {
  assert.equal(isAppOriginUrl("https://commonswarm.com/app"), true);
  assert.equal(isAppOriginUrl("https://github.com/login"), false);
  assert.equal(isAppOriginUrl("https://accounts.google.com/o/oauth2/v2/auth"), false);
  assert.equal(isAppOriginUrl("https://api.commonswarm.com/auth/v1/authorize"), false);

  assert.equal(isAllowedExternalUrl("https://commonswarm.com/support"), true);
  assert.equal(isAllowedExternalUrl("https://example.com"), true);
  assert.equal(isAllowedExternalUrl("http://example.com"), false);
  assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("mailto:ops@commonswarm.com"), false);
  assert.equal(isAllowedExternalUrl("not a url"), false);
});
