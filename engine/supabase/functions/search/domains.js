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

// ==========================================
// PAGINATION — added 2026-07-14 (Notion "wiring search engine" Entry 18)
// ==========================================
// Root cause: runManga() never passed page/limit to any adapter, so every
// search was hardcoded to the first 10 results regardless of what a caller
// asked for. All 4 adapters already accepted (plan, page, limit) params —
// domains.js just wasn't supplying them. This is additive: a caller that
// sends no filters.page/perPage gets the exact same behavior as before
// (page 1, 10 results).
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25; // Jikan hard-caps at 25/page — keep every source consistent

/**
 * Resolves the caller's requested page/limit from filters, defaulting to
 * the old hardcoded values (page 1, 10 results) when absent or invalid.
 */
function resolvePagination(filters) {
  const rawPage = Number(filters?.page);
  const rawLimit = Number(filters?.perPage);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : DEFAULT_PAGE;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  return { page, limit };
}

const MANGA_SOURCES = [
  { name: 'anilist', fetch: (plan, page, limit) => fetchFromAniListUnified(plan, page, false, limit) },
  { name: 'jikan', fetch: (plan, page, limit) => fetchFromJikanFallback(plan, page, limit) },
  { name: 'kitsu', fetch: (plan, page, limit) => fetchFromKitsuFallback(plan, page, limit) },
  { name: 'mangadex', fetch: (plan, page, limit) => fetchFromMangaDexFallback(plan, page, limit) }
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
  const { page, limit } = resolvePagination(filters);

  const plan = buildBasicPlan(cleanQuery, filters);

  if (routing.excludeGenres.length > 0) {
    plan.excludedGenres = [...new Set([...(plan.excludedGenres || []), ...routing.excludeGenres])];
  }

  for (const source of MANGA_SOURCES) {
    try {
      let results = await source.fetch(plan, page, limit);
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
        // hasMore is a heuristic, not a real total-count signal from any
        // adapter: a full page probably means more results exist upstream,
        // an under-full page means we've hit the end. Same "full page
        // probably means more" approach the old frontend engine used
        // (Notion "wiring search engine" Entry 15).
        const hasMore = results.length === limit;
        // ADDED 2026-07-17 (Notion "Backend Update List", aiPanel.js gap
        // #1/#2, Entry 25): expose the routing decision (which genres were
        // boosted/excluded off the mood signal) and the classifier's ranked
        // categories + matched genre/tag terms. These were already computed
        // above for internal ranking use — this just also returns them.
        // aiPanel.js's "Detected X" / "Avoiding X" reasoning lines have no
        // other data source; this is additive, nothing existing changes.
        return {
          source: source.name,
          results,
          mood,
          page,
          hasMore,
          routing,
          classification,
        };
      }
    } catch (err) {
      console.error(`[manga] ${source.name} failed`, err);
    }
  }

  return {
    source: null,
    results: [],
    mood,
    page,
    hasMore: false,
    routing,
    classification,
  };
}

export const DOMAINS = {
  manga: {
    ttlSeconds: 60 * 60 * 6,
    run: runManga
  }
};
