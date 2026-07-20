// parser/tropeSignature.js
//
// Notion "Backend Update List" Entry 71. Replaces the "wait for the repo 
// owner's 1000-trope source list" plan (Entry 69/70) with an LLM-driven
// trope-signature generator, generalizing idiomFallback.js's write-back
// pattern (Entry 61) to the `trope_signatures` table Entry 68 designed.
//
// WHY TAGS/GENRES ONLY, NEVER TITLES (this is the whole point of this file
// existing instead of just extending idiomFallback.js in place):
// Entry 68 already rejected "trope name + a few seed titles" as the seeding
// method, because a title-list answer is a fixed-size set that never grows
// -- "enemies to lovers" would return the same handful of titles forever,
// even as new matching manga get harvested. The original LLM-fallback idea
// floated for this file had the same flaw one level removed: ask the model
// for 3-5 example titles, then derive tags from THOSE titles. That still
// anchors the signature's generation to whatever the model happens to know
// about today, and still requires a second title->tag derivation pass.
// This version skips titles entirely, at every stage: the LLM is asked
// directly for real AniList tags/genres (from the actual vocabulary this
// project already has -- see getTagVocabEntries()/getGenreVocabEntries()
// in queryClassifier.js), so a trope_signatures row is immediately usable
// exactly as Entry 68 designed, and any manga harvested later that carries
// the returned tags surfaces automatically -- new/unreleased titles
// included, zero re-seeding, zero title-vocabulary dependency at all.
//
// TABLE THIS WRITES TO: `trope_signatures` (see Entry 68/69/70 -- not
// `manga_emotion_lexicon`, which is the separate mood/idiom lexicon
// idiomFallback.js writes to). Expected shape, matching the 200 rows
// already seeded manually in batches 1-2:
//   term            text
//   normalized_term text  (unique -- upsert target)
//   tag_weights     jsonb   { "Love Triangle": 6, "Rivalry": 4, ... }
//   genre_weights   jsonb   { "Romance": 7, ... }
//   aliases         text[]  (left empty here -- alias population is a
//                            separate, not-yet-built concern; see status
//                            note at the bottom of this file)
//   batch_number    int     (NULL for LLM-fallback rows -- batch_number is
//                            reserved for the manual/scheduled-backfill
//                            seeding lineage from Entry 69/70; a query-time
//                            single-phrase fallback row isn't part of a
//                            numbered batch)
//   source          text    ("trope_signature_fallback:<provider>")
//
// PROVIDER CHAIN (per Entry 71, "just a fallback" -- no split-by-feature):
// Groq -> Cerebras -> Gemini. Groq/Cerebras reuse the same OpenAI-compatible
// request shape already used by idiomFallback.js/acclaimScoring.js/
// emotionalIntentFallback.js. Gemini is a genuinely different API shape
// (Google's generateContent endpoint, key as a query param, different
// response envelope) so it gets its own call function rather than being
// forced into callProvider()'s OpenAI-shaped request. Fails closed at every
// tier, same as the rest of this pipeline: if all three are unreachable,
// missing keys, or return low-confidence, this is a no-op, never an error
// surfaced to the search response.
//
// WRITEBACK GATING: same reasoning as idiomFallback.js (see that file's
// header) -- this creates brand-new rows for phrases the system hasn't
// seen before, so a false positive plants a fake trope signature that
// silently biases every future query matching it. Same stricter-than-
// acclaim bar, WRITEBACK_THRESHOLD = 0.75, applied here too.
//
// WIRED INTO domains.js as of Entry 72 (repo owner: candidate phrases come
// from live user queries as they search). getTropeSignatureFallbackForQuery()
// near the bottom of this file is the entry point runManga() calls --
// see that function's own header for the span-extraction details, and
// domains.js's diff for the exact call site (mirrors the getIdiomFallback()
// pattern inside computeMoodSignal()). Delivered as a file for GitHub
// review/commit, per this project's established workflow since Entry
// 46/50/51/61 -- not deployed directly.

import { STOPWORDS, normalize } from './normalize.js';

const WRITEBACK_THRESHOLD = 0.75; // same bar as idiomFallback.js, same reasoning

