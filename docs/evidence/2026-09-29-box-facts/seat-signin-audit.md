**This is a source review, not a live account check.** I did not run `cswarm` or launch an Alloy panel: both would create state or run subprocesses under your read-only constraint.

### 1. Create a named agent seat

With the saved human session and Cloud target on this Mac, the commands are:

```sh
cswarm mcp code --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934

cswarm mcp connect \
  --url https://api.commonswarm.com \
  --profile /Users/yulanbot/.cswarm/agents/hm37a-sender/profile.json \
  --name hm37a-sender
```

The first command prints a **one-hour, one-seat** connect code once. Enter it at the second command’s hidden terminal prompt. There is **no `--code`, environment-variable, pipe, or redirected-stdin input** for `mcp connect`; it requires a TTY and disables echo. A fully non-interactive operator cannot complete that prompt through the supported CLI interface. If the URL’s anon key is not already in the saved target, `mcp connect` additionally requires `--anon-key <key>`. No browser consent, email entry, or 2FA step is in this seat flow while the human session remains refreshable; an invalid human session requires a separate sign-in. The chosen profile path must be absolute, private, outside a repository, and unused. Connect writes the profile and sibling `credential.json` as mode `0600` in a `0700` directory. [src/cli.ts:10097](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cli.ts:10097), [src/cli.ts:10109](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cli.ts:10109), [src/cloud/mcp-connect.ts:324](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/mcp-connect.ts:324), [src/cloud/mcp-connect.ts:366](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/mcp-connect.ts:366), [src/cloud/mcp-connect.ts:660](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/mcp-connect.ts:660), [src/cloud/agent-profile.ts:301](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/agent-profile.ts:301).

`principal create` plus `token mint` is a different, lower-level flow; the two commands above are the CLI flow that creates the principal, credential, and profile together. Registration returns those IDs and the credential to the secure profile writer. [src/cloud/mcp-connect.ts:875](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/mcp-connect.ts:875), [src/cloud/mcp-connect.ts:894](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/mcp-connect.ts:894).

### 2. Revoke it

Use the **new principal ID returned by connect**, not the existing `cee27f94-…` ID:

```sh
cswarm principal revoke \
  --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 \
  --principal-id <new-principal-uuid> \
  --json
```

The human readback is:

```sh
cswarm status --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 --json |
  jq --arg id '<new-principal-uuid>' '.agents[] | select(.principal_id == $id) | {principal_id, revoked}'
```

`revoked: true` proves the principal projection. **The CLI does not expose an active-token count**, so that readback alone cannot measure zero tokens. The accepted revoke transaction stamps the principal and every token with `revoked_at`; an authorized database read of `swarm.agent_tokens` is needed for an independent count of rows with `revoked_at IS NULL AND expires_at > now()`. [src/cli.ts:2580](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cli.ts:2580), [src/cloud/workspaces.ts:589](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/workspaces.ts:589), [supabase/functions/command/index.ts:4626](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/supabase/functions/command/index.ts:4626).

### 3. Interpret the existing profile’s HTTP 403

**403 does not identify a single cause.** On the ordinary local-agent `whoami` read path, it means the credential resolved to an unexpired token, but the read context marked it revoked: owner membership absent, revoked, or inactive (including an archived workspace); token, principal, run, or device revoked/ended; a surrender-only token; or a matching token, principal, run, device, membership, lineage, or family tombstone. A missing principal transport also returns generic 403; a non-`local` transport returns 403 `transport_unavailable`. An **expired or superseded predecessor token instead yields 401** because the read context returns no row. Thus the measured 403 for `cee27f94-…` cannot by itself prove principal revocation. [supabase/functions/read/index.ts:506](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/supabase/functions/read/index.ts:506), [supabase/functions/read/index.ts:527](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/supabase/functions/read/index.ts:527), [supabase/functions/read/index.ts:535](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/supabase/functions/read/index.ts:535), [supabase/migrations/20260906000020_agent_execution_sessions.sql:215](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/supabase/migrations/20260906000020_agent_execution_sessions.sql:215).

A human can check the existing principal’s `revoked` flag with `cswarm status --workspace-id … --json`, selecting only that ID and flag with `jq` as above. That distinguishes **principal revocation**, but a false value does not distinguish the other 403 causes. The CLI has no cause-specific readback for the token, membership, device, run, and tombstone checks; that requires authorized server-side reads. No secret needs to be printed. [src/cli.ts:2113](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cli.ts:2113), [supabase/migrations/20260906000020_agent_execution_sessions.sql:219](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/supabase/migrations/20260906000020_agent_execution_sessions.sql:219).

### 4. Site sign-in and linked providers

`/app` offers an **emailed magic link** and buttons for **Google and/or GitHub only when GoTrue reports each enabled at site build time**. It offers no password form. The source does not establish which OAuth buttons are on the currently published build. [site/src/lib/auth-providers.ts:36](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/site/src/lib/auth-providers.ts:36), [site/src/lib/auth-providers.ts:148](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/site/src/lib/auth-providers.ts:148), [site/src/components/app/LiveDashboard.astro:62](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/site/src/components/app/LiveDashboard.astro:62), [site/src/lib/commonswarm.ts:342](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/site/src/lib/commonswarm.ts:342).

**There is no exact read-only command to list user `d37e2ff2-…`’s linked providers from the saved human CLI session.** The CLI stores a *refresh token*, not an access token, and exposes no provider-list command. To call GoTrue `/auth/v1/user`, a program would first have to refresh that credential; the repository’s refresh function rotates the token and writes the replacement to the store. That is a state-changing operation, so it cannot honestly be presented as the requested read-only probe. [src/cloud/storage.ts:46](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/storage.ts:46), [src/cloud/auth.ts:567](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/auth.ts:567).

### 5. CLI-to-dashboard handoff

**No.** The CLI’s saved human refresh credential is separate from the browser session. `cswarm login --no-browser` still produces a Google/GitHub OAuth URL and waits for its PKCE callback; it does not issue a `/app` sign-in link or transfer its saved session into Chrome. The site persists its own browser session and detects a session in the URL after its own sign-in flow. A separate Chrome user-data directory therefore needs to complete one of the site’s offered sign-ins; the existing CLI session alone cannot sign it into `/app`. [src/cloud/auth.ts:448](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/auth.ts:448), [src/cloud/auth.ts:475](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/src/cloud/auth.ts:475), [site/src/lib/commonswarm.ts:133](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-dryrun3/site/src/lib/commonswarm.ts:133).