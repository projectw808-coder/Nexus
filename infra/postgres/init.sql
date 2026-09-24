-- Runs once on first container start. The shadow database is used by `prisma migrate dev`
-- and by the CI drift gate (`prisma migrate diff`). Extensions are created by migrations.
CREATE DATABASE nexus_shadow;
CREATE DATABASE nexus_test;
