import {
  HOUSEHOLD_IDENTITY_WRITE_HOURLY_LIMIT, HOUSEHOLD_WORKSPACE_WRITE_HOURLY_LIMIT,
} from './household-object-policy.js';

export const TODO_QUEUE_LIMIT = 200;
export const TODO_OPEN_LIMIT = 1000;
export const TODO_TITLE_LIMIT = 200;
export const TODO_NOTES_LIMIT = 4000;
export const TODO_COMMENT_LIMIT = 4000;
export const TODO_MENTIONS_LIMIT = 8;
export const TODO_GATE_NOTE_LIMIT = 200;
export const TODO_EVENT_BYTE_LIMIT = 64 * 1024;
export const TODO_IDENTITY_WRITE_HOURLY_LIMIT = HOUSEHOLD_IDENTITY_WRITE_HOURLY_LIMIT;
export const TODO_WORKSPACE_WRITE_HOURLY_LIMIT = HOUSEHOLD_WORKSPACE_WRITE_HOURLY_LIMIT;
export const WORK_RECENT_MS = 30 * 60 * 1000;
export const TODO_DEFAULT_ACCEPTS_FROM = 'owner' as const;

export type AgentWork = 'working' | 'idle' | 'disconnected';
/** Server-normalized credential facts. For local agents, connection is live
 * while either a credential or a renewal approval is live. Message age alone
 * never changes connection. All timestamps come from recorded server actions. */
export interface AgentWorkFacts {
  transport: 'local' | 'hosted_mcp';
  turn_only: boolean;
  connection: 'live' | 'removed' | 'key_off' | 'key_ended' | 'paused';
  last_activity_at: string | null;
  messages_waiting_since: string | null;
  doing: { todo_id: string; title: string | null; since: string } | null;
  working_on: { signal_id: string; at: string; until: string } | null;
}

export function agentWorkState(facts: AgentWorkFacts, now: number): AgentWork {
  if (facts.connection !== 'live') return 'disconnected';
  const activity = facts.last_activity_at === null ? NaN : Date.parse(facts.last_activity_at);
  const recent = Number.isFinite(now) && Number.isFinite(activity)
    && activity <= now && now - activity <= WORK_RECENT_MS;
  const claim = facts.working_on;
  const claimed = claim !== null && Date.parse(claim.at) <= now && Date.parse(claim.until) > now;
  return recent && (facts.doing !== null || claimed) ? 'working' : 'idle';
}

export const TODO_NOTICE_ABOUT_PREFIX = 'todo:';
export const OBJECT_NOTICE_ABOUT_PREFIX = 'object:';
export const TODO_NOTICE_BODIES = {
  added: 'Added a to-do to your queue.',
  start: 'Please start the to-do at the front of your queue.',
  person_offer: 'Asks you to take a to-do.',
  agent_offer: 'Asks for a to-do for your agent.',
  accepted: 'Accepted your to-do request.',
  declined: 'Declined your to-do request.',
  mentioned: 'Mentioned you in a comment.',
} as const;

export function todoNoticeAbout(todoId: string): string {
  return `${TODO_NOTICE_ABOUT_PREFIX}${todoId}`;
}
