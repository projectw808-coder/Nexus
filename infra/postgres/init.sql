-- Runs once on first container start (as the superuser "nexus").
-- The application connects as the NON-superuser role below so row-level security applies;
-- migrations run as "nexus" (table owner) via DATABASE_ADMIN_URL. Extensions are created by
-- migrations. The password is local-only; production roles come from infra/terraform.
CREATE ROLE nexus_app LOGIN PASSWORD 'nexus_app' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE nexus_shadow;
CREATE DATABASE nexus_test;
GRANT ALL PRIVILEGES ON DATABASE nexus TO nexus_app;
