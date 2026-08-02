// engine/supabase/functions/movie-search/resolveSemanticCandidates.ts
//
// Query-time semantic search for movies — the missing half of Entry 107's
// plan. Catalog-side on-demand embedding (embedOnDemand.ts) already existed
// and is live; this file is the query-time counterpart, mirroring the split
// manga's pipeline already has (domains.js's resolveSemanticCandidates() +
// match_media_by_embedding()).
//
// Embeds the free-text query via Gemini (reuses embedOnDemand.ts's
// embedText() directly — same key pair / fallback rule, so a query embedded
// here and a movie embedded by the catalog-side path land in the same
// vector space, byte-for-byte comparable), then calls
// match_movie_by_embedding() (new pgvector RPC, see
// migrations/create_match_movie_by_embedding.sql — exact mirror of manga's
// match_media_by_embedding(), scoped to movie_entities/entity_type='movie')
// to get the closest-embedded movies by cosine similarity.
//
// KNOWN LIMITATION, same class as manga's own semantic path (Entry 88's
// header note): candidates from this path are movie_entities rows, not
// fresh TMDB results — they carry title/overview/genre_names from whatever
// was embedded, NOT live vote_average/vote_count/poster_path/watch
// providers. rankResults.js's qualityScore() degrades safely to its bare
// prior when vote_average/vote_count are both undefined, and moodMatchScore/
// languageMatchScore/providerMatchScore all have neutral (0.5) fallbacks
// for missing fields — so a semantic-only candidate still ranks sanely, it
// just can't win on quality/provider/language signal it doesn't carry.
// Acceptable since text/genre/semantic match is the actual signal this
// feature targets.
//
// Fails closed on any error (returns []) — this is an additive signal on
// top of the existing TMDB waterfall, not a required one. A broken
// embedding call or RPC failure should degrade to TMDB-only results, not
// take the whole search down.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedText } from "./embedOnDemand.ts";

const MATCH_COUNT = 30;

export interface SemanticMovieCandidate {
  id: string;
  tmdbId: number;
  title: string;
  overview: string;
  release_date?: string;
  genre_ids: number[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  poster_path: null;
  backdrop_path: null;
  source: "semantic";
  mediaType: "movie";
  semanticScore: number;
}

// Inverse of movie-search/domains.js's GENRE_NAME_TO_ID — duplicated here
// for the same reason embedOnDemand.ts duplicates GENRE_ID_TO_NAME (not
// exported from domains.js, cheap to keep in sync, TMDB's genre list is a
// stable fixed taxonomy).
const GENRE_NAME_TO_ID: Record<string, number> = {
  action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80,
  documentary: 99, drama: 18, family: 10751, fantasy: 14, history: 36,
  horror: 27, music: 10402, mystery: 9648, romance: 10749,
  "science fiction": 878, thriller: 53, war: 10752, western: 37,
};

/**
 * Embeds the query and returns the closest-matching already-embedded movies
 * from movie_entities, shaped to merge directly into the candidate list
 * index.ts's TMDB waterfall produces (same field names rankMovies() already
 * reads: title, overview, genre_ids, release_date, semanticScore).
 *
 * Movie-only for now — movie_entities has no TV rows (embedOnDemand.ts is
 * also movie-only, see its own entity_type: "movie" upsert), so callers
 * should only invoke this for intent.mediaType === "movie".
 */
export async function resolveSemanticCandidates(
  query: string,
  supabase: SupabaseClient,
): Promise<SemanticMovieCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const embedding = await embedText(trimmed);
    if (!embedding) return [];

    const { data, error } = await supabase.rpc("match_movie_by_embedding", {
      query_embedding: embedding,
      match_count: MATCH_COUNT,
    });

    if (error) {
      console.error("[resolveSemanticCandidates] RPC failed:", error);
      return [];
    }
    if (!data?.length) return [];

    return data.map((row: any) => {
      const genreNames: string[] = row.metadata?.genre_names ?? [];
      const genreIds = genreNames
        .map((n: string) => GENRE_NAME_TO_ID[n.toLowerCase()])
        .filter((id: number | undefined): id is number => typeof id === "number");

      return {
        id: `tmdb-${row.source_id}`,
        tmdbId: Number(row.source_id),
        title: row.name,
        overview: row.metadata?.overview ?? "",
        release_date: row.metadata?.release_date,
        genre_ids: genreIds,
        poster_path: null,
        backdrop_path: null,
        source: "semantic" as const,
        mediaType: "movie" as const,
        semanticScore: row.similarity,
      };
    });
  } catch (err) {
    console.error("[resolveSemanticCandidates] threw:", err);
    return [];
  }
}
