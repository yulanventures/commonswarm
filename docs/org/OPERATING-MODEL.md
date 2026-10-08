# Advisor → Operator → Executor

Adopted 2026-07-29. How work is split across model families on this repo, and why.

Model rule updated 2026-10-07: see section 2.

The load-bearing rule is §2. If only one thing here survives, it should be that one.

---

## 1. Why, in one paragraph

Over a week-long sprint on this codebase, **every real defect was caught by a reviewer of a
different model family than the author.** Not one by self-review. One agent logged eighteen of
its own errors and caught four. Another wrote a test that could not fail for its own property
*while warning about that exact failure mode in the test's opening comment*. Different families
miss different things; a family shares blind spots with itself.

This session added two more, both found only by leaving the model and touching the artefact:
the published binary contained no renewal code at all (D-001), and the CLI told every operator
renewal was unavailable while it was working (D-002). Neither is visible in source. Both are in
`DEFECT-REGISTER.md`.

---

## 2. Model-inversion review — the control that pays for everything

**A reviewer of a change must be a different model family than its author. Self-family
review does not count as review.** A codex subagent reviewing codex work satisfies nothing,
whatever the prompt, session or persona. That is the necessary baseline. Under the Operator
ruling, 2026-10-07 (Tom), the operative gate is **one allowed-model verdict from the other family
(Claude for Codex work, Codex for Claude work), bound to the exact SHA, plus green CI.**

Corollaries that have each already cost something here:

- **A verdict binds to a SHA.** Adding "just a docs commit" on top silently moves the approval
  past what the reviewer saw. A new commit voids the verdict; rebinding is mandatory.
- **An attestation is about WHO checked, not what the message says.** Relaying a reviewer's
  text under another agent's name produces a correctly-worded record with the wrong signature.
- **Verdicts are prescriptions, not vetoes.** The reviewer states the defect AND the required
  shape of the fix. A prescription is binding unless disproven *with evidence*, and the way to
  reject one is to report the disproof and stop on that item — never to quietly do something
  else.

### What is actually available on this machine

Measured, not assumed (`command -v`):

| Family | CLI | Role here |
|---|---|---|
| Claude | `claude` | **Maker or checker.** Allowed models: Claude Sonnet 5.5 (floor), Claude Opus 5.5, Fable 5.1. |
| OpenAI | `codex` | **Maker or checker.** Allowed models: gpt-6.1-sol (floor), gpt-6-astra. |
| xAI | `grok` | Optional non-code strategy panelist only; never maker or checker; not a reviewer. |
| Google | `agy` (Gemini) | Optional non-code strategy panelist only; never maker or checker; not a reviewer. |

**Operator ruling, 2026-10-07 (Tom).** It supersedes the 2026-07-29 ruling and the D-033
requirement for verdicts from both Grok and AGY/Gemini.

1. **No Alloy.** Alloy is not used for making, checking or routing work: no `/alloy` panels,
   no `alloy execute`, and `alloy doctor` is not the source of truth for reviewer availability.
2. **Every maker (author) and checker (reviewer) uses an allowed model or a stronger one.**
   The floor is Claude Sonnet 5.5 or Codex gpt-6.1-sol. Claude Opus 5.5, Fable 5.1 and Codex
   gpt-6-astra are also allowed.
3. **Never maker or checker:** Cursor composer, cursor-grok, Grok, Gemini Flash, Haiku.
4. **The check stays cross-family.** Claude makes and Codex checks, or Codex makes and Claude
   checks. Same-family review still does not count as review.
5. **Lower-model work is re-reviewed.** Open work made or checked only by a model below the
   floor (including the excluded models above) is re-reviewed by an allowed cross-family
   checker before it merges. Lanes running on a lower model finish their current step or stop,
   then continue on an allowed model.
6. **CI decides.** A passing allowed-model cross-family verdict bound to the exact SHA is
   necessary, and the PR's CI must also be green before merge. A review verdict does not
   override red CI.
7. **Grok and Gemini are optional strategy panelists only.** They may stay as extra, non-code
   strategy panelists. They are never a required reviewer, never a maker or checker of code or
   docs that merge, and their opinion never substitutes for the Claude/Codex cross-family check.

`opencode`, `cursor-agent`, Cursor composer, cursor-grok and `antigravity` remain excluded from
the review path and are never maker or checker. Alloy is not used.

**Superseded 2026-10-07:** earlier notes here measured `agy` and `grok` as review CLIs. They
are not reviewers; see the operator ruling above.

---

## 3. The three roles

**Advisor** — one agent, frontier reasoning model. Owns judgement, not throughput: strategy,
architecture, acceptance criteria, scope rulings. Writes the charter, which is the only
interface to the operator. Holds everything irreversible — merging, promoting to production,
applying migrations, talking to the human. Independently verifies operator claims *before
acting on them*: re-runs at least one claimed mutation proof, re-checks pushed SHAs with
`git ls-remote`, never relays an unverified claim upward.

