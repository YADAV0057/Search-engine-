import { normalize, normalizeAndTokenize } from './parser/normalize.js';  
import { buildPlanFromGenreList } from './parser/searchPlanner.js';
import { fetchFromAniListUnified, fetchAniListMediaBySearch, fetchAniListRecommendations, fetchAniListMediaByTags } from './adapters/anilist.js';
import { fetchFromJikanFallback } from './adapters/jikan.js';
import { fetchFromKitsuFallback } from './adapters/kitsu.js';
import { fetchFromMangaDexFallback } from './adapters/mangadex.js';
import { analyzeQueryMood } from './parser/moodLexicon.js';
import { getRoutingForMood, detectConjunctiveClusters } from './parser/mangaRouting.js';
import { rankResults } from './parser/rankResults.js';
import { classifyQuery, rankCategories, hasStrongTitleMatch, getNegatedGenreTerms, getTagVocabEntries, significantTokens } from './parser/queryClassifier.js';
import { computeAcclaimIntensity } from './parser/acclaimScoring.js';
import { detectReferenceTitle } from './parser/referenceTitle.js';
import { getEmotionalIntentFallback } from './parser/emotionalIntentFallback.js';
import { getIdiomFallback } from './parser/idiomFallback.js';

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

async function computeMoodSignal(supabase, rawQuery, groqApiKey, cerebrasApiKey) {
  if (!supabase || !rawQuery) return null;
  const tokens = normalizeAndTokenize(rawQuery);
  if (tokens.length === 0) return null;

  try {
    const { aggregate, negatedAggregate, perToken, cleanTokens, claimed, negated } =
      await analyzeQueryMood(supabase, tokens);
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
    if (!hasPositive && !hasNegated) {
      // Entry 49 gap #5 fix. The lexicon/AFINN tier found genuinely
      // nothing -- e.g. "I just want someone to stay", where "stay" isn't
      // AFINN-scored and "want" is a stopword. Previously this returned
      // null here unconditionally, and the query fell through to a
      // literal free-text search (the Entry 31/32 bug again, reached via
      // an empty-lexicon-coverage path this time instead of a negation
      // edge case). Fall back to a Groq/Cerebras classification of the
      // query's emotional intent -- see emotionalIntentFallback.js's
      // header for the full design. Fails closed to null on any error,
      // missing key, or non-emotional query, so this can never block or
      // degrade a search that isn't asking for it.
      //
      // Entry 61: idiom-span fallback runs first here too (before the
      // whole-query emotional-intent fallback) -- "slow burn" alone, with
      // no other emotional words in the query, is exactly the empty-
      // aggregate case this branch handles, and a phrase-level match is a
      // better signal than a whole-sentence one when it's available.
      const idiomOnly = await getIdiomFallback(cleanTokens, claimed, negated, groqApiKey, cerebrasApiKey, supabase);
      if (idiomOnly) return idiomOnly;
      return await getEmotionalIntentFallback(rawQuery, tokens, groqApiKey, cerebrasApiKey, supabase);
    }

    // Entry 61: idiom-span fallback runs ADDITIVELY here, unlike
    // emotionalIntentFallback.js above -- a query can have real AFINN/
    // lexicon signal from other words ("sad slow burn romance") and still
    // contain an idiom span nothing else covered. Merges into the same
    // aggregate with a plain per-key sum, same as analyzeQueryMood()'s own
    // matches are summed. Never throws/blocks: getIdiomFallback() already
    // fails closed to null on any error or missing key.
    const idiomSignal = await getIdiomFallback(cleanTokens, claimed, negated, groqApiKey, cerebrasApiKey, supabase);
    const mergedAggregate = { ...aggregate };
    const matchedTerms = perToken.filter((t) => t.source);
    if (idiomSignal) {
      for (const [key, weight] of Object.entries(idiomSignal.aggregate)) {
        mergedAggregate[key] = (mergedAggregate[key] || 0) + weight;
      }
      matchedTerms.push(...idiomSignal.matchedTerms);
    }

    return {
      aggregate: mergedAggregate,
      negatedAggregate: negatedAggregate || {},
      matchedTerms,
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

async function computeQueryClassification(supabase, rawQuery, moodMatchedTerms = []) {
  if (!supabase || !rawQuery) return { ranked: [], genreTerms: [], genreOnlyTerms: [], negatedGenreTerms: [], hasStrongTitleMatch: false };
  try {
    // FIX 2026-07-19 (Entry 65): thread the mood pipeline's real
    // phrase-level lexicon matches (mood.matchedTerms, already computed
    // above in runManga() before this is called) into the classifier so
    // its EMOTION category weight reflects real idiom/trope matches, not
    // just raw single-token AFINN hits. See queryClassifier.js's
    // scoreEmotion() for the full rationale.
    const scores = await classifyQuery(supabase, rawQuery, moodMatchedTerms);
    const ranked = rankCategories(scores);
    const genreTerms = [
      ...(scores.GENRE ? scores.GENRE.matches : []),
      ...(scores.TAG ? scores.TAG.matches : [])
    ];
    // FIX 2026-07-19 (Notion "Backend Update List" Entry 53): genreTerms
    // above is ranking-only (queryGenreTerms, read by rankResults() below)
    // and was never merged into plan.primaryGenres for ANY category --
    // so a literal, unambiguous genre word typed in free text ("Sports
    // manga that will make me cry") got scored and then discarded before
    // the fetch ever ran, and the actual candidate pool came entirely from
    // mood-boosted genres instead. genreOnlyTerms is a second, stricter
    // list -- GENRE-category matches only, no TAG -- since TAG's 420-row
    // vocab is the same noisy, false-positive-prone word-bag matching
    // Entry 33 already flagged for TITLE; only a real GENRE hit is trusted
    // enough to actually constrain the fetch (see runManga() below for
    // where this gets folded into plan.primaryGenres). genreTerms itself
    // is untouched -- still ranking-only, still includes TAG, so
    // rankResults()'s existing scoring behavior doesn't change.
    const genreOnlyTerms = scores.GENRE ? scores.GENRE.matches : [];
    // Exclusion-system pass. "anything except horror" -> GENRE.negatedMatches
    // = ['Horror'] -> this -> merged into plan.excludedGenres below, same
    // hard-filter mechanism (genre_not_in on AniList, ID-exclusion on
    // Jikan/MangaDex) that filters.excludedGenres and mood-negation already
    // use. See queryClassifier.js's getNegatedGenreTerms() for why only
    // GENRE/TAG are negatable here, not TITLE/AUTHOR/CHARACTER.
    const negatedGenreTerms = getNegatedGenreTerms(scores);
    const strongTitleMatch = hasStrongTitleMatch(scores, rawQuery);
    return { ranked, genreTerms, genreOnlyTerms, negatedGenreTerms, hasStrongTitleMatch: strongTitleMatch };
  } catch (err) {
    console.error('[domains] query classification failed', err);
    return { ranked: [], genreTerms: [], genreOnlyTerms: [], negatedGenreTerms: [], hasStrongTitleMatch: false };
  }
}

// Entry 49 gap #4. Only called when referenceTitle.js has already
// confirmed a "like X" mention against the real TITLE vocab (see that
// file's header for why the confirmation step exists) -- this function
// just resolves the confirmed title to AniList data and decides what to
// hand back to runManga(). Three outcomes, in order of preference:
//   1. AniList resolves the title AND has curated recommendations for it
//      -> those recommendations become the candidate pool directly.
//   2. AniList resolves the title but has zero/thin recommendations
//      (common for obscure or very new titles) -> fall back to a
//      genre_in plan built from that title's OWN genres, same
//      buildPlanFromGenreList() helper the mood-routing path already
//      uses -- weaker than #1 (loses the "specifically like THIS title"
//      precision) but still anchored to the actual reference instead of
//      ignoring it.
//   3. AniList can't resolve the title at all (rare, since it already
//      matched something in lexicon_entities) -> null, caller proceeds
//      exactly as if no reference had been detected.
async function resolveReferenceTitle(reference, cleanQuery, filters) {
  if (!reference) return { results: null, plan: null, resolvedMedia: null };

  try {
    const media = await fetchAniListMediaBySearch(reference.title);
    if (!media) return { results: null, plan: null, resolvedMedia: null };

    const recommendations = await fetchAniListRecommendations(media.id, 15);
    if (recommendations.length > 0) {
      return { results: recommendations, plan: null, resolvedMedia: media };
    }

    if (media.genres && media.genres.length > 0) {
      const genrePlan = buildPlanFromGenreList(media.genres.slice(0, 3), {
        cleanQuery,
        sort: filters?.sort
      });
      genrePlan.filters.status = filters?.status ?? null;
      genrePlan.filters.statusFilter = filters?.status ?? null;
      genrePlan.filters.maxChapters = filters?.maxChapters ?? null;
      return { results: null, plan: genrePlan, resolvedMedia: media };
    }

    return { results: null, plan: null, resolvedMedia: media };
  } catch (err) {
    console.error('[manga] reference-title resolution failed', err);
    return { results: null, plan: null, resolvedMedia: null };
  }
}

// Entry 59 fix (Notion "Backend Update List"): closes the gap diagnosed
// after Entry 57/58 -- those fixes made the mood pipeline generate real
// per-query keywords and made rankResults.js able to use them for
// re-ranking, but the FETCH stage never used them at all, so every
// "comfort" query still browsed the same fixed genre_in candidate pool
// (re-ranking a fixed pool can't surface a title that was never fetched).
// This function is what actually diversifies the pool: it matches the
// mood signal's keywords against REAL, curated AniList tag names (never
// passes raw LLM phrasing straight to AniList -- see
// fetchAniListMediaByTags()'s header) and, on a hit, fetches by tag_in --
// the same "confirm against real vocab first, then fetch" shape
// resolveReferenceTitle() above already uses for "like X" references.
//
// Matching is deliberately the same word-bag overlap queryClassifier.js's
// matchesCategoryPhrase() uses for TITLE candidates (>=1 shared
// significant/4+ letter token), just applied to short LLM keyword phrases
// against tag names instead of full query tokens against title names --
// appropriate here because both sides are already short, specific phrases
// (2-4 words), not a full sentence that would need the stricter
// similarity() check hasStrongTitleMatch() applies for TITLE.
async function resolveMoodTagCandidates(supabase, moodMatchedTerms) {
  if (!moodMatchedTerms || moodMatchedTerms.length === 0) return { results: [], matchedTags: [] };

  try {
    const tagEntries = await getTagVocabEntries(supabase);
    if (!tagEntries || tagEntries.length === 0) return { results: [], matchedTags: [] };

    const matchedTags = new Set();
    for (const { term } of moodMatchedTerms) {
      const termTokens = significantTokens(term || '');
      if (termTokens.length === 0) continue;
      const termTokenSet = new Set(termTokens);

      for (const entry of tagEntries) {
        if (matchedTags.has(entry.name)) continue;
        if (entry.tokens.some((t) => termTokenSet.has(t))) {
          matchedTags.add(entry.name);
        }
      }
    }

    if (matchedTags.size === 0) return { results: [], matchedTags: [] };

    // Cap at 3 tags -- AniList's tag_in is an OR match across the list, so
    // adding more tags widens the pool rather than narrowing it. 3 keeps
    // the browse thematically tight, same reasoning as MAX_MOOD_GENRES
    // above for genre boosting. Not yet tuned against a broad real-query
    // sample -- flagged the same way MOOD_GENRE_INCLUSION_THRESHOLD/
    // TITLE_SIMILARITY_THRESHOLD were, as something to validate later.
    const tagsToQuery = [...matchedTags].slice(0, 3);
    const results = await fetchAniListMediaByTags(tagsToQuery, 15);
    return { results, matchedTags: tagsToQuery };
  } catch (err) {
    console.error('[manga] mood tag candidate resolution failed', err);
    return { results: [], matchedTags: [] };
  }
}

async function runManga({ query, filters, supabase }) {
  const cleanQuery = normalize(query || '');
  const queryTokens = normalizeAndTokenize(query || '');
  const mood = await computeMoodSignal(
    supabase,
    query || '',
    Deno.env.get('GROQ_API_KEY'),
    Deno.env.get('CEREBRAS_API_KEY')
  );
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
  // Entry 49 gap #3. Computed once, reused in both the fan-out and normal
  // rankResults() call sites below -- same pattern as routing/acclaim
  // above. null for the overwhelming majority of queries (no conjunction
  // detected), in which case rankResults.js's conjunction bonus is 0 and
  // ranking is completely unaffected.
  const conjunctiveClusters = mood ? detectConjunctiveClusters(mood.aggregate) : null;
  const classification = await computeQueryClassification(supabase, query || '', mood ? mood.matchedTerms : []);
  // Entry 35/40. Reuses the mood signal already computed above (acclaim is
  // just another emotion key in the same lexicon table -- see
  // acclaimScoring.js's header comment) plus a Groq fallback for
  // paraphrased acclaim language the lexicon wasn't seeded for. Fails
  // closed to { intensity: 0, source: null } on any error/missing key, so
  // this can never block or degrade a search that isn't asking for it.
  const acclaim = await computeAcclaimIntensity(mood, query || '', Deno.env.get('GROQ_API_KEY'), supabase);
  const { page, limit } = resolvePagination(filters);

  // Entry 49 gap #4: "like X" reference-title detection. Skipped when the
  // query already IS a strong title search on its own (classification.
  // hasStrongTitleMatch) -- a plain "Vagabond" query shouldn't be routed
  // through the "is there a REFERENCE to a title buried in this sentence"
  // path at all, that's just a title search and already works.
  const reference = classification.hasStrongTitleMatch
    ? null
    : await detectReferenceTitle(supabase, query || '');
  const referenceResolution = await resolveReferenceTitle(reference, cleanQuery, filters);

  let plan = referenceResolution.plan || buildBasicPlan(cleanQuery, filters);
  if (!referenceResolution.plan) {
    plan = applyMoodGenreRouting(plan, cleanQuery, filters, routing, classification, negatedExcludeGenres);
  }

  // FIX 2026-07-19 (Notion "Backend Update List" Entry 53): a literal genre
  // word typed in free text ("Sports manga that will make me cry") was
  // detected by the classifier but never reached the fetch step at all --
  // only filters.genres (explicit panel selection) and mood-routing's
  // topGenres (Entry 32) ever populated primaryGenres. Skipped when there's
  // already an explicit genre-filter selection (that takes precedence),
  // when a "like X" reference title was resolved (different candidate-pool
  // strategy entirely, genre words in the modifier clause stay ranking-
  // only same as before), or when the query is itself a strong title
  // search. Merged with (not replacing) whatever mood-derived genres
  // already ended up in plan.primaryGenres above. genreOnlyTerms is
  // already correctly-cased for AniList (harvested directly from AniList's
  // own genre vocabulary via lexicon_entities), so no Entry-52-style case
  // translation is needed here -- toAniListGenre() in anilist.js passes
  // already-correct names straight through unchanged either way.
  const hasExplicitGenreFilter = Array.isArray(filters?.genres) && filters.genres.length > 0;
  if (
    !hasExplicitGenreFilter &&
    !referenceResolution.plan &&
    !classification.hasStrongTitleMatch &&
    classification.genreOnlyTerms.length > 0
  ) {
    plan.primaryGenres = [...new Set([...(plan.primaryGenres || []), ...classification.genreOnlyTerms])];
  }

  // Exclusion-system pass: classification.negatedGenreTerms folded in
  // alongside the two existing exclusion sources (mood-word negation via
  // Entry 39, and filter-panel excludedGenres via buildBasicPlan's default
  // branch / buildPlanFromGenreList). This is what makes "anything except
  // horror" actually exclude Horror at the fetch level -- see
  // computeQueryClassification() above and queryClassifier.js's
  // getNegatedGenreTerms().
  if (routing.excludeGenres.length > 0 || negatedExcludeGenres.length > 0 || classification.negatedGenreTerms.length > 0) {
    plan.excludedGenres = [...new Set([
      ...(plan.excludedGenres || []),
      ...routing.excludeGenres,
      ...negatedExcludeGenres,
      ...classification.negatedGenreTerms,
    ])];
  }

  const moodMatchedTerms = mood ? mood.matchedTerms : [];

  const fanOut = !!filters?.fanOut;

  // Entry 59 fix. Skipped in fan-out mode for the same reason referenceTitle
  // is (Advanced Filter's filters-only request shape has no free text for
  // the mood pipeline to have generated keywords from in the first place --
  // moodMatchedTerms is already empty by construction there, so this call
  // would be a guaranteed no-op; not calling it at all avoids an
  // unnecessary warmCache()/AniList round trip on that path).
  const moodTagResolution = fanOut
    ? { results: [], matchedTags: [] }
    : await resolveMoodTagCandidates(supabase, moodMatchedTerms);

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
      acclaimIntensity: acclaim.intensity,
      conjunctiveClusters,
      hasStrongTitleMatch: classification.hasStrongTitleMatch,
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
      acclaim,
      // Entry 49 gap #4 not wired into fan-out mode: Advanced Filter's
      // request shape (filters-only, per Entries 12/16/25/26) doesn't
      // carry the kind of free-text "like X" sentence this feature reads,
      // so there's nothing to detect here. Kept in the response shape for
      // consistency with the normal path below rather than omitting the
      // key entirely.
      referenceTitle: null,
      moodTags: null,
    };
  }

  const accumulated = [];
  const seenTitles = new Set();
  const contributingSources = [];
  let anySourceHadFullRawPage = false;

  // Entry 49 gap #4. If referenceTitle.js confirmed a reference AND
  // AniList had curated recommendations for it, those recommendations
  // ARE the candidate pool -- seeded first so the waterfall below only
  // tops up the remainder (and is skipped entirely once `limit` is hit,
  // same "stop once we have enough" behavior the waterfall already has
  // for its own sources). This is deliberately additive to the existing
  // MANGA_SOURCES loop rather than a separate return path, so status/
  // minScore/chapter filters, dedup-by-title, and hasMore all still work
  // exactly as before for whatever isn't covered by recommendations.
  if (referenceResolution.results && referenceResolution.results.length > 0) {
    const filtered = applyPostFetchFilters(referenceResolution.results, filters) || [];
    let contributed = false;
    for (const item of filtered) {
      if (accumulated.length >= limit) break;
      const key = normalizeTitleKey(item);
      if (key && seenTitles.has(key)) continue;
      if (key) seenTitles.add(key);
      accumulated.push(item);
      contributed = true;
    }
    if (contributed) contributingSources.push('anilist-recommendations');
  }

  // Entry 59 fix. Seeded second -- after the higher-precision "like X"
  // reference-title recommendations (a confirmed specific-title match beats
  // a broader mood/tag match), before the generic genre_in waterfall. Same
  // additive shape as the block above: dedup by title, stop once `limit`
  // is hit, contributes its own named source rather than being folded into
  // an existing one so aiPanel.js's reasoning trail (and this response's
  // `source` field) can show a "comfort" query actually pulled from
  // AniList's tag_in browse rather than the plain genre waterfall.
  if (moodTagResolution.results && moodTagResolution.results.length > 0) {
    const filtered = applyPostFetchFilters(moodTagResolution.results, filters) || [];
    let contributed = false;
    for (const item of filtered) {
      if (accumulated.length >= limit) break;
      const key = normalizeTitleKey(item);
      if (key && seenTitles.has(key)) continue;
      if (key) seenTitles.add(key);
      accumulated.push(item);
      contributed = true;
    }
    if (contributed) contributingSources.push('anilist-mood-tags');
  }

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

  // Entry 49 gap #4 response metadata -- surfaced the same way mood/
  // routing/classification already are, for aiPanel.js's reasoning trail
  // and for debugging which of resolveReferenceTitle()'s three outcomes
  // fired. `null` whenever no reference was detected (the overwhelming
  // majority of queries), so this is additive-only for every existing
  // caller that doesn't read the field.
  const referenceTitle = reference
    ? {
        matchedPhrase: reference.matchedPhrase,
        matchedTitle: reference.title,
        matchScore: reference.score,
        resolvedAniListId: referenceResolution.resolvedMedia?.id ?? null,
        usedRecommendations: !!(referenceResolution.results && referenceResolution.results.length > 0),
        usedGenreFallback: !!referenceResolution.plan,
      }
    : null;

  // Entry 59 response metadata -- same reasoning as referenceTitle just
  // above: null whenever no tag match fired (the overwhelming majority of
  // non-mood queries, and any mood query whose keywords didn't overlap the
  // ~420-tag vocab), so this is additive-only for existing callers.
  const moodTags = moodTagResolution.matchedTags.length > 0 ? moodTagResolution.matchedTags : null;

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
      acclaimIntensity: acclaim.intensity,
      conjunctiveClusters,
      hasStrongTitleMatch: classification.hasStrongTitleMatch,
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
      acclaim,
      referenceTitle,
      moodTags,
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
    referenceTitle,
    acclaim,
    moodTags,
  };
}

export const DOMAINS = {
  manga: {
    ttlSeconds: 60 * 60 * 6,
    run: runManga
  }
};
