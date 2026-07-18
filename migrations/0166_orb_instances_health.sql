-- #4933: fleet-wide instance health aggregation. Distinct from orb_instances.last_seen_at (bumped on EVERY
-- ingest call, including outcome-only exports from an older self-host build that doesn't send a health
-- signal at all): healthy/health_reported_at are only set when a payload actually carries one, so an
-- instance that hasn't upgraded yet stays NULL (unknown) rather than silently reading as healthy.
ALTER TABLE orb_instances ADD COLUMN healthy INTEGER;
ALTER TABLE orb_instances ADD COLUMN health_reported_at TEXT;
