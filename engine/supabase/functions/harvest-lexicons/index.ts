// ==========================================
// LEXICON HARVESTER — Edge Function entry point
// supabase/functions/harvest-lexicons/index.ts
// ==========================================
// POST /harvest-lexicons   (header: x-harvest-secret: <HARVEST_SECRET>)
// { "entityTypes": ["genre","tag","staff","character","studio","media","synonym"] }  (optional, default: all)
// -> { "results": { "genre": { loaded: n }, "staff": { loaded: n, maxId: n }, ..., "synonym": { loaded: n, seeds: n } } }
//
// NOT part of the live /search request path — same reasoning the old
// engine used to drop shikimoriClient.js (README section 4): this is an
// offline dictionary-harvester, run on a schedule, not per-request. Deploy
// it as its own function so a slow/stuck harvest run can never affect
// search latency:
//   supabase functions deploy harvest-lexicons
//
// SCHEDULING: Supabase has no built-in cron for Edge Functions, so trigger
// this via either (a) the Cron Triggers panel in the Supabase Dashboard
// (Edge Functions -> harvest-lexicons -> Cron), or (b) pg_cron + pg_net
// calling this URL with the secret header, e.g. weekly. Either way, this
// function must stay idempotent and cheap to re-run — it already is, via
// the ID_DESC delta strategy below (and, for synonyms, via idempotent
// upserts on (word, synonym) — see harvestSynonyms()).
//
// STRATEGY (per the harvest plan):
// - genre/tag/theme/demographic: small (~500 rows combined), refetched and
//   upserted in full every run — cheaper than tracking deltas for something
//   this size.
// - staff/character/studio/media: large, paginated, sorted ID_DESC. Each
//   run reads lexicon_sync_state.last_max_id, walks pages until it hits an
//   id <= that value, and stops — only new rows since the last run are
//   fetched. media is scoped to type: MANGA only (this engine's one live
//   niche so far, see domains.js) to keep it well under the ~35MB Gemini
//   estimated for the full anime+manga set.
// - synonym: reads the genre/tag/theme/demographic words already sitting in
//   lexicon_entities (populated by the static-entity step above — no fresh
//   AniList calls needed) and, for each, asks Datamuse's free ml= (means-
//   like) endpoint for up to 8 related words. Upserted into
//   lexicon_synonyms as (word, synonym, score) rows — see
//   0003_synonyms.sql. This is what synonyms.js now queries at request
//   time instead of importing a static SYNONYM_MAP from dictionary.js.
//
// CHECKPOINTING: Supabase's Free-plan Edge Functions have a 150s request
// idle timeout — a run against a large, never-before-synced entity type
// (characters, media) can easily get killed mid-pagination before this
// function ever reaches its own "return" statement. setSyncState() is
// therefore called after EVERY page, not just once at the end of the
// while loop. Rows are already upserted per-page, so without this, a
// timed-out run would keep its fetched rows but lose the resume point,
// forcing the next run to re-walk pages it already paid for in nothing
// but wasted quota/time. With per-page checkpointing, every run — even
// one that gets killed by the platform mid-flight — makes permanent
// forward progress. The synonym step doesn't paginate (~450 seed words,
// comfortably inside one run) so it doesn't need this, but it does log
// progress per seed so a killed run's partial upserts are still visible
// in partialResults.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
);

const HARVEST_SECRET = Deno.env.get('HARVEST_SECRET'); // required — this function does real write work and burns AniList/Datamuse quota
const ANILIST_API_URL = 'https://graphql.anilist.co';
const DATAMUSE_API_URL = 'https://api.datamuse.com/words';

// AniList allows 90 req/min. 750ms between calls keeps us comfortably
// under that even with the extra static-fetch calls in the same run.
const REQUEST_GAP_MS = 750;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_RUN = 200; // hard ceiling (10k rows/entity/run) so a bad sync-state value can't spin forever

