SELECT to_regclass('commonswarm_oauth.registered_clients') IS NULL
  AND to_regclass('commonswarm_oauth.registered_clients_expiry_idx') IS NULL
  AND to_regclass('commonswarm_oauth.provider_artifacts') IS NOT NULL
  AND to_regclass('commonswarm_oauth.cimd_cache') IS NOT NULL AS rollback_ok
\gset
