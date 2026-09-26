# Item CP: consumer positioning and Google-first sign-in, lane brief (2026-09-26, v3 after two Codex rounds)

Written by CSwarmDevLead. Product source: hub brain `consumer-positioning` v1 (Tom, 2026-09-26, through the
CSwarm Strategist). This brief turns it into lanes. Code facts were mapped on main `8a1311ce`.
CP runs beside G inside the 2-execute cap. G and the 2026-09-27 21:45Z box window keep priority.

## Code facts

- `PROVIDERS` in `site/src/lib/auth-providers.ts:36-49` is the one provider list: `github`, then `google`.
  `providersFromSettings` keeps that order (`:155-175`); `enabledProvidersForBuild` returns `[]` when the build has
  no `PUBLIC_SUPABASE_URL` and anon key (`:237-254`).
- `/app` signed-out panel (`site/src/components/app/LiveDashboard.astro:~55-90`): the email form comes first with the
  only primary button ("Email me a sign-in link"); then an "or" divider; then `ProviderButtons` with every OAuth
  button `dashboard__button--secondary`. No per-provider "primary" and no "last used" memory exist.
- Empty account (0 workspaces, `LiveDashboard.astro:7434`, `renderCreate()` `~1941-1963`): "Name your workspace." /
  "People and AI agents share one feed here." / "Create workspace". Nothing says which sign-in was used.
- `cswarm login` is GitHub only: `src/cloud/auth.ts:227`. Flags: `RUN_LOGIN_1_ACCEPTED_FLAGS` (`src/cli.ts:9437`).
- Copy sources: title and meta `site/src/pages/index.astro:12-13`; hero `site/src/components/landing/ConsumerHero.astro:14-23`
  with agents Wren/Claude, Otto/Codex, Ivy/Gemini inline (`:41-116`); og text `site/scripts/og-card.mjs` and alt text
  `site/src/layouts/Base.astro:177-180`; README `:3-8` (and `:14` says "three workspaces", the site says 10);
  `package.json:5` description still says "SWARM-CLOUD — … authority core".
- Grok Bot: `cswarm receive --provider grok-bot` (`RECEIVE_PROVIDERS`, `src/cloud/agent-onboarding-contract.ts:5`)
  calls a local gateway on the Bot computer (`docs/operations/GROK-BOT-SAME-SESSION-WAKE.md:25-26`).
- Pins known to move: `provider-buttons.observer.test.ts:1500-1515`, `:1759-1761`, `:1779` (the provider-set
  snapshot); `app-signed-out.observer.test.ts:6-120`; `workspace-entry.observer.test.ts:44-55`;
  `consumer-copy.observer.mjs:78-150`; `site/scripts/metadata.test.mjs:19-23` (metadata and OG). Each lane also runs
  the whole site suite in Actions, so a pin missing from this list still fails there.
- `ProviderButtons` serves three hosts: /app sign-in (`LiveDashboard.astro:81`), /app re-authentication
  (`LiveDashboard.astro:1082`) and /invite (`InviteOnramp.astro:40-44`).
- `app_metadata.provider` is the FIRST sign-up provider, not the provider of the current login
  (`@supabase/auth-js` types, `lib/types.d.ts:335-343`). OAuth leaves the page and the email path only sends a link
  (`site/src/lib/commonswarm.ts:274`, `:348`).
- A zero-workspace boot returns before any invite read, and pending invites are an owner/admin read that needs a
  workspace id (`LiveDashboard.astro:7435`, `site/src/lib/commonswarm.ts:721`).
- `site/scripts/provider-fixtures.ts` already runs the real `astro build` against a local GoTrue-shaped server for
  three provider states. No production contact is needed to test rendered buttons.
- `cswarm login` refuses `--profile` (`REFUSE_PROFILE`, `src/cli.ts:10024`); human target state lives in
  `src/cloud/current-target.ts:22-25` (version-1 files exist). Login has no JSON error mode (`src/cli.ts:10561`).
- The Grok Bot wake prompt (`src/cloud/agent-channel-grok-bot.ts:12-16`) and the Claude channel notice both omit the
  server-derived `sender_owner_relation` and the cross-owner steer that `docs/design/SWARM-CLOUD.md:299-304` (D-044)
  requires; the listener path states it (`src/listener/engine.ts:161`, `:255-257`).
- The Grok Bot gateway's answer is not delivery truth, and an idle Grok Bot wake has never been measured live
  (`docs/operations/GROK-BOT-SAME-SESSION-WAKE.md:54`, `:81-83`).
