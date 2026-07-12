-- SAVE AS: engine/supabase/migrations/0001_search_cache.sql

-- search_cache: one table, shared across every niche. `domain` is what
-- keeps manga/anime/books results from colliding — see README section 2.

create table if not exists search_cache (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  query_hash text not null,
  results jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- One cache row per (domain, query_hash) — upsert target in cache.js.
create unique index if not exists search_cache_domain_query_hash_idx
  on search_cache (domain, query_hash);

-- Speeds up the eventual cleanup job (delete where expires_at < now()).
-- No cron wired up yet — expired rows are currently just ignored as
-- misses by cache.js, not deleted. Fine at this scale; revisit once the
-- table has enough dead rows to matter.
create index if not exists search_cache_expires_at_idx
  on search_cache (expires_at);

