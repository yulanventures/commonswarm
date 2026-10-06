-- Keep consumed invites, memberships, consent, events and audit. Remove only delivery admission.
DROP FUNCTION IF EXISTS swarm_read.human_invitations();
COMMENT ON COLUMN swarm.invitations.email IS 'Bookkeeping and invite-page rendering only; never an authorization input.';
