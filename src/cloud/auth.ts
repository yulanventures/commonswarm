import { setTimeout as delay } from "node:timers/promises";
import { fetchRestReadRetrying } from "./rest-read-retry.js";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import {
  authStorageKey,
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  type CloudTarget,
} from "./config.js";
import { FileLockTimeoutError, type HumanSessionState, type CredentialRecord, type CredentialStore } from "./storage.js";
import { withClientBuild } from "./client-build.js";

const CALLBACK_PATH = "/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const PASTE_FALLBACK_DELAY_MS = 15_000;
const HIGH_PORT_MIN = 49_152;
const HIGH_PORT_MAX_EXCLUSIVE = 65_536;
const CALLBACK_ATTEMPTS = 32;

export const LOGIN_PROVIDERS = ["google", "github"] as const;
export type LoginProvider = typeof LOGIN_PROVIDERS[number];

const LOGIN_PROVIDER_LABELS: { readonly [Provider in LoginProvider]: string } = {
  google: "Google",
  github: "GitHub",
};

export function loginProviderLabel(provider: LoginProvider): string {
  return LOGIN_PROVIDER_LABELS[provider];
}

export interface AsyncStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryStorage implements AsyncStorage {
  private readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export interface LoginOptions {
  target: CloudTarget;
  store: CredentialStore;
  provider?: LoginProvider;
  openBrowser?: (url: string) => Promise<boolean>;
  input?: Readable;
  output?: Writable;
  timeoutMs?: number;
  pasteFallbackDelayMs?: number;
}

export interface LoginResult {
  userId: string;
  deviceId: string;
  storage: "keychain" | "file";
  workspaceId: string | null;
  email: string | null;
}

export interface RefreshedCredential {
  accessToken: string;
  userId: string;
  deviceId: string;
}

export type HumanSessionErrorCode =
  | "human_session_missing"
  | "human_session_refresh_failed"
  | "human_session_transient";

export class HumanSessionError extends Error {
  readonly name = "HumanSessionError";

