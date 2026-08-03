// engine/supabase/functions/movie-search/adapters/tmdb.ts
//
// TMDB adapter — primary data source for movie-search.
// Mirrors the retry/backoff pattern used by the manga waterfall's anilistQuery(),
// applied to TMDB's endpoints instead. See Movie Search — Architecture & UX Plan (2026-07-28).
//
// STAGE 3 (2026-08-02): discoverMovies() previously routed to /search/movie
// (literal title/overview text search) any time `searchText` was present,
// regardless of whether the query was actually a mood expression. That's why
// "sad movie" only ever surfaced titles that literally contained the word
// "sad" — the candidate pool itself was already filtered by TMDB's text
// search before movie-search's own mood/genre ranking ever got a chance to
// run. Now a `moodOnlyQuery` flag (set upstream in domains.js when the query
// is pure mood with nothing else distinguishing left over) routes retrieval
// through /discover/movie with the matched genres instead, same as a
// genre-chip browse. See domains.js's header note for the full writeup.
//
// TV SUPPORT FIX (2026-08-02): index.ts's TV support (2026-08-01) and anime
// filter (2026-08-02) were written against a `discoverTv()` / `TmdbTv` /
// `MediaType` surface on this adapter, and against a 3-arg
// `getWatchProviders(mediaType, id, watchRegion)` — but this file was never
// updated to match. Concretely, in production that meant:
//   1. Any `mediaType: "tv"` request threw `tmdb.discoverTv is not a
//      function`, uncaught by runWaterfall's TV branch (which has no
//      try/catch — TMDB is the only tier for TV, there's nothing to fall
//      back to) — every TV search returned a 500.
//   2. index.ts's attachWatchProviders() called the old 2-arg
//      getWatchProviders(movieId, watchRegion) as if it were
//      getWatchProviders(mediaType, tmdbId, watchRegion) — so `mediaType`
//      (the string "movie") landed in the `movieId` param and `tmdbId`
//      landed in `watchRegion`. The resulting TMDB request
//      (`/movie/movie/watch/providers`) always failed, silently caught by
//      attachWatchProviders' try/catch, so `watchProviders` came back null
//      on every single movie search, not just TV.
// This fix adds discoverTv()/TmdbTv/MediaType and repoints getWatchProviders
// at the 3-arg (mediaType, id, watchRegion) shape index.ts already expects,
// mirroring discoverMovies()'s /search vs /discover routing for the /tv
// equivalents. TV has no moodOnlyQuery-style mood routing (Stage 3 was
// scoped to movies only, since movie_keyword_signatures has no TV rows) —
// this only closes the mediaType/getWatchProviders mismatch.

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

// TV SUPPORT FIX (2026-08-02): shared media-type discriminator, used by
// getWatchProviders() below to pick /movie/ vs /tv/ and by index.ts's
// attachWatchProviders()/isAnime() call sites.
export type MediaType = "movie" | "tv";

export interface MovieDiscoverParams {
  /** Free-text query. When present (and moodOnlyQuery isn't true), uses /search/movie instead of /discover/movie. */
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
  /**
   * STAGE 3: set by domains.js when the query is a pure mood expression
   * (e.g. "sad movie") with a matched keyword signature and nothing else
   * distinguishing left over. Forces retrieval through /discover/movie
   * (filtered by `genres`, derived from the matched signature) instead of
   * /search/movie, even though `searchText` is also set — searchText is
   * still passed through untouched for downstream text-relevance ranking
   * in rankResults.js, it just isn't used for TMDB retrieval itself here.
   */
  moodOnlyQuery?: boolean;
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

  // STAGE 3: mood-only queries always go through /discover/movie (genre-based
  // discovery) rather than /search/movie (literal title/overview text
  // search), even though searchText is populated — see header note.
  const useDiscover = !params.searchText || params.moodOnlyQuery;

