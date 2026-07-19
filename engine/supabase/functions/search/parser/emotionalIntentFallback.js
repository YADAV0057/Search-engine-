// parser/emotionalIntentFallback.js
//
// Entry 49 gap #5 fix (Notion "Backend Update List"): a query like "I just
// want someone to stay" was falling through with NO mood signal at all --
// not misrouted, just invisible to the mood pipeline entirely. "stay" isn't
// emotionally charged in AFINN, "want" is filtered as a stopword, and
// nothing in manga_emotion_lexicon covers this exact phrase. The result:
// analyzeQueryMood() returns empty aggregate AND empty negatedAggregate,
// domains.js's computeMoodSignal() treats that as "no mood signal", and the
// query falls all the way through to a literal free-text search -- the
// same Entry 31/32 failure pattern, just reached via a different route
// (empty lexicon coverage instead of a negation edge case).
//
// This module is the fallback tier for that empty-result case: a Groq call
// (with a Cerebras backup, see below) that classifies the emotional intent
// of a query directly into one of MANGA_ROUTING's keys when the lexicon
// has nothing to offer. It deliberately mirrors acclaimScoring.js's
// two-tier structure -- cheap lexicon/AFINN tier first (that's
// analyzeQueryMood() itself, unchanged), semantic model tier only when
// that comes back empty -- just applied to general emotional classification
// instead of the narrower acclaim-intent signal.
//
// Gating: only fires when analyzeQueryMood() found literally nothing
// (both aggregate and negatedAggregate empty) AND the query has at least
// two non-stopword tokens. That second check is a free, local filter for
// single-word genre/title searches ("vagabond", "horror") before paying
// for a model call at all. For queries that pass the token-count gate but
// are STILL just a genre or title search ("romance manga"), the filtering
// happens inside the Groq/Cerebras prompt itself, which is instructed to
// reply "none" for anything without real emotional content of its own --
// same tradeoff acclaimScoring.js made (accept the extra call for cases
// that resolve to "none" anyway, rather than threading query-classification
// data into this module and creating a dependency on computeQueryClassification()
// running first).
//
// Unlike acclaimScoring.js's 0-10 confidence score, this returns a
// category (one of 27 keys, or none) with no graininess to gate a
// write-back threshold against -- so any confident non-"none" answer gets
// written back to manga_emotion_lexicon as-is. A wrong category written
// once is a much smaller failure mode here than a wrong acclaim score,
// since it just mis-routes genre boosting for that one phrase rather than
// corrupting a ranking signal blended across every result.
//
// ADDED 2026-07-19: Cerebras as a second, backup provider. Only ever
// consulted when Groq itself couldn't be reached or didn't answer --
// timeout, HTTP error, missing key, or an unparseable reply -- NEVER when
// Groq successfully classified the query as "none". This is pure
// redundancy against one vendor being slow or down, not a second opinion:
// letting Cerebras override a confident Groq "none" would just add a
// second point of failure without adding any accuracy. Same model tier
// (small/fast, single-token classification, not generation) and identical
// prompt, so behavior is indistinguishable to the caller regardless of
// which one actually answered -- fails closed to null exactly like
// acclaimScoring.js if BOTH are unavailable or both fail.
import { STOPWORDS, normalize } from './normalize.js';
import { MANGA_ROUTING } from './mangaRouting.js';

const ROUTING_KEYS = Object.keys(MANGA_ROUTING);

const MIN_MEANINGFUL_TOKENS = 2; // fewer than this and there's no query left
                                  // to reason about beyond a bare genre/title
                                  // word -- skip the model call entirely
const PROVIDER_TIMEOUT_MS = 3000; // same budget as acclaimScoring.js's
                                   // GROQ_TIMEOUT_MS; this must never be
                                   // able to meaningfully slow a search
