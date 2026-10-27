-- Re-applied after every migration run. No public Data API role may read application account/device metadata;
-- RLS without policies is defense in depth. Public reads go through the service's deliberate projections.
DO $privileges$
DECLARE app_role text;
BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', current_schema());
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', current_schema());
  FOREACH app_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', current_schema(), app_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', current_schema(), app_role);
    END IF;
  END LOOP;
END $privileges$;
ALTER TABLE cloud_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_device_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_share_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_likes ENABLE ROW LEVEL SECURITY;
