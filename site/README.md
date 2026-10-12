# CommonSwarm website

The website for CommonSwarm, a shared workspace for people and their agents at home and at work. The app lets people read and send messages.

This directory is **only the website**. The CLI and the server live in the repository
root (`../src`, `../supabase`).

---

## PUBLIC_H0_LINK_JOIN

Build-time flag for the Add an agent invite.

`src/lib/h0-link-join-flag.ts` is the only place that reads it. The value `1` shows
the invite: a signed-in person mints a join credential and copies the message from
`h0AgentPaste`. Any other value, including an unset variable, hides that invite. Add
an agent then matches the page without it.

Leave the flag unset on a site deploy until the h0 document route is deployed. A
deploy with the flag unset does not offer that document link.

---

## The split that shapes this site

- **Humans use the web UI.** There is exactly one write operation in the product —
  create a workspace and onboard agents into it. Everything else on the web is
  read-only visualisation: who is working on what, and what changed.
- **Agents use the CLI.** Everything else lives there.

Every CLI command printed on these pages is a real one, checked against
`node ../dist/cli.js --help`.

---

## Stack

Astro 7 (static output), hand-written CSS, vanilla JS for interactivity.

No Tailwind, no React, no UI library, no CSS framework. That is a fixed constraint,
not a current state.

- Design tokens — `src/styles/tokens.css`
- Reset and base — `src/styles/global.css`
- Primitives — `src/styles/ui.css`
- Motion and reveal contract — `src/styles/motion.css`
- Fonts — self-hosted in `public/fonts` (Inter + JetBrains Mono, latin and latin-ext
  subsets, `font-display: swap`)

The build emits **zero JavaScript bundles**. What interactivity exists is inline
`<script type="module">`, counted inside the HTML.

---

## Running it

Requires Node 22.12 or newer (`package.json` → `engines`).

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # static build into ./dist
npm run preview    # serve the built ./dist
```

Astro does not clean `dist/` between builds and stale files survive. When you are
verifying output, remove it first:

```sh
rm -rf dist && npm run build
```

---

## Routes

| Route        | What it is |
|--------------|------------|
| `/`          | Landing page. Positioning, an interactive demo that assembles a real `cswarm working-on` command as you type, the five-verb vocabulary, and the three-line setup. |
| `/app`       | Sign-up and the live workspace. Identity, messages, signals, and workspace data load from the configured API. |
| `/download`  | Install page. The one-line installer, a per-platform breakdown, what the script does step by step, and other ways in. |
| `/start`     | Compatibility handoff to `/app` for saved links and older sign-in returns. |

---

## What is REAL vs what is a STUB

The repository is public and the product is pre-launch. This section is the honest
boundary — please keep it accurate if you change the site.

### Real

- All four pages, all copy, all layout and responsive behaviour.
- Copy-to-clipboard buttons (`navigator.clipboard`, with an `execCommand` fallback).
- The landing demo builder — it composes a genuine `cswarm working-on …` invocation
  from what you type and shows what the rest of the project would see. It runs
  entirely in the browser.
- The `/app` sign-in, workspace creation, and live workspace views.
- The `/download` platform tabs.
- The `/start` handoff to `/app`, preserving the incoming query and fragment.
- The mobile navigation menu.
- Every CLI command shown anywhere on the site.

### Website traffic and former prototype

The `/app` workspace connects to our API and stores a sign-in session in the browser.
Cloudflare adds its Web Analytics script to our site pages to count page views and
measure load time. On each page view it records the page address without the query
string, the referring page, country, browser, operating system and device type, and load timing from
the browser's Performance API. The analytics script uses no cookies, local storage,
or other client-side state, and does not fingerprint individuals using their IP
address or User Agent. Cloudflare keeps detailed data for 7 days, then keeps
an aggregated sample. Marketing and legal pages use self-hosted fonts.

The items below describe the former static prototype.

- **"Request an invite"** (`/`) — validates the address, then states plainly:
  *"Nothing was sent."* There is no signup service to receive it.
- **"Continue with GitHub"** (`/start`) — there is no OAuth. The page discloses
  *"GitHub sign-in is not connected yet"* and offers to preview the rest of the flow.
- **Workspace creation** (`/start`) — the final step says *"No workspace was created.
  Self-serve signup is not live on the server yet."* No account is created and nothing
  typed leaves the browser.
- **`/app`** is not connected to any workspace. Every agent, signal and timestamp is
  invented, and a "Sample data" notice says so at the top of the page and on each panel.

Success messages must describe completed work. The prototype items above are history,
not the behavior of the current `/app` workspace.

### Current public origin and API configuration

- `astro.config.mjs` uses `https://commonswarm.com` for canonical URLs and OG tags.
- The public installer is `https://commonswarm.com/install.sh`.
- The browser API client reads `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`.
  A build without those values renders the site and reports the missing API configuration
  in `/app`; it does not load a sample workspace.

The former `coswarm.invalid` placeholder is no longer configured. `coswarm.dev` is an
unrelated product and must not be used as a CommonSwarm install or API target.

---

## The social card

`public/og.png` is generated, not hand-drawn, so that its wording can be reviewed like
any other copy:

```sh
node scripts/og-card.mjs public/og.png
```

The script renders deterministic 1200×630 SVG source through sharp. Pass a `.svg` output
path when a reviewer wants the vector source. Its header explains why the card's text must
track the `<h1>` in `src/components/landing/ConsumerHero.astro` and the `ogImageAlt` in
`src/layouts/Base.astro`; always inspect the generated PNG before shipping it.

---

## Motion and the never-invisible invariant

Sections on `/` fade in on scroll. The contract, documented in `src/styles/motion.css`:

- Elements rest in their **visible** state. Nothing is hidden unless JS opts in by
  setting `data-motion-js` on `<html>`.
- That attribute is not set at all when `prefers-reduced-motion: reduce` matches, or
  when `IntersectionObserver` is missing.
- A 2-second failsafe removes the attribute if the observer never gets wired up.

So a browser with broken or disabled JS gets the whole page visible. If you add a
`.js-reveal` element, do not break that path.

Note for reviewers: a full-page screenshot tool captures beyond the viewport without
triggering `IntersectionObserver`, so `/` will look mostly blank in one. Scroll the page
and re-check before reporting it as a bug.

---

## Verification notes

Things that have bitten this repo before:

- **Verify `dist/`, not the source you edited.** And `rm -rf dist` first.
- **Astro ships HTML comments verbatim.** Put notes in frontmatter `/* */`, not `<!-- -->`.
- **Run a positive control on the same invocation.** A grep that returns 0 because the
  file list was mangled looks exactly like a clean result. Prove the check can fail.
- **`../dist/cli.js` can be stale.** It is gitignored. Rebuild it before treating
  `--help` as ground truth, or you will "fail" a page that is actually correct.
- **Brace git revisions in zsh:** `git rev-parse "${r}:site/src/x.ts"`. Unbraced,
  `$r:src/x.ts` is parsed as a substitution modifier and silently returns the wrong
  object.

---

## Deploy

Run this from the repository root. The commands above this section run from `site/`. From `site/`, the same command is `../deploy/site/deploy.sh yulan-vps-1`.

```sh
deploy/site/deploy.sh yulan-vps-1
```

The script builds `site/` from a clean archive and publishes the files. It needs `site/.env`. See `deploy/site/RUNBOOK.md`.
