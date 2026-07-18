import { getAfinnScore } from './dictionary/afinn.js';
import { getEmotionWordOverride } from './emotionWords.js';
import { STOPWORDS } from './normalize.js';

const MAX_PHRASE_WORDS = 4;

// Entry 34 fix. Before this, a query like "I don't want anything sad" scored
// "sad" directly (AFINN -2 -> sadness emotion, intensity 4) with no
// awareness that "don't want" negates it -- actively boosting drama/
// psychological, the exact opposite of the request. There was no negation
// concept at all: "not"/"don't"/etc were simply inert tokens (not scored,
// not stopwords, not doing anything).
//
// Fix direction chosen (per the "simpler and safer to ship first" option
// from the Backend Update List writeup): suppress -- zero out -- the
// sentiment contribution of words following a negation trigger, rather than
// trying to invert emotion-word-map categories (inversion is semantically
// murkier -- "not happy" isn't cleanly "sad").
//
// NEGATION_SCOPE_TOKENS is a raw token-count window (not a content-word
// count) so it can reach past short filler/stopwords sitting between the
// trigger and the actual emotion word -- e.g. "don't want anything sad"
// needs to reach 3 tokens past "don't" to suppress "sad". Not yet tuned
// against a broad query sample; same caveat as MOOD_GENRE_INCLUSION_THRESHOLD
// and TITLE_SIMILARITY_THRESHOLD elsewhere in this pass.
const NEGATION_SCOPE_TOKENS = 3;

const NEGATION_TRIGGERS = new Set([
  'not', 'no', 'never', 'without',
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "won't", "wouldn't", "couldn't", "shouldn't", "can't", 'cannot',
  "haven't", "hasn't", "hadn't"
]);

function isNegationTrigger(token) {
  return NEGATION_TRIGGERS.has(token) || token.endsWith("n't");
}

// Marks, for each token index, whether it falls within NEGATION_SCOPE_TOKENS
// tokens after a negation trigger. The trigger word itself is never marked
// (its own AFINN score, if any -- e.g. "no" is -1 in AFINN -- is left as
// pre-existing behavior, not part of this fix).
function computeNegationMask(tokens) {
  const negated = new Array(tokens.length).fill(false);
  for (let i = 0; i < tokens.length; i++) {
    if (!isNegationTrigger(tokens[i])) continue;
    for (let j = i + 1; j <= i + NEGATION_SCOPE_TOKENS && j < tokens.length; j++) {
      negated[j] = true;
    }
  }
  return negated;
}