  const data = useDiscover
    ? await tmdbFetch("/discover/movie", {
        with_original_language: params.language,
        with_watch_providers: params.watchProviders,
        watch_region: params.watchProviders ? (params.watchRegion ?? "US") : undefined,
        with_genres: params.genres,
        sort_by: "popularity.desc",
        page,
      })
    : await tmdbFetch("/search/movie", {
        query: params.searchText,
        page,
        // /search/movie ignores with_original_language. We intentionally do NOT
        // filter client-side here — see note below.
      });

  const results: TmdbMovie[] = data.results ?? [];

  // Previously this hard-filtered out any result whose original_language
  // didn't match params.language when both a free-text query and a language
  // filter were given together. That's wrong for a market where dubbed
  // content is the norm: a movie like Baahubali is tagged original_language
  // "te" (Telugu) in TMDB, so searching "Bahubali" + language=hi returned
  // zero results even though the Hindi dub is what most users mean.
  //
  // Language filtering for /search/movie is now handled entirely downstream
  // by rankResults.js's languageMatchScore, as a soft ranking signal (movies
  // matching the requested language rank higher) rather than a hard exclude.
  // /discover/movie (the useDiscover branch above — no-searchText OR
  // moodOnlyQuery as of Stage 3) still applies with_original_language
  // server-side as a real filter, since that's a deliberate "browse this
  // language/mood" flow, not a title search.
  return results;
}

// TV SUPPORT FIX (2026-08-02): TV equivalent of TmdbMovie — TMDB's /tv
// endpoints return `name`/`first_air_date` instead of `title`/`release_date`,
// everything else lines up 1:1. index.ts's normalizeTmdbTv() maps this into
// the same output shape as normalizeTmdbMovie() so the rest of the pipeline
// (rankResults.js, the frontend) never has to branch on mediaType.
export interface TmdbTv {
  id: number;
  name: string;
  overview: string;
  first_air_date?: string;
  original_language?: string;
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

// TV SUPPORT FIX (2026-08-02): intentionally no `moodOnlyQuery` field here —
// Stage 3's mood routing is movie-only (movie_keyword_signatures has no TV
// rows, see domains.js), so index.ts never passes it for TV requests.
export interface TvDiscoverParams {
  /** Free-text query. When present, uses /search/tv instead of /discover/tv. */
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

// TV SUPPORT FIX (2026-08-02): mirrors discoverMovies()'s /search vs
// /discover routing for the /tv equivalents. See this file's header note —
// this function didn't exist at all before, which is what made every TV
// search 500.
export async function discoverTv(params: TvDiscoverParams): Promise<TmdbTv[]> {
  const page = String(params.page ?? 1);
  const useSearch = Boolean(params.searchText);

  const data = useSearch
    ? await tmdbFetch("/search/tv", {
        query: params.searchText,
        page,
      })
    : await tmdbFetch("/discover/tv", {
        with_original_language: params.language,
        with_watch_providers: params.watchProviders,
        watch_region: params.watchProviders ? (params.watchRegion ?? "US") : undefined,
        with_genres: params.genres,
        sort_by: "popularity.desc",
        page,
      });

  return (data.results ?? []) as TmdbTv[];
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

// TV SUPPORT FIX (2026-08-02): now takes `mediaType` as its first argument so
// it can hit /movie/{id}/watch/providers or /tv/{id}/watch/providers — matches
// the 3-arg call already made by index.ts's attachWatchProviders(). The
// previous 2-arg (movieId, watchRegion) signature meant that call's first two
// arguments (mediaType, tmdbId) were silently shifted into the wrong
// parameters — see this file's header note for the exact failure mode this
// was producing in production (watch providers coming back null on every
// movie search).
export async function getWatchProviders(
  mediaType: MediaType,
  id: number,
  watchRegion: string,
): Promise<WatchProviderResult | null> {
  const path = mediaType === "tv" ? `/tv/${id}/watch/providers` : `/movie/${id}/watch/providers`;
  const data = await tmdbFetch(path, {});
  return data.results?.[watchRegion] ?? null;
}

export async function getMovieDetails(movieId: number): Promise<any> {
  return await tmdbFetch(`/movie/${movieId}`, { append_to_response: "credits" });
}
