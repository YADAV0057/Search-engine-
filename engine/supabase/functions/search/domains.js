import { normalize, normalizeAndTokenize } from './parser/normalize.js';  
import { buildPlanFromGenreList } from './parser/searchPlanner.js';
import { fetchFromAniListUnified } from './adapters/anilist.js';
import { fetchFromJikanFallback } from './adapters/jikan.js';
import { fetchFromKitsuFallback } from './adapters/kitsu.js';
import { fetchFromMangaDexFallback } from './adapters/mangadex.js';
import { analyzeQueryMood } from './parser/moodLexicon.js';
import { getRoutingForMood } from './parser/mangaRouting.js';
import { rankResults } from './parser/rankResults.js';
import { classifyQuery, rankCategories, hasStrongTitleMatch } from './parser/queryClassifier.js';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

// Entry 32 fix. Minimum summed emotion-intensity weight (from
// getRoutingForMood()'s boostGenres) a genre needs before it's trusted
// enough to actually drive the fetch (genre_in) rather than just re-rank
// results afterward. Not yet tuned against a broad real-query sample --
// flagged in Entry 32 as something to validate before this is considered
// fully safe, same as the TITLE_SIMILARITY_THRESHOLD in queryClassifier.js.
const MOOD_GENRE_INCLUSION_THRESHOLD = 2;
const MAX_MOOD_GENRES = 3;

function resolvePagination(filters) {
  const rawPage = Number(filters?.page);
  const rawLimit = Number(filters?.perPage);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : DEFAULT_PAGE;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  return { page, limit };
}

function parseNumericFilter(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseChapterCount(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function applyPostFetchFilters(results, filters) {
  if (!results || results.length === 0) return results;

  const minScore = parseNumericFilter(filters?.minScore);
  const maxPopularity = parseNumericFilter(filters?.maxPopularity);
  const minChapters = parseNumericFilter(filters?.minChapters);
  const maxChapters = parseNumericFilter(filters?.maxChapters);

  if (minScore === null && maxPopularity === null && minChapters === null && maxChapters === null) {
    return results;
  }

  return results.filter((r) => {
    if (minScore !== null) {
      if (typeof r.averageScore !== 'number' || r.averageScore < minScore) return false;
    }
    if (maxPopularity !== null) {
      if (typeof r.popularity !== 'number' || r.popularity > maxPopularity) return false;
    }
    if (minChapters !== null || maxChapters !== null) {
      const ch = parseChapterCount(r.chapters);
      if (ch === null) return false;
      if (minChapters !== null && ch < minChapters) return false;
      if (maxChapters !== null && ch > maxChapters) return false;
    }
    return true;
  });
}

function normalizeTitleKey(result) {
  const title = result?.title?.english || result?.title?.romaji || '';
  const trimmed = title.trim().toLowerCase();
  return trimmed || (result?.id != null ? `id:${result.id}` : null);
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
      statusFilter: filters?.status ?? null,
      sort: filters?.sort ?? 'relevance',
      maxChapters: filters?.maxChapters ?? null
    },
    confidence: 1.0
  };
}

