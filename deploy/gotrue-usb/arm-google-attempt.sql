-- Run only through the trusted operator connection after collecting this digest from the paired phone.
\set ON_ERROR_STOP on
INSERT INTO auth.ios_google_usb_attempts AS old (owner_id, google_subject, binding)
SELECT u.id, i.provider_id, :'binding' FROM auth.users u
JOIN auth.identities i ON i.user_id = u.id AND i.provider = 'google'
WHERE u.id = :'owner_id'::uuid

ON CONFLICT (owner_id) DO UPDATE
  SET binding = EXCLUDED.binding, google_subject = EXCLUDED.google_subject, armed_at = clock_timestamp(), flow_id = NULL
  WHERE old.armed_at <= clock_timestamp() - interval '5 minutes' AND old.binding <> EXCLUDED.binding
RETURNING 1 AS armed
\gset
\echo Google USB attempt armed for five minutes.
