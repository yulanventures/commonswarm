# Hosted files and wiki for personal and project records

Date: 2026-10-01. Lane P3. Proposed design only.
This is a local source review. Runtime behavior, production state, vendor compatibility,
storage transfers, and purge completion are **not verified**.
The assignment permits only this document. No tests, service calls, or commits are part
of this lane. Source: `/Users/yulanbot/work/cswarm-vision/lanes/task-p3.md:2`.

## Purpose and boundaries

Files hold source documents. Wiki pages hold saved context, plans, and explanations.
Messages record decisions and handoffs between them. The target includes life admin
and business projects. Bookkeeping is an example of these primitives, not a required
accounting feature. Sources: `/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:5`,
`/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:7`,
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:15`.

Use “wiki” and “page” in the product. Existing `cswarm brain` commands remain the
engineering foundation. The roadmap makes this vocabulary change explicit.
[2026-09-11-PRODUCT-SHAPE-AND-VOCABULARY.md:17](2026-09-11-PRODUCT-SHAPE-AND-VOCABULARY.md#L17).

Everything labelled “proposal” below is new work. It grants no permission today.
The canonical specification still wins. Durable grants and mutations must use the
transactional command path, server-derived actors, and PostgreSQL state.
[AGENTS.md:34](../../AGENTS.md#L34),
[AGENTS.md:36](../../AGENTS.md#L36),
[AGENTS.md:39](../../AGENTS.md#L39), [SWARM-CLOUD.md:85](SWARM-CLOUD.md#L85).

## What files and the brain do in the checked-in source

### Files, limits, and versions

| Area | Source behavior and limit |
|---|---|
| Identity | Files belong to a workspace. They have a stable file ID, creator, current version, and tombstone. Names are unique without case within that workspace until purge. Versions record uploader, size, type, and timestamps. [20260818000001_file_artifacts.sql:5](../../supabase/migrations/20260818000001_file_artifacts.sql#L5), [20260818000001_file_artifacts.sql:26](../../supabase/migrations/20260818000001_file_artifacts.sql#L26), [20260818000001_file_artifacts.sql:30](../../supabase/migrations/20260818000001_file_artifacts.sql#L30). |
| Organization | Names are flat. The name rule rejects path separators, a leading dot or whitespace, and C0 controls. It permits up to 255 characters. No folder field exists in this file table. [file-artifacts.ts:110](../../supabase/functions/command/file-artifacts.ts#L110), [20260818000001_file_artifacts.sql:5](../../supabase/migrations/20260818000001_file_artifacts.sql#L5). |
| Upload | Create reserves a pending version and returns a signed upload path. Bytes go directly to Storage. Commit measures size and makes the version live. The object key uses workspace ID, file ID, and version number. [file-artifacts.ts:21](../../supabase/functions/command/file-artifacts.ts#L21), [file-artifacts.ts:724](../../supabase/functions/command/file-artifacts.ts#L724), [file-artifacts.ts:742](../../supabase/functions/command/file-artifacts.ts#L742), [file-artifacts.ts:911](../../supabase/functions/command/file-artifacts.ts#L911), [file-artifacts.ts:961](../../supabase/functions/command/file-artifacts.ts#L961). |
| Capacity | A version is capped at 25 MiB. A workspace is capped at 1 GiB and 500 unpurged names. Live and retired bytes count, as do declared pending bytes from the last three hours. Tombstoned names still count until purge. [file-artifacts.ts:52](../../supabase/functions/command/file-artifacts.ts#L52), [file-artifacts.ts:555](../../supabase/functions/command/file-artifacts.ts#L555), [file-artifacts.ts:668](../../supabase/functions/command/file-artifacts.ts#L668). |
| Version count | Ordinary names have a fixed cap of 20 live or unexpired pending versions. Brain names have a rolling window of 20 live versions and a separate pending cap. Retirement keeps old bytes. [brain-version-window.ts:14](../../src/protocol/brain-version-window.ts#L14), [brain-version-window.ts:82](../../src/protocol/brain-version-window.ts#L82), [file-artifacts.ts:646](../../supabase/functions/command/file-artifacts.ts#L646), [20260902000005_brain_version_window.sql:1](../../supabase/migrations/20260902000005_brain_version_window.sql#L1). |
| Create rate | Validated create attempts use fixed clock-hour buckets: 600 per identity and 2,000 per workspace. Refused creates can spend the bucket. The workspace ceiling does not provide per-person fairness. [file-artifacts.ts:56](../../supabase/functions/command/file-artifacts.ts#L56), [file-artifacts.ts:81](../../supabase/functions/command/file-artifacts.ts#L81), [file-artifacts.ts:91](../../supabase/functions/command/file-artifacts.ts#L91), [file-artifacts.ts:101](../../supabase/functions/command/file-artifacts.ts#L101). |
| Type and integrity | Declared MIME type and extension must pass `fileContentAllowed`. Use its policy constants for accepted-type lists. Commit refuses bytes larger than declared. SHA-256 remains an unverified client attestation. Content screening is not promised. [file-artifacts.ts:420](../../supabase/functions/command/file-artifacts.ts#L420), [file-artifacts.ts:920](../../supabase/functions/command/file-artifacts.ts#L920), [file-artifacts.ts:1019](../../supabase/functions/command/file-artifacts.ts#L1019), [SWARM-CLOUD.md:194](SWARM-CLOUD.md#L194). |

The Storage bucket limit is also declared in a migration. Whether that migration and
those exact limits are applied in production is **not verified** here.
[20260913000001_file_bucket_size_limit.sql:12](../../supabase/migrations/20260913000001_file_bucket_size_limit.sql#L12).

### Tombstones, restoration, and access

Tombstoning blocks new download URLs and keeps the name reserved. A human member may
tombstone any file. An agent must match the file's original agent creator. Restoration
uses that same actor rule. It refuses after the 30-day window or after purge has claimed
the contents. Existing download URLs expire on their own five-minute clock.
[file-artifacts.ts:620](../../supabase/functions/command/file-artifacts.ts#L620),
[file-artifacts.ts:1090](../../supabase/functions/command/file-artifacts.ts#L1090),
[file-artifacts.ts:1159](../../supabase/functions/command/file-artifacts.ts#L1159),
[file-artifacts.ts:1178](../../supabase/functions/command/file-artifacts.ts#L1178),
[file-artifacts.ts:1250](../../supabase/functions/command/file-artifacts.ts#L1250).

The purge function claims expired tombstones and pending uploads, then queues object
paths. It releases names while retaining metadata rows. Physical deletion uses a
best-effort queue drain after file commands. A purged row is not proof that every
storage copy or backup has been erased. Actual deletion and backup retention are
**not verified**.
[20260818000001_file_artifacts.sql:168](../../supabase/migrations/20260818000001_file_artifacts.sql#L168),
[20260818000001_file_artifacts.sql:187](../../supabase/migrations/20260818000001_file_artifacts.sql#L187),
[20260818000001_file_artifacts.sql:213](../../supabase/migrations/20260818000001_file_artifacts.sql#L213),
[file-artifacts.ts:1291](../../supabase/functions/command/file-artifacts.ts#L1291).

Human file listing uses a membership-gated view. Local agent reads are bound to their
principal's workspace. File commands currently bypass the ordinary per-scope gate.
These are workspace boundaries, not P2's proposed selected-record permissions.
[20260902000005_brain_version_window.sql:56](../../supabase/migrations/20260902000005_brain_version_window.sql#L56),
[read/index.ts:548](../../supabase/functions/read/index.ts#L548),
[command/index.ts:10843](../../supabase/functions/command/index.ts#L10843).

File-list reads and signed GET transfers are not audited per principal under the
documented contract. Download-URL creation is audited. URL issuance alone cannot prove
a completed read. [SWARM-CLOUD.md:194](SWARM-CLOUD.md#L194).

### Wiki pages and links

The brain maps a normalized topic to `brain--<topic>.md`. It lists those files in topic
order and excludes tombstones. Topics use the flat syntax in `canonicalBrainTopic`;
slash paths are not accepted. The maximum comes from `BRAIN_TOPIC_MAX_LENGTH`.
[brain.ts:21](../../src/cloud/brain.ts#L21), [brain.ts:34](../../src/cloud/brain.ts#L34),
[brain.ts:66](../../src/cloud/brain.ts#L66), [brain.ts:115](../../src/cloud/brain.ts#L115),
[brain-version-window.ts:10](../../src/protocol/brain-version-window.ts#L10).

The CLI can list, read, and write pages. A read can select `topic@version` or
`--version`. Explicit brain history reads can resolve retired versions. Writing with
`--if-version` uses an optional integer compare-and-set, checked at create and commit.
Unconditional writes remain possible. The canonical target of an opaque revision and
three-way merge is still separate work.
[cli.ts:10342](../../src/cli.ts#L10342), [cli.ts:10343](../../src/cli.ts#L10343),
[cli.ts:10344](../../src/cli.ts#L10344), [cli.ts:9115](../../src/cli.ts#L9115),
[file-artifacts.ts:1077](../../supabase/functions/command/file-artifacts.ts#L1077),
[file-artifacts.ts:635](../../supabase/functions/command/file-artifacts.ts#L635),
[file-artifacts.ts:861](../../supabase/functions/command/file-artifacts.ts#L861),
[SWARM-CLOUD.md:214](SWARM-CLOUD.md#L214).

The site presents a sorted page list, sanitized Markdown, raw text, history links, and
editing of the latest page.
[brain-view.ts:56](../../site/src/lib/brain-view.ts#L56),
[brain-view.ts:182](../../site/src/lib/brain-view.ts#L182),
[brain-view.ts:199](../../site/src/lib/brain-view.ts#L199),
[brain-view.ts:233](../../site/src/lib/brain-view.ts#L233).

Site saves send no base revision or `if_version`. A stale draft can become the latest
page without a version conflict check. The current pointer follows the highest live
version number, so commit arrival order alone does not choose the latest page.
[LiveDashboard.astro:4632](../../site/src/components/app/LiveDashboard.astro#L4632),
[commonswarm.ts:1195](../../site/src/lib/commonswarm.ts#L1195),
[file-artifacts.ts:1005](../../supabase/functions/command/file-artifacts.ts#L1005).
This leaves the canonical concurrency target unimplemented in the site save path.
[SWARM-CLOUD.md:214](SWARM-CLOUD.md#L214).

The history UI counts down through version numbers without querying version states.
An authoritative list of readable versions would be a better foundation for gaps.
[brain-view.ts:108](../../site/src/lib/brain-view.ts#L108).

Message text can open known brain topics. The scanner uses `BRAIN_SLUG_SEPARATORS` and
the inline-code rule for word-like names. It does not guess unknown topics.
[brain-links.ts:53](../../site/src/lib/brain-links.ts#L53),
[brain-links.ts:130](../../site/src/lib/brain-links.ts#L130),
[brain-links.ts:145](../../site/src/lib/brain-links.ts#L145).
Clicking refreshes the topic list and checks the active workspace before opening a page.
[LiveDashboard.astro:4765](../../site/src/components/app/LiveDashboard.astro#L4765).

Messages also have immutable, ordered attachments pinned to file versions in the same
workspace.
[20260901000010_signal_attachments.sql:12](../../supabase/migrations/20260901000010_signal_attachments.sql#L12),
[20260901000010_signal_attachments.sql:66](../../supabase/migrations/20260901000010_signal_attachments.sql#L66),
[20260901000010_signal_attachments.sql:72](../../supabase/migrations/20260901000010_signal_attachments.sql#L72).
Commit returns a `file:<id>@v<version>` reference.
[file-artifacts.ts:1022](../../supabase/functions/command/file-artifacts.ts#L1022).
These pinned references give a foundation for provenance. A general wiki backlink
graph is **not verified** in this review.

### MCP today

Local stdio MCP exposes `file_put` and `brain_put`. Both take a local absolute path and
request ID. `brain_put` also accepts `if_version`. Its schema caps topic text at 200
characters, separately from the brain helper's computed limit. The complete tool table
has no file or wiki list, get, or search tool. CLI reads do not imply MCP reads.
[src/mcp/tools.ts:24](../../src/mcp/tools.ts#L24),
[src/mcp/tools.ts:30](../../src/mcp/tools.ts#L30),
[brain-version-window.ts:12](../../src/protocol/brain-version-window.ts#L12).

Local uploads resolve the path, refuse private CommonSwarm state, and enforce the file
size cap. The adapter uses the profile's workspace and principal. It persists upload
intent, returns committed or replayed results, and can report an unknown outcome with
a same-request retry. Runtime execution of these paths is **not verified** here.
[src/mcp/server.ts:32](../../src/mcp/server.ts#L32),
[src/mcp/server.ts:69](../../src/mcp/server.ts#L69),
[src/mcp/server.ts:148](../../src/mcp/server.ts#L148),
[exact-file-put.ts:17](../../src/cloud/exact-file-put.ts#L17),
[exact-file-put.ts:109](../../src/cloud/exact-file-put.ts#L109),
[exact-file-put.ts:119](../../src/cloud/exact-file-put.ts#L119),
[src/mcp/server.ts:168](../../src/mcp/server.ts#L168).

The model selects the local source path. Protected-state blocking is not a source
allowlist or a P2 content-grant check. An injected instruction could select another
readable local file outside those protected roots. This is a current local MCP risk,
not only a hosted-transfer design concern. Exploit execution is **not verified** here.
[src/mcp/tools.ts:38](../../src/mcp/tools.ts#L38),
[src/mcp/server.ts:32](../../src/mcp/server.ts#L32),
[src/mcp/server.ts:152](../../src/mcp/server.ts#L152).

Hosted MCP exposes seat, messaging, identity, and roster tools. It has no file or wiki
tools. Hosted command and read capabilities have separate narrow allowlists. Adding
content schemas alone would not authorize hosted content operations.
[supabase/functions/mcp/tools.ts:28](../../supabase/functions/mcp/tools.ts#L28),
[hosted-seat-auth.ts:5](../../supabase/functions/_shared/hosted-seat-auth.ts#L5).

## Proposed system of record

### Separate spaces and useful paths

Follow P2: a personal workspace for each person, separate household workspaces, and
separate business workspaces. Until selected-record grants exist, share only chosen,
redacted snapshots into a separate destination workspace. Keep private source titles
and IDs out of shared provenance when they reveal excluded material. Agents also need
separate runtime context for private and shared work.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:60](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L60),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:73](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L73),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:86](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L86).

P3 proposal: add logical folders and page paths within each workspace. Paths organize
content. They confer no privacy by themselves. Use stable resource IDs beneath paths.
Keep display names separate from location and storage keys. Moves keep IDs, history,
and links. Preserve old page paths as aliases where the owner chooses. Refuse ambiguous
aliases and collisions. This extends the flat file and topic model above.
[20260818000001_file_artifacts.sql:5](../../supabase/migrations/20260818000001_file_artifacts.sql#L5),
[brain.ts:66](../../src/cloud/brain.ts#L66).

Synthetic examples are `travel/plans` in a personal wiki, `home/repairs` in a household
wiki, and `projects/launch` in a business wiki. Receipts and estimates can sit beside
the page that explains them. These are proposed examples, not valid current topic
arguments or shipped templates. P2 supplies the template boundaries.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:188](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L188).

### P2 content grants and access audit

Consume P2's contract. Bind each grant to its person, named recipient or connection,
workspace, selected records or folder, operations, expiry, and revocation. Keep read,
add, update or annotate, categorize, and export distinct. Folder grants select a
snapshot by default. History, future versions, and future folder members need explicit
inclusion. An external reviewer's default is selected material with expiring read-only
access. Export requires its own permission.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:222](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L222),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:227](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L227),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:243](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L243).

P3 proposal: materialize selected IDs and versions for snapshot grants. A move into a
folder must not silently enlarge a grant. Moving content out must not leave accidental
access through an old path. Reconcile explicit record grants and any approved following
folder grant in the command transaction. Show the access change before a move that
discloses new content. These rules implement P2's snapshot and future-content choices.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:231](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L231).

Use one permission registry across human, local-agent, hosted-agent, and storage routes.
Check permission on lists, search, previews, page reads, history, links, downloads, and
exports. A filtered tool must not be bypassed by broad membership, a legacy file command,
or direct Storage access. Do not admit a selected-record external collaborator as a
full source-workspace member. Current membership exposes workspace content.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:236](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L236),
[SECURITY.md:43](../../SECURITY.md#L43),
[command/index.ts:10843](../../supabase/functions/command/index.ts#L10843).

Sensitive external byte access needs an authenticated transfer route. Recheck the grant
when bytes are requested. Record attempted, refused, authorized, and completed operations
separately. Stop subsequent requests and queued exports on revocation. Define and measure
in-flight behavior. No grant can retract bytes already delivered. Issuing a URL cannot
stand in for a completed-transfer audit.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:249](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L249),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:259](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L259),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:265](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L265).

### Search and links

P3 proposal: begin with exact path, title, and authorized text search. Return stable IDs,
versions, source location, and bounded excerpts. Filter entitlement before ranking,
counts, snippets, or backlink expansion. Historical search requires history permission.
Remove withdrawn content from derived indexes and recheck every result at retrieval.
OCR, extraction coverage, and semantic retrieval are **not verified** today. Semantic
recall is an H2 proposal. Any processor receiving source text needs a separate disclosed
review. Sources: [2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:237](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L237),
[2026-09-04-ROADMAP-DRAFT.md:110](../org/2026-09-04-ROADMAP-DRAFT.md#L110),
[SWARM-CLOUD.md:267](SWARM-CLOUD.md#L267).

P3 proposal: links carry workspace, resource ID, and either an exact version or an
explicit latest selector. Evidence and shared snapshots pin versions. Navigation may
follow latest. Wiki pages can cite messages and files. Messages can cite pages. Files
can show authorized referring messages and pages. Resolve both ends before returning
titles or snippets. A link grants no access. Hidden sources get no identifying label
or count. Tombstones preserve a permitted unavailable state rather than redirecting
an old link to a new file that reuses the name.
Sources: [20260901000010_signal_attachments.sql:12](../../supabase/migrations/20260901000010_signal_attachments.sql#L12),
[20260818000001_file_artifacts.sql:213](../../supabase/migrations/20260818000001_file_artifacts.sql#L213),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:240](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L240).

### Export, retention, and sensitive intake

Follow P2's stricter intake rule. Store no full card numbers, full account numbers,
credentials, or government IDs. Minimize and redact uploads, extracted text, messages,
pages, previews, and exports. Use synthetic records for evaluation. This supersedes
the memo's proposed exception for some identifiers.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:277](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L277),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:284](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L284).

P3 proposal: owner export includes authorized original files, Markdown pages, selected
history, messages, and a portable manifest. Preserve IDs, paths, timestamps, uploader,
source versions, review status, redaction notes, and links. Recheck grant permission at
request, generation, and retrieval. Cancel pending work on revocation. Expire temporary
packages. Keep private source mappings private. Round-trip import must preserve links
without importing credentials or permission grants.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:319](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L319).

P3 proposal: retention choices distinguish current bytes, retired history, pending
uploads, extracted text, indexes, export packages, metadata, immutable history, and
backups. Define policy by workspace and record class. Keep the existing limits until
a reviewed capacity policy changes them. Do not invent retention durations. Show
tombstoned, queued for purge, physically deleted, and backup expiry as separate facts.
Account closure needs an export and shared-ownership procedure. Complete export,
closure, and lifecycle coverage are **not verified** today.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:298](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L298),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:311](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L311),
[file-artifacts.ts:52](../../supabase/functions/command/file-artifacts.ts#L52).

Signals and audit records cannot be edited or deleted through the application.
[SECURITY.md:46](../../SECURITY.md#L46).
Replacing a page or retiring a version is not erasure. Keep raw sensitive content
out of immutable messages and audit. Retired versions keep their storage objects.
[20260902000005_brain_version_window.sql:1](../../supabase/migrations/20260902000005_brain_version_window.sql#L1).

## Proposed brain upgrade

The roadmap proposes brain search and human-accepted distillation. This lane also
requires topic paths, index pages, and backlinks. Those details are proposed here;
their implementation is **not verified**. Sources:
[2026-09-04-ROADMAP-DRAFT.md:107](../org/2026-09-04-ROADMAP-DRAFT.md#L107),
`/Users/yulanbot/work/cswarm-vision/lanes/task-p3.md:3`.

| Slice | P3 proposal |
|---|---|
| Topic paths | Introduce page IDs and canonical logical paths. Keep existing flat slugs readable. Map legacy `brain--` files without flattening new slash paths into ambiguous names. Share the path policy across CLI, site, and MCP. Moves retain IDs and aliases. Current flat mapping: [brain.ts:66](../../src/cloud/brain.ts#L66). |
| Index pages | Give each selected folder or topic branch an index. Derived child lists show only authorized content. Human or agent prose is an ordinary versioned page. A generated list must not overwrite authored prose. P2's visibility rules apply to both. [2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:237](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L237). |
| Backlinks | Derive outgoing edges and incoming references from committed page versions and message attachments. Store enough source identity to rebuild the index. Resolve access at query time. Exclude code blocks and unrelated URLs from mention scanning. Preserve the current scanner's no-guessing rule and shared separator constant during migration. [brain-links.ts:53](../../site/src/lib/brain-links.ts#L53), [brain-links.ts:91](../../site/src/lib/brain-links.ts#L91), [20260901000010_signal_attachments.sql:12](../../supabase/migrations/20260901000010_signal_attachments.sql#L12). |
| History and editing | Return actual version rows and states. Require a base revision for edits to existing pages. Preserve a losing draft and return a conflict with an authorized current revision. Keep the interim integer check until the canonical opaque revision and merge contract is implemented. [SWARM-CLOUD.md:214](SWARM-CLOUD.md#L214), [brain-view.ts:108](../../site/src/lib/brain-view.ts#L108). |
| Recall and distillation | Add semantic recall only after access filtering and lifecycle rules. Distillation proposes pending trusted content for human review. Pending items stay absent from agent reads, search, digests, and notifications. Do not bank whole private transcripts by default. [2026-09-04-ROADMAP-DRAFT.md:111](../org/2026-09-04-ROADMAP-DRAFT.md#L111), [SWARM-CLOUD.md:258](SWARM-CLOUD.md#L258), [2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:288](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L288). |

Ordinary wiki text is tool data. An agent writing a page cannot grant permission or
activate trusted instructions. Accepted instruction content keeps its separate human
state machine. The canonical structural wiki is also a distinct proposed source map,
with static extraction, exact source SHA, and source-read entitlement. A personal page
index must not be described as that generator.
[SWARM-CLOUD.md:256](SWARM-CLOUD.md#L256), [SWARM-CLOUD.md:262](SWARM-CLOUD.md#L262),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:330](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L330).

## Proposed agent access through MCP

Use the same content contract for local stdio and hosted MCP. Keep admin permission
separate. Bind hosted content calls to the consented connection, workspace, and seat.
Seats under an account-shared connector do not isolate chats. If the host cannot isolate
private and shared contexts, omit private content from that connector. Current vendor
isolation is **not verified**.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:94](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L94),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:166](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L166),
[2026-10-01-AGENT-ONBOARDING-MATRIX.md:191](2026-10-01-AGENT-ONBOARDING-MATRIX.md#L191).

The following names are proposed tool sketches. They are not accepted tools or scopes.
Generate schemas, help, and consent from the reviewed content registry. Keep existing
local path inputs only for sources approved by the person's runtime policy. Apply P2
destination grants to those uploads and add a hosted route that needs no worker disk.
An absolute path alone grants no permission to disclose its bytes. Sources:
[src/mcp/tools.ts:38](../../src/mcp/tools.ts#L38),
[src/mcp/server.ts:32](../../src/mcp/server.ts#L32),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:236](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L236).

| Proposed tool | Inputs and result |
|---|---|
| `content_list` | Authorized path, type filter, and opaque cursor. Return a bounded page of IDs, current versions, and next cursor. Reveal no excluded names or counts. |
| `file_read` | File ID, authorized version, and bounded range or opaque transfer handle. Return metadata and safe text chunks where supported. Transfer binary bytes outside model text through the authenticated runtime route. |
| `file_upload_begin`, `file_upload_commit` | Request ID, destination, name, declared type and size, and base revision for replacement. Bind an opaque upload handle to the actor, grant, object, and limits. Transfer through an authorized client attachment or runtime stream. Commit only after storage and grant checks. |
| `wiki_get`, `wiki_put` | Page ID or path and optional read version. Writes take bounded UTF-8 Markdown, request ID, and base revision. Return the committed ID, version, path, and conflict status. |
| `content_search`, `content_links` | Bounded query or source reference, permitted history selection, and cursor. Return only authorized snippets and edges with source versions. |
| `content_export` | Explicit selection and approved destination. Return pending, completed, refused, or failed job state. A completed job offers an opaque retrieval handle, not a bearer URL in model text. |

These sketches implement P2's required coverage of reads, writes, search, history,
byte access, and export. P3 proposes the handles and chunked schemas to replace local
paths in hosted calls. Exact payload and transfer bounds need reviewed constants.
Keep result truncation explicit. The current local MCP result cap is 32 KiB.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:227](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L227),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:237](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L237),
[src/mcp/tools.ts:15](../../src/mcp/tools.ts#L15),
[src/mcp/tools.ts:117](../../src/mcp/tools.ts#L117).

P3 proposal: never interpret a hosted path as a path on the server. Do not fetch an
arbitrary model-supplied URL to ingest a file. Use an authenticated attachment or stream
adapter. Keep signed upload material in the runtime. Check the grant before starting,
committing, and retrieving. Attribute each write to the human owner and acting agent.
Persist upload and export attempts in PostgreSQL so a hosted retry needs no process
memory. These extend the existing two-phase upload and local retry foundation.
[file-artifacts.ts:21](../../supabase/functions/command/file-artifacts.ts#L21),
[src/mcp/server.ts:148](../../src/mcp/server.ts#L148),
[exact-file-put.ts:109](../../src/cloud/exact-file-put.ts#L109),
[exact-file-put.ts:119](../../src/cloud/exact-file-put.ts#L119), [AGENTS.md:39](../../AGENTS.md#L39).

P3 proposal: the agent reads the current page and source records, makes a bounded change,
and writes against that revision. A conflict preserves the draft. A lost result retries
with the same request and content. Report uploaded, committed, replayed, pending, refused,
or unknown as distinct outcomes. A subsequent message may cite the committed reference;
it never substitutes for commit evidence. Treat all retrieved instructions as content.
[src/mcp/server.ts:164](../../src/mcp/server.ts#L164),
[SWARM-CLOUD.md:215](SWARM-CLOUD.md#L215),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:330](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L330).

## Phased build list sized in lanes

Sizes below describe relative scope. They are not duration or capacity estimates.
The memo limits concurrent implementation to two lanes and places hosted content after
the admin foundation. The later vision starts Lane A immediately beside HM37.
This P3 design adds no HM37 work. Sources:
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:211`,
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:257`,
`/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:8`.

| Phase and lane | Size and dependency | Bounded proposed output | Future exit evidence |
|---|---|---|---|
| Contract: content boundary | Medium. Consume P2 and Lane A review. | Canonical amendment for content grants, operations, snapshot and history choices, intake, byte revocation, retention, and export. Reconcile the current file-scope exemption. | One approved registry and consistent consent. Local, human, hosted, and Storage routes are enumerated. |
| Foundation: content authorization | Medium. Depends on contract. | Grant decisions and reducer projections, filtered metadata and version reads, expiry, revocation, and owner-visible access audit. | Authorized reads pass alongside refused foreign-person, expired, revoked, and excluded-history probes. Audit failure refuses sensitive disclosure. |
| Foundation: hosted transfers | Medium. After authorization; pair with MCP reads. | Runtime upload handles, commit verification, authenticated byte retrieval, durable attempts, and transfer audit. Retain current upload ceilings. | Lost responses and concurrent retries create no duplicate version. Revocation blocks later transfers. Audit separates URL issuance from bytes delivered. |
| Access: MCP content reads | Small. Depends on authorization. | Local and hosted list, page read, version read, and bounded file retrieval through the shared registry. | A named client reads the permitted record and cannot reveal excluded titles, history, or counts. |
| Access: MCP content writes | Medium. Depends on transfers and reviewed write policy. | Local and hosted wiki writes and attachments, base revisions, attribution, retries, and truthful status. Local sources require runtime approval; destinations require P2 grants. | An agent reads, edits, commits, and cites a synthetic record. Stale edits preserve drafts. Local path uploads pass for approved sources and destinations and refuse excluded sources or destinations. |
| Organization: paths and index pages | Medium. Depends on authorization; pair with link work. | Stable page and folder IDs, path policy, legacy slug mapping, moves, aliases, and authorized child indexes. | Old links still resolve. Collisions fail clearly. Moves do not enlarge snapshot grants or reveal another person's page. |
| Organization: links and lexical search | Medium. Depends on IDs and content authorization. | Versioned references, rebuildable backlinks, authorized text extraction, and exact path or text search. | Results retain provenance. Hidden titles, counts, snippets, and references stay hidden. Tombstones and revocation remove derived access. |
| Lifecycle: portable export | Medium. Depends on filtered reads and links. | Manifest, files, Markdown, selected history, redaction notes, job states, expiry, and round-trip import. | A synthetic export restores authorized links and provenance. Revocation cancels a pending export and blocks later retrieval. |
| Lifecycle: retention and closure | Medium. Depends on lifecycle contract and export. | Scheduled purge drain, retired-version policy, derived-data removal, deletion receipts, backup policy, and shared-account closure. | Evidence distinguishes queued deletion from removed bytes and retained history. Backup expiry is measured separately. |
| Recall: semantic search and distillation | Separate later medium lanes. Depends on privacy, extraction, and lifecycle. | Reviewed processor boundary, semantic retrieval, and human review of pending trusted content. | Recall respects version and grant selection. Pending suggestions never appear in model-facing results. |

The sequence implements P2's order of grants, byte checks, audit, hosted content, and
lifecycle. It also consumes the roadmap's recall proposal. Those are future checks,
not tests run by this documentation lane.
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:357](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L357),
[2026-09-04-ROADMAP-DRAFT.md:107](../org/2026-09-04-ROADMAP-DRAFT.md#L107).

## Review dependencies for HezLead

The administration drafts disagree. Lane A includes future owned workspaces in its
full-account option. P2 excludes future spaces until explicit selection. Lane A permits
routine member invitations and worker provisioning inside a grant. P2 requires each
such action to have human confirmation. P1 also differs from Lane A on withdrawal of
provisioned worker access. These are unresolved proposed contracts, not conflicting
measurements of production. P3 makes no admin-policy choice. Resolve them before
implementing permission inheritance or content provisioning.
[2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:136](2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md#L136),
[2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:215](2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md#L215),
[2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:219](2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md#L219),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:124](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L124),
[2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:139](2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md#L139),
[2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:78](2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md#L78),
[2026-10-01-AGENT-ONBOARDING-MATRIX.md:260](2026-10-01-AGENT-ONBOARDING-MATRIX.md#L260).

HezLead must arrange independent review and settle the content registry, transfer
revocation boundary, capacity, retention, and processor choices before implementation.
The supplied task requests a design and a lane-sized build list. It authorizes no
implementation, deployment, or HM37 changes.
`/Users/yulanbot/work/cswarm-vision/lanes/task-p3.md:2`.