// Entry 32 fix. When there's no explicit filter-panel genre selection, no
// strong title match (Entry 33's hasStrongTitleMatch gate), and the mood
// pipeline produced boost genres with enough weight to trust, rebuild the
// plan from those genres via buildPlanFromGenreList() -- same helper the
// filter-panel path already uses. This flips isGenreSearch to true in every
// adapter, so a mood query like "I am feeling lonely" becomes a genre_in
// browse (drama/sliceoflife) instead of a literal keyword search against
// titles, which is what was producing "I Am No Hero of the Shadows!" and
// similar mismatches.
function applyMoodGenreRouting(basicPlan, cleanQuery, filters, routing, classification, negatedExcludeGenres) {
  const hasExplicitGenreFilter = Array.isArray(filters?.genres) && filters.genres.length > 0;
  if (hasExplicitGenreFilter) return basicPlan;
  if (classification.hasStrongTitleMatch) return basicPlan;

  const topGenres = (routing.boostGenres || [])
    .filter((g) => g.weight >= MOOD_GENRE_INCLUSION_THRESHOLD)
    .slice(0, MAX_MOOD_GENRES)
    .map((g) => g.genre);

  if (topGenres.length > 0) {
    const genrePlan = buildPlanFromGenreList(topGenres, { cleanQuery, sort: filters?.sort });

    // buildPlanFromGenreList() defaults status/maxChapters to null -- carry
    // over whatever the caller actually asked for instead of silently
    // dropping them, same as buildBasicPlan()'s default branch does.
    genrePlan.filters.status = filters?.status ?? null;
    genrePlan.filters.statusFilter = filters?.status ?? null;
    genrePlan.filters.maxChapters = filters?.maxChapters ?? null;
    genrePlan.excludedGenres = [...new Set([
      ...(genrePlan.excludedGenres || []),
      ...(filters?.excludedGenres ?? [])
    ])];

    return genrePlan;
  }

  // Entry 39 fix. No positive boost signal survived to build a genre_in
  // search from (e.g. "I don't want anything sad" -- Entry 34 correctly
  // suppresses "sad", so there's nothing left to boost). Previously this
  // fell all the way through to buildBasicPlan()'s literal free-text
  // search against the raw sentence -- the exact Entry 31/32 bug,
  // re-triggered via a different path. Instead: drop the free-text term
  // (so isGenreSearch AND the literal-search branch are both false --
  // every adapter falls into a neutral, unfiltered-by-text popularity
  // browse) but keep whatever genres the negation itself implied should be
  // excluded. "I don't want anything sad" still keeps drama/psychological
  // out of the results this way -- it just doesn't pretend to know what
  // they DO want, unlike inverting the sentiment would.
  if (negatedExcludeGenres && negatedExcludeGenres.length > 0) {
    return {
      ...basicPlan,
      cleanQuery: '',
      primaryGenres: [],
    };
  }

  return basicPlan;
}