// Datamuse: 100k requests/day, no key, no documented per-second limit, but
// stay polite and predictable — same gap as AniList rather than hammering
// it as fast as possible. ~450 seed words * 750ms is well under a minute.
const DATAMUSE_REQUEST_GAP_MS = 750;
const DATAMUSE_MAX_RESULTS = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry config: AniList 502/503/504 are transient upstream blips (their
// server, not ours — confirmed 2026-07-13 when a 504 hit right at the
// start of `staff` pagination after genre/tag/theme/demographic had
// already succeeded). Retry a couple times with exponential backoff
// before giving up, so a single blip doesn't fail the whole harvest run.
//
// 429 added 2026-07-13 after a second failure (run #5) that completed
// in only 21s — too fast to be the known 150s idle-timeout non-issue.
// Likely cause: AniList's 90 req/min rate limit tripped by running the
// harvest workflow repeatedly in a short window. 429 needs a longer
// backoff than 502/503/504 since rate-limit windows take longer to
// clear than a server hiccup — starts at 5s instead of 1s.
//
// FIXED 2026-07-13: this file previously had TWO anilistQuery()
// declarations back to back — an editor artifact from an earlier patch.
// Because JS/TS uses last-declaration-wins for duplicate function names in
// the same scope, the second (older, pre-429) version was silently the one
// actually running, so 429s were retried with the wrong (short) backoff.
// Collapsed back down to one definition here.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000; // 1s, then 2s — used for 502/503/504
const RATE_LIMIT_BASE_DELAY_MS = 5000; // 5s, then 10s — used for 429

async function anilistQuery(query, variables = {}, attempt = 0) {
  const res = await fetch(ANILIST_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      const isRateLimit = res.status === 429;
      const baseDelay = isRateLimit ? RATE_LIMIT_BASE_DELAY_MS : RETRY_BASE_DELAY_MS;
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`AniList HTTP ${res.status} — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return anilistQuery(query, variables, attempt + 1);
    }
    throw new Error(`AniList HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.errors) throw new Error(`AniList GraphQL error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

/**
 * Datamuse ml=<word> (means-like) query. Same retryable-status set as
 * AniList for consistency, though Datamuse rate limiting is undocumented —
 * treating 429/502/503/504 the same way is a safe default either way.
 */
async function datamuseQuery(word, attempt = 0) {
  const url = `${DATAMUSE_API_URL}?ml=${encodeURIComponent(word)}&max=${DATAMUSE_MAX_RESULTS}`;
  const res = await fetch(url);

  if (!res.ok) {
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      const isRateLimit = res.status === 429;
      const baseDelay = isRateLimit ? RATE_LIMIT_BASE_DELAY_MS : RETRY_BASE_DELAY_MS;
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`Datamuse HTTP ${res.status} for "${word}" — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return datamuseQuery(word, attempt + 1);
    }
    throw new Error(`Datamuse HTTP ${res.status} for "${word}"`);
  }

  // Datamuse returns [{ word: "depressed", score: 123456 }, ...]
  return res.json();
}

// ---- Static entities: genres + tags/themes/demographics ----

async function harvestStatic() {
  const query = `
    query {
      GenreCollection
      MediaTagCollection { id name category description }
    }
  `;
  const data = await anilistQuery(query);

  const genreRows = (data.GenreCollection || []).map((name) => ({
    entity_type: 'genre',
    source_id: name.toLowerCase(),
    name,
    metadata: {},
    updated_at: new Date().toISOString()
  }));

  const tagRows = [];
  for (const tag of data.MediaTagCollection || []) {
    // AniList nests Theme/Demographic as tag categories rather than
    // separate collections — split them out into their own entity_types
    // here so downstream lookups (e.g. GENRE_VOCAB/TITLE_VOCAB style
    // consumers) don't have to know AniList's internal category scheme.
    const entityType =
      tag.category === 'Theme' ? 'theme' :
      tag.category === 'Demographic' ? 'demographic' :
      'tag';

    tagRows.push({
      entity_type: entityType,
      source_id: String(tag.id),
      name: tag.name,
      metadata: { category: tag.category, description: tag.description ?? null },
      updated_at: new Date().toISOString()
    });
  }

  const rows = [...genreRows, ...tagRows];
  if (rows.length > 0) {
    const { error } = await supabase.from('lexicon_entities').upsert(rows, { onConflict: 'entity_type,source_id' });
    if (error) throw error;
  }

  return {
    genre: { loaded: genreRows.length },
    tag: { loaded: tagRows.filter((r) => r.entity_type === 'tag').length },
    theme: { loaded: tagRows.filter((r) => r.entity_type === 'theme').length },
    demographic: { loaded: tagRows.filter((r) => r.entity_type === 'demographic').length }
  };
}

