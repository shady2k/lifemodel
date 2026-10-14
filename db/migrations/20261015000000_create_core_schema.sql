-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE SCHEMA IF NOT EXISTS core;
CREATE EXTENSION IF NOT EXISTS vector;
-- migrate:down
