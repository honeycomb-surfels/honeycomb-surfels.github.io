-- Visitor counter schema for Cloudflare D1 (SQLite). Apply with:
--   npx wrangler d1 migrations apply honeycomb_surfels_visitors --remote

-- One row per visit (one browser on one network on one UTC day), the only per-visitor data kept. The Worker
-- deletes the rows of earlier days every day at 00:05 UTC. day: UTC date 'YYYY-MM-DD'. visitor_hash: hex
-- SHA-256 of the secret salt, the day, the network (IPv4 address or IPv6 /64 prefix) and the user agent;
-- neither the address nor the user agent is stored. country: ISO 3166-1 alpha-2 code from
-- request.cf.country, 'XX' when unknown. first_seen_ms: Unix time in ms of the visit's first page load.
CREATE TABLE IF NOT EXISTS visits (
  day TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  country TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (day, visitor_hash)
);

-- Visits per UTC hour of their first page load and per country (aggregate counts only). The footer sums
-- the current hour and the 23 before it; the Worker deletes rows older than 48 hours.
-- hour_ms: start of the UTC hour, Unix time in ms.
CREATE TABLE IF NOT EXISTS hourly_visits (
  hour_ms INTEGER NOT NULL,
  country TEXT NOT NULL,
  visits INTEGER NOT NULL,
  PRIMARY KEY (hour_ms, country)
);

-- Running totals that outlive the deleted rows above. total_visits: visits since launch.
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('total_visits', 0);
