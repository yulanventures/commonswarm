# ACCOUNT-ITEMS evidence, rounds B–D — 2026-10-07

Worktree: `/private/tmp/cs-consent-items`. Branch: `lane/consent-account-items`. HEAD remains `24b08c5a`. Existing uncommitted ACCOUNT-ITEMS work was the base; nothing was committed, pushed, landed, applied, or released. No Alloy, worker delegation, Docker, browser, workflow dispatch, production operation, or HOME assignment. HezLead owns the independent cross-family check.

## Round B changes (file:line)

- `services/mcp-auth/src/interaction-page.js:253`: provider choices are plain same-origin links to GET `/interaction/<uid>/sign-in?provider=<id>`. They use the existing consent stylesheet and contain no forms or scripts. Account-picker hints are escaped into the link query.
- `services/mcp-auth/src/interactions.js:304`: an explicit sign-in route without a provider always renders the chooser, including a single-provider configuration. An initial single-provider view retains its direct sign-in redirect. `:353` keeps switch-account as an Origin- and CSRF-checked POST; its 303 targets only the same-origin chooser with `select_account=1`. `services/mcp-auth/src/admin-interactions.js:42` uses the same link chooser for admin reauthentication.
- `services/mcp-auth/src/interaction-store.js:135`: sign-in stores `hashOpaque(provider + ":" + state)` in the existing `signin_state_hash`; `:156` compares the callback provider/state together before token exchange. No provider column is needed. `:325` retains the transactional CSRF/session/user checks, old-session invalidation, fresh anonymous session, and same-interaction reset, using only existing schema columns.
- `services/mcp-auth/src/interactions.js:84`: account-chip provider comes from a matching account's known `amr` value, preferring `lastSubmission.login` and then the OIDC session. Round C supplies that value at the hosted MCP callback: after provider/state verification and successful user attachment, `interactions.js:215` persists `{ accountId, amr: [selectedProvider] }` in the existing OIDC interaction's `lastSubmission.login`. `oidcLogin()` carries it into the login result, and oidc-provider 9.12.2 carries it into the consent interaction. Missing, unknown, or different-user OIDC information omits the provider label. `services/mcp-auth/src/gotrue.js:77` keeps only confirmed email from the existing `/auth/v1/user` read during exchange. The existing 3600-second browser session holds that email; there is no live `auth.users` SQL read.
- Deleted `supabase/migrations/20261007000001_oauth_account_choices.sql`, including the SECURITY DEFINER function. Removed all runtime references to `browser_identity`, `signin_provider`, `user_provider`, and a stored `select_account`. The latter is now only a harmless URL hint; GoTrue sends `prompt=select_account` only for Google (`gotrue.js:53`). Reverted `site/src/lib/auth-providers.ts` to HEAD because the cross-package import is no longer needed. The site has no diff.
- `services/mcp-auth/src/interaction-page.js:344`: hides the switch form whenever selection is locked, including view/validation renders. `services/mcp-auth/src/interactions.js:531` omits it on a partially completed consent retry. `services/mcp-auth/src/server.js:117` renders a readable 409 binding-mismatch page for browser POSTs, while explicit JSON clients retain JSON errors.
- Preserved the different-user refusal (`interactions.js:279`, `interaction-store.js:180`), startup provider/settings check (`gotrue.js:30`, `server.js:183`), config parsing (`config.js:48`), and the consent page's exact labels and independent two-form contract.
- `services/mcp-auth/test/account-items.test.js:134`: enumerates both consent forms, checks each action's origin, submits both, follows every returned 3xx in the account-switch chain, and requires same-origin HTML before provider link navigation. Covers Google only, GitHub only, and both. Pins the complete chooser CSP and the existing consent CSP (including its pre-existing client redirect origin). Clicking each provider link then verifies provider binding and Google-only account selection.
- `services/mcp-auth/test/account-items.test.js:234`: exercises begin/consume provider-state binding through the production store. `:225` rejects a callback provider swap before exchange. `services/mcp-auth/test/consent-page-structure.test.js:248` checks that locked pages have one form and no switch button. `services/mcp-auth/test/returning-browser.test.js:237` checks readable POST 409 handling with real provider interaction validation. Existing SQL fixtures were adjusted to use the provider-bound digest, with no removed contracts.

