import postgres from 'npm:postgres@3.4.9';
import { withDatabaseTls } from '../_shared/database-options.ts';
import { createAdminRequestVerifier } from '../_shared/admin-oauth-db.ts';
import { isAdminAdmission, type AdminAdmission } from '../_shared/admin-oauth-auth.ts';

// The authority adapter trusts only capabilities from this private verifier.
// Public verifier constructors support isolated crypto tests, but cannot confer
// authority through imports with a caller-selected JWKS or replay store.
const databaseUrl = Deno.env.get('SWARM_DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
if (!databaseUrl) throw new Error('admin_database_configuration_required');
const proofDb = postgres(databaseUrl, withDatabaseTls({ max: 1, prepare: false, idle_timeout: 3, connect_timeout: 5 }, Deno.env.get('SWARM_DATABASE_TLS_CA_B64')));
const verifier = createAdminRequestVerifier(proofDb);
export async function admitAdminRequest(request: Request, surface: 'admin_command' | 'admin_mcp'): Promise<AdminAdmission> {
  return await verifier.verify(request, surface);
}
export function isVerifiedAdminAdmission(value: unknown): value is AdminAdmission {
  return isAdminAdmission(value, verifier);
}
