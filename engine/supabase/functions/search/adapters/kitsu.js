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

// Fetch each result's category (genre) data in the same request via
// JSON:API's compound-document support — avoids an extra per-result call.
params.set('include', 'categories');
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

    // FIX 2026-07-19 (Notion "Backend Update List" Entry 50's own follow-up
    // note: "kitsu.js lacks an equivalent category-filter mechanism --
    // exclusion there is weaker, worth checking during testing"). The old
    // comment here said Kitsu's JSON:API can't filter by "not category" --
    // true for the SERVER-SIDE request, but irrelevant: this function
    // already fetches `include=categories` and resolves each result's own
    // genre names into `genres` below (categoryTitleById), purely to
    // populate the response. That same data means exclusion CAN be applied
    // client-side, post-fetch, before returning -- see the filter after the
    // .map() below. Same canonical-key normalization as jikan.js's
    // toGenreKey() (lowercase, strip non-letters) so 'Slice of Life' /
    // 'sliceoflife' / any Entry-52-style routing key all compare equal
    // regardless of which upstream source produced plan.excludedGenres.
    const toGenreKey = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
    const excludedKeys = new Set((plan.excludedGenres || []).map(toGenreKey));

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

// `include=categories` puts category resources in `included`, not `data`.
// Build id -> display-name lookup once, reused for every result below.
const categoryTitleById = new Map();
for (const inc of data.included || []) {
    if (inc?.type === 'categories' && inc?.attributes?.title) {
        categoryTitleById.set(inc.id, inc.attributes.title);
    }
}

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
                genres: (m.relationships?.categories?.data || [])
    .map(ref => categoryTitleById.get(ref.id))
    .filter(Boolean), 
                description: attr.synopsis || null,
                coverImage: { large: attr.posterImage?.large || attr.posterImage?.original || null },
                chapters: attr.chapterCount || null,
                status: KITSU_STATUS_MAP[attr.status] || attr.status
            };
        }).filter(item => {
            // Entry 50 follow-up fix: hard-exclude anything carrying an
            // excluded genre, same semantics as AniList's genre_not_in and
            // Jikan's ID-exclusion -- a real filter, not a ranking nudge.
            // Caveat (not fixed here, flagging for a future session): this
            // filters AFTER Kitsu has already paginated server-side, so a
            // page that would otherwise be full can come back short if
            // several items in that page happen to carry an excluded
            // genre -- same class of "fewer results than requested" issue
            // already flagged elsewhere in this doc (Entry 29's New
            // Releases note). Kitsu is 3rd in the waterfall and only
            // reached when AniList+Jikan are both empty, so the practical
            // impact is narrow, but a real fix would need to over-fetch
            // and re-paginate rather than filter the already-paginated page.
            if (excludedKeys.size === 0) return true;
            return !item.genres.some(g => excludedKeys.has(toGenreKey(g)));
        });
    } catch (error) {
        clearTimeout(timeout);
        console.error("Kitsu API Error:", error);
        return [];
    }
}

