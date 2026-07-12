// engine/supabase/functions/search/parser/dictionary.js
//
// MOOD_DICTIONARY / URGENCY_MODIFIERS are still placeholders — not
// salvaged/rebuilt yet.
//
// SYNONYM_MAP: REVERTED to an empty stub 2026-07-13. A populated version
// was drafted here briefly (hand-typed "sad"/"action" aliases) but
// superseded same-day by a DB-backed design: synonyms.js now queries the
// lexicon_synonyms table directly (harvested via Datamuse against every
// AniList genre/tag/theme/demographic name — see
// harvest-lexicons/index.ts's harvestSynonyms() and 0003_synonyms.sql)
// instead of importing a static map from here. Kept exported as {} only
// so any other module still importing it doesn't break; nothing should
// rely on this having real data anymore. If you're looking for synonym
// data, it's in the DB, not this file.
export const MOOD_DICTIONARY = {};
export const SYNONYM_MAP = {};
export const URGENCY_MODIFIERS = {};

// Genre/theme/demographic names the adapters already recognize (see
// GENRE_ID_MAP in adapters/jikan.js, MD_TAG_MAP in adapters/mangadex.js).
// Kept as plain words (post toGenreKey()/toTagKey() normalization) so a
// typo like "romnce" or "isekei" corrects to a word the adapters can
// actually map to a genre ID.
//
// UPDATED: these two are now BOOTSTRAP-ONLY. fuzzyMatch.js layers the real
// harvested genre/media names from lexicon_entities (populated by
// harvest-lexicons) on top of these at runtime — see fuzzyMatch.js's
// warmVocab()/getVocab(). Keep these lists as they are; they're what
// correction falls back to instantly (no DB round trip) and what it still
// uses if the DB is unreachable or hasn't been harvested yet. No need to
// hand-extend them further now that the real catalog is the primary source.
export const GENRE_VOCAB = [
    'action', 'adventure', 'comedy', 'drama', 'fantasy', 'horror',
    'mystery', 'psychological', 'romance', 'scifi', 'sliceoflife',
    'sports', 'supernatural', 'thriller', 'mecha', 'music', 'isekai',
    'shounen', 'shoujo', 'seinen', 'josei', 'ecchi', 'harem', 'tragedy',
    'martial', 'arts', 'historical', 'gore', 'villainess', 'reincarnation'
];

// Starter seed list of well-known manga titles, for typo correction only
// (e.g. "bersek" -> "berserk"). Superseded as the primary source by
// lexicon_entities (entity_type: 'media') once harvest-lexicons has run —
// see fuzzyMatch.js. Left in place as the instant-available fallback.
export const TITLE_VOCAB = [
    'berserk', 'naruto', 'bleach', 'jujutsu', 'kaisen', 'chainsaw',
    'attack', 'titan', 'demon', 'slayer', 'onepiece', 'piece', 'vinland',
    'saga', 'vagabond', 'monster', 'solo', 'leveling', 'tokyo', 'ghoul',
    'hunter', 'fullmetal', 'alchemist', 'spy', 'family', 'oshi',
    'jojo', 'bizarre', 'adventure', 'goodnight', 'punpun'
];