const PROVIDER_TIMEOUT_MS = 3000; // same budget as every other LLM tier in this pipeline

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'llama3.1-8b';

// Gemini model name, updated 2026-07-19: 'gemini-2.5-flash' (this file's
// original choice) has been discontinued -- confirmed via Google's own
// Gemini API release notes. 'gemini-3.5-flash' is the current GA fast/
// cheap model as of this update (released as the GA version of the 3.5
// series, positioned as the direct successor to the 2.x Flash line for
// high-volume, cost-sensitive classification work like this fallback).
// Google's Flash-tier naming has churned faster than Groq/Cerebras's
// model strings historically have in this repo -- if this model is ever
// retired too, check https://ai.google.dev/gemini-api/docs/models for
// the current GA Flash-tier model and swap this one constant.
const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_URL = (model, apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

// Cap how many tag/genre names get spelled out in the prompt -- the full
// tag vocab is ~420 entries (see queryClassifier.js's getTagVocabEntries()
// header), which is a lot of prompt tokens per call. Sending the full list
// is still the correct thing to do for correctness (the model must only
// pick from real vocabulary), but worth flagging as a real cost/latency
// tradeoff if this fallback ends up firing often -- see status note at the
// bottom of this file.
const MAX_TAG_NAMES_IN_PROMPT = 420;
const MAX_GENRE_NAMES_IN_PROMPT = 40;

/**
 * Builds the constrained-vocabulary prompt described in Entry 71. Tags and
 * genres are both drawn from this project's real, already-harvested
 * AniList vocabulary (queryClassifier.js's getTagVocabEntries()/
 * getGenreVocabEntries()) -- never freeform, never a title.
 */
function buildMessages(phrase, tagNames, genreNames) {
  const tagList = tagNames.slice(0, MAX_TAG_NAMES_IN_PROMPT).join(', ');
  const genreList = genreNames.slice(0, MAX_GENRE_NAMES_IN_PROMPT).join(', ');

  return [
    {
      role: 'system',
      content:
        'You classify whether a short phrase is a REAL, RECOGNIZED manga/' +
        'anime STORY TROPE (examples: "enemies to lovers", "slow burn", ' +
        '"found family", "revenge arc", "isekai reincarnation"). It is NOT ' +
        'a plain genre word, NOT a character/title name, and NOT an ' +
        'ordinary adjective pair. If it is NOT a real trope, reply with ' +
        'only the word none.\n\n' +
        'If it IS a real trope, reply in EXACTLY this format and nothing ' +
        'else: a confidence integer 0-10, then "|", then 3-6 tags chosen ' +
        'ONLY from this exact list (comma-separated, each as tag:weight, ' +
        'weight 1-10): ' + tagList + '\n' +
        'then "|", then 1-3 genres chosen ONLY from this exact list ' +
        '(same tag:weight format): ' + genreList + '\n\n' +
        'Do not invent tags or genres outside these two lists. Do not name ' +
        'any manga/anime titles anywhere in your answer -- score the ' +
        'CONCEPT itself, not examples of it, so new/future titles that fit ' +
        'the trope are also covered. If a real adjacent tag exists even ' +
        'when no exact-name tag matches the trope (e.g. "Enemies to ' +
        'Lovers" has no tag literally named that -- use "Rivalry"/"Love ' +
        'Triangle" instead), use the closest real adjacent tags rather ' +
        'than returning none.\n\n' +
        'Example: "slow burn" -> 9|Slow Burn:6,Romance Subplot:4,Drama:3' +
        '|Romance:6,Drama:3'
    },
    { role: 'user', content: phrase }
  ];
}

/**
 * Parses "confidence|tag:weight,tag:weight|genre:weight,genre:weight" or
 * "none". Drops any tag/genre name outside the real vocab passed in
 * (a model ignoring the constraint) rather than failing the whole
 * classification -- same tolerant-but-bounded pattern as
 * idiomFallback.js's/emotionalIntentFallback.js's parsers. Returns null if
 * nothing valid survives on either side.
 */
function parseClassification(rawContent, tagNames, genreNames) {
  const trimmed = (rawContent || '').trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().replace(/[^a-z]/g, '') === 'none') return null;

  const parts = trimmed.split('|');
  if (parts.length < 3) return null;

  const confidence = parseInt(parts[0].replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(confidence)) return null;

  const tagVocabLower = new Map(tagNames.map((n) => [n.toLowerCase(), n]));
  const genreVocabLower = new Map(genreNames.map((n) => [n.toLowerCase(), n]));

  const parseWeightedList = (segment, vocabLower) => {
    const out = {};
    segment.split(',').forEach((pair) => {
      const [rawName, rawWeight] = pair.split(':').map((s) => (s || '').trim());
      if (!rawName) return;
      const realName = vocabLower.get(rawName.toLowerCase());
      const weight = parseInt(rawWeight, 10);
      if (realName && Number.isFinite(weight) && weight > 0) {
        out[realName] = Math.max(1, Math.min(10, weight));
      }
    });
    return out;
  };

  const tagWeights = parseWeightedList(parts[1], tagVocabLower);
  const genreWeights = parseWeightedList(parts[2], genreVocabLower);

  if (Object.keys(tagWeights).length === 0 && Object.keys(genreWeights).length === 0) {
    return null;
  }

  return {
    confidence: Math.max(0, Math.min(10, confidence)) / 10,
    tagWeights,
    genreWeights
  };
}

