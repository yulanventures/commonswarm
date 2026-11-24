import { HumanInviteRefused, type HumanInvitePreview, humanInvitationClient } from '../../../src/cloud/human-invitation-transport.js';
import { AuthRecoveryRequired } from '../../../shared/browser-session/index.js';
type Client = ReturnType<typeof humanInvitationClient>;
export interface HumanInviteView { account: string | null; invitations: Awaited<ReturnType<Client['inbox']>>;
  preview: HumanInvitePreview | null; joined: boolean; message: string; busy: boolean; confirmed_role: 'reader' | 'editor' | null;
  /** The last read or join failed; `message` says how. Set explicitly, never inferred from text. */
  failed: boolean;
  /** Session verification could not complete; current content is preserved for a retry on the next notification. */
  recoveryPending?: boolean }
const isAuthRecoveryError = (error: unknown): boolean =>
  error instanceof AuthRecoveryRequired || (error instanceof Error && error.name === 'AuthRecoveryRequired');
/** Owns asynchronous recipient state. Every account transition discards private
 * rows, previews and pending requests before starting another read. */
export function createHumanInviteController(api: Client, render: (view: HumanInviteView) => void) {
  let generation = 0, selectedId = '', request: ReturnType<Client['prepareAcceptance']> | null = null;
  // One decline request per invitation while its result is unknown: a retry repeats it, never sends a second.
  let declining: { id: string; request: ReturnType<Client['prepareDecline']> } | null = null;
  let view: HumanInviteView = { account:null,invitations:[],preview:null,joined:false,message:'',busy:false,confirmed_role:null,failed:false,recoveryPending:false };
  const publish = () => render({ ...view, invitations: [...view.invitations] });
  const current = (version: number) => version === generation && view.account !== null;
  const failure = (error: unknown) => error instanceof HumanInviteRefused ? error.reason === 'review_changed'
    ? 'The workspace changed. Review the invitation again.' : 'This invitation is unavailable. Review it again.'
    : 'The result could not be read. Check again.';
  return {
    setAccount(account: string | null) {
      ++generation; selectedId='';request=null;declining=null;
      view={account,invitations:[],preview:null,joined:false,message:'',busy:false,confirmed_role:null,failed:false,recoveryPending:false}; publish();
    },
    async load() {
      if (!view.account) return;
      const version = ++generation; request=null;view.confirmed_role=null;view.preview=null;view.joined=false;view.busy=true;view.failed=false;view.recoveryPending=false;publish();
      try { const rows=await api.inbox(); if (current(version)) { view.invitations=rows;view.message=rows.length ? 'Choose an invitation to review.' : 'No pending invitations.'; } }
      catch(error) {
        if (current(version)) {
          if (isAuthRecoveryError(error)) {
            view.recoveryPending = true;
          } else {
            view.invitations=[];view.message=failure(error);view.failed=true;
          }
        }
      }
      finally { if(current(version)){view.busy=false;publish();} }
    },
    async review(id: string) {
      if (!view.account) return;
      const version=++generation;selectedId=id;request=null;view.confirmed_role=null;view.preview=null;view.joined=false;view.busy=true;view.failed=false;publish();
      try { const preview=await api.preview({source:'delegated',invitation_id:id}); if(current(version)) { view.preview=preview.status === 'preview' ? preview : null; view.joined=preview.status === 'joined';view.message=preview.status === 'joined' ? `You joined ${preview.workspace_name}.` : ''; } }
      catch(error){if(current(version)){view.message=failure(error);view.failed=true;}}
      finally{if(current(version)){view.busy=false;publish();}}
    },
    async accept(role: string, consent: boolean) {
      if (!view.account || !view.preview || !consent || (role!=='reader' && role!=='editor') || view.busy) return;
      const version=generation;view.busy=true;view.failed=false;publish();
      try {
        if (!request) { request=api.prepareAcceptance({source:'delegated',invitation_id:selectedId},view.preview,role); view.confirmed_role=role; publish(); }
        const result=await request.send(); if(current(version)){view.joined=true;view.preview=null;view.message=`You joined ${String(result.workspace_name)}.`;} }
      catch(error){if(current(version)){view.failed=true;if(error instanceof HumanInviteRefused){request=null;view.confirmed_role=null;view.preview=null;view.message=failure(error);}else view.message='The join result is unknown. Retry to check the same request.';}}
      finally{if(current(version)){view.busy=false;publish();}}
    },
    /** The recipient turns the invitation down. It leaves the list only once the server has confirmed. */
    async decline(id: string) {
      if (!view.account || view.busy || !view.invitations.some(row => row.invitation_id === id)) return;
      const version=++generation;request=null;view.confirmed_role=null;view.preview=null;view.joined=false;view.busy=true;view.failed=false;publish();
      if (declining?.id !== id) declining={id,request:api.prepareDecline(id)};
      try { await declining.request.send();
        if(current(version)){declining=null;view.invitations=view.invitations.filter(row=>row.invitation_id!==id);view.message='Invitation declined.';} }
      catch(error){if(current(version)){view.failed=true;
        if(error instanceof HumanInviteRefused){declining=null;view.message='This invitation is unavailable. Check again.';}
        else view.message='The result is unknown. Decline again to check the same request.';}}
      finally{if(current(version)){view.busy=false;publish();}}
    },
  };
}
