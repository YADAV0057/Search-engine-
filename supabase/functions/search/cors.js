// js/cors.js
//
// Explicit allowlist, not a wildcard — this engine is shared across every
// niche frontend, and a wildcard would let anyone proxy through it and eat
// the free-tier quota. Add each real frontend domain here as it launches.
//
// NOTE: if/when all niche frontends move to subdomains of one company
// domain (e.g. manga.company.com, anime.company.com), replace the
// includes() check below with a suffix match against that one root domain
// instead of listing every subdomain individually. Not needed yet.

const ALLOWED_ORIGINS = [
  'https://moodmanga.in',
  'https://www.moodmanga.in',
  // local dev
  'http://localhost:3000',
  'http://localhost:5173'
];

export function buildCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    'Vary': 'Origin'
  };
}
