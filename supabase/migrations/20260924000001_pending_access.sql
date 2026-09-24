-- Pending access is a derived read of durable issuance state. Never project a
-- bearer, digest, locator, token id, or registrar identity into this contract.
CREATE FUNCTION swarm_read.pending_access(p_workspace_id uuid)
RETURNS TABLE (
  kind text,
  principal_id uuid,
  principal_name text,
  join_credential_id uuid,
  owner_user_id uuid,
  issuer_display text,
  issued_at timestamptz,
  expires_at timestamptz,
  seats_used integer,
  seat_cap integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_user_id uuid := NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
BEGIN
  IF v_user_id IS NULL OR NOT swarm.is_member(p_workspace_id, v_user_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    'classic'::text,
    p.principal_id,
    p.name,
    NULL::uuid,
    p.owner_user_id,
    COALESCE(u.display_name, 'Workspace member'),
    COALESCE(tokens.first_issued_at, p.created_at),
    tokens.first_expires_at,
    NULL::integer,
    NULL::integer
  FROM swarm.agent_principals AS p
  LEFT JOIN swarm.memberships AS owner_membership
    ON owner_membership.workspace_id = p.workspace_id
   AND owner_membership.user_id = p.owner_user_id
   AND owner_membership.revoked_at IS NULL
  LEFT JOIN swarm.users AS u ON u.user_id = owner_membership.user_id
  LEFT JOIN LATERAL (
    SELECT min(t.issued_at) AS first_issued_at,
           min(t.expires_at) AS first_expires_at
    FROM swarm.agent_tokens AS t
    WHERE t.principal_id = p.principal_id
  ) AS tokens ON true
  WHERE p.workspace_id = p_workspace_id
    AND p.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.agent_join_credentials AS registrar
      WHERE registrar.registrar_principal_id = p.principal_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM swarm.agent_tokens AS used
      WHERE used.principal_id = p.principal_id
        AND (used.first_used_at IS NOT NULL
          OR used.revoked_at IS NOT NULL
          OR used.expires_at <= statement_timestamp())
    )
  UNION ALL
  SELECT
    'join'::text,
    NULL::uuid,
    NULL::text,
    c.id,
    c.owner_user_id,
    COALESCE(issuer.display_name, 'Workspace member'),
    c.created_at,
    c.expires_at,
    c.seats_used,
    c.seat_cap
  FROM swarm.agent_join_credentials AS c
  LEFT JOIN swarm.memberships AS issuer_membership
    ON issuer_membership.workspace_id = c.workspace_id
   AND issuer_membership.user_id = c.owner_user_id
   AND issuer_membership.revoked_at IS NULL
  LEFT JOIN swarm.users AS issuer ON issuer.user_id = issuer_membership.user_id
  WHERE c.workspace_id = p_workspace_id
    AND c.revoked_at IS NULL
    AND c.expires_at > statement_timestamp()
    AND c.seats_used < c.seat_cap
  ORDER BY 7, 2 NULLS LAST, 4 NULLS LAST;
END;
$$;

ALTER FUNCTION swarm_read.pending_access(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.pending_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.pending_access(uuid) TO authenticated, swarm_read;

COMMENT ON FUNCTION swarm_read.pending_access(uuid) IS
  'Membership-gated pending agent principals and available join credentials. Explicit projection contains no credential material or token identity.';
