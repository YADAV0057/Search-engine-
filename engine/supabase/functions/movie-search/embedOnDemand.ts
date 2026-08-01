// engine/supabase/functions/movie-search/embedOnDemand.ts
//
// On-demand embedding. When a search returns TMDB movies that don't yet
// have an embedding in movie_entities (either the row doesn't exist yet, or
// backfill-movie-embeddings just hasn't reached it), embed them right then
// instead of waiting for the next cron pass over movie_entities.
//
// Called from index.ts via EdgeRuntime.waitUntil() AFTER the search
// response has already been returned to the user — this never adds latency
// to a search, it just means the *next* search for the same title (or any
// future semantic/mood-boosted ranking that reads embeddings) benefits from
// it. Fire-and-forget by design.
//
// Deliberately mirrors backfill-movie-embeddings/index.ts's source-text
// shape ("title. overview Genres: g1, g2. Keywords: k1, k2.") and Gemini
// key fallback pattern (GEMINI_API_KEY2 -> GEMINI_API_KEY3 on 429) so a
// movie embedded here and one embedded by the cron backfill land in the
// same vector space, byte-for-byte comparable. Not extracted into a shared
// module — matches this codebase's existing convention (see domains.js /
// rankResults.js header notes) of small deliberate duplication over
// cross-file sharing between manga and movie domains.
//
// Requires GEMINI_API_KEY2 (and ideally GEMINI_API_KEY3 as fallback) to be
// set as Edge Function secrets on THIS function too — same env vars
// backfill-movie-embeddings already uses, just also read here.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as tmdb from "./adapters/tmdb.ts";

const GEMINI_API_KEY2 = Deno.env.get("GEMINI_API_KEY2");
const GEMINI_API_KEY3 = Deno.env.get("GEMINI_API_KEY3");
const EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

const OVERVIEW_MAX_CHARS = 1500;
const CALL_GAP_MS = 300; // same politeness gap as backfill-movie-embeddings

// TMDB's genre id -> name map (fixed, stable taxonomy). Inverse of
// domains.js's GENRE_NAME_TO_ID — duplicated here since that map isn't
// exported from domains.js. Cheap to keep in sync; TMDB rarely changes it.
const GENRE_ID_TO_NAME: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
  878: "Science Fiction", 53: "Thriller", 10752: "War", 37: "Western",
};

interface EmbedCandidate {
  tmdbId: number;
  title: string;
  overview: string;
  release_date?: string;
  genre_ids?: number[];
}

async function callGeminiEmbed(
  apiKey: string,
  text: string,
): Promise<{ ok: true; embedding: number[] } | { ok: false; status?: number }> {
  const res = await fetch(`${EMBED_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] }, output_dimensionality: 768 }),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  const values = data?.embedding?.values ?? null;
  if (!values) return { ok: false, status: res.status };
  return { ok: true, embedding: values as number[] };
}

// Same primary/fallback rule as backfill-movie-embeddings: key3 is only
// used on a 429 from key2, not on other failure types.
async function embedText(text: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY2 && !GEMINI_API_KEY3) {
    console.error("[embedOnDemand] neither GEMINI_API_KEY2 nor GEMINI_API_KEY3 is set");
    return null;
  }
  if (GEMINI_API_KEY2) {
    const primary = await callGeminiEmbed(GEMINI_API_KEY2, text);
    if (primary.ok) return primary.embedding;
    if (primary.status !== 429) {
      console.error("[embedOnDemand] key2 non-429 failure", primary.status);
      return null;
    }
  }
  if (GEMINI_API_KEY3) {
    const fallback = await callGeminiEmbed(GEMINI_API_KEY3, text);
    if (fallback.ok) return fallback.embedding;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Embeds any of the given TMDB search-result movies that aren't already
 * embedded in movie_entities, then upserts them. Intended to be passed to
 * EdgeRuntime.waitUntil() so it runs after the search response has already
 * gone out — never awaited by the request itself.
 */
export async function embedMissingMovies(movies: EmbedCandidate[], supabase: SupabaseClient) {
  if (!movies.length) return;

  const sourceIds = movies.map((m) => String(m.tmdbId));

  // Only skip movies that already have an embedding — a row can exist
  // (written by harvest-movies) without one yet, so we check the embedding
  // column specifically, not just row existence.
  const { data: existing, error } = await supabase
    .from("movie_entities")
    .select("source_id")
    .eq("entity_type", "movie")
    .in("source_id", sourceIds)
    .not("embedding", "is", null);

  if (error) {
    console.error("[embedOnDemand] existing-embedding lookup failed", error);
    return;
  }

  const alreadyEmbedded = new Set((existing ?? []).map((r) => r.source_id));
  const toEmbed = movies.filter((m) => !alreadyEmbedded.has(String(m.tmdbId)));
  if (!toEmbed.length) return;

  for (const movie of toEmbed) {
    try {
      // Keywords aren't in TMDB's search-result payload, only in the
      // per-movie /keywords endpoint — worth the extra call here since
      // this only runs once per movie, ever (next search finds it embedded).
      const keywords = await tmdb.getMovieKeywords(movie.tmdbId).catch(() => []);
      const genreNames = (movie.genre_ids ?? [])
        .map((id) => GENRE_ID_TO_NAME[id])
        .filter((n): n is string => Boolean(n));
      const cleanOverview = (movie.overview ?? "")
        .replace(/https?:\/\/\S+/g, "")
        .trim()
        .slice(0, OVERVIEW_MAX_CHARS);

      const sourceText =
        `${movie.title}. ${cleanOverview}` +
        (genreNames.length ? ` Genres: ${genreNames.join(", ")}.` : "") +
        (keywords.length ? ` Keywords: ${keywords.map((k) => k.name).join(", ")}.` : "");

      const embedding = await embedText(sourceText);
      if (!embedding) {
        await sleep(CALL_GAP_MS);
        continue;
      }

      const { error: upsertError } = await supabase.from("movie_entities").upsert(
        {
          entity_type: "movie",
          source_id: String(movie.tmdbId),
          name: movie.title,
          normalized_name: movie.title.toLowerCase().trim(),
          metadata: {
            overview: movie.overview,
            genre_names: genreNames,
            release_date: movie.release_date,
          },
          embedding,
          embedding_source_text: sourceText,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "entity_type,source_id" },
      );

      if (upsertError) {
        console.error("[embedOnDemand] upsert failed for", movie.tmdbId, upsertError);
      }
    } catch (err) {
      console.error("[embedOnDemand] failed for", movie.tmdbId, err);
    }
    await sleep(CALL_GAP_MS);
  }
}
