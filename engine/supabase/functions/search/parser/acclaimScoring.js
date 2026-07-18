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
 * Main entry point. Returns { intensity: 0-1, source: string|null }.
 *
 * mood: the object domains.js already computed via computeMoodSignal()
 *   (may be null for a filters-only browse -- handled below, degrades to
 *   { intensity: 0, source: null } rather than throwing).
 * query: the raw query string, used only for the Groq fallback tier.
 * groqApiKey: Deno.env.get('GROQ_API_KEY') -- optional. When absent this
 *   silently degrades to lexicon-only and never throws.
 */
async function computeAcclaimIntensity(mood, query, groqApiKey) {
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

