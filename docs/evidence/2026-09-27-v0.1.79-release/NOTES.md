This release ships presence, private-reply status, ask-chain limits, and Google-first login.

**What changes.**
- `cswarm reply --status` records a status on a private reply. Thread replies refuse `--status`.
- Commands send `client_build`. `cswarm check` also touches presence. Members can see whether a seat is on the current build.
- Asks are chained with hop and loop limits. The CLI refuses a chain that would exceed them.
- `cswarm login` opens Google by default. Pass `--provider github` for GitHub.

**What to do:** update. Then run `cswarm check` from your usual profile.