  constructor(readonly code: HumanSessionErrorCode, message: string,
    readonly operationId?: string, readonly generation?: number, readonly phase?: string) {
    super(message);
  }
}

interface CallbackReceiver {
  redirectUrl: string;
  origin: string;
  result: Promise<string>;
  close(): Promise<void>;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateCallbackUrl(
  raw: string,
  expectedOrigin: string,
  expectedState: string,
): string {
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    throw new Error("pasted callback must be a complete URL");
  }
  if (callback.origin !== expectedOrigin || callback.pathname !== CALLBACK_PATH) {
    throw new Error("callback origin or path does not match this login attempt");
  }
  const state = callback.searchParams.get("state");
  if (state === null || !equalSecret(state, expectedState)) {
    throw new Error("login state mismatch; refusing callback");
  }
  const oauthError = callback.searchParams.get("error_description") ??
    callback.searchParams.get("error");
  if (oauthError) throw new Error(`OAuth login failed: ${oauthError.slice(0, 240)}`);
  const code = callback.searchParams.get("code");
  if (!code || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new Error("callback is missing a valid authorization code");
  }
  return code;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  return closed;
}

async function callbackReceiver(expectedState: string): Promise<CallbackReceiver> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let origin = "";
  let settled = false;
  const server = createServer((request, response) => {
    try {
      const raw = new URL(request.url ?? "/", origin).toString();
      const code = validateCallbackUrl(raw, origin, expectedState);
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
      });
      response.end("CommonSwarm login complete. You can return to the terminal.\n");
      if (!settled) {
        settled = true;
        resolveCode(code);
      }
    } catch (error) {
      response.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
      });
      response.end("Swarm login callback rejected.\n");
    }
  });

  for (let attempt = 0; attempt < CALLBACK_ATTEMPTS; attempt += 1) {
    const port = randomInt(HIGH_PORT_MIN, HIGH_PORT_MAX_EXCLUSIVE);
    try {
      await listen(server, port);
      server.unref();
      origin = `http://127.0.0.1:${port}`;
      const redirect = new URL(CALLBACK_PATH, origin);
      redirect.searchParams.set("state", expectedState);
      return {
        redirectUrl: redirect.toString(),
        origin,
        result,
        close: async () => {
          if (!settled) {
            settled = true;
            rejectCode(new Error("login callback listener closed"));
          }
          await closeServer(server);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  throw new Error("unable to bind a random high loopback callback port");
}

function pkceVerifier(): string {
  return base64Url(randomBytes(64));
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function oauthUrl(
  target: CloudTarget,
  redirectUrl: string,
  challenge: string,
  provider: LoginProvider,
): string {
  const url = new URL("/auth/v1/authorize", target.url);
  url.searchParams.set("provider", provider);
  url.searchParams.set("redirect_to", redirectUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "s256");
  return url.toString();
}

function authClient(
  target: CloudTarget,
  storage: AsyncStorage,
): SupabaseClient {
  return createClient(target.url, target.anonKey, {
    auth: {
      flowType: "pkce",
      storage,
      storageKey: authStorageKey(target),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export async function openExternalBrowser(url: string): Promise<boolean> {
  const command = process.platform === "darwin"
    ? { executable: "open", args: [url] }
    : process.platform === "linux"
    ? { executable: "xdg-open", args: [url] }
    : null;
  if (!command) return false;
  return await new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function pastedCallback(
  input: Readable | undefined,
  output: Writable,
  origin: string,
  state: string,
): { promise: Promise<string>; close(): void } | null {
  if (!input) return null;
  let resolveCode!: (code: string) => void;
  const promise = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });
  let pending = "";
  const onData = (chunk: Buffer | string) => {
    pending += chunk.toString();
    while (pending.includes("\n")) {
      const newline = pending.indexOf("\n");
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      try {
        resolveCode(validateCallbackUrl(line, origin, state));
      } catch (error) {
        output.write(`${(error as Error).message}\n`);
        output.write("Paste the complete callback URL, or finish in the browser:\n");
      }
    }
  };
  input.on("data", onData);
  return {
    promise,
    close: () => {
      input.off("data", onData);
      input.pause();
    },
  };
}

async function waitForCode(
  receiver: CallbackReceiver,
  state: string,
  input: Readable | undefined,
  output: Writable,
  timeoutMs: number,
  pasteFallbackDelayMs: number,
): Promise<string> {
  const activePastes: Array<{ close(): void }> = [];
  let pasteTimer: NodeJS.Timeout | null = null;
  const paste = input
    ? new Promise<string>((resolve) => {
      pasteTimer = setTimeout(() => {
        output.write(
          "If the browser cannot reach the loopback callback, paste the complete callback URL here:\n",
        );
        const pasted = pastedCallback(input, output, receiver.origin, state);
        if (pasted) activePastes.push(pasted);
        pasted?.promise.then(resolve);
      }, pasteFallbackDelayMs);
    })
    : null;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for the login callback")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      receiver.result,
      ...(paste ? [paste] : []),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (pasteTimer) clearTimeout(pasteTimer);
    for (const pasted of activePastes) pasted.close();
  }
}

function requireSession(session: Session | null): Session {
  if (typeof session?.refresh_token !== "string" || session.refresh_token.length < 8 ||
      session.refresh_token.length > 2048 || /[|\u0000-\u001f\u007f]/.test(session.refresh_token) ||
      typeof session.access_token !== "string" || !session.access_token || session.access_token.length > 16384 ||
      typeof session.user?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(session.user.id)) {
    throw new Error("GoTrue returned an incomplete session");
  }
  return session;
}

async function registerLoginDevice(
  target: CloudTarget,
  accessToken: string,
  deviceId: string,
): Promise<boolean> {
  const response = await fetch(commandEndpoint(target), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(withClientBuild({
      command_id: `login_${randomBytes(12).toString("base64url")}`,
      client_version: CLIENT_PROTOCOL_VERSION,
      command: {
        kind: "register_device",
        device_id: deviceId,
        label: "cswarm-cli",
      },
    })),
  });
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(
      `login device registration returned non-JSON (HTTP ${response.status})`,
    );
  }
  if (response.status === 403) return false;
  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as Record<string, unknown>).status !== "accepted" ||
    (body as Record<string, unknown>).device_id !== deviceId
  ) {
    throw new Error(`login device registration failed (HTTP ${response.status})`);
  }
  return true;
}

async function discoverSoleWorkspace(
  target: CloudTarget,
  accessToken: string,
  userId: string,
): Promise<string | null> {
  const url = new URL("/rest/v1/memberships", target.url);
  url.searchParams.set("select", "workspace_id");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("revoked_at", "is.null");
  url.searchParams.set("limit", "2");
  let response: Response;
  try {
    response = await fetchRestReadRetrying(fetch, url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: target.anonKey,
        "accept-profile": "swarm_read",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body) || body.length !== 1) return null;
  const workspaceId = (body[0] as Record<string, unknown>)?.workspace_id;
  return typeof workspaceId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(workspaceId)
    ? workspaceId
    : null;
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  const output = options.output ?? process.stderr;
  // Keep embedded callers aligned with the CLI's declared provider order. The
  // first provider is the product default everywhere a caller omits the option.
  // Explicit callers still select either supported provider in the normal way.
  const provider = options.provider ?? LOGIN_PROVIDERS[0];
  const state = base64Url(randomBytes(32));
  const verifier = pkceVerifier();
  const memory = new MemoryStorage();
  const storageKey = authStorageKey(options.target);
  const client = authClient(options.target, memory);
  const initialized = await client.auth.initialize();
  if (initialized.error) {
    throw new Error(`unable to initialize PKCE auth: ${initialized.error.message}`);
  }
  // auth-js storage values are JSON encoded even when the underlying adapter
  // accepts strings. The verifier stays only in this process-local store.
  await memory.setItem(`${storageKey}-code-verifier`, JSON.stringify(verifier));
  const receiver = await callbackReceiver(state);
  const authorizationUrl = oauthUrl(
    options.target,
    receiver.redirectUrl,
    pkceChallenge(verifier),
    provider,
  );
  const opener = options.openBrowser ?? openExternalBrowser;

  try {
    const opened = await opener(authorizationUrl);
    if (!opened) {
      output.write(
        `Open this URL in a browser to sign in with ${loginProviderLabel(provider)}:\n`,
      );
      output.write(`${authorizationUrl}\n`);
    }
    const code = await waitForCode(
      receiver,
      state,
      options.input ?? (process.stdin.isTTY ? process.stdin : undefined),
      output,
      options.timeoutMs ?? CALLBACK_TIMEOUT_MS,
      opened
        ? options.pasteFallbackDelayMs ?? PASTE_FALLBACK_DELAY_MS
        : 0,
    );
    const exchanged = await client.auth.exchangeCodeForSession(code);
    if (exchanged.error) {
      throw new Error(`PKCE code exchange failed: ${exchanged.error.message}`);
    }
    const session = requireSession(exchanged.data.session);

    return await options.store.withLock(async () => {
      const existing = await options.store.read();
      const existingProfile = await options.store.readProfile();
      const sameUser = existing?.userId === session.user.id ||
        existing === null && existingProfile.userId === session.user.id;
      let deviceId = sameUser && existing?.deviceId
        ? existing.deviceId
        : randomUUID();
      if (
        !await registerLoginDevice(
          options.target,
          session.access_token,
          deviceId,
        )
      ) {
        deviceId = randomUUID();
        if (
          !await registerLoginDevice(
            options.target,
            session.access_token,
            deviceId,
          )
        ) {
          throw new Error("login device registration was forbidden");
        }
      }
      const discoveredWorkspace = await discoverSoleWorkspace(
        options.target,
        session.access_token,
        session.user.id,
      );
      const record: CredentialRecord = {
        version: 1,
        refreshToken: session.refresh_token,
        generation: (existing?.generation ?? -1) + 1,
        deviceId,
        userId: session.user.id,
      };
      delete existingProfile.humanSession;
      await options.store.writeProfile(existingProfile);
      await options.store.write(record);
      if (!sameCredential(await options.store.read(), record)) throw transientSession(randomUUID(), record.generation, "login-save");
      const workspaceId = discoveredWorkspace ??
        (sameUser ? existingProfile.workspaceId : null);
      await options.store.writeProfile({
        version: 1,
        userId: session.user.id,
        workspaceId,
        email: session.user.email ?? null,
        principalId: sameUser && existingProfile.workspaceId === workspaceId
          ? existingProfile.principalId ?? null
          : null,
        principalName: sameUser && existingProfile.workspaceId === workspaceId
          ? existingProfile.principalName ?? null
          : null,
        pendingCommands: sameUser ? existingProfile.pendingCommands : {},
        humanSession: cachedState(record, session),
      });
      return {
        userId: record.userId,
        deviceId: record.deviceId,
        storage: options.store.kind,
        workspaceId,
        email: session.user.email ?? null,
      };
    });
  } finally {
    await receiver.close().catch(() => undefined);
    await memory.removeItem(`${storageKey}-code-verifier`);
  }
}

function credentialDigest(record: CredentialRecord): string {
  return createHash("sha256").update(JSON.stringify([
    record.generation, record.userId, record.deviceId, record.refreshToken,
  ])).digest("hex");
}

function sameCredential(a: CredentialRecord | null, b: CredentialRecord): boolean {
  return a !== null && credentialDigest(a) === credentialDigest(b);
}

function boundState(state: HumanSessionState | undefined, record: CredentialRecord): state is HumanSessionState {
  return state !== undefined && state.generation === record.generation &&
    state.userId === record.userId && state.deviceId === record.deviceId &&
    state.parentDigest === credentialDigest(record);
}

function cachedState(record: CredentialRecord, session: Session): HumanSessionState {
  const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in;
  return { generation: record.generation, userId: record.userId, deviceId: record.deviceId,
    parentDigest: credentialDigest(record), accessToken: session.access_token, expiresAt };
}

function cachedCredential(record: CredentialRecord, state: HumanSessionState | undefined,
  rejectedAccessToken?: string): RefreshedCredential | null {
  if (!boundState(state, record) || !state.accessToken ||
      !Number.isSafeInteger(state.expiresAt) || state.expiresAt! <= Date.now() / 1000 + 30 ||
      state.accessToken === rejectedAccessToken) return null;
  return { accessToken: state.accessToken, userId: record.userId, deviceId: record.deviceId };
}

function transientSession(operationId: string, generation?: number, phase = "refresh"): HumanSessionError {
  return new HumanSessionError("human_session_transient",
    `Could not confirm your session right now. Your credential was kept; retry the command (reference ${operationId}).`,
    operationId, generation, phase);
}

/** Caller holds the profile lock. A durable successor can recover either side of
 * the credential write, but cannot recover an unseen server response. */
async function reconcileSuccessor(store: CredentialStore, record: CredentialRecord): Promise<CredentialRecord> {
  const profile = await store.readProfile();
  const state = profile.humanSession;
  const next = state?.successor;
  if (!state || !next) return record;
  const successor: CredentialRecord = { version: 1, refreshToken: next.refreshToken,
    userId: next.userId, deviceId: next.deviceId, generation: next.generation };
  const isParent = boundState(state, record);
  const isSuccessor = sameCredential(record, successor) && state.generation + 1 === record.generation &&
    state.userId === record.userId && state.deviceId === record.deviceId;
  if (!isParent && !isSuccessor) return record;
  if (isParent) {
    // Confirm journal durability again when adopting, including recovery after
    // a rename succeeded but the publishing process did not observe fsync.
    await store.writeProfile(profile);
    if (!sameCredential(await store.read(), record)) throw transientSession(state.operationId ?? randomUUID(), record.generation, "adopt");
    await store.write(successor);
  }
  if (!sameCredential(await store.read(), successor)) throw transientSession(state.operationId ?? randomUUID(), record.generation, "read-back");
  profile.humanSession = { generation: successor.generation, userId: successor.userId,
    deviceId: successor.deviceId, parentDigest: credentialDigest(successor),
    accessToken: next.accessToken, expiresAt: next.expiresAt, operationId: state.operationId };
  await store.writeProfile(profile);
  return successor;
}

async function saveSuccessor(store: CredentialStore, before: CredentialRecord,
  session: Session, operationId: string): Promise<CredentialRecord> {
  if (session.user.id !== before.userId) throw transientSession(operationId, before.generation, "identity");
  if (!sameCredential(await store.read(), before)) throw transientSession(operationId, before.generation, "save");
  const next = { ...before, refreshToken: session.refresh_token, generation: before.generation + 1 };
  const cache = cachedState(next, session);
  if (!Number.isSafeInteger(cache.expiresAt) || cache.expiresAt! <= 0) {
    throw transientSession(operationId, before.generation, "expiry");
  }
  const profile = await store.readProfile();
  profile.humanSession = { generation: before.generation, userId: before.userId,
    deviceId: before.deviceId, parentDigest: credentialDigest(before), operationId, successor: {
      refreshToken: next.refreshToken, accessToken: session.access_token, expiresAt: cache.expiresAt!,
      userId: next.userId, deviceId: next.deviceId, generation: next.generation,
    } };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!sameCredential(await store.read(), before)) throw transientSession(operationId, before.generation, "journal-winner");
    try {
      await store.writeProfile(profile);
      break;
    } catch (error) {
      // The successor is still known in memory. Retry its publication instead
      // of asking the server to rotate the parent again.
      if (attempt === 2) throw error;
      await delay(100 * (attempt + 1));
    }
  }
  return await reconcileSuccessor(store, before);
}

