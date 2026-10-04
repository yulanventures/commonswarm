import type { HumanInviteRef, HumanInviteCommand } from '../protocol/household-invitations.js';
import { HOUSEHOLD_JOIN_CONSENT_VERSION } from '../protocol/household-invitations.js';
export interface HumanInvitePreview { status: 'preview'; workspace_id: string; workspace_name: string; invitation_id: string;
  audience: { display_name: string; role: string }[]; disclosure: string; expires_at: number; preview_digest: string; consent_version: string }
export interface HumanInviteJoined { status: 'joined'; workspace_id: string; workspace_name: string; content_role: string | null; agents_provisioned_by_join: false }
export class HumanInviteRefused extends Error { constructor(public readonly reason: string) { super(reason); } }
export class HumanInviteUnknown extends Error { constructor() { super('The join result is unknown. Retry this same request.'); } }
/** Credentials are obtained for each call. Invite IDs are references, never bearer
 * access. The recipient's human session is the only authority at this endpoint. */
export function humanInvitationClient(options: { url: string; anonKey: string; authenticate(): Promise<string>; fetcher?: typeof fetch; requestId(): string }) {
  const send = async (commandId: string, command: HumanInviteCommand): Promise<Record<string, unknown>> => {
    const credential = await options.authenticate();
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 30_000);
    try {
      const response = await (options.fetcher ?? fetch)(`${options.url}/functions/v1/command`, { method:'POST', headers: {
        authorization: `Bearer ${credential}`, apikey:options.anonKey,'content-type':'application/json' },
        body: JSON.stringify({ command_id:commandId,client_version:'0.1.0',command }),signal:deadline.signal });
      if (response.status >= 500) throw new HumanInviteUnknown();
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new HumanInviteRefused(String(body.reason ?? body.error ?? 'request_refused'));
      if (!(command.action === 'preview' ? ['preview','joined'] : ['joined']).includes(String(body.status))) throw new HumanInviteUnknown();
      return body;
    } catch (error) { if (error instanceof HumanInviteRefused) throw error; throw new HumanInviteUnknown(); }
    finally { clearTimeout(timer); }
  };
  return {
    preview: async (invitation: HumanInviteRef) => await send(options.requestId(),{kind:'household_invitation',action:'preview',invitation}) as unknown as HumanInvitePreview | HumanInviteJoined,
    prepareAcceptance(invitation: HumanInviteRef, preview: HumanInvitePreview, contentRole: 'reader' | 'editor') {
      if (preview.consent_version !== HOUSEHOLD_JOIN_CONSENT_VERSION) throw new HumanInviteRefused('consent_version_changed');
      const requestId = options.requestId();
      const command: HumanInviteCommand = {kind:'household_invitation',action:'accept',invitation,consent_version:preview.consent_version,
        preview_digest:preview.preview_digest,content_role:contentRole};
      let receipt: Record<string, unknown> | null = null;
      return { requestId, send: async () => receipt ?? (receipt = await send(requestId,command)) };
    },
    async inbox(): Promise<{ invitation_id: string; workspace_name: string; inviter_display_name: string; expires_at: string }[]> {
      const credential = await options.authenticate(), deadline = new AbortController(), timer = setTimeout(() => deadline.abort(),30_000);
      try {
        const response = await (options.fetcher ?? fetch)(`${options.url}/functions/v1/read`,{method:'POST',headers:{authorization:`Bearer ${credential}`,apikey:options.anonKey,'content-type':'application/json'},body:JSON.stringify({resource:'human_invitations'}),signal:deadline.signal});
        if (!response.ok) throw new HumanInviteRefused('invitations_unavailable');
        const body = await response.json();
        if (!Array.isArray(body.invitations)) throw new HumanInviteUnknown();
        return body.invitations;
      } finally { clearTimeout(timer); }
    },
  };
}
