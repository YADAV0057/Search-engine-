// js/cache.js
//
// TTL cache in front of every external API call, per README section 2:
// "keyed on domain + normalized query + filters". Table defined in
// supabase/migrations/0001_search_cache.sql.

/**
 * Builds a stable cache key from domain + query + filters. SHA-256 keeps
 * the key short and collision-safe regardless of filter object shape or
 * key order (JSON.stringify's key order matters, so we don't rely on it
 * for equality — only for producing bytes to hash).
 */
export async function hashCacheKey(domain, query, filters) {
  const payload = JSON.stringify({
    d: domain,
    q: (query || '').trim().toLowerCase(),
    f: filters ?? {}
  });
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Returns cached results, or null on a miss/expiry/error. */
export async function getCached(supabase, domain, cacheKey) {
  const { data, error } = await supabase
    .from('search_cache')
    .select('results, expires_at')
    .eq('domain', domain)
    .eq('query_hash', cacheKey)
    .maybeSingle();

  if (error) {
    console.error('[cache] read error', error);
    return null;
  }
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) return null; // expired -> treat as miss

  return data.results;
}

/** Upserts a cache row with a TTL. Failures are logged, never thrown — a cache write failing shouldn't fail the search. */
export async function setCached(supabase, domain, cacheKey, results, ttlSeconds) {
  const expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const { error } = await supabase
    .from('search_cache')
    .upsert(
      { domain, query_hash: cacheKey, results, expires_at },
      { onConflict: 'domain,query_hash' }
    );

  if (error) console.error('[cache] write error', error);
}
