// engine/supabase/functions/movie-search/rankResults.js
//
// Movie-specific ranker. Deliberately NOT shared with manga's rankResults.js —
// see Movie Search — Architecture & UX Plan (2026-07-28). Signal set is
// movie-native: popularity/vote signal, language match, provider match,
// text-overlap relevance, mood/keyword-signature match, and (once wired)
// semantic similarity.
//
// STAGE 2 (2026-07-31): moodMatch replaces part of what textRelevance was
// being asked to do alone. Previously a query like "sad movies" only had
// literal title/overview substring matching to work with (textRelevanceScore),
// which is why it surfaced a movie with "Sad" literally in its title instead
// of an actually sad movie — see the bug writeup this entry fixes. Now that
// domains.js's keywordSignature is populated (movie_keyword_signatures ->
// genre_weights), this file uses it as a weighted genre-boost signal,
// following the exact same "only trust it if a candidate actually has it"
// gating pattern as hasAnySemanticScore below (kept for embeddings, still
// not wired — Phase 4).

const WEIGHTS = {
  textRelevance: 0.25,
  quality: 0.2, // vote_average / vote_count blended
  languageMatch: 0.15,
  providerMatch: 0.1,
  moodMatch: 0.15, // genre-weighted keyword-signature match; redistributed when no signature matched the query
  semantic: 0.15, // redistributed to the other five when unavailable (embeddings not wired yet — Phase 4)
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

// Weighted overlap between a movie's TMDB genre ids and the query's matched
// keyword-signature genre_weights (already normalized 0-1 by domains.js).
// Takes the movie's best-matching genre rather than averaging across all of
// them, so a Drama+Comedy movie scores well on a "sad" query (which boosts
// Drama) even though Comedy contributes nothing.
function moodMatchScore(movie, keywordSignature) {
  if (!keywordSignature) return 0; // handled by the gate below — never actually used unweighted
  const genreIds = movie.genre_ids ?? [];
  if (!genreIds.length) return 0;
  let best = 0;
  for (const id of genreIds) {
    const w = keywordSignature.genreWeights[id];
    if (typeof w === "number" && w > best) best = w;
  }
  return best;
}

/**
 * Ranks a list of normalized movie candidates against the parsed intent.
 *
 * @param {Array} movies - normalized candidates (TMDB/OMDb/Trakt shape, plus
 *   optional `semanticScore` once embeddings are wired and `watchProviders`
 *   once attached by index.ts). TMDB candidates carry `genre_ids` (added
 *   Stage 2) which moodMatchScore reads.
 * @param {object} intent - output of domains.parseMovieQuery()
 */
export function rankMovies(movies, intent) {
  const queryTerms = (intent.searchText ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const requestedProviderIds = intent.watchProviders ? intent.watchProviders.split(",") : [];

  // --- hasAnySemanticScore gate (Phase 4, not yet wired — kept as-is) ---
  const hasAnySemanticScore = movies.some(
    (m) => typeof m.semanticScore === "number" && !Number.isNaN(m.semanticScore),
  );

  // --- hasKeywordSignature gate ---
  // Only spend moodMatch weight when the query actually resolved to a
  // keyword signature (e.g. "sad movies" -> Drama boost). A query with no
  // mood match (plain browsing, explicit genre chips, a plot-search query
  // like "movie about a submarine") gets that weight redistributed instead
  // of silently scoring every candidate 0 on a signal that was never real
  // for this request — same lesson as Entry 90's hasAnySemanticScore gate.
  const hasKeywordSignature = intent.keywordSignature != null;

  const inactiveSignals = [
    !hasKeywordSignature && "moodMatch",
    !hasAnySemanticScore && "semantic",
  ].filter(Boolean);

  const activeWeights = (() => {
    if (inactiveSignals.length === 0) return WEIGHTS;
    const inactiveTotal = inactiveSignals.reduce((sum, k) => sum + WEIGHTS[k], 0);
    const redistributionFactor = 1 / (1 - inactiveTotal);
    const scaled = {};
    for (const [k, v] of Object.entries(WEIGHTS)) {
      scaled[k] = inactiveSignals.includes(k) ? 0 : v * redistributionFactor;
    }
    return scaled;
  })();

  const scored = movies.map((movie) => {
    const textScore = textRelevanceScore(movie, queryTerms);
    const quality = qualityScore(movie);
    const langScore = languageMatchScore(movie, intent.language);
    const providerScore = providerMatchScore(movie, requestedProviderIds);
    const moodScore = hasKeywordSignature ? moodMatchScore(movie, intent.keywordSignature) : 0;
    const semanticScore = hasAnySemanticScore ? (movie.semanticScore ?? 0) : 0;

    const finalScore =
      textScore * activeWeights.textRelevance +
      quality * activeWeights.quality +
      langScore * activeWeights.languageMatch +
      providerScore * activeWeights.providerMatch +
      moodScore * activeWeights.moodMatch +
      semanticScore * activeWeights.semantic;

    return {
      ...movie,
      _rank: { textScore, quality, langScore, providerScore, moodScore, semanticScore, finalScore },
    };
  });

  scored.sort((a, b) => b._rank.finalScore - a._rank.finalScore);
  return scored;
}
