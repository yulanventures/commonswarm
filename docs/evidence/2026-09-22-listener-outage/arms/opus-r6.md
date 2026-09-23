# D-036 Checker (Claude Opus), round 6: lane/listener-outage @ 402c7a71

Base a9846955. I read brief6, LANE.md "Fold 8", opus-r5.md, grok-r5.md, and `git diff a48b1aca...402c7a71 -- src/`.
I also read the lane-wide `renewal.ts` diff from a9846955 and the code at 402c7a71 in the detached worktree
(`src/listener/runtime.ts`, `src/cloud/renewal.ts`, `src/cli.ts`, and the new tests). I ran tsx probes from
`/private/tmp/opus6-probe`. They imported the worktree `src` (and a `git archive` copy of `a9846955:src`) by absolute
path and used stub fetchers, a fake clock, an in-memory credential store and a stub pending queue. They made no
network call. I deleted the directory. I ran the two renewal test files in the worktree (26 pass, 0 fail). The
worktree is clean (`git status --short` is empty). This file is the only file I left.

## Round-5 findings: status at 402c7a71

| Round-5 finding | Status |
|---|---|
| Opus P1: a renewal 401 near expiry became a permanent stop, because the window slept 5 min past expiry | PARTLY FIXED. Consecutive renewal 401s now retry every 30 s until 5 s before expiry, and recovery works (probe B below). One transient answer between two samples brings back the 5-minute sleep past expiry. See P1. |
| Opus P2: D-004/D-011 tests deleted; one-shot wording and fatality changed | Tests FIXED. `tests/p1-cli/renewal-refusal-cause.test.ts` at 402c7a71 is byte-identical to a9846955 (`diff` is empty), and it passes. The one-shot 401/403 path again gives the D-004/D-011 classes and sentences. One-shot fatality changed for three other answers that LANE.md does not name. See P2. |
| Opus P2 (sub): follow predicate lacked `RenewalCredentialCheckError` | FIXED (`cli.ts` `isFollowRenewalCredentialFailure`). This has no effect today, because follow does not use `listenerMode`, so it never gets that class. |
| Opus P2 (sub): 426 sentence named the listener for one-shot | FIXED (`RENEWAL_UPGRADE_COMMAND_ACTION` / `_LISTENER_ACTION`). |
| Opus R1: `renewal_retry` status did not say the listener ends at expiry | FIXED (`cli.ts:5719`). |
| Opus R2: lease contradictions were plain `Error` | Tagged as `ListenerLeaseResponseError`. The behaviour is unchanged: `isRestartableListenerStop` gives `false` for it (probe, with a positive control: `RenewalRetryError` gives `true`). A lease contradiction from a foreign backend is still a permanent stop. LANE.md claims only the tag, so this is correct as stated. |
| Opus R3 / Grok 1: AST walker and `parseSignalAttachments` | FIXED. The attachment parser throws `SignalAttachmentMalformedError`. `classifySignalReadFailure` and `isMalformedFollowMessage` recognise it. |
| Grok 2: ACK test sent no session code | FIXED as LANE.md states. I did not re-run it. |

## P1: PRODUCTION. Near expiry, one transient answer inside a renewal-opened window still sleeps 5 minutes past the expiry and ends the listener for good

Fold 8 shortens the wait only when the current sample is itself a `RenewalCredentialCheckError`:

```ts
// runtime.ts:1289-1299
    const expiry = options.credentialSession.expiry;
    const beforeExpiry = error instanceof RenewalCredentialCheckError &&
      expiry !== null && expiry !== undefined &&
      expiry - atMs > RENEWAL_WINDOW_EXPIRY_MARGIN_MS;
    const delayMs = beforeExpiry
      ? Math.min(RENEWAL_WINDOW_RETRY_MS, expiry - atMs - RENEWAL_WINDOW_EXPIRY_MARGIN_MS)
      : CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS;
```

When the window is open, a transport error or 5xx on renewal comes back from `bearer()` as `RenewalRetryError`. The
read path (`runtime.ts:1525-1531`) sends it to `holdCredentialWindow("transient", error)`. It is not a
`RenewalCredentialCheckError`, so the listener waits `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS` (5 min) and ignores the
token expiry. The claim, ACK and other transient sites (`:1380`, `:1828`, `:2035`, `:2155`) use the same function.
After that sleep the token has expired. The next answer is either our 401 (a sample of a now-true loss) or a
transport error, which `bearer()` turns into `RenewalRevoked("predecessor_expired_local")`, a local credential stop.

