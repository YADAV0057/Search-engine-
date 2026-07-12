-- SAVE AS: engine/supabase/migrations/0003_synonyms.sql

-- lexicon_synonyms: alias -> concept expansions, harvested from Datamuse's
-- ml= (means-like) endpoint. Replaces the static SYNONYM_MAP-in-
-- dictionary.js approach — a DB table means synonyms can be refreshed
-- independently of a code deploy, same reasoning as lexicon_entities.
--
-- DIRECTION MATTERS: the old SYNONYM_MAP was alias -> concept (many
-- aliases collapse to one canonical concept, e.g. "depressed"/"lonely"/
-- "heartbroken" all -> "sad"). Datamuse's ml=<word> is queried WITH the
-- concept (the AniList genre/tag/theme/demographic name, e.g. "tragedy")
-- and returns a list of related alias words. That's concept -> list, the
-- opposite direction — so the harvest step inverts it before storing:
-- one row per (alias, concept) pair, alias-leading, so a lookup by the
-- word a user actually typed is a direct index hit.
--
-- Shape: one row per (alias, concept) pair, not concept -> array, so a
-- single upsert per pair is idempotent and re-running the harvest is
-- always safe (same pattern as lexicon_entities' onConflict upserts).

create table if not exists lexicon_synonyms (
  id uuid primary key default gen_random_uuid(),
  alias text not null,       -- word a user might actually type, e.g. "depressed" (already lowercase — see harvest step)
  concept text not null,     -- canonical AniList genre/tag/theme/demographic name this alias maps to, e.g. "tragedy"
  score integer not null,    -- Datamuse's relevance score for this pair, highest first
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per (alias, concept) — upsert target in the harvest step.
create unique index if not exists lexicon_synonyms_alias_concept_idx
  on lexicon_synonyms (alias, concept);

-- synonyms.js's hot-path lookup is "given this word from the query, what
-- concept(s) does it alias?" — index the lookup column directly rather
-- than relying on the composite unique index above.
create index if not exists lexicon_synonyms_alias_idx
  on lexicon_synonyms (alias);

