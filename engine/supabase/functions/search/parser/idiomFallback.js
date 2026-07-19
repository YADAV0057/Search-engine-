// parser/idiomFallback.js
//
// Entry 61 implementation (Notion "Backend Update List"), scoped in Entry 59.
// Generalizes acclaimScoring.js/emotionalIntentFallback.js's Groq write-back
// pattern to the idiom/trope phrase dictionary Entry 58 seeded by hand
// (slow burn, enemies to lovers, morally gray, etc.) -- this module is what
// keeps that dictionary growing without anyone typing SQL inserts.
//
// WHY THIS IS A DIFFERENT SHAPE FROM emotionalIntentFallback.js, ON PURPOSE:
// That module classifies an entire query (whatever's left after the lexicon
// found nothing) into one MANGA_ROUTING key, and writes back the FULL
// sentence as normalized_term -- reachable again only by an exact repeat of
// that sentence. An idiom is a compact, reusable phrase ("slow burn") that
// shows up inside many differently-worded queries ("I want a slow burn
// romance", "looking for a slow burn story", "slow burn please"). Writing
// back the whole sentence would miss that reuse entirely -- every one of
// those three queries would re-pay for Groq forever. So this module works
// at the SPAN level, not the query level: it finds the specific 2-4 word
// run inside the query that got no coverage at all, classifies just that
// span, and writes back just that span -- exactly like Entry 58's manual
// "slow burn" row, so future matches (any query containing that phrase) hit
// the free lexicon tier via moodLexicon.js's existing buildCandidatePhrases()
// matching, unchanged.
//
// GATING, AND WHY IT'S STRICTER THAN acclaimScoring.js's 0.5:
// acclaimScoring.js's write-back only ever fills in a score for a term the
// system already expected to see there (a phrase that scored acclaim-
// adjacent). A wrong guess is a mis-weighted existing concept. This module
// creates BRAND NEW rows for arbitrary word spans the query happened to
// leave uncovered -- a false positive (the model reading two ordinary
// unrelated words as a "trope") doesn't just mis-score one concept, it
// permanently plants a fake concept that will silently bias every future
// query containing that word pair. Repo owner decision (2026-07-19): ship
// straight to manga_emotion_lexicon (no staging table), gated on a
// materially higher bar than acclaimScoring.js's 0.5 -- see
// WRITEBACK_THRESHOLD below -- rather than adding new schema/infra.
//
// Runs ADDITIVELY, unlike emotionalIntentFallback.js's whole-query-empty
// gate: a query can have real AFINN/lexicon signal from other words AND
// still contain an idiom span (e.g. "sad slow burn romance" -- "sad" scores
// normally, "slow burn" needed this fallback before Entry 58's manual seed
// existed). domains.js calls this after analyzeQueryMood() regardless of
// whether that call found anything, and merges the result into the same
// aggregate rather than only using it as a last resort.
import { STOPWORDS, normalize } from './normalize.js';
import { MANGA_ROUTING } from './mangaRouting.js';

const ROUTING_KEYS = Object.keys(MANGA_ROUTING);

const MIN_SPAN_WORDS = 2;   // a single uncovered word is just "no AFINN
                             // entry for this word" -- not idiom territory.
                             // Idioms are inherently multi-word.
const MAX_SPAN_WORDS = 4;   // matches moodLexicon.js's own MAX_PHRASE_WORDS
                             // so anything written back is reachable by the
                             // exact same phrase-matching loop that already
                             // finds "slow burn"/"found family".
const MAX_SPANS_PER_QUERY = 2; // cap Groq calls per request even if a query
                                // has several uncovered runs -- longest
                                // spans first (more likely to be a genuine
                                // multi-word idiom than two short leftover
                                // words that just didn't happen to be in
                                // AFINN).

// Stricter than acclaimScoring.js's WRITEBACK_THRESHOLD (0.5) by design --
// see header. 0.75 = the model has to be confident (>=8/10 on its own
// 0-10 scale, rounded) this is a real, recognizable trope/pacing term, not
// a plausible-sounding guess.
const WRITEBACK_THRESHOLD = 0.75;

const PROVIDER_TIMEOUT_MS = 3000; // same budget as every other LLM tier in
                                   // this pipeline (acclaimScoring.js,
                                   // emotionalIntentFallback.js)

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'llama3.1-8b';

/**
 * Finds contiguous runs of tokens that got NO coverage at all from
 * analyzeQueryMood() (not claimed by a lexicon phrase match, not scored by
 * AFINN) and are not sitting inside a negation trigger's scope -- a
 * negated span ("no slow burn please") must never be written back with a
 * positive weight, so it's simplest and safest to just skip those runs
 * entirely for now rather than try to invert/suppress them here too.
 * Stopword-only runs are dropped (nothing idiom-like about "for the").
 * Longest runs first, each capped to MAX_SPAN_WORDS (split if longer),
 * so a big uncovered stretch doesn't get lost -- though in practice most
 * uncovered runs in a real query are 2-3 words.
 */
