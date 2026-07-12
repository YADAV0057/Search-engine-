-- SAVE AS: engine/supabase/migrations/0002_lexicons.sql
--
-- Lexicon storage for AniList ID -> name/metadata lookups, per the harvest
-- plan in harvest-lexicons/index.js. One generic table rather than one
-- table per entity type (genres/tags/staff/characters/studios/media) —
-- they're all "id -> name (+ small metadata)" shape, so a shared table
-- with an entity_type column avoids five near-identical schemas.

create table if not exists lexicon_entities (
  entity_type text not null,       -- 'genre' | 'tag' | 'theme' | 'demographic' | 'studio' | 'staff' | 'character' | 'media'
  source_id   text not null,       -- AniList's numeric id, as text (genres have no id, see below)
  name        text not null,
  metadata    jsonb not null default '{}'::jsonb,  -- tag category/description, media title variants, etc.
  updated_at  timestamptz not null default now(),
  primary key (entity_type, source_id)
);

-- Genres are the one AniList entity type with no numeric id (GenreCollection
-- returns bare strings) — harvest-lexicons/index.js uses the lowercased
-- genre name itself as source_id for that entity_type only.

create index if not exists lexicon_entities_name_idx
  on lexicon_entities (entity_type, lower(name));

-- Tracks the highest AniList id already synced per paginated entity type
-- (characters/staff/studios/media), so a re-run only fetches the delta —
-- sort ID_DESC, stop at last_max_id, per the harvest plan. Static entity
-- types (genre/tag/theme/demographic) don't use this: they're small enough
-- to refetch and overwrite in full every run.
create table if not exists lexicon_sync_state (
  entity_type  text primary key,
  last_max_id  bigint not null default 0,
  last_synced_at timestamptz
);
