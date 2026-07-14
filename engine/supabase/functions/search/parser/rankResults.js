// parser/rankResults.js
//
// Query-adaptive ranking. Replaces the idea of a single fixed formula
// (0.45 emotion + 0.35 genre + 0.20 popularity) with weights derived from
// the Query Classifier's own per-category scores (see §10, rankCategories()).
// Rationale: a title search like "berserk" shouldn't be dragged around by
// genre/popularity, and a pure mood search like "I'm feeling lonely" has no
// genre signal to weight in the first place. Reuses classifyQuery() +
// getRoutingForMood() + fuzzyMatch.js's similarity() instead of inventing
// new scoring machinery.
//
// Drops in next to applyMoodBoost() in domains.js. Does not replace it —
// applyMoodBoost() still does the hard-filter exclude step earlier in the
// pipeline; rankResults() is the final sort immediately before returning
// results to the client.
//
// UPDATED 2026-07-14 against the real, uploaded fuzzyMatch.js: that file
// only exported correctTypos()/correctTokens()/warmVocab() — its
// levenshtein() is private, used internally by correctWord() against the
// module's own vocab Set, not built for comparing two arbitrary strings.
// Added one small additive export, similarity(a, b), to fuzzyMatch.js
// itself (reuses the same levenshtein(), changes nothing else) rather than
// duplicating edit-distance logic here.

import { similarity } from './fuzzyMatch.js';

const POPULARITY_WEIGHT = 0.10; // small tiebreaker, not a driver — mood/niche
                                 // discovery is the product, a popular but
                                 // irrelevant result shouldn't outrank a
                                 // precise niche match
const INTENT_WEIGHT = 1 - POPULARITY_WEIGHT;

// Saturating cap for turning a raw mood-aggregate score into a 0–1 intensity.
// Tunable — 10 is a starting guess (e.g. "devastated"+"heartbroken"+"tragedy"
// AFINN-doubled = 14 in the §0 worked example, so that case saturates to 1.0).
const MOOD_INTENSITY_SATURATION = 10;

/**
 * Turns a rankCategories() result (e.g. [{category:'EMOTION',score:2},
 * {category:'GENRE',score:1}]) into normalized 0–1 weights per sub-score,
 * keyed the same as the per-candidate sub-scores computed below.
 *
 * moodAggregate is the object already returned by analyzeQueryMood()
 * (e.g. {sadness: 3, hope: 4}) — used here only to derive intensity,
 * not to recompute mood.
 */
function computeRankingWeights(classifierRanked, moodAggregate) {
  const raw = { textMatch: 0, genreMatch: 0, emotionMatch: 0 };

  for (const { category, score } of classifierRanked) {
    if (category === 'TITLE' || category === 'AUTHOR' || category === 'CHARACTER') {
      raw.textMatch += score;
    } else if (category === 'GENRE' || category === 'TAG') {
      raw.genreMatch += score;
    } else if (category === 'EMOTION') {
      raw.emotionMatch += score;
    }
    // unrecognized categories are ignored, not errors — keeps this forward
    // compatible if classifyQuery() ever adds a category
  }

  // Intensity multiplier on EMOTION only, per user decision 2026-07-14:
  // a 0.9-intensity "devastated" query should lean harder on emotionMatch
  // than a 0.3-intensity "kind of sad" one. Applied AFTER the raw category
  // tally but BEFORE normalization, so a high-intensity emotion match can
  // outweigh a low-count text/genre match rather than just nudging within
  // its own bucket.
  const intensity = computeMoodIntensity(moodAggregate);
  raw.emotionMatch *= intensity;

  const total = raw.textMatch + raw.genreMatch + raw.emotionMatch;

  if (total === 0) {
    // No classifier signal at all (shouldn't normally happen — every query
    // hits at least one category) — fall back to an even split so ranking
    // still does something sane instead of dividing by zero.
    return { textMatch: 1 / 3, genreMatch: 1 / 3, emotionMatch: 1 / 3 };
  }

  return {
    textMatch: raw.textMatch / total,
    genreMatch: raw.genreMatch / total,
    emotionMatch: raw.emotionMatch / total,
  };
}

/**
 * 0–1 intensity from a mood aggregate object, e.g. {sadness: 3, hope: 4} -> 0.7.
 * Same "intensity as multiplier downstream" idea flagged in §10's original
 * Mood Analyzer proposal — just applied here at the ranking stage instead of
 * inside moodLexicon.js itself, since moodLexicon.js's job stays "what mood
 * is this" and rankResults.js's job is "how much should that mood matter".
 */
