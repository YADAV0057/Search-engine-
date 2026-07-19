// parser/acclaimScoring.js
//
// Entry 35/40 implementation: acclaim/quality-intent detection, plus the
// Bayesian quality score it feeds into rankResults.js.
//
// Two-tier intent detection, cheapest signal first:
//   1. Lexicon tier (free). "acclaim" is just another emotion key in
//      manga_emotion_lexicon -- the same table/mechanism moodLexicon.js
//      already uses for melancholy/warmth/dread/etc. If the lexicon has
//      rows like {"critically acclaimed": {acclaim: 7}, "hidden gem":
//      {acclaim: 6}}, analyzeQueryMood() already picks them up into
//      mood.aggregate.acclaim with zero changes to that file -- this
//      module just reads the mood object domains.js already computed.
//   2. Groq semantic tier (only when the lexicon tier is weak/absent).
//      Catches paraphrased acclaim language the lexicon wasn't seeded
//      for -- "something I'll remember for years", "actually worth my
//      time, not just popular". One small/cheap model call, fails closed
//      (falls back to lexicon-only, or to zero) on any error, timeout, or
//      missing API key -- this must never be able to block a search.
//
// Entry 40 originally proposed an embedding-based semantic layer (query
// embedding vs. anchor-phrase cosine similarity). That still needs
// embedding infra this project hasn't built. This ships the same idea --
// a cheap semantic check for paraphrased acclaim language -- without
// waiting on that infra, using a model call instead of a vector compare.
// Worth swapping for real embeddings later if/when Entry 31's mood-
// embedding infra gets built, since one shared semantic layer beats two.
//
// ADDED: lexicon write-back. A Groq call that confidently classifies a
// paraphrase gets written into manga_emotion_lexicon so the NEXT time
// anyone searches that phrasing (even after the 6-hour search_cache TTL
// expires, even for a different user), it's picked up by the free lexicon
// tier and Groq never gets called for it again. This is the difference
// between "pay for the same Groq call forever" and "pay once per novel
// phrase" -- the lexicon only ever grows, so the Groq-call rate for
// acclaim-intent queries should trend toward zero as it fills in over
// time, for whatever phrasings people actually use.
//
// Gated on confidence (see WRITEBACK_THRESHOLD below) for a reason: an
// unsure Groq guess going into the lexicon would misclassify every future
// query matching that exact phrase, permanently, for free -- a bad
// tradeoff versus just paying for Groq again next time. Runs via
// EdgeRuntime.waitUntil() so it never adds latency to the search response
// itself; it's a best-effort side effect, not part of the request's
// critical path.
import { normalize } from './normalize.js';

const ACCLAIM_SATURATION = 8; // same saturating-cap pattern as
                               // rankResults.js's MOOD_INTENSITY_SATURATION
const LEXICON_STRONG_ENOUGH = 3; // lexicon signal at/above this skips the
                                  // Groq call entirely -- no need to pay for
                                  // a second opinion when the first one is
                                  // already confident
const GROQ_TIMEOUT_MS = 3000;
const GROQ_MODEL = 'llama-3.1-8b-instant'; // this is a single-integer
                                            // classification, not
                                            // generation -- smallest/fastest
                                            // Groq model is the right choice
const WRITEBACK_THRESHOLD = 0.5; // groqScore >= 5/10 -- confident enough to
                                  // trust as ground truth for future
                                  // queries. Below this, write nothing.

function normalizeLexiconIntensity(mood) {
  const raw = mood?.aggregate?.acclaim;
  if (!raw || raw <= 0) return 0;
  return Math.min(1, raw / ACCLAIM_SATURATION);
}

