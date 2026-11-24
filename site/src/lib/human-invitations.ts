import { humanInvitationClient } from '../../../src/cloud/human-invitation-transport.js';
import {
  AuthRecoveryRequired,
  currentSession,
  deployment,
  isMultiAccountEnabled,
  pinAccountContext,
  uuid,
  WEB_CLIENT_VERSION,
  type PinnedAccountContext,
} from './commonswarm.js';
export { HumanInviteRefused, HumanInviteUnknown } from '../../../src/cloud/human-invitation-transport.js';

export function browserHumanInvitations(options: { pinned?: PinnedAccountContext | null } = {}) {
  const target = deployment();
  if (!target) throw new Error('This page is not connected to CommonSwarm.');
  const bound = isMultiAccountEnabled() ? (options.pinned ?? pinAccountContext()) : null;
  const effectiveTarget = bound ? bound.runtime.deployment : target;
  return humanInvitationClient({
    url: effectiveTarget.url,
    anonKey: effectiveTarget.anonKey,
    requestId: () => `join_${uuid()}`,
    commandEnvelope: (commandId, command) => ({ command_id: commandId, client_version: WEB_CLIENT_VERSION, command }),
    authenticate: async () => {
      if (isMultiAccountEnabled()) {
        if (!bound || !bound.isCurrent()) {
          throw new Error('Your active account changed. Confirm again as the account you want to use.');
        }
        let session;
        try {
          session = await bound.runtime.verifySession();
        } catch (error) {
          if (error instanceof Error && error.name === 'MultiAccountAuthRecoveryRequired') {
            throw new AuthRecoveryRequired();
          }
          throw error;
        }
        if (!session || !bound.isCurrent() || session.user.id !== bound.userId) {
          throw new Error('Sign in as yourself to review invitations.');
        }
        return session.access_token;
      }
      const session = await currentSession();
      if (!session) throw new Error('Sign in as yourself to review invitations.');
      return session.access_token;
    },
  });
}