// ---- Synonyms: Datamuse ml= expansion of existing genre/tag/theme/demographic words ----

/**
 * Pulls distinct, already-harvested genre/tag/theme/demographic names out
 * of lexicon_entities — these become the CONCEPTS we query Datamuse with.
 * Deliberately reuses data already in the DB rather than hand-picking a
 * seed list, so this stays current automatically as AniList's genre/tag
 * set changes and needs zero maintenance.
 */
async function getSynonymConcepts() {
  const { data, error } = await supabase
    .from('lexicon_entities')
    .select('name')
    .in('entity_type', ['genre', 'tag', 'theme', 'demographic']);
  if (error) throw error;

  const concepts = new Set();
  for (const row of data || []) {
    if (row.name) concepts.add(String(row.name).toLowerCase());
  }
  return [...concepts];
}

/**
 * For each concept (an AniList genre/tag/theme/demographic name), asks
 * Datamuse ml=<concept> for up to DATAMUSE_MAX_RESULTS related words and
 * upserts them into lexicon_synonyms — INVERTED, as (alias, concept, score)
 * rows, not (concept, alias). Datamuse naturally returns concept -> [alias,
 * alias, ...]; SYNONYM_MAP's original shape (and what synonyms.js needs for
 * a request-time lookup by the word a user actually typed) is alias ->
 * concept, so each Datamuse result becomes its own row with the concept we
 * queried attached, not the other way around. See 0003_synonyms.sql for
 * the same note on the table itself.
 *
 * Idempotent — safe to re-run; a re-run just refreshes scores and adds any
 * new aliases Datamuse now returns for a concept.
 *
 * Not paginated/checkpointed like harvestPaginated() — ~450 concepts at
 * DATAMUSE_REQUEST_GAP_MS apart is well within one run, so per-concept
 * checkpointing isn't needed. If the concept list grows enough that this
 * stops being true, revisit with the same per-page checkpoint pattern
 * used for staff/character/studio/media.
 */
async function harvestSynonyms() {
  const concepts = await getSynonymConcepts();
  let loaded = 0;
  let conceptsProcessed = 0;

  for (const concept of concepts) {
    let results;
    try {
      results = await datamuseQuery(concept);
    } catch (err) {
      // One bad concept shouldn't kill the whole synonym harvest — log
      // and move on, same "don't let one blip fail everything"
      // philosophy as anilistQuery's retry wrapper, just one level up
      // (skip vs retry).
      console.error(`[harvest-lexicons] datamuse lookup failed for "${concept}"`, err);
      await sleep(DATAMUSE_REQUEST_GAP_MS);
      continue;
    }

    const rows = (results || [])
      .filter((r) => r.word && r.word.toLowerCase() !== concept) // skip self-matches
      .map((r) => ({
        alias: String(r.word).toLowerCase(),
        concept,
        score: typeof r.score === 'number' ? r.score : 0,
        updated_at: new Date().toISOString()
      }));

    if (rows.length > 0) {
      const { error } = await supabase
        .from('lexicon_synonyms')
        .upsert(rows, { onConflict: 'alias,concept' });
      if (error) throw error;
      loaded += rows.length;
    }

    conceptsProcessed++;
    await sleep(DATAMUSE_REQUEST_GAP_MS);
  }

  return { loaded, concepts: conceptsProcessed };
}

// ---- Paginated entities: staff, characters, studios, media(manga) ----

const PAGE_QUERIES = {
  staff: {
    field: 'staff(sort: ID_DESC)',
    extract: (item) => ({ id: item.id, name: item.name?.full }),
    selection: '{ id name { full } }'
  },
  character: {
    field: 'characters(sort: ID_DESC)',
    extract: (item) => ({ id: item.id, name: item.name?.full }),
    selection: '{ id name { full } }'
  },
  studio: {
    field: 'studios(sort: ID_DESC)',
    extract: (item) => ({ id: item.id, name: item.name }),
    selection: '{ id name }'
  },
  media: {
    // MANGA only — this engine's one live niche (see domains.js). Expand
    // to ANIME if/when an anime niche is added.
    field: 'media(sort: ID_DESC, type: MANGA)',
    extract: (item) => ({
      id: item.id,
      name: item.title?.english || item.title?.romaji,
      metadata: { romaji: item.title?.romaji ?? null, native: item.title?.native ?? null }
    }),
    selection: '{ id title { romaji english native } }'
  }
};

