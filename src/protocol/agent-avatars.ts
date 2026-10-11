/**
 * Pure avatar contracts and validation: command/event payloads and authority
 * snapshots go in; normalized reasons, provenance and image checks come out.
 * Worker results contain only image fields; locks, generations and attribution
 * belong to transaction-read state. This module performs no I/O.
 */
import type { Actor } from './events.js';
import type { WorkspaceState } from './workspace-events.js';

export const AGENT_AVATAR_BUCKET = 'agent-avatars';
export const AGENT_AVATAR_SOURCES = ['uploaded_by_person', 'declared_by_agent', 'client_metadata'] as const;
export type AgentAvatarSource = typeof AGENT_AVATAR_SOURCES[number];
export type AgentAvatarRefusalCode = 'stale' | 'precedence' | 'principal_gone';
export interface AgentAvatarImage {
  object_prefix: string;
  content_type: 'image/webp';
  byte_size: number;
  width: 256;
  height: 256;
  sha256: string;
}
export interface AgentAvatar extends Partial<AgentAvatarImage> {
  principal_id: string;
  generation: number;
  person_locked: boolean;
  source: AgentAvatarSource | null;
  source_ref: string | null;
  set_by_user_id: string | null;
  set_by_principal_id: string | null;
  set_at: number | null;
}
export interface AgentAvatarJob {
  job_id: string;
  principal_id: string;
  generation: number;
  quarantine_key: string;
  source: 'uploaded_by_person' | 'declared_by_agent';
  requested_by_user_id: string;
  requested_by_principal_id: string | null;
  state: 'pending' | 'done' | 'refused';
  refusal_code: AgentAvatarRefusalCode | null;
  created_at: number;
  declared_at: number | null;
  completed_at: number | null;
}
export interface AgentModelProvenance {
  principal_id: string;
  model_set_by: 'person' | 'agent' | 'unknown';
  set_by_user_id: string | null;
  set_at: number;
}
export type AgentAvatarCommand =
  | { kind: 'begin_agent_avatar_upload'; principal_id?: string; upload_id: string }
  | { kind: 'declare_agent_avatar'; upload_id: string }
  | { kind: 'clear_own_agent_avatar' }
  | { kind: 'set_agent_avatar'; principal_id: string; upload_id: string }
  | { kind: 'clear_agent_avatar'; principal_id: string }
  | { kind: 'remove_agent_avatar'; principal_id: string; reason: string }
  | { kind: 'complete_agent_avatar_job'; job_id: string; result: AgentAvatarImage };
export const AGENT_AVATAR_PUBLIC_COMMANDS = [
  'begin_agent_avatar_upload', 'declare_agent_avatar', 'clear_own_agent_avatar',
  'set_agent_avatar', 'clear_agent_avatar', 'remove_agent_avatar',
] as const;
export const AGENT_AVATAR_EVENT_TYPES = [
  'AgentAvatarUploadBegun', 'AgentAvatarSet', 'AgentAvatarCleared',
  'AgentAvatarRemoved', 'AgentAvatarRefused',
] as const;
export type AgentAvatarEventType = typeof AGENT_AVATAR_EVENT_TYPES[number];
export interface AgentAvatarEvent {
  principal_id: string;
  avatar?: AgentAvatar;
  job?: AgentAvatarJob;
  code?: AgentAvatarRefusalCode;
  reason?: string;
  removed_by?: string;
}
export function emptyAgentAvatar(principal_id: string, generation = 0): AgentAvatar {
  return { principal_id, generation, person_locked: false, source: null,
    source_ref: null, set_by_user_id: null, set_by_principal_id: null, set_at: null };
}
export function modelProvenance(principal_id: string, actor: Pick<Actor, 'user' | 'agent_principal'>, set_at: number): AgentModelProvenance {
  // An agent envelope includes its human owner too. The principal takes precedence.
  return { principal_id, model_set_by: actor.agent_principal ? 'agent' : actor.user ? 'person' : 'unknown',
    set_by_user_id: actor.agent_principal ? null : actor.user, set_at };
}
export function pendingPersonAvatar(state: WorkspaceState, principal_id: string): boolean {
  return Object.values(state.avatar_jobs ?? {}).some(job => job.principal_id === principal_id
    && job.source === 'uploaded_by_person' && job.state === 'pending' && job.declared_at !== null);
}
export function normalizedAvatarReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const value = reason.trim();
  return value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ? value : null;
}
export function validAvatarImage(result: unknown, workspace_id: string, principal_id: string): result is AgentAvatarImage {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const fields = ['object_prefix', 'content_type', 'byte_size', 'width', 'height', 'sha256'];
  const keys = Reflect.ownKeys(result);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) return false;
  const p = result as AgentAvatarImage;
  return typeof p.sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.sha256)
    && p.object_prefix === `${workspace_id}/${principal_id}/${p.sha256}`
    && p.content_type === 'image/webp' && p.width === 256 && p.height === 256
    && Number.isSafeInteger(p.byte_size) && p.byte_size > 0 && p.byte_size <= 2 * 1024 * 1024;
}
