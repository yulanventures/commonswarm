import { createHash } from "node:crypto";
import { lstat, realpath, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cloudTarget, type CloudTarget } from "./config.js";
import { parseAgentCredentialInput, type AgentCredentialInput } from "./agent-credential-input.js";
import { agentCredentialStore, credentialLineageKey } from "./agent-credential.js";
import { AgentCredentialSession } from "./renewal.js";
import { assertLocalSessionBinding, defaultSessionContextPath, listSessionContexts, sessionProofOf } from "./session-context.js";
import { readSecureJsonFileIfPresent, writeSecureJsonFile, withFileLock } from "./storage.js";
import {
  AGENT_CONNECTION_FIELDS, AGENT_CONNECTION_VERSION,
  type AgentConnectionEnvelope,
  AgentSetupError,
  ONBOARDING_UUID,
} from "./agent-onboarding-contract.js";
import {
  isAgentConnectionToken,
  decodeAgentConnectionToken,
  encodeAgentConnectionToken,
} from "./agent-connection-token.js";


export const ONBOARDING_MAX_FILE_BYTES = 16 * 1024;

export { AgentSetupError, ONBOARDING_UUID };

export interface AgentProfile {
  version: 1;
  url: string;
  anon_key: string;
  workspace_id: string;
  principal_id: string;
  credential_file: string;
  /**
   * The workspace's human name at the time setup ran, so a person reading this file can tell
   * WHICH workspace it points at without resolving a uuid.
   *
   * OPTIONAL, and it must stay optional. The check below compares the key set exactly, so
   * requiring this would declare every profile written before 0.1.71 "damaged" — on every host
   * in the fleet at once. It is also a CACHE, not the authority: a workspace can be renamed
   * after setup, so anything asserting the current name reads it from the server.
   */
  workspace_name?: string;
  host_session_id?: string;
}

/** Refuse a bound profile before any credential, cache, or network access. */
export function requireProfileHost(profile: AgentProfile, hostSessionId?: string): void {
  if (profile.host_session_id === undefined) return;
  if (hostSessionId === undefined) {
    throw new AgentSetupError("host_session_required", "This profile is bound to a host session. Pass --host-session-id with this session's id.");
  }
  if (hostSessionId !== profile.host_session_id) {
    throw new AgentSetupError("profile_other_session", "This profile belongs to another session. Stop and tell the operator.");
  }
}

export function privatePath(path: string): string {
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new AgentSetupError("profile_path_invalid", profilePathRemedy());
  }
  return resolve(path);
}

export function profilePathRemedy(): string {
  const example = agentProfilePath("<deployment>", "<workspace-id>", "<principal-id>", "~/.cswarm");
  return `Use an absolute private file path outside a repository, for example ${example}. Run cswarm profile ls to find saved profiles.`;
}

