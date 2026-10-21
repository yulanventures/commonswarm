import {
  type CallerContext, type NotifyPref, type OrgChannelAuthorityState, type OrgChannelRefusal, type PrincipalKind,
  fail, isLive,
} from '../../../../src/protocol/org-channels-types.ts';
import {
  type ChannelResult, canReadChannel, canReadWorkspace, isPrivateChannelsEnabled, matchPrin, normPrinId, requireReadableChannel, wsScope,
} from './crud.ts';
import { bindFileToChannel, canAccessBoundFile } from './indirect-guards.ts';

export type SignalKind = 'working-on' | 'note' | 'ask';
export interface SignalMention { principal_kind: PrincipalKind; principal_id: string; }
export interface ChannelSignalRecord {
  signal_id: string; workspace_id: string; channel_id: string | null; thread_root_id: string | null;
  in_reply_to?: string | null; author_kind: PrincipalKind; author_id: string; signal_kind: SignalKind;
  body: string; mentions: SignalMention[]; attachment_file_ids: string[]; created_at: string;
}
export interface WakeEvent {
  wake_id: string; signal_id: string; workspace_id: string; channel_id: string | null;
  recipient_kind: PrincipalKind; recipient_id: string;
}
export interface PlannedSignalDelivery extends Omit<WakeEvent, 'wake_id'> {
  delivery_id: string; notify_pref: NotifyPref; mentioned: boolean;
  deliver_inbox: boolean; deliver_wake: boolean; deliver_push: boolean;
}

function checkSeatMatchesWorkspace(s: OrgChannelAuthorityState, workspaceId: string, seatId?: string | null): OrgChannelRefusal | null {
  if (!seatId) return null;
  const seat = (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x));
  if (!seat) return fail('WORKSPACE_ACCESS_DENIED', 'active_seat', { workspace: workspaceId, seat_id: seatId }).refusal;
  if (seat.workspace_id !== workspaceId) {
    const sc = wsScope(s, workspaceId, null, seatId);
    return fail('WORKSPACE_SEAT_MISMATCH', `seat_in_${sc.org ?? workspaceId}/${sc.workspace ?? workspaceId}`, sc).refusal;
  }
  return null;
}

const effPref = (s: OrgChannelAuthorityState, chId: string | null, k: PrincipalKind, id: string): NotifyPref =>
  !chId ? 'all' : (s.channelMemberships.find((m) => m.channel_id === chId && matchPrin(s, m, k, id) && isLive(m))?.notify_pref ?? 'all');

