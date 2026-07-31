// engine/supabase/functions/movie-search/domains.js
//
// Movie-specific query planning. Deliberately NOT shared with manga's domains.js —
// see Movie Search — Architecture & UX Plan (2026-07-28) for why.
//
// STAGE 2 (2026-07-31): keyword-signature (mood) matching is now wired in.
// Previously `keywordSignature` was a permanent stub (`null`) — see git blame /
// Prioritized Next Steps (2026-07-31) item #1/#4. This resolves the free-text
// query against `movie_keyword_signatures` (genre_weights per matched mood term)
// so queries like "sad movies" or "funny movies" get real genre-weighted
// boosting instead of falling through to literal title/overview substring
// matching in rankResults.js. Falls back to the old text-only behavior
// (keywordSignature: null) if no signature rows match or supabase isn't passed.
//
// Pattern borrowed from the manga pipeline (exclusion-term parsing, reference-title
// detection) — not the code, per Entry 89/90's lesson.

// Minimal TMDB genre name -> id map for the launch set. Extend as needed;
// TMDB's /genre/movie/list endpoint is the source of truth if this drifts.
const GENRE_NAME_TO_ID = {
  action: 28,
  adventure: 12,
  animation: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  fantasy: 14,
  history: 36,
  horror: 27,
  music: 10402,
  mystery: 9648,
  romance: 10749,
  "sci-fi": 878,
  "science fiction": 878,
  thriller: 53,
  war: 10752,
  western: 37,
};

// Words that signal the user wants to EXCLUDE a term rather than match it,
// e.g. "thriller but not gory". Mirrors the exclusion-term parsing pattern
// already proven on the manga side.
const EXCLUSION_MARKERS = ["not", "no", "without", "except", "excluding"];

function extractExclusions(rawQuery) {
  const tokens = rawQuery.toLowerCase().split(/\s+/);
  const exclusions = [];
  const keepTokens = [];

  for (let i = 0; i < tokens.length; i++) {
    if (EXCLUSION_MARKERS.includes(tokens[i]) && tokens[i + 1]) {
      exclusions.push(tokens[i + 1]);
      i++; // skip the excluded term itself
      continue;
    }
    keepTokens.push(tokens[i]);
  }

  return { cleanedQuery: keepTokens.join(" ").trim(), exclusions };
}

