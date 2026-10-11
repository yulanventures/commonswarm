// Vendor marks are not drawn here; under decision D1 they return one vendor at a time from approved files (site/public/brand/works-with/SOURCES.md).
export type ModelFamily = "claude" | "openai" | "gemini" | "grok";

/** Closed-default: mislabelling a family is worse than not knowing it (docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md). */
export function modelFamily(model: string | null | undefined): ModelFamily | null {
  if (model == null || model === "") return null;
  const needle = model.toLowerCase();
  if (needle.includes("claude") || needle.includes("anthropic")) return "claude";
  if (needle.includes("openai") || needle.includes("gpt") || needle.includes("codex")) {
    return "openai";
  }
  if (needle.includes("gemini") || needle.includes("google")) return "gemini";
  if (needle.includes("grok")) return "grok";
  return null;
}
