// ==========================================
// TROPE HARVESTER — Edge Function entry point
// supabase/functions/harvest-tropes/index.ts
// ==========================================
// POST /harvest-tropes   (header: x-harvest-secret: <HARVEST_SECRET>)
// { "mode": "bootstrap" | "reclassify_thin" | "all", "limit": 25 }
// -> { "results": { "bootstrap": {...}, "reclassifyThin": {...}, "searchCacheScan": {...} } }
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
// KNOWN GAP (unchanged from v4): search_cache stores only a SHA-256
// query_hash, not raw query text -- the near-miss-scanning half of
// Component 2 still can't be built against the current schema. See
// searchCacheScan's response field below.
// ============================================================
//
// ============================================================
// ADDED 2026-07-20 (Entry 74) -- "reclassify_thin" mode.
// Found while investigating still-weak trope search results: the 300
// rows manually seeded in batches 1-2 (source 'ai_generated_by_claude_
// directly') were written directly to trope_signatures by a past session,
// OUTSIDE this project's actual constrained-vocabulary classifier --
// averaging 0.81 tags/row, with 92% of rows having at most ONE tag (many
// have zero, relying on 1-2 broad genre weights alone). Because
// getTropeSignatureFallback() in tropeSignature.js treats any EXISTING
// trope_signatures row as final and never re-classifies it, these thin
// legacy rows permanently block the real LLM pipeline from ever
// improving them, no matter how many times the term gets searched live.
//
// This mode finds rows below a tag-count threshold and re-runs them
// through the same classifyTrope() pipeline as bootstrap, OVERWRITING
// (not skipping) if a richer result comes back -- the one place in this
// file that intentionally clobbers an existing row, which is why it's a
// separate opt-in mode rather than folded into runBootstrap()'s
// skip-if-existing behavior.
//
// Processes at most `limit` rows per invocation (default 25, same
// "small enough to not risk the timeout ceiling harvest-lexicons has
// already hit at 44-88s on heavier runs" reasoning) rather than trying
// to fix all 275 thin rows in one call -- run it repeatedly (e.g. on the
// same 6-hour cron as harvest-lexicons, or manually) until
// reclassifyThin's `remaining` count reaches 0.
// ============================================================
//
// ============================================================
// FIXED 2026-07-20 (Entry 83/84) -- two real bugs found via manual audit,
// not theoretical:
//
// BUG 1 -- this mode was overwriting ALREADY-CURATED rows, not just the
// legacy 'ai_generated_by_claude_directly' batch it was originally built
// for. A new source, 'manual_seed_v3' (Entry 78-82), does the same kind
// of manual seeding but WITH real-vocab verification per term -- these
// rows are frequently intentionally thin (1 tag, or 0 with genre-only)
// because no honest real-tag match exists, not because they were
// carelessly written. THIN_TAG_THRESHOLD-based candidate selection had no
// source exclusion at all, so it kept re-rolling and overwriting these
// verified rows right alongside the genuinely-bad legacy ones. Fixed:
// candidate query now excludes any source starting with 'manual_seed'
// (matches manual_seed_v3 and any future manual_seed_v4+ line) --
// curated rows are left alone entirely, on the reasoning that a human/
// Claude verifying a term against the live vocab before writing it is a
// stronger signal than an unsupervised re-roll.
//
// BUG 2 (the actual root cause of the visible damage) -- buildMessages()
// below REQUIRED "3-6 tags" on every single classification, with an
// explicit instruction to "use the closest real adjacent tags rather
// than returning none" when no exact match exists. That's a forced-
// padding instruction: it tells the model to invent plausible-but-wrong
// tags any time fewer than 3 genuinely fit, rather than allowing an
// honest 1-2-tag (or tag-less, genre-only) result. Confirmed concretely:
// "amnesia reset" had one precise tag (Amnesia:9) from manual seeding,
// got reclassified under this prompt, and came back with three vaguer
// tags (Reincarnation, Alternate Universe, Memory Manipulation) that
// dropped Amnesia entirely -- isImprovement() then counted 3 > 1 and
// overwrote it, net effect: a worse, padded result replacing a correct
// one. Fixed: prompt now allows 1-6 tags and explicitly instructs the
// model to prefer fewer precise tags over padding, matching the honesty-
// over-completeness standard this project has been holding itself to in
// manual seeding since Entry 78 (see the "do NOT force a tag" reasoning
// there). Also fixed isImprovement() itself so a new result that DROPS
// an old high-weight (>=7) tag no longer counts as an improvement purely
// by having a higher total tag count -- tag count was never a real
// quality proxy on its own, just a convenient one.
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
const LLM_CALL_GAP_MS = 500; // politeness gap between classifications, same spirit as harvest-lexicons' DATAMUSE_REQUEST_GAP_MS
const DEFAULT_RECLASSIFY_LIMIT = 25; // rows per invocation -- see header note on timeout risk
const THIN_TAG_THRESHOLD = 1; // a row with <= this many tags is "thin" and eligible for reclassification
// Source prefixes that are exempt from reclassify_thin's candidate scan --
// see Entry 83/84 header note. Any source string starting with one of
// these is treated as already-curated and left alone, even if thin.
const CURATED_SOURCE_PREFIXES = ['manual_seed'];
// Minimum weight for a tag to count as "high-confidence" for the
// no-regression check in isImprovement() -- see Entry 83/84.
const HIGH_CONFIDENCE_TAG_WEIGHT = 7;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(s: string) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function isCuratedSource(source: string | null | undefined) {
  const s = (source || '').toLowerCase();
  return CURATED_SOURCE_PREFIXES.some((prefix) => s.startsWith(prefix));
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
//
// Entry 83/84: prompt rewritten to stop forcing a 3-6 tag minimum. The
// old wording ("3-6 tags", "use the closest real adjacent tags rather
// than returning none") actively rewarded padding -- an honest 1-tag
// match would never satisfy the model's own instructions, so it always
// invented extra adjacent tags to comply, sometimes at the cost of the
// one tag that was actually correct. This version explicitly tells the
// model that fewer, precise tags beat more, vague ones, and that 1 tag
// is a fully valid answer.
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
        'else: a confidence integer 0-10, then "|", then 1-6 tags chosen ' +
        'ONLY from this exact list (comma-separated, each as tag:weight, ' +
        'weight 1-10): ' + tagList + '\n' +
        'then "|", then 1-3 genres chosen ONLY from this exact list ' +
        '(same tag:weight format): ' + genreList + '\n\n' +
        'IMPORTANT -- precision over quantity: only include a tag if it ' +
        'is a genuinely close match for the trope\'s actual meaning. A ' +
        'single precise tag is a complete, correct answer -- do NOT pad ' +
        'the list with weaker or tangentially-related tags just to reach ' +
        'a higher count. Including a vague or wrong tag to seem more ' +
        'thorough is a worse answer than including only the one tag that ' +
        'truly fits. It is normal and expected for many valid tropes to ' +
        'have only 1 or 2 real tag matches, or genre weights only with no ' +
        'tags at all if nothing in the list is a genuine match -- in that ' +
        'case, still classify the trope (do not reply none just because ' +
        'the tag list has no exact fit) but leave the tag section as few ' +
        'entries as honestly justified, even zero.\n\n' +
        'Do not invent tags or genres outside these two lists. Do not name ' +
        'any manga/anime titles anywhere in your answer -- score the ' +
        'CONCEPT itself, not examples of it.\n\n' +
        'Example of a good precise answer: "slow burn" -> ' +
        '8|Unrequited Love:3|Romance:8,Drama:3 -- note this uses only ONE ' +
        'tag because only one genuinely fits, rather than padding to ' +
        'reach a higher count.'
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

// ---- Reclassify-thin pass (Entry 74; fixed Entry 83/84) ----
//
// Finds rows with <= THIN_TAG_THRESHOLD tags, EXCLUDING any row whose
// source marks it as already-curated (see CURATED_SOURCE_PREFIXES and the
// Entry 83/84 header note -- manual_seed_v3 rows are frequently
// intentionally thin because no honest tag match exists, not because
// they're low-quality, and re-rolling them was silently overwriting
// verified data). Re-classifies each remaining candidate via the real
// pipeline, and OVERWRITES only if the new result is a genuine
// improvement -- see isImprovement() below for the updated (Entry 83/84)
// definition, which no longer treats "more tags" alone as sufficient.
async function runReclassifyThin(limit: number) {
  const [tagNames, genreNames] = await Promise.all([getTagVocabNames(), getGenreVocabNames()]);

  // jsonb_object_keys(...) count done client-side after fetch rather than
  // in the WHERE clause -- keeps this readable without leaning on a
  // Postgres-specific expression index that doesn't exist yet on
  // tag_weights's key count.
  const { data: candidates, error: fetchErr } = await supabase
    .from('trope_signatures')
    .select('term, normalized_term, tag_weights, genre_weights, source')
    .order('term', { ascending: true });

  if (fetchErr) throw fetchErr;

  const thin = (candidates || []).filter(
    (row: { tag_weights: Record<string, number> | null; source: string | null }) =>
      !isCuratedSource(row.source) &&
      Object.keys(row.tag_weights || {}).length <= THIN_TAG_THRESHOLD
  );

  const totalThin = thin.length;
  const batch = thin.slice(0, limit);

  let reclassified = 0;
  let improved = 0;
  let noImprovement = 0;
  let noSignal = 0;

  for (const row of batch) {
    if (!GROQ_API_KEY && !CEREBRAS_API_KEY && !GEMINI_API_KEY) break;

    const result = await classifyTrope(row.term, tagNames, genreNames);
    reclassified++;

    if (!result || result.confidence < WRITEBACK_THRESHOLD) {
      noSignal++;
      await sleep(LLM_CALL_GAP_MS);
      continue;
    }

    if (!isImprovement(row.tag_weights, row.genre_weights, result.tagWeights, result.genreWeights)) {
      noImprovement++;
      await sleep(LLM_CALL_GAP_MS);
      continue;
    }

    const { error: upsertErr } = await supabase
      .from('trope_signatures')
      .update({
        tag_weights: result.tagWeights,
        genre_weights: result.genreWeights,
        source: `trope_harvest_reclassify:${result.provider}`
      })
      .eq('normalized_term', row.normalized_term);

    if (upsertErr) {
      console.error(`[harvest-tropes] reclassify update failed for "${row.term}"`, upsertErr);
    } else {
      improved++;
    }

    await sleep(LLM_CALL_GAP_MS);
  }

  return {
    totalThinRows: totalThin,
    processedThisRun: batch.length,
    remaining: Math.max(0, totalThin - batch.length),
    reclassified,
    improved,
    noImprovement,
    noSignal
  };
}

// Entry 83/84: "improvement" used to mean strictly-more tags (or equal
// tags with more genres) -- a pure count comparison with no check on
// whether the new result actually kept what the old one got right. That
// let a reclassification DROP a high-confidence, precise tag in exchange
// for more numerous but vaguer ones and still count as "better" purely
// on count. Fixed definition: still requires more tags (or equal tags +
// more genres) as before, but now ALSO requires that any old tag with
// weight >= HIGH_CONFIDENCE_TAG_WEIGHT survives into the new tag set --
// if the new classification would silently drop a tag the old one was
// highly confident about, that's treated as a regression, not an
// improvement, no matter how many other tags it adds.
function isImprovement(
  oldTagWeights: Record<string, number> | null,
  oldGenreWeights: Record<string, number> | null,
  newTagWeights: Record<string, number>,
  newGenreWeights: Record<string, number>
) {
  const oldTags = oldTagWeights || {};
  const oldGenres = oldGenreWeights || {};
  const oldTagCount = Object.keys(oldTags).length;
  const oldGenreCount = Object.keys(oldGenres).length;
  const newTagCount = Object.keys(newTagWeights).length;
  const newGenreCount = Object.keys(newGenreWeights).length;

  const moreOverall = newTagCount > oldTagCount || (newTagCount === oldTagCount && newGenreCount > oldGenreCount);
  if (!moreOverall) return false;

  const droppedHighConfidenceTag = Object.entries(oldTags).some(
    ([tagName, weight]) => weight >= HIGH_CONFIDENCE_TAG_WEIGHT && !(tagName in newTagWeights)
  );
  if (droppedHighConfidenceTag) return false;

  return true;
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
  const limit = Number.isFinite(body.limit) && body.limit! > 0 ? body.limit! : DEFAULT_RECLASSIFY_LIMIT;

  const results: Record<string, unknown> = {};

  try {
    if (mode === 'bootstrap' || mode === 'all') {
      results.bootstrap = await runBootstrap();
    }

    if (mode === 'reclassify_thin' || mode === 'all') {
      results.reclassifyThin = await runReclassifyThin(limit);
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
