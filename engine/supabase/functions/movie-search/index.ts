// engine/supabase/functions/movie-search/index.ts
//
// Movie search endpoint.
//
// STAGE 2 (2026-07-31): keyword-signature (mood) matching wired in — see
// domains.js and rankResults.js header comments for the full writeup. Two
// changes needed here specifically:
//   1. A supabase client now exists (same createClient pattern as manga's
//      search/index.ts) and gets passed into parseMovieQuery, which is now
//      async because it queries movie_keyword_signatures.
//   2. normalizeTmdbMovie keeps `genre_ids` (previously dropped) so
//      rankResults.js's moodMatchScore has something to compare the
//      keyword-signature's genre_weights against.
//
// STAGE 3 (2026-08-01): on-demand embedding. Previously a movie only ever
// got an embedding via the backfill-movie-embeddings cron sweeping
// movie_entities in id order — meaning a title a user actually searched for
// today could sit unembedded for weeks depending on where it falls in that
// sweep. Now, after every TMDB-tier search, any result missing an embedding
// gets embedded and upserted into movie_entities via embedOnDemand.ts,
// fired through EdgeRuntime.waitUntil() so it runs AFTER the response has
// already gone out — it costs nothing in search latency, it just means the
// row is ready by the next time anyone (or the ranker's semantic signal,
// once wired) needs it. Requires GEMINI_API_KEY2 (and ideally
// GEMINI_API_KEY3) to be set as secrets on this function too, same as
// backfill-movie-embeddings.
//
// Fully separate from engine/supabase/functions/search/ (manga) — own
// ranker, own query planner, own tables (movie_entities / movie_sync_state,
// not touched by this file directly). See the architecture doc for why.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseMovieQuery } from "./domains.js";
import { rankMovies } from "./rankResults.js";
import { embedMissingMovies } from "./embedOnDemand.ts";
import * as tmdb from "./adapters/tmdb.ts";
import * as omdb from "./adapters/omdb.ts";
import * as trakt from "./adapters/trakt.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_WATCH_REGION = "IN"; // MoodManga's primary audience; overridden per-request when provided

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface MovieSearchRequest {
  query?: string;
  language?: string;
  watchProviders?: string;
  watchRegion?: string;
  genres?: string;
  page?: number;
}

// Top N provider logos surfaced directly on the card, per the UX plan's
// "cap to top 4-5 logos by display_priority" decision.
const MAX_CARD_PROVIDERS = 5;

function normalizeTmdbMovie(m: tmdb.TmdbMovie) {
  return {
    id: `tmdb-${m.id}`,
    tmdbId: m.id,
    title: m.title,
    overview: m.overview,
    release_date: m.release_date,
    original_language: m.original_language,
    // Kept as of Stage 2 — rankResults.js's moodMatchScore reads this to
    // compare against the query's keyword-signature genre_weights. Was
    // previously dropped here since nothing consumed it yet.
    genre_ids: m.genre_ids ?? [],
    vote_average: m.vote_average,
    vote_count: m.vote_count,
    popularity: m.popularity,
    poster_path: m.poster_path,
    backdrop_path: m.backdrop_path,
    source: "tmdb" as const,
  };
}

// Attaches a capped, display_priority-sorted provider list to each TMDB
// result. Only runs for the TMDB path — OMDb/Trakt fallback results ship
// without "where to watch" data, since neither API exposes it on the free tier.
async function attachWatchProviders(movies: ReturnType<typeof normalizeTmdbMovie>[], watchRegion: string) {
  return await Promise.all(
    movies.map(async (movie) => {
      try {
        const providers = await tmdb.getWatchProviders(movie.tmdbId, watchRegion);
        const flatrate = (providers?.flatrate ?? [])
          .sort((a, b) => a.display_priority - b.display_priority)
          .slice(0, MAX_CARD_PROVIDERS);
        return { ...movie, watchProviders: { ...providers, flatrate }, watchProvidersLink: providers?.link };
      } catch {
        // A single title's provider lookup failing shouldn't sink the whole response.
        return { ...movie, watchProviders: null };
      }
    }),
  );
}

async function runWaterfall(intent: Awaited<ReturnType<typeof parseMovieQuery>>) {
  // Tier 1: TMDB (primary) — covers search, discover, language + provider + genre filters.
  try {
    const results = await tmdb.discoverMovies({
      searchText: intent.searchText,
      language: intent.language,
      watchProviders: intent.watchProviders,
      watchRegion: intent.watchRegion ?? DEFAULT_WATCH_REGION,
      genres: intent.genres,
      page: intent.page,
    });
    if (results.length > 0) {
      const normalized = normalizeTmdbMovie ? results.map(normalizeTmdbMovie) : results;
      const withProviders = await attachWatchProviders(normalized, intent.watchRegion ?? DEFAULT_WATCH_REGION);
      return { movies: withProviders, tier: "tmdb" as const };
    }
    // Empty result set from TMDB is a legitimate "no matches," not a failure —
    // don't waterfall down just because zero results came back.
    return { movies: [], tier: "tmdb" as const };
  } catch (tmdbError) {
    console.error("[movie-search] TMDB tier failed, falling back to OMDb:", tmdbError);
  }

  // Tier 2: OMDb (fallback) — title search only, no filter support.
  try {
    const results = await omdb.searchMovies(intent.searchText ?? "", intent.page);
    if (results.length > 0) return { movies: results, tier: "omdb" as const };
  } catch (omdbError) {
    console.error("[movie-search] OMDb tier failed, falling back to Trakt:", omdbError);
  }

  // Tier 3: Trakt (last resort) — title search only, no poster images on free tier.
  try {
    const results = await trakt.searchMovies(intent.searchText ?? "", intent.page);
    return { movies: results, tier: "trakt" as const };
  } catch (traktError) {
    console.error("[movie-search] Trakt tier failed — all providers exhausted:", traktError);
    throw new Error("All movie data providers are currently unavailable. Please try again shortly.");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const body: MovieSearchRequest = req.method === "POST" ? await req.json() : {};
    const intent = await parseMovieQuery(body, supabase);

    const { movies, tier } = await runWaterfall(intent);
    const ranked = rankMovies(movies, intent);

    // Stage 3: on-demand embedding, TMDB tier only — OMDb/Trakt fallback
    // results don't carry a tmdbId or genre_ids, so there's nothing to key
    // an upsert into movie_entities on. Fired via waitUntil so it runs
    // AFTER the response below is returned; adds zero latency to this request.
    if (tier === "tmdb" && ranked.length > 0) {
      const candidates = ranked
        .filter((m): m is typeof m & { tmdbId: number } => typeof (m as any).tmdbId === "number")
        .map((m) => ({
          tmdbId: (m as any).tmdbId,
          title: (m as any).title,
          overview: (m as any).overview,
          release_date: (m as any).release_date,
          genre_ids: (m as any).genre_ids,
        }));

      // @ts-ignore — EdgeRuntime is a Supabase/Deno Deploy global, not in
      // the standard Deno types.
      EdgeRuntime.waitUntil(embedMissingMovies(candidates, supabase));
    }

    return new Response(
      JSON.stringify({
        results: ranked,
        meta: {
          tier,
          count: ranked.length,
          watchRegion: intent.watchRegion ?? DEFAULT_WATCH_REGION,
          exclusions: intent.exclusions,
          keywordSignature: intent.keywordSignature,
        },
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[movie-search] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
