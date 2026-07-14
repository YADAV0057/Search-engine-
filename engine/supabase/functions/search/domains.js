import { normalize, normalizeAndTokenize } from './parser/normalize.js';  
import { buildPlanFromGenreList } from './parser/searchPlanner.js';
import { fetchFromAniListUnified } from './adapters/anilist.js';
import { fetchFromJikanFallback } from './adapters/jikan.js';
import { fetchFromKitsuFallback } from './adapters/kitsu.js';
import { fetchFromMangaDexFallback } from './adapters/mangadex.js';
import { analyzeQueryMood } from './parser/moodLexicon.js';
import { getRoutingForMood } from './parser/mangaRouting.js';
import { rankResults } from './parser/rankResults.js';
// TODO: confirm this import against the real, live queryClassifier.js before
// deploying — not yet uploaded/verified this session, so classifyQuery()'s
// actual export name and return shape are ASSUMED here based on the design
// log (§10: rankCategories() returns [{category, score}, ...]), not
// confirmed against real code. Same category of mistake already caught once
// this session with fuzzyMatch.js — don't skip verifying this one too.
import { classifyQuery } from './parser/queryClassifier.js';

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

// Wraps classifyQuery() with the same defensive try/catch pattern
// computeMoodSignal() already uses above — a classifier failure (or a
// missing/misconfigured supabase client) should degrade to "no classifier
// signal" rather than take down the whole request. rankResults() already
// has its own zero-signal fallback (even 1/3 split), so this is safe.
async function computeQueryClassification(supabase, rawQuery) {
  if (!supabase || !rawQuery) return { ranked: [], genreTerms: [] };
  try {
    // ASSUMED SHAPE, not confirmed — see the import comment above. If the
    // real classifyQuery() returns something different (e.g. doesn't
    // include matched GENRE/TAG term strings alongside the ranked
    // category/score list), this destructure needs to change to match.
    const { ranked, genreTerms } = await classifyQuery(supabase, rawQuery);
    return { ranked: ranked || [], genreTerms: genreTerms || [] };
  } catch (err) {
    console.error('[domains] query classification failed', err);
    return { ranked: [], genreTerms: [] };
  }
}

async function runManga({ query, filters, supabase }) {
  const cleanQuery = normalize(query || '');
  const queryTokens = normalizeAndTokenize(query || '');
  const mood = await computeMoodSignal(supabase, query || '');
  const routing = mood ? getRoutingForMood(mood.aggregate) : { boostGenres: [], excludeGenres: [] };
  const classification = await computeQueryClassification(supabase, query || '');

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
        // Final ranking pass — runs after applyMoodBoost()'s soft re-rank,
        // immediately before returning. Query-adaptive: weights come from
        // the classifier's own per-query category scores, not a fixed
        // formula. See §0-NEW9/§0-NEW10 in the Context Log for design +
        // offline test results (9/9 passed against mock data).
        results = rankResults(results, {
          classifierRanked: classification.ranked,
          moodAggregate: mood ? mood.aggregate : {},
          queryTokens,
          queryGenreTerms: classification.genreTerms,
          boostGenres: routing.boostGenres,
        });
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
