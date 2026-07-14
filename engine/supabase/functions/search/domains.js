import { normalize, normalizeAndTokenize } from './parser/normalize.js';
import { buildPlanFromGenreList } from './parser/searchPlanner.js';
import { fetchFromAniListUnified } from './adapters/anilist.js';
import { fetchFromJikanFallback } from './adapters/jikan.js';
import { fetchFromKitsuFallback } from './adapters/kitsu.js';
import { fetchFromMangaDexFallback } from './adapters/mangadex.js';
import { analyzeQueryMood } from './parser/moodLexicon.js';
import { getRoutingForMood } from './parser/mangaRouting.js';

const MANGA_SOURCES = [
  { name: 'anilist', fetch: (plan) => fetchFromAniListUnified(plan) },
  { name: 'jikan', fetch: (plan) => fetchFromJikanFallback(plan) },
  { name: 'kitsu', fetch: (plan) => fetchFromKitsuFallback(plan) },
  { name: 'mangadex', fetch: (plan) => fetchFromMangaDexFallback(plan) }
];

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

async function computeMoodSignal(supabase, rawQuery) {
  if (!supabase || !rawQuery) return null;
  const tokens = normalizeAndTokenize(rawQuery);
  if (tokens.length === 0) return null;

  try {
    const { aggregate, perToken } = await analyzeQueryMood(supabase, tokens);
    if (Object.keys(aggregate).length === 0) return null;
    return { aggregate, matchedTerms: perToken.filter((t) => t.source) };
  } catch (err) {
    console.error('[domains] mood analysis failed', err);
    return null;
  }
}

function toRoutingKey(name) {
  return (name || '').trim().toLowerCase().replace(/[^a-z]/g, '');
}

function applyMoodBoost(results, boostGenres) {
  if (!boostGenres || boostGenres.length === 0 || !results || results.length === 0) {
    return results;
  }

  const weightByGenre = new Map(boostGenres.map((b) => [b.genre, b.weight]));

  const scored = results.map((result) => {
    const genreKeys = (result.genres || []).map(toRoutingKey);
    let score = 0;
    for (const key of genreKeys) {
      if (weightByGenre.has(key)) score += weightByGenre.get(key);
    }
    return { result, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.result);
}

async function runManga({ query, filters, supabase }) {
  const cleanQuery = normalize(query || '');
  const mood = await computeMoodSignal(supabase, query || '');
  const routing = mood ? getRoutingForMood(mood.aggregate) : { boostGenres: [], excludeGenres: [] };

  const plan = buildBasicPlan(cleanQuery, filters);

  if (routing.excludeGenres.length > 0) {
    plan.excludedGenres = [...new Set([...(plan.excludedGenres || []), ...routing.excludeGenres])];
  }

  for (const source of MANGA_SOURCES) {
    try {
      let results = await source.fetch(plan);
      if (results && results.length > 0) {
        if (routing.boostGenres.length > 0) {
          results = applyMoodBoost(results, routing.boostGenres);
        }
        return { source: source.name, results, mood };
      }
    } catch (err) {
      console.error(`[manga] ${source.name} failed`, err);
    }
  }

  return { source: null, results: [], mood };
}

export const DOMAINS = {
  manga: {
    ttlSeconds: 60 * 60 * 6,
    run: runManga
  }
};
