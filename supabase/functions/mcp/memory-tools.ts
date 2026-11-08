/**
 * Brain M3b: what the hosted memory tools send and return. Everything a memory tool returns that
 * carries workspace text (memories, versions, a replaced statement) is marked untrusted_content:
 * it is data written by people and agents, never instructions. Refusals use fixed copy here;
 * backend prose is never forwarded.
 */
import type { CommandResult } from "../command/contract.d.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { CHANNEL_READ_MARGIN_BYTES, channelPageWireBytes } from "./channel-page.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { HostedToolFailure } from "./tool-errors.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { type HostedToolArguments, memoryEvidenceHref, memorySubjectKey } from "./tools.ts";

/** The memory_save command in the exact form the server stores and compares. Arguments are validated. */
export function memorySaveCommand(args: HostedToolArguments): Record<string, unknown> {
  return {
    kind: "memory_save",
    memory_kind: args.kind,
    subject: memorySubjectKey(String(args.subject)),
    statement: String(args.statement).normalize("NFC").trim(),
    evidence: Array.isArray(args.evidence) ? args.evidence.map((link) => memoryEvidenceHref(link)) : [],
    ...(args.expected_revision === undefined ? {} : { expected_revision: args.expected_revision }),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** memory_save and memory_forget. A refusal over an existing memory is returned, not thrown, so the agent sees it. */
export function memoryWriteOutput(result: CommandResult): Record<string, unknown> {
  const body = result.body;
  if (result.status === 409 && (body.error === "memory_exists" || body.error === "memory_revision_conflict")) {
    const memory = record(body.memory);
    const revision = memory !== null && typeof memory.revision === "number" ? memory.revision : null;
    return {
      status: "refused",
      reason: body.error,
      untrusted_content: true,
      ...(memory === null || revision === null
        ? {
          message: "There's no active memory with that subject to update.",
          next_step: "Save it without expected_revision, with a new request_id.",
        }
        : {
          message: body.error === "memory_exists"
            ? "A memory with that subject already exists, with a different statement."
            : "That memory changed since you read it.",
          memory,
          next_step: `To replace it, call memory_save again with expected_revision ${revision} and a new request_id.`,
        }),
    };
  }
  if (result.status < 200 || result.status >= 300) throw new HostedToolFailure(body.error, body.resets_at);
  return {
    untrusted_content: true,
    memory: body.memory,
    memory_outcome: body.memory_outcome,
    ...(typeof body.previous_statement === "string" ? { previous_statement: body.previous_statement } : {}),
  };
}

/** Drops rows from the end until the result fits the response cap, and says so. */
export function fitMemoryRows(
  value: Record<string, unknown>,
  key: "memories" | "versions",
  note: string,
  maxResponseBytes: number,
): Record<string, unknown> {
  const rows = Array.isArray(value[key]) ? value[key] as unknown[] : [];
  const budget = maxResponseBytes - CHANNEL_READ_MARGIN_BYTES;
  const shaped = (kept: number) => kept === rows.length
    ? { ...value, [key]: rows }
    : { ...value, [key]: rows.slice(0, kept), truncated: true, note };
  let kept = rows.length;
  while (kept > 0 && channelPageWireBytes(shaped(kept)) > budget) kept -= 1;
  return shaped(kept);
}
