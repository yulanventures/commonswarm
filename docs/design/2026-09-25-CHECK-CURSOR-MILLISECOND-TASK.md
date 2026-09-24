# Follow-up task: preserve check inbox order within one millisecond

The read edge pages the inbox using JSON timestamps with millisecond precision.
Its `after` predicate truncates PostgreSQL `created_at` to milliseconds, then
compares `id`. A page ending at `12:00:00.000100` with a high UUID can skip a
signal at `12:00:00.000900` with a lower UUID. That second signal is later in
the `(created_at, id)` order used by `cswarm check`, but the next page omits it.

Fix the read edge's cursor in a separate lane. Add a served-read regression
test with the inverted UUIDs and a one-row page, proving the next page returns
the second signal exactly once. Review the wire cursor representation so it
preserves the comparison precision used by the query.

Item G lane 1 only changes the wake eligibility rule. Its later-observed heal
is safe only when check's cursor has shown every earlier signal in that order.
