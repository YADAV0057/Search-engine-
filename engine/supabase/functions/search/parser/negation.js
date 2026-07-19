// parser/negation.js
//
// Shared negation-scope detection. Split out of moodLexicon.js's Entry 34
// fix so queryClassifier.js can reuse the exact same trigger list and
// windowing logic for GENRE/TAG terms, not just emotion words.
//
// Before this split, negation only ever suppressed AFINN/lexicon emotion
// scoring (moodLexicon.js). A literal genre word matched by
// queryClassifier.js -- e.g. "horror" in "anything except horror" -- was
// scored as a POSITIVE genre-match boost, completely bypassing negation,
// because queryClassifier.js had no negation awareness of its own at all.
// That's the root cause behind "anything except horror" surfacing
// Bastard/Sweet Home/Shotgun Boy -- all horror -- instead of excluding it:
// the exclusion mechanism itself (plan.excludedGenres -> genre_not_in on
// AniList, ID-exclusion on Jikan/MangaDex) already existed and worked fine
// for filters.excludedGenres and mood-based negation; it just had no way to
// hear "except horror" from the query text.
//
// NEGATION_SCOPE_TOKENS is a raw token-count window (not a content-word
// count) so it can reach past short filler/stopwords sitting between the
// trigger and the actual target word -- e.g. "anything except horror"
// needs to reach 1 token past "except" to negate "horror"; "I don't want
// anything sad" needs to reach 3 past "don't". Not yet tuned against a
// broad query sample -- same caveat as every other threshold constant in
// this codebase (TITLE_SIMILARITY_THRESHOLD, MOOD_GENRE_INCLUSION_THRESHOLD).
export const NEGATION_SCOPE_TOKENS = 3;

// ADDED (exclusion-system pass, QA finding #1): except/excluding/avoid/
// hate/dislike family. "except"/"excluding"/"exclude" were the literal gap
// behind "anything except horror" failing -- those trigger words simply
// didn't exist before. avoid/hate/dislike are the other trigger words QA
// explicitly called out, alongside the already-covered "no"/"without"/
// "don't want".
//
// ADDED (follow-up pass, more words): skip/minus/omit/zero/sans, and the
// despise/loathe/detest family (same slot as hate/dislike -- decisive
// distaste, not just mild preference).
//
// DELIBERATELY NOT ADDED: "nothing" -- "nothing but action" is an idiom
// meaning ONLY action, the opposite of exclusion. A blanket single-token
// trigger here would silently invert that query's meaning rather than
// just missing it, which is worse than not catching it at all. "besides"
// is genuinely ambiguous in English (can mean "in addition to" OR
// "except" depending on context) with no cheap token-level disambiguation
// -- also left out rather than guessed at.
export const NEGATION_TRIGGERS = new Set([
  'not', 'no', 'never', 'without',
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "won't", "wouldn't", "couldn't", "shouldn't", "can't", 'cannot',
  "haven't", "hasn't", "hadn't",
  'except', 'excluding', 'exclude',
  'avoid', 'avoiding',
  'hate', 'hates', 'hated',
  'dislike', 'dislikes',
  'skip', 'skipping',
  'minus',
  'omit', 'omitting',
  'zero',
  'sans',
  'despise', 'despises', 'despised',
  'loathe', 'loathes', 'loathed',
  'detest', 'detests', 'detested'
]);

// ADDED (follow-up pass): multi-word trigger phrases. A single-token list
// can't catch "manga other than isekai" or "romance instead of horror" --
// neither "other"/"than"/"instead"/"of" is safe as a standalone trigger
// (all four are extremely common words with no negation meaning on their
// own), but the exact sequence together is an unambiguous exclusion
// phrase. Checked as a token-sequence match, not a single Set lookup.
export const NEGATION_TRIGGER_PHRASES = [
  ['other', 'than'],
  ['aside', 'from'],
  ['apart', 'from'],
  ['rather', 'than'],
  ['instead', 'of'],
  ['get', 'rid', 'of'],
  ['stay', 'away', 'from'],
  ['keep', 'away', 'from']
];

export function isNegationTrigger(token) {
  return NEGATION_TRIGGERS.has(token) || token.endsWith("n't");
}

function matchesPhraseAt(tokens, startIndex, phrase) {
  if (startIndex + phrase.length > tokens.length) return false;
  for (let k = 0; k < phrase.length; k++) {
    if (tokens[startIndex + k] !== phrase[k]) return false;
  }
  return true;
}

/**
 * Marks, for each token index, whether it falls within NEGATION_SCOPE_TOKENS
 * tokens after a negation trigger -- either a single-word trigger
 * (NEGATION_TRIGGERS) or a multi-word phrase (NEGATION_TRIGGER_PHRASES).
 * The trigger itself (all of its tokens, for a phrase) is never marked.
 * The scope window is measured from the END of whichever trigger matched,
 * same NEGATION_SCOPE_TOKENS length either way.
 */
export function computeNegationMask(tokens) {
  const negated = new Array(tokens.length).fill(false);

  for (let i = 0; i < tokens.length; i++) {
    let triggerEnd = null;

    if (isNegationTrigger(tokens[i])) {
      triggerEnd = i;
    } else {
      for (const phrase of NEGATION_TRIGGER_PHRASES) {
        if (matchesPhraseAt(tokens, i, phrase)) {
          triggerEnd = i + phrase.length - 1;
          break; // first phrase match at this position wins -- phrases in
                 // the list don't overlap in a way where a second match
                 // at the same start index would mean anything different
        }
      }
    }

    if (triggerEnd === null) continue;

    for (let j = triggerEnd + 1; j <= triggerEnd + NEGATION_SCOPE_TOKENS && j < tokens.length; j++) {
      negated[j] = true;
    }
  }

  return negated;
}