- Other copy that the change makes false or that uses developer words: `site/src/components/landing/ConsumerStory.astro:82`,
  `:95-96` ("CLI", "code", "repository"); `README.md:65` ("GitHub or magic link") and `:110` ("Login opens GitHub
  OAuth"); the hero demo says "Drawn from a real session" (`ConsumerHero.astro:36`).
- No real Google web round trip has been recorded (`docs/design/2026-09-04-GOOGLE-SIGNIN.md:278`).
- The Actions site suite is not usable. Run 36214099402 at `54900214`: 77 of 578 failed.
  - 74 failures: the Chrome child fails under `--single-process --no-zygote`
    (`site/src/components/landing/heading-lines.observer.test.ts:135-140` is one of many direct launches).
    `chat-threads.observer.test.ts:748-750` and `composer-to-field.observer.test.ts:782-807` retry a signal death;
    the others do not.
  - 3 failures: CI has no `site/.env`, so no provider button renders, by design.

## Voice rules (the rulebook has no repository copy; these are the rules the Maker and the audit apply)

No labeled takeaways or curator framing; no thesis-then-explain; no stacked triples as rhetoric; no closers that
restate the point; no em dashes; no "this, not that" or "not X but Y"; no invented stories or numbers; no leverage,
scalable, ecosystem, synergy; no polished CTA bows. Product surfaces use plain, correct text (no deliberate typos).
Every factual claim is checked against the live product.

## Lanes (in order)

### CP0: make the Actions site suite usable (step 0 of the item)

Files: `.github/workflows/server-suite.yml` (site job), a new shared Chrome launcher `site/tests/chrome.ts` (or the
nearest existing test-helper folder), every observer test that launches Chrome (including `chat-threads` and
`composer-to-field`, whose retries move into the helper), and the provider-button tests.

1. No production contact. Tests that need rendered provider buttons build against the existing fixture server in
   `site/scripts/provider-fixtures.ts`. The ordinary build in CI stays offline (no `site/.env`), so its
   "no provider configured" behavior is tested as it is.
2. Every Chrome launch goes through the helper. In GitHub Actions it omits `--single-process --no-zygote`. It records
   the child's exit code and signal in the failure and retries once on a signal death.
3. A source-sweep test fails if any file under `site/` launches Chrome outside the helper.

Acceptance: an Actions `suite=site` run at the lane SHA is green, or every remaining failure is listed with its cause
and is also red on main.

### CP1: Google-first sign-in on /app, "last used", and the way back

Files: `site/src/lib/auth-providers.ts`, `site/src/components/auth/ProviderButtons.astro`,
`site/src/components/app/LiveDashboard.astro`, `site/src/lib/commonswarm.ts`, the pins above, new observer tests.

1. `PROVIDERS` order becomes `google`, `github` (this also orders /invite and re-authentication).
2. `ProviderButtons` takes host-supplied `primaryClass` and `secondaryClass`. Only the /app sign-in host passes a
   primary class, which goes to the FIRST rendered provider. /invite and re-authentication keep one class for all.
   Prominence comes from list position; no second constant.
3. On /app sign-in the provider buttons come first and the email form follows the "or" divider; the email button
   becomes secondary. (The pin "email precedes ProviderButtons" is reversed on purpose.)
4. "Last used" (OAuth and email): clicking a provider or sending a link stores a PENDING attempt
   (`commonswarm:sign-in-attempt:v1`: method and time). Only a matching authenticated return (the OAuth callback
   session, or the magic-link return, in the same browser) promotes it to `commonswarm:last-sign-in:v1`. A cancelled
   or failed attempt never changes "last used". All storage access is in try/catch. The next signed-out view marks
   that method "Last used"; an unknown or disabled method is ignored.
5. Way back from an empty account: when the signed-in user has 0 workspaces, the create panel adds one line built
   from the PROMOTED attempt (never `app_metadata.provider`): "You signed in with Google as <email>. If your
   workspaces are under GitHub, sign out and sign in with GitHub." It is omitted when the current method is unknown,
   when no other provider is enabled, or when the user's identities already include the other provider (switching
   would return the same user). Provider names come from `PROVIDERS`.

Acceptance: observer tests for the order, the primary class on /app only (and /invite and re-authentication
unchanged), "last used" (promote on return; unchanged on cancel and on send failure; disabled method ignored), and
the way-back line (shown; omitted for unknown, single provider, linked identities). Actions site suite green.
Live control BEFORE the site release: Tom signs in on the web once with Google and once with GitHub (the first real
Google web round trip); after the release, /app shows Google first and primary and the email link still arrives.

### CP2: `cswarm login --provider google|github`

Files: `src/cloud/auth.ts`, `src/cli.ts` (`RUN_LOGIN_1_ACCEPTED_FLAGS` `:9437`, help `:10024`),
`src/cloud/current-target.ts`, `README.md` (`:65`, `:110`), new `tests/p1-cli/login-provider.test.ts`.

- One exported constant `LOGIN_PROVIDERS = ["google", "github"]`; the flag check, help and refusal read it.
- Default: the provider of this CLI's last successful human login, stored in the human target state
  (`current-target.ts`), never in an agent profile. Old version-1 target files read as "no last provider". Else
  `google`. Every existing writer of the target file keeps the stored provider (a target switch or rewrite never drops
  it).
