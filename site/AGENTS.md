# AGENTS.md: CommonSwarm site

`../AGENTS.md` applies here too.

## Stack

Astro 7 static site, Node 22.12 or newer, hand-written CSS and vanilla browser JavaScript. No Tailwind, React or UI libraries.

- Tokens `src/styles/tokens.css`, base `src/styles/global.css`, primitives `src/styles/ui.css`, motion `src/styles/motion.css`
- Self-hosted fonts in `public/fonts/`

## Commands

From `site/`: `npm install`, `npm run dev`, `npm run build`, `npm test`, `npm run preview`.

CLI commands shown on the site must match the built CLI: `(cd .. && npm run build) && node ../dist/cli.js --help`.

## Product and deployment

Shared workspace for people and their agents; households first, then small teams (`../docs/product/VISION.md`). `/app` owns the live workspace and sign-up; `/start` is a compatibility handoff.

Production is static files at `/srv/commonswarm/site/current` on `yulan-vps-1`, behind Caddy and Cloudflare. Build and release: `deploy/site/RUNBOOK.md` and `../../infrastructure/commonswarm.md`. Never Vercel.

Local development may use an untracked `site/.env`. Production builds take explicit public JSON plus an H0 `0` or `1` builder argument:

- `PUBLIC_SUPABASE_URL=https://api.commonswarm.com`
- `PUBLIC_SUPABASE_ANON_KEY` has JWT role `anon`, never service-role.
- `PUBLIC_H0_LINK_JOIN` matches the builder argument; the receipt binds it.
