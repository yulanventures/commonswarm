# Item I — Checker review (Claude Opus arm), round 5 (delta)

Delta `25ac71b1..dc834c50`, a single commit: `test(profile): the profile-list order test checks verbs, not the old
one-name-per-verb shape`. I built a fresh `git archive dc834c50` in `opus-probes/r5` and a mutation copy in
`opus-probes/mut5`. Both built with exit 0. Every run used a temporary HOME. No `cswarm` command was run by hand in
this round; the tests I ran use loopback fixtures. No process is left running.

## What changed

`git diff --stat 25ac71b1 dc834c50`: 1 file, `tests/p1-cli/command-table-gates.test.ts` (+4/−1). I also compared the
r5 archive with the round-4 (25ac71b1) archive using `diff -rq`, excluding `node_modules` and `dist`. That file is the
only difference: `src/`, the fixtures, the site, the docs and LANE.md are identical.

## Does the test still guard the order rule, without re-implementing the builder?

The new assertion:
```ts
const verbs = AGENT_PROFILE_COMMANDS.map(entry => entry.split(" ")[0]!)
  .filter((verb, index, all) => all.indexOf(verb) === index);
assert.deepEqual(verbs, expected);   // expected = verbs with profileListOrder, sorted by it
```
`expected` comes only from `profileListOrder`. It does not repeat the builder's rule for which pairs accept
`--profile` or when a group collapses to its verb. That rule is checked separately by the item-I test
`profile refusal names exactly the accepting command pairs in table order`. So the gate checks only the order of
verbs, and does not copy the builder.

I mutated `AGENT_PROFILE_COMMANDS` in `src/cli.ts` and ran both tests:

| Mutation | command-table-gates (order) | item-I (exact pairs) |
|---|---|---|
| P1 reverse the sort | **fails** | fails |
| P2 remove the sort (`Object.entries` order) | **fails** | fails |
| P3 reverse the pair order inside a group (`session stop, status, start`) | passes (by design: only verb order is checked) | **fails** |
| P4 leave out one verb (`feed`) | **fails** | fails |

Every one of the four mutations fails at least one of the two tests, and the gate itself catches each change to the
verb order. I restored the sources and compared them with `diff -r` (identical). The lead's control (a reversed sort
fails the gate) matches my P1.

One limit, and it does not block: the check removes duplicate verbs, so a builder that split one verb's pairs around
another verb (for example `session start, channel, session stop`) would pass the gate. The item-I test's exact
`deepEqual` would fail it.

## Tests

`command-table-gates`, item I and `citation-drift` at dc834c50: **32/32**. `npm run check:tests` exits 0. I did not
run the full `test:p1-cli` or `npm test` myself. The lead reports 896/896 and 962/962.

## Carried forward

The sentence leaves out `mcp`, `setup`, `check` and the `receive` commands, which accept `--profile`. This was already
so at 0260ab8d, and it is now recorded as a follow-up outside this lane, as my round 4 suggested. Also not established:
the production request count, live hook-id equality, and the static MCP config.

VERDICT: PASS
