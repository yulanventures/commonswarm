# Declared command-baseline changes

Every row below keeps its exit code except six: `channel toString` and
`channel constructor` on the plain, JSON, and valid-profile axes change from
exit 0 to exit 1 (see the own-property section). Rows change only where the
lane 1 spec, the item-L ruling, or that section requires it.

## Selected-entry error class

Spec sentence: “error handling reads the SELECTED ENTRY, never raw
`process.argv`”.

These rows change from a plain error on stderr to the onboarding JSON error on
stdout:

- `refusal.flag-before.check`
- `refusal.flag-before.receive`
- `refusal.flag-before.setup`
- `check.profile-before-verb`
- `selected-error.check.json-before`
- `selected-error.check.profile-valid-before`
- `selected-error.check.profile-missing-before`
- `selected-error.check.json-profile-valid-before`
- `selected-error.check.json-profile-missing-before`
- `selected-error.check.profile-json-valid-before`
- `selected-error.check.profile-json-missing-before`
- `selected-error.check.host-before`
- `selected-error.receive.configure.json-before`
- `selected-error.receive.configure.profile-valid-before`
- `selected-error.receive.configure.profile-missing-before`
- `selected-error.receive.configure.json-profile-valid-before`
- `selected-error.receive.configure.json-profile-missing-before`
- `selected-error.receive.configure.profile-json-valid-before`
- `selected-error.receive.configure.profile-json-missing-before`
- `selected-error.receive.configure.host-before`
- `selected-error.receive.confirm.json-before`
- `selected-error.receive.confirm.profile-valid-before`
- `selected-error.receive.confirm.profile-missing-before`
- `selected-error.receive.confirm.json-profile-valid-before`
- `selected-error.receive.confirm.json-profile-missing-before`
- `selected-error.receive.confirm.profile-json-valid-before`
- `selected-error.receive.confirm.profile-json-missing-before`
- `selected-error.receive.confirm.host-before`
- `selected-error.receive.idle.json-before`
- `selected-error.receive.idle.profile-valid-before`
- `selected-error.receive.idle.profile-missing-before`
- `selected-error.receive.idle.json-profile-valid-before`
- `selected-error.receive.idle.json-profile-missing-before`
- `selected-error.receive.idle.profile-json-valid-before`
- `selected-error.receive.idle.profile-json-missing-before`
- `selected-error.receive.idle.host-before`
- `selected-error.receive.refusal.json-before`
- `selected-error.receive.refusal.profile-valid-before`
- `selected-error.receive.refusal.profile-missing-before`
- `selected-error.receive.refusal.json-profile-valid-before`
- `selected-error.receive.refusal.json-profile-missing-before`
- `selected-error.receive.refusal.profile-json-valid-before`
- `selected-error.receive.refusal.profile-json-missing-before`
- `selected-error.receive.refusal.host-before`
- `selected-error.receive.serve.json-before`
- `selected-error.receive.serve.profile-valid-before`
- `selected-error.receive.serve.profile-missing-before`
- `selected-error.receive.serve.json-profile-valid-before`
- `selected-error.receive.serve.json-profile-missing-before`
- `selected-error.receive.serve.profile-json-valid-before`
- `selected-error.receive.serve.profile-json-missing-before`
- `selected-error.receive.serve.host-before`
- `selected-error.receive.status.json-before`
- `selected-error.receive.status.profile-missing-before`
- `selected-error.receive.status.json-profile-missing-before`
- `selected-error.receive.status.profile-json-missing-before`

- `selected-error.receive.test.json-before`
- `selected-error.receive.test.profile-valid-before`
- `selected-error.receive.test.profile-missing-before`
- `selected-error.receive.test.json-profile-valid-before`
- `selected-error.receive.test.json-profile-missing-before`
- `selected-error.receive.test.profile-json-valid-before`
- `selected-error.receive.test.profile-json-missing-before`
- `selected-error.receive.test.host-before`
- `selected-error.setup.json-before`
- `selected-error.setup.profile-valid-before`
- `selected-error.setup.profile-missing-before`
- `selected-error.setup.json-profile-valid-before`
- `selected-error.setup.json-profile-missing-before`
- `selected-error.setup.profile-json-valid-before`
- `selected-error.setup.profile-json-missing-before`
- `selected-error.setup.host-before`

