// engine/supabase/functions/movie-search/adapters/tmdb.ts
//
// TMDB adapter — primary data source for movie-search.
// Mirrors the retry/backoff pattern used by the manga waterfall's anilistQuery(),
// applied to TMDB's endpoints instead. See Movie Search — Architecture & UX Plan (2026-07-28).

const TMDB_BASE = "https://api.themoviedb.org/3";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;

function apiKey(): string {
  const key = Deno.env.get("TMDB_API_KEY");
  if (!key) throw new Error("TMDB_API_KEY is not set in Supabase Edge Function Secrets");
  return key;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generic retry wrapper — mirrors the AniList retry/backoff pattern (waterfall-retry
// applied to a single provider's transient failures, not to be confused with the
// provider-level TMDB -> OMDb -> Trakt waterfall in index.ts).
async function tmdbFetch(path: string, params: Record<string, string | undefined>): Promise<any> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url.toString());

      if (res.status === 429) {
        // Rate limited — honor Retry-After if present, else exponential backoff.
        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : BASE_BACKOFF_MS * 2 ** attempt;
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`TMDB ${path} returned ${res.status}: ${await res.text()}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("TMDB request failed after retries");
}

export interface MovieDiscoverParams {
  /** Free-text query. When present, uses /search/movie instead of /discover/movie. */
  searchText?: string;
  /** ISO 639-1, e.g. "hi", "en" — TMDB with_original_language */
  language?: string;
  /** Comma-separated TMDB provider IDs — with_watch_providers */
  watchProviders?: string;
  /** ISO 3166-1, e.g. "IN", "US" — required alongside watchProviders */
  watchRegion?: string;
  /** Comma-separated TMDB genre IDs — with_genres */
  genres?: string;
  page?: number;
}

export interface TmdbMovie {
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
  backdrop_path?: string | null;
}

export async function discoverMovies(params: MovieDiscoverParams): Promise<TmdbMovie[]> {
  const page = String(params.page ?? 1);

  const data = params.searchText
    ? await tmdbFetch("/search/movie", {
        query: params.searchText,
        page,
        // /search/movie ignores with_original_language, so we filter client-side below.
      })
    : await tmdbFetch("/discover/movie", {
        with_original_language: params.language,
        with_watch_providers: params.watchProviders,
        watch_region: params.watchProviders ? (params.watchRegion ?? "US") : undefined,
        with_genres: params.genres,
        sort_by: "popularity.desc",
        page,
      });

  let results: TmdbMovie[] = data.results ?? [];

  // /search/movie has no language filter param, so apply it manually when both
  // a free-text query and a language filter were given together.
  if (params.searchText && params.language) {
    results = results.filter((m) => m.original_language === params.language);
  }

  return results;
}

export interface TmdbKeyword {
  id: number;
  name: string;
}

export async function getMovieKeywords(movieId: number): Promise<TmdbKeyword[]> {
  const data = await tmdbFetch(`/movie/${movieId}/keywords`, {});
  return data.keywords ?? [];
}

export interface WatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string;
  display_priority: number;
}

export interface WatchProviderResult {
  link?: string;
  flatrate?: WatchProvider[];
  rent?: WatchProvider[];
  buy?: WatchProvider[];
}

// Returns the region-specific provider block, e.g. result.IN or result.US.
export async function getWatchProviders(
  movieId: number,
  watchRegion: string,
): Promise<WatchProviderResult | null> {
  const data = await tmdbFetch(`/movie/${movieId}/watch/providers`, {});
  return data.results?.[watchRegion] ?? null;
}

export async function getMovieDetails(movieId: number): Promise<any> {
  return await tmdbFetch(`/movie/${movieId}`, { append_to_response: "credits" });
}

