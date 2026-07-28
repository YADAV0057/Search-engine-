// engine/supabase/functions/movie-search/rankResults.js
//
// Movie-specific ranker. Deliberately NOT shared with manga's rankResults.js —
// see Movie Search — Architecture & UX Plan (2026-07-28). Signal set is
// movie-native: popularity/vote signal, language match, provider match,
// text-overlap relevance, and (once wired) semantic similarity.
//
// IMPORTANT: ships with the hasAnySemanticScore gate from day one. Entry 90
// found manga's ranker was burning 30% of ranking weight on semantic score
// even when zero candidates in a batch had an embedding yet, discovered
// after the fact. Embeddings aren't wired for movies yet (Stage 1), so
// every candidate's semanticScore will be null/undefined right now —
// this gate is what keeps that from silently zeroing out 30% of the score.

const WEIGHTS = {
  textRelevance: 0.35,
  quality: 0.25, // vote_average / vote_count blended
  languageMatch: 0.15,
  providerMatch: 0.1,
  semantic: 0.15, // redistributed to the other four when unavailable
};

function normalizeText(s) {
  return (s ?? "").toLowerCase();
}

// Cheap term-overlap relevance — stands in for real text relevance until
// embeddings land. Counts fraction of query terms found in title+overview.
function textRelevanceScore(movie, queryTerms) {
  if (!queryTerms.length) return 0.5; // neutral when there's no free-text query at all
  const haystack = normalizeText(movie.title) + " " + normalizeText(movie.overview);
  const hits = queryTerms.filter((t) => haystack.includes(t)).length;
  return hits / queryTerms.length;
}

// Bayesian-ish quality score so a 9.0/2-votes title doesn't outrank an
// 8.0/50000-votes title. Same shape as manga's qualityScore() blending idea.
function qualityScore(movie) {
  const voteAverage = movie.vote_average ?? 0;
  const voteCount = movie.vote_count ?? 0;
  const PRIOR_MEAN = 6.0;
  const PRIOR_WEIGHT = 20;
  const bayesian = (PRIOR_WEIGHT * PRIOR_MEAN + voteCount * voteAverage) / (PRIOR_WEIGHT + voteCount);
  return bayesian / 10; // normalize to 0-1
}

function languageMatchScore(movie, language) {
  if (!language) return 0.5; // neutral when no language filter was requested
  return movie.original_language === language ? 1 : 0;
}

function providerMatchScore(movie, requestedProviderIds) {
  if (!requestedProviderIds?.length) return 0.5; // neutral when no provider filter was requested
  const movieProviderIds = (movie.watchProviders?.flatrate ?? []).map((p) => p.provider_id);
  const hasMatch = requestedProviderIds.some((id) => movieProviderIds.includes(Number(id)));
  return hasMatch ? 1 : 0;
}

/**
 * Ranks a list of normalized movie candidates against the parsed intent.
 *
 * @param {Array} movies - normalized candidates (TMDB/OMDb/Trakt shape, plus
 *   optional `semanticScore` once embeddings are wired and `watchProviders`
 *   once attached by index.ts)
 * @param {object} intent - output of domains.parseMovieQuery()
 */
export function rankMovies(movies, intent) {
  const queryTerms = (intent.searchText ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const requestedProviderIds = intent.watchProviders ? intent.watchProviders.split(",") : [];

  // --- hasAnySemanticScore gate ---
  // Only trust the semantic weight if at least one candidate in THIS batch
  // actually has a semantic score. Otherwise redistribute that weight
  // proportionally across the other signals so the semantic slot doesn't
  // silently zero out part of every candidate's score.
  const hasAnySemanticScore = movies.some(
    (m) => typeof m.semanticScore === "number" && !Number.isNaN(m.semanticScore),
  );

  const activeWeights = hasAnySemanticScore
    ? WEIGHTS
    : (() => {
        const { semantic, ...rest } = WEIGHTS;
        const redistributionFactor = 1 / (1 - semantic);
        const scaled = {};
        for (const [k, v] of Object.entries(rest)) scaled[k] = v * redistributionFactor;
        return { ...scaled, semantic: 0 };
      })();

  const scored = movies.map((movie) => {
    const textScore = textRelevanceScore(movie, queryTerms);
    const quality = qualityScore(movie);
    const langScore = languageMatchScore(movie, intent.language);
    const providerScore = providerMatchScore(movie, requestedProviderIds);
    const semanticScore = hasAnySemanticScore ? (movie.semanticScore ?? 0) : 0;

    const finalScore =
      textScore * activeWeights.textRelevance +
      quality * activeWeights.quality +
      langScore * activeWeights.languageMatch +
      providerScore * activeWeights.providerMatch +
      semanticScore * activeWeights.semantic;

    return { ...movie, _rank: { textScore, quality, langScore, providerScore, semanticScore, finalScore } };
  });

  scored.sort((a, b) => b._rank.finalScore - a._rank.finalScore);
  return scored;
}

