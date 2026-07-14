// ==========================================
// SEARCH ENGINE — Edge Function entry point
// supabase/functions/search/index.js
// ==========================================
// POST /search
// { "domain": "manga", "query": "...", "filters": { ... } }
// -> { "results": [...], "cached": bool, "source": string|null }
//
// This is the ONE HTTP contact point every niche frontend (moodmanga.in,
// and whatever comes after it) talks to. Nothing here should ever say
// "manga" by name — domain-specific logic lives in domains.js.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders } from './cors.js';
import { getCached, setCached, hashCacheKey } from './cache.js';
import { DOMAINS } from './domains.js';

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
// Supabase platform for every Edge Function in this project — no need to
// set them manually as function secrets.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
);

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const cors = buildCorsHeaders(origin);

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405, cors);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, cors);
  }

  const { domain, query = '', filters = {} } = body ?? {};
  const handler = DOMAINS[domain];

  if (!handler) {
    return json(
      { error: `Unknown domain "${domain}". Registered domains: ${Object.keys(DOMAINS).join(', ')}` },
      400,
      cors
    );
  }

  try {
    const cacheKey = await hashCacheKey(domain, query, filters);

    const cached = await getCached(supabase, domain, cacheKey);
    if (cached) {
      return json({ results: cached, cached: true, source: 'cache' }, 200, cors);
    }

    const { source, results, mood } = await handler.run({ query, filters, supabase });

    // Only cache non-empty results — an empty result set is more likely a
    // transient upstream hiccup than a stable "nothing exists" answer, and
    // caching it would make a real miss look permanent for the TTL window.
    if (results.length > 0) {
      await setCached(supabase, domain, cacheKey, results, handler.ttlSeconds);
    }

    return json({ results, cached: false, source }, 200, cors);
  } catch (err) {
    console.error(`[search] domain="${domain}" failed`, err);
    return json({ error: 'Internal search error' }, 500, cors);
  }
});

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
