// engine/supabase/functions/harvest-movie-keywords/index.ts
//
// MOVIE KEYWORD-SIGNATURE SEEDER — Phase 3 of Movie Search — Build Strategy
// (Phased). Movie-side counterpart to harvest-tropes/index.ts: same "classify
// a mood/vibe phrase against a real, live vocabulary via LLM, write the
// result back as weights" shape, retargeted at movie_keyword_signatures
// instead of trope_signatures.
//
// POST /harvest-movie-keywords   (header: x-harvest-secret: <HARVEST_SECRET>)
// { "mode": "bootstrap", "limit": 25 } -> { "results": { "bootstrap": {...} } }
//
// STRUCTURE MODELED DIRECTLY ON harvest-tropes/index.ts — same retry/backoff
// shape, same HARVEST_SECRET auth (reused, not a new secret), same
// classify-then-upsert flow. Not re-explained line by line here; see that
// file for the fuller rationale. Only "reclassify_thin" mode is omitted for
// this first pass — nothing has been seeded yet to reclassify, so there's no
// legacy-data problem to solve on day one the way harvest-tropes had.
//
// DIAGNOSTIC LOGGING ADDED (2026-07-29, same-day follow-up): first live run
// seeded only 3/25 terms (22 came back "no signal"). Rather than guess why,
// parseClassification/classifyMood/runBootstrap now distinguish and surface
// the ACTUAL failure reason per attempt (model said "none" vs unparseable
// format vs no API key vs HTTP failure vs zero vocab matches survived
// parsing) instead of collapsing everything into a single opaque null. The
// aggregated results also come back in the HTTP response body itself
// (noSignalDetails, capped to 10), not just Supabase's own function logs —
// so a GitHub Actions run's log output is enough to diagnose it without
// needing separate Supabase log access.
//
// PROGRESS TRACKING ADDED (2026-07-31): movie_keyword_seed_progress existed
// in the schema from day one but was never actually written to — it sat at
// total_seeded:0 since creation while 16 real rows accumulated in
// movie_keyword_signatures. runBootstrap now upserts progress (id=1,
// last_batch_number, total_seeded, updated_at) at the end of every run, so
// the tracker reflects reality and can be used to detect "is this cron
// actually running" at a glance instead of having to count table rows by
// hand. total_seeded is a full recount from movie_keyword_signatures each
// run (cheap at this table size) rather than an incrementing counter, so a
// manual DB edit or a failed partial run can't leave it silently wrong.
//
// WHAT'S DIFFERENT FROM harvest-tropes, AND WHY:
//   - Vocab source: harvest-tropes pulls tag/genre names from lexicon_entities
//     (manga's pre-seeded vocab tables). Movies has no equivalent pre-seeded
//     "tag" vocab — instead, harvest-movies/index.ts already writes real,
//     named keyword rows into movie_entities as entity_type='keyword'
//     (confirmed live: 5,113 distinct rows as of 2026-07-29, pulled straight
//     from TMDB's own /movie/{id}/keywords responses, not invented). That's
//     the vocab this file classifies against — genuinely present in the
//     harvested catalog, not a hand-curated list.
//   - Genre vocab: movies' genre list is the fixed, hardcoded TMDB set
//     already living in harvest-movies/index.ts's GENRE_ID_TO_NAME (19
//     genres, changes essentially never) — duplicated here by name list
//     rather than re-deriving it from movie_entities' jsonb metadata, same
//     "each harvester is self-contained" convention harvest-tropes itself
//     documents.
//   - Column reuse: movie_keyword_signatures' schema mirrors trope_signatures
//     exactly, including keeping the column NAME "tag_weights" even though
//     it holds KEYWORD weights here, not manga tags — that's the live
//     schema (confirmed via information_schema), not a naming choice made
//     in this file.
//   - STARTER_MOOD_TERMS below is a movie-appropriate seed list (mood/vibe
//     descriptors people actually search for — "cozy," "mind-bending,"
//     "tearjerker" — not manga tropes like "enemies to lovers"), sized
//     similarly to harvest-tropes' STARTER_TROPES for the same "small
//     high-confidence cold-start set, not a full-coverage attempt" reasoning.
//     Organic growth path (Component 1's live query-time fallback) does NOT
//     exist yet for movies — movie-search/domains.js has no equivalent to
//     tropeSignature.js today. That's a real gap, flagged here rather than
//     silently assumed away: this bootstrap pass is currently the ONLY way
//     movie_keyword_signatures grows. Worth building the query-time fallback
//     as a follow-up once this bootstrap set is proven useful, mirroring how
//     Component 1 was built for manga.
//
// KNOWN OPEN ISSUE (flagged 2026-07-31, not fixed here): unlike
// harvest-movies and backfill-embeddings, this function has no active
// cron/scheduled trigger — it has only been invoked by hand a handful of
// times since 2026-07-28 (16/40 starter terms seeded, in sparse bursts).
// Needs the same scheduled trigger the other two harvesters already have.
//
// NOT reusing GEMINI_API_KEY2/GEMINI_API_KEY3 here — those were confirmed
// reserved specifically for backfill-movie-embeddings (Notion Entry 99),
// intentionally not wired into anything else yet. This function uses the
// original shared GROQ_API_KEY/CEREBRAS_API_KEY/GEMINI_API_KEY trio instead,
// same provider-fallback chain harvest-tropes already uses for its own
// (much higher-volume) classification calls.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
);

