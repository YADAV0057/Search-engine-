// engine/subspace/function/search/parser/synonyms.js
//
// REWRITTEN 2026-07-13: previously imported a static SYNONYM_MAP from
// dictionary.js. Replaced with a request-time lookup against the
// lexicon_synonyms table (alias -> concept, harvested via Datamuse's ml=
// endpoint against every genre/tag/theme/demographic name already in
// lexicon_entities — see harvest-lexicons/index.ts's harvestSynonyms() and
// 0003_synonyms.sql). Mirrors fuzzyMatch.js's exact "load real data from
// DB, cache in memory, refresh every 6h" pattern (warmVocab()/getVocab())
// rather than inventing a new caching strategy — same reasoning ChatGPT's
// design notes gave: this is finishing wiring that's already half-done,
// not a new direction.
//
// FIX (carried over from the old version): the old version did
// `normalizedText.split(" ")` and looked each single token up in
// SYNONYM_MAP. That can never match a multi-word alias ("get even", "a
// bit", or any harvested alias that's more than one word) — those keys
// just sat unused. This version matches phrases against the raw text
// directly, longest phrase first, so multi-word aliases are translated
// before any of their component single words are considered on their own.
// Datamuse mostly returns single words, but this keeps working if a
// future data source contributes multi-word aliases.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Self-contained client, same pattern as fuzzyMatch.js and
// harvest-lexicons/index.js — this module needs the DB regardless of
// which caller (domains.js, a future intent pipeline, ...) ends up
// invoking applySynonyms(), so it doesn't rely on being handed a client
// instance. Guarded with a null fallback so this file doesn't throw in a
// context with no Supabase env vars set (e.g. a local unit test) — it
// just runs as a no-op (returns input unchanged) until the DB is
// reachable.
const supabase = (Deno.env.get('SUPABASE_URL') && Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    ? createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    : null;

const DB_PAGE_SIZE = 1000; // PostgREST's default per-request row cap — must paginate past it once the table grows
const DB_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h — same TTL as fuzzyMatch.js's vocab refresh; no reason to be fresher

// Map of alias -> { concept, score } for the single best (highest-score)
// concept per alias. Built from all lexicon_synonyms rows on load/refresh.
// A Map, not a plain object, so `.has()`/`.get()` work regardless of what
// an alias string happens to look like (e.g. "constructor" as an alias
// would break a plain-object lookup via prototype pollution footguns).
let aliasMap = new Map();
let loadedAt = 0;
let loadInFlight = null;

async function fetchAllSynonymRows() {
    const rows = [];
    let from = 0;
    // Paginate with .range() rather than one .select() — PostgREST caps a
    // single response at DB_PAGE_SIZE rows, and this table will keep
    // growing as more concepts get harvested and Datamuse returns more
    // aliases per concept.
    while (true) {
        const { data, error } = await supabase
            .from('lexicon_synonyms')
            .select('alias, concept, score')
            .range(from, from + DB_PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < DB_PAGE_SIZE) break; // short page = last page
        from += DB_PAGE_SIZE;
    }
    return rows;
}

async function loadAliasMapNow() {
    const rows = await fetchAllSynonymRows();
    const map = new Map();

    for (const row of rows) {
        if (!row.alias || !row.concept) continue;
        const existing = map.get(row.alias);
        // An alias can map to more than one concept (e.g. Datamuse might
        // return "war" as related to both "action" and "military"). Keep
        // only the highest-scored concept per alias, same "don't invent
        // ambiguity, pick the closest match" philosophy as fuzzyMatch.js's
        // correctWord() picking the lowest edit distance.
        if (!existing || row.score > existing.score) {
            map.set(row.alias, { concept: row.concept, score: row.score });
        }
    }

    aliasMap = map;
    loadedAt = Date.now();
}

/**
 * Triggers a refresh of the in-memory alias map from lexicon_synonyms.
 * Safe to call repeatedly — a refresh already in flight is reused rather
 * than started twice, and a fresh-enough cache (< DB_REFRESH_MS old) is a
 * no-op unless `force`.
 *
 * Not required before calling applySynonyms() — it triggers this itself
 * in the background on first use. Call it explicitly (and await it) at
 * cold start if you want the very first request on a fresh instance to
 * already have synonym data rather than falling through as a no-op.
 */
export async function warmSynonyms({ force = false } = {}) {
    if (!supabase) return; // no DB configured — no-op by design, same as fuzzyMatch.js
    const stale = Date.now() - loadedAt > DB_REFRESH_MS;
    if (!force && loadedAt > 0 && !stale) return;
    if (!loadInFlight) {
        loadInFlight = loadAliasMapNow()
            .catch((err) => console.error('[synonyms] alias map refresh failed', err))
            .finally(() => { loadInFlight = null; });
    }
    await loadInFlight;
}

// Fire off a background refresh the first time applySynonyms() actually
// runs, so a warm instance ends up with full synonym data without every
// caller needing to know about warmSynonyms(). Deliberately not awaited
// here — expansion still works immediately (as a no-op passthrough until
// the fetch resolves), same tradeoff fuzzyMatch.js makes for typo
// correction vocab.
let backgroundWarmKicked = false;
function kickBackgroundWarm() {
    if (backgroundWarmKicked) return;
    backgroundWarmKicked = true;
    warmSynonyms().catch(() => {}); // errors already logged inside warmSynonyms
}

/** Does the phrase's word sequence occur in `words` starting at index i? */
function matchesAt(words, i, phraseWords) {
    if (i + phraseWords.length > words.length) return false;
    for (let j = 0; j < phraseWords.length; j++) {
        if (words[i + j] !== phraseWords[j]) return false;
    }
    return true;
}

// Built once per aliasMap version — every alias split into words, sorted
// longest-first, same reasoning as fuzzyMatch.js's combinedVocab caching:
// rebuilding this per-request once the table has thousands of rows would
// be wasteful.
let phrasesCache = null;
let phrasesCacheSize = -1;
function getPhrases() {
    if (phrasesCache && phrasesCacheSize === aliasMap.size) return phrasesCache;
    phrasesCache = [...aliasMap.keys()]
        .map((alias) => ({ alias, words: alias.split(/\s+/).filter(Boolean) }))
        .sort((a, b) => b.words.length - a.words.length || b.alias.length - a.alias.length);
    phrasesCacheSize = aliasMap.size;
    return phrasesCache;
}

/**
 * Replaces aliases in the normalized text with their canonical concept
 * (e.g. "depressed" -> "tragedy"), matching whole phrases so a future
 * multi-word alias works exactly like a single-word one. Words with no
 * alias match are left untouched — this only ever expands to a concept
 * the harvest has actually confirmed a relationship for, it doesn't
 * invent matches out of nothing.
 *
 * Falls through as a no-op (returns input unchanged) if the DB isn't
 * configured or the alias map hasn't loaded yet — same "never throw,
 * degrade gracefully" contract as fuzzyMatch.js's correctTypos().
 */
export function applySynonyms(normalizedText) {
    if (!normalizedText) return '';
    kickBackgroundWarm();

    if (aliasMap.size === 0) return normalizedText; // no data loaded yet — passthrough

    const words = normalizedText.split(/\s+/).filter(Boolean);
    const phrases = getPhrases();
    const out = [];

    let i = 0;
    while (i < words.length) {
        let matched = false;

        for (const phrase of phrases) {
            if (matchesAt(words, i, phrase.words)) {
                out.push(aliasMap.get(phrase.alias).concept);
                i += phrase.words.length;
                matched = true;
                break;
            }
        }

        if (!matched) {
            out.push(words[i]);
            i += 1;
        }
    }

    return out.join(' ');
}
