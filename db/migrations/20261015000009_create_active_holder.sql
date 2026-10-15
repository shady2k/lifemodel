-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS core.active_holder (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  epoch bigint NOT NULL CHECK (epoch > 0)
);
-- migrate:down