async function callOpenAICompatibleProvider(url, model, apiKey, messages) {
  if (!apiKey) return { ok: false };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model, temperature: 0, max_tokens: 200, messages })
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[tropeSignature] provider returned HTTP ${response.status} (${url})`);
      return { ok: false };
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    return { ok: true, text };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[tropeSignature] provider call failed', err);
    return { ok: false };
  }
}

/**
 * Gemini's generateContent has a different request/response envelope than
 * the OpenAI-compatible providers -- system+user messages are folded into
 * one `contents` array (Gemini's `system_instruction` field is a cleaner
 * fit for the system prompt but kept simple/consistent here by sending both
 * as user-role text, same net effect for a single-turn classification
 * call), and the reply text is nested under
 * candidates[0].content.parts[0].text instead of choices[0].message.content.
 */
async function callGeminiProvider(apiKey, messages) {
  if (!apiKey) return { ok: false };

  const systemText = messages.find((m) => m.role === 'system')?.content || '';
  const userText = messages.find((m) => m.role === 'user')?.content || '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(GEMINI_URL(GEMINI_MODEL, apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${systemText}\n\n${userText}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 200 }
      })
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[tropeSignature] Gemini returned HTTP ${response.status}`);
      return { ok: false };
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return { ok: true, text };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[tropeSignature] Gemini call failed', err);
    return { ok: false };
  }
}

/**
 * Groq -> Cerebras -> Gemini, pure fallback (per Entry 71: "just a
 * fallback", not a split-by-feature assignment). Each tier is only
 * consulted if the previous one was unreachable/errored (ok: false) --
 * a confident "none" result (ok: true, parsed: null) from an earlier tier
 * is final and is never second-guessed by a later provider.
 */
async function classifyTrope(phrase, tagNames, genreNames, groqApiKey, cerebrasApiKey, geminiApiKey) {
  const messages = buildMessages(phrase, tagNames, genreNames);

  const groqResult = await callOpenAICompatibleProvider(GROQ_URL, GROQ_MODEL, groqApiKey, messages);
  if (groqResult.ok) {
    const parsed = parseClassification(groqResult.text, tagNames, genreNames);
    return parsed ? { ...parsed, provider: 'groq' } : null;
  }

  const cerebrasResult = await callOpenAICompatibleProvider(CEREBRAS_URL, CEREBRAS_MODEL, cerebrasApiKey, messages);
  if (cerebrasResult.ok) {
    const parsed = parseClassification(cerebrasResult.text, tagNames, genreNames);
    return parsed ? { ...parsed, provider: 'cerebras' } : null;
  }

  const geminiResult = await callGeminiProvider(geminiApiKey, messages);
  if (geminiResult.ok) {
    const parsed = parseClassification(geminiResult.text, tagNames, genreNames);
    return parsed ? { ...parsed, provider: 'gemini' } : null;
  }

  return null;
}