function scoreToTone(score) {
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

function buildEmotionsFromAfinn(score, word) {
  const tone = scoreToTone(score);
  if (tone === 'neutral') return {};
  const intensity = Math.min(Math.abs(score) * 2, 10);

  const override = getEmotionWordOverride(word);
  if (override) return { [override]: intensity };

  return { [tone]: intensity };
}

function buildCandidatePhrases(tokens) {
  const candidates = new Set();
  for (let n = Math.min(MAX_PHRASE_WORDS, tokens.length); n >= 1; n--) {
    for (let start = 0; start + n <= tokens.length; start++) {
      candidates.add(tokens.slice(start, start + n).join(' '));
    }
  }
  return [...candidates];
}

export async function analyzeQueryMood(supabase, tokens) {
  const cleanTokens = (tokens || []).filter(Boolean);
  if (cleanTokens.length === 0) return { perToken: [], aggregate: {} };

  // Entry 34: compute once, up front, and consult it in both the custom-
  // lexicon phrase pass and the AFINN fallback pass below.
  const negated = computeNegationMask(cleanTokens);

  const candidatePhrases = buildCandidatePhrases(cleanTokens);
  const lexiconMap = new Map();

  try {
    const { data, error } = await supabase
      .from('manga_emotion_lexicon')
      .select('normalized_term, emotions')
      .in('normalized_term', candidatePhrases);

    if (error) {
      console.error('[moodLexicon] custom lexicon batch read error', error);
    } else {
      for (const row of data || []) {
        if (row.emotions && Object.keys(row.emotions).length > 0) {
          lexiconMap.set(row.normalized_term, row.emotions);
        }
      }
    }
  } catch (err) {
    console.error('[moodLexicon] custom lexicon batch read threw', err);
  }

  const claimed = new Array(cleanTokens.length).fill(false);
  const matches = [];
  // Entry 39: negated hits are no longer discarded -- they're routed here
  // instead of into `matches`, so domains.js can turn "what emotion was
  // negated" into an exclude-genres signal rather than throwing the
  // information away. See moodLexicon.js's header-level notes on Entry 34
  // for why this stays a suppression, not an inversion (buildEmotionsFromAfinn
  // still reports what the word WOULD have meant un-negated -- domains.js
  // decides what to do with that, this module just stops hiding it).
  const negatedMatches = [];

  for (let n = Math.min(MAX_PHRASE_WORDS, cleanTokens.length); n >= 1; n--) {
    for (let start = 0; start + n <= cleanTokens.length; start++) {
      let overlaps = false;
      for (let i = start; i < start + n; i++) {
        if (claimed[i]) { overlaps = true; break; }
      }
      if (overlaps) continue;

      const phrase = cleanTokens.slice(start, start + n).join(' ');
      if (!lexiconMap.has(phrase)) continue;

      let anyNegated = false;
      for (let i = start; i < start + n; i++) {
        if (negated[i]) { anyNegated = true; break; }
      }

      const emotions = lexiconMap.get(phrase);
      const entry = { term: phrase, emotions, source: 'custom_lexicon' };
      if (anyNegated) {
        negatedMatches.push(entry);
      } else {
        matches.push(entry);
      }
      for (let i = start; i < start + n; i++) claimed[i] = true;
    }
  }

  for (let i = 0; i < cleanTokens.length; i++) {
    if (claimed[i]) continue;
    const word = cleanTokens[i];
    if (STOPWORDS.has(word)) continue;

    const afinnScore = getAfinnScore(word);
    if (afinnScore === null) continue;

    const emotions = buildEmotionsFromAfinn(afinnScore, word);
    const entry = { term: word, emotions, source: 'afinn' };
    if (negated[i]) {
      negatedMatches.push(entry);
    } else {
      matches.push(entry);
    }
  }

  const aggregate = {};
  for (const m of matches) {
    for (const [emotion, intensity] of Object.entries(m.emotions)) {
      aggregate[emotion] = (aggregate[emotion] || 0) + intensity;
    }
  }

  // Entry 39: parallel aggregate for negated hits, same shape as `aggregate`,
  // so getRoutingForMood() can be reused as-is against it in domains.js.
  const negatedAggregate = {};
  for (const m of negatedMatches) {
    for (const [emotion, intensity] of Object.entries(m.emotions)) {
      negatedAggregate[emotion] = (negatedAggregate[emotion] || 0) + intensity;
    }
  }

  return { perToken: matches, aggregate, negatedAggregate, negatedTerms: negatedMatches };
}

export async function getEmotionsForTerm(supabase, term) {
  const normalized = (term || '').trim().toLowerCase();
  if (!normalized) return { emotions: {}, source: null };

  const { data, error } = await supabase
    .from('manga_emotion_lexicon')
    .select('emotions')
    .eq('normalized_term', normalized)
    .maybeSingle();

  if (error) {
    console.error('[moodLexicon] single-term read error', error);
  } else if (data && data.emotions && Object.keys(data.emotions).length > 0) {
    return { emotions: data.emotions, source: 'custom_lexicon' };
  }

  const afinnScore = getAfinnScore(normalized);
  if (afinnScore !== null) {
    return { emotions: buildEmotionsFromAfinn(afinnScore, normalized), source: 'afinn' };
  }

  return { emotions: {}, source: null };
}