/** The SDK retries refresh internally. Use the same GoTrue endpoint directly here
 * so attempts and their deadlines have one bounded owner. Never expose raw errors. */
async function refreshHumanSession(target: CloudTarget, store: CredentialStore, record: CredentialRecord, operationId: string): Promise<
  { session: Session; code?: never } | { session?: never; code?: string }
> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!sameCredential(await store.read(), record)) throw transientSession(operationId, record.generation, "winner");
    try {
      const response = await fetch(new URL("/auth/v1/token?grant_type=refresh_token", target.url), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { apikey: target.anonKey, "content-type": "application/json",
          "x-request-id": operationId, "x-supabase-api-version": "2024-01-01" },
        body: JSON.stringify({ refresh_token: record.refreshToken }),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (response.ok) {
        const session = requireSession(body as unknown as Session | null);
        if (!Number.isFinite(session.expires_at) && Number.isFinite(session.expires_in)) {
          session.expires_at = Math.floor(Date.now() / 1000) + session.expires_in;
        }
        return { session };
      }
      if (response.status !== 429 && response.status < 500) {
        // A policy/permission refusal is not proof that the refresh handle died.
        return { code: typeof body?.code === "string" ? body.code
          : typeof body?.error_code === "string" ? body.error_code : undefined };
      }
    } catch { /* Network, malformed or incomplete response: retain the parent. */ }
    if (attempt < 2) await delay(150 * (attempt + 1));
  }
  return {};
}

