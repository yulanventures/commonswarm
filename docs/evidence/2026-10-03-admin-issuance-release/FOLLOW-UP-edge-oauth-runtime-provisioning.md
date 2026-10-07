# Follow-up: edge SET grant at provisioning

W6 `ai-w6-edge-oauth-runtime-grant` adds
`GRANT commonswarm_oauth_runtime TO commonswarm_edge WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`
on an existing stack. Fresh stacks still receive only
`swarm_command, swarm_read, swarm_capability` from
`deploy/supabase-stack/migrate/prepare-target.sh`. Add this membership at
provisioning later. Do not treat the W6 block as the create-login path.
