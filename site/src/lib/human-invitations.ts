import { humanInvitationClient } from '../../../src/cloud/human-invitation-transport.js';
import { currentSession, deployment, uuid, WEB_CLIENT_VERSION } from './commonswarm.js';
export { HumanInviteRefused, HumanInviteUnknown } from '../../../src/cloud/human-invitation-transport.js';
export function browserHumanInvitations() {
  const target = deployment();
  if (!target) throw new Error('This page is not connected to CommonSwarm.');
  return humanInvitationClient({ url: target.url, anonKey: target.anonKey, requestId: () => `join_${uuid()}`,
    commandEnvelope: (commandId, command) => ({ command_id: commandId, client_version: WEB_CLIENT_VERSION, command }),
    authenticate: async () => { const session = await currentSession(); if (!session) throw new Error('Sign in as yourself to review invitations.'); return session.access_token; } });
}
