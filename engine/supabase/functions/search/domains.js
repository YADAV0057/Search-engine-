import { normalize, normalizeAndTokenize } from './parser/normalize.js';  
import { buildPlanFromGenreList } from './parser/searchPlanner.js';
import { fetchFromAniListUnified } from './adapters/anilist.js';
import { fetchFromJikanFallback } from './adapters/jikan.js';
import { fetchFromKitsuFallback } from './adapters/kitsu.js';
import { fetchFromMangaDexFallback } from './adapters/mangadex.js';
import { analyzeQueryMood } from './parser/moodLexicon.js';
import { getRoutingForMood } from './parser/mangaRouting.js';
import { rankResults } from './parser/rankResults.js';
// Confirmed against the real, live queryClassifier.js (2026-07-14).
// classifyQuery(supabase, rawQuery) returns { [category]: { score, matches } }
// — NOT a ranked list by itself. rankCategories(scores) is the separate
// step that turns it into [{category, score}, ...] sorted highest-first.
import { classifyQuery, rankCategories } from './parser/queryClassifier.js';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25; // Jikan hard-caps at 25/page — keep every source consistent

const MANGA_SOURCES = [
  { name: 'anilist', fetch: (plan, page, limit) => fetchFromAniListUnified(plan, page, false, limit) },
  { name: 'jikan', fetch: (plan, page, limit) => fetchFromJikanFallback(plan, page, limit) },
  { name: 'kitsu', fetch: (plan, page, limit) => fetchFromKitsuFallback(plan, page, limit) },
  { name: 'mangadex', fetch: (plan, page, limit) => fetchFromMangaDexFallback(plan, page, limit) }
];

// filters.page / filters.perPage are the new caller-facing pagination
// params. Both optional — default to page 1 / 10 results, same as the
// old hardcoded adapter defaults, so existing callers with no pagination
// awareness see zero behavior change.
function resolvePagination(filters) {
  const rawPage = Number(filters?.page);
  const rawLimit = Number(filters?.perPage);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : DEFAULT_PAGE;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  return { page, limit };
}

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

// Wraps classifyQuery()+rankCategories() with the same defensive try/catch
// pattern computeMoodSignal() already uses above — a classifier failure (or
// a missing/misconfigured supabase client) should degrade to "no classifier
// signal" rather than take down the whole request. rankResults() already
// has its own zero-signal fallback (even 1/3 split), so this is safe.
//
// queryGenreTerms are pulled from scores.GENRE.matches / scores.TAG.matches
// — these are real matched vocab NAMES from lexicon_entities (e.g. "Romance",
// "Slice of Life"), not raw query words, which is what rankResults()'s
// genreMatch scoring needs to compare against each candidate's genres[].
async function computeQueryClassification(supabase, rawQuery) {
  if (!supabase || !rawQuery) return { ranked: [], genreTerms: [] };
  try {
    const scores = await classifyQuery(supabase, rawQuery);
    const ranked = rankCategories(scores);
    const genreTerms = [
      ...(scores.GENRE ? scores.GENRE.matches : []),
      ...(scores.TAG ? scores.TAG.matches : [])
    ];
    return { ranked, genreTerms };
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
