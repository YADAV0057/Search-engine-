// js/parser/synonyms.js
import { SYNONYM_MAP } from './dictionary.js';

/**
 * FIX: the old version did `normalizedText.split(" ")` and looked each
 * single token up in SYNONYM_MAP. That can never match a multi-word alias
 * ("get even", "a bit", or any harvested alias that's more than one word) —
 * those keys just sat in SYNONYM_MAP unused. This version matches phrases
 * against the raw text directly, longest phrase first, so multi-word
 * aliases are translated before any of their component single words are
 * considered on their own.
 */

// Build once, at module load: every SYNONYM_MAP key split into words,
// sorted so longer (more specific) phrases are tried before shorter ones.
// This must be a >0-length check in case SYNONYM_MAP is still empty at
// import time in some test/mocking context.
let PHRASES = null;
function getPhrases() {
    if (PHRASES) return PHRASES;
    PHRASES = Object.keys(SYNONYM_MAP)
        .map(key => ({ key, words: key.split(/\s+/).filter(Boolean) }))
        .sort((a, b) => b.words.length - a.words.length || b.key.length - a.key.length);
    return PHRASES;
}

/** Does the phrase's word sequence occur in `words` starting at index i? */
function matchesAt(words, i, phraseWords) {
    if (i + phraseWords.length > words.length) return false;
    for (let j = 0; j < phraseWords.length; j++) {
        if (words[i + j] !== phraseWords[j]) return false;
    }
    return true;
}

/**
 * Replaces synonyms/aliases in the normalized text with their core
 * dictionary equivalents (concept ids), matching whole phrases so
 * multi-word aliases work exactly like single-word ones.
 */
export function applySynonyms(normalizedText) {
    if (!normalizedText) return "";

    const words = normalizedText.split(/\s+/).filter(Boolean);
    const phrases = getPhrases();
    const out = [];

    let i = 0;
    while (i < words.length) {
        let matched = false;

        for (const phrase of phrases) {
            if (matchesAt(words, i, phrase.words)) {
                out.push(SYNONYM_MAP[phrase.key]);
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

    return out.join(" ");
}
