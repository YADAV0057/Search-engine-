// ==========================================
// REFERENCE-TITLE DETECTION (search/parser/referenceTitle.js)
// ==========================================
// New 2026-07-19. Notion "Backend Update List" Entry 49, gap #4: "Like
// Frieren but more emotional" returned One Piece -- the reference title
// in the query was never extracted or used anywhere; the whole sentence
// just fell into the same literal free-text search path Entry 32 already
// fixed for mood queries (see domains.js's applyMoodGenreRouting header
// for that history). This file is the missing piece: pull a specific
// title mention out of a "like X" / "similar to X" phrase, confirm it
// against the real lexicon_entities TITLE vocabulary (never trust the
// regex alone), and hand the matched title back to domains.js so it can
// drive the fetch via AniList's own curated `recommendations` edge
// instead of genre-guessing or (worse) literal-text search against the
// raw sentence.
//
// Deliberately NOT reusing hasStrongTitleMatch()/TITLE_SIMILARITY_THRESHOLD
// from queryClassifier.js -- that check compares the FULL query string
// against a title (correct for "is this whole query just a title
// search?"), and floors to 0 here almost every time: fuzzyMatch.js's
// similarity() is Levenshtein-based and short-circuits once two strings'
// lengths differ by more than 3 characters, and "like frieren but more
// emotional" vs "Frieren: Beyond Journey's End" differ by dozens of
// characters despite the reference being a clean, unambiguous match. This
// file instead extracts just the referenced phrase first, then scores
// candidates by "what fraction of the extracted phrase's significant
// (>=4 letter) tokens does this title's token set contain" -- the same
// tokenization queryClassifier.js already uses to build its TITLE
// candidate list (see significantTokens(), imported below so both files
// stay in sync), just a different scoring function.

import { normalizeAndTokenize } from './normalize.js';
import { significantTokens, getTitleVocabEntries } from './queryClassifier.js';

// Multi-word triggers are checked before the bare single-word "like"
// (longest-match-wins, same principle mangaRouting.js's lexicon already
// uses) so "in the style of X" isn't partially swallowed by a shorter,
// looser trigger. "like" is last and carries its own guard below -- it's
// by far the most common phrasing but also the most ambiguous: "I like
// romance" means "I enjoy romance", not "similar to [a title called]
// romance".
const TRIGGERS = [
  'reminds me of', 'reminiscent of', 'in the style of', 'in the vein of',
  'comparable to', 'similar to', 'akin to', 'such as', 'like'
];

// Boundary words/punctuation that end the reference phrase, whichever
// comes first. "but"/"except"/"however" matter most -- "but more
// emotional" is exactly the QA example's modifier clause, not part of
// the title.
const BOUNDARY_RE = /\s+(but|and|with|except|however|that|which|than|or)\b|,/;

// "I like X" / "I'd like X" / "would like X" all mean "I want X", not
// "similar to X" -- only the single-word "like" trigger needs this guard;
// the longer multi-word triggers above aren't ambiguous this way. Tested
// against the text immediately PRECEDING "like" (which does not itself
// contain the word "like"), so the pattern must not include it either.
const LIKE_VERB_GUARD_RE = /\b(i|i'd|i would|we|we'd|you|would|'d)\s*$/;

/**
 * Pulls the candidate reference phrase out of a raw query, e.g.
 * "like Frieren but more emotional" -> "frieren". Returns null if no
 * trigger phrase is found, or if the only trigger found is a "like" used
 * in its ordinary "I like X" verb sense.
 */
export function extractReferencePhrase(rawQuery) {
  const normalized = (rawQuery || '').toLowerCase();
  if (!normalized.trim()) return null;

  for (const trigger of TRIGGERS) {
    const idx = normalized.indexOf(trigger);
    if (idx === -1) continue;

    if (trigger === 'like') {
      const before = normalized.slice(0, idx);
      if (LIKE_VERB_GUARD_RE.test(before)) continue;
    }

    const rest = normalized.slice(idx + trigger.length);
    const boundaryMatch = rest.match(BOUNDARY_RE);
    const phrase = (boundaryMatch ? rest.slice(0, boundaryMatch.index) : rest).trim();
    if (phrase) return phrase;
  }

  return null;
}

// Fraction of the PHRASE's significant tokens present in the TITLE's
// token set. 1.0 means every significant word in the extracted phrase
// appears somewhere in the title -- e.g. phrase tokens ["frieren"]
// against "Frieren: Beyond Journey's End"'s tokens (which include
// "frieren") scores 1.0, even though the two full strings are wildly
// different lengths -- exactly the case similarity() floors to 0 on.
function overlapScore(phraseTokens, entryTokens) {
  if (phraseTokens.length === 0) return 0;
  const entrySet = new Set(entryTokens);
  const hits = phraseTokens.filter((t) => entrySet.has(t)).length;
  return hits / phraseTokens.length;
}

// How much of the extracted phrase has to land inside a candidate title
// before it's trusted as a real reference, not a coincidental word
// overlap. Deliberately strict (every significant token must hit) since,
// unlike the TITLE category's word-bag candidate list, there's no
// downstream re-ranking step to recover from a wrong pick here -- a false
// positive replaces the entire result set with that title's
// recommendations. Not yet tuned against a broad query sample, same
// caveat as queryClassifier.js's TITLE_SIMILARITY_THRESHOLD and
// domains.js's MOOD_GENRE_INCLUSION_THRESHOLD.
const MATCH_THRESHOLD = 0.8;

/**
 * Main entry point. Returns { title, matchedPhrase, score } for the
 * best-matching real title, or null if no trigger phrase was found, or
 * nothing in the TITLE vocab clears MATCH_THRESHOLD.
 *
 * Deliberately requires a warmed TITLE vocab rather than trusting the
 * regex extraction alone -- "like a slow burn romance" extracts the
 * phrase "a slow burn romance" just fine, but nothing in the real title
 * catalog should match it at 0.8+, so it correctly falls through to null
 * instead of misfiring on ordinary descriptive language.
 */
export async function detectReferenceTitle(supabase, rawQuery) {
  const phrase = extractReferencePhrase(rawQuery);
  if (!phrase) return null;

  const phraseTokens = significantTokens(phrase);
  if (phraseTokens.length === 0) return null;
  if (!supabase) return null;

  const titleEntries = await getTitleVocabEntries(supabase);
  if (!titleEntries || titleEntries.length === 0) return null;

  let best = null;
  for (const entry of titleEntries) {
    const score = overlapScore(phraseTokens, entry.tokens);
    if (score < MATCH_THRESHOLD) continue;
    // Tie-break toward the SHORTER matching title on an equal score --
    // e.g. phrase "frieren" scores 1.0 against both "Frieren" and
    // "Frieren: Beyond Journey's End" alike; the shorter, more literal
    // name is the more likely intended reference for a short mention.
    if (!best || score > best.score || (score === best.score && entry.tokens.length < best.entryTokenCount)) {
      best = { title: entry.name, score, entryTokenCount: entry.tokens.length };
    }
  }

  if (!best) return null;
  return { title: best.title, matchedPhrase: phrase, score: best.score };
}
