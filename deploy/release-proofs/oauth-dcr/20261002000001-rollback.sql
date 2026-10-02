-- Reserve rollback only: first disable public authorization / restore baseline
-- OAuth and Caddy. Back up registration rows if retention is required. This
-- removes newly created registrations; it leaves hosted grants/artifacts alone.
DROP TABLE IF EXISTS commonswarm_oauth.registered_clients;
