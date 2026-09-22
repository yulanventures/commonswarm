/** Anything other than the string "1" leaves the invite hidden. */
export function h0LinkJoinFlagEnabled(flag: string | undefined): boolean {
  return flag === "1";
}

export interface JoinInviteSecret {
  paste: string | null;
  joinCredentialId: string;
}

/** Drop the paste. The id stays so the page can still revoke. */
export function concealJoinInvite(secret: JoinInviteSecret): JoinInviteSecret {
  return { paste: null, joinCredentialId: secret.joinCredentialId };
}

/**
 * The handoff a person gets. The flag-off arm is today's prompt, byte for byte.
 * The flag-on arm is the join paste. Callers pass both and this picks one.
 */
export function selectAddAgentHandoff(
  enabled: boolean,
  todayPrompt: string,
  joinPaste: string,
): string {
  return enabled ? joinPaste : todayPrompt;
}
