# Item I — Checker review (Claude Opus arm), round 6 (delta)

Delta `dc834c50..1f4ffb73`, a single commit: `test(profile): every profile-list entry follows the order, not only the
first per verb`. I built a fresh `git archive 1f4ffb73` in `opus-probes/r6` (build exit 0) and a mutation copy of it.
Every run used a temporary HOME. No `cswarm` command was run by hand; the tests I ran use loopback fixtures only. No
process is left running.

## What changed

`git diff --stat`: 1 file, `tests/p1-cli/command-table-gates.test.ts` (+5/−2). `diff -rq` of the r6 archive against the
round-5 (dc834c50) archive, excluding `node_modules` and `dist`, shows only that file. `src/`, the fixtures, the site
and the docs are unchanged.

## Does the test now catch the split, without re-implementing the builder?

The new lines:
```ts
const entryVerbs = AGENT_PROFILE_COMMANDS.map(entry => entry.split(" ")[0]!);
...
const orders = entryVerbs.map(verb => expected.indexOf(verb));
assert.deepEqual(orders, [...orders].sort((left, right) => left - right));
```
`expected` is still just the verbs sorted by `profileListOrder`. The new check requires the order of each entry's
verb to be non-decreasing. It does not repeat the builder's rule for which pairs accept `--profile` or when a group
collapses to its verb; the item-I test still checks that list exactly.

The builder mutations (in `src/cli.ts` `AGENT_PROFILE_COMMANDS`), each built and run against both tests:

| Mutation | command-table-gates | item-I exact list |
|---|---|---|
| P1 reverse the sort | fails | fails |
| P2 remove the sort | fails | fails |
| P3 reverse the pair order inside `session` | passes (by design: the pair order inside one verb is not an order rule) | fails |
| P4 leave out `feed` | fails | fails |
| **P5 Grok's split: `listen, session start, channel, session status, session stop`** | **fails** | fails |

In P5 the list of unique verbs is still `…, listen, session, channel`, so the first `deepEqual` passes. The gate's
failure therefore comes from the new check, the one this commit adds. At dc834c50 the gate passed the same split, as
Grok and I both reported. I restored the sources and compared them with `diff -r` (identical). My P5 result matches
the lead's control.

## Tests

`command-table-gates`, item I and `citation-drift` at 1f4ffb73: **32/32**. `npm run check:tests` exits 0. I did not run
the full suites; the lead reports the gates at the merge bc1781b0 and a production control that passed. I did not
check either.

## Carried forward

The profile-list sentence leaves out `mcp`, `setup`, `check` and the `receive` commands, which accept `--profile`
(already true at 0260ab8d; now a follow-up outside this lane). Also not established: live hook-id equality with the
host variables, and static MCP config behaviour.

VERDICT: PASS
