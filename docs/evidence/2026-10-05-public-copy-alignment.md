# Public copy alignment: worker report, 5 October 2026

Worktree: `/Users/yulanbot/work/wt/public-copy`. Branch: `lane/public-copy`.
Starting HEAD: `7ab5e983`. The worktree was clean before this assignment.

Applied **44 of 44 wording-change rows**. Rows **39 and 46 remain unchanged**.
No row was skipped. This is a local copy and verification report. Nothing was
committed, pushed, published or deployed. No network, Docker or browser was used.
HezLead arranges the independent review.

## Files changed

There are 45 changed files from the assignment, plus this report (46 files total).
The proposal rows affect 39 files. The additional files are the marketing brief,
the regenerated OG PNG and four test/observer files.

- `README.md`
- `dist-npm/README.md`
- `dist-npm/package.json`
- `distribution/chatgpt-apps/plugin.json`
- `docs/evidence/2026-10-03-reviewer-packet/REVIEWER-PACKET.md`
- `docs/evidence/2026-10-03-submissions/chatgpt-apps/LISTING.md`
- `docs/evidence/2026-10-03-submissions/chatgpt-apps/PORTAL-FIELDS.md`
- `docs/evidence/2026-10-03-submissions/claude-connector-directory/LISTING.md`
- `docs/evidence/2026-10-03-submissions/claude-connector-directory/PORTAL-FIELDS.md`
- `docs/integrations/registry/README.md`
- `docs/marketing/SITE-BRIEF.md`
- `npm/README.md`
- `npm/package.template.json`
- `package.json`
- `server.json`
- `site/README.md`
- `site/public/api.md`
- `site/public/llms.txt`
- `site/public/og.png`
- `site/public/skills/cswarm/SKILL.md`
- `site/scripts/metadata.test.mjs`
- `site/scripts/og-card.mjs`
- `site/scripts/seo-pages.test.mjs`
- `site/src/components/download/InstallPanel.astro`
- `site/src/components/landing/ConsumerHero.astro`
- `site/src/components/landing/ConsumerStory.astro`
- `site/src/components/landing/consumer-copy.observer.mjs`
- `site/src/components/landing/heading-lines.observer.test.ts`
- `site/src/components/seo/AboutCommonSwarm.astro`
- `site/src/layouts/Base.astro`
- `site/src/pages/acceptable-use.astro`
- `site/src/pages/alternatives/crewai.astro`
- `site/src/pages/alternatives/langgraph.astro`
- `site/src/pages/app.astro`
- `site/src/pages/download.astro`
- `site/src/pages/guides/claude-code-subagents.astro`
- `site/src/pages/guides/claude-connector.astro`
- `site/src/pages/guides/grok-bot.astro`
- `site/src/pages/index.astro`
- `site/src/pages/invite.astro`
- `site/src/pages/orchestration.astro`
- `site/src/pages/privacy.astro`
- `site/src/pages/start.astro`
- `site/src/pages/support.astro`
- `site/src/pages/terms.astro`
- `docs/evidence/2026-10-05-public-copy-alignment.md` (this report)

## Adjusted rows and implementation details

