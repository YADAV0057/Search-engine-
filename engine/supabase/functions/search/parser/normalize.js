
/**
 * Normalize user search text.
 * Cleans the input so later parser modules can work consistently. 
 */

export function normalize(input) {

    if (!input) return "";

    return input

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
