// engine/supabase/functions/movie-search/index.ts
//
// Movie + TV search endpoint.
//
// TV SUPPORT (2026-08-01): request body now accepts `mediaType: "movie" |
// "tv"` (defaults to "movie" — fully back-compatible). TV shares this
// function rather than getting its own since the pipeline shape is
// identical; only TMDB endpoints, field names (name/first_air_date vs
// title/release_date), and genre id map differ, handled via mediaType
// branches below and in domains.js/tmdb.ts. OMDb/Trakt fallback tiers are
// movie-only — a TV request that fails at the TMDB tier returns an error
// rather than waterfalling.
//
// ANIME FILTER (2026-08-02): TV requests now accept `excludeAnime: boolean`.
// TMDB has no standalone "Anime" genre — anime shows are tagged Animation
// (16) same as Western cartoons, distinguishable only by
// original_language === "ja". That's the same heuristic most TMDB-based
// apps use (imperfect — it'll also catch a handful of non-anime Japanese
// animated content, and won't catch anime co-productions not tagged "ja" —
// but it's the standard approach given what TMDB actually exposes).
// Filtering happens BEFORE ranking, on the raw TMDB page, so pagination's
// hasMore still reflects whether TMDB itself had another page — otherwise
// a heavily-anime page (e.g. an Animation-genre browse) could filter down
// to a handful of results while meta still claimed "no more pages" because
// the post-filter count came in under TMDB_PAGE_SIZE.
//
// Fully separate from engine/supabase/functions/search/ (manga) — own
// ranker, own query planner, own tables (movie_entities / movie_sync_state).

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

const DEFAULT_WATCH_REGION = "IN";
const TMDB_PAGE_SIZE = 20; // TMDB's fixed page size for /search and /discover
const ANIME_GENRE_ID = 16; // TMDB's "Animation" — see header note, no dedicated Anime genre exists

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface MovieSearchRequest {
  query?: string;
  mediaType?: "movie" | "tv";
  language?: string;
  watchProviders?: string;
  watchRegion?: string;
  genres?: string;
  page?: number;
  excludeAnime?: boolean;
}

const MAX_CARD_PROVIDERS = 5;

function normalizeTmdbMovie(m: tmdb.TmdbMovie) {
  return {
    id: `tmdb-${m.id}`,
    tmdbId: m.id,
    title: m.title,
    overview: m.overview,
    release_date: m.release_date,
    original_language: m.original_language,
    genre_ids: m.genre_ids ?? [],
    vote_average: m.vote_average,
    vote_count: m.vote_count,
    popularity: m.popularity,
    poster_path: m.poster_path,
    backdrop_path: m.backdrop_path,
    source: "tmdb" as const,
    mediaType: "movie" as const,
  };
}

// TV's TMDB shape uses name/first_air_date instead of title/release_date —
// normalized into the exact same output shape as normalizeTmdbMovie so
// rankResults.js and the frontend never need to branch on mediaType.
function normalizeTmdbTv(m: tmdb.TmdbTv) {
  return {
    id: `tmdb-tv-${m.id}`,
    tmdbId: m.id,
    title: m.name,
    overview: m.overview,
    release_date: m.first_air_date,
    original_language: m.original_language,
    genre_ids: m.genre_ids ?? [],
    vote_average: m.vote_average,
    vote_count: m.vote_count,
    popularity: m.popularity,
    poster_path: m.poster_path,
    backdrop_path: m.backdrop_path,
    source: "tmdb" as const,
    mediaType: "tv" as const,
  };
}

// See ANIME_GENRE_ID header note — applied to raw TMDB items (both movie's
// TmdbMovie and TV's TmdbTv shapes carry genre_ids + original_language
// already, pre-normalization).
function isAnime(item: { genre_ids?: number[]; original_language?: string }): boolean {
  return item.original_language === "ja" && (item.genre_ids ?? []).includes(ANIME_GENRE_ID);
}

