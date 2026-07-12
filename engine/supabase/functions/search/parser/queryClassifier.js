// SAVE AS: engine/supabase/functions/search/parser/queryClassifier.js
//
// Step 1 of the Mood Analyzer pipeline (see project Notion §10): classifies
// a raw query into one or more non-exclusive categories — TITLE, AUTHOR,
// CHARACTER, GENRE, TAG, EMOTION — feeding into the Rule Engine (step 2,
// resolveCategories() below) which scores and picks/combines a winner.
//
// REUSES EXISTING VOCAB rather than inventing anything new, per user
// decision 2026-07-13:
// - TITLE/AUTHOR/CHARACTER/GENRE/TAG: lexicon_entities (same table
//   fuzzyMatch.js already reads), mapped from entity_type -> category.
//   Loading pattern (paginated fetch, in-memory Set cache, 6h refresh,
//   background warm-on-first-use) is copied from fuzzyMatch.js's
//   warmVocab()/getVocab() rather than reimplemented differently.
// - EMOTION: AFINN-165 word-sentiment lookup via lexicon.js's
//   getWordData() — the same function synopsisAnalyzer.js already uses.
//   No separate emotion word list needed; if AFINN has an opinion on a
//   word, that's an emotion signal.
//
// NOTE on coverage: AUTHOR (staff) and CHARACTER harvests are still
// rate-limited/stalled per the project changelog (AniList 429s), so those
// two categories will under-match until that harvest catches up. This is
// expected, not a bug in this file — see context log §8 changelog entries
// on the staff harvest.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getWordData } from './dictionary/lexicon.js';

