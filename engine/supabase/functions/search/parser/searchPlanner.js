// ==========================================
// SEARCH PLANNER (js/parser/searchPlanner.js)
// ==========================================
// PORTING NOTE: buildSearchPlan() expects a MangaIntent object shaped by
// parser/pipeline.js + parser/intentSchema.js (not part of this upload).
// The translation logic (genre/theme confidence thresholds, exclusion
// dedup, API-order fallback) is reusable as-is; the *input contract*
// needs whatever intent-building step the new engine ends up with,
// wired through the domain/niche field the new engine's API contract
// requires. buildPlanFromGenreList() has no such dependency and works
// standalone today.
// Translates a MangaIntent (the object returned by js/parser/pipeline.js's
// buildIntent()) into a flat, API-agnostic SearchPlan that the API adapters
// (anilist.js, jikan.js, kitsu.js, mangadex.js) can consume without knowing
// anything about moods, confidence scores, or the reasoning rules that
// produced them.

const GENRE_NORMALIZE = {
    SliceOfLife: "Slice of Life",
    Scifi: "Sci-Fi",
    SciFi: "Sci-Fi",
    MahouShoujo: "Mahou Shoujo"
};

function normalizeGenreName(name) {
    return GENRE_NORMALIZE[name] || name;
}

const DEFAULT_INCLUSION_THRESHOLD = 0.80;
const DEFAULT_API_ORDER = ["AniList", "Jikan", "Kitsu", "MangaDex"];

const STATUS_TO_ANILIST_ENUM = {
    completed: "FINISHED",
    ongoing: "RELEASING"
};

/**
 * @typedef {Object} SearchPlan
 * @property {string} cleanQuery
 * @property {string[]} primaryGenres
 * @property {string[]} secondaryThemes
 * @property {string[]} excludedGenres
 * @property {string[]} excludedThemes
 * @property {string[]} apiOrder
 * @property {{status: string|null, sort: string, maxChapters: number|null}} filters
 * @property {number} confidence
 */

/**
 * NEW: Direct plan builder for mood buttons to bypass NLU parser noise.
 */
export function buildPlanFromGenreList(genreQuery, options = {}) {
    const genres = (Array.isArray(genreQuery) ? genreQuery : genreQuery.split(','))
        .map(g => normalizeGenreName(g.trim()))
        .filter(Boolean);

    return {
        cleanQuery: options.cleanQuery ?? genres.join(', '),
        primaryGenres: genres,
        secondaryThemes: [],
        excludedGenres: [],
        excludedThemes: [],
        apiOrder: options.apiOrder ?? DEFAULT_API_ORDER,
        filters: { 
            status: null, 
            statusFilter: null, 
            sort: options.sort ?? "popularity", 
            maxChapters: null 
        },
        confidence: 1.0
    };
}

/**
 * Build a SearchPlan from a MangaIntent.
 */
export function buildSearchPlan(intent, options = {}) {
    if (!intent) {
        throw new Error("buildSearchPlan: intent is required");
    }

    const threshold = options.threshold ?? DEFAULT_INCLUSION_THRESHOLD;
    const includeBoosts = options.includeBoosts ?? true;

    const plan = {
        cleanQuery: intent.originalQuery || "",
        primaryGenres: [],
        secondaryThemes: [],
        excludedGenres: [],
        excludedThemes: [],
        apiOrder: (intent.searchPriority && intent.searchPriority.length > 0)
            ? intent.searchPriority
            : DEFAULT_API_ORDER,
        filters: {
            status: intent.status || null,
            statusFilter: STATUS_TO_ANILIST_ENUM[intent.status] || null,
            sort: intent.sort || "relevance",
            maxChapters: intent.maxChapters ?? null
        },
        confidence: typeof intent.confidence === "number" ? intent.confidence : 0.5
    };

    (intent.genres || []).forEach(g => {
        if (g.confidence >= threshold) {
            plan.primaryGenres.push(normalizeGenreName(g.name));
        }
    });

    (intent.themes || []).forEach(t => {
        if (t.confidence >= threshold) {
            plan.secondaryThemes.push(normalizeGenreName(t.name));
        }
    });

    if (includeBoosts) {
        (intent.boosts?.genres || []).forEach(g => {
            const name = normalizeGenreName(g.name);
            if (g.score >= threshold && !plan.primaryGenres.includes(name)) {
                plan.primaryGenres.push(name);
            }
        });
        (intent.boosts?.themes || []).forEach(t => {
            const name = normalizeGenreName(t.name);
            if (t.score >= threshold && !plan.secondaryThemes.includes(name)) {
                plan.secondaryThemes.push(name);
            }
        });
    }

    plan.excludedGenres = [...new Set((intent.avoids?.genres || []).map(normalizeGenreName))]
        .filter(g => !plan.primaryGenres.includes(g));

    plan.excludedThemes = [...new Set((intent.avoids?.themes || []).map(normalizeGenreName))]
        .filter(t => !plan.secondaryThemes.includes(t));

    return plan;
}
