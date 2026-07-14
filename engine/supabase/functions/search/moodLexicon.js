import { getAfinnScore } from './dictionary/afinn.js';
import { STOPWORDS } from './normalize.js';

const MAX_PHRASE_WORDS = 4;

function scoreToTone(score) {
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

function buildEmotionsFromAfinn(score) {
  const tone = scoreToTone(score);
  if (tone === 'neutral') return {};
  const intensity = Math.min(Math.abs(score) * 2, 10);
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

      const phrase = cleanTokens.slice(start, start + n).join(' ');
      if (lexiconMap.has(phrase)) {
        matches.push({ term: phrase, emotions: lexiconMap.get(phrase), source: 'custom_lexicon' });
        for (let i = start; i < start + n; i++) claimed[i] = true;
      }
    }
  }

  for (let i = 0; i < cleanTokens.length; i++) {
    if (claimed[i]) continue;
    const word = cleanTokens[i];
    if (STOPWORDS.has(word)) continue;

    const afinnScore = getAfinnScore(word);
    if (afinnScore !== null) {
      matches.push({ term: word, emotions: buildEmotionsFromAfinn(afinnScore), source: 'afinn' });
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
    return { emotions: buildEmotionsFromAfinn(afinnScore), source: 'afinn' };
  }

  return { emotions: {}, source: null };
}