function scheduleWriteBack(promise) {
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(promise);
  } else {
    promise.catch((err) => {
      console.error('[tropeSignature] writeback failed (no EdgeRuntime)', err);
    });
  }
}

/**
 * Upserts a confident classification into `trope_signatures`. Scoped on
 * `normalized_term` (assumed unique, matching the table's existing manual
 * rows from batches 1-2 -- NOT YET CONFIRMED against the live schema, same
 * open item Entry 47 flagged for manga_emotion_lexicon and later confirmed;
 * repo owner should verify this constraint exists before this goes live,
 * same caveat, not re-verified here).
 *
 * batch_number is left null -- see file header. aliases is left as an
 * empty array; populating aliases (so e.g. "rivals to lovers" reuses
 * "enemies to lovers"'s row) is a real improvement but a separate concern
 * from this fallback's job, not built here.
 */
async function writeBackToTropeSignatures(supabase, phrase, tagWeights, genreWeights, provider) {
  if (!supabase || !phrase) return;
  const term = normalize(phrase).trim();
  if (!term) return;

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('trope_signatures')
      .select('tag_weights, genre_weights')
      .eq('normalized_term', term)
      .maybeSingle();

    if (fetchErr) {
      console.error('[tropeSignature] writeback lookup failed', fetchErr);
      return;
    }

    // Merge rather than clobber, same as every other write-back tier in
    // this pipeline -- in case a concurrent session (per Entry 43, this
    // project regularly has several running at once) wrote a partial
    // signature for the same term first.
    const tagWeightsOut = { ...(existing?.tag_weights || {}), ...tagWeights };
    const genreWeightsOut = { ...(existing?.genre_weights || {}), ...genreWeights };

    const { error: upsertErr } = await supabase
      .from('trope_signatures')
      .upsert(
        {
          term: phrase.trim(),
          normalized_term: term,
          tag_weights: tagWeightsOut,
          genre_weights: genreWeightsOut,
          batch_number: null,
          source: `trope_signature_fallback:${provider}`
        },
        { onConflict: 'normalized_term' }
      );

    if (upsertErr) {
      console.error('[tropeSignature] writeback upsert failed', upsertErr);
    }
  } catch (err) {
    console.error('[tropeSignature] writeback threw', err);
  }
}

/**
 * Checks trope_signatures for an existing live row before ever calling an
 * LLM -- this fallback should only fire on a genuine miss, same as
 * idiomFallback.js only fires on genuinely uncovered spans. Cheap single
 * lookup, no new caching layer (this table is small -- ~200 rows today,
 * per Entry 70 -- a warm in-memory cache is a reasonable future
 * optimization if this table grows toward the full 1000+, not needed yet).
 */
async function findExistingSignature(supabase, phrase) {
  const term = normalize(phrase).trim();
  if (!supabase || !term) return null;

  const { data, error } = await supabase
    .from('trope_signatures')
    .select('term, tag_weights, genre_weights')
    .eq('normalized_term', term)
    .maybeSingle();

  if (error) {
    console.error('[tropeSignature] existing-signature lookup failed', error);
    return null;
  }
  return data || null;
}

/**
 * Main entry point (NOT YET CALLED from domains.js -- see file header for
 * the wiring note). Given a candidate trope-like phrase already extracted
 * upstream (e.g. via idiomFallback.js's extractCandidateSpans() pattern, or
 * Entry 67's not-yet-built dedicated trope/mood classification lane),
 * returns either an existing live signature or a freshly LLM-classified one
 * -- never both, never a title, never anything outside the real tag/genre
 * vocabulary passed in.
 *
 * tagVocabEntries/genreVocabEntries: the arrays returned by
 * queryClassifier.js's getTagVocabEntries()/getGenreVocabEntries() (each
 * entry expected to have a `.name`), so domains.js can pass in the same
 * already-warm vocab it loads once per request for other purposes (see
 * domains.js's existing `tagVocab` construction around its acclaim/rank
 * wiring) rather than this file re-fetching it.
 *
 * Returns null (no signal, no-op) or
 * { term, tagWeights, genreWeights, source: 'existing' | `llm:${provider}` }.
 */