const HARVEST_SECRET = Deno.env.get('HARVEST_SECRET'); // reused from harvest-lexicons/harvest-tropes
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY');
const CEREBRAS_API_KEY = Deno.env.get('CEREBRAS_API_KEY');
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'llama3.1-8b';
const GEMINI_MODEL = 'gemini-3.5-flash'; // kept in sync manually with harvest-tropes/index.ts — see that file's note
const GEMINI_URL = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

const PROVIDER_TIMEOUT_MS = 3000;
const WRITEBACK_THRESHOLD = 0.75; // same bar as harvest-tropes/tropeSignature.js
const LLM_CALL_GAP_MS = 500;
const DEFAULT_LIMIT = 25;
// Keyword vocab is large (5,113+ rows and growing every harvest run) —
// capped to the most relevant slice per prompt rather than dumping the
// whole table in, same reasoning as harvest-tropes capping tagNames at 420.
const MAX_KEYWORD_VOCAB_IN_PROMPT = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(s: string) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// ---- Starter mood/vibe list (bootstrap seed) ----
//
// Movie-appropriate cold-start set — vibes/moods people actually type into
// a "what should I watch" search box, not genre words (genre is already a
// separate filter) and not manga tropes. Deliberately small; grows via a
// future query-time fallback once one exists (see header note), same
// "don't hand-curate to full coverage" philosophy as STARTER_TROPES.
const STARTER_MOOD_TERMS = [
  'cozy watch', 'feel good movie', 'mind bending', 'tearjerker',
  'edge of your seat', 'popcorn flick', 'guilty pleasure', 'slow burn',
  'dark and gritty', 'nostalgic', 'wholesome', 'uplifting', 'bittersweet ending',
  'psychological thriller', 'whodunit mystery', 'heist movie', 'revenge story',
  'coming of age', 'underdog story', 'survival story', 'apocalyptic',
  'time loop', 'body horror', 'courtroom drama', 'workplace comedy',
  'one location thriller', 'road trip movie', 'based on a true story',
  'slow cinema', 'chaotic energy', 'comfort watch', 'rainy day movie',
  'first date movie', 'family movie night', 'plot twist ending',
  'unreliable narrator', 'anti hero protagonist', 'redemption story',
  'found family', 'against all odds', 'quiet and contemplative',
];

async function getKeywordVocabNames(): Promise<string[]> {
  const { data, error } = await supabase
    .from('movie_entities')
    .select('name')
    .eq('entity_type', 'keyword')
    .limit(MAX_KEYWORD_VOCAB_IN_PROMPT);
  if (error) throw error;
  return (data || []).map((r: { name: string }) => r.name).filter(Boolean);
}

