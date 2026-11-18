/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { AUTH_ENTRY_COPY, CREATE_ACCOUNT_HREF, SIGN_IN_HREF, authEntryFromSearch } from "./auth-entry.ts";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("only the signup address opens the create-account screen", () => {
  assert.equal(authEntryFromSearch(""), "sign-in");
  assert.equal(authEntryFromSearch("?w=4ee87734&v=todos"), "sign-in");
  assert.equal(authEntryFromSearch("?signup"), "create");
  assert.equal(authEntryFromSearch("?signup=1&next=audit"), "create");
  assert.equal(authEntryFromSearch(new URL(CREATE_ACCOUNT_HREF, "https://commonswarm.com").search), "create");
  assert.equal(authEntryFromSearch(new URL(SIGN_IN_HREF, "https://commonswarm.com").search), "sign-in");
});

test("each screen names itself and links to the other", () => {
  assert.equal(AUTH_ENTRY_COPY["sign-in"].title, "Sign in");
  assert.equal(AUTH_ENTRY_COPY.create.title, "Create an account");
  assert.equal(authEntryFromSearch(new URL(AUTH_ENTRY_COPY["sign-in"].otherHref, "https://x").search), "create");
  assert.equal(authEntryFromSearch(new URL(AUTH_ENTRY_COPY.create.otherHref, "https://x").search), "sign-in");
});

test("Sign up and Start a workspace lead to the create-account screen; Log in does not", async () => {
  const header = await source("../components/SiteHeader.astro");
  const footer = await source("../components/SiteFooter.astro");
  const hero = await source("../components/landing/ConsumerHero.astro");
  const story = await source("../components/landing/ConsumerStory.astro");
  const about = await source("../components/seo/AboutCommonSwarm.astro");
  assert.match(header, /\{ href: CREATE_ACCOUNT_HREF, label: "Sign up" \}/u);
  assert.match(footer, /\{ href: CREATE_ACCOUNT_HREF, label: "Sign up" \}/u);
  assert.match(footer, /\{ href: "\/app", label: "Log in" \}/u);
  assert.match(hero, /href=\{CREATE_ACCOUNT_HREF\}>Start a workspace</u);
  assert.match(story, /href=\{CREATE_ACCOUNT_HREF\}>Start a workspace</u);
  assert.match(story, /href="\/app">Log in</u);
  assert.match(about, /href=\{CREATE_ACCOUNT_HREF\}>Sign up</u);
  for (const page of [header, footer, hero, story, about]) assert.doesNotMatch(page, /href="\/app"[^>]*>\s*(?:Sign up|Start a workspace)/u);
});

test("the create-account screen takes the password away and keeps the form submittable", async () => {
  const dashboard = await source("../components/app/LiveDashboard.astro");
  /* The password field, its label and the password button all leave together. */
  assert.equal(dashboard.match(/data-signin-only/gu)?.length >= 3, true);
  assert.match(dashboard, /<label for="dashboard-password" data-signin-only>/u);
  assert.match(dashboard, /id="dashboard-password"[\s\S]{0,200}data-signin-only/u);
  assert.match(dashboard, /data-password-signin data-signin-only/u);
  /* A hidden required field would block Enter; a disabled one is skipped by validation and by password managers. */
  assert.match(dashboard, /password\.disabled = entry === "create"/u);
  /* Enter on the create screen sends the link, never a password sign-in. */
  assert.match(dashboard, /if \(authEntry === "create"\) \{ one<HTMLButtonElement>\("\[data-email-link\]"\)\?\.click\(\); return; \}/u);
});
