import type { CloudTarget } from './config.js';
import { withClientBuild } from './client-build.js';
import { CLIENT_PROTOCOL_VERSION } from './config.js';
import type { HouseholdTransport } from './household-objects.js';
import type { HouseholdToolInvocation } from '../protocol/household-tool-registry.js';
/** Local credentials select identity. The seat field only preserves the shared
 * registry schema and is never resolved as a hosted handle by this transport. */
import { HOUSEHOLD_LOCAL_SEAT, HOUSEHOLD_TOOL_REGISTRY } from '../protocol/household-tool-registry.js';
export const LOCAL_HOUSEHOLD_SEAT = HOUSEHOLD_LOCAL_SEAT;

export function householdWireRequest(invocation: HouseholdToolInvocation): { tool: string; arguments: Record<string, unknown> } {
  const args: Record<string, unknown> = { seat: LOCAL_HOUSEHOLD_SEAT,
    ...(invocation.request_id ? { request_id: invocation.request_id } : {}) };
  if ('query' in invocation) {
    const { kind, ...query } = invocation.query;
    return { tool: kind === 'object_read' && invocation.objectTypes.length === 1 && invocation.objectTypes[0] === 'file' ? 'file_read' : kind,
      arguments: { ...args, ...query } };
  }
  const { kind, ...command } = invocation.command;
  // To-do writes have the same tool and core names, with no blob reservation.
  if (invocation.objectTypes.includes('todo') && HOUSEHOLD_TOOL_REGISTRY.some(row => row.name === kind && row.effect === 'commit')) {
    return { tool: kind, arguments: { ...args, ...command } };
  }
  if (kind === 'create_household_object') return { tool: 'object_create', arguments: { ...args, ...command } };
  if (kind === 'update_household_object') return { tool: 'object_update', arguments: { ...args, ...command } };
  if (kind === 'reserve_household_upload' && 'change' in command) return { tool: 'file_upload_begin', arguments: { ...args, object_id: command.object_id, change: command.change } };
  if (kind === 'commit_household_upload') return { tool: 'file_upload_commit', arguments: { ...args, ...command } };
  throw new TypeError('unsupported household operation');
}

export function createHouseholdHttpTransport(options: { target: CloudTarget;
  authenticate(): Promise<{ credential: string; fetcher?: typeof fetch }> }): HouseholdTransport {
  return {
    async execute(invocation, { signal }) {
      const wire = householdWireRequest(invocation);
      const { credential, fetcher = fetch } = await options.authenticate();
      const reading = 'query' in invocation;
      const response = await fetcher(`${options.target.url}/functions/v1/${reading ? 'read' : 'command'}`, {
        method: 'POST', headers: { authorization: `Bearer ${credential}`, apikey: options.target.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify(reading
          ? { resource: 'household', workspace_id: invocation.workspace_id, ...wire }
          : withClientBuild({ command_id: invocation.request_id, client_version: CLIENT_PROTOCOL_VERSION, workspace_id: invocation.workspace_id,
            stream: { kind: 'workspace' }, command: { kind: 'household_tool', ...wire } })), signal,
      });
      if (response.status >= 500) throw new Error('household transport unavailable');
      if (!response.ok) {
        // Only stable codes cross this boundary; raw error text can hold secrets.
        let body: unknown;
        try { body = await response.json(); } catch { /* A non-JSON refusal has no code. */ }
        const data = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const code = data.reason ?? data.error ?? data.code;
        return { status: 'refused', reason: typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'request_refused' };
      }
      return await response.json();
    },
  };
}
