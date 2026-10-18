# AGENTS.md — CommonSwarm site

The root `../AGENTS.md` is canonical and applies to all work in this directory.

## Site stack

`site/` is the Astro 7 static site for CommonSwarm. It requires Node 22.12 or newer and
uses static output, hand-written CSS, and vanilla browser JavaScript. Do not add Tailwind,
React, or UI libraries.

- Design tokens: `src/styles/tokens.css`
- Base styles: `src/styles/global.css`
- UI primitives: `src/styles/ui.css`
- Motion: `src/styles/motion.css`
- Self-hosted fonts: `public/fonts/`

## Commands

Run site commands from `site/`:

```sh
npm install
npm run dev
npm run build
npm test
npm run preview
```

Before using background development commands, verify support in `package.json`. When the
repository supports them, use `astro dev --background`, `astro dev status`,
`astro dev logs`, and `astro dev stop` through the repository's Astro script.

Commands displayed on the site must match the current built CLI. Rebuild the root CLI
before treating `../dist/cli.js --help` as evidence:

```sh
(cd .. && npm run build)
node ../dist/cli.js --help
```

## Product and deployment

The product vision is a shared workspace for people and their agents: an agent-first
Basecamp blended with Skylight for the household. Households come first, then small
teams and small businesses. See `../docs/product/VISION.md` for vision and audience.

`/app` owns the live workspace and sign-up. `/start` is a compatibility handoff. Do not
restore copy that describes the site as a preview or invite-only.

Production is static files at `/srv/commonswarm/site/current` on `yulan-vps-1`, served by
Caddy at `commonswarm.com` behind Cloudflare. Releases build the exact reviewed SHA
off production using `deploy/site/build-artifact.sh`, then `deploy/site/deploy.sh`
prepares and stages a pinned static packet. Only Anvil under HezLead's direction
executes it under the continuously held Mac release lock; see `deploy/site/RUNBOOK.md`.
Other agents must never release the site. Never use Vercel.

Local development may use untracked `site/.env`. Production builds use only
explicit allowlisted public JSON and a required H0 `0` or `1` builder argument.
Preserve the current value approved by HezLead; never inherit it silently.
Production public configuration:

- `PUBLIC_SUPABASE_URL=https://api.commonswarm.com`
- `PUBLIC_SUPABASE_ANON_KEY` must have JWT role `anon`, never a service-role key.
- `PUBLIC_H0_LINK_JOIN` must match the explicit builder argument; the receipt binds it.

Brain-link parsing uses `BRAIN_SLUG_SEPARATORS` from `src/lib/brain-links.ts`. Do not
retype that separator set.
