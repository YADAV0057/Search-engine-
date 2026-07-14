// SAVE AS: engine/supabase/functions/search/parser/synonyms.js
//
// DB-backed synonym expansion. Queries `lexicon_synonyms` (alias, concept,
// score) — populated by harvest-lexicons's harvestSynonyms() step, which
// reads every genre/tag/theme/demographic name already in lexicon_entities
// and asks Datamuse's free ml= (means-like) endpoint for related words,
// then upserts them INVERTED as (alias, concept, score) rows so a lookup
// by the word a user actually typed resolves to the concept it maps to.
// See 0003_synonyms.sql and the harvest-lexicons changelog entry
// "Synonym engine: DB-backed design, drafted" for the full decision log.
//
// Replaces the old static SYNONYM_MAP (dictionary.js) with this
// request-time lookup, cached in-memory and refreshed periodically — same
// warm/refresh pattern fuzzyMatch.js's warmVocab()/getVocab() use
// elsewhere in this codebase. Reimplemented here (not imported) since
// these parser files don't share module-level state across files in this
// engine's layout.
//
// Datamuse's ml= results are sometimes noisy — broad "means-like"
// association rather than a strict synonym (flagged as an open question
// in the project log). SCORE_CUTOFF is kept as a named, easy-to-raise
// knob rather than a magic number in case noisy aliases show up in real
// query traffic.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — matches fuzzyMatch.js's refresh interval
const PAGE_SIZE = 1000;
const SCORE_CUTOFF = 0; // Datamuse scores are always >= 0; raise this if low-quality aliases turn out to be a real problem

let cache = null; // Map<alias, Array<{ concept: string, score: number }>>, sorted best-first per alias
let cacheLoadedAt = 0;
let warmingPromise = null;

async function loadAllSynonyms(supabase) {
  const map = new Map();
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('lexicon_synonyms')
      .select('alias, concept, score')
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('[synonyms] warm fetch error', error);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (typeof row.score === 'number' && row.score < SCORE_CUTOFF) continue;
      const entry = { concept: row.concept, score: row.score ?? 0 };
      const existing = map.get(row.alias);
      if (existing) existing.push(entry);
      else map.set(row.alias, [entry]);
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // Highest-score concept first per alias, so callers that just want the
  // single best expansion don't need to re-sort on every lookup.
  for (const entries of map.values()) {
    entries.sort((a, b) => b.score - a.score);
  }

  return map;
}

/**
 * Ensures the in-memory cache is populated and fresh. Safe to call on
 * every request: only actually hits the DB when the cache is empty or
 * stale (TTL-based, same 6h window as fuzzyMatch.js), and concurrent
 * callers share one in-flight warm instead of each kicking off their own
 * fetch. A stale-but-present cache is served immediately while the
 * refresh happens in the background, so no single request pays the full
 * warm cost.
 */
async function warmCache(supabase) {
  const isStale = !cache || (Date.now() - cacheLoadedAt) > CACHE_TTL_MS;
  if (!isStale) return cache;

  if (!warmingPromise) {
    warmingPromise = loadAllSynonyms(supabase)
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

  if (cache) return cache; // stale but present — serve it, refresh in background
  return warmingPromise; // cold start — nothing to serve yet, must wait
}

/**
 * Returns the ranked list of { concept, score } for a single alias word,
 * or [] if it has no known synonyms. Word is normalized (trim + lowercase)
 * before lookup, matching how harvestSynonyms() stored aliases.
 */
export async function getSynonyms(supabase, word) {
  const normalized = (word || '').trim().toLowerCase();
  if (!normalized) return [];

  const map = await warmCache(supabase);
  return map.get(normalized) || [];
}

/**
 * Expands an already-tokenized query into alias->concept matches — one
 * best-match concept per token that has a synonym row. Only words that
 * exist in the alias vocabulary get expanded (the cheaper, more precise
 * option per the project log's open question on this); tokens with no
 * match are left alone, not silently dropped from the result.
 *
 * Returns: Array<{ term: string, concept: string, score: number }>
 */
export async function expandTokensWithSynonyms(supabase, tokens) {
  const map = await warmCache(supabase);
  const expansions = [];

  for (const token of tokens || []) {
    const normalized = (token || '').trim().toLowerCase();
    if (!normalized) continue;

    const matches = map.get(normalized);
    if (matches && matches.length > 0) {
      expansions.push({ term: normalized, concept: matches[0].concept, score: matches[0].score });
    }
  }

  return expansions;
}