export async function refreshedCredential(
  target: CloudTarget,
  store: CredentialStore,
  options: { rejectedAccessToken?: string; requestId?: string; signal?: AbortSignal | null;
    userId?: string; deviceId?: string } = {},
): Promise<RefreshedCredential> {
  const operationId = options.requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(options.requestId) ? options.requestId : randomUUID();
  try {
    return await store.withLock(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let before = await store.read();
        if (!before) throw new HumanSessionError("human_session_missing", "not logged in; run cswarm login");
        if (options.userId !== undefined && (before.userId !== options.userId || before.deviceId !== options.deviceId)) {
          throw transientSession(operationId, before.generation, "identity");
        }
        options.signal?.throwIfAborted();
        try {
          before = await reconcileSuccessor(store, before);
          const profile = await store.readProfile();
          const cached = cachedCredential(before, profile.humanSession, options.rejectedAccessToken);
          if (cached) return cached;
          if (!Number.isSafeInteger(before.generation + 1)) throw transientSession(operationId, before.generation, "generation");
          // Once rotation starts, its own bounded transport deadline owns it.
          // Await reconciliation and durable publication under this same lock,
          // even if the unrelated API caller cancels in the meantime.
          options.signal?.throwIfAborted();
          const refreshed = await refreshHumanSession(target, store, before, operationId);
          const current = await store.read();
          if (!sameCredential(current, before)) continue;
          if (!refreshed.session) {
            // Reconcile a published successor before classifying any terminal
            // code, including already-used. Only this exact unchanged parent
            // with no recoverable winner can receive terminal advice.
            const reconciled = await reconcileSuccessor(store, before);
            if (!sameCredential(reconciled, before)) continue;
            options.signal?.throwIfAborted();
            if (refreshed.code && TERMINAL_REFRESH_CODES.has(refreshed.code) &&
                sameCredential(await store.read(), before)) {
              throw new HumanSessionError("human_session_refresh_failed",
                `The server no longer accepts this session; run cswarm login to sign in again (reference ${operationId}).`,
                operationId, before.generation, "refresh");
            }
            throw transientSession(operationId, before.generation);
          }
          const next = await saveSuccessor(store, before, refreshed.session, operationId);
          const saved = cachedCredential(next, (await store.readProfile()).humanSession);
          options.signal?.throwIfAborted();
          if (saved) return saved;
          throw transientSession(operationId, next.generation, "read-back");
        } catch (error) {
          // Storage errors can occur after publication. Re-read the winner before
          // returning failure, never rotate again merely because saving threw.
          let current = await store.read();
          if (!current) throw new HumanSessionError("human_session_missing", "not logged in; run cswarm login");
          try { current = await reconcileSuccessor(store, current); } catch { /* Preserve original error. */ }
          options.signal?.throwIfAborted();
          if (!sameCredential(current, before)) {
            if (options.userId !== undefined && (current.userId !== options.userId || current.deviceId !== options.deviceId)) {
              throw transientSession(operationId, current.generation, "identity");
            }
            const cached = cachedCredential(current, (await store.readProfile()).humanSession, options.rejectedAccessToken);
            if (cached) return cached;
            continue;
          }
          if (error instanceof HumanSessionError) throw error;
          throw transientSession(operationId, current.generation, "storage");
        }
      }
      throw transientSession(operationId, undefined, "winner");
    }, { signal: options.signal });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      // A winner may have saved just as our lock wait expired. This read never
      // mutates or adopts a journal outside the shared lock.
      const current = await store.read();
      if (current && (options.userId === undefined || current.userId === options.userId && current.deviceId === options.deviceId)) {
        const cached = cachedCredential(current, (await store.readProfile()).humanSession, options.rejectedAccessToken);
        if (cached) return cached;
      }
      throw new HumanSessionError("human_session_transient",
        `Could not confirm your session because ${error.message} Your credential was kept (reference ${operationId}).`,
        operationId, current?.generation, "lock");
    }
    throw error;
  }
}

