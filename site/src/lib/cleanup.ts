/*
 * Owner clean-up passes: remove agents from this workspace, or tombstone files, in bulk.
 *
 * NO NEW SERVER POWER. A pass is a client-side loop over two existing commands, so every item
 * gets the server's own authorization, audit, ledger and rate limits:
 *   - remove_agent_from_workspace: the agent leaves THIS workspace; its connection and its other
 *     workspaces stay, and it can be added back. This is the one consequence the view states.
 *     It never sends revoke_agent_principal, whose consequence depends on the agent's origin
 *     workspace (not visible to the browser): permanent retirement stays in Your agents.
 *   - file_tombstone: the file is tombstoned and can be restored until it is purged.
 *
 * A pass is FROZEN when the owner confirms: the account and workspace that opened it, the exact
 * targets, the operation and one command id per item. Scheduling stops the moment the context
 * changes (sign-out, another account or workspace, or the owner/admin role is lost); commands
 * already in flight may finish and are reported against the original pass. A lost reply is
 * "unknown", never "failed", and a retry resends the same command id and payload.
 */

export const CLEANUP_MAX_ITEMS = 200;
export const CLEANUP_CONCURRENCY = 4;

export type CleanupOperation = "remove_agent" | "tombstone_file";
export type CleanupOutcome = "accepted" | "already_done" | "refused" | "rate_limited" | "unknown" | "not_attempted";

export interface CleanupContext { userId: string; workspaceId: string }
export interface CleanupTarget { id: string; label: string }
export interface CleanupItem extends CleanupTarget { commandId: string }
export interface CleanupPass {
  readonly context: Readonly<CleanupContext>;
  readonly operation: CleanupOperation;
  readonly items: readonly Readonly<CleanupItem>[];
}

/** What the server is sent for one item: fixed per pass, identical on every retry. */
export function cleanupCommand(operation: CleanupOperation, targetId: string): Record<string, unknown> {
  return operation === "remove_agent"
    ? { kind: "remove_agent_from_workspace", principal_id: targetId }
    : { kind: "file_tombstone", file_id: targetId };
}

/** The consequence, stated before confirming and again in the result. */
export function cleanupConsequence(operation: CleanupOperation): string {
  return operation === "remove_agent"
    ? "Removes each agent from this workspace. Its connection and its other workspaces stay, and you can add it back. To retire an agent everywhere, use Your agents."
    : "Tombstones each file. Tombstoned files can be restored until they are purged.";
}

export function freezePass(
  context: CleanupContext,
  operation: CleanupOperation,
  targets: readonly CleanupTarget[],
  newId: () => string,
): CleanupPass {
  const unique = new Map<string, CleanupTarget>();
  for (const target of targets) if (target.id && !unique.has(target.id)) unique.set(target.id, target);
  if (unique.size === 0) throw new Error("Select at least one item.");
  if (unique.size > CLEANUP_MAX_ITEMS) throw new Error(`Select at most ${CLEANUP_MAX_ITEMS} items in one pass.`);
  const items = [...unique.values()].map((target) => Object.freeze({ id: target.id, label: target.label, commandId: newId() }));
  return Object.freeze({
    context: Object.freeze({ userId: context.userId, workspaceId: context.workspaceId }),
    operation,
    items: Object.freeze(items),
  });
}

/** Map one command reply (or a thrown transport error) to an outcome. */
export function classifyReply(reply: { status: number; body: Record<string, unknown> } | "lost"): CleanupOutcome {
  if (reply === "lost") return "unknown";
  const { status, body } = reply;
  if (status >= 200 && status < 300) return body.status === "replayed" ? "already_done" : "accepted";
  if (status === 409 && body.error === "file_tombstoned") return "already_done";
  if (status === 429) return "rate_limited";
  if (status >= 500 || status === 0) return "unknown";
  return "refused";
}

export type SendItem = (item: Readonly<CleanupItem>, command: Record<string, unknown>, context: Readonly<CleanupContext>) =>
  Promise<{ status: number; body: Record<string, unknown> } | "lost">;

/**
 * Run (or re-run) a pass. `only` limits the run to the given item ids, for retrying unknown
 * items; their command ids and payloads are the frozen ones. `current` is read before each new
 * item is scheduled: if it no longer matches the pass's context (or returns null because the
 * role was lost), nothing further starts and the rest is "not_attempted".
 */
export async function runPass(
  pass: CleanupPass,
  send: SendItem,
  current: () => CleanupContext | null,
  options: { only?: ReadonlySet<string>; concurrency?: number; onProgress?: (id: string, outcome: CleanupOutcome) => void } = {},
): Promise<Map<string, CleanupOutcome>> {
  const results = new Map<string, CleanupOutcome>();
  const queue = pass.items.filter((item) => !options.only || options.only.has(item.id));
  for (const item of queue) results.set(item.id, "not_attempted");
  const same = () => {
    const now = current();
    return now !== null && now.userId === pass.context.userId && now.workspaceId === pass.context.workspaceId;
  };
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < queue.length) {
      if (!same()) { stopped = true; break; }
      const item = queue[next++]!;
      let outcome: CleanupOutcome;
      try {
        outcome = classifyReply(await send(item, cleanupCommand(pass.operation, item.id), pass.context));
      } catch {
        outcome = "unknown";
      }
      results.set(item.id, outcome);
      options.onProgress?.(item.id, outcome);
      // A rate limit stops this pass: no automatic retry loop.
      if (outcome === "rate_limited") stopped = true;
    }
  };
  const width = Math.max(1, Math.min(options.concurrency ?? CLEANUP_CONCURRENCY, CLEANUP_CONCURRENCY));
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
  return results;
}

/** Items a retry may resend: only those whose outcome is unknown. */
export function retryable(results: ReadonlyMap<string, CleanupOutcome>): Set<string> {
  return new Set([...results].filter(([, outcome]) => outcome === "unknown").map(([id]) => id));
}

export function summarize(results: ReadonlyMap<string, CleanupOutcome>): Record<CleanupOutcome, number> {
  const counts: Record<CleanupOutcome, number> = {
    accepted: 0, already_done: 0, refused: 0, rate_limited: 0, unknown: 0, not_attempted: 0,
  };
  for (const outcome of results.values()) counts[outcome]++;
  return counts;
}
