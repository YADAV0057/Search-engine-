// js/parser/fuzzyMatch.js
//
// Typo tolerance for the mood/synonym phrase matchers. Those match exact
// strings, so a misspelling like "rivalery" or "acedemic" never matches
// "academic rivalry" at all, no matter how close it is. This corrects each
// word to the nearest known vocabulary word before anything else runs —
// synonyms.js and moodEngine.js don't need to know this happened, they
// just see cleaner input.
//
// CHANGED: vocabulary now also pulls from GENRE_VOCAB/TITLE_VOCAB
// (dictionary.js), not just MOOD_DICTIONARY/SYNONYM_MAP/URGENCY_MODIFIERS.
// Those three are still empty stubs (mood dictionary not rebuilt yet — see
// dictionary.js), so until now correctTypos() had zero words to correct
// against and was a silent no-op. Genre/title typos ("romnce", "bersek")
// now correct correctly; mood-phrase typos still won't until the real
// mood dictionary is ported.

import { MOOD_DICTIONARY, SYNONYM_MAP, URGENCY_MODIFIERS, GENRE_VOCAB, TITLE_VOCAB } from './dictionary.js';

// Built once and cached — walks every dictionary key (which may be
// multi-word, e.g. "academic rivalry") and adds each individual word to the
// vocabulary, since correction happens per-word, not per-phrase. Plain word
// lists (GENRE_VOCAB/TITLE_VOCAB) are added as-is, one entry per word.
let VOCAB = null;
function getVocab() {
    if (VOCAB) return VOCAB;
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
    VOCAB = words;
    return VOCAB;
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

/**
 * Corrects likely typos word-by-word against the known vocabulary (mood
 * concepts/aliases/modifiers + genre/title words). Words that already
 * match exactly, or that don't have a close-enough vocabulary word, are
 * left untouched — this only ever nudges a near-miss to what it almost
 * certainly meant, it doesn't invent matches out of nothing.
 */
export function correctTypos(text) {
    if (!text) return text;
    return text.split(/\s+/).filter(Boolean).map(correctWord).join(' ');
}

/** Same correction, but token-in/token-out — for callers already working with a tokenize()'d array (see normalize.js) instead of a raw string. */
export function correctTokens(tokens) {
    if (!tokens || tokens.length === 0) return [];
    return tokens.map(correctWord);
}
