// SAVE AS: engine/supabase/functions/search/adapters/kitsu.js

// ==========================================
// KITSU FALLBACK ENGINE (js/kitsu.js) 
// ==========================================
// CHANGED: now consumes a SearchPlan (js/parser/searchPlanner.js) instead of
// the simple parser's parsedData. KITSU_STATUS_MAP/STATUS_TO_KITSU and the
// overall request-building logic are unchanged.
// Public API, no key required — base URL is overridable via env var,
// works with zero config.
const KITSU_URL = Deno.env.get('KITSU_URL') || 'https://kitsu.io/api/edge';

const KITSU_STATUS_MAP = {
    'current': 'RELEASING', 
    'finished': 'FINISHED',
    'tba': 'NOT_YET_RELEASED',
    'unreleased': 'NOT_YET_RELEASED', 
    'upcoming': 'NOT_YET_RELEASED'
};

const STATUS_TO_KITSU = {
    FINISHED: 'finished',
    RELEASING: 'current',
    NOT_YET_RELEASED: 'upcoming'
};

/**
 * @param {import('./parser/searchPlanner.js').SearchPlan} plan
 * @param {number} page
 * @param {number} limit
 */
export async function fetchFromKitsuFallback(plan, page = 1, limit = 10) {
    const params = new URLSearchParams();
    
    const offset = (page - 1) * limit;
    params.set('page[limit]', limit);
    params.set('page[offset]', offset);

    // Kitsu has no rating-sort equivalent as clean as AniList's SCORE_DESC;
    // -averageRating is the closest field. Keep -userCount (popularity) as
    // the default to match the original behavior.
    params.set('sort', plan.filters?.sort === 'rating' ? '-averageRating' : '-userCount');

    const genreList = [...(plan.primaryGenres || []), ...(plan.secondaryThemes || [])];
    const isGenreSearch = genreList.length > 0;
    const freeText = (plan.cleanQuery || '').trim();

    if (isGenreSearch) {
        const categories = genreList.map(g => g.trim().toLowerCase()).filter(Boolean);
        if (categories.length > 0) {
            params.set('filter[categories]', categories.join(','));
        }
    } else if (freeText.length > 0) {
        params.set('filter[text]', freeText);
    }

    // NOTE: Kitsu's JSON:API filtering doesn't support a clean "exclude
    // category" filter the way AniList/Jikan do, so plan.excludedGenres is
    // intentionally not applied here — Kitsu results may include an
    // excluded genre. This mirrors a real limitation of the Kitsu API,
    // not an oversight.

    if (plan.filters?.statusFilter && STATUS_TO_KITSU[plan.filters.statusFilter]) {
        params.set('filter[status]', STATUS_TO_KITSU[plan.filters.statusFilter]);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
        const response = await fetch(`${KITSU_URL}/manga?${params.toString()}`, {
            headers: {
                'Accept': 'application/vnd.api+json',
                'Content-Type': 'application/vnd.api+json'
            },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            console.error(`Kitsu API returned HTTP ${response.status}`);
            return [];
        }

        const data = await response.json();
        if (!data.data || !Array.isArray(data.data)) return [];

        return data.data.map(m => {
            const attr = m.attributes;
            return {
                id: `kitsu-${m.id}`,
                title: { 
                    romaji: attr.titles.en_jp || attr.canonicalTitle, 
                    english: attr.titles.en || attr.titles.en_us || attr.canonicalTitle 
                },
                averageScore: attr.averageRating ? Math.round(parseFloat(attr.averageRating)) : null,
                // NEW: userCount is Kitsu's own "higher is more popular" count.
                popularity: typeof attr.userCount === 'number' ? attr.userCount : null,
                genres: [], 
                description: attr.synopsis || null,
                coverImage: { large: attr.posterImage?.large || attr.posterImage?.original || null },
                chapters: attr.chapterCount || null,
                status: KITSU_STATUS_MAP[attr.status] || attr.status
            };
        });
    } catch (error) {
        clearTimeout(timeout);
        console.error("Kitsu API Error:", error);
        return [];
    }
}

