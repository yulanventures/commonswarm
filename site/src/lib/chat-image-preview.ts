const PREVIEW_CONTENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

export const canPreviewChatImage = (contentType: string): boolean =>
  PREVIEW_CONTENT_TYPES.has(contentType);

interface SignedPreviewUrl {
  url: string;
  /** Unix time in milliseconds. */
  expiresAt?: number;
}

const DEFAULT_LIFETIME_MS = 300_000;
const EXPIRY_MARGIN_MS = 30_000;

/** Only links with more than 30 seconds left can serve a later repaint. */
export class ChatImagePreviewCache {
  private readonly entries = new Map<string, Required<SignedPreviewUrl>>();

  get(fileId: string, version: number, now: number): string | undefined {
    const key = `${fileId}:${version}`;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt - now <= EXPIRY_MARGIN_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.url;
  }

  remember(fileId: string, version: number, signed: SignedPreviewUrl, signedAt: number): void {
    this.entries.set(`${fileId}:${version}`, {
      url: signed.url,
      expiresAt: signed.expiresAt ?? signedAt + DEFAULT_LIFETIME_MS,
    });
  }

  forget(fileId: string, version: number): void {
    this.entries.delete(`${fileId}:${version}`);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Each rendered image gets one new link after its first failed load. */
export const chatImagePreviewFailure = (previousFailures: number): "retry" | "unavailable" =>
  previousFailures === 0 ? "retry" : "unavailable";
