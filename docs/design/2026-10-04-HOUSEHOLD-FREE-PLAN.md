# Household free plan

2026-10-04. Proposal for Tom and HezLead. Prepared on 2026-10-03.

Keep the generous allowances in household hub v1 section 4. Add durable call
limits and daily content budgets before offering hosted object editing.
Two humans with two Muse agents, two Dot agents, Claude, and Codex use six agent
seats. Hosted seats are connections to agents. CommonSwarm does not run or pay
for their models.

Source inspected: `38986a9aa6c2fd8d92ee138efc87f6fe48921a69`. This is newer than
the baseline in `docs/design/2026-10-03-HOUSEHOLD-HUB-V1.md:8`.
The household core and persistence adapter now exist. The store and legacy
adapter factories are used only by tests in this checkout
(`tests/p1-server/household-storage.test.ts:53`, `tests/household-legacy-adapter.test.ts:99`).
They are not wired into `supabase/functions/command/index.ts`. Unified household
quota enforcement still needs that integration. Live enforcement is **not verified**.
The adapter asks lane 4 to supply the core and
credential recheck (`supabase/functions/command/household-objects.ts:1`).
The current hosted allowlists contain coordination tools only
(`supabase/functions/_shared/hosted-seat-auth.ts:5`).

`docs/design/SWARM-CLOUD.md` remains canonical. Its section 8 requires bounded
resource creation and a signup breaker. Its old hosted Supabase bill of materials
is historical. This estimate uses the box and R2 topology in `AGENTS.md:192`.
No tests, production probes, account access, or commits ran for this document.
Only public vendor pricing pages and their public price resources were fetched.

## Proposed allowances

These are proposed product promises. “Today” means source inspection, not proof
that the code is live. The last column is proposed plain user copy. Existing
errors can be narrower. Generate numbers and help from the enforcing policy.