## Round C and D changes (file:line)

- Round C: `services/mcp-auth/src/interactions.js:215` writes the provider label on the server for hosted MCP sign-ins only, into the existing provider artifact. There is no new schema column or migration. `services/mcp-auth/test/account-items.test.js:185` exercises the callback with the pinned OIDC interaction model rather than a pre-seeded provider label. The round C checker confirmed that removing the callback write makes this test fail.
- Round C: `services/mcp-auth/src/config.js:49` treats an empty legacy `MCP_OAUTH_GOTRUE_PROVIDER=` as unset when a provider list is supplied. An empty legacy value alone still fails the required-setting check. A whitespace-only legacy value still counts as set.
- Round C: `services/mcp-auth/test-postgres/oauth-mcp-contract.test.js:163` adds the synthetic GoTrue `/settings` response used by the production startup check. `:72` selects the form whose action ends in `/consent` and reads fields only inside that form, preserving the independent switch-account form. This also covers validation and locked retry/reload pages.
- Round D: `services/mcp-auth/test-postgres/oauth-mcp-contract.test.js:365` replaces the stale other-account POST expectations with 409, `text/html`, and the heading “You signed in as a different account; start again”. Every other assertion is retained. The existing guard (`interactions.js:279`) precedes POST authentication/CSRF checks; the stored interaction retains its original owner, so switching the browser session's user reaches this HTML refusal.
- Round D: the complete PostgreSQL contract test was reread against the lane changes. Its configured single GitHub provider still takes the initial direct sign-in path; the callback includes the provider and checks the bound digest before exchange. The earlier same-account Origin/CSRF/session probes retain their paths. Restoring the original account after the refusal allows validation and interrupted-consent retries to retain their contracts. Additional `amr` token claims do not change the subject/signature assertions. No further lane-related assertion change was identified by source tracing; this is not an integration pass.

## Test tails

The following round B results are historical, not a fresh round D run.

Node 24.20.0 LTS was selected through PATH for the task's exact commands. No HOME changes.

`npm --prefix services/mcp-auth test` — exit 0; `/private/tmp/cs-account-b-service.log`:

```text
ℹ tests 453
ℹ suites 0
ℹ pass 453
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`node --test services/mcp-auth/test/consent-page-structure.test.js` — exit 0; `/private/tmp/cs-account-b-structure.log`:

```text
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The new redirect regression failed before the production repair with `https://api.commonswarm.com` instead of `https://mcp.commonswarm.com`, at the intended form-redirect assertion (`/private/tmp/cs-account-b-baseline.log`). After the repair, the focused account/structure/returning-browser/version files passed 36/36 (`/private/tmp/cs-account-b-focused.log`). Round B's `git diff --check` passed. At the end of round B, the diff versus HEAD was production/config +310/-103 lines and tests/fixtures +340/-9 lines, excluding evidence. `browser-security.js` is unchanged; no CSP origin was added.

Round C independent-checker report (`/Users/yulanbot/work/c1-next/CHECK-ACCOUNT-ITEMS-C-REPLY.txt`): 10 focused test files passed 235/235 on Node 26.7.0; the contract file passed `node --check`. The checker did not run `test-postgres/` because it needs Docker. Its 409 HTML result was a real-handler probe, not a PostgreSQL contract-suite pass.

Round D worker, Node 26.7.0:

- `node --check services/mcp-auth/test-postgres/oauth-mcp-contract.test.js` — exit 0, no output.
- `npm --prefix services/mcp-auth test` — exit 0; `/private/tmp/cs-account-d-service.log` tail:

```text
ℹ tests 453
ℹ suites 0
ℹ pass 453
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1759.894458
```

Round D changes only this evidence document and the three other-account response assertions in the existing PostgreSQL contract test (+3/-2 test lines, zero production lines). All earlier uncommitted work is retained. `git diff --check` passes. No Docker or browser was run; HezLead still owns the independent check and integration gate.