// Fixed TMDB genre list — duplicated by name from harvest-movies/index.ts's
// GENRE_ID_TO_NAME rather than re-derived from jsonb metadata (self-contained
// convention, see header note). Keep in sync manually if that list changes.
const GENRE_VOCAB_NAMES = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery',
  'Romance', 'Science Fiction', 'TV Movie', 'Thriller', 'War', 'Western',
];

// ---- Classification (same shape as harvest-tropes' classifyTrope) ----

function buildMessages(phrase: string, keywordNames: string[], genreNames: string[]) {
  const keywordList = keywordNames.join(', ');
  const genreList = genreNames.join(', ');
  return [
    {
      role: 'system',
      content:
        'You classify whether a short phrase is a REAL, RECOGNIZABLE movie ' +
        'MOOD or VIBE description that someone might type into a "what ' +
        'should I watch" search box (examples: "cozy watch", "mind ' +
        'bending", "tearjerker", "edge of your seat"). It is NOT a plain ' +
        'genre word, NOT a movie/character title, and NOT an ordinary ' +
        'adjective with no shared meaning across audiences. If it is NOT ' +
        'a real mood/vibe term, reply with only the word none.\n\n' +
        'If it IS a real mood/vibe term, reply in EXACTLY this format and ' +
        'nothing else: a confidence integer 0-10, then "|", then 1-6 ' +
        'keywords chosen ONLY from this exact list (comma-separated, each ' +
        'as keyword:weight, weight 1-10): ' + keywordList + '\n' +
        'then "|", then 1-3 genres chosen ONLY from this exact list (same ' +
        'keyword:weight format): ' + genreList + '\n\n' +
        'IMPORTANT — precision over quantity: only include a keyword if it ' +
        'is a genuinely close match for the mood\'s actual meaning. A ' +
        'single precise keyword is a complete, correct answer — do NOT pad ' +
        'the list with weaker or tangentially-related keywords just to ' +
        'reach a higher count. It is normal and expected for many valid ' +
        'moods to have only 1-2 real keyword matches, or genre weights ' +
        'only with no keywords at all if nothing in the list genuinely ' +
        'fits — in that case still classify it (do not reply none just ' +
        'because the keyword list has no exact fit) but leave the keyword ' +
        'section as few entries as honestly justified, even zero.\n\n' +
        'Do not invent keywords or genres outside these two lists. Do not ' +
        'name any specific movie titles anywhere in your answer — score ' +
        'the CONCEPT itself, not examples of it.\n\n' +
        'Example of a good precise answer: "tearjerker" -> ' +
        '8|tragedy:3,loss:2|Drama:8,Romance:3 — note this uses only real ' +
        'list entries, not invented ones.'
    },
    { role: 'user', content: phrase }
  ];
}

function parseClassification(rawContent: string, keywordNames: string[], genreNames: string[]): { confidence: number; keywordWeights: Record<string, number>; genreWeights: Record<string, number> } | { failReason: string } {
  const trimmed = (rawContent || '').trim();
  if (!trimmed) return { failReason: 'empty_response' };
  if (trimmed.toLowerCase().replace(/[^a-z]/g, '') === 'none') return { failReason: 'model_said_none' };

  const parts = trimmed.split('|');
  if (parts.length < 3) return { failReason: `wrong_part_count:${parts.length}` };

  const confidence = parseInt(parts[0].replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(confidence)) return { failReason: 'unparseable_confidence' };

  const keywordVocabLower = new Map(keywordNames.map((n) => [n.toLowerCase(), n]));
  const genreVocabLower = new Map(genreNames.map((n) => [n.toLowerCase(), n]));

  const parseWeightedList = (segment: string, vocabLower: Map<string, string>) => {
    const out: Record<string, number> = {};
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

  const keywordWeights = parseWeightedList(parts[1], keywordVocabLower);
  const genreWeights = parseWeightedList(parts[2], genreVocabLower);
  if (Object.keys(keywordWeights).length === 0 && Object.keys(genreWeights).length === 0) {
    return { failReason: 'no_vocab_matches_survived_parse' };
  }

  return { confidence: Math.max(0, Math.min(10, confidence)) / 10, keywordWeights, genreWeights };
}

function isFailResult(r: { failReason: string } | { confidence: number }): r is { failReason: string } {
  return (r as { failReason?: string }).failReason !== undefined;
}

async function callOpenAICompatible(url: string, model: string, apiKey: string | undefined, messages: unknown) {
  if (!apiKey) return { ok: false as const };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model, temperature: 0, max_tokens: 200, messages })
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[harvest-movie-keywords] provider HTTP ${res.status} (${url})`);
      return { ok: false as const };
    }
    const data = await res.json();
    return { ok: true as const, text: data?.choices?.[0]?.message?.content };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[harvest-movie-keywords] provider call failed', err);
    return { ok: false as const };
  }
}

async function callGemini(apiKey: string | undefined, messages: { role: string; content: string }[]) {
  if (!apiKey) return { ok: false as const };
  const systemText = messages.find((m) => m.role === 'system')?.content || '';
  const userText = messages.find((m) => m.role === 'user')?.content || '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(GEMINI_URL(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${systemText}\n\n${userText}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 200 }
      })
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[harvest-movie-keywords] Gemini HTTP ${res.status}`);
      return { ok: false as const };
    }
    const data = await res.json();
    return { ok: true as const, text: data?.candidates?.[0]?.content?.parts?.[0]?.text };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[harvest-movie-keywords] Gemini call failed', err);
    return { ok: false as const };
  }
}