export function postChannelSignal(
  s: OrgChannelAuthorityState, caller: CallerContext,
  input: {
    signal_id?: string; workspace_id: string; channel_id?: string | null; thread_id?: string | null;
    thread_root_id?: string | null; in_reply_to?: string | null; signal_kind?: SignalKind; body: string;
    mentions?: SignalMention[]; attachment_file_ids?: string[]; seat_id?: string | null;
    existing_signals?: readonly ChannelSignalRecord[]; candidate_recipients?: readonly CallerContext[]; now?: string;
  },
): ChannelResult<{ signal: ChannelSignalRecord; deliveries: PlannedSignalDelivery[]; wakes: WakeEvent[] }> {
  const seatErr = checkSeatMatchesWorkspace(s, input.workspace_id, input.seat_id);
  if (seatErr) return { ok: false, refusal: seatErr };
  const sc = wsScope(s, input.workspace_id, null, input.seat_id);
  if (!canReadWorkspace(s, caller, input.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', sc);

  let rootId = input.thread_id ?? input.thread_root_id ?? null, chId: string | null = input.channel_id ?? null;
  const replyId = input.in_reply_to ?? null, kind: SignalKind = input.signal_kind ?? 'note';
  const byId = new Map<string, ChannelSignalRecord>();
  for (const sig of [...(input.existing_signals ?? []), ...((s.signals as readonly ChannelSignalRecord[] | undefined) ?? [])]) byId.set(sig.signal_id, sig);

  if (rootId !== null || replyId !== null) {
    if (kind === 'working-on') return fail('INVALID_THREAD_REPLY_KIND', 'note_or_ask_signal_kind', sc);
    const chk = (sig: ChannelSignalRecord | undefined) => {
      if (!sig || sig.workspace_id !== input.workspace_id) return fail('CHANNEL_ACCESS_DENIED', 'thread_channel_access', sc);
      if (sig.channel_id !== null) {
        const sigCh = s.channels.find((c) => c.workspace_id === input.workspace_id && c.channel_id === sig.channel_id);
        if (!sigCh) return fail('CHANNEL_ACCESS_DENIED', 'thread_channel_access', sc);
        if (sigCh.visibility === 'private' && !isPrivateChannelsEnabled(s)) return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', sc);
        if (!canReadChannel(s, caller, sigCh.channel_id)) return fail('CHANNEL_ACCESS_DENIED', 'thread_channel_access', sc);
      }
      return null;
    };
    const replySig = replyId !== null ? byId.get(replyId) : undefined;
    if (replyId !== null) {
      const err = chk(replySig);
      if (err) return err;
      if (rootId === null && replySig) rootId = replySig.thread_root_id ?? replySig.signal_id;
    }
    const rootSig = rootId !== null ? byId.get(rootId) : undefined;
    if (rootId !== null) { const err = chk(rootSig); if (err) return err; }
    if (rootSig && replySig && (replySig.channel_id !== rootSig.channel_id || !(replySig.signal_id === rootSig.signal_id || replySig.thread_root_id === rootSig.signal_id))) {
      return fail('THREAD_CHANNEL_MISMATCH', 'matching_thread_channel', sc);
    }
    const refSig = (rootSig ?? replySig)!;
    if (input.channel_id != null && input.channel_id !== refSig.channel_id) return fail('THREAD_CHANNEL_MISMATCH', 'matching_thread_channel', sc);
    chId = refSig.channel_id;
  }

  let targetCh: (typeof s.channels)[number] | undefined;
  if (chId !== null) {
    targetCh = s.channels.find((c) => c.workspace_id === input.workspace_id && c.channel_id === chId);
    if (!targetCh) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', sc);
    if (targetCh.visibility === 'private' && !isPrivateChannelsEnabled(s)) return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', sc);
    if (!canReadChannel(s, caller, targetCh.channel_id)) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', sc);
    if (!isLive(targetCh)) return fail('CHANNEL_ARCHIVED', 'active_channel', wsScope(s, input.workspace_id, targetCh.slug, input.seat_id));
  }

  const now = input.now ?? new Date().toISOString(), files = input.attachment_file_ids ?? [], prev = [...(s.fileChannelBindings ?? [])];
  for (const fileId of files) {
    if (!canAccessBoundFile(s, caller, fileId, input.workspace_id)) { s.fileChannelBindings = prev; return fail('CHANNEL_ACCESS_DENIED', 'file_channel_membership', sc); }
    if (chId !== null) {
      const bound = bindFileToChannel(s, caller, { file_id: fileId, workspace_id: input.workspace_id, channel_id: chId, now });
      if (!bound.ok) { s.fileChannelBindings = prev; return bound; }
    }
  }

  const signal: ChannelSignalRecord = {
    signal_id: input.signal_id ?? `sig-${input.workspace_id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    workspace_id: input.workspace_id, channel_id: chId, thread_root_id: rootId,
    in_reply_to: input.in_reply_to ?? null, author_kind: caller.principal_kind, author_id: normPrinId(s, caller.principal_kind, caller.principal_id),
    signal_kind: kind, body: input.body, mentions: input.mentions ?? [], attachment_file_ids: [...files], created_at: now,
  };
  const prevSignals = s.signals ?? input.existing_signals ?? [];
  if (!prevSignals.some((x) => x.signal_id === signal.signal_id)) s.signals = [...prevSignals, signal];
  if (targetCh) targetCh.has_history = true;
  return { ok: true, signal, ...planSignalDeliveries(s, signal, input.candidate_recipients ?? []) };
}

function mergeTrustedSignals(s: OrgChannelAuthorityState, supplied: readonly ChannelSignalRecord[]): ChannelSignalRecord[] {
  const trusted = new Map<string, ChannelSignalRecord>();
  for (const sig of (s.signals as readonly ChannelSignalRecord[] | undefined) ?? []) trusted.set(sig.signal_id, sig);
  return supplied.map((sig) => trusted.get(sig.signal_id) ?? sig);
}

function canReadSignalChannel(s: OrgChannelAuthorityState, caller: CallerContext, workspaceId: string, channelId: string | null): boolean {
  if (channelId === null) return true;
  const ch = s.channels.find((c) => c.workspace_id === workspaceId && c.channel_id === channelId);
  if (!ch || (ch.visibility === 'private' && !isPrivateChannelsEnabled(s))) return false;
  return canReadChannel(s, caller, channelId);
}

export function readChannelSignals(
  s: OrgChannelAuthorityState, caller: CallerContext,
  input: { workspace_id: string; channel_id?: string | null; signals: readonly ChannelSignalRecord[] },
): ChannelResult<{ signals: ChannelSignalRecord[] }> {
  const allSignals = mergeTrustedSignals(s, input.signals);
  if (input.channel_id) {
    const check = requireReadableChannel(s, caller, input.workspace_id, input.channel_id);
    if (!check.ok) return check;
    return { ok: true, signals: allSignals.filter((sig) => sig.workspace_id === input.workspace_id && sig.channel_id === input.channel_id) };
  }
  const baseScope = wsScope(s, input.workspace_id, null);
  if (!canReadWorkspace(s, caller, input.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', baseScope);
  return { ok: true, signals: allSignals.filter((sig) => sig.workspace_id === input.workspace_id && canReadSignalChannel(s, caller, input.workspace_id, sig.channel_id)) };
}

export function readThreadSignals(
  s: OrgChannelAuthorityState, caller: CallerContext,
  input: { workspace_id: string; thread_id: string; signals: readonly ChannelSignalRecord[] },
): ChannelResult<{ root: ChannelSignalRecord; replies: ChannelSignalRecord[] }> {
  const baseScope = wsScope(s, input.workspace_id, null);
  if (!canReadWorkspace(s, caller, input.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', baseScope);
  const allSignals = mergeTrustedSignals(s, input.signals);
  const root = allSignals.find((sig) => sig.signal_id === input.thread_id && sig.workspace_id === input.workspace_id);
  if (!root) return fail('CHANNEL_ACCESS_DENIED', 'thread_channel_access', baseScope);
  if (root.channel_id !== null) {
    const ch = s.channels.find((c) => c.workspace_id === input.workspace_id && c.channel_id === root.channel_id);
    if (!ch) return fail('CHANNEL_ACCESS_DENIED', 'thread_channel_access', baseScope);
    if (ch.visibility === 'private' && !isPrivateChannelsEnabled(s)) return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', baseScope);
    if (!canReadChannel(s, caller, root.channel_id)) return fail('CHANNEL_ACCESS_DENIED', 'thread_channel_access', baseScope);
  }
  const replies = allSignals.filter((sig) => sig.workspace_id === input.workspace_id && sig.thread_root_id === root.signal_id && sig.channel_id === root.channel_id && canReadSignalChannel(s, caller, input.workspace_id, sig.channel_id));
  return { ok: true, root, replies };
}

export function planSignalDeliveries(
  s: OrgChannelAuthorityState, signal: ChannelSignalRecord, candidates: readonly CallerContext[],
): { deliveries: PlannedSignalDelivery[]; wakes: WakeEvent[] } {
  const deliveries: PlannedSignalDelivery[] = [], wakes: WakeEvent[] = [], seen = new Set<string>();
  for (const cand of candidates) {
    const cid = normPrinId(s, cand.principal_kind, cand.principal_id), key = `${cand.principal_kind}:${cid}`;
    if (seen.has(key) || (cand.principal_kind === signal.author_kind && cid === normPrinId(s, signal.author_kind, signal.author_id))) continue;
    seen.add(key);
    const canReceive = signal.channel_id === null ? canReadWorkspace(s, cand, signal.workspace_id) : canReadChannel(s, cand, signal.channel_id);
    if (!canReceive) continue;
    const notifyPref = effPref(s, signal.channel_id, cand.principal_kind, cid);
    const mentioned = signal.mentions.some((m) => matchPrin(s, m, cand.principal_kind, cid));
    const deliverInbox = notifyPref !== 'mute', deliverWake = notifyPref === 'all' || (notifyPref === 'mentions' && mentioned);
    const baseItem = { signal_id: signal.signal_id, workspace_id: signal.workspace_id, channel_id: signal.channel_id, recipient_kind: cand.principal_kind, recipient_id: cid };
    if (deliverInbox) deliveries.push({ ...baseItem, delivery_id: `del-${signal.signal_id}-${cand.principal_kind}-${cid}`, notify_pref: notifyPref, mentioned, deliver_inbox: true, deliver_wake: deliverWake, deliver_push: deliverWake });
    if (deliverWake) wakes.push({ ...baseItem, wake_id: `wake-${signal.signal_id}-${cand.principal_kind}-${cid}` });
  }
  return { deliveries, wakes };
}

export function filterInboxItems(s: OrgChannelAuthorityState, caller: CallerContext, items: readonly PlannedSignalDelivery[], workspaceId?: string): PlannedSignalDelivery[] {
  return items.filter((item) => item.recipient_kind === caller.principal_kind && normPrinId(s, item.recipient_kind, item.recipient_id) === normPrinId(s, caller.principal_kind, caller.principal_id) && (!workspaceId || item.workspace_id === workspaceId) && (item.channel_id === null ? canReadWorkspace(s, caller, item.workspace_id) : canReadChannel(s, caller, item.channel_id)));
}

export function filterWakeEvents(s: OrgChannelAuthorityState, caller: CallerContext, wakes: readonly WakeEvent[]): WakeEvent[] {
  return wakes.filter((w) => w.recipient_kind === caller.principal_kind && normPrinId(s, w.recipient_kind, w.recipient_id) === normPrinId(s, caller.principal_kind, caller.principal_id) && (w.channel_id === null ? canReadWorkspace(s, caller, w.workspace_id) : canReadChannel(s, caller, w.channel_id)));
}

export function canAckInboxItem(s: OrgChannelAuthorityState, caller: CallerContext, item: PlannedSignalDelivery, seatId?: string | null): ChannelResult<{ acked_delivery_id: string }> {
  const seatErr = checkSeatMatchesWorkspace(s, item.workspace_id, seatId);
  if (seatErr) return { ok: false, refusal: seatErr };
  const scope = wsScope(s, item.workspace_id, null, seatId);
  if (item.recipient_kind !== caller.principal_kind || normPrinId(s, item.recipient_kind, item.recipient_id) !== normPrinId(s, caller.principal_kind, caller.principal_id)) return fail('CHANNEL_ACCESS_DENIED', 'delivery_recipient_match', scope);
  if (!(item.channel_id === null ? canReadWorkspace(s, caller, item.workspace_id) : canReadChannel(s, caller, item.channel_id))) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', scope);
  return { ok: true, acked_delivery_id: item.delivery_id };
}

export interface ChannelUnreadBucket { channel_id: string; slug: string; unread_count: number; mention_count: number; muted: boolean; }
export function computeUnreadCounts(
  s: OrgChannelAuthorityState, caller: CallerContext,
  input: { workspace_id: string; signals: readonly ChannelSignalRecord[]; seen_signal_ids?: Iterable<string> },
): ChannelResult<{ total_unread: number; total_mentions: number; unfiled_unread: number; by_channel: Record<string, ChannelUnreadBucket> }> {
  const scope = wsScope(s, input.workspace_id, null);
  if (!canReadWorkspace(s, caller, input.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', scope);
  const seen = new Set(input.seen_signal_ids ?? []), byChannel: Record<string, ChannelUnreadBucket> = {}, cid = normPrinId(s, caller.principal_kind, caller.principal_id);
  for (const ch of s.channels) {
    if (ch.workspace_id === input.workspace_id && isLive(ch) && canReadChannel(s, caller, ch.channel_id)) {
      const pref = effPref(s, ch.channel_id, caller.principal_kind, cid);
      byChannel[ch.channel_id] = { channel_id: ch.channel_id, slug: ch.slug, unread_count: 0, mention_count: 0, muted: pref === 'mute' };
    }
  }
  let unfiledUnread = 0, totalUnread = 0, totalMentions = 0;
  for (const sig of mergeTrustedSignals(s, input.signals)) {
    if (sig.workspace_id !== input.workspace_id || seen.has(sig.signal_id)) continue;
    if (sig.author_kind === caller.principal_kind && normPrinId(s, sig.author_kind, sig.author_id) === cid) continue;
    const mentioned = sig.mentions.some((m) => matchPrin(s, m, caller.principal_kind, cid));
    if (sig.channel_id === null) { unfiledUnread += 1; totalUnread += 1; if (mentioned) totalMentions += 1; continue; }
    const bucket = byChannel[sig.channel_id];
    if (!bucket || bucket.muted) continue;
    bucket.unread_count += 1; totalUnread += 1;
    if (mentioned) { bucket.mention_count += 1; totalMentions += 1; }
  }
  return { ok: true, total_unread: totalUnread, total_mentions: totalMentions, unfiled_unread: unfiledUnread, by_channel: byChannel };
}

export function buildCatchUpSummary(
  s: OrgChannelAuthorityState, caller: CallerContext,
  input: { workspace_id: string; signals: readonly ChannelSignalRecord[]; seen_signal_ids?: Iterable<string> },
): ChannelResult<{ total_unread: number; needs_you_count: number; needs_you_signals: ChannelSignalRecord[]; active_channel_slugs: string[] }> {
  const unreadRes = computeUnreadCounts(s, caller, input);
  if (!unreadRes.ok) return unreadRes;
  const seen = new Set(input.seen_signal_ids ?? []), readableIds = new Set(Object.keys(unreadRes.by_channel)), cid = normPrinId(s, caller.principal_kind, caller.principal_id);
  const needsYouSignals = mergeTrustedSignals(s, input.signals).filter((sig) => {
    if (sig.workspace_id !== input.workspace_id || seen.has(sig.signal_id)) return false;
    if (sig.channel_id !== null && !readableIds.has(sig.channel_id)) return false;
    const pref = effPref(s, sig.channel_id, caller.principal_kind, cid);
    return pref !== 'mute' && (sig.mentions.some((m) => matchPrin(s, m, caller.principal_kind, cid)) || (sig.signal_kind === 'ask' && pref === 'all'));
  });
  return { ok: true, total_unread: unreadRes.total_unread, needs_you_count: needsYouSignals.length, needs_you_signals: needsYouSignals, active_channel_slugs: Object.values(unreadRes.by_channel).filter((b) => b.unread_count > 0).map((b) => b.slug) };
}
