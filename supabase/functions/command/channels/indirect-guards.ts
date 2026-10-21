import {
  type CallerContext,
  type ChannelSummary,
  type FileChannelBinding,
  type OrgChannelAuthorityState,
  type OrgChannelRefusal,
  type PrincipalKind,
  canReadChannel,
  canReadWorkspace,
  fail,
  isLive,
} from '../../../../src/protocol/org-channels-contract.js';
import { type ChannelResult, isPrivateChannelsEnabled } from './crud.js';

export interface ChannelFileRecord {
  file_id: string;
  workspace_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  current_version?: number;
  created_by_kind?: PrincipalKind;
  created_by?: string;
  created_at?: string;
  tombstoned_at?: string | null;
}

export interface SearchableSignalRecord {
  signal_id: string;
  workspace_id: string;
  channel_id: string | null;
  thread_root_id?: string | null;
  author_kind: PrincipalKind;
  author_id: string;
  body: string;
  created_at: string;
}

export interface LinkPreviewCandidate {
  target_kind: 'signal' | 'channel' | 'file';
  workspace_id: string;
  channel_id?: string | null;
  signal_id?: string | null;
  file_id?: string | null;
  title: string;
  snippet: string;
  author?: string | null;
  author_name?: string | null;
  channel_slug?: string | null;
  channel_name?: string | null;
}

export interface ScrubbedLinkPreview {
  target_kind: 'signal' | 'channel' | 'file';
  workspace_id: string;
  channel_id: string | null;
  signal_id: string | null;
  file_id: string | null;
  redacted: boolean;
  is_private: boolean;
  title: string | null;
  snippet: string | null;
  author: string | null;
  author_name: string | null;
  channel_slug: string | null;
  channel_name: string | null;
}

function wsScope(
  s: OrgChannelAuthorityState,
  workspaceId: string,
  channelSlug?: string | null,
): OrgChannelRefusal['scope'] {
  const ws = s.workspaces.find((w) => w.workspace_id === workspaceId);
  const org = ws ? s.organizations.find((o) => o.id === ws.org_id) : undefined;
  return {
    org: org?.slug ?? ws?.org_id ?? null,
    workspace: ws?.slug ?? workspaceId,
    channel: channelSlug ?? null,
  };
}

/** Enforces `canReadChannel` across all bound channels for `fileId` in `workspaceId`. */
export function canAccessBoundFile(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  fileId: string,
  workspaceId: string,
): boolean {
  if (!canReadWorkspace(s, caller, workspaceId)) return false;
  const bindings = (s.fileChannelBindings ?? []).filter(
    (b) => b.file_id === fileId && b.workspace_id === workspaceId,
  );
  return bindings.length === 0 || bindings.every((b) => canReadChannel(s, caller, b.channel_id));
}

