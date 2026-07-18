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
//
// FIXED 2026-07-14 (earlier pass): textMatchScore() was calling .toLowerCase()
// directly on candidate.title, but every adapter (anilist.js/jikan.js/
// kitsu.js/mangadex.js) returns title as an OBJECT ({ romaji, english }),
// never a plain string. That threw a TypeError inside rankResults(), which
// runs inside domains.js's per-source try/catch — so every source failed
// identically and every search returned results:[], source:null. Fixed by
// pulling the actual string fields out of the title object before use.
//
// FIXED 2026-07-18 (Mixer saturation gap, Backend Update List): genreMatchScore
// already had a fix so it scores against filters.genres directly, not just
// classifier-derived queryGenreTerms — but emotionMatchScore() only ever
// scored against routing.boostGenres. When Mixer sends filters.genres as a
// hard filter AND the mood-label query text boosts that same genre (Mixer's
// actual request shape — filters-only, mood labels sent as query text, no
// free text), every surviving candidate already has that genre (the hard
// filter guaranteed it), so BOTH genreMatch and emotionMatch saturate to 1.0
// for every result. finalScore then degenerates to a popularity sort dressed
// up as a mood match — genre/emotion contribute zero discriminating signal
// even though their weight is still being applied.
//
// Fix (Option 1 from the design discussion — reuses data already computed,
// touches nothing on the free-text path, degrades gracefully): detect the
// saturation case (genreMatch and emotionMatch identical across every
// candidate in the batch) and, only then, fall back to scoring the mood
// signal's own matchedTerms (analyzeQueryMood()'s per-token hits — words
// like "cozy"/"heartwarming"/"slow burn", already computed in domains.js's
// computeMoodSignal(), no new fetch needed) against each candidate's
// description text. The weight that genreMatch/emotionMatch would have
// contributed (since it's constant, it contributes nothing to the sort
// order anyway) is redirected to this description-match signal instead, so
// there's still something real to discriminate on. Un-saturated queries
// (the common case) are completely unaffected — descriptionMatch is only
// computed and only weighted in when saturation is actually detected.
//
// ADDED (Entry 35/40): a Bayesian quality-score term, weighted by how
// strongly the query expresses acclaim/quality intent (acclaimScoring.js's
// computeAcclaimIntensity(), computed in domains.js and passed in here as
// `acclaimIntensity`). A query with zero acclaim intent gets zero weight
// on this term — quality score never distorts an ordinary genre/mood
// search, it only kicks in for queries actually asking for "the best" /
// "critically acclaimed" / "something I'll remember for years".
import { similarity } from './fuzzyMatch.js';
import { computeQualityScores } from './acclaimScoring.js';

const POPULARITY_WEIGHT = 0.10; // small tiebreaker, not a driver — mood/niche
                                 // discovery is the product, a popular but
                                 // irrelevant result shouldn't outrank a
                                 // precise niche match
const INTENT_WEIGHT = 1 - POPULARITY_WEIGHT;

// Saturating cap for turning a raw mood-aggregate score into a 0–1 intensity.
// Tunable — 10 is a starting guess (e.g. "devastated"+"heartbroken"+"tragedy"
// AFINN-doubled = 14 in the §0 worked example, so that case saturates to 1.0).
const MOOD_INTENSITY_SATURATION = 10;

// Entry 35/40. Ceiling on how much of the intent budget the quality score
// can claim, reached only at acclaimIntensity === 1 (maximal, unambiguous
// acclaim intent). At acclaimIntensity 0 this contributes nothing, same as
// today's behavior for every query that isn't asking for "the best" —
// existing genre/mood/title search results are unaffected by default.
const MAX_QUALITY_WEIGHT = 0.4;

/**
 * Turns a rankCategories() result (e.g. [{category:'EMOTION',score:2},
 * {category:'GENRE',score:1}]) into normalized 0–1 weights per sub-score,
 * keyed the same as the per-candidate sub-scores computed below.
 *
 * moodAggregate is the object already returned by analyzeQueryMood()
 * (e.g. {sadness: 3, hope: 4}) — used here only to derive intensity,
 * not to recompute mood.
 */