async function computeMoodSignal(supabase, rawQuery) {
  if (!supabase || !rawQuery) return null;
  const tokens = normalizeAndTokenize(rawQuery);
  if (tokens.length === 0) return null;

  try {
    const { aggregate, negatedAggregate, perToken } = await analyzeQueryMood(supabase, tokens);
    // Entry 39 fix: this used to bail to null whenever `aggregate` (positive
    // signal) was empty -- which is exactly what happens for a query that's
    // ALL negation, e.g. "I don't want anything sad" (Entry 34 correctly
    // suppresses "sad" out of `aggregate`, leaving it empty). That silently
    // threw away the negatedAggregate signal too, so the query fell all the
    // way through to Entry 32's old literal-keyword-search fallback --
    // exactly the bug Entry 32 was fixing, just re-triggered a different way.
    // Now: only bail if BOTH are empty.
    const hasPositive = Object.keys(aggregate).length > 0;
    const hasNegated = Object.keys(negatedAggregate || {}).length > 0;
    if (!hasPositive && !hasNegated) return null;
    return {
      aggregate,
      negatedAggregate: negatedAggregate || {},
      matchedTerms: perToken.filter((t) => t.source),
    };
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

async function computeQueryClassification(supabase, rawQuery) {
  if (!supabase || !rawQuery) return { ranked: [], genreTerms: [], hasStrongTitleMatch: false };
  try {
    const scores = await classifyQuery(supabase, rawQuery);
    const ranked = rankCategories(scores);
    const genreTerms = [
      ...(scores.GENRE ? scores.GENRE.matches : []),
      ...(scores.TAG ? scores.TAG.matches : [])
    ];
    const strongTitleMatch = hasStrongTitleMatch(scores, rawQuery);
    return { ranked, genreTerms, hasStrongTitleMatch: strongTitleMatch };
  } catch (err) {
    console.error('[domains] query classification failed', err);
    return { ranked: [], genreTerms: [], hasStrongTitleMatch: false };
  }
}

async function runManga({ query, filters, supabase }) {
  const cleanQuery = normalize(query || '');
  const queryTokens = normalizeAndTokenize(query || '');
  const mood = await computeMoodSignal(supabase, query || '');
  const routing = mood ? getRoutingForMood(mood.aggregate) : { boostGenres: [], excludeGenres: [] };
  // Entry 39: a second routing pass, over the NEGATED aggregate. We only
  // take its boostGenres -- the genres that emotion would have boosted had
  // it not been negated -- and treat those as genres to exclude. We
  // deliberately ignore negatedRouting.excludeGenres (the genres that
  // emotion's OWN routing table entry excludes): un-negating an exclusion
  // is an inversion ("not sad" -> implicitly wants comedy?), which is the
  // same semantically-murky move Entry 34 already rejected. Excluding what
  // was explicitly ruled out is a narrower, safer claim than including its
  // opposite.
  const negatedRouting = mood ? getRoutingForMood(mood.negatedAggregate) : { boostGenres: [], excludeGenres: [] };
  const negatedExcludeGenres = (negatedRouting.boostGenres || []).map((g) => g.genre);
  const classification = await computeQueryClassification(supabase, query || '');
  const { page, limit } = resolvePagination(filters);

  let plan = buildBasicPlan(cleanQuery, filters);
  plan = applyMoodGenreRouting(plan, cleanQuery, filters, routing, classification, negatedExcludeGenres);

  if (routing.excludeGenres.length > 0 || negatedExcludeGenres.length > 0) {
    plan.excludedGenres = [...new Set([
      ...(plan.excludedGenres || []),
      ...routing.excludeGenres,
      ...negatedExcludeGenres,
    ])];
  }

  const moodMatchedTerms = mood ? mood.matchedTerms : [];

  const fanOut = !!filters?.fanOut;

  if (fanOut) {
    const bySource = { anilist: [], jikan: [], kitsu: [], mangadex: [] };
    let anySourceHadFullRawPageFO = false;

    const settled = await Promise.allSettled(
      MANGA_SOURCES.map((source) => source.fetch(plan, page, limit))
    );

    settled.forEach((result, i) => {
      const source = MANGA_SOURCES[i];
      if (result.status !== 'fulfilled') {
        console.error(`[manga] ${source.name} failed`, result.reason);
        return;
      }
      const rawResults = result.value;
      if (rawResults && rawResults.length === limit) anySourceHadFullRawPageFO = true;
      bySource[source.name] = applyPostFetchFilters(rawResults, filters) || [];
    });

    const seenTitlesFO = new Set();
    const mergedFO = [];
    for (const source of MANGA_SOURCES) {
      for (const item of bySource[source.name]) {
        const key = normalizeTitleKey(item);
        if (key && seenTitlesFO.has(key)) continue;
        if (key) seenTitlesFO.add(key);
        mergedFO.push(item);
      }
    }

    let resultsFO = mergedFO;
    if (routing.boostGenres.length > 0) {
      resultsFO = applyMoodBoost(resultsFO, routing.boostGenres);
    }
    resultsFO = rankResults(resultsFO, {
      classifierRanked: classification.ranked,
      moodAggregate: mood ? mood.aggregate : {},
      queryTokens,
      queryGenreTerms: classification.genreTerms,
      filterGenres: filters?.genres ?? [],
      boostGenres: routing.boostGenres,
      moodMatchedTerms,
    });

    const contributingSourcesFO = MANGA_SOURCES
      .filter((s) => bySource[s.name].length > 0)
      .map((s) => s.name);

    return {
      source: contributingSourcesFO.join('+') || null,
      results: resultsFO,
      bySource,
      mood,
      page,
      hasMore: anySourceHadFullRawPageFO,
      routing,
      classification,
    };
  }

  const accumulated = [];
  const seenTitles = new Set();
  const contributingSources = [];
  let anySourceHadFullRawPage = false;

  for (const source of MANGA_SOURCES) {
    if (accumulated.length >= limit) break;

    try {
      const rawResults = await source.fetch(plan, page, limit);
      if (rawResults && rawResults.length === limit) {
        anySourceHadFullRawPage = true;
      }

      const filteredResults = applyPostFetchFilters(rawResults, filters);
      if (!filteredResults || filteredResults.length === 0) continue;

      let sourceContributed = false;
      for (const item of filteredResults) {
        if (accumulated.length >= limit) break;
        const key = normalizeTitleKey(item);
        if (key && seenTitles.has(key)) continue;
        if (key) seenTitles.add(key);
        accumulated.push(item);
        sourceContributed = true;
      }
      if (sourceContributed) contributingSources.push(source.name);
    } catch (err) {
      console.error(`[manga] ${source.name} failed`, err);
    }
  }

  if (accumulated.length > 0) {
    let results = accumulated;
    if (routing.boostGenres.length > 0) {
      results = applyMoodBoost(results, routing.boostGenres);
    }
    results = rankResults(results, {
      classifierRanked: classification.ranked,
      moodAggregate: mood ? mood.aggregate : {},
      queryTokens,
      queryGenreTerms: classification.genreTerms,
      filterGenres: filters?.genres ?? [], 
      boostGenres: routing.boostGenres,
      moodMatchedTerms,
    });

    const hasMore = accumulated.length >= limit && anySourceHadFullRawPage;

    return {
      source: contributingSources.join('+') || null,
      results,
      mood,
      page,
      hasMore,
      routing,
      classification,
    };
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
