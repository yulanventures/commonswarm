# H lane 1 evidence

## Refusal baseline inventory

The refusal inventory was derived from the dispatcher at `4cb8c5fe`, before
the command-table conversion. Its dispatcher code is unchanged from
`1cc1a663`. The enumeration used TypeScript AST traversal to
list every `assertShape()` call with its containing function. A second source
walk listed every closed sub-action selector and every unknown-action refusal
in `main()`, `runOnboardingCommand()`, and the handlers called by `main()`.

The baseline test records the resulting inventory as data:

- `GROUP_REFUSAL_SITES` generates the same missing-action and unknown-action
  matrix for every closed group, across plain, JSON, valid-profile, and
  missing-profile axes.
- `REFUSE_PROFILE_ROUTES` generates one valid route for each verb that reached
  the old profile refusal before its handler.
- `ARITY_REFUSAL_ROUTES` contains each `assertShape()` call whose positional
  minimum can be under-run after the old dispatcher selects its handler.
- Named rows cover the unknown verb without a profile, with a valid profile,
  and with a missing profile; flags before the verb; the hook-check
  extra-positional exception; and every meta-command condition, including a
  bare invocation.
- `prototypeVerbFixtures()` generates plain, JSON, and valid-profile rows for
  every name returned by `Object.getOwnPropertyNames(Object.prototype)`. This
  keeps inherited table properties on the unknown-command path.
- `prototypeSubActionFixtures()` puts each of those names in the sub-action
  position of every `GROUP_REFUSAL_SITES` verb, on the same three axes, so an
  inherited sub-action lookup is recorded as well as an inherited verb lookup.
  On `4cb8c5fe`, `cswarm channel toString` exits 0 with no output and
  `cswarm channel __proto__` exits 1 with a TypeError; the rows record that.
- `FILE_REFUSAL_JSON_ROUTES` reaches a server file refusal with `--json` after
  the `--` terminator, where it is a file name and not the flag, plus one
  control row that also passes the flag.

Calls whose minimum is already supplied by the verb and required sub-action
cannot produce a too-few `assertShape()` result. Handlers that check a missing
payload before `assertShape()` are recorded by their group matrix or successful
route instead; the baseline records the error the old code can actually emit.

`LEGACY_COMMAND_ENTRY_COVERAGE` records the old dispatcher's complete entry,
variant, profile, host-session, and error-policy inventory. It is the fallback
only while commit 1 has no command table. After conversion, the same generator
enumerates `AGENT_COMMANDS` and rejects any difference from that inventory.

Two more matrices are generated from that entry set:

- `hostSessionFixtures()` adds a valid profile and `--host-session-id` to one
  route for every entry. The row id carries the entry's keep/drop policy.
- `selectedErrorFixtures()` selects every variant of every entry whose table policy is
  `errorMode: "onboarding"` or `workspaceErrorJson: true`. It crosses each
  selected variant with JSON before the verb, valid and missing profiles before the verb,
  both JSON/profile orders before the verb, and a host-session flag before the
  verb. The profile-only axes keep JSON after the verb.

The workspace-error rows create a fake human session in the temporary HOME.
Its refresh and two-workspace reads are served only by the harness's
`127.0.0.1` stub. This reaches `WorkspaceCliError` without an external request.

The row set is generated from these arrays. It is not a list typed separately
into the JSON snapshot. Exit-code counts are generated from the recorded rows
in `tests/p1-cli/fixtures/command-dispatch-baseline-counts.json`; this README
does not restate those numbers.
