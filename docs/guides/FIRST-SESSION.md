# Tom's first CommonSwarm session

**Use this after HezLead confirms C1 and the matching household releases are live.**
Shared objects, agent content approval, lists and history need the household
integration (`6418dee2`); your wife's invitation review and join also need lane 5
(`24c62e2c`). Landing code alone does not make these steps live.
**Unverified:** live sign-in, invitation and agent connection flows, and Claude's
current menu labels. This guide was checked against source; the draft checklists
still require those live proofs.

1. **Choose a shared workspace.** Open [CommonSwarm /app](https://commonswarm.com/app)
   and sign in as yourself. Create or select the workspace you want to share.
   Use the workspace menu's **New workspace** to add one.
   Open **Shared objects**, choose **Shared with current workspace members** as
   the workspace purpose, and press **Confirm editor access**. Leave the agent
   selector at **Only confirm my access** for now.

   **You should see:** “Your content access is confirmed.” Members who confirm
   content access can read shared content and history.
   **If it fails:** the owner must confirm purpose first. Check your workspace
   and account. For an unknown confirmation outcome, reload
   before confirming again. If Shared objects is missing, check the release with HezLead.

2. **Connect Claude.** In your own claude.ai account, add a custom connector with
   server URL `https://mcp.commonswarm.com/mcp`. Sign in as yourself.
   On the consent screen, select only this shared
   workspace, mark it **Home workspace**, read the app identity and return
   destination, and press **Allow connection**. No API key or client secret is
   needed.

   **You should see:** your identity and workspace, then a return to Claude.
   **If it fails:** check membership and the signed-in account for a missing
   workspace. Reload unfinished consent to resume. If the URL cannot connect,
   ask HezLead to check C1's release. Returning to Claude alone does not prove access.

3. **Give your Claude agent content access.** In a chat with the connector enabled,
   ask: “Use CommonSwarm to claim a seat named Tom-list in the home workspace.
   Show its identity with whoami and list the workspace members.” Then return to
   **/app → Shared objects**. Choose **Shared with current workspace members**,
   select that agent under **Also approve one of your connected agents**,
   enable the create and patch
   permissions, and press **Confirm editor access**.

   **You should see:** your workspace and seat identity, then “Your content access
   is confirmed” in /app. **If it fails:** reopen Shared objects after claiming
   the seat; check the account menu's **Connected apps** if it stays absent.
   Hosted content approval expires after 24 hours; repeat it when needed.
   Connector consent and content approval are separate. Chats on one connector
   grant share seats. Keep private work on a separate connection and workspace.

4. **Invite your wife from /app.** In the shared workspace, use **Invite a
   collaborator** if shown. Otherwise open the channel's agent roster, choose
   **Add an agent → A teammate does**. Enter the email she will use to sign in,
   press **Create invite link**, and privately send her the copied link.

   **You should see:** a pending invitation's one-use link with a seven-day expiry.
   **If it fails:** check your Owner/Admin membership and the
   Shared confirmation from step 1. If copying fails, use the page's manual-copy
   instruction. She has not joined until she confirms on her side.

5. **She signs in and chooses access herself.** For the copied link in step 4,
   she opens it and signs in with her own account using the invited email.
   If an authorized agent sent her a member invitation instead, she signs in
   to **/app**, finds **Your invitations**, and selects the invitation to review.
   That inbox path requires her to have an account already; copied links do not
   appear there. She reviews the workspace, current members and retained-history
   disclosure, chooses **Editor** for this
   editing test, checks the consent box and presses **Join as myself**.

   **She should see:** “You joined” and the workspace name. **If it fails:** check
   the email and your Shared settings. For a missing inbox invitation, press
   **Check invitations** and confirm the agent invited her account. For an
   unavailable link, check whether she already joined; otherwise ask for a new
   link. Review again if the disclosure changed. For an unknown join result,
   use **Try again** on the link page, or **Join as myself** again in the inbox,
   to check the saved request.

6. **She connects her own agent.** She repeats steps 2 and 3 through her own
   claude.ai and CommonSwarm accounts, selects the shared workspace, claims a
   seat such as Wife-list, and approves that seat's content operations herself.

   **She should see:** her identity and agent in the shared workspace.
   **If it fails:** check membership, then her connector and content approvals.
   Joining creates no connected agent. She must authorize her agents herself.
   Repeat content approval for each additional seat.

7. **Make and edit one list.** Ask your Claude: “Create a CommonSwarm list titled
   Groceries with unchecked items milk and bread. Show the committed object ID
   and revision.” Give that object ID to your wife. Ask her agent to read it and
   check milk. Then ask yours to read the latest version and add eggs. Agents
   should use the advertised `object_create`, `object_read` and `object_update`
   tools, with each patch based on the revision just read.

   **You should see:** a `committed` result for creation and each edit, with milk
   checked and eggs present on a fresh read. **If it fails:** missing object tools
   need the household release; refused writes need editor access and the selected
   seat's content approval. For an unknown outcome, retry the identical input
   with the same request ID before making another write.

8. **Read the history.** Reopen **/app → Shared objects**, select Groceries and
   inspect **History**. Open an earlier revision, then **Back to current revision**.
   Either agent can also use `object_history` and read a returned revision with
   `object_read`.

   **You should see:** committed revisions with human/agent attribution, server
   time and revision IDs. **If it fails:** reopen the view to reload it, use
   **Load more history** if offered, and check content access. Earlier revisions
   remain readable; the next edit does not erase them.

9. **Recognize a conflict.** To try one, have both agents read the same current
   revision. Let one save an edit, then let the other submit its planned patch
   against the older revision.

   **You should see:** one committed save, then `conflict` with the current revision
   and a retained draft ID. The second edit is unsaved. Even different-item edits
   conflict when their base is stale.
   **Next:** keep the draft ID and intended changes, read the current list, review
   how to combine the changes, then submit an agreed patch against that revision
   with a new request ID. Another save can conflict again. For an unknown outcome,
   use step 7's identical-request retry.

Sources: checkout `5f64fab4`, its
[connector guide](../../site/src/pages/guides/claude-connector.astro), and household
drafts `6418dee2` / `24c62e2c` with their `LEAD-CHECKLIST.md` release limits.
