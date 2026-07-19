// ==========================================
// TROPE HARVESTER — Edge Function entry point
// supabase/functions/harvest-tropes/index.ts
// ==========================================
// POST /harvest-tropes   (header: x-harvest-secret: <HARVEST_SECRET>)
// { "mode": "bootstrap" }   (optional, default: bootstrap)
// -> { "results": { "bootstrap": { checked, seeded, skippedExisting, skippedLowConfidence }, "searchCacheScan": {...} } }
//
// Notion "Backend Update List" Entry 71/72 -- Component 2 of the two-part
// trope-signature system (Component 1 is search/parser/tropeSignature.js's
// query-time fallback, already wired into domains.js's runManga()). Same
// deploy-as-its-own-function reasoning as harvest-lexicons/index.ts: this
// does real LLM-call and write work, on a schedule, and must never share a
// request/timeout budget with live search traffic.
//
// STRUCTURE MODELED DIRECTLY ON harvest-lexicons/index.ts (same retry/
// backoff shape, same HARVEST_SECRET auth, same cron-via-Dashboard-or-
// GitHub-Actions scheduling note) -- see that file for the fuller
// rationale behind each of these patterns; not re-explained line by line
// here.
//
// WHY THE CLASSIFY/WRITE-BACK LOGIC IS DUPLICATED HERE, NOT IMPORTED FROM
// search/parser/tropeSignature.js: each Supabase Edge Function deploys as
// its own isolated bundle (see the `files` param this project's
// deploy_edge_function calls always pass explicitly) -- harvest-lexicons
// already established the convention of each harvester being fully
// self-contained rather than reaching across function boundaries. If this
// duplication drifts out of sync with tropeSignature.js's prompt/parsing
// logic over time, that's a real maintenance cost worth revisiting (e.g.
// via a shared Deno import from a common URL/path both functions pull
// from) -- flagged, not solved here, consistent with this file's other
// open items at the bottom.
//
// ============================================================
// KNOWN GAP, FOUND WHILE BUILDING THIS (verify-against-live-schema catch,
// same practice as Entry 55/56): Entry 59's original Component 2 design
// said this should "scan recent search_cache entries for 2-4 word phrases
// that produced zero lexicon coverage." Checked cache.js directly before
// writing this file -- search_cache stores `query_hash` (a SHA-256 digest
// of domain+normalized-query+filters), NOT the raw query text. There is
// currently NO live table anywhere in this project that stores what
// people actually typed. This means the search_cache-scanning half of
// Component 2, AS ORIGINALLY SCOPED, cannot be built against the current
// schema -- there is nothing to scan.
//
// NOT fixed here (a real design decision, not a quick patch):
//   (a) Add a new lightweight raw-query log table (e.g. `search_query_log`,
//       domain + raw query text + timestamp, no results/PII beyond the
//       query string itself) that the search function writes to
//       alongside search_cache -- needs repo owner sign-off given it's a
//       new persisted data category, not just an index/column addition.
//   (b) Skip the near-miss-scanning half entirely and rely on Component 1
//       (the live query-time fallback, already wired and already writing
//       back confident matches) as the sole organic-growth mechanism --
//       cheaper, no schema change, but slower to reach broad coverage
//       since it only ever sees phrases that happen to occur in a live
//       search.
// This file implements ONLY the bootstrap-seeding half below, which has
// no such dependency, and reports the scan half as not_implemented with
// this reason in its own response field rather than silently doing
// nothing.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
);

const HARVEST_SECRET = Deno.env.get('HARVEST_SECRET'); // reused from harvest-lexicons -- same secret gates both harvesters
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY');
const CEREBRAS_API_KEY = Deno.env.get('CEREBRAS_API_KEY');
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'llama3.1-8b';
// See tropeSignature.js's own note on this constant -- 'gemini-2.5-flash'
// was discontinued; kept in sync with that file's GEMINI_MODEL manually
// since this is a separate deployed bundle (see header duplication note).
const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_URL = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

