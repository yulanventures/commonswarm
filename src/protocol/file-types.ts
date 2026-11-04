/** Upload file names: the extension decides the declared content type. Shared by the CLI
 * (`cswarm file put`) and the hosted MCP's file_put; the server re-checks the pair against its
 * own allowlist (fileContentAllowed in supabase/functions/command/file-artifacts.ts). Pure. */

export const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  // .html/.htm: a web/marketing team's deliverables (Fastio feedback 2026-08-19). Every
  // download is served Content-Disposition: attachment (§5), never rendered inline, so HTML
  // is no more dangerous than the .svg already permitted — the spec treats all downloads as
  // untrusted attachments the consumer must not execute.
  [".html", "text/html"],
  [".htm", "text/html"],
  [".json", "application/json"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".zip", "application/zip"],
  [".tar.gz", "application/gzip"],
]);

export function contentTypeForName(name: string): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestLength = 0;
  for (const [extension, type] of CONTENT_TYPES) {
    if (lower.endsWith(extension) && extension.length > bestLength) {
      best = type;
      bestLength = extension.length;
    }
  }
  return best;
}

export function allowedExtensionList(): string {
  return [...CONTENT_TYPES.keys()].join(", ");
}

