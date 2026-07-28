// engine/supabase/functions/movie-search/domains.js
//
// Movie-specific query planning. Deliberately NOT shared with manga's domains.js —
// see Movie Search — Architecture & UX Plan (2026-07-28) for why. This is Stage 1
// (waterfall + filters skeleton): mood/keyword-signature parsing is intentionally
// a stub here and gets filled in once the trope_signatures-equivalent
// (keyword-signature) harvest for movies exists.
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
 */
export function parseMovieQuery(input) {
  const rawQuery = (input.query ?? "").trim();
  const { cleanedQuery, exclusions } = rawQuery ? extractExclusions(rawQuery) : { cleanedQuery: "", exclusions: [] };

  // Explicit filter chips always win over anything inferred from free text.
  const inferredGenreIds = input.genres ? [] : matchGenresInText(cleanedQuery);

  return {
    searchText: cleanedQuery || undefined,
    rawQuery,
    exclusions,
    language: input.language || undefined,
    watchProviders: input.watchProviders || undefined,
    watchRegion: input.watchRegion || undefined,
    genres: input.genres || (inferredGenreIds.length ? inferredGenreIds.join(",") : undefined),
    page: input.page ?? 1,
    // Populated once the movie keyword-signature system (Stage 2) lands.
    // Kept as an explicit stub field now so rankResults.js has a stable
    // shape to check against (see hasAnySemanticScore gate).
    keywordSignature: null,
  };
}

