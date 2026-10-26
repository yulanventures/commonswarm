-- Drop the hosted client stream lock added by 20261019000004. No migration or
-- database object references it and the pre-permanence runtime never called
-- it, so nothing else changes. Apply before the 20261019000003 reserve. Kept
-- on purpose: every registered client, binding and hosted grant row, and the
-- 20261019000003 family lock (that version's own reserve drops it).
DROP FUNCTION IF EXISTS commonswarm_oauth.lock_hosted_client_streams(text);
