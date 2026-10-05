# CommonSwarm MCP Registry record

Prepared 4 October 2026 for D2 at source
`61f187c527b51e9946f607691dd056e9964d751a`.
The root [server.json](../../../server.json) is prepared and locally validated.
The command and output are in [VALIDATION.md](VALIDATION.md).
No Registry login or publish command ran. No commit or push was made.

**Vendor-documented** labels link to official Registry documentation or its schema.
**Measured** labels cite stored evidence and state its limits.
**NOT VERIFIED** labels name pending checks.

## Schema and fields

**Vendor-documented:** the Registry quickstart creates `server.json` in the server
project directory. Its remote-server guide points to schema version **2025-12-11**.
That schema uses JSON Schema Draft 7. Both guides and the schema were fetched
on 4 October 2026.
[Quickstart](https://modelcontextprotocol.io/registry/quickstart),
[remote servers](https://modelcontextprotocol.io/registry/remote-servers),
[schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).

**Vendor-documented:** the field meanings below follow `ServerDetail`,
`Repository`, and `StreamableHttpTransport` in the
[schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
Values are proposed publisher metadata. Their CommonSwarm evidence is below.

| Field | Meaning and prepared value |
| --- | --- |
| `$schema` | Format identifier. Pins the documented 2025-12-11 schema URL. |
| `name` | Registry identifier with one slash. Proposed namespace `io.github.yulanventures`, server `commonswarm`. Publisher permission is NOT VERIFIED. |
| `title` | Display name: CommonSwarm. |
| `description` | Shared workspace for people and agents, at home and work. Messages and inbox checks. OAuth required. Schema limit: 100 characters. |
| `version` | Server implementation version: `1.0.0`. Matches the inspected hosted `serverInfo.version`. Live version parity is NOT VERIFIED. |
| `websiteUrl` | Project website: `https://commonswarm.com`. Current reachability is NOT VERIFIED by D2. |
| `repository.url` | Source repository: `https://github.com/yulanventures/commonswarm`. Current public reachability is NOT VERIFIED by D2. |
| `repository.source` | Source forge identifier: `github`. |
| `remotes` | One remote connection entry. |
| `remotes[0].type` | Transport: `streamable-http`. |
| `remotes[0].url` | Public MCP resource: `https://mcp.commonswarm.com/mcp`. |

**Measured in stored source review:** the hosted server declares `1.0.0`.
The root package declares `0.1.80` and is private. These are separate version
values. D2 uses the hosted declaration because the Registry schema describes
`version` as the MCP implementation version. This is not a shipped CLI claim.
[Version inventory, E9](../../evidence/2026-10-02-distribution-gaps/GAPS.md),
[current declaration](../../../supabase/functions/mcp/protocol.ts).

**Vendor-documented:** a remote record uses `remotes` and can omit `packages`.
The remote URL must be publicly accessible.
[Remote format](https://modelcontextprotocol.io/registry/remote-servers).
This record describes only the hosted endpoint. It contains no local package,
credentials, fixed authorization headers, or account configuration.

## OAuth and capability evidence

**Vendor-documented:** the schema defines no OAuth or authentication property
on `ServerDetail` or `StreamableHttpTransport`. OAuth is stated in the description.
Consumers must use service discovery. No custom auth field is invented here.
[Schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).

**Measured by the lead on 2 October 2026:** the stored public discovery result
names resource `https://mcp.commonswarm.com/mcp`, authorization server
`https://mcp.commonswarm.com`, resource scope `mcp`, and bearer method `header`.
It records S256 PKCE and authorization-code/refresh grants. These are dated
metadata measurements, not fresh host acceptance or lifecycle tests.
[Live metadata evidence](../../evidence/2026-10-02-distribution-gaps/GAPS.md#live-metadata-measured-by-the-lead-2026-10-02-public-get-user-agent-curl871).
The older DCR gap there is superseded by the supplied live DCR and fresh-client
round-trip summary in
[the evidence update](../../evidence/2026-10-03-reviewer-packet/GAPS-UPDATE.md#authorized-production-evidence).
That update does not supply a raw all-tool, refresh, or revoke receipt.

**Measured in stored source review:** the MCP challenge points to
`https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp`.
Authorization discovery routes include
`https://mcp.commonswarm.com/.well-known/oauth-authorization-server` and
`https://mcp.commonswarm.com/.well-known/openid-configuration`.
[Transport and discovery inventory, E2](../../evidence/2026-10-02-distribution-gaps/GAPS.md),
[current resource metadata](../../../supabase/functions/mcp/protocol.ts).
**NOT VERIFIED:** fresh public reachability, live version parity, and each host's
full OAuth lifecycle. No CommonSwarm service was contacted by D2.

**Measured in stored source review:** workspace messages and inbox checks are
part of the eight-tool hosted catalog. The description refers to that scope.
The catalog and argument examples come from the enforcement table.
[Stored hosted catalog](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool),
[current enforcement table](../../../supabase/functions/mcp/tools.ts).
**NOT VERIFIED by D2:** delegated completion, per-host support, Registry
publication, and wake. Metadata validation proves none of these.

## Namespace and publisher authentication

**Vendor-documented:** publishing requires Registry authentication.
GitHub authentication permits names under `io.github.username/*` or
`io.github.orgname/*`. The prepared name selects the organization form.
HezLead must authenticate a publisher authorized for `io.github.yulanventures`.
A repository URL alone does not establish publisher authorization.
[Publisher authentication](https://modelcontextprotocol.io/registry/authentication).

**NOT VERIFIED:** this publisher's Registry authorization, namespace availability,
and any existing record/version conflict. D2 made no Registry account or record
lookup. Resolve these before publication.

**Vendor-documented:** domain authentication instead uses a reverse-DNS namespace.
DNS authentication requires a domain TXT record proving the publisher key.
Choosing that route for `commonswarm.com` would require a reviewed name such as
`com.commonswarm/commonswarm`, domain proof, and another validation run.
GitHub authentication does not authorize that domain namespace.
[Domain and DNS rules](https://modelcontextprotocol.io/registry/authentication#dns-authentication).
**NOT VERIFIED:** CommonSwarm Registry DNS proof. D2 made no DNS change.

## Publish handoff

HezLead runs the command below only after **Tom's go**. Use the reviewed
repository root containing this record. First confirm the current schema,
server version and public endpoint, resolve namespace/version conflicts, and
complete publisher authentication for the chosen organization namespace.
Keep publisher credentials and one-time codes outside reports and source files.

**Vendor-documented:** from that root, this exact command reads `server.json`
and publishes to the official Registry:
[Publish step](https://modelcontextprotocol.io/registry/quickstart#step-6-publish-to-the-mcp-registry).

```sh
mcp-publisher publish
```

**Vendor-documented:** the quickstart verifies publication through the Registry
API. After an authorized publish, retain its redacted receipt and verify the
returned record's exact name, version, and remote URL.
[Verification step](https://modelcontextprotocol.io/registry/quickstart#step-6-publish-to-the-mcp-registry).
**NOT VERIFIED:** publication or downstream discovery of CommonSwarm.
The prepared files remain uncommitted and unpublished.
