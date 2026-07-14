// SAVE AS: engine/supabase/functions/search/parser/queryClassifier.js
//
// Step 1 of the Mood Analyzer pipeline (project log §10): classifies a
// raw query into one or more non-exclusive categories — TITLE, AUTHOR,
// CHARACTER, GENRE, TAG, EMOTION — then Step 2 (the "Rule Engine") ranks
// every category that matched by score, highest first. Results are shown
// across multiple categories at once rather than committing to a single
// winner (2026-07-13 design decision — rankCategories() below replaces an
// earlier tie-picking resolveCategories() approach).
//
// TITLE/AUTHOR/CHARACTER/GENRE/TAG reuse the vocab already harvested into
// lexicon_entities (same table fuzzyMatch.js reads), via a category ->
// entity_type map below (TAG folds tag+theme+demographic into one
// category — AniList's 3-way split is meaningful to the harvester, not to
// a query classifier). EMOTION reuses the live AFINN-165 wordlist
// (parser/dictionary/afinn.js's getAfinnScore()) — no separate emotion
// word list.
//
// Vocab loading (paginated fetch + in-memory cache + 6h refresh +
// background warm-on-first-use) mirrors the same pattern fuzzyMatch.js and
// synonyms.js use elsewhere in this codebase. Reimplemented here (not
// imported) since these parser files don't share module-level state
// across files in this engine's layout.
//
// Known limitation carried over from the design log: AUTHOR/CHARACTER
// will under-match until the stalled staff/character AniList harvest (see
// harvest-lexicons changelog, 429 rate-limiting) catches up — not a bug in
// this file, just thin upstream data.

import { getAfinnScore } from './dictionary/afinn.js';
import { normalizeAndTokenize } from './normalize.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const PAGE_SIZE = 1000;

// Skips noise words like "one"/"d" that would otherwise token-overlap-match
// almost anything — same threshold chosen during the 2026-07-13 sanity-check
// fix below.
const MIN_SIGNIFICANT_WORD_LENGTH = 4;

const CATEGORY_ENTITY_TYPES = {
  TITLE: ['media'],
  AUTHOR: ['staff'],
  CHARACTER: ['character'],
  GENRE: ['genre'],
  TAG: ['tag', 'theme', 'demographic']
};

let cache = null; // Map<category, Array<{ name: string, tokens: string[] }>>
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

/**
 * Ensures the in-memory vocab cache is populated and fresh. Safe to call
 * every request — a stale-but-present cache is served immediately while a
 * refresh happens in the background, same pattern as synonyms.js's
 * warmCache().
 */
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

/**
 * Bidirectional token-overlap match: true if ANY significant word (>=4
 * letters) from a vocab entry's name appears as its own token in the
 * query. Replaces an earlier naive full-string substring match, which
 * failed on queries like "berserk by miura" against a staff name stored
 * as "Kentaro Miura" — a surname-only query never contains the full
 * stored name as a substring (2026-07-13 sanity-check fix).
 *
 * Accepted tradeoff, logged rather than re-litigated: this can over-match
 * on common single-word names/titles (e.g. a title literally named "Air"
 * matching any query containing "air"). Preferred over the prior
 * false-negative-heavy behavior at this stage; revisit with a stricter
 * filter if real query volume shows false positives.
 */
function matchesCategoryPhrase(queryTokenSet, vocabEntries) {
  const matches = [];
  for (const entry of vocabEntries) {
    if (entry.tokens.some((t) => queryTokenSet.has(t))) {
      matches.push(entry.name);
    }
  }
  return matches;
}

/**
 * EMOTION scoring: every query token with a nonzero AFINN score counts,
 * uncapped — matches the "scoring uncapped" fix applied to the phrase
 * categories below, so EMOTION doesn't structurally win ties just because
 * phrase categories used to cap at 1 match regardless of how many vocab
 * entries actually matched.
 */
function scoreEmotion(queryTokens) {
  const matches = [];
  for (const token of queryTokens) {
    const score = getAfinnScore(token);
    if (score !== null && score !== 0) matches.push(token);
  }
  return matches;
}

/**
 * Classifies a raw query string into every category it matches, each with
 * a score = count of distinct matching vocab entries/words — NOT capped
 * at 1 (2026-07-13 "scoring uncapped" decision: matchesCategoryPhrase()
 * returns every matching vocab entry per category, not just the first, so
 * e.g. "psychological tragedy" scores TAG(2) rather than TAG(1)).
 *
 * Returns: { [category]: { score: number, matches: string[] } } — only
 * categories with score > 0 are included; a zero-score category is
 * omitted entirely rather than present at score 0.
 */
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

/**
 * Rule Engine (Step 2): sorts every category that matched by score,
 * highest first, and returns the full ranked list — NOT a single
 * tie-picked winner (2026-07-13 redesign: results are shown across
 * multiple categories at once, so the caller decides how many ranks deep
 * to surface rather than this function deciding for them).
 */
export function rankCategories(scores) {
  return Object.entries(scores)
    .map(([category, { score }]) => ({ category, score }))
    .sort((a, b) => b.score - a.score);
}
