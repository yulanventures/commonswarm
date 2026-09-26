import { readFileSync } from "node:fs";

// Injected by scripts/build-release.sh via esbuild --define. Keep this legacy
// identifier: release and npm bundles both replace it at build time.
declare const __COSWARM_VERSION__: string;

function packageVersion(): string {
  if (typeof __COSWARM_VERSION__ === "string" && __COSWARM_VERSION__.length > 0) {
    return __COSWARM_VERSION__;
  }
  try {
    const value = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const version = value.version;
    if (typeof version !== "string") return "unknown";
    return /^[\x20-\x7e]{1,64}$/.test(version) ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/** The build sent by every command and printed by the CLI. */
export const CLI_BUILD_VERSION = packageVersion();

/** Add the one canonical build field to a command envelope. */
export function withClientBuild<T extends Record<string, unknown>>(
  envelope: T,
): T & { client_build: string } {
  return { ...envelope, client_build: CLI_BUILD_VERSION };
}