async function callGroqForAcclaimIntent(query, apiKey) {
  if (!apiKey || !query) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: 10,
        messages: [
          {
            role: 'system',
            content:
              'You classify whether a manga search query is asking for ' +
              'CRITICALLY-ACCLAIMED / HIGH-QUALITY / MEMORABLE work ' +
              'specifically -- not just "good", a genre word, or an ' +
              'unrelated mood word. Reply with ONLY a single integer 0-10: ' +
              '0 = no quality/acclaim intent at all, 10 = explicitly asking ' +
              'for the best/most acclaimed/most memorable work. Examples: ' +
              '"recommend something I\'ll remember for years" -> 7. ' +
              '"something sad" -> 0. "hidden gem I might have missed" -> 6. ' +
              '"romance manga" -> 0. "actually worth reading, not just ' +
              'popular" -> 8.'
          },
          { role: 'user', content: query }
        ]
      })
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[acclaimScoring] Groq returned HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    const score = parseInt(text, 10);
    if (!Number.isFinite(score)) return null;
    return Math.max(0, Math.min(10, score)) / 10;
  } catch (err) {
    clearTimeout(timeout);
    console.error('[acclaimScoring] Groq call failed', err);
    return null;
  }
}

/**
 * Fires the write-back promise without making the caller wait on it.
 * EdgeRuntime.waitUntil() (Supabase Edge Functions' background-task API)
 * keeps the isolate alive long enough for it to finish AFTER the response
 * has already been sent to the user -- so this adds zero latency to their
 * search. Falls back to a bare fire-and-forget outside that runtime (e.g.
 * local `deno run` testing) so this file doesn't hard-depend on it.
 */
function scheduleWriteBack(promise) {
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(promise);
  } else {
    promise.catch((err) => {
      console.error('[acclaimScoring] lexicon writeback failed (no EdgeRuntime)', err);
    });
  }
}

/**
 * Upserts a confident Groq classification into manga_emotion_lexicon so
 * future exact-phrase matches are free (lexicon tier) instead of another
 * Groq call. Merges into any existing emotions row rather than overwriting
 * it, so a phrase that already carries other emotion signal keeps it.
 *
 * Deliberately swallows every error here -- this is a best-effort cache-
 * warming side effect running after the response is already sent. It must
 * never be able to surface a failure to the user, and by the time this
 * runs there's no response left to attach an error to anyway.
 */
async function writeBackToLexicon(supabase, query, groqScore) {
  if (!supabase || !query) return;

  const term = normalize(query).trim();
  if (!term) return;

  // Back to the lexicon's native ~0-10 scale (matches existing rows like
  // "critically acclaimed" -> 7), rather than the 0-1 scale used
  // internally for blending.
  const intensity = Math.round(groqScore * 10);

  try {
    // Entry 60 fix (Notion "Backend Update List"): scoped by entity_type,
    // symmetric with emotionalIntentFallback.js's own fix -- this fetch
    // previously pulled in and merged whatever entity_type='mood_word' row
    // existed for the same normalized_term, corrupting `emotions` with a
    // key this feature never intended to write there. See that file's
    // writeBackToLexicon() for the full repro and the migration that added
    // the composite (normalized_term, entity_type) unique constraint this
    // now targets via onConflict below.
    const { data: existing, error: fetchErr } = await supabase
      .from('manga_emotion_lexicon')
      .select('emotions')
      .eq('normalized_term', term)
      .eq('entity_type', 'acclaim_phrase')
      .maybeSingle();

    if (fetchErr) {
      console.error('[acclaimScoring] lexicon writeback lookup failed', fetchErr);
      return;
    }

    const emotions = { ...(existing?.emotions || {}), acclaim: intensity };

    const { error: upsertErr } = await supabase
      .from('manga_emotion_lexicon')
      .upsert(
        { term, normalized_term: term, entity_type: 'acclaim_phrase', emotions, source: 'groq_acclaim_writeback' },
        { onConflict: 'normalized_term,entity_type' }
      );

    if (upsertErr) {
      console.error('[acclaimScoring] lexicon writeback upsert failed', upsertErr);
    }
  } catch (err) {
    console.error('[acclaimScoring] lexicon writeback threw', err);
  }
}