const PROVIDER_TIMEOUT_MS = 3000;
const WRITEBACK_THRESHOLD = 0.75; // same bar as tropeSignature.js's query-time path
const LLM_CALL_GAP_MS = 500; // politeness gap between bootstrap classifications, same spirit as harvest-lexicons' DATAMUSE_REQUEST_GAP_MS

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(s: string) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// ---- Starter trope list (bootstrap seed) ----
//
// A deliberately small, high-confidence set of well-known, broadly-
// recognized story tropes -- not an attempt at the full 1000-term
// coverage Entry 69/70 originally aimed for by hand. This is the "cold
// start" set; everything past this grows organically via Component 1's
// live query-time write-back (per Entry 71's design) rather than being
// hand-curated further. Repo owner should feel free to extend this list
// directly -- it's plain data, no code change needed elsewhere to pick up
// additions.
const STARTER_TROPES = [
  'enemies to lovers', 'friends to lovers', 'slow burn', 'love triangle',
  'found family', 'coming of age', 'chosen one', 'revenge arc',
  'redemption arc', 'morally gray', 'tragic hero', 'anti hero',
  'happy ending', 'bittersweet ending', 'tragic ending', 'time loop',
  'isekai reincarnation', 'overpowered protagonist', 'underdog story',
  'rivals to lovers', 'childhood friends to lovers', 'fake dating',
  'arranged marriage', 'second chance romance', 'forbidden love',
  'star crossed lovers', 'unrequited love', 'love rectangle',
  'tournament arc', 'training arc', 'betrayal', 'hidden identity',
  'secret royalty', 'amnesia plot', 'body swap', 'parallel worlds',
  'apocalyptic survival', 'dystopian rebellion', 'coming out story',
  'found family found again', 'mentor and student', 'master and servant',
  'sibling rivalry', 'lost memories', 'reverse harem', 'harem',
  'slice of life healing', 'workplace romance', 'age gap romance',
  'villain protagonist', 'reformed villain', 'unlikely friendship',
  'road trip story', 'locked in together', 'only one bed',
  'grumpy sunshine pairing', 'love hate relationship', 'political intrigue',
  'coming home story', 'found found family', 'sports rivalry to respect',
  'talent vs hard work', 'legacy and inheritance'
];

// ---- Real tag/genre vocab (self-contained, no queryClassifier.js import) ----

async function getTagVocabNames(): Promise<string[]> {
  const { data, error } = await supabase
    .from('lexicon_entities')
    .select('name')
    .in('entity_type', ['tag', 'theme', 'demographic']);
  if (error) throw error;
  return (data || []).map((r: { name: string }) => r.name).filter(Boolean);
}

async function getGenreVocabNames(): Promise<string[]> {
  const { data, error } = await supabase
    .from('lexicon_entities')
    .select('name')
    .eq('entity_type', 'genre');
  if (error) throw error;
  return (data || []).map((r: { name: string }) => r.name).filter(Boolean);
}

// ---- Classification (condensed duplicate of tropeSignature.js -- see header) ----

function buildMessages(phrase: string, tagNames: string[], genreNames: string[]) {
  const tagList = tagNames.slice(0, 420).join(', ');
  const genreList = genreNames.slice(0, 40).join(', ');
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
        'CONCEPT itself, not examples of it. If a real adjacent tag exists ' +
        'even when no exact-name tag matches the trope, use the closest ' +
        'real adjacent tags rather than returning none.\n\n' +
        'Example: "slow burn" -> 9|Slow Burn:6,Romance Subplot:4,Drama:3' +
        '|Romance:6,Drama:3'
    },
    { role: 'user', content: phrase }
  ];
}

function parseClassification(rawContent: string, tagNames: string[], genreNames: string[]) {
  const trimmed = (rawContent || '').trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().replace(/[^a-z]/g, '') === 'none') return null;

  const parts = trimmed.split('|');
  if (parts.length < 3) return null;

  const confidence = parseInt(parts[0].replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(confidence)) return null;

  const tagVocabLower = new Map(tagNames.map((n) => [n.toLowerCase(), n]));
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

  const tagWeights = parseWeightedList(parts[1], tagVocabLower);
  const genreWeights = parseWeightedList(parts[2], genreVocabLower);
  if (Object.keys(tagWeights).length === 0 && Object.keys(genreWeights).length === 0) return null;

  return { confidence: Math.max(0, Math.min(10, confidence)) / 10, tagWeights, genreWeights };
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
      console.error(`[harvest-tropes] provider HTTP ${res.status} (${url})`);
      return { ok: false as const };
    }
    const data = await res.json();
    return { ok: true as const, text: data?.choices?.[0]?.message?.content };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[harvest-tropes] provider call failed', err);
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
      console.error(`[harvest-tropes] Gemini HTTP ${res.status}`);
      return { ok: false as const };
    }
    const data = await res.json();
    return { ok: true as const, text: data?.candidates?.[0]?.content?.parts?.[0]?.text };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[harvest-tropes] Gemini call failed', err);
    return { ok: false as const };
  }
}

