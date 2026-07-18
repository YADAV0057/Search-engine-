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

  for (let n = Math.min(MAX_PHRASE_WORDS, cleanTokens.length); n >= 1; n--) {
    for (let start = 0; start + n <= cleanTokens.length; start++) {
      let overlaps = false;
      for (let i = start; i < start + n; i++) {
        if (claimed[i]) { overlaps = true; break; }
      }
      if (overlaps) continue;

      // Entry 34: a phrase that falls (even partially) inside a negation
      // scope is skipped entirely -- suppressed, not matched -- rather than
      // contributing its emotions as if the negation weren't there.
      let anyNegated = false;
      for (let i = start; i < start + n; i++) {
        if (negated[i]) { anyNegated = true; break; }
      }
      if (anyNegated) continue;

      const phrase = cleanTokens.slice(start, start + n).join(' ');
      if (lexiconMap.has(phrase)) {
        matches.push({ term: phrase, emotions: lexiconMap.get(phrase), source: 'custom_lexicon' });
        for (let i = start; i < start + n; i++) claimed[i] = true;
      }
    }
  }

  for (let i = 0; i < cleanTokens.length; i++) {
    if (claimed[i]) continue;
    if (negated[i]) continue; // Entry 34: suppress negated single-word AFINN hits too
    const word = cleanTokens[i];
    if (STOPWORDS.has(word)) continue;

    const afinnScore = getAfinnScore(word);
    if (afinnScore !== null) {
      matches.push({ term: word, emotions: buildEmotionsFromAfinn(afinnScore, word), source: 'afinn' });
    }
  }

  const aggregate = {};
  for (const m of matches) {
    for (const [emotion, intensity] of Object.entries(m.emotions)) {
      aggregate[emotion] = (aggregate[emotion] || 0) + intensity;
    }
  }

  return { perToken: matches, aggregate };
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
