This release shows who was invited but has not connected yet.

**What changes.**
- `cswarm members` prints an "Invited, not connected" section, and `--json` has a `pending` array. An entry is an agent
  that was added but has never made an authenticated call, or a connect code (`cswarm mcp code`) that is not used,
  revoked or expired. Each entry shows its age.
- The web app's People and agents dialog shows the same entries as "Invited, not connected · <age>".
- An entry goes away when the agent makes its first call, or when its code is used, revoked or expired, or when the
  agent is revoked.
- Only members of the workspace see these entries. No entry carries a token, a code, or a secret.

**If the pending list cannot load**, `cswarm members` and the app still show the members, and the section says
"Invited, not connected: could not load".

**What to do:** update. Run `cswarm members` to see who has not connected yet.
