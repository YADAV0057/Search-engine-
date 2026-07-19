-- Entry 58 (Backend Update List): manga_emotion_lexicon only stored `emotions`,
-- with nowhere to persist the synopsis-plausible keywords emotionalIntentFallback.js's
-- LLM tier generates alongside the emotion key (Entry 57). Additive, nullable
-- column -- no existing reader/writer is broken by its presence.
--
-- STATUS: already applied directly to project uvperhzhnosjtkwxxnte via
-- Supabase migration (name: add_keywords_to_manga_emotion_lexicon) as of
-- 2026-07-19. Included here for the repo's migration history / other
-- environments, per the project's GitHub-review workflow.

alter table public.manga_emotion_lexicon
  add column if not exists keywords jsonb not null default '[]'::jsonb;

comment on column public.manga_emotion_lexicon.keywords is
  'Short free-text keywords captured alongside a classified emotion (see emotionalIntentFallback.js Entry 57/58). Empty array for rows that predate this column or were never classified with keywords.';

