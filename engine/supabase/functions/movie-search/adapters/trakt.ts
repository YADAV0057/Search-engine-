// engine/supabase/functions/movie-search/adapters/trakt.ts 
//
// Trakt adapter — optional last-resort fallback, used only if both TMDB and
// OMDb fail. Trakt's free API requires the trakt-api-version and
// trakt-api-key (client_id) headers rather than a query-string key.

const TRAKT_BASE = "https://api.trakt.tv";
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 400;

function clientId(): string {
  const id = Deno.env.get("TRAKT_CLIENT_ID");
  if (!id) throw new Error("TRAKT_CLIENT_ID is not set in Supabase Edge Function Secrets");
  return id;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function traktFetch(path: string, searchParams: Record<string, string | undefined>): Promise<any> {
  const url = new URL(`${TRAKT_BASE}${path}`);
  for (const [k, v] of Object.entries(searchParams)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: {
          "Content-Type": "application/json",
          "trakt-api-version": "2",
          "trakt-api-key": clientId(),
        },
      });
      if (!res.ok) throw new Error(`Trakt ${path} returned ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Trakt request failed after retries");
}

export interface NormalizedTraktMovie {
  id: string; // "trakt-<trakt id>", prefixed like OMDb ids to avoid collisions
  title: string;
  overview: string;
  release_date?: string;
  genre_names?: string[];
  vote_average?: number; // Trakt's rating is 0-10, same scale as TMDB
  poster_path?: null; // Trakt's free tier doesn't return images
  source: "trakt";
}

export async function searchMovies(searchText: string, page = 1): Promise<NormalizedTraktMovie[]> {
  const data = await traktFetch("/search/movie", {
    query: searchText,
    page: String(page),
    limit: "20",
    extended: "full",
  });

  return (data ?? []).map((entry: any) => {
    const m = entry.movie;
    return {
      id: `trakt-${m.ids.trakt}`,
      title: m.title,
      overview: m.overview ?? "",
      release_date: m.released,
      genre_names: m.genres ?? [],
      vote_average: m.rating,
      poster_path: null,
      source: "trakt" as const,
    };
  });
}
