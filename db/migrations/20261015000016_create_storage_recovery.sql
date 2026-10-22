-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS storage.maintenance (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  generation uuid,
  purpose text CHECK (purpose IN ('backup','restore')),
  state text NOT NULL DEFAULT 'normal' CHECK (state IN ('normal','draining','held','reconciling')),
  effect_key text,
  cut_at timestamptz
);
-- Expanding/re-runnable, including on databases that already applied the draft.
ALTER TABLE storage.maintenance ADD COLUMN IF NOT EXISTS reopened_at timestamptz;
INSERT INTO storage.maintenance(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS storage.version_availability (
  object_id uuid PRIMARY KEY REFERENCES storage.objects(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('unverified','available','missing','corrupt')),
  checked_at timestamptz
);
CREATE TABLE IF NOT EXISTS storage.restore_progress (
  generation uuid PRIMARY KEY,
  cursor uuid,
  backend_cursor text,
  inventory_complete boolean NOT NULL DEFAULT false,
  complete boolean NOT NULL DEFAULT false,
  unavailable bigint NOT NULL DEFAULT 0 CHECK (unavailable >= 0),
  artifact_sha256 text CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$')
);
-- migrate:down
