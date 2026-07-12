-- SAVE AS: engine/supabase/migrations/0004_mangadex_media_dedup.sql
--
-- Supports harvestMediaFromMangaDex() in harvest-lexicons/index.ts (see
-- README/Notion changelog, 2026-07-13 decision: add MangaDex as a second
-- media source alongside AniList, deduped by normalized title before
-- insert, since AniList's rate limit is shared across staff/character/
-- studio/media in every harvest run and media is the single largest
-- paginated set).
--
-- WHY A GENERATED COLUMN, NOT AN IN-MEMORY CHECK: the dedup rule is
-- "before inserting a MangaDex title, check if a title with the same
-- normalized name already exists in lexicon_entities for entity_type
-- 'media'". Doing that by loading every existing media row into the Edge
-- Function on each run doesn't scale as the table grows. A generated
-- column lets Postgres compute and index the normalized form once, so the
-- dedup check is a single indexed query per page instead of an in-memory
-- table scan.
--
-- NORMALIZATION RULE (must match the JS-side normalizeTitle() in
-- index.ts EXACTLY, or the two will disagree on what counts as a
-- duplicate): lowercase, then strip everything that isn't a-z or 0-9.
-- "Attack on Titan" and "Attack on Titan!" both normalize to
-- "attackontitan".

alter table lexicon_entities
  add column if not exists normalized_name text
  generated always as (
    lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g'))
  ) stored;

-- Partial index — only 'media' rows are ever looked up this way, so no
-- reason to index normalized_name for genre/tag/staff/etc rows too.
create index if not exists lexicon_entities_media_normalized_name_idx
  on lexicon_entities (normalized_name)
  where entity_type = 'media';

