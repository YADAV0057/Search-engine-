import { normalize, normalizeAndTokenize } from './parser/normalize.js';  
import { buildPlanFromGenreList } from './parser/searchPlanner.js';
import { fetchFromAniListUnified } from './adapters/anilist.js';
import { fetchFromJikanFallback } from './adapters/jikan.js';
import { fetchFromKitsuFallback } from './adapters/kitsu.js';
import { fetchFromMangaDexFallback } from './adapters/mangadex.js';
import { analyzeQueryMood } from './parser/moodLexicon.js';
import { getRoutingForMood } from './parser/mangaRouting.js';
import { rankResults } from './parser/rankResults.js';
import { classifyQuery, rankCategories } from './parser/queryClassifier.js';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

function resolvePagination(filters) {
  const rawPage = Number(filters?.page);
  const rawLimit = Number(filters?.perPage);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : DEFAULT_PAGE;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  return { page, limit };
}

// ==========================================
// Backend Update List batch (sort/filter additions):
// - sort:'popularity' — now EXPLICIT and forced across all 4 adapters,
//   rather than an accidental side-effect of the default branch (which
//   previously broke for MangaDex on a free-text query — it would use
//   order[relevance] instead of a popularity order).
// - sort:'trending' — AniList has a real TRENDING_DESC enum value, so this
//   is a genuine trending signal there. Jikan/Kitsu/MangaDex have no
//   trending metric at all, so they fall back to their popularity sort for
//   this value (documented in each adapter, not silently ignored).
// - filters.minScore / filters.maxPopularity — NEW. Applied as a
//   post-fetch filter below (no adapter exposes a clean score/popularity
//   threshold param across all 4 sources, so this is enforced here rather
//   than per-adapter, same pattern as the exclude-genre re-check Kitsu
//   already needed).
// - filters.minChapters — NEW, filters.maxChapters — FIXED (was accepted
//   into the plan but never actually read by any adapter). Both now
//   applied the same way as minScore/maxPopularity below.
// ==========================================

// ==========================================
// WATERFALL FIX (this pass): runManga() used to stop at the FIRST source
// that returned any filtered survivors and return just those, even if
// that was only 1-2 items — it never went on to ask Jikan/Kitsu/MangaDex
// for more. That's fine when there's no filter (any single source's page
// is a complete, useful result), but it actively worked against
// minScore/maxPopularity/minChapters/maxChapters: a strict filter can
// legitimately knock a 25-item raw page down to 1-3 survivors, and the
// waterfall would stop right there instead of topping up from the other
// three sources. Confirmed live: Hidden Gems and Short Reads were coming
// back with 1 and 3 results respectively even though other sources likely
// had more that passed the filter.
//
// Now: every source is tried (up to `limit` accumulated results), results
// are de-duplicated by normalized title (the same manga showing up via
// both AniList and Jikan, for example, shouldn't appear twice in one
// row), and only once every source has been tried (or the limit is
// filled) do we rank + return. Un-filtered queries behave the same as
// before in practice — the first source's full page usually already
// satisfies `limit` on its own, so there's nothing left to top up.
// ==========================================

function parseNumericFilter(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseChapterCount(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// Applied AFTER a source's raw fetch, BEFORE the waterfall's "did this
// source return anything usable" check — so a source that gets filtered
// down to zero results correctly falls through to the next source instead
// of the waterfall stopping early on an empty-after-filtering page.
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

// Used by the waterfall to de-duplicate the same manga arriving from two
// different sources (e.g. AniList and Jikan both surfacing "Berserk").
// Falls back to the source-qualified id if neither title field is usable,
// so a genuinely untitled result still gets a stable (if unique) key
// instead of colliding with every other untitled result.
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
      // FIX: this was hardcoded to null, so the `status` value above never
      // reached any adapter — mangadex.js (and likely anilist.js/jikan.js/
      // kitsu.js) reads plan.filters.statusFilter specifically. That's why
      // Trending Today / New Releases (RELEASING) / Most Awaited
      // (NOT_YET_RELEASED) were all returning identical unfiltered
      // popularity-sorted results.
      statusFilter: filters?.status ?? null,
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

  // FAN-OUT MODE (Notion "Backend Update List", multi-source fan-out
  // request): Advanced Filter's fetchAll.js used to genuinely query all 4
  // sources in parallel and hand each source's results to merge.js
  // separately — the waterfall-stop-at-first-hit behavior above collapsed
  // that into "whichever single source answered first", which merge.js
  // can still consume (it only needs the {source, items}[] shape) but
  // with 3 of 4 buckets always empty, so results felt thinner.
  //
  // Opt-in via filters.fanOut (boolean) so every other caller — landing
  // page rows, Mixer, plain search — keeps the existing waterfall
  // behavior and its early-exit performance benefit unchanged. When set,
  // all 4 adapters are queried concurrently (Promise.allSettled, so one
  // slow/failed source never blocks the others), each source's own
  // post-fetch-filtered results are kept in their own bucket
  // (bySource.<name>), and nothing is capped/deduped across sources here
  // — that's merge.js's job, same as before the engine cutover.
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

    // Still provide a single merged/ranked `results` list too, so any
    // caller that doesn't care about per-source buckets (or an older
    // frontend build that hasn't picked up bySource yet) keeps working
    // exactly like the non-fanOut path.
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

  // Accumulate across sources instead of stopping at the first one with
  // any filtered survivors — see WATERFALL FIX note above.
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
    });

    // hasMore: we filled the page exactly to `limit` AND at least one
    // contributing source still had a full raw page (there's a
    // reasonable signal more exists to page into). A partially-filled
    // page (accumulated.length < limit after trying every source) means
    // we've genuinely exhausted what's available under this filter, so
    // hasMore is false in that case even if some individual source had a
    // full raw page before filtering.
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
