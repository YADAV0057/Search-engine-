// js/domains.js
//
// One registry entry per niche. index.js never knows or cares which niche
// it's serving — it just looks up DOMAINS[domain] and calls .run().
// Adding a new niche (anime, books, ...) means adding a new entry here,
// not touching index.js/cors.js/cache.js.
//
// Each entry needs:
//   ttlSeconds — how long a result set stays cached for this domain
//   run({ query, filters }) -> { source: string|null, results: array }

import { normalize } from './parser/normalize.js';
import { buildPlanFromGenreList } from './parser/searchPlanner.js';
import { fetchFromAniListUnified } from './adapters/anilist.js';
import { fetchFromJikanFallback } from './adapters/jikan.js';
import { fetchFromKitsuFallback } from './adapters/kitsu.js';
import { fetchFromMangaDexFallback } from './adapters/mangadex.js';

// Tiered fallback per README section 2: try source 1, only fall through if
// it comes back empty. Order here IS the waterfall order. MangaDex sits
// last — it's the old engine's Tier 4 database, kept as the final catch-all
// after the three metadata-first sources.
const MANGA_SOURCES = [
  { name: 'anilist', fetch: (plan) => fetchFromAniListUnified(plan) },
  { name: 'jikan', fetch: (plan) => fetchFromJikanFallback(plan) },
  { name: 'kitsu', fetch: (plan) => fetchFromKitsuFallback(plan) },
  { name: 'mangadex', fetch: (plan) => fetchFromMangaDexFallback(plan) }
];

/**
 * PORTING NOTE: the old engine built a rich SearchPlan from a MangaIntent
 * produced by a mood/NLU pipeline (parser/pipeline.js, not yet ported —
 * see SALVAGE_NOTES.md). Until that pipeline exists here, this builds a
 * minimal plan directly from the raw query/filters so the adapters (which
 * only care about the SearchPlan shape, not how it was built) work today.
 * Swap this out for a real buildIntent() -> buildSearchPlan() pipeline
 * later without touching index.js or the adapters.
 */
function buildBasicPlan(query, filters) {
  if (Array.isArray(filters?.genres) && filters.genres.length > 0) {
    return buildPlanFromGenreList(filters.genres, {
      cleanQuery: query,
      sort: filters.sort
    });
  }

  return {
    cleanQuery: query,
    primaryGenres: [],
    secondaryThemes: [],
    excludedGenres: filters?.excludedGenres ?? [],
    excludedThemes: [],
    apiOrder: ['anilist', 'jikan', 'kitsu', 'mangadex'],
    filters: {
      status: filters?.status ?? null,
      statusFilter: null,
      sort: filters?.sort ?? 'relevance',
      maxChapters: filters?.maxChapters ?? null
    },
    confidence: 1.0
  };
}

async function runManga({ query, filters }) {
  const cleanQuery = normalize(query || '');
  const plan = buildBasicPlan(cleanQuery, filters);

  for (const source of MANGA_SOURCES) {
    try {
      const results = await source.fetch(plan);
      if (results && results.length > 0) {
        return { source: source.name, results };
      }
    } catch (err) {
      console.error(`[manga] ${source.name} failed`, err);
      // fall through to the next source in the waterfall
    }
  }

  return { source: null, results: [] };
}

export const DOMAINS = {
  manga: {
    ttlSeconds: 60 * 60 * 6, // 6h — catalog data, not live/volatile
    run: runManga
  }

  // anime: { ttlSeconds: ..., run: runAnime },
  // books: { ttlSeconds: ..., run: runBooks },
};
