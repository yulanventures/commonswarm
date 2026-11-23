import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export const SAFE_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const DEFAULT_BASE_ENV_ALLOWLIST = ["HOME", "LANG", "TMPDIR"] as const;

const FORBIDDEN_ENV_NAME = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|SWARM|CSWARM)/i;
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_OTHER_WRITE_MASK = 0o022;
const EXEC_BIT_MASK = 0o111;

export type LaunchErrorCode =
  | "invalid_executable"
  | "executable_not_found"
  | "executable_not_regular"
  | "executable_untrusted_owner"
  | "executable_writable"
  | "executable_not_executable"
  | "invalid_cwd"
  | "invalid_args"
  | "invalid_env_name"
  | "forbidden_env_name"
  | "invalid_env_value";

export class LaunchError extends Error {
  readonly code: LaunchErrorCode;

  constructor(code: LaunchErrorCode, message: string) {
    super(message);
    this.name = "LaunchError";
    this.code = code;
  }
}

export interface ConfigRootEnv {
  readonly name: string;
  readonly value: string;
}

export interface LaunchDescription {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly configRootEnv?: ConfigRootEnv;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface PrepareLaunchOptions {
  readonly baseAllowlist?: readonly string[];
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
}

export interface PreparedLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

function hasNullByte(value: string): boolean {
  return value.includes("\0");
}

function validateEnvName(name: string): void {
  if (typeof name !== "string" || !VALID_ENV_NAME.test(name)) {
    throw new LaunchError("invalid_env_name", "Invalid environment variable name");
  }
  if (name === "PATH") {
    throw new LaunchError("forbidden_env_name", "PATH cannot be overridden");
  }
  if (FORBIDDEN_ENV_NAME.test(name)) {
    throw new LaunchError("forbidden_env_name", "Forbidden environment variable name");
  }
}

function validateEnvValue(value: unknown): string {
  if (typeof value !== "string" || hasNullByte(value)) {
    throw new LaunchError("invalid_env_value", "Invalid environment variable value");
  }
  return value;
}

async function verifyExecutable(executable: string): Promise<string> {
  if (typeof executable !== "string" || executable.length === 0 || hasNullByte(executable) || !isAbsolute(executable)) {
    throw new LaunchError("invalid_executable", "Executable path must be absolute");
  }

  let resolved: string;
  try {
    resolved = await realpath(executable);
  } catch {
    throw new LaunchError("executable_not_found", "Executable could not be resolved");
  }

  if (!isAbsolute(resolved) || hasNullByte(resolved)) {
    throw new LaunchError("invalid_executable", "Resolved executable path must be absolute");
  }

  let st;
  try {
    st = await lstat(resolved);
  } catch {
    throw new LaunchError("executable_not_found", "Executable could not be inspected");
  }

  if (st.isSymbolicLink() || !st.isFile()) {
    throw new LaunchError("executable_not_regular", "Executable must be a regular file");
  }

  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (st.uid !== uid && st.uid !== 0) {
      throw new LaunchError("executable_untrusted_owner", "Executable must be owned by current user or root");
    }
  }

  if ((st.mode & GROUP_OTHER_WRITE_MASK) !== 0) {
    throw new LaunchError("executable_writable", "Executable must not be writable by group or others");
  }

  if ((st.mode & EXEC_BIT_MASK) === 0) {
    throw new LaunchError("executable_not_executable", "Executable file is not executable");
  }

  try {
    await access(resolved, constants.X_OK);
  } catch {
    throw new LaunchError("executable_not_executable", "Executable file is not executable");
  }

  return resolved;
}

async function verifyCwd(cwd: string): Promise<string> {
  if (typeof cwd !== "string" || cwd.length === 0 || hasNullByte(cwd) || !isAbsolute(cwd)) {
    throw new LaunchError("invalid_cwd", "Working directory must be an absolute path");
  }
  let st;
  try {
    st = await stat(cwd);
  } catch {
    throw new LaunchError("invalid_cwd", "Working directory does not exist");
  }
  if (!st.isDirectory()) {
    throw new LaunchError("invalid_cwd", "Working directory must be a directory");
  }
  return cwd;
}

function buildSafePath(resolvedExecutable: string): string {
  const execDir = dirname(resolvedExecutable);
  const parts = SAFE_SYSTEM_PATH.split(":");
  if (parts.includes(execDir)) {
    return SAFE_SYSTEM_PATH;
  }
  return `${SAFE_SYSTEM_PATH}:${execDir}`;
}

export async function prepareLaunch(
  description: LaunchDescription,
  options: PrepareLaunchOptions = {},
): Promise<PreparedLaunch> {
  if (!Array.isArray(description.args)) {
    throw new LaunchError("invalid_args", "Arguments must be an array");
  }
  const args: string[] = [];
  for (const arg of description.args) {
    if (typeof arg !== "string" || hasNullByte(arg)) {
      throw new LaunchError("invalid_args", "Arguments must be strings without null bytes");
    }
    args.push(arg);
  }

  const resolvedExecutable = await verifyExecutable(description.executable);
  const cwd = await verifyCwd(description.cwd);

  const allowlist = options.baseAllowlist ?? DEFAULT_BASE_ENV_ALLOWLIST;
  const parentEnv = options.parentEnv ?? process.env;

  const env: Record<string, string> = {
    PATH: buildSafePath(resolvedExecutable),
  };

  for (const name of allowlist) {
    validateEnvName(name);
    if (Object.prototype.hasOwnProperty.call(parentEnv, name)) {
      const value = parentEnv[name];
      if (typeof value === "string") {
        env[name] = validateEnvValue(value);
      }
    }
  }

  if (description.configRootEnv !== undefined) {
    validateEnvName(description.configRootEnv.name);
    env[description.configRootEnv.name] = validateEnvValue(description.configRootEnv.value);
  }

  if (description.extraEnv !== undefined) {
    for (const [name, value] of Object.entries(description.extraEnv)) {
      validateEnvName(name);
      env[name] = validateEnvValue(value);
    }
  }

  return {
    executable: resolvedExecutable,
    args,
    cwd,
    env,
  };
}
