// engine/supabase/functions/harvest-movies/index.ts
//
// Harvests TMDB's movie catalog into movie_entities (entity_type='movie' and
// entity_type='keyword'), mirroring the harvest-lexicons pattern. Fully
// self-contained — no imports from movie-search/, per the "fully separate
// folder" philosophy in the Architecture & UX Plan. Intended to run on a
// cron schedule, one page (20 movies) per invocation.
//
// TMDB's /discover/movie caps at page 500 (10,000 results) for any single
// filter combination — the same ceiling MangaDex's harvest hit. Mirrors that
// harvest's compound-cursor fix: partition by primary_release_year instead
// of MangaDex's createdAtSince, paired with page offset within each year.
// Encoded as a single integer (year * 1000 + page) so it fits the existing
// movie_sync_state.cursor_offset (int4) column without a schema change.

import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_BASE = "https://api.themoviedb.org/3";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;
const START_YEAR = new Date().getFullYear() + 1; // include near-future release dates
const FLOOR_YEAR = 1900;
const TMDB_MAX_PAGE = 500;

function tmdbApiKey(): string {
  const key = Deno.env.get("TMDB_API_KEY");
  if (!key) throw new Error("TMDB_API_KEY is not set in Supabase Edge Function Secrets");
  return key;
}

function supabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available to this function");
  }
  return createClient(url, serviceKey);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmdbFetch(path: string, params: Record<string, string | undefined>): Promise<any> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", tmdbApiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : BASE_BACKOFF_MS * 2 ** attempt;
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`TMDB ${path} returned ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("TMDB request failed after retries");
}

// Stable official TMDB genre list (movie). Source of truth if this ever
// drifts: GET /genre/movie/list. Hardcoded here since it changes rarely and
// avoids an extra API call on every invocation.
const GENRE_ID_TO_NAME: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
  10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
};

// --- Cursor encode/decode: year * 1000 + page ---
function decodeCursor(cursorOffset: number): { year: number; page: number } {
  if (!cursorOffset || cursorOffset <= 0) return { year: START_YEAR, page: 1 };
  return { year: Math.floor(cursorOffset / 1000), page: cursorOffset % 1000 };
}

function encodeCursor(year: number, page: number): number {
  return year * 1000 + page;
}

function nextCursor(year: number, page: number, hasMorePagesThisYear: boolean): { year: number; page: number; done: boolean } {
  if (hasMorePagesThisYear && page < TMDB_MAX_PAGE) {
    return { year: year, page: page + 1, done: false };
  }
  const nextYear = year - 1;
  if (nextYear < FLOOR_YEAR) {
    // Full sweep complete — wrap back to the top so re-runs pick up new
    // releases and re-check for TMDB metadata changes (vote counts, etc.).
    return { year: START_YEAR, page: 1, done: true };
  }
  return { year: nextYear, page: 1, done: false };
}

interface TmdbMovie {
  id: number;
  title: string;
  overview: string;
  release_date?: string;
  original_language?: string;
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  poster_path?: string | null;
}

async function fetchKeywords(movieId: number): Promise<{ id: number; name: string }[]> {
  try {
    const data = await tmdbFetch(`/movie/${movieId}/keywords`, {});
    return data.keywords ?? [];
  } catch {
    // A single title's keyword lookup failing shouldn't sink the whole batch.
    return [];
  }
}

Deno.serve(async (_req) => {
  try {
    const supabase = supabaseClient();

    // 1. Read cursor
    const { data: syncRow, error: syncReadError } = await supabase
      .from("movie_sync_state")
      .select("*")
      .eq("entity_type", "movie")
      .maybeSingle();
    if (syncReadError) throw syncReadError;

    const { year, page } = decodeCursor(syncRow?.cursor_offset ?? 0);

    // 2. Fetch one page of TMDB's catalog for that year
    const discoverData = await tmdbFetch("/discover/movie", {
      primary_release_year: String(year),
      sort_by: "popularity.desc",
      page: String(page),
    });

    const movies: TmdbMovie[] = discoverData.results ?? [];
    const totalPages: number = discoverData.total_pages ?? 1;

    // 3. Fetch keywords per movie (sequential — TMDB's free tier rate limit
    // doesn't tolerate high concurrency well; a page of 20 is small enough
    // that sequential calls stay well within an edge function's time budget).
    const keywordSeen = new Map<number, string>();
    const movieRows = [];
    for (const movie of movies) {
      const keywords = await fetchKeywords(movie.id);
      for (const kw of keywords) keywordSeen.set(kw.id, kw.name);

      const genreNames = (movie.genre_ids ?? []).map((id) => GENRE_ID_TO_NAME[id]).filter(Boolean);
      const keywordNames = keywords.map((k) => k.name);

      movieRows.push({
        entity_type: "movie",
        source_id: String(movie.id),
        name: movie.title,
        metadata: {
          overview: movie.overview,
          release_date: movie.release_date,
          original_language: movie.original_language,
          genre_ids: movie.genre_ids ?? [],
          genre_names: genreNames,
          keyword_ids: keywords.map((k) => k.id),
          vote_average: movie.vote_average,
          vote_count: movie.vote_count,
          popularity: movie.popularity,
          poster_path: movie.poster_path,
        },
        // Per the Architecture & UX Plan: title + overview + genre names + keyword names.
        // Cast/director deliberately excluded — those live as metadata, queried
        // directly, not embedded (see plan's "structured-lookup, not semantic" note).
        embedding_source_text: [movie.title, movie.overview, ...genreNames, ...keywordNames]
          .filter(Boolean)
          .join(" "),
        updated_at: new Date().toISOString(),
      });
    }

    const keywordRows = Array.from(keywordSeen.entries()).map(([id, name]) => ({
      entity_type: "keyword",
      source_id: String(id),
      name,
      metadata: {},
      updated_at: new Date().toISOString(),
    }));

    // 4. Upsert. embedding/embedding_source_text are left untouched on
    // conflict for keyword rows (no embedding field set), and overwritten
    // for movie rows so re-harvested titles pick up fresh TMDB metadata —
    // embeddings themselves are populated separately by backfill-movie-embeddings.
    if (movieRows.length > 0) {
      const { error } = await supabase.from("movie_entities").upsert(movieRows, {
        onConflict: "entity_type,source_id",
      });
      if (error) throw error;
    }
    if (keywordRows.length > 0) {
      const { error } = await supabase.from("movie_entities").upsert(keywordRows, {
        onConflict: "entity_type,source_id",
        ignoreDuplicates: true, // keyword rows are cheap lookups; don't fight embedding backfill for them
      });
      if (error) throw error;
    }

    // 5. Advance and persist cursor
    const { year: nYear, page: nPage, done } = nextCursor(year, page, page < totalPages);
    const { error: syncWriteError } = await supabase.from("movie_sync_state").upsert(
      {
        entity_type: "movie",
        cursor_offset: encodeCursor(nYear, nPage),
        last_max_id: (syncRow?.last_max_id ?? 0) + movieRows.length,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "entity_type" },
    );
    if (syncWriteError) throw syncWriteError;

    return new Response(
      JSON.stringify({
        harvested: { movies: movieRows.length, keywords: keywordRows.length },
        cursor: { processedYear: year, processedPage: page, totalPages },
        nextCursor: { year: nYear, page: nPage },
        fullSweepJustCompleted: done,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[harvest-movies] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

