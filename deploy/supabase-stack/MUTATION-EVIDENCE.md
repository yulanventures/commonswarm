# Pure control mutation evidence

`tests/p1-cli/supabase-stack.test.ts` validates the committed files, then applies each mutation in memory and requires the named failure.

| Mutation | Required failure |
|---|---|
| Remove `POSTGRES_PASSWORD` from `env.example` | Required environment name missing |
| Publish PostgreSQL on loopback | PostgreSQL port published |
| Change GoTrue from 300 MB to 700 MB | Ruled memory split changed |
| Add a literal JWT secret to Compose | Secret-like Compose value |
| Change the GoTrue Caddy upstream | Auth route wrong |
| Uncomment the Supabase-origin proxy | Fallback active |
| Remove Realtime HTTP/1.1 transport | Realtime no-buffer transport missing |

The test is in `tests/p1-cli/`, so `npm run test:p1-cli` runs it through that script's recursive glob. The literal `npm test` script does not name this new file; its separate gate remains unchanged.
