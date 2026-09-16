# Local N-db rehearsal — RUN AND PRODUCTION-PIN RERUN 2026-09-16

The box and production were not contacted. The source was the already-running local Supabase stack on `127.0.0.1:54321–54329`. The target used Compose project `n-db-rehearsal`, external network `commonswarm-net`, fixed database address `172.31.0.10`, loopback ports `18000–18005`, generated test secrets, and a generated two-day internal CA. The final run used the production pins supplied by the lead: PostgreSQL `17.6.1.147`, GoTrue `v2.197.0`, and Storage API `v1.77.5`. PostgREST `v14.5` and Realtime `v2.86.3` remain the local CLI pins because their production endpoints publish no version.

## Results

| Step | Result |
|---|---|
| Images | Pulled and ran PostgreSQL `17.6.1.147`, GoTrue `v2.197.0`, PostgREST `v14.5`, Realtime `v2.86.3`, and Storage API `v1.77.5`. |
| Source fixture | Created one confirmed local Auth user, completed password sign-in, and uploaded one text object. The fixtures were removed after the run. |
| Dump | Exit 0. Custom dump size 7,055,733 bytes. Selected 7 schemas, 84 table counts, and 273 `swarm-files` object rows. `realtime.messages` data was excluded. |
| Roles | Generated password-free application role SQL. The target image created its own Supabase roles; the role artifact supplied CommonSwarm roles and `supabase_realtime_admin`. |
| Restore | Exit 0 in one transaction after the role artifact. |
| Target role preparation | Exit 0. All login passwords were checked as SCRAM verifiers. `backup_ro` and `commonswarm_edge` received only their planned memberships. |
| Row counts | Exit 0. All 84 source and target table counts matched: 2,470 Auth users, 2,179 agent-token rows, and 273 Storage object rows. This check ran before target-only rehearsal writes. |
| Realtime control state | The pinned Realtime application seeded the encrypted tenant and extension. The setup script enabled database TLS, kept `supabase_realtime` empty, and found all three CommonSwarm Broadcast policies. Health returned 200. |
| Storage copy | Exit 0. Copied and SHA-256 checked 273 objects, 6,882 bytes total. A second run also passed, proving idempotent upsert behavior. |
| Migrated human session | The old source access token was rejected by target GoTrue. The migrated refresh token returned 200 and issued a target HS256 session. A fresh target password sign-in also returned 200. |
| Edge command | `create_workspace` through `/functions/v1/command` returned 200 and `accepted`. This used the pinned edge image with a temporary copy of the edge owned functions that passed the internal CA explicitly to `postgres(...)`; the committed CommonSwarm function files were not edited. |
| Authenticated REST | A `swarm_read.workspaces` read through `/rest/v1/workspaces` returned the new workspace, HTTP 200. |
| CLI pointed at target | Built `dist/cli.js` used `SWARM_CLOUD_URL=http://127.0.0.1:18000`, the unchanged target anon JWT, and an imported refresh session. `cswarm status --json` exited 0 and returned JSON. |
| Storage upload/download | An upsert through `/storage/v1/object/swarm-files/...` returned success; an authenticated download returned bytes with the same SHA-256. |
| Realtime wake | A private `cswarm-wake:{wake_id}` channel reached `SUBSCRIBED`. A database `realtime.send` wake arrived through Caddy: `{"subscribed":true,"received":true,"detail":"wake"}`. |
| Health | PostgreSQL, GoTrue, PostgREST, Realtime, Storage API, edge runtime, and the local Caddy gateway were healthy or returned their planned health response. |

The service results did not change after the production pin update. Every Auth, REST, CLI, Storage, Realtime, edge, count, and health control passed again. The local source continued to change between runs, so the compressed dump changed from 7,077,101 to 7,055,733 bytes and copied object bytes changed from 6,873 to 6,882. The table count, object count, and named row counts stayed the same.

## Problems found and fixed in preparation

1. The PostgreSQL image bootstrap user is `supabase_admin`. Setting `POSTGRES_USER=postgres` skipped the image's role setup. The example now preserves `supabase_admin`.
2. The CommonSwarm init hook sorted before the image's `migrate.sh`. Its mount name now starts with `zz-`.
3. The image does not create the no-login `supabase_realtime_admin` owner. The password-free role dump now carries it.
4. Realtime needs `_realtime` before its repository migrations. Target preparation creates that image-owned schema.
5. A self-signed leaf is not an internal CA. The successful run used a CA certificate with `CA:TRUE` and a separately signed leaf containing both ruled SANs.
6. A shared env file gave Storage API Realtime's `PORT=4000`. `SERVER_PORT=5000` and `SERVER_ADMIN_PORT=5001` now make Storage's bind explicit.
7. Realtime stores its tenant JWT and database password encrypted. Direct SQL insertion was unreadable. The pinned Realtime seeder now creates those rows; SQL only enables TLS and verifies policy state.
8. `DB_ENC_KEY` must be 16 ASCII characters for the pinned Realtime AES-128 implementation.
9. Edge Runtime workers do not inherit arbitrary main-service variables. The router must pass the database CA variable.
10. `postgres` 3.4.9 ignored a CA file URL parameter and the process CA settings in this Edge Runtime. The successful temporary function copy passed the decoded public CA as `ssl.ca` with certificate verification enabled and kept `sslmode=verify-full`. Its URL omitted `sslrootcert`, which this client otherwise sent to PostgreSQL as an invalid startup parameter.
11. The edge database URL uses the dedicated `commonswarm_edge` password, not the shared service password.
12. The original PostgreSQL health check used its Unix socket. It could pass before a separate migration container could connect on the bridge. The committed health check now connects to `172.31.0.10` with `sslmode=verify-full` and the internal CA.
13. A fresh Realtime tenant reports `SUBSCRIBED` while it can still be creating its Broadcast publication and replication slot. The final control allowed that initialization to finish and then received the database wake.

## Signed-in human after cutover

The site loads its stored access token, then calls GoTrue `getUser`. An old asymmetric production token cannot be checked by this HS256-only GoTrue instance. The call fails, `currentSession()` clears the local browser session, and the app shows its sign-in path. The human signs in with GitHub once.

The imported Auth rows preserve refresh tokens. The local migrated refresh returned 200 and produced a new HS256 token. The CLI calls `refreshSession()` before each human operation, so its refresh path can continue without an interactive login when the migrated token is still valid. The release instruction still tells every human to sign in once because the browser path does not proactively replace an otherwise unexpired access token after an API rejection.

## Not established

- No box rehearsal from a production dump was run.
- No production endpoint, Supabase project, SSH host, DNS record, Cloudflare API, Tailscale node, or vault was contacted.
- GitHub OAuth was not run because this lane did not read the production client secret.
- R2 was not contacted. The local Storage API used its file backend; the same API copy path is configured for R2 in production.
- This lane did not independently read production service versions. It used the lead's 2026-09-16 21:20Z results. Production PostgREST and Realtime versions remain unknown because their endpoints publish no version; those two pins come from the local Supabase CLI stack.
- The edge owned repository files still need the explicit `ssl.ca` change before the box rehearsal. This lane was prohibited from editing `supabase/functions/**` and `deploy/edge-runtime/**`.
- A production asymmetric access token and production refresh token were not read. Human behavior above combines the locally measured key-change control with the site and CLI code paths.
- The production Caddy block was adapted for syntax but was not installed or reloaded.