/** Bound human transport. Only explicit replayable API routes receive the token;
 * unknown routes/stream bodies and policy refusals never trigger a refresh. */
export function humanSessionFetch(target: CloudTarget, store: CredentialStore,
  initial: RefreshedCredential, fetcher: typeof fetch = fetch): typeof fetch {
  let current = initial;
  const ownedTokens = new Set([initial.accessToken]);
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const authorization = headers.get("authorization");
    const ownsBearer = authorization !== null && ownedTokens.has(authorization.replace(/^Bearer /, ""));
    const sameOrigin = url.origin === new URL(target.url).origin && !url.username && !url.password;
    if (ownsBearer && !sameOrigin) throw transientSession(randomUUID(), undefined, "origin");
    if (!ownsBearer) return await fetcher(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = init?.body;
    const command = url.pathname === new URL(commandEndpoint(target)).pathname && method === "POST" && typeof body === "string";
    let hasCommandId = false;
    if (command) {
      try { hasCommandId = typeof JSON.parse(body).command_id === "string"; } catch { /* No replay. */ }
    }
    const safeRead = method === "GET" && body === undefined &&
      (url.pathname.startsWith("/rest/v1/") || url.pathname === "/functions/v1/read");
    const readPost = method === "POST" && url.pathname === "/functions/v1/read" && typeof body === "string";
    const replayable = !(input instanceof Request) && (safeRead || readPost || command && hasCommandId);
    const sentAccessToken = current.accessToken;
    headers.set("authorization", `Bearer ${sentAccessToken}`);
    const requestId = headers.get("x-request-id") ?? randomUUID();
    headers.set("x-request-id", requestId);
    const requestInit = { ...init, headers, redirect: "error" as const };
    const response = await fetcher(input, requestInit);
    if (response.status !== 401 || !replayable || init?.signal?.aborted) return response;
    const refusal = await response.clone().json().catch(() => null) as { error?: unknown; code?: unknown } | null;
    const code = typeof refusal?.error === "string" ? refusal.error : refusal?.code;
    if (typeof code !== "string" || !new Set(["unauthenticated", "invalid_jwt", "jwt_expired", "PGRST301", "PGRST303"]).has(code)) return response;
    const rejectedAccessToken = sentAccessToken;
    const next = await refreshedCredential(target, store, { rejectedAccessToken, requestId, signal: init?.signal,
      userId: initial.userId, deviceId: initial.deviceId });
    if (next.userId !== initial.userId || next.deviceId !== initial.deviceId) throw transientSession(requestId, undefined, "identity");
    current = next;
    ownedTokens.add(next.accessToken);
    headers.set("authorization", `Bearer ${next.accessToken}`);
    return await fetcher(input, requestInit);
  }) as typeof fetch;
}

