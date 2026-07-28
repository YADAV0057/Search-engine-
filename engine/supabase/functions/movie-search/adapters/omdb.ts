// engine/supabase/functions/movie-search/adapters/omdb.ts
//
// OMDb adapter — fallback catalog source, used only when TMDB fails entirely
// (network error, 5xx, or exhausted retries). OMDb has no discover/filter
// endpoint, so this only supports title-text search, not language/provider/genre
// filtering — those filters are simply not applied when the waterfall falls
// back this far.

const OMDB_BASE = "https://www.omdbapi.com/";
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 400;

function apiKey(): string {
  const key = Deno.env.get("OMDB_API_KEY");
  if (!key) throw new Error("OMDB_API_KEY is not set in Supabase Edge Function Secrets");
  return key;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function omdbFetch(params: Record<string, string | undefined>): Promise<any> {
  const url = new URL(OMDB_BASE);
  url.searchParams.set("apikey", apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`OMDb returned ${res.status}: ${await res.text()}`);
      const data = await res.json();
      if (data.Response === "False") throw new Error(data.Error ?? "OMDb: no results");
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OMDb request failed after retries");
}

export interface OmdbMovie {
  imdbID: string;
  Title: string;
  Year: string;
  Plot?: string;
  Genre?: string;
  imdbRating?: string;
  Poster?: string;
}

// Normalized shape so index.ts / rankResults.js can treat OMDb results
// the same as TMDB results without branching on provider everywhere.
export interface NormalizedOmdbMovie {
  id: string; // imdbID, prefixed so it can't collide with TMDB numeric ids
  title: string;
  overview: string;
  release_date?: string;
  genre_ids?: number[]; // always empty — OMDb genres are free-text, not TMDB's enum
  genre_names?: string[];
  vote_average?: number;
  poster_path?: string | null;
  source: "omdb";
}

export async function searchMovies(searchText: string, page = 1): Promise<NormalizedOmdbMovie[]> {
  const data = await omdbFetch({ s: searchText, type: "movie", page: String(page) });
  const items = data.Search ?? [];

  // OMDb's search endpoint returns titles only, no plot — fetch full details
  // for each result so overview text is available for ranking/embeddings later.
  const detailed = await Promise.all(
    items.map((item: any) => omdbFetch({ i: item.imdbID, plot: "short" }).catch(() => null)),
  );

  return detailed
    .filter((d): d is OmdbMovie => d !== null)
    .map((d) => ({
      id: `omdb-${d.imdbID}`,
      title: d.Title,
      overview: d.Plot ?? "",
      release_date: d.Year,
      genre_ids: [],
      genre_names: d.Genre ? d.Genre.split(",").map((g) => g.trim()) : [],
      vote_average: d.imdbRating ? Number(d.imdbRating) : undefined,
      poster_path: d.Poster && d.Poster !== "N/A" ? d.Poster : null,
      source: "omdb" as const,
    }));
}

