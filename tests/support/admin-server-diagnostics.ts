/** Only structural observations may leave a server harness. Never serialize a body/error. */
function code(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(value) &&
    !value.startsWith("swm_") ? value : null;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function time(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) ? value : null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export class AdminHarnessAssertion extends Error {}
export class AdminServerDiagnostics {
  private responses: Record<string, unknown>[] = [];
  private counts: Record<string, unknown>[] = [];
  private assertion: Record<string, number | boolean | null> = {};
  count(operation: string, value: unknown): void {
    this.counts.push({ operation: code(operation), value: count(value) });
    this.counts = this.counts.slice(-12);
  }
  response(operation: string, status: number, value: unknown): void {
    const body = record(value), active = record(body.active);
    this.responses.push({
      operation: code(operation), status,
      error_code: code(body.error), result_status: code(body.status),
      grant_page_size: Array.isArray(body.grants) ? body.grants.length : null,
      grant_state_counts: Object.fromEntries(["active", "revoked", "suspended", "expired"].map(state =>
        [state, Array.isArray(body.grants) ? body.grants.filter(grant => record(grant).state === state).length : null])),
      action_page_size: Array.isArray(body.actions) ? body.actions.length : null,
      member_page_size: Array.isArray(body.members) ? body.members.length : null,
      event_count: Array.isArray(body.events) ? body.events.length : null,
      has_next_before: typeof body.next_before === "string",
      active: { grant_count: count(active.grant_count), full_account_count: count(active.full_account_count),
        expires_at: time(active.expires_at), full_account_expires_at: time(active.full_account_expires_at) },
    });
    this.responses = this.responses.slice(-12);
  }
  check(ok: unknown, observed: Record<string, unknown> = {}): void {
    this.assertion = { condition: Boolean(ok) };
    for (const [key, value] of Object.entries(observed)) {
      if (/^[a-z_]{1,80}$/u.test(key) &&
          (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || value === null)) {
        this.assertion[key] = value as number | boolean | null;
      }
    }
    if (!ok) throw new AdminHarnessAssertion("server harness assertion failed");
  }
  failure(error: unknown): Record<string, unknown> {
    const sql = record(error);
    return { assertion: this.assertion, responses: this.responses, counts: this.counts,
      failure_kind: error instanceof AdminHarnessAssertion ? "assertion" : "exception",
      sqlstate: typeof sql.code === "string" && /^[0-9A-Z]{5}$/u.test(sql.code) ? sql.code : null };
  }
}
