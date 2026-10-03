# CommonSwarm ChatGPT package draft

Build from the repository root:

```sh
bash scripts/build-chatgpt-package.sh
node --test tests/chatgpt-package.test.mjs
bash scripts/build-chatgpt-package.sh --validate-only --submission-ready
```

Requires Python 3 with `jsonschema` (validated with 4.25.1), and Node 22+ for
the service-free test. Builds run offline, without credentials or services.
The final command currently fails deliberately: no verified customer-support
URL or real demo recording is available. The default build validates the draft
package, rather than claiming submission readiness. Neither mode proves live
URLs, account eligibility, tool execution, scan acceptance or vendor approval.

The ZIP is `dist-chatgpt/commonswarm-chatgpt.zip`. It contains exactly
`plugin.json`, `mcp.json`, `LICENSE` and `assets/app-icon-512.png`. The icon is
copied into the archive from `site/public/brand/app-icon-512.png`; no duplicate
binary is tracked. The license comes from the repository's MIT `LICENSE`.
Entry order, timestamps, permissions and storage method are fixed. README and
schema files are build inputs/documentation and are not submission entries.

## Sources and scope

Prepared listing facts and review cases come from the reviewed `lane/dist-packet`
documents at `docs/evidence/2026-10-03-submissions/chatgpt-apps/LISTING.md` and
`PORTAL-FIELDS.md`. The lead supplied `../C3-ACTIONS.md` rows OA-01, OA-03,
OA-04 and OA-12 and `../VENDOR-DOC-CHECK.md` in this lane. In the reviewed packet,
those files live under `docs/evidence/2026-10-03-reviewer-packet/`.

Current primary sources fetched using plain HTTPS GET on 3 October 2026 UTC:

- [OpenAI package guide](https://developers.openai.com/plugins/build/plugins)
- [OpenAI submission and field reference](https://developers.openai.com/plugins/deploy/submission)
- [Portable plugin schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
- [Portable MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json)

Both upstream schema snapshots are pinned under `scripts/schemas/` and validated
with a Draft 2020-12 validator. The builder also enforces the documented public
listing limits, five positive/three negative case fields, asset bounds, and this
lane's one-server/no-apps/no-hooks inventory. It deliberately supports only the
fields this package uses, rather than claiming to implement every optional
OpenAI field. `Productivity` is the prepared category; the publisher must confirm
the actual portal choice. Package version 1.0.0 is independent of the CLI version.

Fetched schema SHA-256 values:

- `plugin.schema.json`: `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883`
- `mcp.schema.json`: `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb`

The eight cases are prepared expectations, not execution receipts. Optional
country overrides, translations, author email, app references, hooks, skills,
private credentials and reviewer instructions are omitted. The support URL is
omitted because OA-03 is blocked; the video URL is omitted because OA-09 has no
recording. Both are optional in an uploaded draft and required for MCP review.
HezLead must choose a product-support address before the support page can be
implemented and separately released. `legal@` and `security@` are reserved for
their existing purposes; the email-template README describes `hello@` as an
email sender without a formal support role. Do not infer a support channel.

No submission, deployment, account creation or production change occurs here.