async function getSyncState(entityType) {
  const { data, error } = await supabase
    .from('lexicon_sync_state')
    .select('last_max_id')
    .eq('entity_type', entityType)
    .maybeSingle();
  if (error) throw error;
  return data?.last_max_id ?? 0;
}

async function setSyncState(entityType, maxId) {
  const { error } = await supabase
    .from('lexicon_sync_state')
    .upsert(
      { entity_type: entityType, last_max_id: maxId, last_synced_at: new Date().toISOString() },
      { onConflict: 'entity_type' }
    );
  if (error) throw error;
}

async function harvestPaginated(entityType) {
  const cfg = PAGE_QUERIES[entityType];
  if (!cfg) throw new Error(`Unknown paginated entity type "${entityType}"`);

  const lastMaxId = await getSyncState(entityType);
  let newMaxId = lastMaxId;
  let loaded = 0;
  let page = 1;
  let caughtUp = false;

  const query = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage }
        ${cfg.field} ${cfg.selection}
      }
    }
  `;

  while (!caughtUp && page <= MAX_PAGES_PER_RUN) {
    const data = await anilistQuery(query, { page, perPage: PAGE_SIZE });
    const items = data.Page[entityType === 'media' ? 'media' : entityType] || [];

    const rows = [];
    for (const item of items) {
      if (item.id <= lastMaxId) {
        // ID_DESC means everything from here on is stuff we already have —
        // stop the loop entirely, don't just skip this row.
        caughtUp = true;
        break;
      }
      const extracted = cfg.extract(item);
      if (!extracted.name) continue; // skip entries AniList has with no usable name
      rows.push({
        entity_type: entityType,
        source_id: String(extracted.id),
        name: extracted.name,
        metadata: extracted.metadata ?? {},
        updated_at: new Date().toISOString()
      });
      if (extracted.id > newMaxId) newMaxId = extracted.id;
    }

    if (rows.length > 0) {
      const { error } = await supabase.from('lexicon_entities').upsert(rows, { onConflict: 'entity_type,source_id' });
      if (error) throw error;
      loaded += rows.length;
    }

    // Checkpoint after every page (not just once at the end) — see the
    // CHECKPOINTING note at the top of this file. This upsert is cheap
    // (single row, primary key on entity_type) so doing it PAGE_SIZE-often
    // instead of once-per-run is not a meaningful cost, and it's what
    // makes a mid-run 150s timeout non-wasteful.
    if (newMaxId > lastMaxId) await setSyncState(entityType, newMaxId);

    if (!data.Page.pageInfo?.hasNextPage) break;
    page++;
    await sleep(REQUEST_GAP_MS);
  }

  return { loaded, maxId: newMaxId, pagesFetched: page };
}

// ---- Entry point ----

const ALL_ENTITY_TYPES = ['genre', 'tag', 'staff', 'character', 'studio', 'media', 'synonym'];

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  if (!HARVEST_SECRET || req.headers.get('x-harvest-secret') !== HARVEST_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — defaults to harvesting everything
  }

  const requested = Array.isArray(body.entityTypes) && body.entityTypes.length > 0
    ? body.entityTypes
    : ALL_ENTITY_TYPES;

  const results = {};

  try {
    if (requested.includes('genre') || requested.includes('tag')) {
      Object.assign(results, await harvestStatic());
      await sleep(REQUEST_GAP_MS);
    }

    for (const entityType of ['staff', 'character', 'studio', 'media']) {
      if (!requested.includes(entityType)) continue;
      results[entityType] = await harvestPaginated(entityType);
      await sleep(REQUEST_GAP_MS);
    }

    // Runs last, deliberately: depends on genre/tag/theme/demographic rows
    // already being in lexicon_entities, which either came from this same
    // run's harvestStatic() call above, or a prior run.
    if (requested.includes('synonym')) {
      results.synonym = await harvestSynonyms();
    }

    return json({ results }, 200);
  } catch (err) {
    // FIXED 2026-07-13: previously returned only a generic "Harvest
    // failed" string, swallowing the real error and forcing guesswork on
    // every failure (see the 429 investigation in the project log). Now
    // surfaces err.message alongside partialResults.
    console.error('[harvest-lexicons] failed', err);
    return json({ error: 'Harvest failed', message: err?.message ?? String(err), partialResults: results }, 500);
  }
});

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