The other four `receive.status` rows (valid profile, and `host-before`) are not
listed: `receive status` succeeds there (exit 0, status JSON on both), so there
is no error to change.

The round-4 generator adds all eight `SELECTED_ERROR_AXES` rows for each of
these non-default selected variants:

- `selected-error.setup.version.*`
- `selected-error.setup.guide.*`
- `selected-error.check.message.*`
- `selected-error.check.hook.*`
- `selected-error.inbox.notify.*`
- `selected-error.inbox.follow.*`

The 32 setup and check rows change from the old flag-before-verb refusal to the
selected variant's onboarding JSON error on stdout. The 16 inbox rows are
unchanged controls: they pin selection of `notify` and `follow` but declare no
behavior change.

These signed-in human rows change from a workspace error on stderr to the same
structured workspace error on stdout. The secure-file fallback warning remains
on stderr:

- `selected-error.ask.json-before`
- `selected-error.brain.get.json-before`
- `selected-error.brain.ls.json-before`
- `selected-error.brain.put.json-before`
- `selected-error.feed.json-before`
- `selected-error.file.get.json-before`
- `selected-error.file.ls.json-before`
- `selected-error.file.put.json-before`
- `selected-error.file.restore.json-before`
- `selected-error.file.rm.json-before`
- `selected-error.inbox.json-before`
- `selected-error.note.json-before`
- `selected-error.reply.json-before`
- `selected-error.status.json-before`
- `selected-error.use.json-before`
- `selected-error.working-on.json-before`

### Server file refusals read the parsed `--json`

A `FileCommandRefused` error chose JSON with `process.argv.includes("--json")`.
It now reads the selected entry's parsed arguments. After the `--` terminator,
`--json` is a positional (the file to find), not the flag. Measured on
`4cb8c5fe` and this lane with a loopback server that refuses every request:
these rows change from exit 1 with refusal JSON on stdout to exit 1 with
`cswarm: file list failed (HTTP 400)` on stderr:

- `refusal.file-refused.terminator-json.get`
- `refusal.file-refused.terminator-json.rm`
- `refusal.file-refused.terminator-json.restore`

`refusal.file-refused.flag-and-terminator-json.get` passes the flag as well as
the same positional and is unchanged: JSON on stdout on both.

## Own-property sub-action lookup (declared in the conversion commit)

The conversion commit selects a sub-action only when the group's own
`subcommands` object has it. On `4cb8c5fe`, `runChannel` looked the name up in
`CHANNEL_SUBCOMMANDS` and called what it inherited from `Object.prototype`. For
each of the 12 `Object.prototype` names on the plain, JSON, and valid-profile
axes (36 rows, `refusal.prototype-sub-action.channel.*`), the old result was
exit 0 with no output (`toString`, `constructor`), exit 1 with "chosen is not a
function" (`__proto__`), or exit 1 with a TypeError (the rest). The new result
is exit 1 with the channel refusal and usage, byte-identical to
`refusal.group.channel.unknown.*`. The prototype-name rows of every other group
are unchanged from `4cb8c5fe`.

## Resume help line

Spec sentence: “So every variant `select` can return is its own gate row.”

These rows keep their existing help text, add the `cswarm resume --profile`
usage line, and split `check` help into default, `--message-id`, and `--hook`
command shapes:

- `meta.help-flag`
- `meta.help-verb`
- `meta.no-positional-json`
- `meta.no-positional-profile`
- `meta.bare`

## Item-L CLI-only command

Strategist ruling: “the published skill and the quick guide KEEP `cswarm brain
put <topic> <markdown-path>` until item L ships brain_put as a tool.”

`setup.guide` changes its model-facing command examples from unqualified verb
phrases to `cswarm working-on`, `cswarm reply`, `cswarm brain put`, and `cswarm
check`.
