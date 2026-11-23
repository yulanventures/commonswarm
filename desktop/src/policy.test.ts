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

test("classifyNavigation allows the CommonSwarm app origin on any path", () => {
  assert.equal(classifyNavigation("https://commonswarm.com"), "in_app");
  assert.equal(classifyNavigation("https://commonswarm.com/app"), "in_app");
  assert.equal(classifyNavigation("https://commonswarm.com/invite?token=abc#section"), "in_app");
  assert.equal(classifyNavigation("https://commonswarm.com/support"), "in_app");
});

test("classifyNavigation allows every allow-listed sign-in host", () => {
  assert.ok(SIGN_IN_HOSTS.length >= 3);
  for (const entry of SIGN_IN_HOSTS) {
    assert.ok(entry.reason.length > 0, `missing reason for ${entry.host}`);
    assert.equal(classifyNavigation(`https://${entry.host}/auth`), "in_app");
  }
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/authorize?provider=github"),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/callback?code=123"),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc"),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc"),
    "in_app",
  );
});

test("classifyNavigation treats look-alike hosts as external, never in_app", () => {
  assert.equal(classifyNavigation("https://commonswarm.com.evil.example/app"), "external");
  assert.equal(classifyNavigation("https://evilcommonswarm.com/app"), "external");
  assert.equal(classifyNavigation("https://sub.commonswarm.com/app"), "external");
  assert.equal(classifyNavigation("https://github.com.evil.example/login"), "external");
  assert.equal(classifyNavigation("https://evilgithub.com/login"), "external");
  assert.equal(classifyNavigation("https://accounts.google.com.evil.example/"), "external");
  assert.equal(classifyNavigation("https://commonswarm.com:8443/app"), "external");
});

test("classifyNavigation treats other https URLs as external", () => {
  assert.equal(classifyNavigation("https://example.com/docs"), "external");
  assert.equal(classifyNavigation("https://docs.github.com/en"), "external");
});

test("classifyNavigation blocks non-https, dangerous schemes, credentials, and malformed input", () => {
  assert.equal(classifyNavigation("http://commonswarm.com"), "blocked");
  assert.equal(classifyNavigation("http://commonswarm.com/app"), "blocked");
  assert.equal(classifyNavigation("http://api.commonswarm.com/auth/v1/authorize"), "blocked");
  assert.equal(classifyNavigation("http://example.com"), "blocked");
  assert.equal(classifyNavigation("http://localhost:4321/app"), "blocked");
  assert.equal(classifyNavigation("javascript:alert(1)"), "blocked");
  assert.equal(classifyNavigation("data:text/html,<script>alert(1)</script>"), "blocked");
  assert.equal(classifyNavigation("file:///etc/passwd"), "blocked");
  assert.equal(classifyNavigation("commonswarm://open"), "blocked");
  assert.equal(classifyNavigation("mailto:ops@commonswarm.com"), "blocked");
  assert.equal(classifyNavigation("https://user:pass@commonswarm.com/app"), "blocked");
  assert.equal(classifyNavigation(""), "blocked");
  assert.equal(classifyNavigation("   "), "blocked");
  assert.equal(classifyNavigation("not a url"), "blocked");
  assert.equal(classifyNavigation("://missing-scheme"), "blocked");
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
    classifyNavigation("http://localhost:4321/invite", { allowedDevOrigin: devOrigin }),
    "in_app",
  );
  assert.equal(
    classifyNavigation("http://localhost:9999/other", { allowedDevOrigin: devOrigin }),
    "blocked",
  );
  assert.equal(
    classifyNavigation("http://commonswarm.com/app", { allowedDevOrigin: devOrigin }),
    "blocked",
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
