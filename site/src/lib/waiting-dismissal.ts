/**
 * Waiting on you dismissal controller (C3):
 * - Keeps NO copy of the dismissed question or to-do (only kind, id, routing keys, and slot position).
 * - Undo keeps the row showing "Undoing…", sends the restore command, and RELOADS from the server.
 * - Failed Dismiss RELOADS from the server (with error treatment on non-404, silent reload on 404);
 *   never re-inserts a saved card.
 * - Archived Restore sends restore, then RELOADS from the server.
 * - Authoritative loss of conversation, channel, or workspace access synchronously retires matching
 *   Dismissed rows, survey pointers, and pending actions, and fences late async settlements via
 *   per-row retirement and a monotonic access generation counter.
 */
import { parseWaitingDismissalInstanceId, type WaitingDismissalItemKind, type WaitingDismissalResult } from "./commonswarm";
import type { WaitingArchivedItem, WaitingDismissBatchVM, WaitingDismissedPlaceholder, WaitingScope } from "./waiting-panel";

export type WaitingDismissSlotKind = "ask" | "plain" | "todo";
export type WaitingDismissPlacementKind = "channel" | "general" | "dm" | "group_dm" | "workspace" | "unknown";

/** Minimal metadata captured for one item in a "Dismiss all" batch. Holds NO item text. */
export interface WaitingDismissBatchTarget {
  readonly slotKind: WaitingDismissSlotKind;
  readonly itemKind: WaitingDismissalItemKind;
  /** Signal id, todo id, or pinned review offer id. Never blank for batch items. */
  readonly itemId: string;
  /** Card id rendered in the Waiting list (signal id for asks, todo id for todos/reviews). */
  readonly cardId: string;
  readonly workspaceId: string;
  readonly channelId: string | null;
  readonly conversationId: string | null;
  readonly placementKind: WaitingDismissPlacementKind;
}

export interface WaitingDismissBatchBeginInput {
  scope: WaitingScope;
  placeKey: string;
  workspaceIds: readonly string[];
  /** Sync targets when the scope is already complete and unpaged. */
  targets?: readonly WaitingDismissBatchTarget[];
  /** Async loader used when remaining pages or workspaces must be fetched before showing confirm. */
  loadTargets?: (isAlive: () => boolean) => Promise<readonly WaitingDismissBatchTarget[] | null>;
}

export interface WaitingDismissTarget {
  slotKind: WaitingDismissSlotKind;
  itemKind: WaitingDismissalItemKind;
  /** Signal id, todo id, or offer id; "" only while resolving an offer id for review items. */
  itemId: string;
  /** Card id rendered in the Waiting list (signal id for asks, todo id for todos/reviews). */
  cardId: string;
  workspaceId: string;
  channelId: string | null;
  conversationId: string | null;
  placementKind: WaitingDismissPlacementKind;
  position: number;
  placeKey: string;
  scope: WaitingScope;
  fromSurvey?: boolean;
}

/** Minimal metadata kept for an in-place "Dismissed · Undo" row. Holds NO content from the item. */
export interface WaitingDismissRow {
  readonly attemptId: number;
  readonly batchAttemptId: number | null;
  readonly key: string;
  readonly slotKind: WaitingDismissSlotKind;
  readonly itemKind: WaitingDismissalItemKind;
  itemId: string;
  readonly cardId: string;
  readonly workspaceId: string;
  readonly channelId: string | null;
  readonly conversationId: string | null;
  readonly placementKind: WaitingDismissPlacementKind;
  readonly position: number;
  readonly placeKey: string;
  readonly scope: WaitingScope;
  readonly accessGen: number;
  pendingUndo: boolean;
  undoAttemptId: number | null;
  dismissResolved: boolean;
  retired: boolean;
  inFlightDismiss?: Promise<boolean>;
}

interface BatchNotFoundCandidate {
  readonly workspaceId: string;
  readonly slotKind: WaitingDismissSlotKind;
  readonly cardId: string;
}

/** Minimal metadata recorded for one dismissal created by a batch. Holds NO item text. */
interface BatchUndoRecord {
  readonly workspaceId: string;
  readonly itemKind: WaitingDismissalItemKind;
  readonly itemId: string;
  readonly dismissal: string;
}

interface WaitingDismissBatchInternal {
  readonly attemptId: number;
  readonly batchGen: number;
  readonly scope: WaitingScope;
  readonly placeKey: string;
  readonly workspaceIds: ReadonlySet<string>;
  readonly accountAlive: () => boolean;
  readonly capturedGlobalGen: number;
  readonly capturedWsGens: ReadonlyMap<string, number>;
  readonly capturedPanelLifetime: number | null;
  phase: "loading" | "confirm" | "running" | "done" | "undoing" | "restored";
  targets: readonly WaitingDismissBatchTarget[];
  undoEntries: BatchUndoRecord[];
  total: number;
  processed: number;
  doneCount: number;
  restoredCount: number;
  stopping: boolean;
  retired: boolean;
}

interface ArchivedRestoreEntry {
  readonly attemptId: number;
  readonly itemKey: string;
  readonly workspaceId: string;
  readonly channelId: string | null;
  readonly conversationId: string | null;
  readonly placement: WaitingArchivedItem["placement"];
  retired: boolean;
}

export type WaitingAccessLossEvent =
  | { kind: "conversation"; workspaceId: string; conversationId: string; channelId: string | null }
  | { kind: "channel"; workspaceId: string; channelId: string }
  | { kind: "workspace"; workspaceId: string; fromWaitingRefresh?: boolean }
  | { kind: "all" };

