-- Runs once, before any migration, as the owner role.
--
-- The application must NOT connect as the table owner: Postgres exempts table
-- owners from row-level security, so RLS would be dead weight. This creates the
-- least-privileged runtime role the app actually connects as.
--
-- The role credential is never written here. scripts/db-bootstrap.mjs reads it
-- from APP_DATABASE_URL and binds it into bootstrap.app_password, so there is a
-- single source of truth and nothing to leak into version control.

DO $$
DECLARE
  pw text := current_setting('bootstrap.app_password');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cooking_app') THEN
    EXECUTE format('CREATE ROLE cooking_app LOGIN PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE cooking_app LOGIN PASSWORD %L', pw);
  END IF;
END
$$;

GRANT CONNECT ON DATABASE cooking TO cooking_app;
GRANT USAGE ON SCHEMA public TO cooking_app;

-- Applies to tables that exist now.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cooking_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cooking_app;

-- And to tables created later by any migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cooking_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cooking_app;

-- Belt and braces: never let the runtime role bypass RLS.
ALTER ROLE cooking_app NOBYPASSRLS;
