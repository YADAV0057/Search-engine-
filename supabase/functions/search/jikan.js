// ==========================================
// JIKAN (MyAnimeList) FALLBACK ENGINE (js/jikan.js) 
// ==========================================
// CHANGED: now consumes a SearchPlan (js/parser/searchPlanner.js) instead of
// the simple parser's parsedData. GENRE_ID_MAP, STATUS_TO_JIKAN, and the
// overall request-building logic are unchanged.
// Public API, no key required — base URL is overridable via env var in
// case Jikan ever needs a mirror/proxy, but works with zero config.
const JIKAN_URL = Deno.env.get('JIKAN_URL') || 'https://api.jikan.moe/v4';

const GENRE_ID_MAP = {
    action: 1, adventure: 2, comedy: 4, drama: 8, fantasy: 10, 
    horror: 14, mystery: 7, psychological: 40, romance: 22, scifi: 24,
    sliceoflife: 36, sports: 30, supernatural: 37, thriller: 45,
    mecha: 18, music: 19, mahoushoujo: 66
};

const STATUS_TO_JIKAN = {
    FINISHED: 'complete',
    RELEASING: 'publishing',
    HIATUS: 'hiatus',
    CANCELLED: 'discontinued'
};

const JIKAN_STATUS_TO_INTERNAL = {
    'Publishing': 'RELEASING',
    'Finished': 'FINISHED',
    'On Hiatus': 'HIATUS',
    'Discontinued': 'CANCELLED',
    'Not yet published': 'NOT_YET_RELEASED'
};

/**
 * Normalizes a genre/theme display name (e.g. "Slice of Life", "Sci-Fi")
 * into the lookup key GENRE_ID_MAP uses.
 */
function toGenreKey(name) {
    return name.trim().toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * @param {import('./parser/searchPlanner.js').SearchPlan} plan
 * @param {number} page
 * @param {number} limit
 */
export async function fetchFromJikanFallback(plan, page = 1, limit = 10) {
    const params = new URLSearchParams();
    params.set('page', page);
    params.set('limit', Math.min(limit, 25));

    const genreList = [...(plan.primaryGenres || []), ...(plan.secondaryThemes || [])];
    const isGenreSearch = genreList.length > 0;
    const freeText = (plan.cleanQuery || '').trim();

    // Jikan doesn't have an equivalent to AniList's SEARCH_MATCH, so keep the
    // original default (popularity) unless the plan explicitly asked for rating.
    if (plan.filters?.sort === 'rating') {
        params.set('order_by', 'score');
        params.set('sort', 'desc');
    } else {
        params.set('order_by', 'popularity');
        params.set('sort', 'asc'); // Jikan's popularity rank is ascending = more popular
    }

    if (isGenreSearch) {
        const ids = genreList
            .map(toGenreKey)
            .map(g => GENRE_ID_MAP[g])
            .filter(Boolean);
        if (ids.length > 0) params.set('genres', ids.join(','));
    } else if (freeText.length > 0) {
        params.set('q', freeText);
    }

    // NEW: exclude genres the planner flagged as avoids, where Jikan has an ID for them
    if (plan.excludedGenres && plan.excludedGenres.length > 0) {
        const excludeIds = plan.excludedGenres
            .map(toGenreKey)
            .map(g => GENRE_ID_MAP[g])
            .filter(Boolean);
        if (excludeIds.length > 0) params.set('genres_exclude', excludeIds.join(','));
    }

    if (plan.filters?.statusFilter && STATUS_TO_JIKAN[plan.filters.statusFilter]) {
        params.set('status', STATUS_TO_JIKAN[plan.filters.statusFilter]);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
        const response = await fetch(`${JIKAN_URL}/manga?${params.toString()}`, {
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            console.error(`Jikan API returned HTTP ${response.status}`);
            return [];
        }

        const data = await response.json();
        if (!data.data || !Array.isArray(data.data)) return [];

        return data.data.map(m => ({
            id: `jikan-${m.mal_id}`,
            title: { romaji: m.title, english: m.title_english || m.title },
            averageScore: m.score ? Math.round(m.score * 10) : null,
            genres: (m.genres || []).map(g => g.name),
            // NEW: Jikan's `members` = count of users who list this manga — a
            // "higher is more popular" count, same direction as AniList's
            // `popularity` field (unlike Jikan's own `popularity` rank field,
            // which is lower-is-better and would need inverting to compare).
            popularity: typeof m.members === 'number' ? m.members : null,
            demographics: (m.demographics || []).map(d => d.name),
            description: m.synopsis || null,
            coverImage: { large: m.images?.jpg?.large_image_url || m.images?.jpg?.image_url || null },
            chapters: m.chapters || null,
            status: JIKAN_STATUS_TO_INTERNAL[m.status] || m.status
        }));
    } catch (error) {
        clearTimeout(timeout);
        console.error("Jikan API Error:", error);
        return [];
    }
}