Probe: the real `AgentCredentialSession` with `listenerMode: true`, the real `runListenerRuntime`, and a fake clock.
The token expires at E, which is 4.5 min after the start. "Our backend" renews a live token and refuses an expired
token with 401 `unauthenticated`.

```
== A: foreign 401, then one network error, then our backend
-4.50m renew#1 -> 401 (foreign)          credential_check checks=1
-4.00m renew#2 -> network                credential_check checks=1   (transient: 5-min sleep follows)
 1.00m renew#3 -> 401 (ours, expired)    credential_check checks=2
 6.00m renew#4 -> 401 (ours, expired)
 6.00m STOP credential RenewalCredentialCheckError
== B control: foreign 401 twice, then our backend
-4.50m renew#1 -> 401 (foreign)
-4.00m renew#2 -> 401 (foreign)
-3.50m renew#3 -> 200 accepted           credential_check_cleared
 4.25m STOP cancelled                    (survived past E)
== C control: network error twice, then our backend (no window)
-4.50m renew#1 -> network   read_retry renewal_retry delay=468
-4.49m renew#2 -> network   read_retry renewal_retry delay=534
-4.48m renew#3 -> 200 accepted            read_recovered
 4.27m STOP cancelled
```

A and B differ in one answer only: renewal #2 is a network error in A and a foreign 401 in B. In A the backend was
available from -3.5 min, but the listener made no attempt until +1.0 min, after the token had expired. A DNS change
usually looks like A: a mix of transport errors and answers from the wrong backend. This is the 2026-09-16 incident
class, and brief6 names this check: "the near-expiry case under every ordering (network errors, a foreign 401, our
401, success)". The same fault occurs when a read-edge 401 opens the window shortly before renewal is due. The
window then sleeps 5 minutes, and a transient renewal failure after that sleeps another 5 minutes across the
expiry.

The fold-8 tests cover only 401, 401, success (`tests/listener-runtime.test.ts:6312`) and 401 throughout (`:6354`).
No test puts a transient between samples near expiry.

Fix: base the pre-expiry schedule on the session, not on the type of the sample. While the window is open and
`expiry` is known and less than `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS` + margin away, cap every wait (confirmed or
transient) at `min(RENEWAL_WINDOW_RETRY_MS, expiry - now - margin)`. For a transient that is a
`RenewalRetryError`, the capped delivery/read backoff is also acceptable. Add the A ordering as a test that runs past
the first wait and must recover.

## P2: PRODUCTION. One-shot commands now fail on three renewal answers where a9846955 used the live token, and LANE.md names this for listener mode only

`bearer()` now rethrows these classes in every mode:

```ts
// renewal.ts:856-862
      if (error instanceof RenewalCredentialCheckError ||
          error instanceof RenewalUpgradeRequiredError ||
          ...
          error instanceof RenewalUnsupported ||
          error instanceof RenewalRefused) throw error;
```

At a9846955, one-shot `bearer()` threw only when `this.expired() || error instanceof RenewalRevoked` (or
reauthorisation/suspension). It warned and returned the live token for `RenewalUnsupported` and every
`RenewalRefused`. Probe: the same stub answer, a live token 3 min from expiry, `listenerMode` unset, a9846955 against
402c7a71.

```
base  200 rejected renewal_unsupported:     PROCEEDS  warn="this credential was issued without a renewal window..."
base  200 rejected renewal_grant_not_found: PROCEEDS
base  200 rejected renewal_device_mismatch: PROCEEDS  warn="The standing grant is bound to another device..."
base  426 upgrade_required:                 PROCEEDS  warn="This copy of cswarm is older than the deployment accepts..."
fold8 200 rejected renewal_unsupported:     THROWS RenewalUnsupported
fold8 200 rejected renewal_grant_not_found: THROWS RenewalUnsupported
fold8 200 rejected renewal_device_mismatch: THROWS RenewalRefused
fold8 426 upgrade_required:                 THROWS RenewalUpgradeRequiredError
```

`cli.ts` prints these as `cswarm: <message>`, and the command does not run. Before this change, a person with a
live credential got a warning and the command ran. Now every one-shot command in the last 10% of the token's life
(5 to 15 min) fails for a credential that has no renewal grant or that is bound to another device. With 426, a
read-only command such as `cswarm inbox` now fails, although the read edge has no version gate
(`read/index.ts` has no `upgrade_required`). LANE.md Fold 8 says "Named `renewal_unsupported` and device refusals
retain their own fatal classes ... in listener mode". Fold 7 says "one-shot CLI commands may use a still-live
predecessor". Neither statement discloses that one-shot commands now fail. The only record is the 426 test,
`tests/p1-cli/renewal-listener-samples.test.ts:120`, which pins the one-shot failure. The test at `:105` covers
listener mode only. Brief6 requires "one-shot behaviour equals a9846955 except where LANE.md names the change".

