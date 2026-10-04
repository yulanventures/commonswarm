import { HumanInviteRefused, type HumanInvitePreview, humanInvitationClient } from '../../../src/cloud/human-invitations.js';
type Client = ReturnType<typeof humanInvitationClient>;
export interface HumanInviteView { account: string | null; invitations: Awaited<ReturnType<Client['inbox']>>;
  preview: HumanInvitePreview | null; joined: boolean; message: string; busy: boolean; confirmed_role: 'reader' | 'editor' | null }
/** Owns asynchronous recipient state. Every account transition discards private
 * rows, previews and pending requests before starting another read. */
export function createHumanInviteController(api: Client, render: (view: HumanInviteView) => void) {
  let generation = 0, selectedId = '', request: ReturnType<Client['prepareAcceptance']> | null = null;
  let view: HumanInviteView = { account:null,invitations:[],preview:null,joined:false,message:'',busy:false,confirmed_role:null };
  const publish = () => render({ ...view, invitations: [...view.invitations] });
  const current = (version: number) => version === generation && view.account !== null;
  const failure = (error: unknown) => error instanceof HumanInviteRefused ? error.reason === 'review_changed'
    ? 'The workspace changed. Review the invitation again.' : 'This invitation is unavailable. Review it again.'
    : 'The result could not be read. Check again.';
  return {
    setAccount(account: string | null) {
      ++generation; selectedId='';request=null;
      view={account,invitations:[],preview:null,joined:false,message:'',busy:false,confirmed_role:null}; publish();
    },
    async load() {
      if (!view.account) return;
      const version = ++generation; request=null;view.confirmed_role=null;view.preview=null;view.joined=false;view.busy=true;publish();
      try { const rows=await api.inbox(); if (current(version)) { view.invitations=rows;view.message=rows.length ? 'Choose an invitation to review.' : 'No pending invitations.'; } }
      catch(error) { if(current(version)) { view.invitations=[];view.message=failure(error); } }
      finally { if(current(version)){view.busy=false;publish();} }
    },
    async review(id: string) {
      if (!view.account) return;
      const version=++generation;selectedId=id;request=null;view.confirmed_role=null;view.preview=null;view.joined=false;view.busy=true;publish();
      try { const preview=await api.preview({source:'delegated',invitation_id:id}); if(current(version)) { view.preview=preview.status === 'preview' ? preview : null; view.joined=preview.status === 'joined';view.message=preview.status === 'joined' ? `You joined ${preview.workspace_name}.` : ''; } }
      catch(error){if(current(version))view.message=failure(error);}
      finally{if(current(version)){view.busy=false;publish();}}
    },
    async accept(role: string, consent: boolean) {
      if (!view.account || !view.preview || !consent || (role!=='reader' && role!=='editor') || view.busy) return;
      const version=generation;view.busy=true;publish();
      try {
        if (!request) { request=api.prepareAcceptance({source:'delegated',invitation_id:selectedId},view.preview,role); view.confirmed_role=role; publish(); }
        const result=await request.send(); if(current(version)){view.joined=true;view.preview=null;view.message=`You joined ${String(result.workspace_name)}.`;} }
      catch(error){if(current(version)){if(error instanceof HumanInviteRefused){request=null;view.confirmed_role=null;view.preview=null;view.message=failure(error);}else view.message='The join result is unknown. Retry to check the same request.';}}
      finally{if(current(version)){view.busy=false;publish();}}
    },
  };
}
