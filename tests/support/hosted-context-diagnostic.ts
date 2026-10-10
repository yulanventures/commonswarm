import assert from 'node:assert/strict';

// Shared by the Deno fixture and its Node parent. No free-form metadata.
export const HOSTED_CONTEXT_STEPS: readonly string[] = [
  'child-startup', 'input', 'command-import', 'claim-import', 'protocol-import',
  'output-import', 'protocol-setup', 'first-claim', 'replay', 'continue',
  'separate-claim', 'committed-context', 'malformed', 'conflict', 'revoked',
  'committed-count', 'cleanup',
  // Fixed assertion sites in the MCP child; labels never contain runtime values.
  'storage-01', 'storage-02', 'storage-03', 'storage-04',
  'storage-05', 'storage-06', 'storage-07', 'storage-08',
  'storage-09', 'household-01', 'bound-01', 'bound-02',
  'bound-03', 'bound-04', 'bound-05', 'bound-06',
  'bound-07', 'bound-08', 'bound-09', 'bound-10',
  'bound-11', 'discovery-01', 'discovery-02', 'discovery-03',
  'discovery-04', 'discovery-05', 'discovery-06', 'discovery-07',
  'discovery-08', 'discovery-09', 'discovery-10', 'discovery-11',
  'first-message-01', 'first-message-02', 'first-message-03', 'first-message-04',
  'first-message-05', 'first-message-06', 'first-message-07', 'first-message-08',
  'first-message-09', 'first-message-10', 'first-message-11', 'first-message-12',
  'first-message-13', 'first-message-14', 'durable-new-01', 'durable-new-02',
  'durable-new-03', 'durable-new-04', 'durable-new-05', 'durable-new-06',
  'durable-new-07', 'durable-new-08', 'durable-new-09', 'durable-new-10',
  'durable-new-11', 'durable-new-12', 'durable-new-13', 'durable-new-14',
  'durable-new-15', 'durable-new-16', 'durable-new-17', 'replay-01',
  'replay-02', 'replay-03', 'replay-04', 'replay-05',
  'replay-06', 'replay-07', 'replay-08', 'replay-09',
  'continue-01', 'continue-02', 'continue-03', 'continue-04',
  'continue-05', 'continue-06', 'continue-07', 'continue-08',
  'continue-09', 'continue-10', 'continue-11', 'continue-12',
  'continue-13', 'continue-14', 'continue-15', 'continue-16',
  'continue-17', 'collision-01', 'collision-02', 'collision-03',
  'collision-04', 'collision-05', 'collision-06', 'collision-07',
  'collision-08', 'collision-09', 'collision-10', 'collision-11',
  'collision-12', 'collision-13', 'collision-14', 'collision-15',
  'collision-16', 'collision-17', 'collision-18', 'collision-19',
  'collision-20', 'collision-21', 'collision-22', 'persisted-01',
  'persisted-02', 'persisted-03', 'malformed-01', 'malformed-02',
  'conflict-01', 'conflict-02', 'public-household-01', 'public-household-02',
  'public-household-03', 'prepared-household-01', 'prepared-household-02', 'prepared-household-03',
  'prepared-household-04', 'prepared-household-05', 'prepared-household-06', 'prepared-household-07',
  'prepared-household-08', 'prepared-household-09', 'prepared-household-10', 'prepared-household-11',
  'prepared-household-12', 'prepared-household-13', 'prepared-household-14', 'prepared-household-15',
  'prepared-household-16', 'prepared-household-17', 'prepared-household-18', 'prepared-household-19',
  'prepared-household-20', 'prepared-household-21', 'prepared-household-22', 'prepared-household-23',
  'prepared-household-24', 'prepared-household-25', 'prepared-household-26', 'prepared-household-27',
  'prepared-household-28', 'prepared-household-29', 'prepared-household-30', 'prepared-household-31',
  'prepared-household-32', 'prepared-household-33', 'prepared-household-34', 'prepared-household-35',
  'cannot-resume-01', 'cannot-resume-02', 'cannot-resume-03', 'cannot-resume-04',
  'cannot-resume-05', 'cannot-resume-06', 'cannot-resume-07', 'cannot-resume-08',
  'cannot-resume-09', 'cannot-resume-10', 'cannot-resume-11', 'cannot-resume-12',
  'cannot-resume-13', 'cannot-resume-14', 'cannot-resume-15', 'expiry-01',
  'expiry-02', 'expiry-03', 'expiry-04', 'expiry-05',
  'expiry-06', 'expiry-07', 'new-after-expiry-01', 'new-after-expiry-02',
  'new-after-expiry-03', 'new-after-expiry-04', 'new-after-expiry-05', 'new-after-expiry-06',
  'new-after-expiry-07', 'new-after-expiry-08', 'new-after-expiry-09', 'new-after-expiry-10',
  'new-after-expiry-11', 'new-after-expiry-12', 'new-after-expiry-13', 'new-after-expiry-14',
  'new-after-expiry-15', 'new-after-expiry-16', 'expiry-close-01', 'expiry-close-02',
  'expiry-close-03', 'expiry-close-04', 'expiry-close-05', 'expiry-close-06',
  'expiry-close-07', 'expiry-close-08', 'expiry-close-09', 'expiry-close-10',
  'expiry-close-11', 'expiry-close-12', 'expiry-close-13', 'expiry-close-14',
  'expiry-close-15', 'expiry-close-16', 'expiry-close-17', 'expiry-close-18',
  'expiry-close-19', 'expiry-close-20', 'expiry-close-21', 'expiry-close-22',
  'revoked-01', 'revoked-02', 'revoked-03', 'revoked-04',
  'revoked-05', 'revoked-06', 'revoked-07', 'revoked-08',
  'count-01',
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