**Operator** — one session, strongest available non-advisor family at max reasoning. Owns
execution: decomposes the assignment, spawns executors, enforces gates, assembles
review-ready branches, reports with exact SHAs and verbatim gate output. **Never merges, never
promotes, never touches production, never applies schema changes.**

**Executors** — many, disposable. Scoped mechanical work from self-contained briefs. One
worktree per task, one branch per task, gates inside the task, mutation proof attached.
Executors that make or check commits use an allowed model (section 2); nothing below the floor
makes or checks code. Max-effort models take anything with judgement in it.

---

## 4. Evidence discipline — what "done" means

- **Mutation proof per fix:** revert the fix → observe the verbatim red → restore exactly →
  observe green. A test never seen red proves nothing.
- ★ **The mutation must be applied at the PRODUCTION CALL SITE**, not to a constant and not to
  the test's own fixture. Four tests in one day passed full suites while checking nothing they
  were named for (D-018), and every one of them *had* a mutation proof — applied where the test
  was already looking. If the only mutation that reddens a test is one its author chose, the
  test observes the author's model of the system, and a model agrees with itself.
- **"What test fails if someone deletes this call?"** must have a named answer.
- **Every sentence in a commit message is a measurement that was run**, or is explicitly marked
  as an assumption. Corrections go in the tree, not only in the message.
- **Gates report real counts, not colours.** A job that passed in 0 seconds did not run;
  `skipped` is not green; a pending gate is not a gate.
- **Report failures verbatim.** "Stopped, blocked" is an acceptable terminal state.
  Falsely-marked-complete is not.

This repo's own verification doctrine (`AGENTS.md`) is the same rule from a different angle:
measure the artefact, not its name; run a positive control on the same invocation; enumerate,
don't pattern-match; pushed ≠ landed ≠ applied.

---

## 5. Failure modes already hit here

| Failure | Countermeasure |
|---|---|
| Release built from a commit predating the feature; everything green, feature unreachable (D-001) | Grep the **built artefact** for a symbol the feature must contain, with a control against a fresh build |
| CLI reported a feature unavailable while it worked (D-002) | Exercise the real path end to end; never trust a code comment asserting a field exists |
| Executor CLI exits 0 having produced only narration | Wait for process **exit**; treat narration-only output as FAILED and reroute to another family |
| Sandboxed "push" landed on a local clone, not GitHub | Advisor verifies with unpiped `git ls-remote` against the real remote |
| Credentials copied into a sandbox "temporarily" to unblock a tool | Never copy credentials. Report and stop. Auth-blocked is a valid terminal state |
| Literal instruction unsatisfiable; agent invented a workaround that looked like control evasion | Charters specify **outcomes with fallbacks**, never bare mechanisms |
| A SHA written from memory into a durable document | Verify against `git log`/`ls-remote` before it lands. This happened while writing the register |

---

## 6. Charters — the advisor→operator interface

Everything the operator does comes from a written assignment containing, in order:

1. **Role restatement + reporting protocol.** Outcomes with fallbacks, never bare mechanisms:
   "deliver the report by running exactly this command" is unsatisfiable the moment the command
   fails for an environmental reason, and an agent escalating around it is indistinguishable
   from a control bypass. Name the record that must exist, attributed to whom, plus a fallback
   channel.
2. **Hard rules** — the invariants that cost hours when relearned.
3. **Tasks** — each with the reviewer's verdict quoted *verbatim*, the required fix shape, the
   required **observer** (a test that can see the defect *class*, not just the instance), and
   the required mutation proof.
4. **Gates** — exact commands; exit codes read unpiped; problem *counts* read, not colours;
   a control run against the base branch for pre-existing noise.
5. **Report format** — per task: final SHA, `ls-remote` push evidence, gate counts, mutation
   observations verbatim, review status, anything REJECTED with its evidence. Then stop.

Multiple operator sessions may run concurrently **only on disjoint branches and worktrees**,
and each charter names what the others are touching. This repo is worked by several agents at
once and the shared checkout is frequently not on `main` — see `AGENTS.md`.

---

## 7. Cadence

1. Advisor maintains `DEFECT-REGISTER.md` on `main` as the single source of truth.
2. Advisor writes a charter per wave; operator executes; executors fan out.
3. Every branch gets a cross-family review from an allowed model, bound to its exact SHA, and
   its CI must be green before merge. REQUEST CHANGES verdicts come back as prescriptions; the
   advisor turns them into the next charter, quoted verbatim, because paraphrase loses the
   constraint that mattered.
4. Advisor merges **only at approved heads with executed, non-zero-duration gates**, promotes
   at milestones, and verifies each promotion independently.
5. Expect 2–3 review rounds on anything hard. A deeper defect surfacing in round 2 is the
   system working, not failing.
