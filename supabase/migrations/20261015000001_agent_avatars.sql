-- Phase 2 only. No change to identity v1 tables, functions or agent_principals view.
CREATE TABLE swarm.agent_avatars (
 principal_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
 FOREIGN KEY(principal_id,workspace_id) REFERENCES swarm.agent_principals(principal_id,workspace_id),
 object_prefix text, content_type text, byte_size integer, width integer, height integer, sha256 text,
 source text CHECK (source IN ('uploaded_by_person','declared_by_agent','client_metadata')),
 generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
 person_locked boolean NOT NULL DEFAULT false,
 source_ref text, set_by_user_id uuid REFERENCES swarm.users(user_id),
 set_by_principal_id uuid REFERENCES swarm.agent_principals(principal_id), set_at timestamptz,
 CHECK ((source IS NULL AND object_prefix IS NULL AND content_type IS NULL AND byte_size IS NULL
   AND width IS NULL AND height IS NULL AND sha256 IS NULL AND source_ref IS NULL
   AND set_by_user_id IS NULL AND set_by_principal_id IS NULL AND set_at IS NULL)
 OR (source IS NOT NULL AND object_prefix IS NOT NULL AND content_type='image/webp'
   AND content_type IS NOT NULL AND byte_size IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND sha256 IS NOT NULL
   AND byte_size BETWEEN 1 AND 2097152 AND width=256 AND height=256
   AND sha256 ~ '^[a-f0-9]{64}$' AND set_at IS NOT NULL
   AND object_prefix=workspace_id::text||'/'||principal_id::text||'/'||sha256
   AND ((source='uploaded_by_person' AND set_by_user_id IS NOT NULL AND set_by_principal_id IS NULL AND source_ref IS NULL)
     OR (source='declared_by_agent' AND set_by_principal_id IS NOT NULL AND set_by_principal_id=principal_id AND set_by_user_id IS NULL AND source_ref IS NULL)
     OR (source='client_metadata' AND source_ref IS NOT NULL))))
);
CREATE TABLE swarm.agent_avatar_jobs (
 job_id uuid PRIMARY KEY,
 principal_id uuid NOT NULL,
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
 FOREIGN KEY(principal_id,workspace_id) REFERENCES swarm.agent_principals(principal_id,workspace_id),
 generation bigint NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
 quarantine_key text NOT NULL,
 source text NOT NULL CHECK (source IN ('uploaded_by_person','declared_by_agent')),
 requested_by_user_id uuid NOT NULL REFERENCES swarm.users(user_id),
 requested_by_principal_id uuid REFERENCES swarm.agent_principals(principal_id),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','refused')),
 refusal_code text CHECK (refusal_code IN ('stale','precedence','principal_gone')),
 created_at timestamptz NOT NULL, declared_at timestamptz, completed_at timestamptz,
 CHECK (quarantine_key=workspace_id::text||'/'||principal_id::text||'/quarantine/'||job_id::text),
 CHECK ((source='uploaded_by_person' AND requested_by_principal_id IS NULL)
   OR (source='declared_by_agent' AND requested_by_principal_id IS NOT NULL AND requested_by_principal_id=principal_id)),
 CHECK ((state='pending' AND refusal_code IS NULL AND completed_at IS NULL)
   OR (state='done' AND refusal_code IS NULL AND declared_at IS NOT NULL AND completed_at IS NOT NULL)
   OR (state='refused' AND refusal_code IS NOT NULL AND declared_at IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX agent_avatar_jobs_pending ON swarm.agent_avatar_jobs(workspace_id, principal_id, created_at)
 WHERE state='pending' AND declared_at IS NOT NULL;
CREATE TABLE swarm.agent_model_provenance (
 principal_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
 FOREIGN KEY(principal_id,workspace_id) REFERENCES swarm.agent_principals(principal_id,workspace_id),
 model_set_by text NOT NULL CHECK (model_set_by IN ('person','agent','unknown')),
 set_by_user_id uuid REFERENCES swarm.users(user_id), set_at timestamptz NOT NULL,
 CHECK ((model_set_by='person' AND set_by_user_id IS NOT NULL)
   OR (model_set_by IN ('agent','unknown') AND set_by_user_id IS NULL))
);
-- Last declaration, not last attributable declaration: unattributed recent edits
-- must not acquire the attribution of an older edit. Workspace streams have one
-- monotonic seq; occurred_at/event_id give deterministic fallback ordering.
INSERT INTO swarm.agent_model_provenance(principal_id,workspace_id,model_set_by,set_by_user_id,set_at)
SELECT p.principal_id,p.workspace_id,
 CASE WHEN e.actor_agent_principal IS NOT NULL THEN 'agent'
      WHEN e.actor_user IS NOT NULL THEN 'person' ELSE 'unknown' END,
 CASE WHEN e.actor_agent_principal IS NULL THEN e.actor_user ELSE NULL END,
 coalesce(e.occurred_at_server,p.created_at)
FROM swarm.agent_principals p
LEFT JOIN LATERAL (
 SELECT ev.actor_user,ev.actor_agent_principal,ev.occurred_at_server
 FROM swarm.events ev JOIN swarm.streams st ON st.stream_id=ev.stream_id AND st.kind='workspace'
 WHERE ev.workspace_id=p.workspace_id AND ev.type='AgentModelDeclared'
   AND ev.payload->>'principal_id'=p.principal_id::text
 ORDER BY ev.seq DESC,ev.occurred_at_server DESC,ev.event_id DESC LIMIT 1
) e ON true
WHERE p.model IS NOT NULL;

ALTER TABLE swarm.agent_avatars OWNER TO swarm_admin;
ALTER TABLE swarm.agent_avatar_jobs OWNER TO swarm_admin;
ALTER TABLE swarm.agent_model_provenance OWNER TO swarm_admin;
ALTER TABLE swarm.agent_avatars ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.agent_avatar_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.agent_model_provenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON swarm.agent_avatars,swarm.agent_avatar_jobs,swarm.agent_model_provenance
 FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT SELECT,INSERT,UPDATE ON swarm.agent_avatars,swarm.agent_avatar_jobs,swarm.agent_model_provenance TO swarm_command;
CREATE POLICY command_all ON swarm.agent_avatars TO swarm_command USING(true) WITH CHECK(true);
CREATE POLICY command_all ON swarm.agent_avatar_jobs TO swarm_command USING(true) WITH CHECK(true);
CREATE POLICY command_all ON swarm.agent_model_provenance TO swarm_command USING(true) WITH CHECK(true);

CREATE VIEW swarm_read.agent_identity_marks WITH (security_barrier=true) AS
SELECT p.principal_id,a.sha256 AS avatar_version,a.source AS avatar_source,
 coalesce(mp.model_set_by,'unknown') AS model_set_by,
 NULL::text AS verified_family, -- Phase 6: reviewed D2 exact client-ID mapping only.
 NULL::text AS app_host -- Base lacks identity v1. Do not widen current member exposure.
 -- At L 3c415572, 20261006000004:459 exposes app.client_id to members;
 -- its :462 membership gate and :490-491 app projection permit raw client ID.
 -- Agreement/extraction needs the identity v1 base and the held directory reviews.
FROM swarm.agent_principals p
LEFT JOIN swarm.agent_avatars a ON a.principal_id=p.principal_id AND a.workspace_id=p.workspace_id
LEFT JOIN swarm.agent_model_provenance mp ON mp.principal_id=p.principal_id AND mp.workspace_id=p.workspace_id
WHERE swarm.is_member(p.workspace_id,auth.uid())
 AND NOT EXISTS(SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p.principal_id);
ALTER VIEW swarm_read.agent_identity_marks OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.agent_identity_marks FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT SELECT ON swarm_read.agent_identity_marks TO authenticated,swarm_read;
