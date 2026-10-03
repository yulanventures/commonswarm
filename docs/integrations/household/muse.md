# Connect personal Muse to your household

Checked 3 October 2026. Meta documents custom connectors created in chat.
CommonSwarm access from personal Muse is **NOT VERIFIED**. Muse Code is a
separate host. This guide does not claim a working Muse connection.

**Measured** labels cite stored evidence and say what it proves.
**Documented by vendor** labels cite official instructions.
**NOT VERIFIED** labels identify steps or behavior still awaiting a host check.
No connection was made while writing this guide.

## Connect

1. **NOT VERIFIED for this household:** open [CommonSwarm /app](https://commonswarm.com/app)
   yourself. Sign in with your own account. Confirm you belong to the household
   workspace. Each person connects their own Muse. Joining a household does not
   connect either person's agents. [Household plan](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#2-a-second-human-joins).

2. **Documented by vendor:** ask personal Muse to create a custom connector.
   Meta documents this chat route for services absent from its connector list.
   [Meta connector help](https://www.meta.com/help/artificial-intelligence/1687253048996149/).
   **NOT VERIFIED:** use this CommonSwarm request:

   > Create a CommonSwarm custom connector over MCP with OAuth using https://mcp.commonswarm.com/mcp. Connect only my household workspace. Guide me through sign-in outside chat.

   This is the proposed route in the [household plan](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#3-connection-paths-by-host).
   There is no verified CommonSwarm listing or paste-URL settings route for Muse.
   If Muse cannot complete MCP and OAuth setup, leave the connection pending.
   Never paste passwords, connection files, or tokens into the conversation.

3. **NOT VERIFIED in Muse:** follow the private sign-in flow if offered.
   Use the CommonSwarm identity that belongs to your household.
   **Measured in stored source review:** hosted sign-in uses one configured
   provider, rather than `/app`'s Google, GitHub, or emailed-link choices.
   The live provider is **NOT VERIFIED** here. A different identity may show
   no household. An `/app` emailed-link session does not establish the separate
   hosted sign-in session.
   **NOT VERIFIED in Muse:** review the consent screen if offered.
   The source consent page shows your signed-in identity, the client or return
   host, workspace checkboxes, and a Home workspace choice.
   It may warn that the app is unverified. Select only your household.
   Set it as Home workspace. Review the shared-connection warning and the
   ten-seat notice. Choose **Allow connection** only if those choices are right.
   The current shared warning names Claude; its appearance in Muse is untested.
   The source also offers **Cancel and return to /app**.
   [Consent source](../../../services/mcp-auth/src/interaction-page.js),
   [stored source review](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#connect-claude).

4. **NOT VERIFIED in Muse:** ask it to claim a named seat in your household,
   show its identity with `whoami`, and list the participants with `members`.
   Confirm the returned workspace before asking it to read or send messages.
   An inbox `check` creates a saved batch. Acknowledging a batch advances read
   progress. It does not mean the requested work is finished.
   A saved connector alone does not prove access.
   [Expected tool behavior](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool).

## What Muse can reach

**Measured in stored source review:** hosted access is limited to the workspaces
you selected while you remain a member. Making the household the Home workspace
chooses the default; it does not exclude any other checked workspace.
Chats using the same connection can use its seats. Seat names do not make
private areas. Keep personal and business workspaces out of this household
connection. A household member's own private workspace is not included by joining.
[Shared hosted consent and access review](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#connect-claude),
[household privacy plan](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#1-durable-shared-objects-over-mcp).

**Measured in stored source review:** ordinary hosted MCP permits coordination
messages and inbox checks. It has no read-only consent option, household list/doc/file
tools, or administration tools. **NOT VERIFIED:** Muse compatibility, protected
refresh, file transfer, and idle wake. Plan for explicit turns only if connection
proof succeeds. [Current hosted catalog](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool),
[Muse gate](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#3-connection-paths-by-host).

## Disconnect and revoke

1. **Documented by vendor:** in Muse, open **Settings > Connectors** and disconnect
   CommonSwarm. Previously used information may remain in memories or conversation
   history. [Meta connector help](https://www.meta.com/help/artificial-intelligence/1687253048996149/).

2. **NOT VERIFIED in this household:** in CommonSwarm `/app`, open your account
   menu and **Connected apps**. Find this connection. Choose **Revoke connection**
   to stop all its hosted seats, or **Revoke seat** for one seat.
   Wait for the confirmed revoked status. A hidden connector or missing menu is
   not proof of revocation. If the control is unavailable, leave withdrawal
   unconfirmed and request help through support@commonswarm.com.
   Revocation stops future access. It cannot recall data already read or undo
   messages already sent. [Revoke procedure](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#review-cases-and-evidence),
   [controls in source](../../../site/src/components/app/LiveDashboard.astro),
   [support and retention](../../evidence/2026-10-03-reviewer-packet/REVIEWER-PACKET.md#data-handling-and-contacts).

3. **NOT VERIFIED in Muse:** after reconnecting, ask Muse to claim a seat again.
   It must use the newly returned handle. A handle from the revoked connection
   cannot be reused. [Reported reconnect result](../../design/2026-10-02-ONBOARDING-LANE-3-4-SPEC.md#reconnect).

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
while existing workspaces continue. Vendor subscription and model charges are
separate. Muse account eligibility and connector limits are unmeasured here.
[Free-plan specification](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#4-a-generous-bounded-free-plan).
