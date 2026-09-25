/** One renewal per watching seat per minute. Three missed renewals make it stale. */
export const WAKE_LEASE_RENEW_MS = 60_000;
export const WAKE_LEASE_STALE_MS = 3 * WAKE_LEASE_RENEW_MS;
export const WAKE_LEASE_STALE_LABEL = `${WAKE_LEASE_STALE_MS / 60_000} minutes`;

export type WakeLeasePhase = "start" | "renew";
type ExitRule = { exit: number; sentence: (surface: "watcher" | "h0_poll", host: string | null, command: string, sessionContextPath?: string, remedyCommand?: string, contextSource?: "operator" | "profile", fallback?: string) => string };
export const NOTIFY_NO_RESTART_CLAUSE = "this watcher must not be restarted by a supervisor";
const proofRemedy = (sessionContextPath?: string, remedyCommand?: string, contextSource?: "operator" | "profile", fallback?: string) =>
  `${sessionContextPath ? `${contextSource === "profile" ? "the profile's host session context" : "the operator's --session-context path"} ${sessionContextPath} was refused; ` : ""}` +
  (remedyCommand ? `run ${remedyCommand}` : fallback ??
    "inspect this seat's resume output for a verified live context on this host, then retry from that host session");
const holder = (surface: "watcher" | "h0_poll", host: string | null) => surface === "h0_poll"
  ? "an H0 poll" : `a watcher on ${host ?? "another host"}`;

/** One source for each code's exit and operator sentence. Proof errors differ by phase. */
export const NOTIFY_LEASE_RULES = {
  notify_held_elsewhere: { exit: 76, sentence: (surface, host, command) =>
    `${holder(surface, host)} holds this seat's wake surface; ${surface === "h0_poll"
      ? `finish the poll there before starting ${command}`
      : `stop it there or run ${command}${command.includes("--take-over") ? "" : " --take-over"}`}` },
  wake_lease_superseded: { exit: 76, sentence: (surface, host) =>
    `${holder(surface, host)} took over this seat's wake surface; stop this watcher and use that surface there` },
  session_conflict: { exit: 76, sentence: () =>
    "Another live session owns this seat and its session moved elsewhere; stop this watcher" },
  session_expired: { exit: 76, sentence: (_surface, _host, _command, path, remedy, source, fallback) =>
    `This watcher's host session ended; ${proofRemedy(path, remedy, source, fallback)}` },
  session_retired: { exit: 76, sentence: () =>
    "This seat's host session was retired; start a new live session before starting its watcher" },
  session_proof_missing: {
    start: { exit: 76, sentence: (_surface, _host, _command, path, remedy, source, fallback) =>
      `A managed seat's watcher needs a live session proof (or the profile's host session); ${proofRemedy(path, remedy, source, fallback)}` },
    renew: { exit: 76, sentence: (_surface, _host, _command, path, remedy, source, fallback) =>
      `This watcher's session proof became missing during renewal; ${proofRemedy(path, remedy, source, fallback)}` },
  },
  session_proof_invalid: {
    start: { exit: 76, sentence: (_surface, _host, _command, path, remedy, source, fallback) =>
      `A managed seat's watcher needs a valid session proof (or the profile's host session); ${proofRemedy(path, remedy, source, fallback)}` },
    renew: { exit: 76, sentence: (_surface, _host, _command, path, remedy, source, fallback) =>
      `This watcher's session proof became invalid during renewal; ${proofRemedy(path, remedy, source, fallback)}` },
  },
} satisfies Record<string, ExitRule | Record<WakeLeasePhase, ExitRule>>;

export type NotifyLeaseCode = keyof typeof NOTIFY_LEASE_RULES;
export function wakeLeaseRule(code: NotifyLeaseCode, phase: WakeLeasePhase): ExitRule {
  const rule = NOTIFY_LEASE_RULES[code];
  return "exit" in rule ? rule : rule[phase];
}
export const NOTIFY_LEASE_EXITS = Object.fromEntries(
  (Object.keys(NOTIFY_LEASE_RULES) as NotifyLeaseCode[]).map(code => [code, wakeLeaseRule(code, "renew").exit]),
) as Record<NotifyLeaseCode, number>;
export const EXIT_NOTIFY_LEASE_LOST = NOTIFY_LEASE_EXITS.notify_held_elsewhere;

export function wakeLeaseExitSentence(
  code: NotifyLeaseCode,
  surface: "watcher" | "h0_poll",
  host: string | null,
  restartCommand: string,
  phase: WakeLeasePhase = "renew",
  sessionContextPath?: string,
  remedyCommand?: string,
  contextSource?: "operator" | "profile",
  fallback?: string,
): string {
  const rule = wakeLeaseRule(code, phase);
  const stop = rule.exit === 76 ? `${NOTIFY_NO_RESTART_CLAUSE}; ` : "";
  const sentence = rule.sentence(surface, host, restartCommand, sessionContextPath, remedyCommand, contextSource, fallback);
  const stdinReminder = restartCommand.includes("--agent-token-stdin") &&
    !sentence.includes(" | ") && !sentence.includes("pipe the same credential")
    ? "; pipe the same credential on stdin if starting another watcher" : "";
  return `[${code}] ${stop}${stop ? sentence.replace(/^[A-Z]/, letter => letter.toLowerCase()) : sentence}${stdinReminder}; exit ${rule.exit}.`;
}
