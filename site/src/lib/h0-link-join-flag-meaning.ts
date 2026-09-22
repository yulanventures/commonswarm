export interface ShownJoinInvite {
  inviteId: string | null;
  joinActive: boolean;
  prompt: string | null;
}

export interface ConcealedJoinInvite {
  paste: string | null;
  inviteId: string;
}

/** Drop the paste. The id stays so the page can still revoke. */
export function concealJoinInvite(secret: {
  paste: string | null;
  inviteId: string;
}): ConcealedJoinInvite {
  return { paste: null, inviteId: secret.inviteId };
}

/**
 * Done clears the invite. A revoke result that arrives later must see
 * inviteId null and leave this state alone.
 */
export function dismissShownJoin(shown: ShownJoinInvite): ShownJoinInvite {
  const hidden = shown.joinActive
    ? concealJoinInvite({ paste: shown.prompt, inviteId: shown.inviteId ?? "" })
    : null;
  return {
    inviteId: null,
    joinActive: false,
    prompt: hidden === null ? shown.prompt : hidden.paste,
  };
}

/**
 * A revoke result applies only when revokedInviteId is still the invite on screen.
 * Returns null when Done has already cleared it, or when a different invite is shown.
 * The caller must not write join state when this returns null.
 */
export function shownJoinAfterRevoke(
  shown: ShownJoinInvite,
  revokedInviteId: string,
): ShownJoinInvite | null {
  if (shown.inviteId !== revokedInviteId) return null;
  const hidden = concealJoinInvite({
    paste: shown.prompt,
    inviteId: shown.inviteId,
  });
  return {
    inviteId: hidden.inviteId,
    joinActive: true,
    prompt: hidden.paste,
  };
}