const FALLBACK_INTENSITY = 5; // moderate weight on the lexicon's ~0-10
                               // scale (seeded rows run 6-7 for strong
                               // signals, e.g. acclaimScoring.js's
                               // "critically acclaimed" -> 7) -- comfortably
                               // above MOOD_GENRE_INCLUSION_THRESHOLD /
                               // CONJUNCTIVE_WEIGHT_THRESHOLD (both 2 in
                               // domains.js/mangaRouting.js) so it actually
                               // drives boosting, without claiming a
                               // confidence this classification doesn't have

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'llama3.1-8b'; // Cerebras's equivalent small/fast
                                       // tier, OpenAI-compatible endpoint --
                                       // same shape request works unchanged

function hasMeaningfulContent(tokens) {
  const meaningful = (tokens || []).filter((t) => t && !STOPWORDS.has(t));
  return meaningful.length >= MIN_MEANINGFUL_TOKENS;
}

function buildMessages(query) {
  return [
    {
      role: 'system',
      content:
        'You classify the emotional/mood intent of a manga search query ' +
        'into exactly ONE of these keys: ' + ROUTING_KEYS.join(', ') + '. ' +
        'Reply with ONLY that single key, lowercase, no punctuation, ' +
        'nothing else. Reply "none" if the query is just a genre name, a ' +
        'title, an author, or otherwise has no real emotional/mood content ' +
        'of its own. Examples: "I just want someone to stay" -> comfort. ' +
        '"I need to feel something again" -> awe. "romance manga" -> none. ' +
        '"vagabond" -> none. "something to make me feel less alone" -> comfort.'
    },
    { role: 'user', content: query }
  ];
}

/**
 * Calls one provider (Groq or Cerebras -- same OpenAI-compatible shape for
 * both) and returns a discriminated result so the caller can tell "the
 * provider is unreachable/broken" (ok: false, try the backup) apart from
 * "the provider confidently said this isn't an emotional query" (ok: true,
 * key: null -- do NOT fall through to the backup for this case).
 */
async function callProvider({ url, model, apiKey, query, label }) {
  if (!apiKey || !query) return { ok: false, key: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 10,
        messages: buildMessages(query)
      })
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[emotionalIntentFallback] ${label} returned HTTP ${response.status}`);
      return { ok: false, key: null };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '');

    if (!raw) return { ok: false, key: null };
    if (raw === 'none') return { ok: true, key: null };
    if (!ROUTING_KEYS.includes(raw)) {
      // Model replied with something that's neither a valid routing key
      // nor "none" -- treat as a failure (not a confident "none") so the
      // backup provider still gets a chance, same as a timeout would.
      console.error(`[emotionalIntentFallback] ${label} returned unrecognized key: "${raw}"`);
      return { ok: false, key: null };
    }
    return { ok: true, key: raw };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[emotionalIntentFallback] ${label} call failed`, err);
    return { ok: false, key: null };
  }
}

/**
 * Tries Groq first, Cerebras only as a backup for an unreachable/broken
 * Groq call -- see the ADDED 2026-07-19 header note above for why this is
 * redundancy, not a second opinion. Returns { emotionKey, provider } where
 * emotionKey is null (query isn't emotional, or both providers failed) or
 * one of ROUTING_KEYS; provider is 'groq' | 'cerebras' | null.
 */
async function classifyEmotionalIntent(query, groqApiKey, cerebrasApiKey) {
  const groqResult = await callProvider({
    url: GROQ_URL, model: GROQ_MODEL, apiKey: groqApiKey, query, label: 'groq'
  });
  if (groqResult.ok) return { emotionKey: groqResult.key, provider: 'groq' };

  const cerebrasResult = await callProvider({
    url: CEREBRAS_URL, model: CEREBRAS_MODEL, apiKey: cerebrasApiKey, query, label: 'cerebras'
  });
  if (cerebrasResult.ok) return { emotionKey: cerebrasResult.key, provider: 'cerebras' };

  return { emotionKey: null, provider: null };
}