/** Server confirmation revokes refresh handles. Previously issued access JWTs
 * retain their server-defined lifetime; copy must not claim otherwise. */
export type LogoutOutcome =
  | "already-logged-out"
  | "revoked"
  | "local-only"
  | "cleared-unverified";

export function logoutMessage(
  outcome: LogoutOutcome,
  allDevices: boolean,
): string {
  switch (outcome) {
    case "already-logged-out":
      return "Already logged out.\n";
    case "cleared-unverified":
      return "Cleared this device. The server was not contacted, so any session it still " +
        "holds is unchanged — sign in and run cswarm logout --all-devices if you need it revoked.\n";
    case "local-only":
      // States the OBSERVATION, not a cause. This fires for all four terminal codes, and
      // only session_expired is expiry; after refresh_token_already_used a live session may
      // exist elsewhere, so "nothing to revoke" is true of THIS handle and not the identity.
      return "Signed out on this device. The server no longer accepts this credential, so " +
        "there was nothing this device could revoke; other devices are unaffected.\n";
    case "revoked":
      return allDevices
        // NOT "Signed out on all devices" (Plumb). That is the same account-wide completion
        // claim in different words: the endpoint revokes refresh tokens, and already-issued
        // access JWTs can still authorize a device until they expire. What is true is that
        // THIS device is signed out and the account-wide request was accepted.
        ? "Signed out on this device. The server confirmed the account-wide sign-out.\n"
        : "Signed out on this device. The server confirmed it; other machines stay signed " +
          "in so collaborators are not disrupted.\n";
  }
}

