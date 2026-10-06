-- ZTech lead-intelligence schema, migration 006: Opportunity Intelligence associations (I3).
--
-- The lead <-> OI research link, so a researched lead still shows its report after
-- ZTech restarts. One row per OI research_id. IDs and metadata ONLY:
--   - no IntelligenceReport JSON (the report stays in OI's own SQLite store and is
--     re-fetched by research_id),
--   - no provider credentials, no OI database data,
--   - no change to numbers, outreach, pitch, approval or activity tables.
--
-- lead_id is ZTech's identity; research_id / snapshot_id / entity_key are OI's, stored
-- exactly as OI minted them on a validated report. The join is never a name match.

CREATE TABLE IF NOT EXISTS li_oi_associations (
  research_id  TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL,
  entity_key   TEXT NOT NULL,
  status       TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS li_oi_assoc_lead ON li_oi_associations (lead_id, recorded_at DESC);
