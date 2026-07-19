import { getAfinnScore } from './dictionary/afinn.js';
import { normalizeAndTokenize, normalize } from './normalize.js';
import { similarity } from './fuzzyMatch.js';
import { computeNegationMask } from './negation.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;

const MIN_SIGNIFICANT_WORD_LENGTH = 4;

// Entry 33 fix: how similar the full query needs to be to an actual title
// (via fuzzyMatch.js's similarity(), same Levenshtein-based scorer used for
// typo correction) before we trust it as a real title search. The old
// "any single ≥4-letter word overlaps any of 9,912 titles" check
// (matchesCategoryPhrase, still used below for building the *candidate*
// list) was found to false-positive constantly at this catalog size -- e.g.
// "I am feeling lonely" scored a TITLE hit off "Lonely Man"/"Lonely Wolf,
// Lonely Sheep" purely because they share the word "lonely". This second,
// stricter check is what actually gates Entry 32's genre-routing decision.
// Tunable -- 0.65 is a starting point, not verified against a broad query
// sample yet.
const TITLE_SIMILARITY_THRESHOLD = 0.65;

const CATEGORY_ENTITY_TYPES = {
  TITLE: ['media'],
  AUTHOR: ['staff'],
  CHARACTER: ['character'],
  GENRE: ['genre'],
  TAG: ['tag', 'theme', 'demographic']
};

// Exclusion-system pass (QA finding #1). Negation is only ever ACTED on for
// these two categories -- excluding a GENRE/TAG is a real, well-defined
// request ("anything except horror" -> genre_not_in) with an existing hard-
// filter mechanism already wired all the way to the adapters
// (plan.excludedGenres). Negating a TITLE/AUTHOR/CHARACTER match ("not
// Naruto") doesn't have an equivalent mechanism today and is a much murkier
// ask besides -- left as a possible future addition, not silently
// mishandled here. negatedMatches is still computed uniformly below for
// every category (simplest code path), domains.js just only ever reads it
// off GENRE/TAG.
const NEGATABLE_CATEGORIES = new Set(['GENRE', 'TAG']);

let cache = null;
let cacheLoadedAt = 0;
let warmingPromise = null;

// Exported (was module-private) so referenceTitle.js's phrase-vs-title
// overlap scoring tokenizes identically to how these TITLE entries were
// tokenized when the vocab cache was built -- same reasoning as reusing
// getTitleVocabEntries() below instead of re-querying lexicon_entities.
export function significantTokens(name) {
  return normalizeAndTokenize(name).filter((t) => t.length >= MIN_SIGNIFICANT_WORD_LENGTH);
}