// computeRankingWeights — filters.genres is an explicit, structured scoring
// request (the caller picked these genres directly), separate from whatever
// the classifier found in the query text. Without this, the per-title
// variance genreMatchScore() now produces still gets multiplied by a 0
// weight whenever the classifier found no GENRE/TAG terms — the common
// case for Mixer's mood-label-heavy queries.
function computeRankingWeights(classifierRanked, moodAggregate, filterGenres) {
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

  if (filterGenres && filterGenres.length > 0) {
    raw.genreMatch += filterGenres.length;
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
 */
function computeMoodIntensity(moodAggregate) {
  if (!moodAggregate) return 0;
  const totalScore = Object.values(moodAggregate).reduce((sum, v) => sum + Math.abs(v), 0);
  return Math.min(1, totalScore / MOOD_INTENSITY_SATURATION);
}

/**
 * textMatch sub-score, 0–1. Uses fuzzyMatch.js's similarity().
 *
 * FIXED: candidate.title is { romaji, english }, not a string — pull the
 * actual text fields out before calling similarity() on them. author/
 * character are left as-is (candidate.author, candidate.character) since
 * no adapter currently sets those as objects, but they're optional-chained
 * defensively anyway.
 */
function textMatchScore(candidate, queryTokens) {
  if (queryTokens.length === 0) return 0;
  const fields = [
    candidate.title?.english,
    candidate.title?.romaji,
    candidate.author,
    candidate.character
  ].filter(Boolean);
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
 * in the candidate's genres.
 */
// genreMatchScore — now scores against filters.genres too, not just the
// query-text classifier's genre terms. Mixer sends filters.genres as a hard
// filter with no discriminating genre words in the free text, so
// queryGenreTerms alone was always empty for that flow (Entry 26).
function genreMatchScore(candidate, queryGenreTerms, filterGenres) {
  const combined = new Set([
    ...(queryGenreTerms || []).map((g) => g.toLowerCase()),
    ...(filterGenres || []).map((g) => g.toLowerCase()),
  ]);
  if (combined.size === 0) return 0;
  const candidateGenres = new Set((candidate.genres || []).map((g) => g.toLowerCase()));
  const hits = [...combined].filter((g) => candidateGenres.has(g)).length;
  return hits / combined.size;
}

/**
 * emotionMatch sub-score, 0–1: overlap between the query's mood-driven
 * boost genres and the candidate's genres.
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
 * descriptionMatch sub-score, 0–1: fraction of the mood signal's own
 * matched terms (analyzeQueryMood()'s perToken output — e.g. "cozy",
 * "heartwarming", "slow burn") that literally appear in the candidate's
 * description text.
 *
 * This is the fallback discriminator for the saturation case (see the
 * 2026-07-18 fix note at the top of this file): a candidate description
 * that actually mentions "found family" or "slow burn" is a genuinely
 * different, real signal from one that doesn't — even when every
 * candidate is otherwise tied on genre because a hard filter already
 * guaranteed the genre match. Deliberately simple substring matching, not
 * fuzzy — descriptions are prose, not vocab terms, so an exact phrase hit
 * is a meaningful signal and a near-miss isn't worth chasing here.
 */
function descriptionMatchScore(candidate, moodMatchedTerms) {
  if (!moodMatchedTerms || moodMatchedTerms.length === 0) return 0;
  const description = (candidate.description || '').toLowerCase();
  if (!description) return 0;

  let hits = 0;
  for (const m of moodMatchedTerms) {
    const term = (m?.term || '').toLowerCase().trim();
    if (term && description.includes(term)) hits++;
  }
  return hits / moodMatchedTerms.length;
}

/**
 * A sub-score is "saturated" across a batch if every candidate landed on
 * the exact same value — i.e. it contributes zero variance to the sort,
 * regardless of how much weight is nominally assigned to it. This is the
 * condition the Mixer bug produces: a hard genre filter guarantees
 * genreMatch/emotionMatch are identical for every survivor.
 */
function isSaturated(values) {
  if (values.length < 2) return false;
  return values.every((v) => v === values[0]);
}

/**
 * popularity sub-score, 0–1: log-scaled, min-max normalized WITHIN the
 * current result set.
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
 * moodMatchedTerms: analyzeQueryMood()'s perToken array (mood.matchedTerms
 * in domains.js), passed through so the saturation fallback above has
 * something to score against. Optional — omitting it just means the
 * saturation fallback silently contributes 0 (same as today) instead of
 * throwing.
 *
 * acclaimIntensity: 0-1, from acclaimScoring.js's computeAcclaimIntensity()
 * (computed once in domains.js's runManga(), passed through here same as
 * boostGenres/moodMatchedTerms). Optional, defaults to 0 — a query with no
 * acclaim intent gets the exact same ranking behavior as before this was
 * added.
 */
function rankResults(results, { classifierRanked, moodAggregate, queryTokens, queryGenreTerms, filterGenres, boostGenres, moodMatchedTerms, acclaimIntensity = 0 }) {
  const weights = computeRankingWeights(classifierRanked, moodAggregate, filterGenres);
  const popularityScores = computePopularityScores(results);
  const qualityScores = computeQualityScores(results);

  // First pass: compute every sub-score up front so we can look across the
  // whole batch (needed to detect saturation) before deciding how much
  // weight descriptionMatch should actually get.
  const partial = results.map((candidate, i) => ({
    candidate,
    textMatch: textMatchScore(candidate, queryTokens),
    genreMatch: genreMatchScore(candidate, queryGenreTerms, filterGenres),
    emotionMatch: emotionMatchScore(candidate, boostGenres),
    popularity: popularityScores[i],
    quality: qualityScores[i],
  }));

  const genreSaturated = isSaturated(partial.map((p) => p.genreMatch));
  const emotionSaturated = isSaturated(partial.map((p) => p.emotionMatch));
  // Only fall back when BOTH discriminating signals are degenerate — if
  // either one still varies across the batch, ranking already has a real
  // signal to work with and descriptionMatch would just add noise.
  const saturated = genreSaturated && emotionSaturated && (weights.genreMatch + weights.emotionMatch) > 0;

  // Entry 35/40. How much of the intent budget quality claims this batch —
  // zero for an ordinary query, up to MAX_QUALITY_WEIGHT for a query that
  // maximally expresses acclaim intent. Computed once per batch (not per
  // candidate) since it depends only on the query, not any one result.
  const qualityWeight = MAX_QUALITY_WEIGHT * Math.max(0, Math.min(1, acclaimIntensity));
  const remainingWeight = 1 - qualityWeight;

  const scored = partial.map(({ candidate, textMatch, genreMatch, emotionMatch, popularity, quality }) => {
    let baseIntentScore;
    let descriptionMatch = 0;

    if (saturated) {
      // genreMatch/emotionMatch are identical for every candidate here, so
      // whatever weight computeRankingWeights() assigned them is
      // contributing zero information to the sort. Redirect that combined
      // weight to descriptionMatch instead of just discarding it.
      descriptionMatch = descriptionMatchScore(candidate, moodMatchedTerms);
      const borrowedWeight = weights.genreMatch + weights.emotionMatch;
      baseIntentScore = weights.textMatch * textMatch + borrowedWeight * descriptionMatch;
    } else {
      baseIntentScore =
        weights.textMatch * textMatch +
        weights.genreMatch * genreMatch +
        weights.emotionMatch * emotionMatch;
    }

    // Entry 35/40. Quality score only ever displaces part of the existing
    // intent budget, scaled by how strongly the query asked for it —
    // qualityWeight is 0 for any query without acclaim intent, so
    // intentScore === baseIntentScore in that case, unchanged from before.
    const intentScore = remainingWeight * baseIntentScore + qualityWeight * quality;

    const finalScore = INTENT_WEIGHT * intentScore + POPULARITY_WEIGHT * popularity;

    return {
      ...candidate,
      _rankDebug: {
        textMatch, genreMatch, emotionMatch, descriptionMatch, popularity,
        quality, qualityWeight, weights, saturated, finalScore
      },
      finalScore
    };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

export { rankResults, computeRankingWeights, computeMoodIntensity };
