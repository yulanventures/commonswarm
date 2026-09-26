/** Names owned by connect inside a profile directory. Keep readers and writers on this list. */
export const CONNECT_PROFILE_FILES = {
  pending: "connect-pending.json",
  complete: "connect-complete.json",
  attemptMarker: "connect-profile-attempt.json",
  credential: "credential.json",
  setupLock: "setup.lock",
  connectLock: "mcp-connect.lock",
  temporaryBases: ["connect-pending.json", "connect-complete.json", "connect-profile-attempt.json", "credential.json", "profile.json"],
  temporaryPattern: /^.+\.\d+\.[0-9a-f]{12}\.tmp$/i,
  temporaryName: (path: string, pid: number, hex: string) => `${path}.${pid}.${hex}.tmp`,
} as const;

export function reservedConnectProfileName(name: string): boolean {
  const lower = name.toLowerCase();
  if ([CONNECT_PROFILE_FILES.pending, CONNECT_PROFILE_FILES.complete, CONNECT_PROFILE_FILES.attemptMarker, CONNECT_PROFILE_FILES.credential,
    CONNECT_PROFILE_FILES.setupLock, CONNECT_PROFILE_FILES.connectLock].some(base => lower === base)) return true;
  return CONNECT_PROFILE_FILES.temporaryPattern.test(lower);
}

export function reservedConnectProfileNames(): string {
  return [CONNECT_PROFILE_FILES.pending, CONNECT_PROFILE_FILES.complete, CONNECT_PROFILE_FILES.attemptMarker, CONNECT_PROFILE_FILES.credential,
    CONNECT_PROFILE_FILES.setupLock, CONNECT_PROFILE_FILES.connectLock,
    ...CONNECT_PROFILE_FILES.temporaryBases.map(base => `${base}.<pid>.<12 hex>.tmp`),
    "<profile-name>.<pid>.<12 hex>.tmp"].join(", ");
}
