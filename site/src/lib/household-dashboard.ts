import { createHouseholdObjectsController, mountHouseholdObjects, type HouseholdActions,
  type HouseholdVersionView, type HouseholdWorkspaceView, type HouseholdConflictView } from './household-objects-view';
import type { HouseholdOutcome } from '../../../src/protocol/household-object-events';
type Call = (command: Record<string, unknown>, requestId: string) => Promise<Record<string, unknown>>;
import { HOUSEHOLD_LOCAL_SEAT } from '../../../src/protocol/household-tool-registry';
import { HOUSEHOLD_OBJECT_LIMIT } from '../../../src/protocol/household-object-policy';
const seat = HOUSEHOLD_LOCAL_SEAT;
const version = (raw: Record<string, unknown>): HouseholdVersionView => ({
  revision: raw.revision as HouseholdVersionView['revision'], title: String(raw.title),
  author: raw.author as HouseholdVersionView['author'], occurred_at_server: Number(raw.occurred_at_server),
  live: raw.live === true, content: raw.content as HouseholdVersionView['content'] ?? null,
});
/** Scoped loader. The caller clears it at every workspace/session change; late
 * responses cannot mount content from the previous workspace. */
export function createHouseholdDashboard(root: HTMLElement) {
  let generation = 0;
  let unmount: (() => void) | undefined;
  const clear = () => { generation++; unmount?.(); unmount = undefined; root.replaceChildren(); };
  return {
    clear,
    async open(context: { workspace_id: string; name: string; viewer_user_id: string; audience: readonly string[] }, call: Call) {
      clear();
      const active = generation;
      const say = (message: string) => { if (active === generation) root.textContent = message; };
      say('Loading shared objects…');
      const tool = (name: string, args: Record<string, unknown>, requestId = crypto.randomUUID()) => call({
        kind: 'household_tool', tool: name, arguments: { seat, ...args } }, requestId);
      try {
        const access = await call({ kind: 'household_access' }, crypto.randomUUID());
        if (active !== generation) return;
        if (access.status !== 'ok') { say('Content access needs your confirmation. Choose reader or editor access before opening shared objects.'); return; }
        const entries: Record<string, unknown>[] = [];
        let offset = 0;
        for (;;) {
          const rows = await tool('object_list', { offset, limit: 100 });
          if (active !== generation) return;
          if (rows.status !== 'ok' || !Array.isArray(rows.objects)) throw new Error('household list refused');
          entries.push(...rows.objects);
          if (entries.length > HOUSEHOLD_OBJECT_LIMIT) throw new Error('household list exceeds workspace bound');
          if (rows.next_offset === null) break;
          if (!Number.isSafeInteger(rows.next_offset) || Number(rows.next_offset) <= offset || Number(rows.next_offset) >= HOUSEHOLD_OBJECT_LIMIT) throw new Error('household list cursor invalid');
          offset = Number(rows.next_offset);
        }
        const objects = [];
        for (const entry of entries) {
          const read = await tool(entry.kind === 'file' ? 'file_read' : 'object_read', { object_id: entry.object_id });
          const history = await tool('object_history', { object_id: entry.object_id, offset: 0, limit: 100 });
          if (active !== generation) return;
          if (read.status !== 'ok' || history.status !== 'ok' || !Array.isArray(history.revisions)) throw new Error('household read refused');
          const current = version({ ...(read.revision as Record<string, unknown>), content: read.content, live: read.live });
          objects.push({ object_id: String(entry.object_id), kind: entry.kind as HouseholdWorkspaceView['objects'][number]['kind'], current,
            history: history.revisions.map((entry: Record<string, unknown>) => version(entry)),
            next_history_cursor: history.next_offset === null ? null : String(history.next_offset) });
        }
        const workspace: HouseholdWorkspaceView = { ...context, content_role: access.content_role as HouseholdWorkspaceView['content_role'],
          operations: access.operations as HouseholdWorkspaceView['operations'], objects };
        const actions: HouseholdActions = {
          save: async request => {
            const result = await tool('object_update', { object_id: request.object_id, base: request.base, patch: request.patch, request_id: request.request_id }, request.request_id);
            if (active !== generation) return { status: 'unknown' };
            return result as unknown as Exclude<HouseholdOutcome, { status: 'released' }>;
          },
          readRevision: async revision => {
            const result = await tool('object_read', { object_id: revision.object_id, revision });
            if (active !== generation || result.status !== 'ok' || !result.content) throw new Error('household read refused');
            return result.content as HouseholdVersionView['content'] & {};
          },
          recoverDraft: async (workspaceId, draftId) => {
            const result = await call({ kind: 'household_draft', draft_id: draftId }, crypto.randomUUID());
            if (active !== generation || result.status !== 'ok' || workspaceId !== context.workspace_id) throw new Error('household draft refused');
            return { ...result, base: version(result.base as Record<string, unknown>), current: version(result.current as Record<string, unknown>) } as unknown as HouseholdConflictView;
          },
          readHistory: async (workspaceId, objectId, cursor) => {
            const result = await tool('object_history', { object_id: objectId, offset: Number(cursor), limit: 100 });
            if (active !== generation || workspaceId !== context.workspace_id || result.status !== 'ok') throw new Error('household history refused');
            return { revisions: (result.revisions as Record<string, unknown>[]).map(version), next_cursor: result.next_offset === null ? null : String(result.next_offset) };
          },
        };
        if (active === generation) unmount = mountHouseholdObjects(root, createHouseholdObjectsController(workspace, actions));
      } catch { say('Shared objects could not be loaded. Open this view again to retry.'); }
    },
  };
}