export async function getTropeSignatureFallback(
  phrase,
  tagVocabEntries,
  genreVocabEntries,
  groqApiKey,
  cerebrasApiKey,
  geminiApiKey,
  supabase
) {
  if (!phrase || !supabase) return null;

  const existing = await findExistingSignature(supabase, phrase);
  if (existing) {
    return {
      term: existing.term,
      tagWeights: existing.tag_weights || {},
      genreWeights: existing.genre_weights || {},
      source: 'existing'
    };
  }

  if (!groqApiKey && !cerebrasApiKey && !geminiApiKey) return null;

  const tagNames = (tagVocabEntries || []).map((e) => e.name).filter(Boolean);
  const genreNames = (genreVocabEntries || []).map((e) => e.name).filter(Boolean);
  if (tagNames.length === 0 && genreNames.length === 0) return null;

  const result = await classifyTrope(phrase, tagNames, genreNames, groqApiKey, cerebrasApiKey, geminiApiKey);
  if (!result) return null;

  if (result.confidence >= WRITEBACK_THRESHOLD) {
    scheduleWriteBack(writeBackToTropeSignatures(supabase, phrase, result.tagWeights, result.genreWeights, result.provider));
  }

  return {
    term: phrase,
    tagWeights: result.tagWeights,
    genreWeights: result.genreWeights,
    source: `llm:${result.provider}`
  };
}

const MIN_SPAN_WORDS = 2;      // same reasoning as idiomFallback.js: a
                                 // single uncovered word is just "no
                                 // lexicon/AFINN entry", not trope territory
const MAX_SPAN_WORDS = 4;       // matches moodLexicon.js's MAX_PHRASE_WORDS
const MAX_SPANS_PER_QUERY = 2;  // cap LLM calls per request, longest spans first

/**
 * Finds contiguous runs of query tokens that got no coverage at all from
 * analyzeQueryMood() -- not claimed by a lexicon phrase match, not scored
 * by AFINN, and not sitting inside a negation trigger's scope. This is a
 * deliberate, standalone copy of idiomFallback.js's extractCandidateSpans()
 * rather than a shared import: the two fallbacks are independent LLM tiers
 * (idiom/mood-phrase vs. trope/tag-genre) that happen to both need "which
 * words did nothing else cover" as their starting point, and keeping them
 * decoupled means either one's span-selection logic can change without
 * touching the other. If this duplication becomes a maintenance problem
 * (the two drift and nobody notices), worth factoring out to a shared
 * parser/spanExtraction.js -- not done here, same "flag, don't yet fix"
 * pattern as this file's other open items.
 *
 * BUGFIX (2026-07-20, found via a live production row): an uncovered run
 * LONGER than MAX_SPAN_WORDS used to be left-chunked into consecutive
 * MAX_SPAN_WORDS-sized windows (e.g. a 5-word run -> one 4-word span +
 * one 1-word leftover). For a real query -- "Something that feels like a
 * warm cup of tea" -- the uncovered run was "a warm cup of tea" (5 words),
 * which chunked into "a warm cup of" (4 words, span pushed) + "tea"
 * (1 word, dropped for being under MIN_SPAN_WORDS). The LLM then received
 * the truncated fragment MINUS the one word that made it mean anything,
 * misclassified "a warm cup of" as a real trope, and wrote back a false
 * {Drama, Slice of Life} signature that now pollutes every future "warm
 * cup of X" query too (see this file's own writeback code -- an existing
 * row is trusted, never re-classified).
 *
 * FIX: a run longer than MAX_SPAN_WORDS is now skipped entirely rather
 * than chunked. Real trope names are essentially never more than 4 words
 * ("enemies to lovers" is 3; "isekai reincarnation" is 2) -- an uncovered
 * run longer than that is far more likely a whole descriptive/idiom
 * sentence fragment, which is emotionalIntentFallback.js's/
 * idiomFallback.js's territory, not this file's. Silently truncating it
 * to fit was the actual bug, not a reasonable fallback.
 */
