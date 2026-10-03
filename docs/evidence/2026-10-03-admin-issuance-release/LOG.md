# Admin issuance release log

Preparation only. No window opened, schema applied, service released, browser
started, approval received or C1 smoke executed by this worker. Issuance OFF.

The executing worker appends one row for every marked step, including failures.
Keep only safe IDs/digests, request statuses, fixed failure codes and evidence
file pointers. Never append raw command output, secrets, headers or URLs.

| UTC start/end | Window / ID | Step | Exact source / image / artifact identity | Expected / measured baseline | Gate / probe receipt | Result | Approval / rollback decision | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Failure entries record STOP, whether a mutation was attempted, whether COMMIT
or a command outcome is unknown, the exact approved recovery step and its
measured result. A rollback failure cannot become a closed-success row. Record
rm refusals with exact path and the guard's message; retain the refused file.

W1 preserves all checksum/backfill evidence and historical data after COMMIT.
W3 closure is permanent even after edge rollback. W5 has runnable activation/rollback blocks. W6 refuses unresolved path/scope rulings.
W7 cannot receive PASS without a verified production C1 report and its approval.
