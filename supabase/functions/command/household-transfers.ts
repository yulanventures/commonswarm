/** Protected attachment/stream transport. Never return a Storage credential or
 * signed URL to the model. The command adapter rechecks rights at every use.
 * Lane 4 supplies FILE_BUCKET and the service credential from its existing path.
 */
import type { HouseholdBlob, HouseholdContent } from '../_shared/household-object-events.d.ts';

export interface HouseholdStorage {
  putImmutable(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string, maximumBytes: number): Promise<Uint8Array | null>;
}

export class HouseholdTransferError extends Error {
  constructor(readonly code: 'storage_unavailable' | 'access_refused' | 'bytes_missing' | 'bytes_mismatch' | 'content_invalid' | 'transfer_too_large') {
    super(code);
    this.name = 'HouseholdTransferError';
  }
}

export async function householdSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable request and list/doc encoding; no content goes into event envelopes. */
export function householdCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new HouseholdTransferError('content_invalid');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(householdCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${householdCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function householdContentBytes(content: HouseholdContent): Uint8Array {
  if (content.kind === 'file') throw new HouseholdTransferError('content_invalid');
  return new TextEncoder().encode(householdCanonical(content));
}

export async function verifiedHouseholdBytes(storage: HouseholdStorage, blob: HouseholdBlob): Promise<Uint8Array> {
  const bytes = await storage.read(blob.storage_key, blob.size_bytes);
  if (bytes === null) throw new HouseholdTransferError('bytes_missing');
  if (bytes.byteLength !== blob.size_bytes || await householdSha256(bytes) !== blob.sha256) {
    throw new HouseholdTransferError('bytes_mismatch');
  }
  return bytes;
}

export function decodeHouseholdContent(bytes: Uint8Array, kind: 'list' | 'doc'): HouseholdContent {
  try {
    const content: HouseholdContent = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (content?.kind !== kind || householdCanonical(content) !== new TextDecoder().decode(bytes)) {
      throw new HouseholdTransferError('content_invalid');
    }
    return content;
  } catch {
    throw new HouseholdTransferError('content_invalid');
  }
}

/** Server-owned endpoint and key only. The factory is called by the trusted
 * host, never with fields from a model request. Redirects fail closed. */
export function createHouseholdTransferStorage(options: {
  storageBaseUrl: string;
  bucket: string;
  serviceCredential: string;
  fetcher?: typeof fetch;
}): HouseholdStorage {
  const base = new URL(options.storageBaseUrl);
  if (base.username || base.password || base.search || base.hash || !['http:', 'https:'].includes(base.protocol)) {
    throw new HouseholdTransferError('storage_unavailable');
  }
  const fetcher = options.fetcher ?? fetch;
  const url = (path: string, authenticated: boolean): string => {
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(path)) throw new HouseholdTransferError('content_invalid');
    return `${base.toString().replace(/\/$/, '')}/object/${authenticated ? 'authenticated/' : ''}${encodeURIComponent(options.bucket)}/${path}`;
  };
  const headers = () => ({ Authorization: `Bearer ${options.serviceCredential}`, apikey: options.serviceCredential });
  return {
    async putImmutable(path, bytes) {
      let response: Response;
      try {
        response = await fetcher(url(path, false), { method: 'POST', redirect: 'error',
          headers: { ...headers(), 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: new Uint8Array(bytes) });
      } catch { throw new HouseholdTransferError('storage_unavailable'); }
      await response.body?.cancel();
      if (!response.ok) throw new HouseholdTransferError('storage_unavailable');
    },
    async read(path, maximumBytes) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new HouseholdTransferError('transfer_too_large');
      let response: Response;
      try {
        response = await fetcher(url(path, true), { redirect: 'error', headers: headers() });
      } catch { throw new HouseholdTransferError('storage_unavailable'); }
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new HouseholdTransferError('storage_unavailable'); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maximumBytes) throw new HouseholdTransferError('transfer_too_large');
          chunks.push(part.value);
        }
      } catch (error) {
        if (error instanceof HouseholdTransferError) throw error;
        throw new HouseholdTransferError('storage_unavailable');
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    },
  };
}
