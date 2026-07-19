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
        'Reply "none" if the query is just a genre name, a title, an ' +
        'author, or otherwise has no real emotional/mood content of its ' +
        'own -- reply with just the word none, nothing else, in that case. ' +
        'Otherwise reply in exactly this format: the single best-fit key, ' +
        'lowercase, then a pipe character "|", then 2-4 short lowercase ' +
        'keywords or short phrases (comma-separated) that capture what ' +
        'this SPECIFIC query is about -- words and phrases that would ' +
        'plausibly appear in a manga synopsis about this exact theme, not ' +
        'generic emotion words. No other text, no explanation. ' +
        'Examples: "I just want someone to stay" -> ' +
        'comfort|staying, someone to rely on, not being abandoned. ' +
        '"I want a story about finding people who become family" -> ' +
        'comfort|found family, chosen family, belonging. ' +
        '"I need a story that heals loneliness" -> ' +
        'comfort|loneliness, connection, healing. ' +
        '"romance manga" -> none. "vagabond" -> none.'
    },
    { role: 'user', content: query }
  ];
}

/**
 * Parses a raw model reply into { key, keywords }. Format is
 * "emotionkey|kw1, kw2, kw3" or the literal "none". Deliberately tolerant
 * of a model that ignores the keyword half of the format and replies with
 * just a bare key (older prompt behavior, or a model that drifts) --
 * keywords degrades to an empty array in that case rather than failing the
 * whole classification, since the emotion key alone is still useful even
 * without keyword-level ranking signal.
 */
function parseClassification(rawContent) {
  const trimmed = (rawContent || '').trim().toLowerCase();
  if (!trimmed) return { key: null, keywords: [], valid: false };
  if (trimmed.replace(/[^a-z]/g, '') === 'none') return { key: null, keywords: [], valid: true };

  const pipeIndex = trimmed.indexOf('|');
  const keyPart = (pipeIndex === -1 ? trimmed : trimmed.slice(0, pipeIndex)).replace(/[^a-z]/g, '');
  if (!ROUTING_KEYS.includes(keyPart)) return { key: null, keywords: [], valid: false };

  const keywords = pipeIndex === -1
    ? []
    : trimmed.slice(pipeIndex + 1)
        .split(',')
        .map((k) => k.replace(/[^a-z ]/g, '').trim())
        .filter(Boolean)
        .slice(0, 4);

  return { key: keyPart, keywords, valid: true };
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
        max_tokens: 40, // was 10 -- the reply now includes 2-4 keywords
                        // alongside the emotion key, not just a bare key
        messages: buildMessages(query)
      })
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[emotionalIntentFallback] ${label} returned HTTP ${response.status}`);
      return { ok: false, key: null, keywords: [] };
    }

    const data = await response.json();
    const { key, keywords, valid } = parseClassification(data?.choices?.[0]?.message?.content);

    if (!valid) {
      // Neither a valid routing key nor a confident "none" -- treat as a
      // failure (same as a timeout) so the backup provider still gets a
      // chance, rather than silently accepting a malformed reply.
      console.error(`[emotionalIntentFallback] ${label} returned unparseable reply: "${data?.choices?.[0]?.message?.content}"`);
      return { ok: false, key: null, keywords: [] };
    }
    return { ok: true, key, keywords };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[emotionalIntentFallback] ${label} call failed`, err);
    return { ok: false, key: null, keywords: [] };
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
  if (groqResult.ok) return { emotionKey: groqResult.key, keywords: groqResult.keywords, provider: 'groq' };

  const cerebrasResult = await callProvider({
    url: CEREBRAS_URL, model: CEREBRAS_MODEL, apiKey: cerebrasApiKey, query, label: 'cerebras'
  });
  if (cerebrasResult.ok) return { emotionKey: cerebrasResult.key, keywords: cerebrasResult.keywords, provider: 'cerebras' };

  return { emotionKey: null, keywords: [], provider: null };
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
async function writeBackToLexicon(supabase, query, emotionKey, keywords, provider) {
  if (!supabase || !query || !emotionKey) return;

  const term = normalize(query).trim();
  if (!term) return;

  try {
    // Entry 60 fix (Notion "Backend Update List"): scoped by entity_type,
    // where it previously wasn't. manga_emotion_lexicon's `normalized_term`
    // is a table-wide unique/onConflict key shared with acclaimScoring.js's
    // OWN writeBackToLexicon() (entity_type='acclaim_phrase', a completely
    // separate classification feature) -- an unscoped fetch here would pull
    // in and merge whatever acclaimScoring wrote for the same query text
    // (e.g. {acclaim: 9}) into what should be a pure comfort/mood
    // classification, corrupting `emotions` with a key that isn't even a
    // valid MANGA_ROUTING entry. getWrittenBackClassification() below then
    // has no way to tell the difference on a later cache hit -- it just
    // trusts Object.keys(emotions)[0], and whichever feature happened to
    // write first wins, silently. Repro: "I want to believe people can
    // stay" -> emotions ended up {acclaim: 9, comfort: 5}, acclaim: 9
    // written first by acclaimScoring.js, so the cache hit routed as
    // "acclaim" (zero MANGA_ROUTING genre boost) instead of "comfort".
    const { data: existing, error: fetchErr } = await supabase
      .from('manga_emotion_lexicon')
      .select('emotions, keywords')
      .eq('normalized_term', term)
      .eq('entity_type', 'mood_word')
      .maybeSingle();

    if (fetchErr) {
      console.error('[emotionalIntentFallback] lexicon writeback lookup failed', fetchErr);
      return;
    }

    const emotions = { ...(existing?.emotions || {}), [emotionKey]: FALLBACK_INTENSITY };

    // Entry 58 fix: merge (dedupe) rather than overwrite -- if a later
    // classification of the exact same phrase returns slightly different
    // keyword phrasing, keep the union instead of discarding whichever set
    // landed first. Falls back to [] for rows written before this column
    // existed (Postgres returns [] as the column default, but guard anyway
    // in case `existing.keywords` is null for any other reason).
    const existingKeywords = Array.isArray(existing?.keywords) ? existing.keywords : [];
    const mergedKeywords = [...new Set([...existingKeywords, ...(keywords || [])])];

    const { error: upsertErr } = await supabase
      .from('manga_emotion_lexicon')
      .upsert(
        {
          term,
          normalized_term: term,
          entity_type: 'mood_word',
          emotions,
          keywords: mergedKeywords,
          source: `emotional_intent_writeback:${provider}`,
        },
        // Entry 60 fix: was onConflict:'normalized_term' -- the table-wide
        // uniqueness that let this collide with acclaimScoring.js's
        // entity_type='acclaim_phrase' rows for the same query text. See
        // this file's writeBackToLexicon() header and the migration that
        // added the composite unique constraint this now targets.
        { onConflict: 'normalized_term,entity_type' }
      );

    if (upsertErr) {
      console.error('[emotionalIntentFallback] lexicon writeback upsert failed', upsertErr);
    }
  } catch (err) {
    console.error('[emotionalIntentFallback] lexicon writeback threw', err);
  }
}

