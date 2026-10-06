/** Unwired local tools. The registry owns admission/schema/annotations; the
 * authenticated host supplies the transport and protected attachment channel.
 */
import { HOUSEHOLD_TOOLS, HouseholdToolInputError, validateHouseholdToolArguments,
  type HouseholdToolHostContext } from '../protocol/household-tool-registry.js';
import { HouseholdObjectClient, type HouseholdClientResult, type HouseholdPreparedRequest } from '../cloud/household-objects.js';
import { MCP_RESULT_MAX_BYTES } from './tools.js';

export const HOUSEHOLD_MCP_TOOLS: typeof HOUSEHOLD_TOOLS = HOUSEHOLD_TOOLS;
export interface HouseholdMcpResult {
  isError: boolean;
  content: readonly { type: 'text'; text: string }[];
}
export interface HouseholdMcpTools {
  tools: typeof HOUSEHOLD_TOOLS;
  prepare(name: string, input: unknown, host?: Pick<HouseholdToolHostContext, 'upload'>): HouseholdPreparedRequest;
  call(name: string, input: unknown, host?: Pick<HouseholdToolHostContext, 'upload'>, options?: { signal?: AbortSignal }): Promise<HouseholdMcpResult>;
  retry(request: HouseholdPreparedRequest, options?: { signal?: AbortSignal }): Promise<HouseholdMcpResult>;
}

/** The client supplies a closed projection with no transfer credentials. */
function householdMcpResult(result: HouseholdClientResult): HouseholdMcpResult {
  const next_action = result.status === 'unknown'
    ? result.request_id ? 'Retry identical input with the same request_id to recover the recorded outcome.' : 'Retry the read.'
    : result.status === 'pending' ? 'The upload is reserved; no revision is committed. Complete the protected upload, then call file_upload_commit with a new request_id.'
    : result.status === 'conflict' ? 'kind' in result && result.kind === 'todo'
      ? 'Read the current to-do and review the change. Submit it with the current version and a new request_id.'
      : 'Recover the retained draft, read the current revision, and review the merge. Submit the reviewed patch with a new request_id.'
    : result.status === 'refused' ? 'Resolve the refusal before submitting another request.'
    : result.status === 'ok' && result.kind === 'object_read' && result.revision.kind === 'file'
      ? 'File metadata is available. Use the host protected attachment channel for bytes; access must be rechecked.' : null;
  const output = { ...result, next_action };
  const raw = JSON.stringify(output);
  const response = { isError: result.status === 'refused' || result.status === 'unknown' || result.status === 'conflict',
    content: [{ type: 'text' as const, text: raw }] };
  // AM13 budgets the escaped text inside the transport envelope. The server's
  // 28 KiB pages fit this local 32 KiB cap, including cursors and next_action.
  if (Buffer.byteLength(JSON.stringify(response)) <= MCP_RESULT_MAX_BYTES) return response;
  // Do not hide a committed write or suggest retrying it merely to fit a cap.
  const summary = { status: result.status === 'ok' ? 'refused' : result.status,
    ...(result.status === 'ok' ? { reason: 'result_too_large' } : {}),
    ...('request_id' in result ? { request_id: result.request_id } : {}),
    truncated: true, next_action: next_action ?? (result.status === 'committed'
      ? 'The write committed. Read the object or history for details.' : 'Narrow the read to fit the MCP byte limit.') };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(summary) }] };
}

export function createHouseholdMcpTools(client: HouseholdObjectClient): HouseholdMcpTools {
  return {
    tools: HOUSEHOLD_MCP_TOOLS,
    /** Callers keep this host-only handle for interrupted attempts. */
    prepare(name: string, input: unknown, host: Pick<HouseholdToolHostContext, 'upload'> = {}): HouseholdPreparedRequest {
      return client.prepare(name, input, host);
    },
    async call(name: string, input: unknown, host: Pick<HouseholdToolHostContext, 'upload'> = {}, options: { signal?: AbortSignal } = {}): Promise<HouseholdMcpResult> {
      try {
        validateHouseholdToolArguments(name, input);
        return householdMcpResult(await client.prepare(name, input, host).send(options));
      } catch (error) {
        if (!(error instanceof HouseholdToolInputError)) throw error;
        return householdMcpResult({ status: 'refused', reason: error.code });
      }
    },
    async retry(request: HouseholdPreparedRequest, options: { signal?: AbortSignal } = {}): Promise<HouseholdMcpResult> {
      return householdMcpResult(await request.retry(options));
    },
  };
}
