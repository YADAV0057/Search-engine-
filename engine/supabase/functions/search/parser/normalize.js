

/**
 * Normalize user search text.
 * Cleans the input so later parser modules can work consistently. 
 */

export function normalize(input) {

    if (!input) return "";

    return input

        // Unicode normalize first — collapses accented/composed characters
        // to their canonical form before any other rule runs, so downstream
        // regexes see consistent bytes regardless of input encoding quirks.
        .normalize('NFKC')

        // Convert to lowercase
        .toLowerCase()

        // Normalize curly quotes to straight quotes
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')

        // Remove punctuation except apostrophes
        .replace(/[^\w\s']/g, " ")

        // Replace multiple spaces with one
        .replace(/\s+/g, " ")

        // Trim spaces at beginning/end
        .trim();

}

/**
 * Splits already-normalized text into tokens.
 * "sad romance manga" -> ["sad", "romance", "manga"]
 *
 * Deliberately dumb — no stopword removal, no stemming. Callers that want
 * stopwords stripped (e.g. an intent classifier scoring content words) do
 * that themselves via removeStopwords() below; keeping this function pure
 * means every caller sees the same token boundaries regardless of what
 * they plan to do with them.
 */
export function tokenize(normalizedText) {
    if (!normalizedText) return [];
    return normalizedText.split(/\s+/).filter(Boolean);
}

/** Convenience wrapper — normalize then tokenize in one call. */
export function normalizeAndTokenize(input) {
    return tokenize(normalize(input));
}

// Small, deliberately conservative list — only words that carry no signal
// for intent/genre/emotion classification. Words like "no"/"not" are kept:
// they flip meaning ("no romance"), and excludedGenres logic downstream
// depends on seeing them.
const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'i', 'me', 'my', 'you', 'your', 'it', 'its', 'this', 'that',
    'want', 'need', 'give', 'gives', 'looking', 'for', 'to', 'of', 'in',
    'on', 'and', 'or', 'with', 'something', 'some', 'any', 'please'
]);

/** Drops low-signal words from an already-tokenized array. */
export function removeStopwords(tokens) {
    return tokens.filter(t => !STOPWORDS.has(t));
}