/**
 * Main entry point. Returns { intensity: 0-1, source: string|null }.
 *
 * mood: the object domains.js already computed via computeMoodSignal()
 *   (may be null for a filters-only browse -- handled below, degrades to
 *   { intensity: 0, source: null } rather than throwing).
 * query: the raw query string, used for the Groq fallback tier AND as the
 *   lexicon key on write-back.
 * groqApiKey: Deno.env.get('GROQ_API_KEY') -- optional. When absent this
 *   silently degrades to lexicon-only and never throws.
 * supabase: the request's Supabase client, used only for the write-back.
 *   Optional -- when absent, write-back is silently skipped (still returns
 *   the Groq result for THIS request, it just doesn't get remembered).
 */
async function computeAcclaimIntensity(mood, query, groqApiKey, supabase) {
  const lexiconIntensity = normalizeLexiconIntensity(mood);
  const lexiconRaw = mood?.aggregate?.acclaim ?? 0;

  if (lexiconRaw >= LEXICON_STRONG_ENOUGH) {
    return { intensity: lexiconIntensity, source: 'lexicon' };
  }

  const groqScore = await callGroqForAcclaimIntent(query, groqApiKey);

  if (groqScore === null) {
    return lexiconRaw > 0
      ? { intensity: lexiconIntensity, source: 'lexicon' }
      : { intensity: 0, source: null };
  }

  if (groqScore >= WRITEBACK_THRESHOLD) {
    scheduleWriteBack(writeBackToLexicon(supabase, query, groqScore));
  }

  const blended = Math.max(lexiconIntensity, groqScore);
  const source = lexiconRaw > 0 ? 'lexicon+groq' : 'groq';
  return { intensity: blended, source };
}

/**
 * Bayesian/weighted quality score (IMDB-style formula), 0-1 per candidate.
 *
 * Pulls low-vote-count titles toward the batch mean instead of letting a
 * single 10/10 rating outrank 5,000 ratings averaging 8.5 -- the concrete
 * problem Entry 40 flagged with a raw `filters.minScore` hard cutoff (a
 * 74.9-with-50k-ratings title wrongly excluded by a `>= 75` threshold).
 *
 * Caveat worth keeping visible rather than papering over: none of the
 * four adapters return a true per-title vote/rating count today, only
 * averageScore (0-100) and popularity (a follower/member/user count --
 * a real but imperfect proxy for "how many people have actually rated
 * this"). Using popularity as the `v` term is the best signal available
 * without a schema change to every adapter, not a perfect one. Revisit if
 * AniList's `stats.scoreDistribution` (true vote breakdown) or similar
 * ever gets added to the GraphQL query in anilist.js.
 *
 * `m` (the prior's strength) is expressed as a fraction of the current
 * batch's own popularity range rather than a fixed absolute number, so it
 * scales sensibly whether the batch is AniList's mainstream catalog
 * (popularity in the tens of thousands) or a niche MangaDex fan-out
 * (popularity in the hundreds).
 */
function computeQualityScores(results) {
  const scored = results.map((r) => ({
    score: typeof r.averageScore === 'number' ? r.averageScore : null,
    votes: typeof r.popularity === 'number' ? r.popularity : 0,
  }));

  const validScores = scored.filter((s) => s.score !== null);
  if (validScores.length === 0) {
    return results.map(() => 0);
  }

  const C = validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length;
  const maxVotes = Math.max(...scored.map((s) => s.votes), 1);
  const m = maxVotes * 0.1; // titles under ~10% of the batch's top
                             // popularity get pulled hardest toward C

  return scored.map(({ score, votes }) => {
    if (score === null) return 0;
    const v = votes;
    const weighted = (v / (v + m)) * score + (m / (v + m)) * C;
    return Math.max(0, Math.min(1, weighted / 100));
  });
}

export { computeAcclaimIntensity, computeQualityScores };