/** Durable `file_channel_bindings` creation on channel file attach/upload. */
export function bindFileToChannel(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: {
    file_id: string;
    workspace_id: string;
    channel_id: string;
    now?: string;
  },
): ChannelResult<{ binding: FileChannelBinding }> {
  const baseScope = wsScope(s, input.workspace_id, input.channel_id);
  if (!canReadWorkspace(s, caller, input.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', baseScope);
  }
  const ch = s.channels.find(
    (c) => c.workspace_id === input.workspace_id && c.channel_id === input.channel_id,
  );
  if (!ch) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', baseScope);
  if (ch.visibility === 'private' && !isPrivateChannelsEnabled(s)) {
    return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', baseScope);
  }
  if (!canReadChannel(s, caller, ch.channel_id)) {
    return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', baseScope);
  }
  const scope = wsScope(s, input.workspace_id, ch.slug);
  if (!isLive(ch)) return fail('CHANNEL_ARCHIVED', 'active_channel', scope);

  s.fileChannelBindings = s.fileChannelBindings ?? [];
  const existingBindings = s.fileChannelBindings.filter(
    (b) => b.file_id === input.file_id && b.workspace_id === input.workspace_id,
  );
  if (
    existingBindings.length > 0 &&
    !canAccessBoundFile(s, caller, input.file_id, input.workspace_id)
  ) {
    return fail('CHANNEL_ACCESS_DENIED', 'file_channel_membership', {
      org: scope.org,
      workspace: scope.workspace,
      channel: null,
    });
  }
  const hasPrivateBinding = existingBindings.some(
    (b) => s.channels.find((c) => c.channel_id === b.channel_id)?.visibility === 'private',
  );
  if (hasPrivateBinding && ch.visibility === 'workspace') {
    return fail('PRIVATE_FILE_CANNOT_BECOME_PUBLIC', 'private_file_isolation', scope);
  }
  const already = existingBindings.find((b) => b.channel_id === ch.channel_id);
  if (already) return { ok: true, binding: already };

  const binding: FileChannelBinding = {
    file_id: input.file_id,
    workspace_id: input.workspace_id,
    channel_id: ch.channel_id,
    bound_by_kind: caller.principal_kind,
    bound_by: caller.principal_id,
    created_at: input.now ?? new Date().toISOString(),
  };
  s.fileChannelBindings.push(binding);
  return { ok: true, binding };
}

/**
 * Signed-URL minting & download guard requiring `canReadChannel` across all bound channels.
 */
export function authorizeFileDownloadUrl(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: {
    workspace_id: string;
    file_id: string;
    version_n?: number;
    ttl_seconds?: number;
  },
): ChannelResult<{
  file_id: string;
  workspace_id: string;
  download_path: string;
  expires_in_seconds: number;
  bound_channel_ids: string[];
}> {
  const scope = wsScope(s, input.workspace_id, null);
  if (!canReadWorkspace(s, caller, input.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', scope);
  }

  const bindings = (s.fileChannelBindings ?? []).filter(
    (b) => b.file_id === input.file_id && b.workspace_id === input.workspace_id,
  );

  if (bindings.length > 0) {
    const boundPrivate = bindings.some((b) => {
      const ch = s.channels.find((c) => c.channel_id === b.channel_id);
      return ch?.visibility === 'private';
    });
    if (boundPrivate && !isPrivateChannelsEnabled(s)) {
      return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
    }
    if (!canAccessBoundFile(s, caller, input.file_id, input.workspace_id)) {
      return fail('CHANNEL_ACCESS_DENIED', 'file_channel_membership', scope);
    }
  }

  const versionN = input.version_n ?? 1;
  const expiresIn = Math.min(Math.max(input.ttl_seconds ?? 300, 30), 300);
  return {
    ok: true,
    file_id: input.file_id,
    workspace_id: input.workspace_id,
    download_path: `/storage/v1/object/sign/swarm-files/${input.workspace_id}/${input.file_id}/${versionN}`,
    expires_in_seconds: expiresIn,
    bound_channel_ids: bindings.map((b) => b.channel_id),
  };
}

/**
 * Filters workspace file listings by channel bindings (`canAccessBoundFile`).
 */
export function filterWorkspaceFiles(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  workspaceId: string,
  files: readonly ChannelFileRecord[],
): ChannelFileRecord[] {
  if (!canReadWorkspace(s, caller, workspaceId)) return [];
  return files.filter(
    (f) =>
      f.workspace_id === workspaceId &&
      f.tombstoned_at == null &&
      canAccessBoundFile(s, caller, f.file_id, workspaceId),
  );
}

/**
 * Search filter: pre-filters signals and files by `canReadChannel` / `canAccessBoundFile`
 * BEFORE matching, ranking, snippet generation, or count calculation so counts never leak.
 */
export function searchWorkspaceContent(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: {
    workspace_id: string;
    query: string;
    signals: readonly SearchableSignalRecord[];
    files?: readonly ChannelFileRecord[];
  },
): ChannelResult<{
  signal_hits: SearchableSignalRecord[];
  file_hits: ChannelFileRecord[];
  total_count: number;
  by_channel_count: Record<string, number>;
}> {
  const scope = wsScope(s, input.workspace_id, null);
  if (!canReadWorkspace(s, caller, input.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', scope);
  }
  const needle = input.query.trim().toLowerCase();
  if (!needle) {
    return {
      ok: true,
      signal_hits: [],
      file_hits: [],
      total_count: 0,
      by_channel_count: {},
    };
  }

  const readableSignals = input.signals.filter((sig) => {
    if (sig.workspace_id !== input.workspace_id) return false;
    if (sig.channel_id === null) return true;
    return canReadChannel(s, caller, sig.channel_id);
  });

  const readableFiles = filterWorkspaceFiles(
    s,
    caller,
    input.workspace_id,
    input.files ?? [],
  );

  const signalHits = readableSignals.filter((sig) =>
    sig.body.toLowerCase().includes(needle),
  );
  const fileHits = readableFiles.filter((f) =>
    f.name.toLowerCase().includes(needle),
  );

  const byChannelCount: Record<string, number> = {};
  for (const hit of signalHits) {
    const key = hit.channel_id ?? 'unfiled';
    byChannelCount[key] = (byChannelCount[key] ?? 0) + 1;
  }

  return {
    ok: true,
    signal_hits: signalHits,
    file_hits: fileHits,
    total_count: signalHits.length + fileHits.length,
    by_channel_count: byChannelCount,
  };
}

/**
 * Permalink resolver: returns a uniform `CHANNEL_ACCESS_DENIED` refusal for nonexistent,
 * wrong-workspace, or unauthorized private targets so non-members get no existence oracle.
 */
export function resolvePermalink(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: {
    workspace_id: string;
    channel_id?: string | null;
    signal_id?: string | null;
    file_id?: string | null;
    signals?: readonly SearchableSignalRecord[];
    files?: readonly ChannelFileRecord[];
  },
): ChannelResult<{
  target_kind: 'channel' | 'signal' | 'file';
  channel?: ChannelSummary;
  signal?: SearchableSignalRecord;
  file?: ChannelFileRecord;
}> {
  const scope = wsScope(s, input.workspace_id, null);
  if (!canReadWorkspace(s, caller, input.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', scope);
  }

  if (input.signal_id) {
    const sig = (input.signals ?? s.signals ?? []).find(
      (x) => x.signal_id === input.signal_id && x.workspace_id === input.workspace_id,
    );
    const resolvedChannelId = sig?.channel_id ?? null;
    const ch = resolvedChannelId
      ? s.channels.find(
          (c) => c.channel_id === resolvedChannelId && c.workspace_id === input.workspace_id,
        )
      : undefined;
    if (!sig || !resolvedChannelId || !ch) {
      return fail('CHANNEL_ACCESS_DENIED', 'resource_access', scope);
    }
    if (ch.visibility === 'private' && !isPrivateChannelsEnabled(s)) {
      return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
    }
    if (!canReadChannel(s, caller, resolvedChannelId)) {
      return fail('CHANNEL_ACCESS_DENIED', 'resource_access', scope);
    }
    return { ok: true, target_kind: 'signal', channel: ch, signal: sig };
  }

  if (input.file_id) {
    const f = (input.files ?? []).find(
      (x) =>
        x.file_id === input.file_id &&
        x.workspace_id === input.workspace_id &&
        x.tombstoned_at == null,
    );
    if (!f) return fail('CHANNEL_ACCESS_DENIED', 'resource_access', scope);
    const bindings = (s.fileChannelBindings ?? []).filter(
      (b) => b.file_id === f.file_id && b.workspace_id === input.workspace_id,
    );
    const hasPrivate = bindings.some(
      (b) => s.channels.find((c) => c.channel_id === b.channel_id)?.visibility === 'private',
    );
    if (hasPrivate && !isPrivateChannelsEnabled(s)) {
      return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
    }
    if (!canAccessBoundFile(s, caller, f.file_id, input.workspace_id)) {
      return fail('CHANNEL_ACCESS_DENIED', 'resource_access', scope);
    }
    return { ok: true, target_kind: 'file', file: f };
  }

  if (input.channel_id) {
    const ch = s.channels.find(
      (c) => c.channel_id === input.channel_id && c.workspace_id === input.workspace_id,
    );
    if (!ch) return fail('CHANNEL_ACCESS_DENIED', 'resource_access', scope);
    if (ch.visibility === 'private' && !isPrivateChannelsEnabled(s)) {
      return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
    }
    if (!canReadChannel(s, caller, ch.channel_id)) {
      return fail('CHANNEL_ACCESS_DENIED', 'resource_access', scope);
    }
    return { ok: true, target_kind: 'channel', channel: ch };
  }

  return fail('CHANNEL_ACCESS_DENIED', 'resource_access', scope);
}

/**
 * Link-preview scrubber: redacts title, snippet, author, and channel slug whenever a viewer
 * lacks access to the target channel, signal, or bound file, or when channel context is missing.
 */
export function scrubLinkPreviews(
  s: OrgChannelAuthorityState,
  viewer: CallerContext,
  candidates: readonly LinkPreviewCandidate[],
): ScrubbedLinkPreview[] {
  return candidates.map((cand) => {
    let authorized = canReadWorkspace(s, viewer, cand.workspace_id);
    let isPrivate = false;
    let resolvedChannelId: string | null = cand.channel_id ?? null;
    let checkedTarget = false;

    if (cand.target_kind === 'signal' || cand.signal_id != null) {
      checkedTarget = true;
      const sig = cand.signal_id
        ? (s.signals ?? []).find(
            (x) =>
              x.signal_id === cand.signal_id &&
              (x.workspace_id === undefined || x.workspace_id === cand.workspace_id),
          )
        : undefined;
      if (sig && sig.channel_id && (!cand.channel_id || sig.channel_id === cand.channel_id)) {
        resolvedChannelId = sig.channel_id;
      } else {
        resolvedChannelId = null;
        authorized = false;
      }
    }

    if (
      cand.target_kind === 'channel' ||
      cand.target_kind === 'signal' ||
      cand.signal_id != null ||
      resolvedChannelId != null
    ) {
      if (cand.target_kind === 'channel') checkedTarget = true;
      const ch = resolvedChannelId
        ? s.channels.find(
            (c) => c.channel_id === resolvedChannelId && c.workspace_id === cand.workspace_id,
          )
        : undefined;
      if (ch?.visibility === 'private') isPrivate = true;
      authorized =
        authorized &&
        Boolean(resolvedChannelId && ch) &&
        (ch?.visibility !== 'private' || isPrivateChannelsEnabled(s)) &&
        Boolean(resolvedChannelId && canReadChannel(s, viewer, resolvedChannelId));
    }

    if (cand.target_kind === 'file' || cand.file_id != null) {
      checkedTarget = true;
      if (!cand.file_id) {
        authorized = false;
      } else {
        const bindings = (s.fileChannelBindings ?? []).filter(
          (b) => b.file_id === cand.file_id && b.workspace_id === cand.workspace_id,
        );
        const fileHasPrivate = bindings.some(
          (b) => s.channels.find((c) => c.channel_id === b.channel_id)?.visibility === 'private',
        );
        if (fileHasPrivate) isPrivate = true;
        authorized =
          authorized &&
          (!fileHasPrivate || isPrivateChannelsEnabled(s)) &&
          canAccessBoundFile(s, viewer, cand.file_id, cand.workspace_id);
      }
    }

    if (!checkedTarget) {
      authorized = false;
    }

    if (!authorized) {
      return {
        target_kind: cand.target_kind,
        workspace_id: cand.workspace_id,
        channel_id: null,
        signal_id: cand.signal_id ?? null,
        file_id: cand.file_id ?? null,
        redacted: true,
        is_private: true,
        title: null,
        snippet: null,
        author: null,
        author_name: null,
        channel_slug: null,
        channel_name: null,
      };
    }

    return {
      target_kind: cand.target_kind,
      workspace_id: cand.workspace_id,
      channel_id: resolvedChannelId,
      signal_id: cand.signal_id ?? null,
      file_id: cand.file_id ?? null,
      redacted: false,
      is_private: isPrivate,
      title: cand.title,
      snippet: cand.snippet,
      author: cand.author ?? cand.author_name ?? null,
      author_name: cand.author_name ?? cand.author ?? null,
      channel_slug: cand.channel_slug ?? cand.channel_name ?? null,
      channel_name: cand.channel_name ?? cand.channel_slug ?? null,
    };
  });
}

/**
 * Workspace export filter: filters channels, signals, files, and bindings through `canReadChannel`
 * and `canAccessBoundFile` so non-member org/workspace owners & admins never export private data.
 */
export function exportWorkspaceData(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: {
    workspace_id: string;
    signals: readonly SearchableSignalRecord[];
    files: readonly ChannelFileRecord[];
  },
): ChannelResult<{
  channels: ChannelSummary[];
  signals: SearchableSignalRecord[];
  files: ChannelFileRecord[];
  file_channel_bindings: FileChannelBinding[];
}> {
  const scope = wsScope(s, input.workspace_id, null);
  if (!canReadWorkspace(s, caller, input.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', scope);
  }

  const channels = s.channels.filter(
    (ch) =>
      ch.workspace_id === input.workspace_id &&
      canReadChannel(s, caller, ch.channel_id),
  );
  const readableChannelIds = new Set(channels.map((ch) => ch.channel_id));

  const signals = input.signals.filter(
    (sig) =>
      sig.workspace_id === input.workspace_id &&
      (sig.channel_id === null || readableChannelIds.has(sig.channel_id)),
  );

  const files = filterWorkspaceFiles(s, caller, input.workspace_id, input.files);
  const readableFileIds = new Set(files.map((f) => f.file_id));

  const bindings = (s.fileChannelBindings ?? []).filter(
    (b) =>
      b.workspace_id === input.workspace_id &&
      readableChannelIds.has(b.channel_id) &&
      readableFileIds.has(b.file_id),
  );

  return {
    ok: true,
    channels,
    signals,
    files,
    file_channel_bindings: bindings,
  };
}
