// js/parser/dictionary.js
//
// MOOD_DICTIONARY / SYNONYM_MAP / URGENCY_MODIFIERS are still placeholders —
// not salvaged/rebuilt yet. synonyms.js and fuzzyMatch.js both import them;
// this stub exists so the module graph resolves. Replace with the real
// mood dictionary before relying on applySynonyms()/mood-based correction.
//
// GENRE_VOCAB / TITLE_VOCAB below are new and NOT placeholders — they're a
// real (if starter-sized) word list used by fuzzyMatch.js's spell
// correction and by the intent classifier for genre/title matching.
// Kept separate from SYNONYM_MAP because they're plain word lists, not
// alias->concept mappings — no semantic replacement happens with these,
// they're purely "is this word close enough to a known word".

export const MOOD_DICTIONARY = {};
export const SYNONYM_MAP = {};
export const URGENCY_MODIFIERS = {};

// Genre/theme/demographic names the adapters already recognize (see
// GENRE_ID_MAP in adapters/jikan.js, MD_TAG_MAP in adapters/mangadex.js).
// Kept as plain words (post toGenreKey()/toTagKey() normalization) so a
// typo like "romnce" or "isekei" corrects to a word the adapters can
// actually map to a genre ID. Extend this list whenever a new genre key is
// added to an adapter's map — it should stay a superset of every adapter's
// genre keys, since correction happens before genre lookup.
export const GENRE_VOCAB = [
    'action', 'adventure', 'comedy', 'drama', 'fantasy', 'horror',
    'mystery', 'psychological', 'romance', 'scifi', 'sliceoflife',
    'sports', 'supernatural', 'thriller', 'mecha', 'music', 'isekai',
    'shounen', 'shoujo', 'seinen', 'josei', 'ecchi', 'harem', 'tragedy',
    'martial', 'arts', 'historical', 'gore', 'villainess', 'reincarnation'
];

// Starter seed list of well-known manga titles, for typo correction only
// (e.g. "bersek" -> "berserk"). NOT exhaustive and not meant to be — a
// hardcoded list can never keep up with the catalog. Once the engine has a
// harvested/cached title index (see README section 5, open questions),
// swap or supplement this with real titles pulled from search_cache /
// a dedicated titles table instead of maintaining this list by hand.
export const TITLE_VOCAB = [
    'berserk', 'naruto', 'bleach', 'jujutsu', 'kaisen', 'chainsaw',
    'attack', 'titan', 'demon', 'slayer', 'onepiece', 'piece', 'vinland',
    'saga', 'vagabond', 'monster', 'solo', 'leveling', 'tokyo', 'ghoul',
    'hunter', 'fullmetal', 'alchemist', 'spy', 'family', 'oshi',
    'jojo', 'bizarre', 'adventure', 'goodnight', 'punpun'
];