## Supabase status and limitations

`git diff HEAD -- supabase/` is empty, and the new migration file no longer exists. All runtime migration dependencies are gone; the resulting source change needs only the OAuth image release, with no schema application or site release.

Round B encountered a sandbox refusal while clearing a pre-existing migration intent-to-add index entry. That is historical: the round C checker and round D worker both observed empty `git status --short supabase/ site/` output. There is no remaining migration or site diff in this worktree.

Browser and PostgreSQL integration were not run, as instructed. Handler/store tests prove server redirects, state binding, and query guards; they do not execute Chrome CSP or SQL against PostgreSQL. The real oidc-provider account-switch completion and its session-end/logout step remain untested end to end. Only the account-authentication redirect chain is asserted same-origin; the existing successful OAuth client-return behavior is unchanged.

Confirmed email can remain stale for up to the existing one-hour session after an explicit GoTrue email change. Provider labels are omitted when matching OIDC `amr` is unavailable; the callback now persists the label in the existing provider artifact, with no new database field. The callback lookup/persist can fail after user attachment and before session rotation; the round C checker recorded this as a low-risk limitation. Provider `amr` also enters ID and refresh tokens, and an admin label may reflect an earlier sign-in by the same user. Old in-flight sign-ins using the former unbound digest must restart. Google receives its account picker; no equivalent GitHub picker or provider logout is claimed.

## Item 1: offline GoTrue findings

Source root: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/92a046b9-c9b9-436a-8043-54e019698ffd/scratchpad/auth-src`. `git describe --tags --always` reports `v2.197.0`; exact HEAD `4eee58f296d9698a1c2c0ae14d7a0b379c7622d3`. This matches `deploy/supabase-stack/compose.yaml:73`.

1. A provider's changed verified email does **not** automatically replace `auth.users.email` for an existing identity on normal OAuth sign-in. `internal/models/linking.go:79` finds the identity by provider subject; `:89` explicitly retains the existing user's email in the linking decision. `internal/api/external.go:383` updates that identity's data/last-sign-in and user metadata/provider metadata, without writing the account email. A newer provider email may therefore appear in identity/user metadata while GoTrue's account email remains unchanged. This lane changes no GoTrue linking/email policy.
2. A new provider identity with the same verified email normally **does** link to the existing user in the same linking domain. `internal/models/linking.go:66` gathers verified emails (or emails treated as confirmed by Mailer.Autoconfirm), `:77` selects the domain, `:149` links a matching ordinary user, and `:200` onward links matching identities that share one user. `internal/api/external.go:319` creates the linked identity. Conflicting users refuse instead of arbitrarily choosing one.
3. The automatic-linking grouping setting is `GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS`, explicitly documented at `internal/conf/configuration.go:396`. `internal/models/linking.go:20` applies that grouping and `:36` returns the shared default domain for ordinary providers. The deprecated `ProvidersWithOwnLinkingDomain` list is backfilled at `configuration.go:1169`. `GOTRUE_SECURITY_MANUAL_LINKING_ENABLED` (`configuration.go:907`, default false) controls explicit manual linking, not this automatic sign-in decision. No on/off automatic-linking flag occurs in this decision path.
4. The existing swarm email refresh remains `supabase/functions/command/index.ts:3077`, particularly the coalesce at `:3085`. Consent displays the confirmed GoTrue account email captured from `/auth/v1/user` at sign-in, within the existing one-hour session. It does not substitute an email from provider metadata and no longer introduces a live SQL identity read.

## Google account selection evidence

GoTrue `internal/api/external.go:72` removes controlled query parameters; `:84` passes remaining parameters as OAuth AuthURL options; `:134` builds the provider authorize URL. `internal/api/custom_oauth_admin.go:654` lists reserved parameters and does not include prompt. Google embeds oauth2.Config at `internal/api/provider/google.go:33`. Thus v2.197.0 passes prompt through. The new unit test also asserts `prompt=select_account` on switched Google requests and its absence on ordinary sign-in.
