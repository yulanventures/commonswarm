import { createEdgeDatabase } from '../_shared/database.ts';
import { createAdminRequestVerifier } from '../_shared/admin-oauth-db.ts';
import { isAdminAdmission, type AdminAdmission, type AdminRequestVerifier } from '../_shared/admin-oauth-auth.ts';

// The authority adapter trusts only capabilities from this private verifier.
// Public verifier constructors support isolated crypto tests, but cannot confer
// authority through imports with a caller-selected JWKS or replay store.
let verifier: AdminRequestVerifier | null = null;
function requestVerifier(): AdminRequestVerifier {
  if (verifier !== null) return verifier;
  const databaseUrl = Deno.env.get('SWARM_DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!databaseUrl) throw new Error('admin_database_configuration_required');
  const proofDb = createEdgeDatabase(databaseUrl, { max: 1, idle_timeout: 3, connect_timeout: 5 }, Deno.env.get('SWARM_DATABASE_TLS_CA_B64'));
  verifier = createAdminRequestVerifier(proofDb);
  return verifier;
}
export async function admitAdminRequest(request: Request, surface: 'admin_command' | 'admin_mcp'): Promise<AdminAdmission> {
  return await requestVerifier().verify(request, surface);
}
export function isVerifiedAdminAdmission(value: unknown): value is AdminAdmission {
  return verifier !== null && isAdminAdmission(value, verifier);
}
