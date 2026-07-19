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
//
// FIX 2026-07-19 (Entry 59): `acclaim` and `referenceTitle` were already
// being returned by domains.js's runManga() (Entry 35/40 and Entry 49 gap
// #4 respectively) but this file's destructuring/response object were
// never updated to match — both were silently dropped before ever
// reaching the HTTP response, same class of gap this entry's fix
// (`moodTags`) would otherwise have introduced a third instance of. All
// three are included below now.
//
// FIXED 2026-07-18 (frontend/backend contract mismatch): this validation
// used to be `if (!query || typeof query !== 'string')`, which rejects an
// EMPTY string query with a 400 — but a filters-only browse request (no
// search text at all) is a legitimate shape. js/search.js's
// triggerQuickFilter() (the "Finish tonight" / "Long binge" / "Completed"
// chips) sends exactly that: `triggerSearch('', 1, false, extraFilters)`.
// That 400 was silently swallowed by callSearchEngine() throwing, caught
// by triggerSearch(), and rendered as "Something went wrong searching —
// try again in a moment." straight into #community-grid — which happens
// to be the SAME grid element topPicks.js renders "Today's Top Picks"
// into, so the leftover error from the last quick-filter tap was showing
// up there instead. (topPicks.js itself already worked around this exact
// restriction by hardcoding a non-empty `query: 'top rated manga'` — see
// its own header comment.) Now only a missing/non-string query (null,
// undefined, a number, etc.) is rejected; an empty string is treated as
// "no free-text term, filters only" and passed straight through to the
// domain handler, same as any other query.

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

  // FIXED 2026-07-18: only reject a missing/non-string query. An empty
  // string ('') is a valid "filters-only browse, no free text" request —
  // see the fix note at the top of this file.
  if (typeof query !== 'string') {
    return json({ error: '"query" must be a string (use "" for a filters-only browse)' }, 400, cors);
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

    const { source, results, mood, page, hasMore, routing, classification, acclaim, referenceTitle, moodTags } =
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
      { results, cached: false, source, mood, page, hasMore, routing, classification, acclaim, referenceTitle, moodTags },
      200,
      cors
    );
  } catch (err) {
    console.error('[search] request failed', err);
    return json({ error: 'Search failed', message: err?.message ?? String(err) }, 500, cors);
  }
});