function computeMoodIntensity(moodAggregate) {
  if (!moodAggregate) return 0;
  const totalScore = Object.values(moodAggregate).reduce((sum, v) => sum + Math.abs(v), 0);
  return Math.min(1, totalScore / MOOD_INTENSITY_SATURATION);
}

/**
 * textMatch sub-score, 0–1. Uses fuzzyMatch.js's similarity(), confirmed
 * against the live file (added there as a small additive export — see
 * that file's own changelog comment). Note this is a different use of
 * fuzzyMatch.js than its existing job: correctTypos()/correctTokens()
 * correct query words against a global vocab Set before search even runs;
 * this instead compares the (already-corrected) query tokens directly
 * against one specific candidate's fields, at ranking time.
 */
function textMatchScore(candidate, queryTokens) {
  if (queryTokens.length === 0) return 0;
  const fields = [candidate.title, candidate.author, candidate.character].filter(Boolean);
  let best = 0;
  for (const field of fields) {
    const fieldNorm = field.toLowerCase();
    for (const token of queryTokens) {
      const score = similarity(token, fieldNorm);
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * genreMatch sub-score, 0–1: fraction of the query's genre/tag terms present
 * in the candidate's genres. Plain overlap, same spirit as
 * matchesCategoryPhrase()'s vocab matching in queryClassifier.js.
 */
function genreMatchScore(candidate, queryGenreTerms) {
  if (!queryGenreTerms || queryGenreTerms.length === 0) return 0;
  const candidateGenres = new Set((candidate.genres || []).map((g) => g.toLowerCase()));
  const hits = queryGenreTerms.filter((g) => candidateGenres.has(g.toLowerCase())).length;
  return hits / queryGenreTerms.length;
}

/**
 * emotionMatch sub-score, 0–1: overlap between the query's mood-driven
 * boost genres (getRoutingForMood(), already built for applyMoodBoost())
 * and the candidate's genres — normalized instead of the raw summed-weight
 * count applyMoodBoost() uses, so it's comparable to the other sub-scores.
 */
function emotionMatchScore(candidate, boostGenres) {
  if (!boostGenres || boostGenres.length === 0) return 0;
  const candidateGenres = new Set((candidate.genres || []).map((g) => g.toLowerCase()));
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const { genre, weight } of boostGenres) {
    totalWeight += weight;
    if (candidateGenres.has(genre.toLowerCase())) matchedWeight += weight;
  }
  return totalWeight === 0 ? 0 : matchedWeight / totalWeight;
}

/**
 * popularity sub-score, 0–1: log-scaled, min-max normalized WITHIN the
 * current result set (not against some global constant) — avoids a single
 * mega-popular title (e.g. a top-10 AniList entry) flattening every other
 * candidate's score to near-zero by comparison.
 */
function computePopularityScores(results) {
  const logPops = results.map((r) => Math.log((r.popularity || 0) + 1));
  const min = Math.min(...logPops);
  const max = Math.max(...logPops);
  const range = max - min;
  return logPops.map((v) => (range === 0 ? 0 : (v - min) / range));
}

/**
 * Main entry point. Call after applyMoodBoost()'s hard-filter/soft-rerank
 * step, immediately before returning `results` to the client.
 *
 * @param results        array of candidate manga objects (post genre-exclude filter)
 * @param classifierRanked  output of rankCategories() for this query
 * @param moodAggregate  output of analyzeQueryMood() for this query
 * @param queryTokens    normalized query tokens (for textMatch)
 * @param queryGenreTerms  genre/tag terms extracted from the query (for genreMatch)
 * @param boostGenres    getRoutingForMood(moodAggregate).boostGenres (for emotionMatch)
 */
function rankResults(results, { classifierRanked, moodAggregate, queryTokens, queryGenreTerms, boostGenres }) {
  const weights = computeRankingWeights(classifierRanked, moodAggregate);
  const popularityScores = computePopularityScores(results);

  const scored = results.map((candidate, i) => {
    const textMatch = textMatchScore(candidate, queryTokens);
    const genreMatch = genreMatchScore(candidate, queryGenreTerms);
    const emotionMatch = emotionMatchScore(candidate, boostGenres);
    const popularity = popularityScores[i];

    const intentScore =
      weights.textMatch * textMatch +
      weights.genreMatch * genreMatch +
      weights.emotionMatch * emotionMatch;

    const finalScore = INTENT_WEIGHT * intentScore + POPULARITY_WEIGHT * popularity;

    return { ...candidate, _rankDebug: { textMatch, genreMatch, emotionMatch, popularity, weights, finalScore }, finalScore };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

export { rankResults, computeRankingWeights, computeMoodIntensity };