function extractCandidateSpans(cleanTokens, claimed, negated) {
  const spans = [];
  let runStart = null;

  const flushRun = (end) => {
    if (runStart === null) return;
    const runTokens = cleanTokens.slice(runStart, end);
    const meaningful = runTokens.filter((t) => !STOPWORDS.has(t));
    if (meaningful.length >= MIN_SPAN_WORDS && meaningful.length <= MAX_SPAN_WORDS) {
      spans.push(runTokens.join(' '));
    }
    // meaningful.length > MAX_SPAN_WORDS: deliberately dropped, not
    // chunked -- see BUGFIX note above.
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

  return spans
    .sort((a, b) => b.split(' ').length - a.split(' ').length)
    .slice(0, MAX_SPANS_PER_QUERY);
}

/**
 * Main query-time entry point, wired into domains.js's runManga() (Entry
 * 72 -- "candidate phrase will come from user queries as they search").
 * Takes the SAME cleanTokens/claimed/negated coverage mask idiomFallback.js
 * already consumes (exposed on computeMoodSignal()'s return value for this
 * purpose), extracts up to MAX_SPANS_PER_QUERY uncovered spans from the
 * user's live query, and runs each through getTropeSignatureFallback()
 * above -- existing-signature lookup first, LLM classification only on a
 * genuine miss, write-back gated the same as before.
 *
 * Deliberately does NOT try to merge/dedupe overlapping trope matches
 * across spans -- with MAX_SPANS_PER_QUERY capped at 2, this is a small
 * enough result set that domains.js can just take whichever span(s)
 * returned a signal and fold their genre/tag weights in directly (plain
 * union, same as everywhere else in this pipeline merges multi-source
 * genre lists).
 *
 * Returns null (nothing found/uncovered) or the FIRST confident signature
 * match across the candidate spans -- not all of them merged into one
 * object, to keep the shape simple for domains.js's fold-in step. If a
 * query genuinely contains two distinct trope phrases, only the first
 * (longest-span-first, per extractCandidateSpans()'s ordering) is used --
 * a real but narrow limitation, flagged rather than solved here.
 */
export async function getTropeSignatureFallbackForQuery(
  cleanTokens,
  claimed,
  negated,
  tagVocabEntries,
  genreVocabEntries,
  groqApiKey,
  cerebrasApiKey,
  geminiApiKey,
  supabase
) {
  if (!cleanTokens || cleanTokens.length === 0) return null;
  if (!groqApiKey && !cerebrasApiKey && !geminiApiKey) return null;

  const spans = extractCandidateSpans(cleanTokens, claimed || [], negated || []);
  if (spans.length === 0) return null;

  for (const phrase of spans) {
    const result = await getTropeSignatureFallback(
      phrase,
      tagVocabEntries,
      genreVocabEntries,
      groqApiKey,
      cerebrasApiKey,
      geminiApiKey,
      supabase
    );
    if (result) return result;
  }

  return null;
}

// ---------------------------------------------------------------------
// STATUS, updated 2026-07-19 (Entry 72): Component 1 (query-time fallback)
// is now WIRED, not standalone -- getTropeSignatureFallbackForQuery() is
// called from domains.js's runManga() (see that file's diff), sourcing
// candidate phrases from live user queries via the same coverage mask
// idiomFallback.js uses, per repo owner's direction. GEMINI_MODEL updated
// to 'gemini-3.5-flash' after 'gemini-2.5-flash' was confirmed discontinued.
//
// Still NOT built here, left for follow-up:
//   - Component 2 (scheduled backfill job seeding a starter set + scanning
//     search_cache for repeated near-misses) -- see harvest-tropes/
//     index.ts, delivered alongside this file.
//   - tropeSignal.tagWeights isn't yet threaded into rankResults()'s
//     tagVocab-based Tier-1 scoring -- domains.js currently only folds
//     genreWeights into the fetch-level plan.primaryGenres filter. Flagged
//     in domains.js's own diff comments, not solved here.
//   - Confirming `trope_signatures.normalized_term` actually has a unique
//     constraint (assumed, not verified against live schema -- same open
//     item pattern as Entry 47's manga_emotion_lexicon caveat).
//   - Confirming GEMINI_MODEL is still current at deploy time -- Google's
//     Flash-tier naming has churned faster than Groq/Cerebras's historically
//     have in this repo; not test-called this session either way.
// ---------------------------------------------------------------------