/**
 * Entry 58 fix: an exact-phrase check against manga_emotion_lexicon for a
 * row this module itself wrote back previously. This is deliberately
 * separate from -- and runs before -- analyzeQueryMood()'s own lexicon
 * read (moodLexicon.js), because that function only matches candidate
 * phrases up to MAX_PHRASE_WORDS (4) tokens. A full-sentence row written
 * by writeBackToLexicon() below is normalized_term = the entire raw query,
 * which for any query longer than 4 words -- the common case for anything
 * that reaches this fallback at all -- can never appear in
 * analyzeQueryMood()'s candidate-phrase list. Without this check, the
 * write-back closed the *schema* gap (keywords now persist) but not the
 * *reachability* gap: a repeat of the exact same sentence would still
 * silently re-call analyzeQueryMood() (empty), then re-pay for Groq/
 * Cerebras every single time, exactly as before Entry 56/57 -- the
 * write-back's entire purpose (Entry 47: "Groq call volume should trend
 * toward zero over time") would still not hold for this fallback's own
 * rows specifically.
 *
 * Scoped with entity_type + source LIKE guards so this only ever matches a
 * row this exact function tree wrote, never an unrelated custom_lexicon
 * phrase entry that happens to share a normalized_term.
 */
async function getWrittenBackClassification(supabase, term) {
  if (!supabase || !term) return null;

  try {
    const { data, error } = await supabase
      .from('manga_emotion_lexicon')
      .select('emotions, keywords')
      .eq('normalized_term', term)
      .eq('entity_type', 'mood_word')
      .like('source', 'emotional_intent_writeback%')
      .maybeSingle();

    if (error) {
      console.error('[emotionalIntentFallback] cached classification lookup failed', error);
      return null;
    }
    if (!data || !data.emotions) return null;

    // Entry 60 defense-in-depth: the write-path fix (entity_type scoping +
    // composite unique constraint, see writeBackToLexicon() above) stops
    // new contamination, but doesn't retroactively repair it -- filter to
    // keys this module could actually have written (valid ROUTING_KEYS
    // entries) rather than trusting insertion order on whatever's in the
    // row. A row with no valid key left (fully displaced by a stale
    // contamination) falls through to null -- caller re-classifies fresh
    // via Groq/Cerebras rather than silently acting on an untrustworthy
    // cached key, same fail-safe default as every other error path here.
    const emotionKeys = Object.keys(data.emotions).filter((k) => ROUTING_KEYS.includes(k));
    if (emotionKeys.length === 0) return null;

    // This module's writeBackToLexicon() only ever sets one key per call,
    // but merges into whatever was already there (see above) -- take the
    // first key rather than assuming a specific one if a row somehow ends
    // up holding more than one (e.g. hand-edited, or written by another
    // feature sharing this table).
    const emotionKey = emotionKeys[0];
    const keywords = Array.isArray(data.keywords) ? data.keywords : [];
    return { emotionKey, keywords };
  } catch (err) {
    console.error('[emotionalIntentFallback] cached classification lookup threw', err);
    return null;
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

  const term = normalize(rawQuery).trim();

  // Entry 58: exact-phrase cache check, ahead of the LLM call. See
  // getWrittenBackClassification()'s own comment for why this can't just
  // rely on analyzeQueryMood() having already found (and ruled out) a
  // match -- that function's phrase matching structurally cannot reach a
  // full-sentence write-back row for any query over 4 words.
  const cached = await getWrittenBackClassification(supabase, term);
  if (cached) {
    const aggregate = { [cached.emotionKey]: FALLBACK_INTENSITY };
    const matchedTerms = cached.keywords.length > 0
      ? cached.keywords.map((kw) => ({ term: kw, emotions: aggregate, source: 'emotional_intent_writeback:cache' }))
      : [{ term, emotions: aggregate, source: 'emotional_intent_writeback:cache' }];
    return { aggregate, negatedAggregate: {}, matchedTerms };
  }

  const { emotionKey, keywords, provider } = await classifyEmotionalIntent(rawQuery, groqApiKey, cerebrasApiKey);
  if (!emotionKey) return null;

  scheduleWriteBack(writeBackToLexicon(supabase, rawQuery, emotionKey, keywords, provider));

  const aggregate = { [emotionKey]: FALLBACK_INTENSITY };

  // FIX 2026-07-19 (Notion "Backend Update List" Entry 57): matchedTerms
  // used to be a single entry holding the ENTIRE raw query string as
  // "term" -- e.g. "i want a story about finding people who become
  // family". rankResults.js's descriptionMatchScore() (built for the
  // Mixer-saturation fix) checks whether each term literally appears as a
  // substring in a candidate's synopsis -- a full sentence essentially
  // never does, so descriptionMatch was silently always 0 for every query
  // that reached this fallback. Once a query lands on a MANGA_ROUTING key
  // (e.g. "comfort"), every such query became indistinguishable: same
  // boosted genres -> same genre_in browse -> saturated genre/emotion
  // scores -> descriptionMatch fallback fires but finds nothing -> ranking
  // silently degrades to popularity, so distinct queries like "heals
  // loneliness" vs. "found family" vs. "nobody left behind" all returned
  // the same handful of popular Drama/Slice of Life titles reshuffled.
  // Using the LLM's own short, synopsis-plausible keywords (see
  // buildMessages()'s updated prompt) instead of the raw sentence gives
  // descriptionMatchScore() real per-candidate signal to work with, so a
  // candidate whose synopsis actually mentions "found family" or
  // "loneliness" now ranks above one that merely shares a genre tag.
  // Falls back to the old single-full-sentence term if the model replied
  // with just a bare key and no keywords (e.g. an older/drifted reply) --
  // strictly no worse than before in that case, not a regression.
  //
  // UPDATED Entry 58: this fresh-classification path now also persists
  // `keywords` (see writeBackToLexicon()) and getWrittenBackClassification()
  // above reads them back on an exact-phrase repeat, so the keyword-level
  // distinction survives a cache hit too -- previously flagged as a known
  // limitation here ("only helps fresh LLM classifications, not lexicon-hit
  // repeats"), now closed.
  const matchedTerms = keywords.length > 0
    ? keywords.map((term) => ({ term, emotions: aggregate, source: `emotional_intent_fallback:${provider}` }))
    : [{ term: normalize(rawQuery).trim(), emotions: aggregate, source: `emotional_intent_fallback:${provider}` }];

  return {
    aggregate,
    negatedAggregate: {},
    matchedTerms,
  };
}
