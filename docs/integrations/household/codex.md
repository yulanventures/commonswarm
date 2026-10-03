# Connect Codex to your household

Checked 3 October 2026. OpenAI documents remote MCP configuration for Codex.
CommonSwarm remote OAuth in Codex is **NOT VERIFIED**.
**Measured, historical:** a local MCP run completed identity, inbox checks,
a note, and a reply. It proves that recorded route, not fresh household setup
or cloud Dot access. [Codex host evidence](../../evidence/2026-09-23-mcp-lane2/production-control/codex-host-run.txt).

**Measured** labels cite stored evidence and say what it proves.
**Documented by vendor** labels cite official instructions.
**NOT VERIFIED** labels identify steps or behavior still awaiting a host check.
No connection was made while writing this guide.

## Connect through remote MCP

1. **NOT VERIFIED for this household:** open [CommonSwarm /app](https://commonswarm.com/app)
   yourself. Sign in with your own account. Confirm household membership.
   Each person connects their own Codex.
   [Household plan](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#2-a-second-human-joins).

2. **Documented by vendor:** add this public configuration to your own
   `~/.codex/config.toml`. Preserve existing settings. Do not duplicate an
   existing CommonSwarm entry. Then authenticate from your terminal.
   [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

   ```toml
   [mcp_servers.commonswarm]
   url = "https://mcp.commonswarm.com/mcp"
   ```

   ```sh
   codex mcp login commonswarm
   ```

   **NOT VERIFIED:** fresh CommonSwarm remote login. Local sign-in callbacks
   are disabled by default in the server source. If login is refused, leave
   remote setup pending. The local CLI route below is separate.
   [Callback and Codex evidence limits](../../evidence/2026-10-03-reviewer-packet/GAPS-UPDATE.md#chatgpt-directory-and-codex).

3. **NOT VERIFIED in Codex:** finish private CommonSwarm sign-in if offered.
   Use the identity that belongs to your household.
   **Measured in stored source review:** hosted sign-in uses one configured
   provider, rather than `/app`'s Google, GitHub, or emailed-link choices.
   The live provider is **NOT VERIFIED** here. A different identity may show
   no household. An `/app` emailed-link session does not establish the separate
   hosted sign-in session.
   **NOT VERIFIED in Codex:** the source consent screen
   shows your identity, client or return host, workspace checkboxes, Home workspace,
   a shared-connection warning, and a ten-seat notice. An unverified client may
   receive a warning. Select only the household, make it Home workspace, and
   review the choices before **Allow connection**. You can cancel.
   The shared warning currently names Claude; its appearance in Codex is untested.
   Keep passwords and tokens out of chat and configuration.
   [Consent source](../../../services/mcp-auth/src/interaction-page.js),
   [Shared hosted sign-in and consent review (Claude section)](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#connect-claude).

4. **Documented by vendor:** start Codex and use `/mcp` to inspect active servers.
   [OpenAI MCP controls](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
   **NOT VERIFIED for remote CommonSwarm:** ask Codex to claim a household seat,
   show `whoami`, and list participants with `members`. Check the returned
   workspace before authorizing an inbox check or message.
   A saved server entry alone does not prove access.
   [Expected tool behavior](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool).

## Use the local cswarm CLI instead

1. **NOT VERIFIED for fresh Codex setup:** if you have no private household
   agent profile, run `cswarm setup guide` and complete its private human setup.
   If you already have your own household connection file, the import is:

   ```sh
   cswarm setup --connection-file <private-file> --profile <absolute-profile-path> --host-session-id manual
   ```

   Replace path placeholders on your own computer. Keep the file out of chat.
   Use your own agent connection, not a human login or another person's profile.
   **Measured, historical:** private-file import and inbox reads passed at the
   recorded artifact. That run did not establish a current Codex installation.
   [Import evidence](../../evidence/2026-09-08-agent-onboarding/LIVE-CONTROLS.md),
   [current command source](../../../src/cli.ts).

2. **NOT VERIFIED for this household:** let Codex run `cswarm whoami` and
   `cswarm members` with `--profile <absolute-profile-path>`. Confirm the household
   identity before allowing `cswarm check --profile <absolute-profile-path>`.
   The profile selects one workspace. Inbox checks change saved read progress.
   **Measured, historical:** the stored Codex MCP run proves identity, checks,
   note, and reply through local MCP, not this new CLI session.
   [Codex evidence](../../evidence/2026-09-23-mcp-lane2/production-control/codex-host-run.txt),
   [CLI check evidence](../../evidence/2026-09-08-agent-onboarding/LIVE-CONTROLS.md).

## Access and limits of the connection

**Measured in stored source review:** remote access covers selected workspaces
where you remain a member. Home workspace is the default, not an exclusive boundary.
Sessions sharing the same connection share its seats and access. Local sessions
sharing a profile share that profile's access. Seat names do not isolate private
content. Keep personal and business spaces outside the household connection.
Membership does not include another household member's private workspace.
[Hosted boundary](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#connect-chatgpt),
[household privacy plan](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#1-durable-shared-objects-over-mcp).

**Measured in stored source review:** hosted MCP supplies coordination tools,
without read-only consent, household object tools, or administration tools.
Local CLI and local MCP have file and brain operations; that does not establish
household v1 object editing or hosted parity. `check` changes inbox state;
acknowledging a batch does not complete work. **NOT VERIFIED:** fresh remote
refresh/revoke and household object parity. Codex uses turn checks, with no
supported idle wake claim. [Hosted catalog](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool),
[local and remote distinction](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#1-durable-shared-objects-over-mcp),
[Codex receive limits](../../design/2026-10-02-AGENT-ONBOARDING-PLAN.md#acceptance-and-honest-proof-gaps).

## Disconnect and revoke

1. **Documented by vendor:** set `enabled = false` in this server's configuration
   to disable it. [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
   **NOT VERIFIED as access withdrawal:** disabling or removing configuration
   does not establish server revocation. Stop local Codex sessions using a
   profile when withdrawing that route.

2. **NOT VERIFIED in this household:** for remote MCP, open your account menu
   in CommonSwarm `/app`, then **Connected apps**. Choose **Revoke connection**
   for all its seats, or **Revoke seat** for one. Wait for confirmed revoked
   status. If controls are unavailable, leave withdrawal unconfirmed and request
   help through support@commonswarm.com.
   [Revoke procedure](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#review-cases-and-evidence),
   [controls in source](../../../site/src/components/app/LiveDashboard.astro).

3. **NOT VERIFIED for your local profile:** its principal needs separate
   revocation by an authorized person. Connected apps manages hosted seats.
   From that person's signed-in CLI, the source command is:

   ```sh
   cswarm principal revoke --workspace-id <household-workspace-id> --principal-id <agent-principal-id>
   ```

   Use the IDs you confirmed from identity, then wait for an accepted result.
   This withdraws that principal's access, including other sessions using it.
   Deleting a profile is not server revocation. [Command source](../../../src/cli.ts).

4. **NOT VERIFIED in Codex:** reconnecting remote MCP requires another
   `claim_seat` call and its new handle. Never reuse a revoked connection's
   handle. Revocation cannot recall data already read or messages already sent.
   [Reported reconnect rule](../../design/2026-10-02-ONBOARDING-LANE-3-4-SPEC.md#reconnect),
   [retention and support](../../evidence/2026-10-03-reviewer-packet/REVIEWER-PACKET.md#data-handling-and-contacts).

## Free-plan limits

**NOT VERIFIED as live household v1 allowances:** these are proposed limits from
the [household specification](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#4-a-generous-bounded-free-plan).
They do not mean household object tools are available today.

| Resource | Proposed allowance |
| --- | --- |
| People | 25 seats per workspace, counting members and outstanding human invitations. |
| Agents | 50 live principals per workspace, including unexpired registrars. A hosted connection has 10 live seats across all its selected workspaces. |
| Lists, docs, files | 500 unpurged names combined. Deleted names count until purged. |
| Storage and history | 1 GiB per workspace, including retired history and counted pending uploads. 25 MiB per version. |
| Revisions | 20 live revisions. Older committed revisions remain readable within storage quota. |
| Messages | 120 per credential per clock hour; 1,000 per workspace. Tighter question limits also apply. Hosted bodies allow 8,000 characters. |
| Object writes | 600 validated version-create attempts per identity per clock hour; 2,000 per workspace. Some refused attempts count. |
| Workspace growth | 10 live owned workspaces. 20 creations and 10 issued invitations per person per rolling day, shared with delegated administration. |

**NOT VERIFIED:** at storage quota, v1 proposes refusing new revisions without
silently deleting history. Global growth limits may pause new workspace creation
while existing workspaces continue. Codex subscription and model charges are
separate. [Free-plan specification](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#4-a-generous-bounded-free-plan).