Fix: make the rethrow of `RenewalUnsupported`/`RenewalRefused`/`RenewalUpgradeRequiredError` depend on
`listenerMode`, so that one-shot keeps the a9846955 warn-and-proceed while the token is live. Alternatively, record
the decision in LANE.md with its reach. Add a one-shot test for each class.

## R1: RIGOUR. `renewal_unsupported` and device refusals are a permanent listener stop on one answer

In listener mode these classes now stop at once with reason `fatal`. `isRestartableListenerStop` gives `false`
(probe, with a positive control). Fold 7 retried them until expiry. a9846955 disabled renewal and ran until
expiry. `renewal_unsupported` is the answer of a command adapter that has not wired renewal
(`src/protocol/workspace-commands.ts:330`). An older edge behind a DNS change that still authenticates the token
therefore stops the listener for good with one answer. A retry until expiry would have survived it. The reach needs
a foreign backend that accepts the credential, so I rate this RIGOUR. This contradicts the brief rule "no permanent
stop on a single foreign answer", and LANE.md does not argue for the choice.

## R2: RIGOUR. `credential_check` status is not true once the token expires inside the window

Probe D: foreign 401 every 30 s until E-5 s, then (after the 5-min sleep) one network error. Every
`credential_check` event said `stopAt=+5.50m`. The listener stopped at `+4.92m` with `RenewalRevoked` ("expired while
renewal was unavailable"). `credentialCheckSentence` (`cli.ts:5714`) says "It will stop at <stopAt> if every check
until then confirms the loss; a transient answer extends the check window". After expiry both clauses are false. A
transient answer ends the listener at once, and no check can succeed. When `renewalExpiresAt` is earlier than
`credentialStopAt`, the sentence should name the expiry and say that the listener ends there unless renewal succeeds
first.

## R3: RIGOUR. The 5-second expiry margin

`RENEWAL_WINDOW_EXPIRY_MARGIN_MS = 5_000` (`runtime.ts:149`). The last attempt is scheduled at E-5 s, but
`RENEW_TIMEOUT_MS` is 30 s (`renewal.ts:130`), and the server judges expiry by its own clock. Client clock skew above
5 s, or a slow answer, makes the last attempt land after expiry. This does not break the design, but the margin has
no argument in LANE.md.

## Checked and correct

- The restored D-004/D-011 file is identical to a9846955 and passes. One-shot 401/403 with a foreign or non-JSON
  body gives `RenewalRevoked("forbidden", UNEXPLAINED_REFUSAL_MESSAGE)`, or the local-expiry sentence past expiry, as
  at a9846955 (where parse failure also set `body = {}`).
- Listener 401/403: only 401 `unauthenticated` is a sample. Other answers are `RenewalOutcomeUnknown` and become a
  `RenewalRetryError`, then a local expiry stop after the known expiry. Consecutive 401s retry at 30 s before
  expiry, and the stop still needs 3 checks and the 10-minute span (probe D: 10 checks, no stop before expiry).
- The `cli.ts` credential wrapper now forwards `expiry`, which the short retry needs. Without it the runtime always
  took 5 minutes. LANE.md reports this, and the detached fixture proves it.
- Changed and new tests run under package scripts: `tests/listener-runtime.test.ts` and
  `tests/listener-cli-process.test.ts` are named in the literal `npm test`, and `tests/p1-cli/**` is globbed by
  `test:p1-cli`.
- D-053: the new branches use `instanceof`, not `error.message`.
- `--follow` is unchanged from a9846955. It stops on one confirmed read code and on a one-shot renewal 401/403. The
  measured incidents were listeners, and LANE.md discloses this.

## Not established

I did not run `npm test`, `test:p1-cli`, or `build-release.sh`, and I started no listener. My "our backend" is a
stub that refuses an expired token with 401 `unauthenticated`. I did not re-trace which answer the command edge sends
for an expired predecessor. Either answer (401 sample or transport error followed by local expiry) ends the listener
in probe A. I did not measure real DNS failover shapes or clock skew on production clients. The one-shot "CLI prints"
claim comes from reading the `cli.ts` catch logic, not from running the binary.

VERDICT: FAIL
