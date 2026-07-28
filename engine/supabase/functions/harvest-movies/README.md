# harvest-movies — deployment notes

Upload to:

```
engine/supabase/functions/harvest-movies/
    index.ts
```

Single self-contained file — no imports from `movie-search/`, per the
"fully separate folder" philosophy (avoids the cross-function coupling
that caused Entry 90's cross-domain bug on the manga side).

## What it does
- Pulls one page (20 movies) per invocation from TMDB `/discover/movie`, newest year first, sorted by popularity.
- For each movie, fetches TMDB keywords and writes:
  - `movie_entities` (`entity_type = 'movie'`) — title, overview, genre names, TMDB metadata, and `embedding_source_text` (`title + overview + genre names + keyword names`, per the Architecture & UX Plan — cast/director deliberately excluded, they'll live as queryable metadata instead).
  - `movie_entities` (`entity_type = 'keyword'`) — every distinct TMDB keyword encountered, for the future keyword-signature system.
- Advances a compound `year * 1000 + page` cursor in `movie_sync_state` (`entity_type = 'movie'`) — works around TMDB's hard 500-page (10,000-result) cap per filter combination, the same problem the MangaDex harvest hit, fixed the same way (partition by a second dimension, here `primary_release_year` instead of MangaDex's `createdAtSince`).
- On a full sweep completing (reaches 1900), wraps back to the current year+1 so re-runs both catch new releases and refresh existing rows' TMDB metadata.

## Required secrets (already set)
- `TMDB_API_KEY`
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — these are auto-injected into every Supabase Edge Function by the platform; no manual secret needed.

## Scheduling
Run on a cron, same pattern as `harvest-lexicons`. Suggest starting with something like every 15-30 min — each invocation does ~20 TMDB detail-ish calls (1 discover + up to 20 keyword lookups), well within TMDB's free-tier rate limits.

## Not built yet
- `backfill-movie-embeddings` — per the Architecture & UX Plan's own sequencing, this comes *after* harvest has some real coverage, not before. `GEMINI_API_KEY2`/`GEMINI_API_KEY3` are already in Secrets and ready to go — next step once this harvest has run for a while and `movie_entities` has real rows.
- Keyword-signature seeding (`movie_keyword_signatures` table already exists, mirroring `trope_signatures`) — this is a data-generation pass (like the manga trope batches), not code, and needs the keyword catalog from this harvest to seed against.