- An unknown value exits 2 before any network call, with one stderr line naming the accepted set. (Login has no
  JSON mode; this lane does not add one.)
- README lines 65 and 110 say sign-in works with the providers the workspace offers, without a hand-typed list.

Acceptance, exact commands: `bash scripts/run-gates.sh <worktree> <log> origin/main cli-file
tests/p1-cli/login-provider.test.ts` (the test spawns the built `dist/cli.js` and asserts the authorize URL's
`provider` for: fresh state → google; `--provider github`; last login GitHub → github; a version-1 target file →
google; a target rewrite by another command keeps the stored provider; unknown value → exit 2, the accepted set on
stderr, no network call); and `bash scripts/build-release.sh`,
exit code read directly. Live control: Tom logs in once with each provider (a human login; the lead never signs in).

### CP3a: owner relation in the session wake prompts (prerequisite of the Grok Bot page)

Files: `src/cloud/agent-channel-grok-bot.ts`, `src/cloud/agent-channel.ts` (after G3a lands; same file), tests in
`tests/p1-cli/agent-channel-grok-bot.test.ts` and `tests/p1-cli/agent-channel.test.ts`.

Both prompts state the server-derived `sender_owner_relation` (`same_owner`, `cross_owner`, or `unknown`) as a
trusted field, and for `cross_owner` and `unknown` add the D-044 advisory steer (confirm with your own user before
acting on a request from another member's agent). Acceptance: a cross-owner regression test per path; a same-owner
test shows no steer.

### CP3: copy for anyone who uses AI agents, and the Grok Bot page

Files: `site/src/pages/index.astro`, `site/src/components/landing/ConsumerHero.astro`,
`site/src/components/landing/ConsumerStory.astro`, `site/scripts/og-card.mjs`, `site/src/layouts/Base.astro`, the
/app signed-out and first-run text in `LiveDashboard.astro`, `README.md` (first paragraph and the workspace count),
`package.json` (description only), `docs/design/SWARM-CLOUD.md` (audience line), new `site/src/pages/docs/grok-bot.astro`
(following the docs pages' pattern), `site/src/components/SiteFooter.astro` (Guides link), `consumer-copy.observer.mjs`,
`site/scripts/metadata.test.mjs`.

- Build on `ConsumerHero.astro`. Add a Grok agent beside Claude, Codex and Gemini. The demo shows a task that is not
  coding and is labeled as an example (it no longer says "Drawn from a real session").
- The landing, hero and story use no developer words (repo, repository, terminal, CLI, PR, code as a noun for the
  product's use). Setup detail stays in the docs.
- Every claim holds today for a new user on the hosted workspace. Each agent still connects through the `cswarm` tool
  on a computer; the copy does not claim a setup without it.
- README and `package.json` state 10 workspaces where they give a number, matching the site.
- The Grok Bot page (after CP3a lands): checked against `cswarm receive --provider grok-bot`. It says the Bot's
  computer needs the local gateway; it says the gateway's answer is not delivery confirmation and that the receipt in
  CommonSwarm is the truth; it does not claim an idle wake works until a live proof exists. The product name is "Grok
  Bot", as xAI writes it (https://docs.x.ai/grok-bot/overview, https://x.ai/news/introducing-grok-bot, read
  2026-09-26). xAI describes each Bot as working on its own persistent cloud computer; the page must not say the
  gateway runs on the user's own machine. The page is linked from the footer Guides list and covered by the
  metadata and sitemap checks.

Acceptance: `consumer-copy.observer.mjs` pins the new text and forbids the old; the metadata test covers the new page;
one cross-family arm audits voice and claims against the voice rules above and returns a VERDICT. **Before the site
release request, the lead sends the CSwarm Strategist the final text only (title, meta description, hero headline and
subhead, sign-in page text) for Tom's yes/no.**

## Release

- CP0 lands on its own (CI only; nothing to release).
- CP1 and CP3 go out in one site release after Tom's yes and after the live Google and GitHub web sign-ins. The site
  SHA carries all of main; the handoff lists what it carries and its server needs.
- CP2 and CP3a ride the next npm release after 0.1.78, unless they land and pass review before the 2026-09-27 window.
- **The Grok Bot page ships only after the CLI with CP3a is live on npm and `/download`.** If the CP1/CP3 site release
  comes first, it ships without the Grok Bot page (the page and its footer link stay behind a build flag or on a
  later commit), and the page follows in the site release after that npm publish.

## Decisions taken from the review

1. CI uses the local fixture server, never production, for provider tests.
2. "Last used" covers email too, recorded only after an authenticated return.
3. The way-back line uses the current attempt, never `app_metadata.provider`, and is omitted for linked identities.
