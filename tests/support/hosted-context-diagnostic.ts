import assert from 'node:assert/strict';

// Shared by the Deno fixture and its Node parent. No free-form metadata.
export const HOSTED_CONTEXT_STEPS: readonly string[] = [
  'child-startup', 'input', 'command-import', 'claim-import', 'protocol-import',
  'output-import', 'protocol-setup', 'first-claim', 'replay', 'continue',
  'separate-claim', 'committed-context', 'malformed', 'conflict', 'revoked',
  'committed-count', 'cleanup',
];

// tool-errors.ts does not export its catalog. The pure test reconciles this
// inventory with MESSAGES and the constructor's normalized fallback.
export const HOSTED_TOOL_FAILURE_CODES: readonly string[] = [
  'hosted_grant_forbidden', 'hosted_grant_unavailable', 'hosted_grant_binding_mismatch',
  'forbidden', 'credential_kind_forbidden', 'unauthenticated', 'hosted_seat_forbidden',
  'hosted_seat_revoked', 'hosted_seat_name_invalid', 'hosted_seat_name_taken',
  'hosted_seat_limit_reached', 'principal_limit_reached', 'hosted_check_batch_forbidden',
  'command_id_conflict', 'invalid_request', 'payload_too_large', 'upgrade_required',
  'identity_resume_unavailable', 'context_expired', 'context_closed',
  'workspace_unavailable', 'workspace_mismatch', 'session_capacity_reached',
  'name_allocation_busy', 'rate_limited', 'tool_failed',
];
const ERROR_CODES = new Set([
  ...HOSTED_TOOL_FAILURE_CODES, 'ERR_ASSERTION', 'TypeError', 'SyntaxError',
  'RangeError', 'Error', 'UnknownError', 'ETIMEDOUT', 'ChildProcessFailure',
  'InvalidDiagnostic',
]);

// PostgreSQL 17, Appendix A: https://www.postgresql.org/docs/17/errcodes-appendix.html
const SQLSTATE_CLASSES = new Set([
  '00', '01', '02', '03', '08', '09', '0A', '0B', '0F', '0L', '0P', '0Z',
  '20', '21', '22', '23', '24', '25', '26', '27', '28', '2B', '2D', '2F',
  '34', '38', '39', '3B', '3D', '3F', '40', '42', '44', '53', '54', '55',
  '57', '58', 'F0', 'HV', 'P0', 'XX',
]);
function isSqlstate(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Z]{5}$/u.test(value)
    && SQLSTATE_CLASSES.has(value.slice(0, 2));
}

type CodedErrorClass = new (...args: never[]) => Error & { code: string };
export function classifyHostedContextFailure(error: unknown, classes: {
  HostedToolFailure?: CodedErrorClass; PostgresError?: CodedErrorClass;
} = {}): { error_code: string; sqlstate: string | null } {
  // postgres.js creates PostgresError only at its database error boundary.
  // Generic Error.code and user-supplied error names are never SQLSTATE.
  const sqlstate = classes.PostgresError && error instanceof classes.PostgresError
    && isSqlstate(error.code) ? error.code : null;
  const error_code = classes.HostedToolFailure && error instanceof classes.HostedToolFailure
    ? (HOSTED_TOOL_FAILURE_CODES.includes(error.code) ? error.code : 'InvalidDiagnostic')
    : error instanceof assert.AssertionError ? 'ERR_ASSERTION'
    : error instanceof TypeError ? 'TypeError'
    : error instanceof SyntaxError ? 'SyntaxError'
    : error instanceof RangeError ? 'RangeError'
    : error instanceof Error ? 'Error' : 'UnknownError';
  return { error_code, sqlstate };
}

export const HOSTED_CONTEXT_FAILURE_PREFIX = 'SID_MCP_CLAIM_FAILED ';
const FALLBACK = { step: 'child-startup', error_code: 'InvalidDiagnostic', sqlstate: null, http_status: null };
const FIELDS = ['step', 'error_code', 'sqlstate', 'http_status'];

export function rebuildHostedContextDiagnostic(value: unknown): string {
  const fallback = () => HOSTED_CONTEXT_FAILURE_PREFIX + JSON.stringify(FALLBACK);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(row, key))
    || typeof row.step !== 'string' || !HOSTED_CONTEXT_STEPS.includes(row.step)
    || typeof row.error_code !== 'string' || !ERROR_CODES.has(row.error_code)
    || (row.sqlstate !== null && !isSqlstate(row.sqlstate))
    || (row.http_status !== null && (typeof row.http_status !== 'number'
      || !Number.isInteger(row.http_status) || row.http_status < 100 || row.http_status > 599))) return fallback();
  return HOSTED_CONTEXT_FAILURE_PREFIX + JSON.stringify({
    step: row.step, error_code: row.error_code, sqlstate: row.sqlstate, http_status: row.http_status,
  });
}

export function parseHostedContextDiagnostic(line: string): string {
  if (!line.startsWith(HOSTED_CONTEXT_FAILURE_PREFIX) || line.length > 512) {
    return rebuildHostedContextDiagnostic(null);
  }
  try {
    return rebuildHostedContextDiagnostic(JSON.parse(line.slice(HOSTED_CONTEXT_FAILURE_PREFIX.length)));
  } catch {
    return rebuildHostedContextDiagnostic(null);
  }
}
