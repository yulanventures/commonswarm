# Human home overview

Apply `20261006000002_home_overview.sql` after the reviewed to-do migration
`20261006000001_household_todos.sql`. Run `20261006000002-catalog.sql` and
require `catalog_ok` to be `t`. This checks function ownership, security,
volatility, search paths, return types, and the exact EXECUTE grantees.
The internal consent predicate has no client EXECUTE grant.

The RPC counts only visible messages from other people and their agents,
using the viewer's maximum first-seen receipt (or seven days without receipts).
To-do and object activity belongs in the separate Latest activity read; it is
not counted as new. All content counts and personal to-do lists require live
human content consent. Agent Doing facts omit titles without that consent.
The result is bounded at 50 workspaces, 25 people and 50 agents per workspace,
10 asks, and 20 entries in each assigned/waiting list.

Before rollback, restore clients that do not require this RPC. In one session,
run `BEGIN;`, `20261006000002-rollback.sql`, and
`20261006000002-rollback-catalog.sql`. Commit only when `rollback_ok` is `t`;
otherwise roll back. The scripts do not commit their own transaction.
Roll back this migration before rolling back the to-do tables.
No history is deleted; the proof checks the retained tables, owners, RLS,
append-only triggers and restricted grantees. The CI drill also snapshots all
nine tables and their ACLs to prove the rollback preserves their exact bytes.

All three SQL proof files have byte-identical reserve copies in
`supabase/home-overview-reserve/`. No production changes were applied here.
