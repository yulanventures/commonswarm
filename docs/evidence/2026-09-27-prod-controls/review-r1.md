I'll check the procedure against the repository, starting with the CLI commands, presence fields, and receipt paths it cites.The procedure cannot be run as written. Three success gates reject a correct run, and the Claude approval steps are Tom’s.

## Findings

1. Preflight `cswarm --version` cannot pass. The CLI prints `cswarm 0.1.80 (protocol 0.1.0)` (`src/cli.ts:10478-10481`, `src/cloud/config.ts:3`). The same printer is the only version line in this tree, so `commonswarm@0.1.79` is `cswarm 0.1.79 (protocol 0.1.0)`. The preflight requires the bare strings `cswarm 0.1.80` and `cswarm 0.1.79`. That `test` fails, the block prints `FAIL PRE-FLIGHT`, and Anvil is told to stop before any seat exists.

2. A successful revoke of all 13 principals fails the revoke gate. `principal revoke --json` goes through `printJson`, which writes indented JSON (`src/cli.ts:1779-1780`, `src/cli.ts:2599-2607`). Each result is several lines (`message`, `status`, `principal_id`, `command_event_ids`). After 13 accepted revokes, `wc -l` is not 13, so the block prints `FAIL REVOKE` and the next instruction keeps `$HOME/.config/cswarm/prod-controls-20260927-0927a` on disk. `PASS REVOKE 13 OF 13` is unreachable.

3. The secret scan fails on the procedure file it requires. Section 6 commits `PROCEDURE.md` inside `docs/evidence/2026-09-27-prod-controls/` and then runs `rg` over that whole directory. The draft itself contains `commonswarm:anon-key`, `"anon_key":`, `"credential":`, and `swm_agt_`. `rg -l` matches the procedure, the `!` fails, and `PASS EVIDENCE COMPLETE AND SECRET-FREE` does not print on a clean evidence set.

4. The G3e tab-B stop line does not appear in the terminal. `inbox --notify` writes its SIGINT sentence to stderr (`src/cli.ts:5004-5010`, `src/cloud/arrival-watch.ts:92-106`). Section 3.2 redirects that stderr to `$CTL_ROOT/g3e-stale-old/watcher.stderr`. The tab returns to the shell with exit 130 and no CLI sentence. The stale classification itself is real: release does not clear `watcher_at` (`supabase/functions/command/index.ts:2730-2732`, `2746-2777`), and the route is stale after three minutes (`src/cloud/wake-lease-constants.ts:6-8`, `src/cloud/agent-presence.ts:100-108`). The 24×10s poll can observe `stale watcher` if the operator continues.

5. The interactive Claude steps are Tom’s, and the draft gives them to Anvil. The T2 procedure this control cites says Tom runs `claude auth login` on the mini and presses the development-channel approval key (`docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md:44-54`). Host recovery of that OAuth session is the operator’s `claude auth login` (`docs/org/2026-08-29-RESUME-HERE.md:1016-1045`). Sections 2.1–2.3 tell Anvil to start Haiku, approve the development channel, and approve `cswarm_reply`. Mint and revoke are Anvil’s under Tom’s standing human session (`docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:202-203`, `285-286`).

T3’s refusal lines match the edge, including the `cswarm:` prefix and exit 1 (`supabase/functions/command/index.ts:9100-9104`, `10416-10419`; `src/cli.ts:10616`, `10557-10561`). Receipt JSON fields `state`, `outcome`, `acked_at`, and `replies[].responder_principal_id` match `src/cloud/receipts.ts:275-311`. The four presence kinds and `update available` match `src/cloud/agent-presence.ts:62-75` and `src/cli.ts:4310-4336` when `current_client_build` is `0.1.80`. The app line is `none · last call: never · client build: unknown` (`site/src/lib/agent-presence.ts:69-88`). The 13 revoke targets match the 13 mint calls. No step assigns `HOME`, runs Docker, presses **Sign out**, or uses a working seat. The guarded `rm -rf` paths are the scratch directory and the literal `prod-controls-20260927-0927a` directory.

## NITS

- The roster opener’s accessible name is `N agents — view and manage agents` (`site/src/components/app/LiveDashboard.astro:468-476`, `4101-4104`). `People & agents` is the dialog title after it opens (`:1030-1031`). `Filter agents…` is the placeholder (`:1060-1061`).
- The anon-key meta tag is `site/src/layouts/Base.astro:206`. Lines 1925–1930 are not in that file.
- `setup`’s command entry is `src/cli.ts:10110`. Line 9964 is the import-variant help string.
- Text roster omits the word `current` when `client.kind` is `current` (`src/cli.ts:4332-4335`). The turn row renders `turn, last <age>`, not the bare word `turn` (`site/src/lib/agent-presence.ts:76-78`).
- Preflight never reads `current_client_build`. `0.1.79` is `update available` only when that config is strictly newer (`src/cloud/agent-presence.ts:67-73`). The box plan records the published build, which that plan still calls `0.1.79` (`docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:473-495`).

VERDICT: FAIL