async function classifyTrope(phrase: string, tagNames: string[], genreNames: string[]) {
  const messages = buildMessages(phrase, tagNames, genreNames);

  const groq = await callOpenAICompatible(GROQ_URL, GROQ_MODEL, GROQ_API_KEY, messages);
  if (groq.ok) {
    const parsed = parseClassification(groq.text, tagNames, genreNames);
    return parsed ? { ...parsed, provider: 'groq' } : null;
  }

  const cerebras = await callOpenAICompatible(CEREBRAS_URL, CEREBRAS_MODEL, CEREBRAS_API_KEY, messages);
  if (cerebras.ok) {
    const parsed = parseClassification(cerebras.text, tagNames, genreNames);
    return parsed ? { ...parsed, provider: 'cerebras' } : null;
  }

  const gemini = await callGemini(GEMINI_API_KEY, messages);
  if (gemini.ok) {
    const parsed = parseClassification(gemini.text, tagNames, genreNames);
    return parsed ? { ...parsed, provider: 'gemini' } : null;
  }

  return null;
}

// ---- Bootstrap pass ----

async function runBootstrap() {
  const [tagNames, genreNames] = await Promise.all([getTagVocabNames(), getGenreVocabNames()]);

  let checked = 0;
  let seeded = 0;
  let skippedExisting = 0;
  let skippedLowConfidence = 0;
  let skippedNoSignal = 0;

  for (const phrase of STARTER_TROPES) {
    checked++;
    const term = normalize(phrase);

    const { data: existing, error: fetchErr } = await supabase
      .from('trope_signatures')
      .select('normalized_term')
      .eq('normalized_term', term)
      .maybeSingle();

    if (fetchErr) {
      console.error(`[harvest-tropes] existence check failed for "${phrase}"`, fetchErr);
      continue;
    }
    if (existing) {
      skippedExisting++;
      continue;
    }

    if (!GROQ_API_KEY && !CEREBRAS_API_KEY && !GEMINI_API_KEY) {
      // No provider available at all -- stop the whole pass rather than
      // burn through the list producing skippedNoSignal for every term.
      break;
    }

    const result = await classifyTrope(phrase, tagNames, genreNames);
    if (!result) {
      skippedNoSignal++;
      await sleep(LLM_CALL_GAP_MS);
      continue;
    }
    if (result.confidence < WRITEBACK_THRESHOLD) {
      skippedLowConfidence++;
      await sleep(LLM_CALL_GAP_MS);
      continue;
    }

    const { error: upsertErr } = await supabase.from('trope_signatures').upsert(
      {
        term: phrase,
        normalized_term: term,
        tag_weights: result.tagWeights,
        genre_weights: result.genreWeights,
        batch_number: null,
        source: `trope_harvest_bootstrap:${result.provider}`
      },
      { onConflict: 'normalized_term' }
    );

    if (upsertErr) {
      console.error(`[harvest-tropes] upsert failed for "${phrase}"`, upsertErr);
    } else {
      seeded++;
    }

    await sleep(LLM_CALL_GAP_MS);
  }

  return { checked, seeded, skippedExisting, skippedLowConfidence, skippedNoSignal };
}

// ---- Entry point ----

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }
  if (!HARVEST_SECRET || req.headers.get('x-harvest-secret') !== HARVEST_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: { mode?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body -> default mode
  }
  const mode = body.mode || 'bootstrap';

  const results: Record<string, unknown> = {};

  try {
    if (mode === 'bootstrap' || mode === 'all') {
      results.bootstrap = await runBootstrap();
    }

    // See the KNOWN GAP note at the top of this file -- there is currently
    // no raw-query data to scan. Reported explicitly rather than silently
    // omitted, so a caller checking this function's response can tell the
    // difference between "ran and found nothing" and "can't run yet."
    results.searchCacheScan = {
      status: 'not_implemented',
      reason:
        'search_cache stores only a SHA-256 query_hash, not raw query ' +
        'text (confirmed against cache.js) -- nothing to scan against ' +
        'yet. Needs either a new raw-query log table or a decision to ' +
        'rely solely on the live query-time fallback (tropeSignature.js) ' +
        'for organic growth instead. See this file\'s header comment.'
    };

    return json({ results }, 200);
  } catch (err) {
    console.error('[harvest-tropes] failed', err);
    return json({ error: 'Harvest failed', message: (err as Error)?.message ?? String(err), partialResults: results }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