function matchGenresInText(text) {
  const lower = text.toLowerCase();
  const ids = [];
  for (const [name, id] of Object.entries(GENRE_NAME_TO_ID)) {
    if (lower.includes(name) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Stopwords stripped before we look for mood/keyword-signature matches, so
// "sad movies" and "funny movie" reduce to the actual mood token ("sad",
// "funny") rather than requiring the literal phrase "sad movies" to exist
// as a row. This is intentionally tiny — just enough to unblock the common
// "<mood> movie(s)" / "<mood> film(s)" phrasing seen in QA — not a general
// stopword list.
const NOISE_WORDS = new Set(["movie", "movies", "film", "films", "a", "some", "please", "me", "show", "find"]);

function candidateMoodTokens(cleanedQuery) {
  const words = cleanedQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w));

  // Both individual words and the full stripped phrase are candidates —
  // covers single-word moods ("sad") and multi-word signature terms already
  // seeded ("mind bending", "coming of age") without requiring "movies" etc.
  // to have been stripped out of THOSE first (they don't contain noise words).
  const phrase = words.join(" ");
  const tokens = new Set(words);
  if (phrase) tokens.add(phrase);
  // Also try the raw cleaned query un-stripped, in case a seeded term
  // legitimately contains a noise word (none currently do, but cheap to cover).
  if (cleanedQuery.trim()) tokens.add(cleanedQuery.trim().toLowerCase());
  return [...tokens].filter(Boolean);
}

/**
 * Looks up `movie_keyword_signatures` for any row whose normalized_term or
 * aliases match a token/phrase derived from the query. Merges genre_weights
 * across all matches (summed) into TMDB genre ids for use by the ranker.
 *
 * Returns null (not an empty object) when nothing matches, so callers can
 * cheaply check `if (keywordSignature)` — mirrors rankResults.js's existing
 * hasAnySemanticScore-style "only trust this signal if it's actually present"
 * gating pattern.
 */
async function matchKeywordSignature(supabase, cleanedQuery) {
  if (!supabase || !cleanedQuery) return null;

  const tokens = candidateMoodTokens(cleanedQuery);
  if (tokens.length === 0) return null;

  try {
    const { data, error } = await supabase
      .from("movie_keyword_signatures")
      .select("normalized_term, term, aliases, genre_weights, tag_weights")
      .or(`normalized_term.in.(${tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(",")}),aliases.ov.{${tokens.map((t) => t.replace(/[{},]/g, "")).join(",")}}`);

    if (error) {
      console.error("[movie-search/domains] keyword-signature lookup failed:", error);
      return null;
    }
    if (!data || data.length === 0) return null;

    // Merge genre_weights across every matched signature row (summed, not
    // averaged — a query matching two moods that both point at Drama should
    // boost Drama more than a query matching only one).
    const genreWeights = {};
    const matchedTerms = [];
    for (const row of data) {
      matchedTerms.push(row.normalized_term);
      for (const [genreName, weight] of Object.entries(row.genre_weights ?? {})) {
        const id = GENRE_NAME_TO_ID[genreName.toLowerCase()];
        if (id == null) continue; // seeded genre name doesn't map to a known TMDB id — skip rather than guess
        genreWeights[id] = (genreWeights[id] ?? 0) + Number(weight ?? 0);
      }
    }

    if (Object.keys(genreWeights).length === 0) return null;

    // Normalize to 0-1 so rankResults.js can treat this the same shape as
    // any other 0-1 signal, same convention as textRelevanceScore/qualityScore.
    const maxWeight = Math.max(...Object.values(genreWeights));
    const normalizedGenreWeights = {};
    for (const [id, w] of Object.entries(genreWeights)) {
      normalizedGenreWeights[id] = maxWeight > 0 ? w / maxWeight : 0;
    }

    return { matchedTerms, genreWeights: normalizedGenreWeights };
  } catch (err) {
    // A broken mood lookup should degrade to the old text-only behavior,
    // not take the whole search request down with it.
    console.error("[movie-search/domains] keyword-signature lookup threw:", err);
    return null;
  }
}

/**
 * Parses the incoming request into a structured search intent.
 *
 * @param {object} input
 * @param {string} [input.query] - free-text mood/keyword query
 * @param {string} [input.language] - explicit language filter chip (ISO 639-1)
 * @param {string} [input.watchProviders] - explicit provider filter chip (comma-separated TMDB provider IDs)
 * @param {string} [input.watchRegion] - explicit region override (ISO 3166-1), defaults to auto-detected region upstream
 * @param {string} [input.genres] - explicit genre filter chip (comma-separated TMDB genre IDs)
 * @param {number} [input.page]
 * @param {import('@supabase/supabase-js').SupabaseClient} [supabase] - passed by index.ts so
 *   keyword-signature matching can query movie_keyword_signatures. Optional so
 *   parseMovieQuery still works (minus mood matching) if ever called without it.
 */
export async function parseMovieQuery(input, supabase) {
  const rawQuery = (input.query ?? "").trim();
  const { cleanedQuery, exclusions } = rawQuery ? extractExclusions(rawQuery) : { cleanedQuery: "", exclusions: [] };

  // Explicit filter chips always win over anything inferred from free text.
  const inferredGenreIds = input.genres ? [] : matchGenresInText(cleanedQuery);

  const keywordSignature = input.genres ? null : await matchKeywordSignature(supabase, cleanedQuery);

  return {
    searchText: cleanedQuery || undefined,
    rawQuery,
    exclusions,
    language: input.language || undefined,
    watchProviders: input.watchProviders || undefined,
    watchRegion: input.watchRegion || undefined,
    genres: input.genres || (inferredGenreIds.length ? inferredGenreIds.join(",") : undefined),
    page: input.page ?? 1,
    // Real as of Stage 2 (2026-07-31) — see matchKeywordSignature() above.
    // Shape: { matchedTerms: string[], genreWeights: { [tmdbGenreId]: 0-1 } } | null
    keywordSignature,
  };
}
