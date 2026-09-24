I'll review item G lane 1 at `a503577e` against rulings G1–G9, without changing files or touching production. First I'll read the fold notes and the lane diff.HEAD is `a503577e` on the fold. Next I’ll read the fold diff and the code each ruling claims to fix.The fold notes and SQL are in. I’ll read the command path, check client, and the tests that claim to pin each ruling.The cutoff and the retry write look like they can disagree with the rulings. I’ll reproduce both with a temporary home and no repo changes.Item G lane 1 at `a503577e` still fails. Two rulings do not hold as specified. The rest of G1–G9 match the code and the tests that guard them.

## Findings

### 1. PRODUCTION — a timed-out observation never records the attempt or age cap

`src/cloud/agent-check.ts:269-285` gives each ack only the time still left, then refuses to persist the queue unless 50 ms remains after the request:

```269:285:src/cloud/agent-check.ts
              const client = new DeliveryCommandClient(target, fetcher, {
                deadlineMs: Math.min(AGENT_CHECK_TIMEOUT_MS, remainingMs),
              });
              await client.observeUnclaimedAgentDelivery({ workspaceId: profile.workspace_id,
                credential: token, commandId: randomUUID(), signalId: id });
              removed.push(id);
            } catch (error) {
              const transient = error instanceof DeliveryTransportError ||
                (error instanceof DeliveryHttpError && error.status >= 500 && error.status < 600);
              const next = { attempts: prior.attempts + 1, first_at: prior.first_at };
              if (!transient || next.attempts >= AGENT_CHECK_ACK_MAX_ATTEMPTS) removed.push(id);
              else retryUpdates[id] = next;
            }
          }
          if (attempted === 0 && removed.length === 0) return;
          const writeBudgetMs = Math.floor(deadlineMs - Date.now());
          if (writeBudgetMs < AGENT_CHECK_ACK_MIN_REMAINING_MS) return;
```

`src/cloud/delivery.ts:833-836` starts that timer for the full `deadlineMs`. A timeout therefore ends on the check deadline, `writeBudgetMs` is about 0, and the function returns before `pending_observed_retries` is written. The attempt cap (`AGENT_CHECK_ACK_MAX_ATTEMPTS`, line 263) and the 24-hour age cap never see the failure. The id stays in `pending_observed_ids` from the pre-ack write at line 313. The next check starts the same request again. A fast 409 earlier in the same batch is discarded with it, because `removed` is only in memory.

Measured with a temporary `HOME`, one fast 409 and one ack that ignores abort, deadline 450 ms: the call returned 2 ms after the deadline, both ids were still pending, and `pending_observed_retries` was null. G4’s fast-409 test still passes, because those responses return with time left to write. `docs/evidence/2026-09-25-item-g-lane1/LANE.md:49` says the metadata caps attempts at 3 and age at 24 hours. That is true only when the failure returns before the 50 ms floor.

### 2. RIGOUR — the “known seat, old row” server test is on the wrong side of a fresh cutoff

`tests/p1-server/managed-delivery.test.ts:579-584` backdates the positive row by 4 minutes and expects the view to return it:

```579:584:tests/p1-server/managed-delivery.test.ts
  const live = await postAsk(agent.principalId);
  await sql`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '4 minutes'
    WHERE signal_id = ${live}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`;
  const stale = await wakePathRows(agent.principalId);
  assert.equal(stale.length, 1);
  assert.ok(Date.now() - stale[0]!.getTime() >= WAKE_STALE_MS);
```

The view counts a row only when `enqueued_at >= applied_at` (`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:74`). `applied_at` is `statement_timestamp()` at migration (`:55-59`). On `db:reset`, that is seconds before this test. `now() - 4 minutes` is before the cutoff, so the view omits the row and `stale.length === 1` fails. The assertion passes only once the cutoff is already more than 4 minutes old. On this database the cutoff age is 13m43s, so the same row would count here. `LANE.md:47` says this test covers the case after the lead’s reset. A focused run of this file right after reset does not.

The earlier assertion in the same test (pre-cutoff mail stays out of the view, lines 573–574) does fail if the cutoff predicate is removed.

## Rulings that hold

**G1.** `supabase/functions/command/durable-delivery.ts:731-735` refuses only a null proof or a row whose `session_id` is already bound to a different session. An enqueued row has `session_id` null (`tests/delivery-client.test.ts:985-1014`). A generation+1 proof is still stopped by the generic fence (`tests/p1-server/managed-delivery.test.ts:625-628`); the different-session negative is the unit test, and it fails if the null check is removed.

