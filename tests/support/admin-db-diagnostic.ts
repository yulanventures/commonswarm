/** The DB harness may expose catalog metadata, never exception text or values. */
export const approvalSteps = [
  'initialize', 'schema-isolation', 'fixture-prepare', 'verification-prepare',
  'projection-prepare', 'actor-refusals', 'verification-refusals', 'owner-injection',
  'owner-approval', 'approval-retry', 'command-id-conflict', 'alice-binding',
  'active-control', 'withdrawal-fault-setup', 'withdrawal-rollback',
  'withdrawal-rollback-readback', 'withdrawal-fault-cleanup', 'owner-withdrawal',
  'withdrawal-readback', 'bob-control', 'no-resurrection', 'issuance-closed',
  'outer-rollback', 'connection-close',
] as const;
export type ApprovalStep = typeof approvalSteps[number];
const marker = 'ADMIN_OWNER_APPROVAL_DIAGNOSTIC ';
export function approvalCatalog(schema: string) {
  // Names come only from the schema-only pg_dump already used for isolation.
  // An allowlist avoids treating token-shaped text as a catalog identifier.
  return {
    tables: new Set([...schema.matchAll(/CREATE TABLE (?:swarm|swarm_read|commonswarm_oauth)\.([a-z_][a-z0-9_]{0,62})\s*\(/gu)].map(match => match[1]!)),
    constraints: new Set([...schema.matchAll(/(?:ADD CONSTRAINT|CREATE (?:UNIQUE )?INDEX) ([a-z_][a-z0-9_]{0,62})\s/gu)].map(match => match[1]!)),
  };
}
export type ApprovalCatalog = ReturnType<typeof approvalCatalog>;

export function approvalDiagnostic(step: ApprovalStep, error: unknown, catalog: ApprovalCatalog): string {
  let fields: Record<string, unknown> = {};
  // assert.rejects may wrap an unexpected PostgreSQL error as its actual value.
  // Retain that error's catalog fields without exposing the assertion message.
  for (let depth = 0; depth < 3 && error !== null && typeof error === 'object'; depth++) {
    fields = error as Record<string, unknown>;
    if (typeof fields.code === 'string' && /^[0-9A-Z]{5}$/u.test(fields.code)) break;
    error = fields.cause ?? fields.actual;
  }
  return marker + JSON.stringify({ step: approvalSteps.includes(step) ? step : 'initialize',
    sqlstate: typeof fields.code === 'string' && /^[0-9A-Z]{5}$/u.test(fields.code) ? fields.code : null,
    constraint: typeof fields.constraint_name === 'string' && catalog.constraints.has(fields.constraint_name) ? fields.constraint_name : null,
    table: typeof fields.table_name === 'string' && catalog.tables.has(fields.table_name) ? fields.table_name : null });
}

/** Revalidate the child output; never attach raw stdout/stderr to an assertion. */
export function approvalFailureDetail(stdout: string, catalog: ApprovalCatalog): string {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(marker)) continue;
    try {
      const fields = JSON.parse(line.slice(marker.length));
      if (!approvalSteps.includes(fields.step)) continue;
      return approvalDiagnostic(fields.step, { code: fields.sqlstate,
        constraint_name: fields.constraint, table_name: fields.table }, catalog).slice(marker.length);
    } catch { /* A partial marker is not safe diagnostic evidence. */ }
  }
  return 'step=initialize; safe diagnostic unavailable';
}
