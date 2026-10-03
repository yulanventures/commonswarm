import { safeAdminError } from '../../supabase/functions/command/failures.js';

/** Preserve the actionable cause without exposing driver SQL/parameters or
 * exec stderr through Node's automatic Error.cause serialization. */
export function edgeSetupCause(error: unknown, phase: string) {
  const fields = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = typeof fields.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(fields.code) ? fields.code
    : typeof fields.status === 'number' && Number.isInteger(fields.status) ? String(fields.status) : null;
  const firstLine = error instanceof Error ? new Error(error.message.split(/[\r\n]/u)[0]) : null;
  if (firstLine && typeof fields.name === 'string' && /^[A-Za-z]+Error$/u.test(fields.name)) firstLine.name = fields.name;
  const summary = { phase: /^[a-z-]{1,40}$/u.test(phase) ? phase : 'unknown', code,
    sqlstate: code && /^[A-Z0-9]{5}$/u.test(code) ? code : null,
    message: firstLine ? safeAdminError(firstLine) : 'unknown error' };
  return Object.assign(new Error(JSON.stringify(summary)), { summary });
}
