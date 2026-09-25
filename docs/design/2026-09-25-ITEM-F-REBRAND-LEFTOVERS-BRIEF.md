# Item F brief: rebrand leftovers (2026-09-25)

Written by CSwarmDevLead. Source: brain `app-backlog` item F and brain `rebrand-yulan-ventures` (the operator's
dossier extract, 2026-09-14). Base: origin/main d437c291. Client, site and package metadata only. No server change.

## What is true today (mapped read-only)

- `install.sh:27` defaults `REPO="${CSWARM_REPO:-Ridge-io/commonswarm}"`.
- `dist-npm/package.json:18` has `repository.url` `git+https://github.com/Ridge-io/commonswarm.git`; `dist-npm/README.md:32`
  links `https://github.com/Ridge-io/commonswarm`.
- Rendered site links: `site/src/components/SiteFooter.astro:81` (`REPO`, the GitHub and license links on every page),
  `site/src/components/download/OtherWays.astro:77` (`SOURCE_REPO` on /download),
  `site/src/components/seo/AboutCommonSwarm.astro:15`.
- The old product name in repo-visible text: `README.md:342` ("the name `coswarm`"), `site/README.md:1,3,81,97`
  (title and two example commands `coswarm working-on`).
- The shipped bundle `dist-npm/cswarm.cjs` carries the builder's absolute home path in esbuild module comments
  (410 lines match `Ridge.io`, for example `// ../../../../../../../Users/<builder>/Developer/Ridge.io/cloud-swarm/node_modules/zod/...`).
- The live remote is `yulanventures/commonswarm`.

## Decisions

1. Every ACTIVE reference uses `yulanventures/commonswarm`: installer default, npm `repository`, npm README, the three
   rendered site links, workflows and scripts that build a URL or call `gh`. Build each site URL from ONE exported
   constant (the site already has release.ts-style modules; reuse or add one), not three literals.
2. User-facing copy says Yulan Ventures where it names the organization. The product name is CommonSwarm and the
   command is `cswarm` (fix `site/README.md` and `README.md:342`).
3. The release bundle carries no absolute or home-relative builder path: make esbuild's module comments
   root-relative (or drop them) in `scripts/build-release.sh` / its build config. Do not change the paired
   `__COSWARM_VERSION__` identifier.
4. KEEP: historical docs (`docs/evidence`, `docs/org`, design history), comments that record past drift with dates,
   the deliberate `coswarm.dev` hazard warnings, `supabase_db_cloud-swarm` container names, fixture emails, and the
   local directory name. No repo rename, transfer, Vercel, DNS, secret or billing change.
5. A test fails if a live surface reintroduces `Ridge-io` (or `Ridge.io` as an organization) or a builder path: an
   allowlist of the files that may contain those strings (history and dated comments), not a denylist; it scans the
   tracked tree plus the built `site/dist` and the release bundle. Show that the test fails on each reverted fix.

## Done

The test above; `install.sh` default and npm metadata name yulanventures; site build pages link yulanventures.
After release (lead): `curl -s https://commonswarm.com/install.sh | grep -c yulanventures` >= 1 and `grep -c Ridge-io`
0; `npm view commonswarm repository.url` names yulanventures.
