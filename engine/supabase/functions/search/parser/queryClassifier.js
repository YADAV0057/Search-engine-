import { getAfinnScore } from './dictionary/afinn.js';
import { normalizeAndTokenize, normalize } from './normalize.js'; 
import { similarity } from './fuzzyMatch.js';

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

let cache = null;
let cacheLoadedAt = 0;
let warmingPromise = null;

function significantTokens(name) {
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

function matchesCategoryPhrase(queryTokenSet, vocabEntries) {
  const matches = [];
  for (const entry of vocabEntries) {
    if (entry.tokens.some((t) => queryTokenSet.has(t))) {
      matches.push(entry.name);
    }
  }
  return matches;
}

function scoreEmotion(queryTokens) {
  const matches = [];
  for (const token of queryTokens) {
    const score = getAfinnScore(token);
    if (score !== null && score !== 0) matches.push(token);
  }
  return matches;
}

export async function classifyQuery(supabase, rawQuery) {
  const queryTokens = normalizeAndTokenize(rawQuery || '');
  if (queryTokens.length === 0) return {};

  const queryTokenSet = new Set(queryTokens);
  const vocabByCategory = await warmCache(supabase);

  const scores = {};

  for (const [category, entries] of vocabByCategory.entries()) {
    const matches = matchesCategoryPhrase(queryTokenSet, entries);
    if (matches.length > 0) {
      scores[category] = { score: matches.length, matches };
    }
  }

  const emotionMatches = scoreEmotion(queryTokens);
  if (emotionMatches.length > 0) {
    scores.EMOTION = { score: emotionMatches.length, matches: emotionMatches };
  }

  return scores;
}

export function rankCategories(scores) {
  return Object.entries(scores)
    .map(([category, { score }]) => ({ category, score }))
    .sort((a, b) => b.score - a.score);
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
