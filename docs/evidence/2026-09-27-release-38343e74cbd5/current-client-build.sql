INSERT INTO swarm.config (key, value) VALUES ('current_client_build', to_jsonb('0.1.79'::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
