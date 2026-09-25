# Facts from HezLead, 2026-09-25 ~00:20Z (for G's box release request and the next RELEASE-TO-BOX fold)

- Item J phase A PASSED 00:18Z: 20260924000001 applied (ledger 0->1, catalog f->t), functional pass (seeded row visible
  to a member; 0 rows without identity), cron added=none removed=none, no stack switch. Phase B (edge) began ~00:19Z.
- Two phase-A stops, both before any write:
  1. KIND_LIST 'edge' was wrong: a migration release needs 'edge stack'.
  2. Anvil retyped the section-5 apply block with `\\$`; the runbook's single `\$` is right under set -u.
     Runbook fold line: "extract blocks by line number; never retype".
- G sizing (read-only, 00:18Z): swarm.signal_deliveries total_rows=1879, total size 584 kB.
  Top workspaces observed/total: 292be0f9 495/1079; 4f63d2b0 4/321; 3ab184b3 0/141; d49b3042 30/124; f9aaada4 40/89.
  HezLead: lock window trivial (~2k rows vs 100k-row local test at 9.6 ms); no index needed before release at this
  size (G lane 1 already ships the partial index; it builds on ~2k rows).
- J phase B first try (~00:20Z): stop gate on probe j2 (Bearer x gave 400, not 401); Anvil rolled the edge back to
  1200ebb1 (healthy); migration stays. Cause: the probe used the nil UUID, which fails read's UUID_RE (version nibble
  1-8), so parseBody returns 400 before the token check. 00000000-0000-4000-8000-000000000000 gives 401. All other
  probes on the new edge passed (a-h, j1, j3, j4). Retry with the corrected UUID began 00:24Z.
  The lead's own probe answer (j1/j2 -> 401) did not state that the UUIDs must be valid v1-8 UUIDs. Probe-notes line:
  "never use the nil UUID in probes".
