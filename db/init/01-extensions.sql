-- Extensions required by the Phase 1 schema.
-- Runs once on first container init (empty data volume).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