async function classifyMood(phrase: string, keywordNames: string[], genreNames: string[]) {
  const messages = buildMessages(phrase, keywordNames, genreNames);
  const diagnostics: { provider: string; outcome: string; rawPreview?: string }[] = [];

  const groq = await callOpenAICompatible(GROQ_URL, GROQ_MODEL, GROQ_API_KEY, messages);
  if (groq.ok) {
    const parsed = parseClassification(groq.text, keywordNames, genreNames);
    if (!isFailResult(parsed)) {
      return { ...parsed, provider: 'groq', diagnostics };
    }
    diagnostics.push({ provider: 'groq', outcome: parsed.failReason, rawPreview: (groq.text || '').slice(0, 200) });
  } else {
    diagnostics.push({ provider: 'groq', outcome: GROQ_API_KEY ? 'http_call_failed' : 'no_api_key' });
  }

  const cerebras = await callOpenAICompatible(CEREBRAS_URL, CEREBRAS_MODEL, CEREBRAS_API_KEY, messages);
  if (cerebras.ok) {
    const parsed = parseClassification(cerebras.text, keywordNames, genreNames);
    if (!isFailResult(parsed)) {
      return { ...parsed, provider: 'cerebras', diagnostics };
    }
    diagnostics.push({ provider: 'cerebras', outcome: parsed.failReason, rawPreview: (cerebras.text || '').slice(0, 200) });
  } else {
    diagnostics.push({ provider: 'cerebras', outcome: CEREBRAS_API_KEY ? 'http_call_failed' : 'no_api_key' });
  }

  const gemini = await callGemini(GEMINI_API_KEY, messages);
  if (gemini.ok) {
    const parsed = parseClassification(gemini.text, keywordNames, genreNames);
    if (!isFailResult(parsed)) {
      return { ...parsed, provider: 'gemini', diagnostics };
    }
    diagnostics.push({ provider: 'gemini', outcome: parsed.failReason, rawPreview: (gemini.text || '').slice(0, 200) });
  } else {
    diagnostics.push({ provider: 'gemini', outcome: GEMINI_API_KEY ? 'http_call_failed' : 'no_api_key' });
  }

  console.error(`[harvest-movie-keywords] no usable result for "${phrase}":`, JSON.stringify(diagnostics));
  return { failed: true as const, diagnostics };
}