/** Check each existing ancestor, including repos reached through an ancestor symlink. */
export async function assertPrivateLocation(path: string): Promise<string> {
  const absolute = privatePath(path);
  let current = dirname(absolute);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        // macOS /tmp and /var are system aliases. Resolve them, then inspect the real tree.
        const resolved = await realpath(current);
        if (current !== "/tmp" && current !== "/var") {
          throw new AgentSetupError("profile_symlink", "A private state path must not pass through a symlink.");
        }
        await assertPrivateLocation(join(resolved, "probe"));
      }
      try {
        await lstat(join(current, ".git"));
        throw new AgentSetupError("profile_inside_repository", "Keep the connection file and agent profile outside repositories.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

export { isAgentConnectionToken, decodeAgentConnectionToken, encodeAgentConnectionToken };

export function parseAgentConnection(raw: string): AgentConnectionEnvelope {
  if (isAgentConnectionToken(raw)) {
    return decodeAgentConnectionToken(raw);
  }
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch {
    throw new AgentSetupError("connection_invalid", raw.includes("\\_") || /^\s*```/.test(raw)
      ? "The connection file appears to contain Markdown formatting. Use ‘Use a setup file’ in CommonSwarm and run setup with that file. Do not edit credentials or paste them into chat."
      : "The connection file is not valid JSON. Use ‘Use a setup file’ in CommonSwarm and run setup with that file. Do not paste its contents into chat.");
  }
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      value.version !== AGENT_CONNECTION_VERSION ||
      Object.keys(value).length !== AGENT_CONNECTION_FIELDS.length ||
      AGENT_CONNECTION_FIELDS.some(key => !Object.hasOwn(value, key)) ||
      typeof value.url !== "string" || typeof value.anon_key !== "string" ||
      typeof value.workspace_id !== "string" || !ONBOARDING_UUID.test(value.workspace_id) ||
      typeof value.principal_id !== "string" || !ONBOARDING_UUID.test(value.principal_id) ||
      !value.credential || typeof value.credential !== "object" || Array.isArray(value.credential)) {
    throw new AgentSetupError("connection_invalid", `Expected connection version ${AGENT_CONNECTION_VERSION} with fields: ${AGENT_CONNECTION_FIELDS.join(", ")}. Save the supplied file unchanged.`);
  }
  if (/^\s*\[[\s\S]*\]\(/.test(value.url)) {
    throw new AgentSetupError("connection_target_invalid", "The connection URL appears to be a Markdown link. Use ‘Use a setup file’ in CommonSwarm and run setup with that file. Do not edit credentials or paste them into chat.");
  }
  const target = checkedTarget(value.url, value.anon_key);
  const agent = parseAgentCredentialInput(JSON.stringify(value.credential), { kind: "stdin" });
  if (!agent.durable || agent.principalId !== value.principal_id.toLowerCase()) {
    throw new AgentSetupError("connection_identity_mismatch", "The connection and credential name different agents. Ask for a new connection file.");
  }
  return {
    version: AGENT_CONNECTION_VERSION, url: target.url, anon_key: target.anonKey,
    workspace_id: value.workspace_id.toLowerCase(), principal_id: agent.principalId,
    credential: value.credential as Record<string, unknown>,
  };
}

function checkedTarget(url: string, anonKey: string): CloudTarget {
  try {
    const target = cloudTarget(url, anonKey);
    const parsed = new URL(target.url);
    if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error();
    if (anonKey.length > 4096 || /[\u0000-\u0020\u007f]/.test(anonKey)) throw new Error();
    return target;
  } catch {
    throw new AgentSetupError("connection_target_invalid", "Use an HTTPS deployment origin and its public key. HTTP is allowed only for local tests.");
  }
}

export function defaultAgentProfilePath(connection: Pick<AgentProfile, "url" | "anon_key" | "workspace_id" | "principal_id">): string {
  const target = checkedTarget(connection.url, connection.anon_key);
  return agentProfilePath(target.profileId, connection.workspace_id, connection.principal_id);
}

export function agentProfilePath(deployment: string, workspace: string, principal: string, root = agentProfileRoot()): string {
  return join(root, "agents", deployment, workspace, principal, "profile.json");
}

/** Shared root for automatic setup and MCP connect profiles. Explicit paths under this root are included too. */
export function agentProfileRoot(): string {
  return join(homedir(), ".cswarm");
}

const PROFILE_REGISTRY = "profile-paths.json";
const PROFILE_REGISTRY_MAX_BYTES = 1024 * 1024;

async function registeredProfilePaths(root: string): Promise<string[]> {
  const raw = await readSecureJsonFileIfPresent(join(root, PROFILE_REGISTRY), PROFILE_REGISTRY_MAX_BYTES);
  if (raw === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new AgentSetupError("profile_registry_invalid", "The saved profile inventory is damaged.");
  }
  if (!Array.isArray(parsed) || parsed.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new AgentSetupError("profile_registry_invalid", "The saved profile inventory is damaged.");
  }
  return parsed;
}

export interface ListedAgentProfile {
  path: string;
  principal_id?: string;
  principal_name?: string;
  workspace_id?: string;
  workspace_name?: string;
  url_host?: string;
  error?: string;
}

/** Inspect profile.json files only; credentials are never opened. Symlinked directories are skipped. */
export async function listAgentProfiles(): Promise<{ searched_roots: string[]; profiles: ListedAgentProfile[] }> {
  const root = agentProfileRoot();
  let registered: string[] = [];
  const failures: ListedAgentProfile[] = [];
  try { registered = await registeredProfilePaths(root); }
  catch { failures.push({ path: join(root, PROFILE_REGISTRY), error: "profile_registry_invalid" }); }
  const paths = new Set(registered);
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && directory === root) return;
      failures.push({ path: directory, error: code === "ENOENT" ? "directory_missing" : "directory_unreadable" });
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "profile.json") paths.add(path);
    }
  };
  await walk(root);
  const profiles: ListedAgentProfile[] = [...failures];
  for (const path of [...paths].sort()) {
    try {
      const profile = await readAgentProfile(path, undefined, true);
      profiles.push({ path, principal_id: profile.principal_id, workspace_id: profile.workspace_id,
        ...(profile.workspace_name ? { workspace_name: profile.workspace_name } : {}),
        url_host: new URL(profile.url).host });
    } catch (error) {
      profiles.push({ path, error: error instanceof AgentSetupError ? error.code : "profile_unreadable" });
    }
  }
  return { searched_roots: [root], profiles };
}

export async function readAgentProfile(path: string, hostSessionId?: string, listing = false): Promise<AgentProfile> {
  path = await assertPrivateLocation(path);
  const raw = await readSecureJsonFileIfPresent(path, ONBOARDING_MAX_FILE_BYTES);
  if (raw === null) throw new AgentSetupError("profile_missing", "The agent profile is missing. Run cswarm setup with the connection file.");
  let p: AgentProfile;
  try { p = JSON.parse(raw); } catch { throw new AgentSetupError("profile_invalid", "The agent profile is damaged. Run setup again."); }
  /* Exactly the required keys, optionally plus workspace_name and host_session_id. Written as accepted sets
   * rather than a subset test, so an unknown key is still a damaged profile. */
  const required = ["version", "url", "anon_key", "workspace_id", "principal_id", "credential_file"];
  const keys = Object.keys(p ?? {}).sort().join();
  const keysAccepted = keys === [...required].sort().join() ||
    keys === [...required, "workspace_name"].sort().join() ||
    keys === [...required, "host_session_id"].sort().join() ||
    keys === [...required, "workspace_name", "host_session_id"].sort().join();
  if (!p || p.version !== 1 || !keysAccepted ||
      (p.host_session_id !== undefined &&
        (typeof p.host_session_id !== "string" || p.host_session_id.length < 1 || p.host_session_id.length > 200)) ||
      (p.workspace_name !== undefined &&
        (typeof p.workspace_name !== "string" || p.workspace_name.length > 200)) ||
      typeof p.url !== "string" || typeof p.anon_key !== "string" ||
      typeof p.workspace_id !== "string" || !ONBOARDING_UUID.test(p.workspace_id) ||
      typeof p.principal_id !== "string" || !ONBOARDING_UUID.test(p.principal_id) ||
      p.credential_file !== join(dirname(path), "credential.json")) {
    throw new AgentSetupError("profile_invalid", "The agent profile is damaged. Run setup again.");
  }
  checkedTarget(p.url, p.anon_key);
  if (!listing) requireProfileHost(p, hostSessionId);
  return p;
}

export async function readProfileCredential(profile: AgentProfile): Promise<AgentCredentialInput> {
  const raw = await readSecureJsonFileIfPresent(profile.credential_file, ONBOARDING_MAX_FILE_BYTES);
  if (raw === null) throw new AgentSetupError("profile_credential_missing", "The profile credential is missing. Run setup again.");
  const agent = parseAgentCredentialInput(raw, { kind: "file", path: profile.credential_file });
  if (agent.principalId !== profile.principal_id) throw new AgentSetupError("profile_identity_mismatch", "The saved credential belongs to a different agent. Run setup again.");
  return agent;
}

export async function openProfileCredential(profile: AgentProfile, fetcher: typeof fetch = fetch): Promise<AgentCredentialSession> {
  const agent = await readProfileCredential(profile);
  const target = checkedTarget(profile.url, profile.anon_key);
  const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(agent.token) });
  return AgentCredentialSession.open({ target, workspaceId: profile.workspace_id, presented: agent, store, fetcher });
}

export async function saveAgentProfile(path: string, connection: AgentConnectionEnvelope, workspaceName?: string, hostSessionId?: string, refuseExisting = false, registryWrite = writeSecureJsonFile): Promise<AgentProfile> {
  path = await assertPrivateLocation(path);
  const profile: AgentProfile = {
    version: 1, url: connection.url, anon_key: connection.anon_key,
    workspace_id: connection.workspace_id, principal_id: connection.principal_id,
    credential_file: join(dirname(path), "credential.json"),
    /* Only when the server actually gave one. The key is omitted rather than written null, so
     * a profile from a deployment that does not send the name keeps exactly the six keys every
     * released client already accepts. */
    ...(workspaceName === undefined ? {} : { workspace_name: workspaceName }),
    ...(hostSessionId === undefined || hostSessionId === "manual" ? {} : { host_session_id: hostSessionId }),
  };
  await withFileLock(dirname(path), "setup", async () => {
    const existingRaw = await readSecureJsonFileIfPresent(path, ONBOARDING_MAX_FILE_BYTES);
    if (existingRaw !== null) {
      if (refuseExisting) throw new AgentSetupError("profile_exists", "This profile path already holds a connection. Choose a new profile path.");
      const existing = await readAgentProfile(path, hostSessionId);
      if (existing.url !== profile.url || existing.workspace_id !== profile.workspace_id || existing.principal_id !== profile.principal_id) {
        throw new AgentSetupError("profile_conflict", "This profile belongs to another workspace or agent. Use a different profile path.");
      }
    }
    if (refuseExisting && await readSecureJsonFileIfPresent(profile.credential_file, ONBOARDING_MAX_FILE_BYTES) !== null) {
      throw new AgentSetupError("profile_exists", "This profile path already holds a connection. Choose a new profile path.");
    }
    await writeSecureJsonFile(profile.credential_file, JSON.stringify(connection.credential));
    await writeSecureJsonFile(path, JSON.stringify(profile));
  });
  const root = agentProfileRoot();
  let movedRegistry: string | undefined;
  try {
    await withFileLock(root, "profile-registry", async () => {
      let paths: string[];
      try { paths = await registeredProfilePaths(root); }
      catch (error) {
        if (!(error instanceof AgentSetupError) || error.code !== "profile_registry_invalid") throw error;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        movedRegistry = join(root, `${PROFILE_REGISTRY}.damaged-${stamp}`);
        await rename(join(root, PROFILE_REGISTRY), movedRegistry);
        paths = [];
      }
      if (!paths.includes(path)) await registryWrite(join(root, PROFILE_REGISTRY), JSON.stringify([...paths, path]));
    });
    if (movedRegistry) process.stderr.write(`cswarm: Profile saved; damaged inventory moved to ~/.cswarm/${movedRegistry.split("/").at(-1)} and rebuilt.\n`);
  } catch {
    let modeCause = false;
    let symlinkCause = false;
    try {
      const stat = await lstat(root);
      modeCause = (stat.mode & 0o777) !== 0o700;
      symlinkCause = stat.isSymbolicLink();
    } catch { /* The inventory is optional. */ }
    process.stderr.write(modeCause
      ? symlinkCause ? "cswarm: Profile saved; inventory unavailable. ~/.cswarm must be a real private directory.\n" : "cswarm: Profile saved; inventory unavailable. Run chmod 700 ~/.cswarm to enable it.\n"
      : `cswarm: Profile saved; inventory unavailable.${movedRegistry ? ` Damaged inventory moved to ~/.cswarm/${movedRegistry.split("/").at(-1)}.` : ""} Run cswarm profile ls to inspect saved profiles.\n`);
  }
  return profile;
}

export function profileScopeKey(hostSessionId?: string): string {
  return hostSessionId === undefined ? "manual" : createHash("sha256").update(hostSessionId).digest("hex");
}

export function profileTarget(profile: AgentProfile): CloudTarget {
  return checkedTarget(profile.url, profile.anon_key);
}

/** A supplied host ID may select its own managed proof; never take another session's proof. */
export async function profileSessionContext(profile: AgentProfile, hostSessionId?: string) {
  if (hostSessionId === undefined || hostSessionId === "manual") return null;
  const contexts = (await listSessionContexts(profile.workspace_id, profile.principal_id)).filter(c => sessionProofOf(c) !== null);
  if (contexts.length === 0) return null;
  const matches = contexts.filter(c => c.host_session_id === hostSessionId);
  if (matches.length !== 1) throw new AgentSetupError("profile_session_conflict", "This agent has no single managed context for this host session. Check cswarm session status; do not use another session's context.");
  const context = matches[0]!;
  assertLocalSessionBinding(context, {
    target: profileTarget(profile), tokenPrincipalId: profile.principal_id,
    flagWorkspaceId: profile.workspace_id, tokenFile: profile.credential_file, hostSessionId,
  });
  return { context, path: defaultSessionContextPath(profile.workspace_id, profile.principal_id, context.session_id) };
}