| Resource | Proposed free limit | Today and required work, file:line | What the user sees at the limit |
|---|---|---|---|
| Owned workspaces | 10 live per verified person. Joined workspaces do not use this allowance. | `FREE_TIER_WORKSPACE_LIMIT` is 10 at `supabase/functions/command/index.ts:823`. Creation counts unarchived workspaces by creator at `supabase/functions/command/index.ts:5225`. CLI recovery copy exists at `src/cloud/command-client.ts:511`. | “You have 10 open workspaces. Close one before creating another. You can still join an existing workspace.” |
| Human members | 25 per workspace, including outstanding human invitations. | `supabase/functions/command/index.ts:850`, `supabase/functions/command/index.ts:8273` counts members plus ordinary and delegated pending invitations. | “All 25 human places are in use. Cancel an unused invitation or remove a member before inviting someone else.” |
| Local and hosted agents combined | 50 live principals per workspace. | `supabase/functions/command/index.ts:851`, `supabase/functions/command/index.ts:5840`, `supabase/functions/command/index.ts:10301`. Unexpired join registrars count too. Expired or revoked registrars do not. | “All 50 agent places are in use. Revoke an unused agent or join link before adding another.” |
| Hosted agent seats | 10 live per connector grant across its workspaces. Included in the 50 above. | `src/protocol/hosted-authority.ts:8`, `src/protocol/hosted-authority.ts:359`; grant-wide count at `supabase/functions/command/index.ts:10215`. This is not 10 per household or per human. | “This connection has 10 live seats. Reuse an existing seat or revoke an unused one.” |
| Agent join links | 5 live per person per workspace; 20 per workspace; 10 registrations per link; 24-hour maximum life. | `src/protocol/agent-join-limits.ts:12`, `src/protocol/agent-join-limits.ts:21`; checks at `supabase/functions/command/index.ts:6929`, `supabase/functions/command/index.ts:6561`. A link also uses one registrar principal, not 10 reserved seats (`supabase/functions/command/index.ts:6912`). | “You have too many active join links. Revoke an unused link or wait for it to expire. A full link needs a new link.” |
| Household objects | 500 total names across lists, docs, files, and brain topics. Tombstones hold their names until purge. | `src/protocol/household-object-policy.ts:2`; core refusal at `src/protocol/household-objects.ts:339`. Legacy cap is `supabase/functions/command/file-artifacts.ts:54`, `supabase/functions/command/file-artifacts.ts:673`. Integrate the adapter and reconcile legacy plus household counts (`supabase/functions/command/household-objects.ts:204`). | “This workspace has 500 objects or reserved names. You can edit existing objects. A deleted name becomes available after its purge.” |
| Object revisions and history | 20 live revisions per object. Older committed revisions stay readable while retained. No automatic history deletion to make room. | `src/protocol/household-object-policy.ts:5`; full-history reads at `src/protocol/household-objects.ts:558`. Adapter retires older revisions at `supabase/functions/command/household-objects.ts:259`. Legacy files stop at 20 live plus pending versions; brain topics roll 20 live (`src/protocol/brain-version-window.ts:96`). Legacy retired-byte reads require an explicit brain version (`supabase/functions/command/file-artifacts.ts:1078`). Extend all routes before promising parity. | “Older revisions are in history. They still use storage. If storage is full, the next revision cannot be saved.” |
| Storage | 1,073,741,824 bytes, or 1 GiB, per workspace. Count current and retired revisions, tombstones awaiting purge, pending declarations, and preserved conflict drafts. | `src/protocol/household-object-policy.ts:3`; usage at `src/protocol/household-objects.ts:148`, quota at `src/protocol/household-objects.ts:362`. Legacy live, retired, and recent pending declarations count at `supabase/functions/command/file-artifacts.ts:548`. Integrate one locked total across both paths; no second free allowance. | “This change does not fit in your 1 GiB storage. Existing content and history remain readable. Export and review what to remove. Deletion frees space only after purge.” |
| Bytes per file or object revision | 26,214,400 bytes, or 25 MiB. | `src/protocol/household-object-policy.ts:4`; adapter checks content at `supabase/functions/command/household-objects.ts:149`. Legacy refusal at `supabase/functions/command/file-artifacts.ts:504`; Storage upload bound at `supabase/migrations/20260913000001_file_bucket_size_limit.sql:13`. Hosted protected transfer integration remains required. | “This revision exceeds 25 MiB. Split or reduce it before trying again.” |
| Upload and object write attempts | 600 per human identity or agent principal per clock hour; 2,000 per workspace per clock hour. | Identity limit at `src/protocol/household-object-policy.ts:6`; workspace limit at `src/protocol/household-object-policy.ts:7`. Adapter buckets at `supabase/functions/command/household-objects.ts:131`, `supabase/functions/command/household-objects.ts:164`. Legacy buckets at `supabase/functions/command/index.ts:11715`. Validated refusals can count. Exact settled replays do not. Unified object-write enforcement needs command-path integration. Ensure both clients use the same buckets. | “Too many changes were attempted this hour. Your change was not saved. Retry after the displayed reset time.” |
| Signals or messages per day | Derived planning maximum of 24,000 per workspace per UTC day. Retain enforced limits of 1,000 per workspace per clock hour and 120 per credential per clock hour. | Credential constant at `supabase/functions/command/index.ts:699`; workspace constant at `supabase/functions/command/index.ts:700`. Hourly checks at `supabase/functions/command/index.ts:5523`, `supabase/functions/command/index.ts:5536`. No daily signal counter exists in `enforceSignalRate`; 24 hourly buckets × 1,000 gives the planning maximum. Add a durable daily usage display; the refusal comes from an hourly or ask bucket. Keep agent ask gates of 20/minute and 6 per agent sender-recipient pair per 10 minutes (`src/cloud/ask-chain-constants.ts:8`, `src/cloud/ask-chain-constants.ts:11`; sender enforcement at `supabase/functions/command/index.ts:5553`, pair enforcement at `supabase/functions/command/index.ts:5574`). | “This message was not sent. Wait until the displayed reset time. Existing messages and objects remain available.” |
| Other content events per day | 100,000 new content events per workspace per UTC day, including signals and object command events. | Proposed ceiling is 24,000 signals + 48,000 hourly-bounded object attempts + 28,000 event headroom. This is a policy budget, not measured demand. Add a transactional day counter before content mutations. Object decisions emit events at `src/protocol/household-objects.ts:252`; hourly write checks at `src/protocol/household-objects.ts:326` do not cap every event route. Exclude recovery, revocation, ACKs, and renewal from this content budget. | “This workspace has reached today's change limit. New changes resume at 00:00 UTC. You can still read, export, and manage access.” |
| Hosted MCP calls per minute | 60 per seat; 300 per workspace; 120 per human owner across that owner's grants and seats. Fixed UTC minute buckets. | New durable counters required after authenticated binding and before tool work at `supabase/functions/mcp/index.ts:190`. Seatless calls charge grant and owner, with a 60-call grant bucket, plus workspace. Current guard is four concurrent requests per handler by default (`supabase/functions/mcp/index.ts:82`, `supabase/functions/mcp/protocol.ts:239`). It is not a minute quota. Proposed sizing: six seats × 10 calls/minute = 60; workspace headroom is 5 × 60. Owner headroom is 4 × three seats × 10. Capacity at these rates is **not verified**. | “Too many calls were made. Retry after the displayed reset time. Your agent is still connected.” |
| Workspace creation and invitations | 20 workspace creations and 10 issued human invitations per person per rolling day. | Creation limit at `src/protocol/admin-policy.ts:13`; invitation limit at `src/protocol/admin-policy.ts:14`. Shared human limits at `supabase/functions/command/index.ts:836`, `supabase/functions/command/index.ts:842`. Creating a link does not deliver an email (`supabase/functions/command/index.ts:869`). | “You have reached today's creation or invitation limit. Existing workspaces still work. Retry after the displayed reset time.” |