// ---- Progress tracking ----
//
// Added 2026-07-31: movie_keyword_seed_progress existed but was never
// written to. Recounts movie_keyword_signatures fresh each run (cheap at
// this table size) rather than incrementing, so it can't drift from a
// partial/failed run or a manual edit.
async function updateProgress(batchNumber: number | null) {
  const { count, error: countErr } = await supabase
    .from('movie_keyword_signatures')
    .select('id', { count: 'exact', head: true });
  if (countErr) {
    console.error('[harvest-movie-keywords] progress count failed', countErr);
    return;
  }
  const { error: upsertErr } = await supabase
    .from('movie_keyword_seed_progress')
    .upsert(
      { id: 1, last_batch_number: batchNumber, total_seeded: count ?? 0, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
  if (upsertErr) {
    console.error('[harvest-movie-keywords] progress upsert failed', upsertErr);
  }
}

// ---- Bootstrap pass ----

async function runBootstrap(limit: number) {
  const [keywordNames, genreNames] = await Promise.all([getKeywordVocabNames(), Promise.resolve(GENRE_VOCAB_NAMES)]);

  let checked = 0;
  let seeded = 0;
  let skippedExisting = 0;
  let skippedLowConfidence = 0;
  let skippedNoSignal = 0;
  const noSignalDetails: { term: string; diagnostics: unknown }[] = [];

  for (const phrase of STARTER_MOOD_TERMS) {
    if (checked >= limit) break;
    checked++;
    const term = normalize(phrase);

    const { data: existing, error: fetchErr } = await supabase
      .from('movie_keyword_signatures')
      .select('normalized_term')
      .eq('normalized_term', term)
      .maybeSingle();

    if (fetchErr) {
      console.error(`[harvest-movie-keywords] existence check failed for "${phrase}"`, fetchErr);
      continue;
    }
    if (existing) {
      skippedExisting++;
      continue;
    }

    if (!GROQ_API_KEY && !CEREBRAS_API_KEY && !GEMINI_API_KEY) {
      break; // no provider available at all — stop rather than burn the whole list
    }

    const result = await classifyMood(phrase, keywordNames, genreNames);
    if ('failed' in result) {
      skippedNoSignal++;
      noSignalDetails.push({ term: phrase, diagnostics: result.diagnostics });
      await sleep(LLM_CALL_GAP_MS);
      continue;
    }
    if (result.confidence < WRITEBACK_THRESHOLD) {
      skippedLowConfidence++;
      await sleep(LLM_CALL_GAP_MS);
      continue;
    }

    // Column named tag_weights in the live schema even though it holds
    // keyword weights here — see header note, not a naming choice made in
    // this file.
    const { error: upsertErr } = await supabase.from('movie_keyword_signatures').upsert(
      {
        term: phrase,
        normalized_term: term,
        tag_weights: result.keywordWeights,
        genre_weights: result.genreWeights,
        batch_number: null,
        source: `movie_keyword_harvest_bootstrap:${result.provider}`
      },
      { onConflict: 'normalized_term' }
    );

    if (upsertErr) {
      console.error(`[harvest-movie-keywords] upsert failed for "${phrase}"`, upsertErr);
    } else {
      seeded++;
    }

    await sleep(LLM_CALL_GAP_MS);
  }

  await updateProgress(null);

  return {
    checked, seeded, skippedExisting, skippedLowConfidence, skippedNoSignal,
    totalStarterTerms: STARTER_MOOD_TERMS.length,
    // Capped to the first 10 so the response body doesn't balloon on a bad
    // run — enough to spot a pattern (e.g. every single one being
    // 'no_api_key' means a provider key isn't actually set) without
    // dumping 25 full diagnostic blocks into one HTTP response.
    noSignalDetails: noSignalDetails.slice(0, 10),
  };
}

// ---- Entry point ----

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }
  if (!HARVEST_SECRET || req.headers.get('x-harvest-secret') !== HARVEST_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: { mode?: string; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    // empty body -> default mode
  }
  const mode = body.mode || 'bootstrap';
  const limit = Number.isFinite(body.limit) && body.limit! > 0 ? body.limit! : DEFAULT_LIMIT;

  const results: Record<string, unknown> = {};

  try {
    if (mode === 'bootstrap' || mode === 'all') {
      results.bootstrap = await runBootstrap(limit);
    }

    return json({ results }, 200);
  } catch (err) {
    console.error('[harvest-movie-keywords] failed', err);
    return json({ error: 'Harvest failed', message: (err as Error)?.message ?? String(err), partialResults: results }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