export interface WaitingDismissalPorts {
  sendDismiss: (
    workspaceId: string,
    itemKind: WaitingDismissalItemKind,
    itemId: string,
    isAlive?: () => boolean,
  ) => Promise<WaitingDismissalResult>;
  sendRestore: (
    workspaceId: string,
    itemKind: WaitingDismissalItemKind,
    itemId: string,
    isAlive?: () => boolean,
    dismissal?: string,
  ) => Promise<WaitingDismissalResult>;
  resolveReviewOfferId?: (workspaceId: string, todoId: string, isAlive?: () => boolean) => Promise<string | null>;
  /** Optional snapshot of the caller's account/auth lifetime captured at the moment the person acts. */
  captureAccountGuard?: () => () => boolean;
  /** Optional monotonic panel lifetime counter that changes on every panel close and open. */
  getPanelLifetime?: () => number;
  /** Optional check that the panel is still showing the scope/place/workspace the batch started in. */
  isBatchScopeCurrent?: (batchScope: {
    scope: WaitingScope;
    placeKey: string;
    workspaceIds: ReadonlySet<string>;
  }) => boolean;
  isAlive: () => boolean;
  removeCardFromClient: (target: WaitingDismissTarget) => void;
  onRetireAccessLoss?: (event: WaitingAccessLossEvent) => void;
  reloadWaiting: (workspaceId: string) => Promise<void> | void;
  reloadWaitingBatch?: (workspaceIds: readonly string[]) => Promise<void> | void;
  isItemListed?: (workspaceId: string, slotKind: WaitingDismissSlotKind, cardId: string) => boolean;
  invalidateArchived: (workspaceId: string) => void;
  setCardError: (slotKind: WaitingDismissSlotKind, cardId: string, message: string) => void;
  setStatusError: (message: string) => void;
  setArchivedError: (itemKey: string, message: string) => void;
  clearArchivedError: (itemKey: string) => void;
  render: () => void;
  onDismissedRendered?: (key: string) => void;
  onRestoredReloaded?: (slotKind: WaitingDismissSlotKind, cardId: string) => void;
  onBatchConfirmOpened?: () => void;
  onBatchCancelled?: () => void;
  onBatchStarted?: () => void;
  onBatchFinished?: () => void;
  onBatchUndoFinished?: () => void;
}

export interface WaitingDismissalController {
  accessGeneration(): number;
  workspaceAccessGeneration(workspaceId: string): number;
  has(key: string): boolean;
  pendingDismissCardIds(workspaceId: string): Set<string>;
  placeholdersFor(placeKey: string, scope: WaitingScope): WaitingDismissedPlaceholder[];
  surveyNotice(): { key: string; pendingUndo?: true } | null;
  isArchivedRestoring(itemKey: string): boolean;
  batchState(): WaitingDismissBatchVM | null;
  batchScope(): { scope: WaitingScope; placeKey: string; workspaceIds: ReadonlySet<string> } | null;
  beginBatchConfirm(input: WaitingDismissBatchBeginInput): Promise<void>;
  cancelBatchConfirm(): void;
  confirmBatch(): Promise<void>;
  undoBatch(): Promise<void>;
  stopBatch(): void;
  retireBatch(renderIfChanged?: boolean): boolean;
  dismiss(target: WaitingDismissTarget): Promise<void>;
  undo(key: string): Promise<void>;
  restoreArchived(item: WaitingArchivedItem): Promise<void>;
  retireForConversation(workspaceId: string, conversationId: string, channelId?: string | null): boolean;
  retireForChannel(workspaceId: string, channelId: string): boolean;
  retireForWorkspace(workspaceId: string, options?: { fromWaitingRefresh?: boolean }): boolean;
  retireAll(notify?: boolean): void;
}

const BATCH_CONCURRENCY = 3;

function normalizeBatchTargets(targets: readonly WaitingDismissBatchTarget[] | null | undefined): WaitingDismissBatchTarget[] {
  const out: WaitingDismissBatchTarget[] = [];
  for (const target of targets ?? []) {
    const itemId = typeof target.itemId === "string" ? target.itemId.trim() : "";
    if (!itemId) continue;
    out.push({
      slotKind: target.slotKind,
      itemKind: target.itemKind,
      itemId,
      cardId: target.cardId,
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      conversationId: target.conversationId,
      placementKind: target.placementKind,
    });
  }
  return out;
}

function normId(id: string): string {
  return id.trim().toLowerCase();
}

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && normId(a) === normId(b));
}

function isNotFoundResult(result: WaitingDismissalResult): boolean {
  return !result.ok && (result.status === 404 || result.error === "not_found");
}

function isRetiredResult(result: WaitingDismissalResult): boolean {
  return !result.ok && result.status === 0 && result.error === "operation_retired";
}

