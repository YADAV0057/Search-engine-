// ==========================================
// SEARCH — Edge Function entry point
// supabase/functions/search/index.ts
// ==========================================
// POST /search
// { "domain": "manga", "query": "...", "filters": {...} }
// -> { results: [...], cached: boolean, source?: string, mood?: {...}, page?: number, hasMore?: boolean, routing?: {...}, classification?: {...} }
//
// RESTORED 2026-07-14 after this file went missing from the repo and the
// live Supabase deploy was accidentally overwritten with the
// harvest-lexicons/index.ts content, which wiped the whole function
// bundle (cache.js/cors.js/domains.js/adapters/parser were dropped from
// the LIVE deploy at that point too, though they stayed safe in GitHub
// the whole time). Rebuilt here to match cache.js/cors.js/domains.js's
// real exports exactly, and to match the documented, confirmed-live
// v20-era behavior from the project's Notion "AI Context Log" (§0-NEW6):
// pass `supabase` into the domain handler so mood scoring actually runs,
// and include `mood` in the JSON response.
//
// UPDATED 2026-07-14 (Notion "wiring search engine" Entry 18): domains.js
// now resolves page/limit from filters and returns `page`/`hasMore`
// alongside `source`/`results`/`mood`. Both response branches below now
// surface `hasMore` so the frontend doesn't have to guess.
//
// UPDATED 2026-07-17 (Notion "Backend Update List" — aiPanel.js gap #1/#2,
// Entry 25): domains.js's runManga() now also returns `routing`
// (boostGenres/excludeGenres the mood signal produced) and `classification`
// (the query classifier's ranked categories + matched genre/tag terms).
// Both were already being computed internally for ranking — this just also
// returns them, so aiPanel.js's "Detected X" / "Avoiding X" reasoning lines
// have real data to render instead of none. Live-fetch branch only (see
// cache note below for why the cache-hit branch doesn't get these too).
//
// Cache hits intentionally omit `source`/`mood`/`routing`/`classification`
// — search_cache (cache.js/getCached) only ever stores `results`, nothing
// else, so there is nothing to return for those fields on a hit. This is a
// pre-existing, documented non-bug (see §0-NEW6's "cache doesn't store
// mood" note, extended here to the two new fields), not something this
// change alters.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders } from './cors.js';
import { hashCacheKey, getCached, setCached } from './cache.js';
import { DOMAINS } from './domains.js';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
);

function json(body, status, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const cors = buildCorsHeaders(origin);

  // Preflight — must succeed even if the function is otherwise broken,
  // or every real request looks like a generic "CORS error" in the
  // browser regardless of the actual cause (see §0's changelog: a
  // top-level import crash once caused this exact misdiagnosis).
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405, cors);
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, cors);
  }

  const { domain, query, filters } = body;

  const handler = DOMAINS[domain];
  if (!handler) {
    return json({ error: `Unknown domain "${domain}"` }, 400, cors);
  }

  if (!query || typeof query !== 'string') {
    return json({ error: '"query" is required' }, 400, cors);
  }

  try {
    const cacheKey = await hashCacheKey(domain, query, filters);
    const cachedResults = await getCached(supabase, domain, cacheKey);

    if (cachedResults) {
      // hasMore on a cache hit: the cache key already encodes filters
      // (including page/perPage — see cache.js's hashCacheKey), so a hit
      // was necessarily stored under the SAME page/limit this request is
      // asking for. Same full-page heuristic as a live fetch.
      const limit = Number.isInteger(filters?.perPage) && filters.perPage > 0
        ? Math.min(filters.perPage, 25)
        : 10;
      const hasMore = cachedResults.length === limit;
      return json({ results: cachedResults, cached: true, hasMore }, 200, cors);
    }

    const { source, results, mood, page, hasMore, routing, classification } =
      await handler.run({ query, filters, supabase });

    // Don't cache empty/failed results — a transient upstream miss
    // shouldn't get frozen into the cache for the full TTL. (Not
    // explicitly documented in the Notion log — flagging this as my own
    // reasonable addition in case you want it removed to match exact
    // prior behavior.)
    if (results && results.length > 0) {
      await setCached(supabase, domain, cacheKey, results, handler.ttlSeconds);
    }

    return json(
      { results, cached: false, source, mood, page, hasMore, routing, classification },
      200,
      cors
    );
  } catch (err) {
    console.error('[search] request failed', err);
    return json({ error: 'Search failed', message: err?.message ?? String(err) }, 500, cors);
  }
});
