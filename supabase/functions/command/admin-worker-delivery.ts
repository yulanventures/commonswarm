import { isVerifiedAdminAdmission } from './admin-admission.ts';
import { type AdminAdmission } from '../_shared/admin-oauth-auth.ts';

// A worker bearer is a separate credential class. A protected runtime callback
// may deliver it only to the presenting, proof-bound connection. This capability
// is never parsed from an HTTP header/body or included in a tool result.
export interface AdminWorkerChannel { readonly connection_id: string }
const channels = new WeakMap<object, AdminAdmission>();
export function createAdminWorkerChannel(admission: AdminAdmission): AdminWorkerChannel {
  if (!isVerifiedAdminAdmission(admission)) throw new Error('verified_admin_request_required');
  const channel = Object.freeze({ connection_id: admission.token.connection_id });
  channels.set(channel, admission);
  return channel;
}
export function adminWorkerChannelConnection(channel: AdminWorkerChannel | undefined, admission: AdminAdmission): string | null {
  return channel && channels.get(channel) === admission ? channel.connection_id : null;
}
