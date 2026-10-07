// Immutable protocol fixtures from reviewed repository history, independent of
// the producer's catalog derivation. No tools/list discovery supplies expectations.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const baselineEdgeSha = 'b0cbaef580e1e4aeb27fcf4ef15268e39cce0218';
export const earlierEdgeSha = '7bb2842032fd60e20d78cee4d6d44b3a517297b1';
export const releaseSha = '1388b0ee73b76de111f9fabf196ed916566c37fd';
const repo = fileURLToPath(new URL('../../', import.meta.url));
export async function catalogAt(sha, ordinary) {
  const bytes = execFileSync('git', ['-C', repo, 'show', `${sha}:supabase/functions/_shared/protocol.js`]);
  const protocol = await import(`data:text/javascript;base64,${bytes.toString('base64')}`);
  const hosted = (protocol.HOUSEHOLD_TOOLS ?? []).filter(tool =>
    !protocol.HOUSEHOLD_TOOL_REGISTRY.find(row => row.name === tool.name).objectTypes.every(kind => kind === 'file'));
  return { protocol, names: [...ordinary, ...hosted.map(tool => tool.name)] };
}