| Rows | Adjustment and reason |
|---|---|
| 14 | Put the three proposed setup sentences into the existing three cards. The second title is now “Connect your agents”. Kept the section and card structure. |
| 15 | The recorded current text was only a closing `</div>`. Located the existing setup limitation by content. Replaced it with “Choose the connection guide for your agent. Some agents connect through an app. Others need cswarm on a supported computer.” The last sentence avoids the existing forbidden “CLI” homepage string without changing or removing that assertion. |
| 17 | Kept the proposed words. Used three headline lines and a smaller font so the longer headline fits the existing 1200×630 card. Redrew `site/public/og.png` with sharp and inspected it. No browser was used. |
| 18 | Added the measured visible footer to the proposed alt: `The footer says "Free · 10 workspaces · no card".` The image still shows that footer. |
| 20 | Used “The hosted workspace runs no agents and defines no control flow. Your connected agent checks and replies to messages.” This removes the false listener-launch claim and retains the existing scoped runtime claim pinned by SEO tests. |
| 29 | Used “The hosted workspace runs no agents and does not choose their tasks.” This preserves the proposed meaning and the existing guard against absolute execution claims. |
| 36, 38, 40, 42, 44 | Preserved disclosures omitted by the proposed shorter introduction: inbox batches, acknowledgement advancing delivery, seat names not isolating chats, the eight-tool catalog, and no task claiming or closing. Plugin description, plugin longDescription, both listing long descriptions and reviewer-packet description match at 631 characters. |
| 40, 42 | Recalculated the displayed counts: short 26, one-liner 98, long 631. |
| 41, 43 | Updated the actual table cells rather than inserting a prose paragraph. Updated both one-liner and long-description references where present. ChatGPT root description and interface mapping use 631; Claude one-liner uses 98 and long description uses 631. Kept portal eligibility, proof and submission requirements. |
| 45 | Retained “Schema limit: 100 characters.” after the proposed description explanation, preserving the registry contract. The actual `server.json` description is exactly 100 characters. |

The source paragraphs were found by content rather than old line numbers.
The npm README source and tracked generated README are byte-identical. The npm
package template and tracked generated package have identical descriptions.
`dist-npm/cswarm.cjs` was not edited. No npm build or publish script was used to
update these generated copies.

`docs/marketing/SITE-BRIEF.md` keeps its section order, tables and onboarding/
honesty structure. It now leads with households, then small teams and small
businesses. It sets consumer-first wording, Google sign-in first when enabled,
the free-plan direction, agents as members and no kids' reward layer. It removes
obsolete terminal-only and deployment instructions. Roadmap household objects,
calendar, Today and display features are explicitly unavailable. Universal host
acceptance and full account delegation are not claimed as shipped.

## Tests updated: final pinned strings

All assertions and checks remain. No assertion was weakened or removed.
Only expectations for replaced copy and the setup qualifier's comment changed.

| File | New pinned strings |
|---|---|
| `site/scripts/metadata.test.mjs` | `CommonSwarm: A shared workspace for home, work and your agents`; `Share messages, files and notes with the people and agents you use at home and at work.`; `Your people. Your agents. One shared workspace.`; `Share messages, files and notes about home and work.` |
| `site/scripts/seo-pages.test.mjs` | `Claude Code subagents: A practical guide`; `Learn how Claude Code subagents work and how to share updates with people and agents in a CommonSwarm workspace.`; `Connect Grok Bot to a shared workspace for home or work. Follow the setup guide for its computer.`; `Connect Claude to your CommonSwarm workspace`; `Let Claude share messages with people and agents in a workspace you approve, at home or at work.` |
| `site/src/components/landing/consumer-copy.observer.mjs` | `Your people. Your agents. One shared workspace.`; `Share messages, files and notes`; `about home and work.`; `Choose the connection guide for your agent. Some agents connect through an app. Others need cswarm on a supported computer.`; `Connect your agents`; `Choose how to connect each agent.` |
| `site/src/components/landing/heading-lines.observer.test.ts` | `Your people. Your agents. One shared workspace.` The same heading line-limit assertion remains. |

Searched replaced copy in `site/tests`, `site/src/lib/*.test.mjs`, `tests/`,
site script tests and component observers. A further fixed-string search covered
45 distinct replaced literals. Remaining matches were generic fragments,
listener command tests and the synthetic “Opening CommonSwarm…” typography case.
They do not pin replaced public copy and were retained. No root test needed an
expected-string edit.

Checked claims against local source: workspace creation and messages in
`site/src/lib/commonswarm.ts`; file create/commit/list in `src/cloud/files.ts`;
the hosted catalog in `supabase/functions/mcp/tools.ts`; target resolution in
`src/cli.ts`; sign-in order and provider handling in `site/src/lib/auth-providers.ts`;
and hosted delivery semantics in `src/protocol/hosted-check.ts`.
This source review does not prove fresh vendor acceptance or production parity.

## Verification run and exit codes

Created `T` with `mktemp -d /private/tmp/lane-home.XXXXXX`. All test invocations
used `env HOME="$T"`. Site tests used `node --test <file>` from `site/`. Root tests
used `node --import tsx --test <file>`. Only the listed files were run.

