-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Disposable evidence only: no task foreign keys and no active-holder trigger.
CREATE SCHEMA IF NOT EXISTS observability;
CREATE TABLE IF NOT EXISTS observability.trace_spans (
  trace_id text NOT NULL,
  span_id text NOT NULL,
  parent_span_id text,
  component text NOT NULL,
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  ended_at timestamptz CHECK (isfinite(ended_at)),
  status text CHECK (status IN ('ok', 'failed', 'suppressed')),
  attrs jsonb NOT NULL CHECK (jsonb_typeof(attrs) = 'object'),
  PRIMARY KEY (trace_id, span_id),
  CHECK ((ended_at IS NULL) = (status IS NULL))
);
CREATE TABLE IF NOT EXISTS observability.trace_events (
  record_id text PRIMARY KEY,
  trace_id text NOT NULL,
  span_id text NOT NULL,
  event text NOT NULL,
  ts timestamptz NOT NULL CHECK (isfinite(ts)),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object')
);
-- New empty tables, created in this transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS trace_spans_started ON observability.trace_spans(started_at);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS trace_events_trace ON observability.trace_events(trace_id, ts);
-- migrate:down
