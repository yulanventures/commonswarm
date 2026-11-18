/**
 * Slow-command diagnostics: where a command's time went, logged only when it is slow.
 *
 * A request's phases are measured from marks taken at fixed boundaries in handleTransaction:
 *   auth       start of the request to the start of the local auth plan (connection, session admission, setup)
 *   plan_lock  planning and locking the local auth plan (credential discovery and every row-lock wait it takes)
 *   grant      the renewal-grant stamp (swarm.record_renewal_grant_use)
 *   body       the rest of the handler, up to its last step
 *   commit     the last step to the transaction's end (the commit and its deferred triggers)
 * A phase the request never reached (a refusal before the plan, for example) is null.
 *
 * The line names the command kind (only a kind the edge knows; anything else is "other"), durations, the HTTP
 * status, whether the workspace stream was locked and a server-generated request id (the one command_failures rows
 * carry). Nothing in it comes from the request: no ids, tokens, bodies, names or client-supplied headers.
 */
export const SLOW_COMMAND_LOG_MS = 1500;

type Mark = "start" | "plan_start" | "plan_end" | "grant_start" | "grant_end" | "body_end" | "end";

export class CommandTimer {
  private readonly marks = new Map<Mark, number>();
  private grantMs = 0;
  streamLocked = false;
  attempts = 0;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.marks.set("start", this.now());
  }

  /** A transaction attempt began; a retry replaces the previous attempt's inner marks. */
  attempt(): void {
    this.attempts += 1;
    for (const mark of ["plan_start", "plan_end", "grant_start", "grant_end", "body_end"] as const) this.marks.delete(mark);
    this.grantMs = 0;
  }

  mark(name: Exclude<Mark, "start">): void {
    const at = this.now();
    this.marks.set(name, at);
    if (name === "grant_end") {
      const started = this.marks.get("grant_start");
      if (started !== undefined) this.grantMs += at - started;
    }
  }

  phases(): { total_ms: number; phase_ms: Record<"auth" | "plan_lock" | "grant" | "body" | "commit", number | null> } {
    const at = (name: Mark) => this.marks.get(name);
    const start = at("start")!;
    const end = at("end") ?? this.now();
    const span = (from: number | undefined, to: number | undefined) =>
      from === undefined || to === undefined ? null : Math.max(0, Math.round(to - from));
    const planStart = at("plan_start");
    const planEnd = at("plan_end");
    const bodyEnd = at("body_end");
    const grant = at("grant_end") === undefined ? null : Math.round(this.grantMs);
    const bodySpan = span(planEnd, bodyEnd);
    return {
      total_ms: Math.max(0, Math.round(end - start)),
      phase_ms: {
        auth: span(start, planStart),
        plan_lock: span(planStart, planEnd),
        grant,
        body: bodySpan === null ? null : Math.max(0, bodySpan - (grant ?? 0)),
        commit: span(bodyEnd, end),
      },
    };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The log line for a slow command, or null when it was fast enough. Only fixed fields: the kind is logged only
 * when it is one the edge knows (`knownKinds`), and the request id is the server's own UUID. */
export function slowCommandLine(input: {
  commandKind: string;
  knownKinds: ReadonlySet<string>;
  timer: CommandTimer;
  status: number;
  requestId: string;
}): string | null {
  const { total_ms, phase_ms } = input.timer.phases();
  if (total_ms < SLOW_COMMAND_LOG_MS) return null;
  const kind = input.knownKinds.has(input.commandKind) ? input.commandKind : "other";
  return JSON.stringify({
    event: "command_slow",
    command_kind: kind,
    total_ms,
    phase_ms,
    status: Number.isInteger(input.status) ? input.status : 0,
    stream_locked: input.timer.streamLocked,
    attempts: input.timer.attempts,
    request_id: UUID.test(input.requestId) ? input.requestId : null,
  });
}
