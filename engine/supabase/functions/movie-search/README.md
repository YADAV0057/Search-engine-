# movie-search — deployment notes

Upload this whole `movie-search/` folder to:

```
engine/supabase/functions/movie-search/
```

so the tree matches:

```
engine/supabase/functions/
  movie-search/
    index.ts
    domains.js
    rankResults.js
    adapters/
      tmdb.ts
      omdb.ts
      trakt.ts
```

Once pushed, GitHub Actions should deploy it as a new Supabase Edge Function
(`movie-search`), separate from `search` (manga). No changes to any existing
manga files.

## Secrets required (already added per your notes)
- `TMDB_API_KEY` — primary
- `OMDB_API_KEY` — fallback
- `TRAKT_CLIENT_ID` — fallback
- `GEMINI_API_KEY2` / `GEMINI_API_KEY3` — reserved for `backfill-movie-embeddings`, not used by this function yet

## What's live in this scaffold (Stage 1: waterfall + filters)
- TMDB → OMDb → Trakt waterfall with retry/backoff per tier
- Language, watch-provider, and genre filters (TMDB `/discover` + `/search`)
- Watch-provider attachment per result, capped to top 5 by `display_priority`
- Basic exclusion-term parsing ("thriller but not gory") and genre-name inference from free text
- Ranking with quality (Bayesian vote blend), text-overlap relevance, language match, provider match — and the `hasAnySemanticScore` gate already in place

## What's intentionally stubbed (Stage 2/3, not built yet)
- Movie keyword-signature system (the `trope_signatures` equivalent, off TMDB's `keywords` endpoint) — `intent.keywordSignature` is currently always `null`
- Embeddings on overview + keywords (`movie_entities`, `backfill-movie-embeddings`) — `movie.semanticScore` is never populated yet, so the ranker's semantic weight is currently always redistributed to the other four signals
- `harvest-movies` function (TMDB/OMDb catalog harvest into `movie_entities`)
- `movie_entities` / `movie_sync_state` tables — not created yet; this function doesn't read/write them

## Sample request body
```json
{
  "query": "cathartic slow burn",
  "language": "en",
  "watchProviders": "8,119",
  "watchRegion": "IN",
  "page": 1
}
```

## Next steps
1. Test this against real traffic first — TMDB tier should handle almost everything.
2. Once stable, start the keyword-signature harvest (`harvest-movies` + a movies-flavored trope-signature table) in parallel.
3. Wire `movie.semanticScore` in once that harvest has *some* coverage — the ranker will pick it up automatically via the `hasAnySemanticScore` gate, no ranker changes needed.