/**
 * Fires the write-back promise without making the caller wait on it.
 * Identical pattern to acclaimScoring.js's scheduleWriteBack() -- kept as
 * a separate copy rather than imported/shared, same dependency-free
 * reasoning mangaRouting.js used for CONJUNCTIVE_WEIGHT_THRESHOLD.
 */
function scheduleWriteBack(promise) {
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(promise);
  } else {
    promise.catch((err) => {
      console.error('[emotionalIntentFallback] lexicon writeback failed (no EdgeRuntime)', err);
    });
  }
}

/**
 * Upserts a classified emotion into manga_emotion_lexicon so future exact-
 * phrase matches hit the free lexicon/AFINN tier directly and never need
 * this fallback again. Merges into any existing emotions row rather than
 * overwriting it. Swallows every error -- best-effort cache warming that
 * runs after the response is already sent, same as acclaimScoring.js's
 * writeBackToLexicon().
 */
async function writeBackToLexicon(supabase, query, emotionKey, provider) {
  if (!supabase || !query || !emotionKey) return;

  const term = normalize(query).trim();
  if (!term) return;

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('manga_emotion_lexicon')
      .select('emotions')
      .eq('normalized_term', term)
      .maybeSingle();

    if (fetchErr) {
      console.error('[emotionalIntentFallback] lexicon writeback lookup failed', fetchErr);
      return;
    }

    const emotions = { ...(existing?.emotions || {}), [emotionKey]: FALLBACK_INTENSITY };

    const { error: upsertErr } = await supabase
      .from('manga_emotion_lexicon')
      .upsert(
        { normalized_term: term, emotions, source: `emotional_intent_writeback:${provider}` },
        { onConflict: 'normalized_term' }
      );

    if (upsertErr) {
      console.error('[emotionalIntentFallback] lexicon writeback upsert failed', upsertErr);
    }
  } catch (err) {
    console.error('[emotionalIntentFallback] lexicon writeback threw', err);
  }
}

/**
 * Main entry point. Called by domains.js's computeMoodSignal() only when
 * analyzeQueryMood() found nothing at all (both aggregate and
 * negatedAggregate empty).
 *
 * rawQuery: the original query string -- sent to the model(s) and used as
 *   the lexicon write-back key.
 * tokens: normalizeAndTokenize(rawQuery) -- already computed by the caller,
 *   reused here for the meaningful-content gate rather than re-tokenizing.
 * groqApiKey / cerebrasApiKey: Deno.env.get(...) values -- either or both
 *   may be absent; this degrades to returning null rather than throwing.
 * supabase: used only for the write-back; optional, write-back is silently
 *   skipped when absent (this request's classification result is still
 *   returned either way).
 *
 * Returns null (nothing to add -- caller falls through to its existing
 * null-mood behavior) or an object shaped exactly like
 * domains.js's computeMoodSignal() normally returns:
 *   { aggregate, negatedAggregate, matchedTerms }
 * so every downstream consumer (getRoutingForMood, detectConjunctiveClusters,
 * rankResults.js, the aiPanel.js reasoning trail) works completely
 * unchanged, whether the mood signal came from the lexicon or from here.
 */
export async function getEmotionalIntentFallback(rawQuery, tokens, groqApiKey, cerebrasApiKey, supabase) {
  if (!hasMeaningfulContent(tokens)) return null;

  const { emotionKey, provider } = await classifyEmotionalIntent(rawQuery, groqApiKey, cerebrasApiKey);
  if (!emotionKey) return null;

  scheduleWriteBack(writeBackToLexicon(supabase, rawQuery, emotionKey, provider));

  const aggregate = { [emotionKey]: FALLBACK_INTENSITY };
  const term = normalize(rawQuery).trim();

  return {
    aggregate,
    negatedAggregate: {},
    matchedTerms: [{ term, emotions: aggregate, source: `emotional_intent_fallback:${provider}` }],
  };
}
