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

`/app` owns the live workspace and sign-up. `/start` is a compatibility handoff. Do not
restore copy that describes the site as a preview or invite-only.

Production is static files at `/srv/commonswarm/site/current` on `yulan-vps-1`, served by
Caddy at `commonswarm.com` behind Cloudflare. Releases use `deploy/site/deploy.sh` and are
performed only by Anvil under HezLead's direction. Other agents must never release the site. Never use
Vercel.

Site build variables live in untracked `site/.env`:

- `PUBLIC_SUPABASE_URL=https://api.commonswarm.com`
- `PUBLIC_SUPABASE_ANON_KEY` must be an anon JWT, never a service-role key.

Brain-link parsing uses `BRAIN_SLUG_SEPARATORS` from `src/lib/brain-links.ts`. Do not
retype that separator set.