/** Auth codes that mean this refresh token can never work again.
 *
 * CLOSED allowlist on purpose: anything not listed -- transient, rate-limited, or simply
 * unrecognised -- RETAINS the credential. Deleting is irreversible, so the default has to be
 * the reversible side. Measured shapes: a modern `400 refresh_token_not_found` carries
 * `code`, while a legacy `400 invalid_grant` carries none, which is why the escape hatch
 * below exists rather than a looser rule here. */
const TERMINAL_REFRESH_CODES: ReadonlySet<string> = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
]);

export async function logout(
  target: CloudTarget,
  store: CredentialStore,
  scope: "local" | "global" = "local",
  options: { localOnly?: boolean } = {},
): Promise<LogoutOutcome> {
  return await store.withLock(async () => {
    let record = await store.read();
    if (!record) {
      const profile = await store.readProfile();
      delete profile.humanSession;
      await store.writeProfile(profile);
      return "already-logged-out";
    }
    if (options.localOnly) {
      await store.delete();
      return "cleared-unverified";
    }
    const operationId = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      record = await store.read();
      if (!record) return "already-logged-out";
      record = await reconcileSuccessor(store, record);
      const refreshed = await refreshHumanSession(target, store, record, operationId);
      if (!sameCredential(await store.read(), record)) continue;
      if (!refreshed.session) {
        const reconciled = await reconcileSuccessor(store, record);
        if (!sameCredential(reconciled, record)) continue;
        if (!sameCredential(await store.read(), record)) continue;
        if (!refreshed.code || !TERMINAL_REFRESH_CODES.has(refreshed.code)) {
          throw new Error(
            "could not confirm the session with the server, so your credential was kept; " +
              "check your connection and run cswarm logout again, " +
              "or run cswarm logout --local to clear this device without contacting the server",
          );
        }
        await store.delete();
        return "local-only";
      }
      // Journal and verify the rotated handle before requesting server revocation.
      const session = refreshed.session;
      const successor = await saveSuccessor(store, record, session, operationId);
      const signedOut = await fetch(new URL(`/auth/v1/logout?scope=${scope}`, target.url), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${session.access_token}`, apikey: target.anonKey, "x-request-id": operationId },
      }).then(response => response.ok).catch(() => false);
      if (!signedOut) {
        throw new Error(
          "signed in, but the server did not confirm the session ended; your credential was " +
            "kept — run cswarm logout again, or run cswarm logout --local to clear this device " +
            "without contacting the server",
        );
      }
      if (!sameCredential(await store.read(), successor)) throw transientSession(operationId, successor.generation, "logout-winner");
      await store.delete();
      return "revoked";
    }
    throw transientSession(operationId, record?.generation, "logout-winner");
  });
}
