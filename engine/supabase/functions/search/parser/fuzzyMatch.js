// js/parser/fuzzyMatch.js
//
// Typo tolerance for the mood/synonym phrase matchers. Those match exact
// strings, so a misspelling like "rivalery" or "acedemic" never matches
// "academic rivalry" at all, no matter how close it is. This corrects each
// word to the nearest known vocabulary word before anything else runs —
// synonyms.js and moodEngine.js don't need to know this happened, they
// just see cleaner input.
//
// CHANGED (this pass): vocabulary is no longer just dictionary.js's static
// lists. GENRE_VOCAB/TITLE_VOCAB were always a starter seed ("bersek" ->
// "berserk" but nothing outside that ~30-word list) — see the note in
// dictionary.js. Now, on top of that bootstrap set, this module also reads
// the real genre + manga-title names harvested into lexicon_entities by
// harvest-lexicons (supabase/functions/harvest-lexicons/index.js), so
// correction works against the actual AniList catalog once a harvest has
// run, not just the hand-typed seed list.
//
// MOOD_DICTIONARY/SYNONYM_MAP/URGENCY_MODIFIERS are still empty stubs (see
// dictionary.js) — mood-phrase typos still won't correct until the real
// mood dictionary is ported. This change only affects genre/title words.

import { MOOD_DICTIONARY, SYNONYM_MAP, URGENCY_MODIFIERS, GENRE_VOCAB, TITLE_VOCAB } from './dictionary.js';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Self-contained client, same pattern as harvest-lexicons/index.js — this
// module needs the DB regardless of which caller (domains.js, a future
// intent pipeline, ...) ends up invoking correctTypos()/correctTokens(), so
// it doesn't rely on being handed a client instance. Guarded with a null
// fallback so this file doesn't throw in a context with no Supabase env
// vars set (e.g. a local unit test) — it just runs on bootstrap vocab only.
const supabase = (Deno.env.get('SUPABASE_URL') && Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    ? createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    : null;

// genre: ~500 rows, cheap. media: manga titles only (see harvest-lexicons'
// MANGA-only scoping) — large, but still just short text, fine to hold in
// memory for a warm instance's lifetime per Gemini's original storage math.
const DB_ENTITY_TYPES = ['genre', 'media'];
const DB_PAGE_SIZE = 1000; // PostgREST's default per-request row cap — must paginate past it for media
const DB_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h — matches domains.js's manga cache TTL; no reason to be fresher than the results being corrected against

let dbWords = new Set();
let dbLoadedAt = 0;
let dbVersion = 0;
let dbLoadInFlight = null;

async function fetchAllNames(entityType) {
    const names = [];
    let from = 0;
    // Paginate with .range() rather than one .select() — PostgREST caps a
    // single response at DB_PAGE_SIZE rows, and `media` alone can be tens
    // of thousands of rows after a few harvest runs.
    while (true) {
        const { data, error } = await supabase
            .from('lexicon_entities')
            .select('name')
            .eq('entity_type', entityType)
            .range(from, from + DB_PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const row of data) if (row.name) names.push(row.name);
        if (data.length < DB_PAGE_SIZE) break; // short page = last page
        from += DB_PAGE_SIZE;
    }
    return names;
}

async function loadDbVocabNow() {
    const words = new Set();
    for (const entityType of DB_ENTITY_TYPES) {
        const names = await fetchAllNames(entityType);
        names.forEach((name) => {
            String(name).toLowerCase().split(/\s+/).forEach((w) => {
                if (w.length >= 3) words.add(w); // same 3-char floor as the static lists below
            });
        });
    }
    dbWords = words;
    dbLoadedAt = Date.now();
    dbVersion++;
}

/**
 * Triggers a refresh of the DB-backed portion of the vocabulary (genre +
 * media names from lexicon_entities). Safe to call repeatedly — a refresh
 * already in flight is reused rather than started twice, and a
 * fresh-enough cache (< DB_REFRESH_MS old) is a no-op unless `force`.
 *
 * Not required before calling correctTypos()/correctTokens() — they trigger
 * this themselves in the background on first use. Call it explicitly (and
 * await it) at cold start if you want the very first request on a fresh
 * instance to already have full DB vocab rather than bootstrap-only.
 */
export async function warmVocab({ force = false } = {}) {
    if (!supabase) return; // no DB configured — bootstrap vocab only, by design
    const stale = Date.now() - dbLoadedAt > DB_REFRESH_MS;
    if (!force && dbLoadedAt > 0 && !stale) return;
    if (!dbLoadInFlight) {
        dbLoadInFlight = loadDbVocabNow()
            .catch((err) => console.error('[fuzzyMatch] vocab refresh failed', err))
            .finally(() => { dbLoadInFlight = null; });
    }
    await dbLoadInFlight;
}

// Built once and cached — walks every dictionary key (which may be
// multi-word, e.g. "academic rivalry") and adds each individual word to the
// vocabulary, since correction happens per-word, not per-phrase. Plain word
// lists (GENRE_VOCAB/TITLE_VOCAB) are added as-is, one entry per word. This
// is the bootstrap set only — combinedVocab() below layers dbWords on top.
let bootstrapVocab = null;
function getBootstrapVocab() {
    if (bootstrapVocab) return bootstrapVocab;
    const words = new Set();
    const addWords = (dict) => {
        Object.keys(dict).forEach(key => {
            key.split(/\s+/).forEach(w => {
                if (w.length >= 3) words.add(w); // skip 1-2 letter words — too many false "corrections"
            });
        });
    };
    const addList = (list) => {
        list.forEach(w => {
            if (w.length >= 3) words.add(w);
        });
    };
    addWords(MOOD_DICTIONARY);
    addWords(SYNONYM_MAP);
    addWords(URGENCY_MODIFIERS);
    addList(GENRE_VOCAB);
    addList(TITLE_VOCAB);
    bootstrapVocab = words;
    return bootstrapVocab;
}

// Recombined only when dbWords actually changes (dbVersion bump), not on
// every call — correctWord() iterates this set linearly per word, so
// rebuilding it per-request once media is loaded (tens of thousands of
// entries) would be wasteful.
let combinedVocab = null;
let combinedVersion = -1;
function getVocab() {
    if (combinedVocab && combinedVersion === dbVersion) return combinedVocab;
    combinedVocab = new Set([...getBootstrapVocab(), ...dbWords]);
    combinedVersion = dbVersion;
    return combinedVocab;
}

/** Standard edit-distance (insert/delete/substitute), with an early exit for very mismatched lengths. */
function levenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99; // cheap reject before doing the full DP table
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// How many edits we'll tolerate scales with word length — a 1-edit
// tolerance on a 4-letter word can turn it into an unrelated word, but a
// 1-2 edit typo on a 10-letter word is still clearly "the same word".
function maxDistanceFor(word) {
    if (word.length <= 4) return 1;
    if (word.length <= 8) return 2;
    return 3;
}

/** Corrects a single already-lowercased word against the vocabulary. Returns the word unchanged if no close-enough match exists. */
function correctWord(word) {
    const vocab = getVocab();
    if (word.length < 3 || vocab.has(word)) return word;

    const maxDist = maxDistanceFor(word);
    let best = null;
    let bestDist = Infinity;

    for (const candidate of vocab) {
        if (Math.abs(candidate.length - word.length) > maxDist) continue; // cheap pre-filter
        const dist = levenshtein(word, candidate);
        if (dist < bestDist) {
            bestDist = dist;
            best = candidate;
            if (dist === 0) break;
        }
    }

    return (best && bestDist <= maxDist) ? best : word;
}

// Fire off a background refresh the first time correction actually runs, so
// a warm instance ends up with full DB vocab without every caller needing
// to know about warmVocab(). Deliberately not awaited here — correction
// still works immediately on bootstrap vocab; DB words just join in once
// the fetch resolves (fast — usually well within the same request or the
// next one on a warm instance).
let backgroundWarmKicked = false;
function kickBackgroundWarm() {
    if (backgroundWarmKicked) return;
    backgroundWarmKicked = true;
    warmVocab().catch(() => {}); // errors already logged inside warmVocab
}

// ADDED for rankResults.js (§0-NEW9, ranking formula): correctWord()/
// levenshtein() above operate against the module's own vocab Set, not
// against an arbitrary pair of strings, so there was no existing entry
// point for "how similar are these two specific strings" (e.g. a query
// token vs. one candidate's title). This is purely additive — reuses the
// same levenshtein() already defined above, doesn't change correctTypos()/
// correctTokens()/warmVocab() at all.
/**
 * 0–1 similarity between two strings (1 = identical, 0 = completely
 * different), via the same edit-distance function used internally for
 * vocab correction. Case-sensitive — callers should lowercase both sides
 * first (ranking code already works with lowercased fields/tokens).
 */
export function similarity(a, b) {
    if (!a || !b) return 0;
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 0;
    // levenshtein() returns 99 as a cheap-reject sentinel for very
    // mismatched lengths (see its own early-exit comment above) — clamp
    // so that doesn't produce a nonsensical negative similarity.
    return Math.max(0, 1 - dist / maxLen);
}

/**
 * Corrects likely typos word-by-word against the known vocabulary (mood
 * concepts/aliases/modifiers + genre/title words, now including real
 * harvested genre/media names once warmVocab() has resolved at least once).
 * Words that already match exactly, or that don't have a close-enough
 * vocabulary word, are left untouched — this only ever nudges a near-miss
 * to what it almost certainly meant, it doesn't invent matches out of
 * nothing.
 */
export function correctTypos(text) {
    if (!text) return text;
    kickBackgroundWarm();
    return text.split(/\s+/).filter(Boolean).map(correctWord).join(' ');
}

/** Same correction, but token-in/token-out — for callers already working with a tokenize()'d array (see normalize.js) instead of a raw string. */
export function correctTokens(tokens) {
    if (!tokens || tokens.length === 0) return [];
    kickBackgroundWarm();
    return tokens.map(correctWord);
}
