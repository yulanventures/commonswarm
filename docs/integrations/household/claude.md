# Connect Claude to your household

Checked 3 October 2026. **NOT VERIFIED for your household:** Claude connection
steps below have not been tested with a household workspace. HezLead reports
an earlier custom-connector PASS. The cited packet retains that report;
it does not contain a measured household run. This guide did not repeat that test.
Directory installation, every Claude surface, refresh, and revoke coverage remain
separate checks. [Stored PASS and limits](../../evidence/2026-10-03-reviewer-packet/GAPS-UPDATE.md#authorized-production-evidence).

**Measured** labels cite stored evidence and say what it proves.
**Documented by vendor** labels cite official instructions.
**NOT VERIFIED** labels identify steps or behavior still awaiting a host check.

## Connect

1. **NOT VERIFIED for this household:** open [CommonSwarm /app](https://commonswarm.com/app)
   yourself. Sign in with your own account. Confirm your household membership.
   Each household member connects Claude separately under their own account.
   [Household plan](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#2-a-second-human-joins).

2. **Documented by vendor:** in Claude, open **Customize > Connectors**.
   Choose **+ Add > Add custom connector**. Name it **CommonSwarm**.
   Enter `https://mcp.commonswarm.com/mcp` and continue.
   Review the detected authentication. Choose **Sign in now** and Claude's
   published identity for OAuth, then finish adding the connector.
   Use OAuth without entering fixed credentials.
   Team and Enterprise users need an authorized organization owner to add it
   first, then each member connects individually.
   [Claude setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
   **NOT VERIFIED for your household:** HezLead's earlier custom connection PASS is retained in
   [the evidence update](../../evidence/2026-10-03-reviewer-packet/GAPS-UPDATE.md#authorized-production-evidence).
   It does not establish a directory listing.

3. **Measured in stored source review; NOT VERIFIED for your household:**
   complete CommonSwarm sign-in using the identity that belongs to your household.
   Hosted sign-in uses its configured provider, which may differ from `/app`.
   The consent page shows your signed-in identity, client or return host,
   workspace checkboxes, and Home workspace. An unverified client may receive
   a warning. Select only the household and make it Home workspace.
   Read the shared-chat warning and the ten-seat notice.
   Choose **Allow connection**, or **Cancel and return to /app**.
   [Stored consent review](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#connect-claude),
   [consent screen source](../../../services/mcp-auth/src/interaction-page.js).

4. **Documented by vendor:** enable CommonSwarm for this conversation through
   **+ > Connectors**. [Claude conversation controls](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
   **NOT VERIFIED for your household:** ask Claude to claim a named household
   seat, show `whoami`, and list participants with `members`.
   Confirm the household before authorizing inbox checks or messages. Then ask
   Claude to post one short note saying it joined, using the existing `note` tool,
   and tell you to look for it in the CommonSwarm web app. Open your household
   workspace and look for that note under the name Claude just claimed.
   `check` creates a saved batch. Acknowledging it advances read progress,
   not task completion. A saved connector alone does not prove your seat works.
   [Expected tool behavior](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool).

## What Claude can reach

**Measured in stored source review:** this connection reaches only selected
workspaces where you remain a member. Home workspace is the default; other
checked workspaces remain accessible. Chats using the same Claude connection
can use any seat it created. Seat names do not isolate chats.
Leave private and business spaces unchecked. Household membership does not
include another person's private workspace. Use separately scoped connections
and grants where privacy requires them. If Claude cannot provide that boundary,
keep private workspaces off the shared connection.
[Shared boundary](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#connect-chatgpt),
[household privacy plan](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#1-durable-shared-objects-over-mcp).

**Measured in stored source review:** hosted MCP supplies coordination tools.
It has no read-only consent option, household list/doc/file tools, or administration
tools. Seats check messages during active turns. This connector offers no idle
wake promise. **NOT VERIFIED:** household object editing and equivalent results
on Desktop, mobile, Cowork, and Claude Code.
[Current catalog](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool),
[surface evidence limits](../../evidence/2026-10-03-reviewer-packet/GAPS-UPDATE.md#authorized-production-evidence).

## Disconnect and revoke

1. **Documented by vendor:** open **Customize > Connectors**, find CommonSwarm,
   and choose **Remove** or its three-dot menu. Follow the removal prompts.
   [Claude removal instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

2. **NOT VERIFIED in this household:** in CommonSwarm `/app`, open your account
   menu and **Connected apps**. Find this connection. **Revoke connection** stops
   all its hosted seats; **Revoke seat** stops one seat. Wait for the confirmed
   revoked status. Disabling a conversation toggle is not proof of revocation.
   If the control is unavailable, leave withdrawal unconfirmed and request help
   through support@commonswarm.com. Data already read and messages already sent
   remain. [Revoke procedure](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#review-cases-and-evidence),
   [controls in source](../../../site/src/components/app/LiveDashboard.astro),
   [retention and support](../../evidence/2026-10-03-reviewer-packet/REVIEWER-PACKET.md#data-handling-and-contacts).

3. **NOT VERIFIED for your household:** HezLead reports that reconnecting creates
   a new grant. Ask Claude to call
   `claim_seat` again and use the newly returned handle. An old handle can be
   refused as `hosted_seat_forbidden`. HezLead reported regression retest 14 passed;
   the cited specification retains that report, not a measured household run.
   It was not rerun here. [Reconnect report](../../design/2026-10-02-ONBOARDING-LANE-3-4-SPEC.md#reconnect),
   [retained connector PASS](../../evidence/2026-10-02-distribution-gaps/GAPS.md#basis-and-status-meanings).

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

**Documented by vendor:** Claude Free supports one custom connector.
[Claude plan limit](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
**NOT VERIFIED:** at storage quota, v1 proposes refusing new revisions without
silently deleting history. Global growth limits may pause new workspace creation
while existing workspaces continue. Claude subscription and model charges are
separate. [Free-plan specification](../../design/2026-10-03-HOUSEHOLD-HUB-V1.md#4-a-generous-bounded-free-plan).
