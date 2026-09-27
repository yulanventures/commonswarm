import { errors } from "oidc-provider";

const GRANTABLE_MODELS = new Set([
  "AccessToken",
  "AuthorizationCode",
  "BackchannelAuthenticationRequest",
  "DeviceCode",
  "PreAuthorizedCode",
  "RefreshToken",
]);

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function storageKey(model, id) {
  return `${model}:${id}`;
}

function removeFromGrant(state, key, payload) {
  if (!GRANTABLE_MODELS.has(payload.kind) || !payload.grantId) {
    return;
  }

  const members = state.grantMembers.get(payload.grantId);
  members?.delete(key);
  if (members?.size === 0) {
    state.grantMembers.delete(payload.grantId);
  }
}

function removeRecord(state, key) {
  const record = state.records.get(key);
  if (!record) return;

  state.records.delete(key);
  removeFromGrant(state, key, record.payload);
  if (record.payload.uid && state.sessionUids.get(record.payload.uid) === record.payload.jti) {
    state.sessionUids.delete(record.payload.uid);
  }
  if (record.payload.userCode && state.userCodes.get(record.payload.userCode) === record.payload.jti) {
    state.userCodes.delete(record.payload.userCode);
  }
}

function revokeGrant(state, grantId) {
  state.revokedGrants.add(grantId);
  for (const key of [...state.grantMembers.get(grantId) ?? []]) {
    removeRecord(state, key);
  }
  state.grantMembers.delete(grantId);
}

/**
 * A process-local spike adapter with compare-and-swap refresh consumption.
 * Production must replace this with the PostgreSQL contract in SPIKE.md.
 */
export function createAtomicMemoryAdapter({ beforeRefreshTokenConsume } = {}) {
  const state = {
    grantMembers: new Map(),
    records: new Map(),
    revokedGrants: new Set(),
    sessionUids: new Map(),
    userCodes: new Map(),
  };

  return (model) => ({
    async consume(id) {
      if (model === "RefreshToken") {
        await beforeRefreshTokenConsume?.(id);
      }

      const key = storageKey(model, id);
      const record = state.records.get(key);
      if (!record) {
        throw new errors.InvalidGrant(`${model} not found`);
      }

      if (record.payload.consumed !== undefined) {
        // Two requests may both have found an unconsumed token before they
        // race this compare-and-swap. The loser must not revoke the winner's
        // grant family. A later request that finds the consumed token takes
        // oidc-provider's replay path, which calls revokeByGrantId.
        throw new errors.InvalidGrant("refresh token already used");
      }

      record.payload.consumed = Math.floor(Date.now() / 1000);
    },

    async destroy(id) {
      removeRecord(state, storageKey(model, id));
    },

    async find(id) {
      const key = storageKey(model, id);
      const record = state.records.get(key);
      if (!record) return undefined;
      if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
        removeRecord(state, key);
        return undefined;
      }
      return copy(record.payload);
    },

    async findByUid(uid) {
      const id = state.sessionUids.get(uid);
      return id === undefined ? undefined : this.find(id);
    },

    async findByUserCode(userCode) {
      const id = state.userCodes.get(userCode);
      return id === undefined ? undefined : this.find(id);
    },

    async revokeByGrantId(grantId) {
      revokeGrant(state, grantId);
    },

    async upsert(id, payload, expiresIn) {
      const key = storageKey(model, id);
      removeRecord(state, key);

      if (GRANTABLE_MODELS.has(model) && payload.grantId) {
        // Never report a successful save for an artifact the tombstone
        // prevented us from storing. This can happen when replay revocation
        // overtakes a request between refresh-token consumption and rotation.
        if (state.revokedGrants.has(payload.grantId)) {
          throw new errors.InvalidGrant("grant family revoked");
        }
        const members = state.grantMembers.get(payload.grantId) ?? new Set();
        members.add(key);
        state.grantMembers.set(payload.grantId, members);
      }

      const stored = copy({ ...payload, jti: payload.jti ?? id, kind: payload.kind ?? model });
      state.records.set(key, {
        expiresAt: typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined,
        payload: stored,
      });
      if (stored.uid) state.sessionUids.set(stored.uid, id);
      if (stored.userCode) state.userCodes.set(stored.userCode, id);
    },
  });
}