const supabase = (Deno.env.get('SUPABASE_URL') && Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    ? createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    : null;

// Classifier category -> lexicon_entities.entity_type value(s).
// TAG folds tag/theme/demographic together, matching how the Query
// Classifier design doc treats them as one bucket (a query can independently
// also hit GENRE — AniList keeps genre and tag/theme/demographic separate,
// see harvest-lexicons' harvestStatic()).
const CATEGORY_ENTITY_TYPES = {
    TITLE: ['media'],
    AUTHOR: ['staff'],
    CHARACTER: ['character'],
    GENRE: ['genre'],
    TAG: ['tag', 'theme', 'demographic']
};

const DB_PAGE_SIZE = 1000; // PostgREST's per-request row cap, same as fuzzyMatch.js
const DB_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h — same TTL as fuzzyMatch.js/domains.js manga cache, no reason to diverge

// category -> Set<lowercased known name>
let vocabByCategory = {};
let loadedAt = 0;
let loadInFlight = null;

async function fetchAllNames(entityType) {
    const names = [];
    let from = 0;
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

async function loadVocabNow() {
    const result = {};
    for (const [category, entityTypes] of Object.entries(CATEGORY_ENTITY_TYPES)) {
        const set = new Set();
        for (const entityType of entityTypes) {
            const names = await fetchAllNames(entityType);
            names.forEach((n) => set.add(String(n).toLowerCase()));
        }
        result[category] = set;
    }
    vocabByCategory = result;
    loadedAt = Date.now();
}

/**
 * Triggers a refresh of the category vocab from lexicon_entities. Safe to
 * call repeatedly — an in-flight load is reused, a fresh-enough cache is a
 * no-op unless forced. Same contract as fuzzyMatch.js's warmVocab().
 */
export async function warmClassifierVocab({ force = false } = {}) {
    if (!supabase) return; // no DB configured — classifier runs EMOTION-only
    const stale = Date.now() - loadedAt > DB_REFRESH_MS;
    if (!force && loadedAt > 0 && !stale) return;
    if (!loadInFlight) {
        loadInFlight = loadVocabNow()
            .catch((err) => console.error('[queryClassifier] vocab load failed', err))
            .finally(() => { loadInFlight = null; });
    }
    await loadInFlight;
}

let warmKicked = false;
function kickWarm() {
    if (warmKicked) return;
    warmKicked = true;
    warmClassifierVocab().catch(() => {}); // errors already logged inside warmClassifierVocab
}

function tokenize(text) {
    return text.toLowerCase().replace(/[^a-z0-9'\-\s]/g, ' ').split(/\s+/).filter(Boolean);
}

// Below this length, a single word from a vocab name is too generic to
// trust as a match on its own (e.g. "one" from "one piece", "d" from
// "monkey d luffy") — skipped unless a name has NO word at or above this
// length, in which case we fall back to using all of its words anyway
// rather than making that name unmatchable.
const SIGNIFICANT_WORD_MIN_LEN = 4;

function nameTokens(name) {
    return name.split(/\s+/).filter(Boolean);
}

/**
 * Bidirectional token-overlap match, replacing a naive "does the full
 * query string contain the full vocab name" substring check (see sanity
 * check finding, 2026-07-13): AniList staff/character names are stored in
 * FULL ("Kentaro Miura"), so a query using just a surname — "berserk by
 * miura" — never contained the full name as a substring and silently
 * missed AUTHOR entirely. This instead checks whether ANY significant word
 * from a vocab name appears as its OWN token in the query, so a partial
 * name (surname-only, one word of a multi-word title, etc.) still matches.
 *
 * Tradeoff, accepted deliberately (user decision 2026-07-13): this can
 * over-match on common single-word names/titles (e.g. a TITLE entry
 * literally named "Air" matching any query containing the word "air") —
 * preferred over the previous false-negative-heavy behavior for this
 * project's stage. Revisit with a stricter significance/frequency filter
 * if false positives become a real problem once real vocab volume is in.
 */
function matchesCategoryPhrase(queryTokenSet, vocabSet) {
    for (const name of vocabSet) {
        const tokens = nameTokens(name);
        const significant = tokens.filter((w) => w.length >= SIGNIFICANT_WORD_MIN_LEN);
        const candidates = significant.length > 0 ? significant : tokens; // don't make short-word-only names unmatchable
        for (const word of candidates) {
            if (queryTokenSet.has(word)) return name;
        }
    }
    return null;
}

/**
 * Step 1: Query Classifier.
 * @param {string} query  Raw user query
 * @returns {{
 *   categories: string[],                        // e.g. ["TITLE", "AUTHOR"]
 *   matches: Record<string, string|string[]>,     // what actually matched per category
 *   scores: Record<string, number>                // additive scores, feed into resolveCategories()
 * }}
 */
export function classifyQuery(query) {
    kickWarm();
    const queryLower = (query || '').toLowerCase().trim();
    const tokens = tokenize(queryLower);
    const queryTokenSet = new Set(tokens);

    const categories = [];
    const matches = {};
    const scores = { TITLE: 0, AUTHOR: 0, CHARACTER: 0, GENRE: 0, TAG: 0, EMOTION: 0 };

    // --- Phrase-based categories, reusing lexicon_entities vocab ---
    // On a cold instance before the first warm completes, vocabByCategory
    // is still empty — this quietly no-ops for these categories rather
    // than throwing, same graceful-degrade approach as fuzzyMatch.js's
    // bootstrap-vocab fallback.
    for (const category of ['TITLE', 'AUTHOR', 'CHARACTER', 'GENRE', 'TAG']) {
        const vocabSet = vocabByCategory[category];
        if (!vocabSet || vocabSet.size === 0) continue;
        const matched = matchesCategoryPhrase(queryTokenSet, vocabSet);
        if (matched) {
            categories.push(category);
            matches[category] = matched;
            scores[category] += 1;
        }
    }

    // --- EMOTION, via AFINN-165 (lexicon.js) — same lookup synopsisAnalyzer.js uses ---
    const emotionWords = tokens.filter((token) => getWordData(token));
    if (emotionWords.length > 0) {
        categories.push('EMOTION');
        matches.EMOTION = emotionWords;
        scores.EMOTION += emotionWords.length;
    }

    return { categories, matches, scores };
}

/**
 * Step 2: Rule Engine (§4 of the design doc) — picks the winning
 * category(ies) by highest score. Ties combine, matching "pick the
 * highest score or combine them" from the design. TIE_MARGIN is 0 (exact
 * ties only) for now — widen it later if real query volume shows close-
 * but-not-equal scores should also combine.
 */
const TIE_MARGIN = 0;
export function resolveCategories(scores) {
    const nonZero = Object.entries(scores).filter(([, v]) => v > 0);
    if (nonZero.length === 0) return [];
    const maxScore = Math.max(...nonZero.map(([, v]) => v));
    return nonZero.filter(([, v]) => v >= maxScore - TIE_MARGIN).map(([k]) => k);
}