| Test file | Final exit | Result |
|---|---|---|
| `site/scripts/metadata.test.mjs` | 0 | 2 tests passed. |
| `site/scripts/seo-pages.test.mjs` | 0 | 7 tests passed. |
| `site/scripts/download-version.test.mjs` | 0 | 6 tests passed. |
| `site/src/components/landing/consumer-copy.observer.mjs` | 0 | Observer passed, reported as 1 node test. |
| `tests/rebrand-active-refs.test.ts` | 0 | 5 tests passed. |
| `tests/file-size-limit-agreement.test.ts` | 0 | 45 tests passed. |
| `tests/chatgpt-package.test.mjs` | 0 | 4 tests passed, including schema rejection controls and reproducible local ZIP. Initial invocation exited 1 because temporary HOME hid the already installed Python `jsonschema`. Reran with `PYTHONPATH=/Users/yulanbot/Library/Python/3.9/lib/python/site-packages` supplied alongside temporary HOME. Nothing was installed. |

The offline site build exited **0**. Invoked the locally available Astro executable
with `--root site`, `ASTRO_TELEMETRY_DISABLED=1`, empty `PUBLIC_SUPABASE_URL` and
empty `PUBLIC_SUPABASE_ANON_KEY`. It built 17 pages without backend requests.
Used copies of installed dependencies inside this worktree, without npm install.
A repeated build measured the command's exit code explicitly.

`site/src/components/landing/heading-lines.observer.test.ts` was **not run**:
it launches a browser, which the task forbids. Its expected headline was updated.
The full registry schema validation was not rerun because its recorded command
fetches a schema over the network. The dated validation receipt remains unchanged.

`git diff --check` passed, exit **0**. Newly added public lines contain no em dash
or internal product-comparison names. The CLI bundle and both retain-unchanged
files have no diff. Temporary test HOME cleanup succeeded, exit **0**.

## Field-length results

| Field | Measured length | Limit | Result |
|---|---:|---:|---|
| `server.json` description | 100 | 100 | PASS |
| Plugin root description | 631 | 4000 | PASS |
| Plugin interface shortDescription | 26 | 30 | PASS |
| Plugin interface longDescription | 631 | 4000 | PASS |
| Both directory listing short descriptions | 26 each | 30 | PASS |
| Both directory listing one-liners | 98 each | 200 | PASS |
| Both directory listing long descriptions | 631 each | 2000 | PASS |
| Subagents guide title / description | 40 / 112 | 60 / 155 | PASS |
| Claude connector guide title / description | 44 / 96 | 60 / 155 | PASS |
| Grok Bot guide title / description | 31 / 97 | 60 / 155 | PASS |

Counts are of the actual strings after resolving and reading the local files.
Stored listing counts were reconciled with those strings. Actual portal limits,
field acceptance and publication state remain unverified.

OG PNG: **1200×630**, **229,137 bytes**. SHA-256:
`c8e0e7e83a19979ee6eb52caa151d28e214929691d32b14df257cc9f2777f5c6`.
The inspected pixels contain the approved headline, mechanism, button and footer.

## Resolved refusals and local artifacts

BLOCKED by filesystem: "EPERM: operation not permitted, unlink '/Users/yulanbot/work/wt/public-copy/site/node_modules/.vite/deps/_metadata.json'". To resolve: use dependency copies inside this worktree. Resolved; the final offline build passed.

BLOCKED by command review: "rm -f style commands are not permitted. Use a safer approach". To resolve: validate the owned directory and use guarded rm without force. Resolved; four refusal controls and the owned-path positive control passed, then `rm -r /private/tmp/lane-home.gjqnmq` exited 0. That directory no longer exists.

Ignored local verification artifacts remain in `scratchpad/public-copy/`,
`node_modules/`, `site/node_modules/`, `site/.astro/` and `site/dist/` where created.
No temporary credential files were created. The root and site dependency symlinks
from the initial build attempt were removed; installed dependency sources were
not edited. HezLead can review this diff and arrange the independent check.
