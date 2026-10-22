import { personFirstName } from "./home-names";

/** Only the greeting uses email's local part; account and onboarding identity stay unchanged. */
export function greetingName(
  user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined,
  confirmedViewerName?: string | null,
): string {
  const meta = user?.user_metadata ?? {};
  for (const candidate of [confirmedViewerName, meta.full_name, meta.name, meta.user_name, meta.preferred_username]) {
    if (typeof candidate !== "string") continue;
    const first = personFirstName(candidate);
    if (first) return first;
  }
  const email = user?.email?.trim() || confirmedViewerName?.trim() || "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at).trim() || "there" : "there";
}