Brain topics use the file namespace (`src/cloud/brain.ts:66`). They share the
object, byte, version, and upload budgets. They do not have a separate free pool.
Hourly bounds permit bursts across an hour boundary. The write budgets are
attempt limits, not smooth rates or equal shares between humans.

Add the minute limits to the reviewed policy registry. Share them across edge
processes in PostgreSQL. Protect human recovery and essential reads from another
member's traffic. Preserve the canonical distinction between resource creation
caps and teammate-facing soft limits (`docs/design/SWARM-CLOUD.md:490`).
Use owner limits to throttle the source of excess traffic. A workspace aggregate
must not lock out an innocent member's read, export, or revoke operation.
At the daily event ceiling, return a bounded refusal before appending another
content event. Count rejection events inside the budget. Do not let repeated
refusals bypass it. These changes are proposed, not implemented.

At quota, keep the local or host draft available. A new durable conflict draft
also needs space (`src/protocol/household-objects.ts:278`). Do not claim a draft
was retained if that reservation failed. Show used bytes, reserved bytes, and the
actual recovery path. Household purge, quota screens, hosted transfer parity, and
end-to-end recovery are **not verified**. Do not suggest buying an upgrade before
one exists.

## Estimated monthly cost per active household

Prices checked on **2026-10-03**. Use R2 Standard. It costs $0.015/GB-month,
$4.50/million Class A operations, and $0.36/million Class B operations. Direct
R2 egress is free. Monthly included usage is 10 GB-month, one million A, and ten
million B. Billing rounds up storage and operation units.
Source: [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The [Hetzner regular-performance pricing page](https://www.hetzner.com/cloud/regular-performance/)
identifies CPX42 as `CLOUD_128` and combines it with IPv4 `CLOUD_21`.
Its [public price data](https://www.hetzner.com/_resources/app/data/app/live_data_prices.json)
lists FSN1 monthly CPX42 at **$81.99 or €69.49**, and IPv4 at **$0.60 or €0.50**.
Use **$82.59 = $81.99 + $0.60** per month before tax.
These are public list prices, not the box invoice. Invoice, discounts, tax,
backup charges, and actual capacity are **not verified**. No currency conversion
is assumed. The data also lists EU excess traffic at $1.20/TB. The pricing page
includes 20 TB. Traffic available after other products is **not verified**.

Every number below is an **estimate**. Inputs describe a planning household,
not observed customer usage. Assume 30 days, one active shared workspace,
six agents, five stored revisions per agent per day, and 40 reads per agent per
day. Assume an average of 0.25 GiB retained, including history and drafts.
Budget one extra full stored copy for backups. Double operations for that copy
as a simple reserve. Actual backup retention and Storage call amplification are
**not verified**. They must replace these inputs after a pilot.

| Estimated component | Formula | Monthly estimate |
|---|---|---|
| Box share | $82.59 × 50% CommonSwarm allocation ÷ 100 active households | $0.41295 |
| R2 stored bytes with one extra copy | 0.25 GiB × 1.073741824 GB/GiB × 2 copies × $0.015 | $0.00805306 |
| R2 Class A with copy reserve | 6 agents × 5 revisions/day × 30 days × 1 A/revision × 2 × $4.50/1,000,000 | $0.00810 |
| R2 Class B with copy reserve | 6 agents × 40 reads/day × 30 days × 2 B/read × 2 × $0.36/1,000,000 | $0.010368 |
| Allocated total before shared free usage and rounding | $0.41295 + $0.00805306 + $0.00810 + $0.010368 | $0.43947 |
| Total at the full 1 GiB allowance, same operations | $0.41295 + (1 × 1.073741824 × 2 × $0.015) + $0.00810 + $0.010368 | $0.46363 |

The 50% box share and 100 households are explicit allocation assumptions.
They are not measurements of CPU or memory use. With the same allocation,
10 households cost $82.59 × 0.5 ÷ 10 = **$4.1295 estimated box share each**.
At 1,000 they cost $82.59 × 0.5 ÷ 1,000 = **$0.041295 each**, only if the box can
serve them. Capacity for either population is **not verified**. Assigning the
whole box doubles the box component. This is allocated cost. Additional cash
cost can stay small until a capacity upgrade is needed.

For the actual pooled R2 estimate, let S be total GB-month, A total Class A calls,
and B total Class B calls across the billing account. Include other products and
backups. Estimated bill in USD is:

`0.015 × ceil(max(S - 10, 0)) + 4.50 × ceil(max(A - 1,000,000, 0) / 1,000,000) + 0.36 × ceil(max(B - 10,000,000, 0) / 1,000,000)`.

Do not give each household the account's free allowance. With no other usage,
100 example households have S = 100 × 0.25 × 1.073741824 × 2 = 53.6870912,
A = 180,000, and B = 2,880,000. Estimated pooled R2 bill is
$0.015 × ceil(53.6870912 - 10) = $0.66.
Estimated box plus pooled R2 share is ($82.59 × 0.5 + $0.66) ÷ 100 = **$0.41955**.
Available free usage is **not verified**. The unrounded allocation table is a
planning estimate, not an invoice or maximum bill.

Multiple workspaces multiply storage and traffic. Ten full workspaces imply
10 × 1 GiB × 2 copies × 1.073741824 × $0.015 = **$0.32212 estimated storage/month**
before shared free usage and rounding. Operations need their own totals.
MCP call limits bound bursts. They do not make this workload a worst-case bound.
At 24,000 signals/day, 30 days produce 720,000 signals per workspace.
Database event size, index overhead, audit retention, CPU, and memory are
**not verified**. They can require a larger box before R2 is expensive.

Box traffic overage estimate is `max(total outgoing TB - 20, 0) × $1.20`.
Measure box-mediated downloads too. Free R2 egress does not make the box path
free of bandwidth or CPU cost. No per-call hosted Supabase or function bill is
assumed on this self-hosted stack. Human operations cost needs a separate
estimate: `support hours/month × loaded hourly cost ÷ active households`.
Those inputs, domain allocation, and other shared service costs are **not verified**.
Vendor model subscriptions are paid by each human and are outside this estimate.

## Spend breaker

Keep the existing durable signup breaker. It counts accepted global operations
in clock-hour buckets. It trips when a total is greater than a ceiling:
100 workspace creations, 400 issued invitations, 20,000 signal posts, or 1,000
agent-token mints (ceiling table at `supabase/functions/command/index.ts:904`;
strict greater-than trip check at `supabase/functions/command/index.ts:5674`).
Those are proxies for unusual load. They are not dollar thresholds.
The complete metered set is workspace creation, invitation issuance, signal
posting, and agent-token minting (`supabase/functions/command/index.ts:898`,
`supabase/functions/command/index.ts:904`). Creation and signals are charged in
their handlers (`supabase/functions/command/index.ts:5333`,
`supabase/functions/command/index.ts:11612`). The shared accepted-command path
charges only invitations and token mints (`supabase/functions/command/index.ts:943`,
`supabase/functions/command/index.ts:12673`). Delivered emails, file bytes, reads,
hosted calls, object revisions, and vendor model charges have no proxy in that set.

The trip writes `swarm.spend_breaker` and one `spend_breaker_tripped` row in
`swarm.security_alerts` (`supabase/functions/command/index.ts:5613`).
An operator can inspect the open trip through the status view
(`supabase/migrations/20260728000001_spend_circuit_breaker.sql:210`).
Push, email, and human receipt of that alert are **not verified**.
Before household launch, add delivery to HezLead and the assigned operations
worker, with acknowledgment and safe counts only. Do not introduce agent
listeners or model-based monitoring.

The next verified self-serve workspace creator receives `503 signup_paused`
with a retry-later explanation (`supabase/functions/command/index.ts:5220`,
`supabase/functions/command/index.ts:5767`). Existing workspaces keep their ordinary signals, invitations, tokens,
and reads, subject to normal quotas. Proposed household reads and editing must
continue under their own limits. Recovery, exports, revocation, and renewal must
remain available. A trip does not delete content or disconnect everyone.

The latch stays open after the hour ends. An authorized operator clears it with
`swarm.reset_spend_breaker(who, why)`. Clearing does not reset hourly counters
(`supabase/migrations/20260728000001_spend_circuit_breaker.sql:143`, `supabase/migrations/20260728000001_spend_circuit_breaker.sql:147`).
Investigate the source of excess load before clearing it.

Add authenticated object-write, transfer-byte, and hosted-call totals alongside
the current proxies. Derive aggregate trip thresholds from pilot usage and
capacity measurements. No numeric thresholds for those proxies are justified
yet. Keep tenant and owner throttles independent of signup pause. Failed
anonymous requests must never open the global latch (`supabase/functions/command/index.ts:879`).
Signup pause alone cannot cap spending from existing households. Storage quotas,
call limits, measured retention, and operator notification are required too.

## Decision

**Recommend:** Approve the proposed generous allowances in the table, including 500 objects and 1 GiB per workspace; retain existing hourly signal and legacy upload limits; require unified household quotas, new daily content-event and MCP minute counters, and measured launch gates before hosted object editing.

**Closest lower alternative:** Keep all recommended limits except 250 objects and 512 MiB; estimated full-quota storage with one copy reserve is 0.5 × 1.073741824 × 2 × $0.015 = $0.01611/month, with less room for history.

**Closest higher alternative:** Keep all recommended limits except 1,000 objects and 2 GiB; estimated full-quota storage with one copy reserve is 2 × 1.073741824 × 2 × $0.015 = $0.06442/month, with database capacity still not verified.