async function attachWatchProviders(
  items: ReturnType<typeof normalizeTmdbMovie>[],
  mediaType: tmdb.MediaType,
  watchRegion: string,
) {
  return await Promise.all(
    items.map(async (item) => {
      try {
        const providers = await tmdb.getWatchProviders(mediaType, item.tmdbId, watchRegion);
        const flatrate = (providers?.flatrate ?? [])
          .sort((a, b) => a.display_priority - b.display_priority)
          .slice(0, MAX_CARD_PROVIDERS);
        return { ...item, watchProviders: { ...providers, flatrate }, watchProvidersLink: providers?.link };
      } catch {
        return { ...item, watchProviders: null };
      }
    }),
  );
}

async function runWaterfall(intent: Awaited<ReturnType<typeof parseMovieQuery>>) {
  if (intent.mediaType === "tv") {
    // TV tier: TMDB only. OMDb/Trakt adapters are movie-search-only — no TV
    // endpoint on either, so there's no fallback tier to waterfall to.
    const rawResults = await tmdb.discoverTv({
      searchText: intent.searchText,
      language: intent.language,
      watchProviders: intent.watchProviders,
      watchRegion: intent.watchRegion ?? DEFAULT_WATCH_REGION,
      genres: intent.genres,
      page: intent.page,
    });

    // hasMore reflects the raw TMDB page, not the post-anime-filter count —
    // see header note.
    const hasMore = rawResults.length >= TMDB_PAGE_SIZE;

    const filtered = intent.excludeAnime ? rawResults.filter((r) => !isAnime(r)) : rawResults;

    const normalized = filtered.map(normalizeTmdbTv);
    const withProviders = await attachWatchProviders(normalized, "tv", intent.watchRegion ?? DEFAULT_WATCH_REGION);
    return { movies: withProviders, tier: "tmdb" as const, hasMore };
  }

  // Tier 1: TMDB (primary)
  try {
    const results = await tmdb.discoverMovies({
      searchText: intent.searchText,
      language: intent.language,
      watchProviders: intent.watchProviders,
      watchRegion: intent.watchRegion ?? DEFAULT_WATCH_REGION,
      genres: intent.genres,
      page: intent.page,
    });
    const hasMore = results.length >= TMDB_PAGE_SIZE;
    if (results.length > 0) {
      const normalized = results.map(normalizeTmdbMovie);
      const withProviders = await attachWatchProviders(normalized, "movie", intent.watchRegion ?? DEFAULT_WATCH_REGION);
      return { movies: withProviders, tier: "tmdb" as const, hasMore };
    }
    // Empty result set from TMDB is a legitimate "no matches," not a failure —
    // don't waterfall down just because zero results came back.
    return { movies: [], tier: "tmdb" as const, hasMore: false };
  } catch (tmdbError) {
    console.error("[movie-search] TMDB tier failed, falling back to OMDb:", tmdbError);
  }

  // Tier 2: OMDb (fallback)
  try {
    const results = await omdb.searchMovies(intent.searchText ?? "", intent.page);
    if (results.length > 0) return { movies: results, tier: "omdb" as const, hasMore: false };
  } catch (omdbError) {
    console.error("[movie-search] OMDb tier failed, falling back to Trakt:", omdbError);
  }

  // Tier 3: Trakt (last resort)
  try {
    const results = await trakt.searchMovies(intent.searchText ?? "", intent.page);
    return { movies: results, tier: "trakt" as const, hasMore: false };
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
    // excludeAnime is TV-only in practice (movie's own genre taxonomy has
    // no equivalent ambiguity to resolve), but harmless to carry through
    // parseMovieQuery's output regardless of mediaType.
    (intent as any).excludeAnime = Boolean(body.excludeAnime);

    const { movies, tier, hasMore } = await runWaterfall(intent);
    const ranked = rankMovies(movies, intent);

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

      // @ts-ignore — EdgeRuntime is a Supabase/Deno Deploy global.
      EdgeRuntime.waitUntil(embedMissingMovies(candidates, supabase, intent.mediaType));
    }

    return new Response(
      JSON.stringify({
        results: ranked,
        meta: {
          mediaType: intent.mediaType,
          tier,
          count: ranked.length,
          hasMore,
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
