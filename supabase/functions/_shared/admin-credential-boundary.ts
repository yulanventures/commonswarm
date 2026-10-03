import { ADMIN_RESOURCE } from './protocol.js';

/** Denial-only classification. Unverified claims can refuse a credential, never
 * authenticate it or route it into an admin operation. All other credentials
 * still pass through the endpoint's existing authentication. */
export function isAdminCredential(value: string | null): boolean {
  if (value === null) return false;
  if (value.startsWith('swm_adm_') || value.startsWith('swm_adr_')) return true;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  // Bound denial parsing; oversized JWT-shaped input is also foreign input.
  if (value.length > 16 * 1024) return true;
  const payload = parts[1]!;
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) return false;
  try {
    const bytes = atob(payload.replaceAll('-', '+').replaceAll('_', '/') +
      '='.repeat((4 - payload.length % 4) % 4));
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(bytes, character => character.charCodeAt(0)),
    ));
    return claims !== null && typeof claims === 'object' &&
      (claims.grant_class === 'delegated_admin' || claims.aud === ADMIN_RESOURCE ||
        Array.isArray(claims.aud) && claims.aud.includes(ADMIN_RESOURCE));
  } catch {
    return false;
  }
}

export function presentsAdminCredential(request: Request): boolean {
  const header = request.headers.get('authorization');
  return isAdminCredential(header === null ? null : /^(?:Bearer|DPoP) +([^\s,]+)$/iu.exec(header)?.[1] ?? null);
}