function extractCandidateSpans(cleanTokens, claimed, negated) {
  const spans = [];
  let runStart = null;

  const flushRun = (end) => {
    if (runStart === null) return;
    const runTokens = cleanTokens.slice(runStart, end);
    const meaningful = runTokens.filter((t) => !STOPWORDS.has(t));
    if (meaningful.length >= MIN_SPAN_WORDS) {
      for (let start = runStart; start < end; start += MAX_SPAN_WORDS) {
        const chunk = cleanTokens.slice(start, Math.min(start + MAX_SPAN_WORDS, end));
        if (chunk.length >= MIN_SPAN_WORDS) spans.push(chunk.join(' '));
      }
    }
    runStart = null;
  };

  for (let i = 0; i < cleanTokens.length; i++) {
    const isCovered = claimed[i] || negated[i];
    if (isCovered) {
      flushRun(i);
    } else if (runStart === null) {
      runStart = i;
    }
  }
  flushRun(cleanTokens.length);

  // Longest-first: a 4-word uncovered run is more likely a genuine
  // multi-word idiom than a 2-word leftover pairing of ordinary words.
  return spans
    .sort((a, b) => b.split(' ').length - a.split(' ').length)
    .slice(0, MAX_SPANS_PER_QUERY);
}

function buildMessages(phrase) {
  return [
    {
      role: 'system',
      content:
        'You classify whether a short phrase from a manga search query is ' +
        'a RECOGNIZABLE STORY TROPE, PACING DESCRIPTOR, or NARRATIVE IDIOM ' +
        '-- the kind of term readers use to describe a story\'s structure ' +
        'or arc (examples: "slow burn", "found family", "enemies to ' +
        'lovers", "morally gray", "coming of age", "happy ending"). It is ' +
        'NOT a genre word, NOT a character/title name, and NOT an ordinary ' +
        'adjective pair that just happens to sit next to each other in a ' +
        'sentence. If it is NOT a real trope/idiom, reply with only the ' +
        'word none. If it IS one, reply in exactly this format: a ' +
        'confidence integer 0-10 (how sure you are this is a genuine, ' +
        'commonly-used term, not a guess), then a pipe "|", then 1-3 ' +
        'emotion:weight pairs comma-separated, using ONLY these emotion ' +
        'keys: ' + ROUTING_KEYS.join(', ') + ' -- weight is 1-10. No other ' +
        'text. Examples: "slow burn" -> 9|romance:6,elegance:4. "enemies ' +
        'to lovers" -> 9|romance:7,tension:4. "red umbrella" -> none. ' +
        '"very sad" -> none (that is a plain adjective, not a named ' +
        'trope). "morally gray" -> 9|identity:5,tension:3.'
    },
    { role: 'user', content: phrase }
  ];
}

/**
 * Parses "confidence|key:weight,key:weight" or "none". Drops any emotion
 * key outside ROUTING_KEYS (a model that ignores the constraint) rather
 * than failing the whole classification -- same tolerant-but-bounded
 * pattern as emotionalIntentFallback.js's parseClassification(). Returns
 * null (not a valid idiom classification) if nothing valid survives.
 */
function parseClassification(rawContent) {
  const trimmed = (rawContent || '').trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.replace(/[^a-z]/g, '') === 'none') return null;

  const pipeIndex = trimmed.indexOf('|');
  if (pipeIndex === -1) return null;

  const confidence = parseInt(trimmed.slice(0, pipeIndex).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(confidence)) return null;

  const emotions = {};
  trimmed.slice(pipeIndex + 1).split(',').forEach((pair) => {
    const [rawKey, rawWeight] = pair.split(':').map((s) => (s || '').trim());
    const key = (rawKey || '').replace(/[^a-z]/g, '');
    const weight = parseInt(rawWeight, 10);
    if (ROUTING_KEYS.includes(key) && Number.isFinite(weight) && weight > 0) {
      emotions[key] = Math.max(1, Math.min(10, weight));
    }
  });

  if (Object.keys(emotions).length === 0) return null;
  return { confidence: Math.max(0, Math.min(10, confidence)) / 10, emotions };
}

