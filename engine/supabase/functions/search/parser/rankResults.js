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

// Entry 49 gap #3. Flat additive bonus (not part of the intent-budget
// split like textMatch/genreMatch/emotionMatch/quality) applied on top of
// finalScore when a candidate satisfies BOTH conjunctive clusters. Kept
// as a separate additive term rather than folded into the existing
// weight-budget math so it's a pure bonus for the rare double-match
// candidate, not a redistribution that could shift ranking for every
// other query. 0 for every query without a detected conjunction (the
// default/common case) -- existing ranking behavior is unaffected.
const CONJUNCTION_BONUS = 0.15;

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
//
// FIX 2026-07-19 (moodmanga "enemies to lover" ranking bug): TITLE's score
// from classifyQuery() is a loose word-bag count — any query word ≥4
// letters that appears ANYWHERE in the ~9,912-title catalog counts as a
// match. That's intentional for building the candidate list upstream, but
// it's not trustworthy as a RANKING-WEIGHT signal: a trope/mood phrase like
// "enemies to lover" shares a word with 53 unrelated titles in this catalog,
// which was inflating raw.textMatch to ~16x the emotion signal's weight and
// making per-candidate fuzzy title-string similarity (meant for typo
// tolerance on real title searches) the dominant ranking factor for a query
// that isn't a title search at all.
//
// queryClassifier.js already solved exactly this problem once, for a
// different call site: hasStrongTitleMatch() re-checks the FULL query
// against the FULL matched title with a strict similarity threshold (0.65),
// not word overlap — built specifically to stop "I am feeling lonely" from
// reading as a title search off "Lonely Man"/"Lonely Wolf". It was wired
// into routing decisions (basicPlan short-circuit, reference-title skip,
// primaryGenres injection) but never into rankResults()'s weight budget.
// This is that missing wire: TITLE only contributes to raw.textMatch when
// hasStrongTitleMatch is true. AUTHOR/CHARACTER are left alone — they
// weren't implicated in the bug (their vocab lists are far smaller than the
// 9,912-title catalog, and hasStrongTitleMatch() doesn't cover them anyway)
// — this only changes behavior for the TITLE category specifically.
function computeRankingWeights(classifierRanked, moodAggregate, filterGenres, hasStrongTitleMatch) {
  const raw = { textMatch: 0, genreMatch: 0, emotionMatch: 0 };

  for (const { category, score } of classifierRanked) {
    if (category === 'TITLE') {
      if (hasStrongTitleMatch) raw.textMatch += score;
    } else if (category === 'AUTHOR' || category === 'CHARACTER') {
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
 * Entry 66 (2026-07-19, by Claude). Two-tier emotionMatch, replacing the
 * old flat-genre-pool version (see mangaRouting.js's getRoutingForMood()
 * header for the full root-cause writeup -- Backend Update List Entry
 * 63/65/66).
 *
 * Scored per EMOTION DIMENSION, each capped at its own lexicon weight,
 * via whichever tier has real evidence:
 *
 * Tier 1 (tagVocab hit): if this dimension's ORIGINAL matched term (e.g.
 * "Enemies To Lovers") is itself a real AniList curated tag name, score
 * it directly against candidate.tags -- no genre proxy involved at all.
 * AniList's own per-title `rank` (0-100) scales the credit within this
 * dimension's weight budget, so a borderline (low-rank) tag hit doesn't
 * get the same full credit as a clearly central (high-rank) one.
 *
 * Tier 3 (genre-proxy fallback): for dimensions with no real tag
 * equivalent (e.g. "enemies to lovers" itself isn't in AniList's ~420-tag
 * vocab, confirmed by direct query against lexicon_entities), fall back
 * to genre overlap -- but capped at this dimension's own weight
 * regardless of how many genres it maps to in MANGA_ROUTING, unlike the
 * old flat-pool version.
 *
 * Deliberately a strict generalization of the old function: a dimension
 * with no tag match and a single-genre mapping scores identically to
 * before.
 *
 * `emotionGenreMap` entries: { emotion, weight, genres, tagName? } --
 * `tagName` is populated by rankResults()'s caller-side lookup against
 * `tagVocab` using the ORIGINAL matched term (moodMatchedTerms), since
 * the emotion-bucket names here ("romance", "tension") aren't the
 * matched term itself -- see rankResults() below for that wiring.
 */
function emotionMatchScore(candidate, emotionGenreMap) {
  if (!emotionGenreMap || emotionGenreMap.length === 0) return 0;
  const candidateGenres = new Set((candidate.genres || []).map((g) => g.toLowerCase()));
  const candidateTags = new Map(
    (candidate.tags || []).map((t) => [(t.name || '').toLowerCase(), typeof t.rank === 'number' ? t.rank : 100])
  );

  let matchedWeight = 0;
  let totalWeight = 0;

  for (const { weight, genres, tagName } of emotionGenreMap) {
    totalWeight += weight;

    if (tagName && candidateTags.has(tagName.toLowerCase())) {
      const rank = candidateTags.get(tagName.toLowerCase());
      matchedWeight += weight * Math.min(1, rank / 100);
      continue;
    }

    if (!genres || genres.length === 0) continue;
    const hitCount = genres.filter((g) => candidateGenres.has(g.toLowerCase())).length;
    matchedWeight += weight * (hitCount / genres.length);
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
 * Entry 49 gap #3. 1 if the candidate's own genres hit BOTH clusters from
 * detectConjunctiveClusters() (mangaRouting.js), 0 otherwise -- including
 * when it only hits one side, or when clusters is null (no conjunction
 * detected for this query, the common case). Deliberately binary, not a
 * partial/weighted score: the whole point is to separate "satisfies both
 * required moods" from "satisfies only one", which a partial-credit scheme
 * would blur back together.
 */
function conjunctionMatchScore(candidate, clusters) {
  if (!clusters) return 0;
  const candidateGenres = new Set((candidate.genres || []).map((g) => g.toLowerCase()));
  const hitsA = clusters.clusterA.genres.some((g) => candidateGenres.has(g.toLowerCase()));
  const hitsB = clusters.clusterB.genres.some((g) => candidateGenres.has(g.toLowerCase()));
  return (hitsA && hitsB) ? 1 : 0;
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
 *
 * hasStrongTitleMatch: boolean from queryClassifier.js's
 * hasStrongTitleMatch(classification.scores, rawQuery) — see the 2026-07-19
 * fix note on computeRankingWeights() above. Optional, defaults to false,
 * which means TITLE contributes nothing to raw.textMatch unless a caller
 * explicitly confirms the query is a real title search. That default was
 * chosen deliberately (fail toward not letting incidental word overlap
 * dominate ranking) rather than defaulting to true/old-behavior, since the
 * old default is exactly what caused this bug.
 */
function rankResults(results, { classifierRanked, moodAggregate, queryTokens, queryGenreTerms, filterGenres, boostGenres, emotionGenreMap, tagVocab, moodMatchedTerms, acclaimIntensity = 0, conjunctiveClusters = null, hasStrongTitleMatch = false }) {
  const weights = computeRankingWeights(classifierRanked, moodAggregate, filterGenres, hasStrongTitleMatch);
  const popularityScores = computePopularityScores(results);
  const qualityScores = computeQualityScores(results);

  // Entry 66. `emotionGenreMap` is keyed by emotion-BUCKET name (romance,
  // tension...), not by the original matched lexicon term ("Enemies To
  // Lovers") -- that identity only survives in `moodMatchedTerms`. Attach
  // `tagName` here (once per request, not per candidate) by checking each
  // matched term's own string against the real AniList tag vocabulary,
  // then distributing it onto whichever emotion-bucket entries that term
  // contributed weight to. `tagVocab` is a lowercase Set of real tag
  // names (domains.js builds it once via the already-cached
  // getTagVocabEntries()) -- optional; when absent this degrades
  // byte-identical to the old genre-proxy-only behavior (Tier 1 simply
  // never fires, Tier 3 unchanged).
  const emotionGenreMapWithTags = (() => {
    if (!emotionGenreMap || emotionGenreMap.length === 0) return emotionGenreMap;
    if (!tagVocab || tagVocab.size === 0) return emotionGenreMap;

    // Deliberately EXACT (case-insensitive) name matching, not the looser
    // word-bag/token-overlap matching resolveMoodTagCandidates() uses for
    // pool-widening (domains.js). A false positive there just adds one
    // extra candidate to consider; a false positive here directly
    // inflates a ranking score -- see Entry 33 for what loose word-bag
    // matching already did once to a confidence-bearing signal in this
    // pipeline. Stricter bar is intentional.
    const termTagNames = new Set();
    for (const { term, source } of moodMatchedTerms || []) {
      if (source !== 'custom_lexicon') continue; // AFINN single-word hits are never real tag names
      if (tagVocab.has((term || '').toLowerCase())) termTagNames.add((term || '').toLowerCase());
    }
    if (termTagNames.size === 0) return emotionGenreMap;

    // Re-derive which term(s) actually own each emotion-bucket weight by
    // re-reading moodMatchedTerms' own emotions objects -- if a
    // tag-matched term is the (or a) contributor to a bucket, tag that
    // bucket entry. Ambiguous only when two different matched terms both
    // touch the same emotion key AND only one of them has a real tag --
    // in that rare case we conservatively skip tagging (falls through to
    // Tier 3 for that dimension) rather than guess.
    return emotionGenreMap.map((entry) => {
      const contributors = (moodMatchedTerms || []).filter(
        (m) => m.emotions && Object.prototype.hasOwnProperty.call(m.emotions, entry.emotion)
      );
      if (contributors.length === 1 && termTagNames.has((contributors[0].term || '').toLowerCase())) {
        return { ...entry, tagName: contributors[0].term };
      }
      return entry;
    });
  })();

  // First pass: compute every sub-score up front so we can look across the
  // whole batch (needed to detect saturation) before deciding how much
  // weight descriptionMatch should actually get.
  const partial = results.map((candidate, i) => ({
    candidate,
    textMatch: textMatchScore(candidate, queryTokens),
    genreMatch: genreMatchScore(candidate, queryGenreTerms, filterGenres),
    emotionMatch: emotionMatchScore(candidate, emotionGenreMapWithTags),
    popularity: popularityScores[i],
    quality: qualityScores[i],
  }));

  const genreSaturated = isSaturated(partial.map((p) => p.genreMatch));
  const emotionSaturated = isSaturated(partial.map((p) => p.emotionMatch));
  // FIX 2026-07-19 (Notion "Backend Update List" Entry 63/64): previously
  // only redirected wasted weight when BOTH genreMatch and emotionMatch
  // were saturated together (the Mixer hard-filter case, where both
  // saturate to a constant 1.0). That missed a distinct, more common case:
  // a TAG-classified query term (e.g. "magic") that never literally
  // appears in any candidate.genres list, so genreMatchScore() saturates
  // to a constant 0 for every candidate — while emotionMatch (a totally
  // separate code path, scored against mood-derived boost genres) still
  // varies normally. The old dual-condition check read that as "real
  // signal already exists, don't touch it" and left genreMatch's own
  // weight share permanently wasted (multiplied against a value that's
  // always 0), quietly shrinking the effective intent budget instead of
  // fully using it — this is why a correctly-higher-emotionMatch candidate
  // (e.g. Solo Leveling for "magic that feels mysterious") still lost to
  // a more popular but less atmospheric one (Berserk): its real emotionMatch
  // edge was diluted by wasted genreMatch weight sitting in the same budget.
  // Now each term's saturation is handled independently below — whichever
  // of genreMatch/emotionMatch is flat has ONLY its own weight share
  // redirected to descriptionMatch; a term that still varies keeps
  // contributing its own real per-candidate signal unchanged. When both
  // happen to be saturated together, the net effect is identical to the
  // old behavior (both redirected) — this is a strict generalization, not
  // a behavior change for the case the original Mixer fix was built for.
  const saturated = (genreSaturated && weights.genreMatch > 0) || (emotionSaturated && weights.emotionMatch > 0);

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
      // FIX Entry 63/64: redirect only the weight of whichever term(s)
      // are actually saturated for THIS batch — a term still varying
      // keeps its own real per-candidate score instead of being folded
      // into the flat descriptionMatch redirect too.
      descriptionMatch = descriptionMatchScore(candidate, moodMatchedTerms);
      const redirectedWeight =
        (genreSaturated ? weights.genreMatch : 0) +
        (emotionSaturated ? weights.emotionMatch : 0);
      const keptGenreMatch = genreSaturated ? 0 : weights.genreMatch * genreMatch;
      const keptEmotionMatch = emotionSaturated ? 0 : weights.emotionMatch * emotionMatch;
      baseIntentScore =
        weights.textMatch * textMatch +
        keptGenreMatch +
        keptEmotionMatch +
        redirectedWeight * descriptionMatch;
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

    // Entry 49 gap #3. Pure additive bonus, zero for the default/common
    // case (conjunctiveClusters null -> conjunctionMatch always 0). Added
    // after finalScore's normal weighted split rather than competing for a
    // share of it, since this is meant to be a tiebreaker/lift for the
    // rare double-match candidate, not a redistribution of everyone else's
    // score.
    const conjunctionMatch = conjunctionMatchScore(candidate, conjunctiveClusters);
    const conjunctionBonus = conjunctiveClusters ? CONJUNCTION_BONUS * conjunctionMatch : 0;

    const finalScore = INTENT_WEIGHT * intentScore + POPULARITY_WEIGHT * popularity + conjunctionBonus;

    return {
      ...candidate,
      _rankDebug: {
        textMatch, genreMatch, emotionMatch, descriptionMatch, popularity,
        quality, qualityWeight, weights, saturated, conjunctionMatch, finalScore
      },
      finalScore
    };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

export { rankResults, computeRankingWeights, computeMoodIntensity };
