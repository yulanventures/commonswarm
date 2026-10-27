import { dbAssert } from './admin-schema-db.js';

// Approved Allow writer/narrow ACL: commit 8b477b1655ac and
// deploy/release-proofs/permanence/20261019000007-catalog.sql:1-10,48-50.
// Assert the installed permanence grant separately; historical catalogs remain
// byte-exact and their prerequisites are restored only in owned rollback clones.
export const installedApprovalFamilyAcl = dbAssert(`SELECT
  array_agg(x.grantee::regrole::text || ':' || x.privilege_type || ':' ||
    x.grantor::regrole::text || ':' || x.is_grantable::text ORDER BY 1)
    = ARRAY['swarm_command:UPDATE:swarm_admin:false']::text[]
  FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE a.attrelid='swarm.household_content_connections'::regclass
    AND a.attname='renewal_grant_id' AND NOT a.attisdropped`,
  'installed permanence approval family ACL is exact');

export const historicalApprovalFamilyAcl =
  'REVOKE UPDATE (renewal_grant_id) ON swarm.household_content_connections FROM swarm_command;';
