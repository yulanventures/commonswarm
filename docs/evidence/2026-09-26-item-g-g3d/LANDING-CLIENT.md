# Item G lane G3d, client half: presence from every client (landed 2026-09-26)

Brief: `docs/design/2026-09-26-REST-OF-G-BRIEF.md`, section G3d. Server half: `LANDING-SERVER.md`.

- Lane commit `cbf5ad00` (Alloy task `4d984700cd004a07`: Codex Maker). Its gate still failed three envelope pins in
  `tests/delivery-client.test.ts`, outside its allowed paths; the lead updated them to expect `client_build` from the
  helper. No Alloy Checker ran (tests had failed); a read-only Codex arm reviewed the squashed commit.
- `src/cloud/client-build.ts` is the one build source; `withClientBuild()` adds `client_build` to all nine envelope
  constructors (inventory test). Channel claims send route `channel`, the listener `listener`. `cswarm check` and the
  hook send `touch_presence` concurrently, at most once per 60 s per seat, never changing check output or budget.
  `src/cloud/agent-presence.ts` is the classifier for G3e.

## Release rule (from the review; BINDING)

The Codex review found that this client against the CURRENT production server fails loudly: the pre-G3d edge refuses
the unknown `client_build` key on capability and renewal-grant commands, and the unknown claim `route`. So:

**No npm package or `/download` binary built from a commit that contains `cbf5ad00` may be published until the box
window that releases the G3c and G3d server half (`20260927000001`, `20260927000002`, and their edge) has passed its
gate.** cswarm 0.1.78 is built from `74804141`, which does not contain it. The web app does not use this helper (it
builds its own envelopes in `site/src/lib/commonswarm.ts`), so a site release is not affected.

## Gates

| Gate | Result |
|---|---|
| lane gate (`gates` mode: build, `npm test`, check:tests, check:edge, command-core, build-release, site build) | exit 0 |
| `cli-file` agent-channel, agent-onboarding, chat-cli, citation-drift, presence-client, standing-grants, timeout-table, delivery-client | 3/3, 29/29, 29/29, 5/5, 6/6, 7/7, 29/29, 33/33 |
| full `p1-cli` | run with the T3a landing (a p1-cli run cannot overlap a running Alloy task) |
