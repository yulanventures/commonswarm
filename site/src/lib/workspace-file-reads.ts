/** Read-only recovery scoped to the account and workspace that started it. */
export interface FileReadContext {
  workspaceId: string;
  session: object;
  generation: number;
}

const sameContext = (a: FileReadContext | null, b: FileReadContext): boolean =>
  !!a && a.workspaceId === b.workspaceId && a.session === b.session && a.generation === b.generation;

export function createFileListRetry<T>(current: () => FileReadContext | null, read: (workspaceId: string) => Promise<T>) {
  let pending: FileReadContext | null = null;
  return {
    isPending: () => !!pending && sameContext(current(), pending),
    async run(): Promise<{ kind: "success"; value: T } | { kind: "failure"; error: unknown } | { kind: "stale" | "busy" }> {
      const context = current();
      if (!context) return { kind: "stale" };
      if (pending && sameContext(pending, context)) return { kind: "busy" };
      pending = context;
      try {
        const value = await read(context.workspaceId);
        return sameContext(current(), context) ? { kind: "success", value } : { kind: "stale" };
      } catch (error) {
        return sameContext(current(), context) ? { kind: "failure", error } : { kind: "stale" };
      } finally {
        if (pending === context) pending = null;
      }
    },
  };
}

/** Bind the in-panel retry without disturbing other workspace state. */
export function bindFileListRetry<T>(options: {
  button: HTMLButtonElement;
  status: HTMLElement;
  retry: ReturnType<typeof createFileListRetry<T>>;
  hasError: () => boolean;
  apply: (result: { kind: "success"; value: T } | { kind: "failure"; error: unknown }) => void;
  render: () => void;
  isVisible: () => boolean;
  successFocus: HTMLElement;
}): { sync: () => void } {
  const { button, status, retry } = options;
  const sync = (): void => {
    const busy = retry.isPending();
    button.hidden = !options.hasError();
    button.disabled = busy;
    status.hidden = !busy;
    status.textContent = busy ? "Loading files…" : "";
  };
  button.addEventListener("click", async () => {
    if (!options.hasError() || retry.isPending()) return;
    const heldFocus = button.ownerDocument.activeElement === button;
    const pending = retry.run();
    sync();
    const result = await pending;
    if (result.kind === "busy" || result.kind === "stale") return;
    options.apply(result);
    options.render();
    const focused = button.ownerDocument.activeElement;
    if (heldFocus && options.isVisible() && (focused === button || focused === button.ownerDocument.body)) {
      (result.kind === "success" ? options.successFocus : button).focus();
    }
  });
  sync();
  return { sync };
}

/** Bound the entire selected Wiki version read, including the grant and body. */
export async function readWikiContent(
  grant: () => Promise<{ url: string }>,
  isCurrent: () => boolean,
): Promise<string> {
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(new Error("This page took too long to load. Try again."));
    }, 15_000);
  });
  const read = async (): Promise<string> => {
    const result = await grant();
    if (expired || !isCurrent()) throw new Error("This page is no longer selected.");
    const response = await fetch(result.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Topic download failed (HTTP ${response.status}).`);
    const content = await response.text();
    if (expired || !isCurrent()) throw new Error("This page is no longer selected.");
    return content;
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