**G2 rule, from the view and the receipt wrapper.** A seat is in `swarm_read.agent_wake_path` only when it already has a post-cutoff unclaimed `observed` ack, and then only for a directed ask/note that is unacked, has no current or former lease, is unexpired (`s.until > statement_timestamp()`), and was enqueued at or after `swarm.wake_path_release.applied_at`. The client marks stale only when that timestamp is at least `WAKE_STALE_MS` (`site/src/lib/wake-path.ts:7-11`, `src/cloud/receipts.ts:173-179`). Otherwise the receipt keeps the current “Not yet delivered” sentence (`tests/delivery-receipts.test.ts:467-480`).

| Case | Result |
|---|---|
| Pre-cutoff row | `enqueued_at >= applied_at` excludes it |
| Expired row | `s.until > statement_timestamp()` excludes it |
| Never-acked seat | The `observed` `EXISTS` fails, so the seat stays out of the view and `wake_path_observing` is false |
| Acked seat, new old post-cutoff row | The row is the aggregate; the client marks it once it is older than `WAKE_STALE_MS` |
| Cleared by ack | `acked_at IS NULL` drops it |
| Leased row | Current lease and `last_lease_*` must all be null |
| Revoked principal | `p.revoked_at IS NULL` |
| Owner left | The proof seed requires `swarm.is_member(workspace, owner)` (`deploy/release-proofs/item-g/20260925000001-functional.sql:35`). The view’s `is_member` is the viewer (`auth.uid()`). `MemberRemoved` does not stamp `agent_principals.revoked_at`, so another member can still see a departed owner’s seat. That seat is actually unchecked |

The cutoff is one row in `swarm.wake_path_release`: boolean primary key, `CHECK (singleton)`, `applied_at` defaulting to `statement_timestamp()`, inserted once by the migration. There is no typed date. Re-applying the migration fails on `CREATE TABLE`. That is safe to apply once on the box. The brief’s “Correction (fold 1)” matches this rule and keeps the retired decision-4 sentence.

**G3.** Acks run after `present` and the cursor write. Each request’s timer is the remaining budget, and a start below `AGENT_CHECK_ACK_MIN_REMAINING_MS` (50) is skipped. The profile and hook paths share `ackPending`. The in-flight test (`tests/p1-cli/agent-onboarding.test.ts:207-237`) fails if that timer is a fresh `AGENT_CHECK_TIMEOUT_MS`. The same repro finished 2 ms after a 450 ms deadline. The hook hard exit is 150 ms later (`AGENT_CHECK_WRITE_BACK_MARGIN_MS`).

**G5.** The new admitted acked shape is `ack_outcome = 'observed' AND last_error_code IS NULL` with no lease pair. The previous shapes stay: lease pair, `expired`, and `failed_terminal` with `delivery_attempts_exhausted`. The local catalog definition is that predicate, and `convalidated` is true. The migration adds it `NOT VALID` and then `VALIDATE CONSTRAINT` (`20260925000001_unclaimed_observed_ack.sql:30-31`). The catalog proof matches the definition, `convalidated`, and any other `acked_at` check that still requires a lease pair (`deploy/release-proofs/item-g/20260925000001-catalog.sql:3-45`). `tests/delivery-client.test.ts:1032-1038` fails if the error-code conjunct or `NOT VALID` is removed.

**G6.** The functional proof requires `item_g_seed_signal_id`, selects that row only when it is eligible, rejects other eligible mail for the same seat, and requires `oldest_unobserved_at = v_enqueued`. Revoked principals and owners who are no longer members fail the seed with the eligibility error. Non-member and anonymous reads have their own errors. `auth.uid()` reads `request.jwt.claims` `sub`, which is what the proof sets.

**G7.** Queued `observed` replay returns idempotent before the session comparison (`durable-delivery.ts:791-794`), matching `4d4cb3f7`. `tests/delivery-client.test.ts:1017-1029` fails if that return moves back under the session check.

**G8.** A wake-view error returns the roster already built (`site/src/components/app/LiveDashboard.astro:2029`). `NO_LISTENER_STATUS_SENTENCE` is “No listener is running for this agent in {stateDirectory}…” (`src/listener/main-routing.ts:66-67`), and `src/cli.ts:7352` fills in `paths.instanceDirectory`.

**G9.** The deferred MCP commit acks only the ask/note prefix through `lastVisibleId` (`src/cloud/agent-check.ts:306-309`). `tests/p1-cli/mcp-stdio.test.ts:640-647` compares those ack ids with the capped response and fails if every presented row is acked.

No secret appeared in the migration, proofs, or this run. No production host was contacted.

VERDICT: FAIL
