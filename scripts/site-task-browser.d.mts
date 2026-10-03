// Types for the plain-JavaScript task-browser controller (tests import its guards).
export declare const STATE_FILE: string;
export declare const EXIT_FILE: string;
export declare const SOCKET_FILE: string;
export declare const CONTROLLER_LOG: string;
export declare const BROWSER_LOG: string;
export declare const PROFILE_PATTERN: RegExp;
export declare class ControllerError extends Error {
  constructor(code: string, detail?: string);
  code: string;
}
export declare function validateStateDir(stateDir: string): string;
export declare function validateExecutable(executable: string, allowedRoot: string): string;
export declare function guardProfilePath(stateDir: string, profile: string): string;
export declare function removeProfile(stateDir: string, profile: string): "removed" | "absent";
export declare function readPrivateJson(path: string): unknown;
export declare function validateProbeUrl(url: string): string;
export declare function main(argv: string[]): Promise<number | null>;