async function callProvider(url, model, apiKey, phrase) {
  if (!apiKey || !phrase) return { ok: false };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 30,
        messages: buildMessages(phrase),
      }),
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[idiomFallback] provider returned HTTP ${response.status}`);
      return { ok: false };
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const parsed = parseClassification(text);
    return { ok: true, parsed };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[idiomFallback] provider call failed', err);
    return { ok: false };
  }
}

/**
 * Groq first, Cerebras only as a backup when Groq is unreachable/errored --
 * identical redundancy pattern to emotionalIntentFallback.js. A confident
 * Groq "none" (ok: true, parsed: null) is final; Cerebras is never
 * consulted to second-guess it, only to cover Groq being down.
 */
async function classifyPhrase(phrase, groqApiKey, cerebrasApiKey) {
  const groqResult = await callProvider(GROQ_URL, GROQ_MODEL, groqApiKey, phrase);
  if (groqResult.ok) return { ...groqResult.parsed, provider: 'groq' };

  const cerebrasResult = await callProvider(CEREBRAS_URL, CEREBRAS_MODEL, cerebrasApiKey, phrase);
  if (cerebrasResult.ok) return cerebrasResult.parsed ? { ...cerebrasResult.parsed, provider: 'cerebras' } : null;

  return null;
}

function scheduleWriteBack(promise) {
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(promise);
  } else {
    promise.catch((err) => {
      console.error('[idiomFallback] lexicon writeback failed (no EdgeRuntime)', err);
    });
  }
}

/**
 * Upserts a confident classification as a brand-new entity_type='tag' row --
 * the exact same shape as Entry 58's manual seed rows, so it's reachable by
 * moodLexicon.js's existing phrase matching with zero further code changes.
 * Scoped to (normalized_term, entity_type) via onConflict, matching the
 * composite unique constraint added for the acclaimScoring.js/
 * emotionalIntentFallback.js contamination bug (see those files' Entry 60
 * fix) -- built correctly from the start here rather than retrofitted.
 */
async function writeBackToLexicon(supabase, phrase, emotions, provider) {
  if (!supabase || !phrase) return;
  const term = normalize(phrase).trim();
  if (!term) return;

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('manga_emotion_lexicon')
      .select('emotions')
      .eq('normalized_term', term)
      .eq('entity_type', 'tag')
      .maybeSingle();

    if (fetchErr) {
      console.error('[idiomFallback] lexicon writeback lookup failed', fetchErr);
      return;
    }

    // Don't clobber a term that already exists as a tag for another reason
    // (e.g. a real AniList genre/tag name harvested separately) -- merge,
    // same as every other write-back in this pipeline.
    const emotionsOut = { ...(existing?.emotions || {}), ...emotions };

    const { error: upsertErr } = await supabase
      .from('manga_emotion_lexicon')
      .upsert(
        {
          term: phrase.trim(),
          normalized_term: term,
          entity_type: 'tag',
          emotions: emotionsOut,
          source: `idiom_fallback_writeback:${provider}`,
        },
        { onConflict: 'normalized_term,entity_type' }
      );

    if (upsertErr) {
      console.error('[idiomFallback] lexicon writeback upsert failed', upsertErr);
    }
  } catch (err) {
    console.error('[idiomFallback] lexicon writeback threw', err);
  }
}

/**
 * Main entry point. Called by domains.js's computeMoodSignal() after
 * analyzeQueryMood(), REGARDLESS of whether that call found other signal --
 * this is additive, not a last-resort fallback (see header).
 *
 * cleanTokens/claimed/negated: the three fields Entry 61 added to
 * analyzeQueryMood()'s return value (see moodLexicon.js) -- reused here
 * rather than re-tokenizing or re-running negation detection.
 * groqApiKey/cerebrasApiKey/supabase: same as every other fallback module;
 * absence degrades to a no-op, never throws, never blocks the search.
 *
 * Returns null (nothing to add) or { aggregate, negatedAggregate: {},
 * matchedTerms } -- same shape as the other mood-signal sources, so
 * domains.js can merge it into the existing aggregate with a plain
 * per-key sum, the same way analyzeQueryMood()'s own matches are summed.
 */
export async function getIdiomFallback(cleanTokens, claimed, negated, groqApiKey, cerebrasApiKey, supabase) {
  if (!cleanTokens || cleanTokens.length === 0) return null;
  if (!groqApiKey && !cerebrasApiKey) return null;

  const spans = extractCandidateSpans(cleanTokens, claimed, negated);
  if (spans.length === 0) return null;

  const aggregate = {};
  const matchedTerms = [];

  for (const phrase of spans) {
    const result = await classifyPhrase(phrase, groqApiKey, cerebrasApiKey);
    if (!result || !result.confidence || !result.emotions) continue;

    // Any confident-enough non-"none" classification is trusted for THIS
    // request's ranking signal even below the write-back bar -- only
    // persisting it to the shared lexicon needs the stricter threshold.
    // A one-off low-confidence guess helping just this one search is a
    // much smaller risk than baking it in for every future query.
    for (const [key, weight] of Object.entries(result.emotions)) {
      aggregate[key] = (aggregate[key] || 0) + weight;
    }
    matchedTerms.push({ term: phrase, emotions: result.emotions, source: `idiom_fallback:${result.provider}` });

    if (result.confidence >= WRITEBACK_THRESHOLD) {
      scheduleWriteBack(writeBackToLexicon(supabase, phrase, result.emotions, result.provider));
    }
  }

  if (Object.keys(aggregate).length === 0) return null;
  return { aggregate, negatedAggregate: {}, matchedTerms };
}