async function loadEntityType(supabase, entityType) {
  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('lexicon_entities')
      .select('name')
      .eq('entity_type', entityType)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error(`[queryClassifier] warm fetch error for entity_type=${entityType}`, error);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (!row.name) continue;
      rows.push({ name: row.name, tokens: significantTokens(row.name) });
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

async function loadAllCategories(supabase) {
  const map = new Map();

  for (const [category, entityTypes] of Object.entries(CATEGORY_ENTITY_TYPES)) {
    const entries = [];
    for (const entityType of entityTypes) {
      entries.push(...(await loadEntityType(supabase, entityType)));
    }
    map.set(category, entries);
  }

  return map;
}

async function warmCache(supabase) {
  const isStale = !cache || (Date.now() - cacheLoadedAt) > CACHE_TTL_MS;
  if (!isStale) return cache;

  if (!warmingPromise) {
    warmingPromise = loadAllCategories(supabase)
      .then((map) => {
        cache = map;
        cacheLoadedAt = Date.now();
        warmingPromise = null;
        return cache;
      })
      .catch((err) => {
        warmingPromise = null;
        throw err;
      });
  }

  if (cache) return cache;
  return warmingPromise;
}

// Exclusion-system pass. Previously took a Set (queryTokenSet) and just
// checked overlap -- couldn't tell WHERE in the query a match came from, so
// couldn't tell whether that position was negated. Now takes the token
// array plus the negation mask computed once per query, and tracks every
// query-token INDEX each entity's tokens hit, not just whether they hit.
//
// A category match counts as negated only if EVERY position it hit in the
// query is negated -- if the same genre word appears twice in a query and
// only one mention is negated, the positive mention wins (conservative:
// avoids accidentally excluding something the person also affirmatively
// asked for). The common case -- one mention, e.g. "anything except
// horror" -- just has exactly one hit position to check.
function matchesCategoryPhrase(queryTokens, negated, vocabEntries) {
  const positionsByToken = new Map();
  queryTokens.forEach((t, i) => {
    if (!positionsByToken.has(t)) positionsByToken.set(t, []);
    positionsByToken.get(t).push(i);
  });

  const matches = [];
  const negatedMatches = [];

  for (const entry of vocabEntries) {
    const hitPositions = [];
    for (const t of entry.tokens) {
      const positions = positionsByToken.get(t);
      if (positions) hitPositions.push(...positions);
    }
    if (hitPositions.length === 0) continue;

    const anyPositive = hitPositions.some((i) => !negated[i]);
    if (anyPositive) {
      matches.push(entry.name);
    } else {
      negatedMatches.push(entry.name);
    }
  }

  return { matches, negatedMatches };
}

function scoreEmotion(queryTokens, lexiconMatchedTerms = []) {
  const matches = [];
  for (const token of queryTokens) {
    const score = getAfinnScore(token);
    if (score !== null && score !== 0) matches.push(token);
  }
  // FIX 2026-07-19 (Notion "Backend Update List" Entry 65): also count real
  // phrase-level custom-lexicon mood matches (idiom/trope terms like
  // "enemies to lovers", already computed by moodLexicon.js's
  // analyzeQueryMood() one step earlier in domains.js's runManga()) as
  // EMOTION signal. Previously this function only ever looked at raw
  // single-token AFINN scores, so a query whose entire real mood signal
  // came from a multi-word lexicon phrase match (not a single AFINN-scored
  // word) had its EMOTION category weight in computeRankingWeights()
  // determined by whichever unrelated individual word in the query
  // happened to also carry its own AFINN score — e.g. "enemies" alone
  // scores -2 in AFINN (generic negative sentiment), completely
  // disconnected from the {romance:7, tension:4} the phrase "enemies to
  // lovers" actually carries in manga_emotion_lexicon. That mismatched,
  // arbitrary weight is what let unrelated tension/horror-genre candidates
  // (e.g. Bastard) compete on equal footing with genuine romance-trope
  // matches for their share of the ranking-weight budget. lexiconMatchedTerms
  // is optional and defaults to [] — callers that don't pass it (none
  // currently, but keeping this safe) get byte-identical old behavior.
  for (const m of lexiconMatchedTerms) {
    if (m && m.source === 'custom_lexicon' && m.term && !matches.includes(m.term)) {
      matches.push(m.term);
    }
  }
  return matches;
}

export async function classifyQuery(supabase, rawQuery, lexiconMatchedTerms = []) {
  const queryTokens = normalizeAndTokenize(rawQuery || '');
  if (queryTokens.length === 0) return {};

  // Exclusion-system pass: computed once, reused for every category below,
  // same trigger list moodLexicon.js uses (shared via parser/negation.js)
  // plus the additions ("except"/"excluding"/"avoid"/"hate"/"dislike")
  // that pass added -- see negation.js's header for the full rationale.
  const negated = computeNegationMask(queryTokens);
  const vocabByCategory = await warmCache(supabase);

  const scores = {};

  for (const [category, entries] of vocabByCategory.entries()) {
    const { matches, negatedMatches } = matchesCategoryPhrase(queryTokens, negated, entries);
    if (matches.length > 0 || negatedMatches.length > 0) {
      // score is deliberately based on POSITIVE matches only -- an
      // entirely-negated category (e.g. GENRE for "anything except
      // horror", where the only hit is negated) contributes 0 to
      // rankResults.js's computeRankingWeights() weight budget for that
      // category. That's correct: a negated genre isn't something to rank
      // BY, it's a hard filter handled separately in domains.js/
      // plan.excludedGenres. Falling through to an even weight split when
      // every category nets to 0 (already existing fallback behavior in
      // computeRankingWeights) degrades gracefully to a plain popularity
      // browse of whatever survives the exclusion filter -- the right
      // behavior for a query like "anything except horror" that has no
      // positive signal beyond the exclusion itself.
      scores[category] = { score: matches.length, matches, negatedMatches };
    }
  }

  const emotionMatches = scoreEmotion(queryTokens, lexiconMatchedTerms);
  if (emotionMatches.length > 0) {
    scores.EMOTION = { score: emotionMatches.length, matches: emotionMatches };
  }

  return scores;
}

// New for referenceTitle.js (Entry 49 gap #4). Reuses whatever's already
// in the module-level `cache` (warmed by classifyQuery() above, 6h TTL,
// same 9,912-row TITLE list) instead of a second lexicon_entities load --
// domains.js already calls classifyQuery() once per request before this
// would ever run, so in practice this just returns the already-warm Map
// entry with no extra DB round trip.
export async function getTitleVocabEntries(supabase) {
  const vocabByCategory = await warmCache(supabase);
  return vocabByCategory.get('TITLE') || [];
}

// Entry 59 fix. Mirrors getTitleVocabEntries() immediately above -- same
// reasoning, same warm module-level cache (already loads entity_type=
// 'tag'/'theme'/'demographic' rows into the TAG bucket per
// CATEGORY_ENTITY_TYPES, ~420 real curated AniList tags as of this fix)
// instead of a second lexicon_entities round trip. Used by domains.js's
// resolveMoodTagCandidates() to match the mood pipeline's LLM-generated
// keywords (emotionalIntentFallback.js's `keywords` / moodLexicon.js's
// matchedTerms) against real AniList tag names before ever calling
// AniList's tag_in browse -- see anilist.js's fetchAniListMediaByTags()
// header for why matching against the real vocab (not passing raw LLM
// phrasing straight through) matters.
export async function getTagVocabEntries(supabase) {
  const vocabByCategory = await warmCache(supabase);
  return vocabByCategory.get('TAG') || [];
}

export function rankCategories(scores) {
  return Object.entries(scores)
    .map(([category, { score }]) => ({ category, score }))
    .sort((a, b) => b.score - a.score);
}

// Exclusion-system pass. Collects negatedMatches off the two categories
// it's actually safe/meaningful to hard-exclude on (see NEGATABLE_CATEGORIES
// above). Returns a flat, deduped array of genre/tag NAMES -- domains.js
// merges this straight into plan.excludedGenres alongside the existing
// mood-negation and filter-panel exclusion sources.
export function getNegatedGenreTerms(scores) {
  const out = new Set();
  for (const category of NEGATABLE_CATEGORIES) {
    const negatedMatches = scores?.[category]?.negatedMatches;
    if (!negatedMatches) continue;
    for (const name of negatedMatches) out.add(name);
  }
  return [...out];
}

// Entry 33 fix. Takes the TITLE category's word-bag matches (candidate
// titles that share at least one significant word with the query) and
// re-checks them with a real similarity score against the *full* query,
// not just word overlap. Only returns true if some candidate title is
// actually a close match to the whole query -- e.g. "vagabond" against
// "Vagabond" scores high; "i am feeling lonely" against "Lonely Man" does
// not, because the two strings are mostly dissimilar outside the one
// shared word. This is what Entry 32's genre-routing fix gates on instead
// of the raw classifier TITLE score.
export function hasStrongTitleMatch(scores, rawQuery, threshold = TITLE_SIMILARITY_THRESHOLD) {
  const titleMatches = scores?.TITLE?.matches;
  if (!titleMatches || titleMatches.length === 0) return false;

  const normalizedQuery = normalize(rawQuery || '');
  if (!normalizedQuery) return false;

  for (const name of titleMatches) {
    const score = similarity(normalizedQuery, normalize(name));
    if (score >= threshold) return true;
  }
  return false;
}