export function createWaitingDismissalController(ports: WaitingDismissalPorts): WaitingDismissalController {
  let accessGen = 0;
  let globalGen = 0;
  let batchGen = 0;
  let nextAttemptId = 0;
  const newAttemptId = (): number => (nextAttemptId += 1);
  const workspaceGens = new Map<string, number>();
  const workspaceAnyLossGens = new Map<string, number>();
  const channelGens = new Map<string, number>();
  const conversationGens = new Map<string, number>();
  const rows = new Map<string, WaitingDismissRow>();
  const archivedRestoring = new Map<string, ArchivedRestoreEntry>();
  let surveyDismissedKey: string | null = null;
  let activeBatch: WaitingDismissBatchInternal | null = null;

  const isRowOwner = (key: string, row: WaitingDismissRow): boolean => {
    const current = rows.get(key);
    return current === row && current.attemptId === row.attemptId;
  };

  const deleteOwnedRow = (key: string, row: WaitingDismissRow): boolean => {
    if (!isRowOwner(key, row)) return false;
    rows.delete(key);
    if (surveyDismissedKey === key) surveyDismissedKey = null;
    return true;
  };

  const isArchivedOwner = (itemKey: string, entry: ArchivedRestoreEntry): boolean => {
    const current = archivedRestoring.get(itemKey);
    return current === entry && current.attemptId === entry.attemptId;
  };

  const deleteOwnedArchived = (itemKey: string, entry: ArchivedRestoreEntry): boolean => {
    if (!isArchivedOwner(itemKey, entry)) return false;
    archivedRestoring.delete(itemKey);
    return true;
  };

  const ownsBatch = (batch: WaitingDismissBatchInternal): boolean =>
    activeBatch === batch && activeBatch.attemptId === batch.attemptId && activeBatch.batchGen === batch.batchGen;

  const isBatchContextAlive = (batch: WaitingDismissBatchInternal): boolean => {
    if (!ports.isAlive() || !batch.accountAlive()) return false;
    if (globalGen !== batch.capturedGlobalGen) return false;
    if (
      batch.capturedPanelLifetime !== null &&
      ports.getPanelLifetime &&
      ports.getPanelLifetime() !== batch.capturedPanelLifetime
    ) {
      return false;
    }
    if (
      ports.isBatchScopeCurrent &&
      !ports.isBatchScopeCurrent({
        scope: batch.scope,
        placeKey: batch.placeKey,
        workspaceIds: batch.workspaceIds,
      })
    ) {
      return false;
    }
    for (const [normWs, capturedGen] of batch.capturedWsGens) {
      if ((workspaceAnyLossGens.get(normWs) ?? 0) !== capturedGen) return false;
    }
    return true;
  };

  const isBatchAlive = (batch: WaitingDismissBatchInternal): boolean =>
    !batch.retired && ownsBatch(batch) && isBatchContextAlive(batch);

  const clearBatchRows = (batchAttemptId: number): void => {
    for (const [key, row] of rows.entries()) {
      if (row.batchAttemptId === batchAttemptId) {
        row.retired = true;
        deleteOwnedRow(key, row);
      }
    }
  };

  const retireBatchInternal = (renderIfChanged: boolean): boolean => {
    const current = activeBatch;
    batchGen += 1;
    let changed = false;
    if (current) {
      current.retired = true;
      current.undoEntries = [];
      activeBatch = null;
      changed = true;
    }
    for (const [key, row] of rows.entries()) {
      if (row.batchAttemptId !== null) {
        row.retired = true;
        deleteOwnedRow(key, row);
        changed = true;
      }
    }
    if (changed && renderIfChanged && ports.isAlive()) ports.render();
    return changed;
  };

  const reloadBatchWorkspaces = async (workspaceIds: Iterable<string>): Promise<void> => {
    const unique = [...new Set(workspaceIds)];
    if (unique.length === 0) return;
    if (ports.reloadWaitingBatch) {
      await ports.reloadWaitingBatch(unique);
      return;
    }
    for (const wsId of unique) {
      await ports.reloadWaiting(wsId);
    }
  };

  const createActionAlive = (
    workspaceId: string,
    channelId: string | null,
    conversationId: string | null,
    wildcardPlacement: boolean,
    entryAlive: () => boolean,
  ): (() => boolean) => {
    const accountAlive = ports.captureAccountGuard ? ports.captureAccountGuard() : ports.isAlive;
    const normWs = normId(workspaceId);
    const chKey = channelId ? `${normWs}:${normId(channelId)}` : null;
    const convKey = conversationId ? `${normWs}:${normId(conversationId)}` : null;
    const capturedGlobalGen = globalGen;
    const capturedWsGen = workspaceGens.get(normWs) ?? 0;
    const capturedChGen = chKey !== null ? (channelGens.get(chKey) ?? 0) : null;
    const capturedConvGen = convKey !== null ? (conversationGens.get(convKey) ?? 0) : null;
    const capturedAnyLossGen = wildcardPlacement ? (workspaceAnyLossGens.get(normWs) ?? 0) : null;
    return (): boolean =>
      ports.isAlive() &&
      accountAlive() &&
      entryAlive() &&
      globalGen === capturedGlobalGen &&
      (workspaceGens.get(normWs) ?? 0) === capturedWsGen &&
      (capturedChGen === null || (channelGens.get(chKey!) ?? 0) === capturedChGen) &&
      (capturedConvGen === null || (conversationGens.get(convKey!) ?? 0) === capturedConvGen) &&
      (capturedAnyLossGen === null || (workspaceAnyLossGens.get(normWs) ?? 0) === capturedAnyLossGen);
  };

  const retireMatching = (
    predicate: (row: WaitingDismissRow) => boolean,
    archivedPredicate: (entry: ArchivedRestoreEntry) => boolean,
    event: WaitingAccessLossEvent,
  ): boolean => {
    accessGen += 1;
    let affectedNormWs: string | null = null;
    if (event.kind === "workspace") {
      const normWs = normId(event.workspaceId);
      affectedNormWs = normWs;
      workspaceGens.set(normWs, accessGen);
      workspaceAnyLossGens.set(normWs, accessGen);
    } else if (event.kind === "channel") {
      const normWs = normId(event.workspaceId);
      affectedNormWs = normWs;
      workspaceAnyLossGens.set(normWs, accessGen);
      channelGens.set(`${normWs}:${normId(event.channelId)}`, accessGen);
    } else if (event.kind === "conversation") {
      const normWs = normId(event.workspaceId);
      affectedNormWs = normWs;
      const normConv = normId(event.conversationId);
      workspaceAnyLossGens.set(normWs, accessGen);
      conversationGens.set(`${normWs}:${normConv}`, accessGen);
      channelGens.set(`${normWs}:${normConv}`, accessGen);
      if (event.channelId !== null) {
        channelGens.set(`${normWs}:${normId(event.channelId)}`, accessGen);
      }
    }
    let changed = false;
    if (activeBatch && affectedNormWs !== null && activeBatch.workspaceIds.has(affectedNormWs)) {
      if (retireBatchInternal(false)) changed = true;
    }
    for (const [key, row] of rows.entries()) {
      if (predicate(row)) {
        row.retired = true;
        deleteOwnedRow(key, row);
        changed = true;
      }
    }
    for (const [itemKey, entry] of archivedRestoring.entries()) {
      if (archivedPredicate(entry)) {
        entry.retired = true;
        deleteOwnedArchived(itemKey, entry);
        changed = true;
      }
    }
    ports.onRetireAccessLoss?.(event);
    if (changed) ports.render();
    return changed;
  };

  type BatchItemOutcome =
    | { kind: "dismissed"; undoEntry?: BatchUndoRecord }
    | { kind: "not_found"; candidate: BatchNotFoundCandidate }
    | { kind: "failed" }
    | { kind: "retired" };

  type BatchUndoItemOutcome = "restored" | "not_restored" | "retired";

  const runBatchDismissItem = async (
    batch: WaitingDismissBatchInternal,
    target: WaitingDismissBatchTarget,
    touchedWorkspaces: Set<string>,
  ): Promise<BatchItemOutcome> => {
    if (!isBatchAlive(batch)) return { kind: "retired" };
    const pinnedItemId = target.itemId.trim();
    if (!pinnedItemId) {
      batch.processed += 1;
      ports.render();
      return { kind: "failed" };
    }
    const key = `${target.slotKind}:${target.cardId}`;
    const existingRow = rows.get(key);
    if (existingRow && !existingRow.retired && existingRow.batchAttemptId === null && !existingRow.dismissResolved) {
      return { kind: "failed" };
    }
    const attemptId = newAttemptId();
    const row: WaitingDismissRow = {
      attemptId,
      batchAttemptId: batch.attemptId,
      key,
      slotKind: target.slotKind,
      itemKind: target.itemKind,
      itemId: pinnedItemId,
      cardId: target.cardId,
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      conversationId: target.conversationId,
      placementKind: target.placementKind,
      position: 0,
      placeKey: batch.placeKey,
      scope: batch.scope,
      accessGen,
      pendingUndo: false,
      undoAttemptId: null,
      dismissResolved: false,
      retired: false,
    };
    rows.set(key, row);
    touchedWorkspaces.add(target.workspaceId);

    const ownsRow = (): boolean => isRowOwner(key, row);
    const alive = createActionAlive(
      target.workspaceId,
      target.channelId,
      target.conversationId,
      target.placementKind === "unknown",
      () => !row.retired && ownsRow() && isBatchAlive(batch),
    );
    const retireRow = (): BatchItemOutcome => {
      if (ownsRow()) {
        row.retired = true;
        deleteOwnedRow(key, row);
      }
      return { kind: "retired" };
    };

    if (!ownsRow() || !alive()) return retireRow();
    let result: WaitingDismissalResult;
    try {
      result = await ports.sendDismiss(target.workspaceId, target.itemKind, pinnedItemId, alive);
    } catch {
      result = { ok: false, status: 0, error: null, message: "Could not dismiss. Try again." };
    }
    if (!ownsRow() || !alive() || isRetiredResult(result)) {
      return retireRow();
    }

    if (result.ok) {
      row.dismissResolved = true;
      ports.removeCardFromClient({ ...target, itemId: pinnedItemId, position: 0, placeKey: batch.placeKey, scope: batch.scope });
      batch.processed += 1;
      ports.render();
      const dismissal = result.created === true ? parseWaitingDismissalInstanceId(result.dismissal) : null;
      return dismissal !== null
        ? {
            kind: "dismissed",
            undoEntry: {
              workspaceId: target.workspaceId,
              itemKind: target.itemKind,
              itemId: pinnedItemId,
              dismissal,
            },
          }
        : { kind: "dismissed" };
    }

    deleteOwnedRow(key, row);
    if (isNotFoundResult(result)) {
      ports.removeCardFromClient({ ...target, itemId: pinnedItemId, position: 0, placeKey: batch.placeKey, scope: batch.scope });
      batch.processed += 1;
      ports.render();
      return {
        kind: "not_found",
        candidate: { workspaceId: target.workspaceId, slotKind: target.slotKind, cardId: target.cardId },
      };
    }

    batch.processed += 1;
    ports.render();
    return { kind: "failed" };
  };

  const runBatchUndoItem = async (
    batch: WaitingDismissBatchInternal,
    entry: BatchUndoRecord,
    touchedWorkspaces: Set<string>,
  ): Promise<BatchUndoItemOutcome> => {
    if (!isBatchAlive(batch)) return "retired";
    const dismissal = parseWaitingDismissalInstanceId(entry.dismissal);
    if (!dismissal) {
      batch.processed += 1;
      ports.render();
      return "not_restored";
    }
    touchedWorkspaces.add(entry.workspaceId);

    const alive = createActionAlive(
      entry.workspaceId,
      null,
      null,
      true,
      () => isBatchAlive(batch),
    );
    if (!alive()) return "retired";

    let result: WaitingDismissalResult;
    try {
      result = await ports.sendRestore(entry.workspaceId, entry.itemKind, entry.itemId, alive, dismissal);
    } catch {
      result = { ok: false, status: 0, error: null, message: "Could not restore. Try again." };
    }
    if (!ownsBatch(batch) || !alive() || isRetiredResult(result)) {
      return "retired";
    }

    batch.processed += 1;
    ports.render();
    if (result.ok && result.restored !== false) {
      return "restored";
    }
    return "not_restored";
  };

  return {
    accessGeneration: () => accessGen,
    workspaceAccessGeneration: (workspaceId: string) =>
      Math.max(globalGen, workspaceAnyLossGens.get(normId(workspaceId)) ?? 0),
    has: (key) => rows.has(key),

    pendingDismissCardIds(workspaceId: string): Set<string> {
      const ids = new Set<string>();
      for (const row of rows.values()) {
        if (row.retired || row.pendingUndo || !sameId(row.workspaceId, workspaceId)) continue;
        if (!row.dismissResolved || row.batchAttemptId !== null) {
          ids.add(row.cardId);
        }
      }
      return ids;
    },

    placeholdersFor(placeKey: string, scope: WaitingScope): WaitingDismissedPlaceholder[] {
      const out: WaitingDismissedPlaceholder[] = [];
      for (const row of rows.values()) {
        if (!row.retired && row.batchAttemptId === null && row.placeKey === placeKey && row.scope === scope) {
          out.push({
            key: row.key,
            itemKind: row.itemKind,
            itemId: row.itemId || row.cardId,
            cardId: row.cardId,
            workspaceId: row.workspaceId,
            position: row.position,
            ...(row.pendingUndo ? { pendingUndo: true as const } : {}),
          });
        }
      }
      return out;
    },

    surveyNotice(): { key: string; pendingUndo?: true } | null {
      if (!surveyDismissedKey) return null;
      const row = rows.get(surveyDismissedKey);
      if (!row || row.retired) return null;
      return {
        key: row.key,
        ...(row.pendingUndo ? { pendingUndo: true as const } : {}),
      };
    },

    isArchivedRestoring: (itemKey) => archivedRestoring.has(itemKey),

    batchState(): WaitingDismissBatchVM | null {
      const batch = activeBatch;
      if (!batch || batch.retired) return null;
      if (batch.phase === "loading") return { phase: "loading" };
      if (batch.phase === "confirm") return { phase: "confirm", total: batch.total };
      if (batch.phase === "running") {
        return {
          phase: "running",
          processed: batch.processed,
          total: batch.total,
          stopping: batch.stopping,
        };
      }
      if (batch.phase === "undoing") {
        return {
          phase: "undoing",
          processed: batch.processed,
          total: batch.total,
        };
      }
      if (batch.phase === "restored") {
        return {
          phase: "restored",
          restoredCount: batch.restoredCount,
          total: batch.total,
        };
      }
      return {
        phase: "done",
        doneCount: batch.doneCount,
        total: batch.total,
        ...(batch.undoEntries.length > 0 ? { canUndo: true as const } : {}),
      };
    },

    batchScope(): { scope: WaitingScope; placeKey: string; workspaceIds: ReadonlySet<string> } | null {
      const batch = activeBatch;
      if (!batch || batch.retired) return null;
      return { scope: batch.scope, placeKey: batch.placeKey, workspaceIds: batch.workspaceIds };
    },

    async beginBatchConfirm(input: WaitingDismissBatchBeginInput): Promise<void> {
      if (!ports.isAlive()) return;
      if (activeBatch && (activeBatch.phase === "running" || activeBatch.phase === "undoing") && isBatchAlive(activeBatch)) return;
      const hadPrev = retireBatchInternal(false);

      const attemptId = newAttemptId();
      const currentBatchGen = (batchGen += 1);
      const accountAlive = ports.captureAccountGuard ? ports.captureAccountGuard() : ports.isAlive;
      const capturedPanelLifetime = ports.getPanelLifetime ? ports.getPanelLifetime() : null;
      const wsSet = new Set<string>(input.workspaceIds.map(normId).filter(Boolean));
      const wsGens = new Map<string, number>();
      for (const normWs of wsSet) {
        wsGens.set(normWs, workspaceAnyLossGens.get(normWs) ?? 0);
      }

      if (input.loadTargets) {
        const batch: WaitingDismissBatchInternal = {
          attemptId,
          batchGen: currentBatchGen,
          scope: input.scope,
          placeKey: input.placeKey,
          workspaceIds: wsSet,
          accountAlive,
          capturedGlobalGen: globalGen,
          capturedWsGens: wsGens,
          capturedPanelLifetime,
          phase: "loading",
          targets: [],
          undoEntries: [],
          total: 0,
          processed: 0,
          doneCount: 0,
          restoredCount: 0,
          stopping: false,
          retired: false,
        };
        activeBatch = batch;
        ports.render();

        let loaded: readonly WaitingDismissBatchTarget[] | null = null;
        try {
          loaded = await input.loadTargets(() => isBatchAlive(batch));
        } catch {
          loaded = null;
        }
        if (!ownsBatch(batch)) return;
        if (!isBatchAlive(batch)) {
          retireBatchInternal(false);
          return;
        }
        const sanitized = normalizeBatchTargets(loaded);
        if (sanitized.length < 2) {
          retireBatchInternal(true);
          return;
        }
        for (const t of sanitized) {
          const normWs = normId(t.workspaceId);
          if (normWs && !wsSet.has(normWs)) {
            wsSet.add(normWs);
            wsGens.set(normWs, workspaceAnyLossGens.get(normWs) ?? 0);
          }
        }
        batch.targets = sanitized;
        batch.total = sanitized.length;
        batch.phase = "confirm";
        ports.render();
        if (!ownsBatch(batch) || !isBatchAlive(batch)) return;
        ports.onBatchConfirmOpened?.();
        return;
      }

      const sanitized = normalizeBatchTargets(input.targets);
      if (sanitized.length < 2) {
        if (hadPrev && ports.isAlive()) ports.render();
        return;
      }
      for (const t of sanitized) {
        const normWs = normId(t.workspaceId);
        if (normWs && !wsSet.has(normWs)) {
          wsSet.add(normWs);
          wsGens.set(normWs, workspaceAnyLossGens.get(normWs) ?? 0);
        }
      }
      const batch: WaitingDismissBatchInternal = {
        attemptId,
        batchGen: currentBatchGen,
        scope: input.scope,
        placeKey: input.placeKey,
        workspaceIds: wsSet,
        accountAlive,
        capturedGlobalGen: globalGen,
        capturedWsGens: wsGens,
        capturedPanelLifetime,
        phase: "confirm",
        targets: sanitized,
        undoEntries: [],
        total: sanitized.length,
        processed: 0,
        doneCount: 0,
        restoredCount: 0,
        stopping: false,
        retired: false,
      };
      activeBatch = batch;
      ports.render();
      if (!ownsBatch(batch) || !isBatchAlive(batch)) return;
      ports.onBatchConfirmOpened?.();
    },

    cancelBatchConfirm(): void {
      const batch = activeBatch;
      if (!batch || (batch.phase !== "confirm" && batch.phase !== "loading")) return;
      retireBatchInternal(true);
      if (ports.isAlive()) ports.onBatchCancelled?.();
    },

    async confirmBatch(): Promise<void> {
      const batch = activeBatch;
      if (!batch || batch.phase !== "confirm" || !isBatchAlive(batch)) return;

      // Drop any resolved per-item "Dismissed · Undo" placeholders so the batch result row replaces them.
      for (const [key, row] of rows.entries()) {
        if (row.batchAttemptId === null && row.dismissResolved && !row.pendingUndo) {
          row.retired = true;
          deleteOwnedRow(key, row);
        }
      }

      batch.phase = "running";
      batch.processed = 0;
      batch.undoEntries = [];
      batch.stopping = false;
      ports.render();
      if (!ownsBatch(batch) || !isBatchAlive(batch)) return;
      ports.onBatchStarted?.();

      const notFoundCandidates: BatchNotFoundCandidate[] = [];
      const undoEntries: BatchUndoRecord[] = [];
      const touchedWorkspaces = new Set<string>();
      let dismissedCount = 0;
      let retired = false;

      for (let start = 0; start < batch.targets.length; start += BATCH_CONCURRENCY) {
        if (!isBatchAlive(batch)) {
          retired = true;
          break;
        }
        if (batch.stopping) break;
        const chunk = batch.targets.slice(start, start + BATCH_CONCURRENCY);
        const outcomes = await Promise.all(
          chunk.map((target) => runBatchDismissItem(batch, target, touchedWorkspaces)),
        );
        if (!ownsBatch(batch)) return;
        if (!isBatchAlive(batch) || outcomes.some(o => o.kind === "retired")) {
          retired = true;
          break;
        }
        for (const outcome of outcomes) {
          if (outcome.kind === "dismissed") {
            dismissedCount += 1;
            if (outcome.undoEntry) undoEntries.push(outcome.undoEntry);
          } else if (outcome.kind === "not_found") {
            notFoundCandidates.push(outcome.candidate);
          }
        }
      }

      if (!ownsBatch(batch)) return;
      if (retired || !isBatchAlive(batch)) {
        retireBatchInternal(false);
        return;
      }

      // Release batch row locks before the authoritative server reload so failed, stopped, or
      // still-listed items reappear accurately from the server.
      clearBatchRows(batch.attemptId);
      for (const wsId of touchedWorkspaces) {
        ports.invalidateArchived(wsId);
      }
      await reloadBatchWorkspaces(touchedWorkspaces);

      if (!ownsBatch(batch)) return;
      if (!isBatchAlive(batch)) {
        retireBatchInternal(false);
        return;
      }

      let gone404Count = 0;
      for (const candidate of notFoundCandidates) {
        if (ports.isItemListed && !ports.isItemListed(candidate.workspaceId, candidate.slotKind, candidate.cardId)) {
          gone404Count += 1;
        }
      }
      batch.doneCount = dismissedCount + gone404Count;
      batch.undoEntries = undoEntries;
      batch.phase = "done";
      ports.render();
      if (!ownsBatch(batch) || !isBatchAlive(batch)) return;
      ports.onBatchFinished?.();
    },

    async undoBatch(): Promise<void> {
      const prev = activeBatch;
      if (!prev || prev.phase !== "done" || prev.undoEntries.length === 0) return;
      if (!isBatchAlive(prev)) {
        retireBatchInternal(false);
        return;
      }

      const entries: BatchUndoRecord[] = prev.undoEntries.map((entry) => ({
        workspaceId: entry.workspaceId,
        itemKind: entry.itemKind,
        itemId: entry.itemId,
        dismissal: entry.dismissal,
      }));
      prev.retired = true;
      prev.undoEntries = [];

      const attemptId = newAttemptId();
      const currentBatchGen = (batchGen += 1);
      const accountAlive = ports.captureAccountGuard ? ports.captureAccountGuard() : ports.isAlive;
      const capturedPanelLifetime = ports.getPanelLifetime ? ports.getPanelLifetime() : null;
      const wsSet = new Set<string>(prev.workspaceIds);
      for (const entry of entries) {
        const normWs = normId(entry.workspaceId);
        if (normWs) wsSet.add(normWs);
      }
      const wsGens = new Map<string, number>();
      for (const normWs of wsSet) {
        wsGens.set(normWs, workspaceAnyLossGens.get(normWs) ?? 0);
      }

      const undoBatch: WaitingDismissBatchInternal = {
        attemptId,
        batchGen: currentBatchGen,
        scope: prev.scope,
        placeKey: prev.placeKey,
        workspaceIds: wsSet,
        accountAlive,
        capturedGlobalGen: globalGen,
        capturedWsGens: wsGens,
        capturedPanelLifetime,
        phase: "undoing",
        targets: [],
        undoEntries: [],
        total: entries.length,
        processed: 0,
        doneCount: 0,
        restoredCount: 0,
        stopping: false,
        retired: false,
      };
      activeBatch = undoBatch;
      ports.render();
      if (!ownsBatch(undoBatch)) return;
      if (!isBatchAlive(undoBatch)) {
        retireBatchInternal(false);
        return;
      }

      const touchedWorkspaces = new Set<string>();
      let restoredCount = 0;
      let retired = false;

      for (let start = 0; start < entries.length; start += BATCH_CONCURRENCY) {
        if (!isBatchAlive(undoBatch)) {
          retired = true;
          break;
        }
        const chunk = entries.slice(start, start + BATCH_CONCURRENCY);
        const outcomes = await Promise.all(
          chunk.map((entry) => runBatchUndoItem(undoBatch, entry, touchedWorkspaces)),
        );
        if (!ownsBatch(undoBatch)) return;
        if (!isBatchAlive(undoBatch) || outcomes.some((o) => o === "retired")) {
          retired = true;
          break;
        }
        for (const outcome of outcomes) {
          if (outcome === "restored") restoredCount += 1;
        }
      }

      if (!ownsBatch(undoBatch)) return;
      if (retired || !isBatchAlive(undoBatch)) {
        retireBatchInternal(false);
        return;
      }

      for (const wsId of touchedWorkspaces) {
        ports.invalidateArchived(wsId);
      }
      await reloadBatchWorkspaces(touchedWorkspaces);

      if (!ownsBatch(undoBatch)) return;
      if (!isBatchAlive(undoBatch)) {
        retireBatchInternal(false);
        return;
      }

      if (restoredCount === entries.length) {
        const settledGen = (batchGen += 1);
        undoBatch.retired = true;
        undoBatch.undoEntries = [];
        activeBatch = null;
        ports.render();
        if (batchGen !== settledGen || activeBatch !== null || !isBatchContextAlive(undoBatch)) return;
        ports.onBatchUndoFinished?.();
        return;
      }

      undoBatch.restoredCount = restoredCount;
      undoBatch.total = entries.length;
      undoBatch.undoEntries = [];
      undoBatch.phase = "restored";
      ports.render();
      if (!ownsBatch(undoBatch) || !isBatchAlive(undoBatch)) return;
      ports.onBatchUndoFinished?.();
    },

    stopBatch(): void {
      const batch = activeBatch;
      if (!batch || batch.phase !== "running" || batch.stopping || !isBatchAlive(batch)) return;
      batch.stopping = true;
      ports.render();
    },

    retireBatch(renderIfChanged = true): boolean {
      return retireBatchInternal(renderIfChanged);
    },

    async dismiss(target: WaitingDismissTarget): Promise<void> {
      if (!ports.isAlive()) return;
      if (activeBatch) {
        if ((activeBatch.phase === "running" || activeBatch.phase === "undoing") && isBatchAlive(activeBatch)) return;
        retireBatchInternal(false);
      }
      const key = `${target.slotKind}:${target.cardId}`;
      if (rows.has(key)) return;

      const attemptId = newAttemptId();
      const row: WaitingDismissRow = {
        attemptId,
        batchAttemptId: null,
        key,
        slotKind: target.slotKind,
        itemKind: target.itemKind,
        itemId: target.itemId,
        cardId: target.cardId,
        workspaceId: target.workspaceId,
        channelId: target.channelId,
        conversationId: target.conversationId,
        placementKind: target.placementKind,
        position: target.position,
        placeKey: target.placeKey,
        scope: target.scope,
        accessGen,
        pendingUndo: false,
        undoAttemptId: null,
        dismissResolved: false,
        retired: false,
      };
      rows.set(key, row);
      if (target.fromSurvey) surveyDismissedKey = key;

      ports.removeCardFromClient(target);
      ports.render();
      ports.onDismissedRendered?.(key);

      const ownsRow = (): boolean => isRowOwner(key, row);
      const alive = createActionAlive(
        target.workspaceId,
        target.channelId,
        target.conversationId,
        target.placementKind === "unknown",
        () => !row.retired && ownsRow(),
      );
      const settleCancelledIfOwned = (): false => {
        if (!ownsRow()) return false;
        row.retired = true;
        deleteOwnedRow(key, row);
        if (ports.isAlive()) ports.render();
        return false;
      };

      const runDismiss = async (): Promise<boolean> => {
        let resolvedItemId = row.itemId;
        if (target.itemKind === "review" && !resolvedItemId) {
          if (!ports.resolveReviewOfferId) {
            if (!ownsRow()) return false;
            if (!alive()) return settleCancelledIfOwned();
            deleteOwnedRow(key, row);
            ports.render();
            await ports.reloadWaiting(target.workspaceId);
            return false;
          }
          try {
            const offerId = await ports.resolveReviewOfferId(target.workspaceId, target.cardId, alive);
            if (!ownsRow()) return false;
            if (!alive()) return settleCancelledIfOwned();
            if (!offerId) {
              deleteOwnedRow(key, row);
              ports.invalidateArchived(target.workspaceId);
              ports.render();
              await ports.reloadWaiting(target.workspaceId);
              return false;
            }
            resolvedItemId = offerId;
          } catch {
            if (!ownsRow()) return false;
            if (!alive()) return settleCancelledIfOwned();
            deleteOwnedRow(key, row);
            ports.setCardError(target.slotKind, target.cardId, "Could not dismiss. Try again.");
            ports.render();
            await ports.reloadWaiting(target.workspaceId);
            return false;
          }
          row.itemId = resolvedItemId;
        }

        if (!ownsRow()) return false;
        if (!alive()) return settleCancelledIfOwned();
        let result: WaitingDismissalResult;
        try {
          result = await ports.sendDismiss(target.workspaceId, target.itemKind, resolvedItemId, alive);
        } catch {
          result = { ok: false, status: 0, error: null, message: "Could not dismiss. Try again." };
        }
        if (!ownsRow()) return false;
        if (!alive() || isRetiredResult(result)) {
          return settleCancelledIfOwned();
        }

        if (result.ok) {
          row.dismissResolved = true;
          if (!row.pendingUndo) {
            ports.invalidateArchived(target.workspaceId);
            void ports.reloadWaiting(target.workspaceId);
          }
          return true;
        }

        deleteOwnedRow(key, row);
        if (!isNotFoundResult(result)) {
          ports.setCardError(target.slotKind, target.cardId, result.message);
        }
        ports.invalidateArchived(target.workspaceId);
        ports.render();
        await ports.reloadWaiting(target.workspaceId);
        return false;
      };

      row.inFlightDismiss = runDismiss();
      await row.inFlightDismiss;
    },

    async undo(key: string): Promise<void> {
      const row = rows.get(key);
      if (!row || row.retired || row.pendingUndo || !ports.isAlive()) return;
      if (activeBatch) {
        if ((activeBatch.phase === "running" || activeBatch.phase === "undoing") && isBatchAlive(activeBatch)) return;
        retireBatchInternal(false);
      }

      const undoAttemptId = newAttemptId();
      row.pendingUndo = true;
      row.undoAttemptId = undoAttemptId;
      ports.render();

      const ownsUndo = (): boolean => isRowOwner(key, row) && row.undoAttemptId === undoAttemptId;
      const scopeAlive = createActionAlive(
        row.workspaceId,
        row.channelId,
        row.conversationId,
        row.placementKind === "unknown",
        () => !row.retired,
      );
      const alive = (): boolean => scopeAlive() && ownsUndo();
      const settleCancelledIfOwned = (): void => {
        if (!ownsUndo()) return;
        row.retired = true;
        deleteOwnedRow(key, row);
        if (ports.isAlive()) ports.render();
      };

      const dismissSucceeded = row.inFlightDismiss ? await row.inFlightDismiss : row.dismissResolved;
      if (!ownsUndo()) return;
      if (!alive()) {
        settleCancelledIfOwned();
        return;
      }
      if (!dismissSucceeded || !row.itemId) return;

      let result: WaitingDismissalResult;
      try {
        result = await ports.sendRestore(row.workspaceId, row.itemKind, row.itemId, alive);
      } catch {
        result = { ok: false, status: 0, error: null, message: "Could not restore. Try again." };
      }
      if (!ownsUndo()) return;
      if (!alive() || isRetiredResult(result)) {
        settleCancelledIfOwned();
        return;
      }

      deleteOwnedRow(key, row);
      if (!result.ok && !isNotFoundResult(result)) {
        ports.setStatusError(result.message);
      }
      ports.invalidateArchived(row.workspaceId);
      ports.render();
      await ports.reloadWaiting(row.workspaceId);
      if (result.ok && scopeAlive()) {
        ports.onRestoredReloaded?.(row.slotKind, row.cardId);
      }
    },

    async restoreArchived(item: WaitingArchivedItem): Promise<void> {
      if (item.outcomeKind !== "dismissed" || archivedRestoring.has(item.itemKey) || !ports.isAlive()) return;
      if (activeBatch) {
        if ((activeBatch.phase === "running" || activeBatch.phase === "undoing") && isBatchAlive(activeBatch)) return;
        retireBatchInternal(false);
      }

      const attemptId = newAttemptId();
      const entry: ArchivedRestoreEntry = {
        attemptId,
        itemKey: item.itemKey,
        workspaceId: item.workspaceId,
        channelId: item.channelId ?? null,
        conversationId: item.conversationId ?? null,
        placement: item.placement,
        retired: false,
      };
      archivedRestoring.set(item.itemKey, entry);
      ports.clearArchivedError(item.itemKey);
      ports.render();

      const ownsEntry = (): boolean => isArchivedOwner(item.itemKey, entry);
      const alive = createActionAlive(
        item.workspaceId,
        item.channelId ?? null,
        item.conversationId ?? null,
        item.placement === "redacted",
        () => !entry.retired && ownsEntry(),
      );

      let result: WaitingDismissalResult;
      try {
        result = await ports.sendRestore(item.workspaceId, item.kind, item.id, alive);
      } catch {
        result = { ok: false, status: 0, error: null, message: "Could not restore. Try again." };
      }
      if (!ownsEntry()) return;
      if (!alive() || isRetiredResult(result)) {
        entry.retired = true;
        deleteOwnedArchived(item.itemKey, entry);
        if (ports.isAlive()) ports.render();
        return;
      }

      deleteOwnedArchived(item.itemKey, entry);
      if (!result.ok && !isNotFoundResult(result)) {
        ports.setArchivedError(item.itemKey, result.message);
      }
      ports.invalidateArchived(item.workspaceId);
      ports.render();
      await ports.reloadWaiting(item.workspaceId);
    },

    retireForConversation(workspaceId: string, conversationId: string, channelId: string | null = null): boolean {
      return retireMatching(
        (row) =>
          sameId(row.workspaceId, workspaceId) &&
          (sameId(row.conversationId, conversationId) ||
            sameId(row.channelId, conversationId) ||
            (channelId !== null && sameId(row.channelId, channelId)) ||
            row.placementKind === "unknown"),
        (entry) =>
          sameId(entry.workspaceId, workspaceId) &&
          (sameId(entry.conversationId, conversationId) ||
            sameId(entry.channelId, conversationId) ||
            (channelId !== null && sameId(entry.channelId, channelId)) ||
            entry.placement === "redacted"),
        { kind: "conversation", workspaceId, conversationId, channelId },
      );
    },

    retireForChannel(workspaceId: string, channelId: string): boolean {
      return retireMatching(
        (row) =>
          sameId(row.workspaceId, workspaceId) &&
          (sameId(row.channelId, channelId) || row.placementKind === "unknown"),
        (entry) =>
          sameId(entry.workspaceId, workspaceId) &&
          (sameId(entry.channelId, channelId) || entry.placement === "redacted"),
        { kind: "channel", workspaceId, channelId },
      );
    },

    retireForWorkspace(workspaceId: string, options?: { fromWaitingRefresh?: boolean }): boolean {
      return retireMatching(
        (row) => sameId(row.workspaceId, workspaceId),
        (entry) => sameId(entry.workspaceId, workspaceId),
        { kind: "workspace", workspaceId, ...(options?.fromWaitingRefresh ? { fromWaitingRefresh: true } : {}) },
      );
    },

    retireAll(notify = false): void {
      accessGen += 1;
      globalGen = accessGen;
      retireBatchInternal(false);
      for (const row of rows.values()) row.retired = true;
      rows.clear();
      surveyDismissedKey = null;
      for (const entry of archivedRestoring.values()) entry.retired = true;
      archivedRestoring.clear();
      if (notify) ports.onRetireAccessLoss?.({ kind: "all" });
    },
  };
}
