// SAVE AS: engine/supabase/functions/search/adapters/mangadex.js

// ==========================================
// MANGADEX FALLBACK ENGINE (js/mangadex.js)
// ==========================================
// PORTED from the old engine's fetchFromMangaDexFallback(). Now consumes a
// SearchPlan (parser/searchPlanner.js) instead of the old parsedData shape,
// matching anilist.js/jikan.js/kitsu.js. CONFIG.MANGADEX_API / .env's
// hardcoded URLs are replaced with the same Deno.env.get(...) + public
// default pattern jikan.js/kitsu.js already use.
//
// NOT ported: resolveReadLinks()/getFallbackLinks()/suggestTitlesFromMangaDex()
// and the Firestore read-links cache. Those aren't search-source lookups —
// they resolve a "read now" link for a single already-chosen title and
// depend on the frontend's Firestore `cache` collection, which this engine
// doesn't have (it has its own domain-agnostic search_cache in Postgres —
// see cache.js/README section 2). Same call as comick.js/shikimoriClient.js/
// aiPanel.js in README section 4: out of scope for the /search request path.
// Public API, no key required — base URL is overridable via env var, works
// with zero config.
const MANGADEX_URL = Deno.env.get('MANGADEX_URL') || 'https://api.mangadex.org';
const MANGADEX_COVER_URL = Deno.env.get('MANGADEX_COVER_URL') || 'https://uploads.mangadex.org/covers';

// MangaDex requires specific UUIDs for genres/themes, not names.
const MD_TAG_MAP = {
    action: '391b0423-d847-456f-aff0-8b8a41bdfeaf',
    adventure: '87cc87cd-a395-47af-bf47-b32d4318e3df',
    comedy: '4d32cc48-9f00-4cca-9b5a-a839f0764984',
    drama: 'b9af3a63-f058-46de-a9a0-e0c13906197a',
    fantasy: 'cdc58593-87dd-415e-bbc0-2ec27bf404cc',
    horror: 'cdad7e68-1419-41dd-bdce-27753074a640',
    mystery: 'ee968100-4191-4968-94d3-f3f62e40044a',
    psychological: '3b60b75c-a2d7-4860-ab56-05f391bb889c',
    romance: '423e2eae-a7a2-4a8b-ac03-a8351462d71d',
    scifi: '256c8bd9-4904-4360-bf4f-508a76d67183',
    sliceoflife: 'e5301a23-ebd9-49dd-a0cb-2add944c0d04',
    sports: '69b626e5-4d74-4b55-a2a0-40a23277beff',
    supernatural: 'eabc5b4c-6aff-42f3-b657-3e90cbd00b75',
    thriller: '07251805-a27e-4d59-b468-232d5f80ef16'
};

const MD_STATUS_MAP = {
    FINISHED: 'completed',
    RELEASING: 'ongoing',
    HIATUS: 'hiatus',
    CANCELLED: 'cancelled'
};

const REVERSE_MD_STATUS = {
    completed: 'FINISHED',
    ongoing: 'RELEASING',
    hiatus: 'HIATUS',
    cancelled: 'CANCELLED'
};

function toTagKey(name) {
    return name.trim().toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * @param {import('../parser/searchPlanner.js').SearchPlan} plan
 * @param {number} page
 * @param {number} limit
 */
export async function fetchFromMangaDexFallback(plan, page = 1, limit = 10) {
    const params = new URLSearchParams();
    params.set('limit', limit);
    params.set('offset', (page - 1) * limit);
    params.append('includes[]', 'cover_art');
    params.set('availableTranslatedLanguage[]', 'en');

    const genreList = [...(plan.primaryGenres || []), ...(plan.secondaryThemes || [])];
    const isGenreSearch = genreList.length > 0;
    const freeText = (plan.cleanQuery || '').trim();

    if (isGenreSearch) {
        const tagIds = genreList
            .map(toTagKey)
            .map(g => MD_TAG_MAP[g])
            .filter(Boolean);

        tagIds.forEach(id => params.append('includedTags[]', id));

        if (plan.filters?.sort === 'rating') {
            params.set('order[rating]', 'desc');
        } else {
            params.set('order[followedCount]', 'desc'); // Sort by most popular
        }
    } else if (freeText.length > 0) {
        params.set('title', freeText);
        params.set('order[relevance]', 'desc');
    }

    // Exclude genres the planner flagged as avoids, where MangaDex has a tag UUID for them.
    if (plan.excludedGenres && plan.excludedGenres.length > 0) {
        const excludeIds = plan.excludedGenres
            .map(toTagKey)
            .map(g => MD_TAG_MAP[g])
            .filter(Boolean);
        excludeIds.forEach(id => params.append('excludedTags[]', id));
    }

    if (plan.filters?.statusFilter && MD_STATUS_MAP[plan.filters.statusFilter]) {
        params.append('status[]', MD_STATUS_MAP[plan.filters.statusFilter]);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout for heavy DB searches

    try {
        const response = await fetch(`${MANGADEX_URL}/manga?${params.toString()}`, {
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            console.error(`MangaDex API returned HTTP ${response.status}`);
            return [];
        }

        const data = await response.json();
        if (!data.data || !Array.isArray(data.data)) return [];

        return data.data.map(m => {
            // Bomb-proofed: defaults to empty objects/arrays if MangaDex is missing data.
            const attr = m.attributes || {};
            const rels = m.relationships || [];

            const coverRel = rels.find(rel => rel?.type === 'cover_art');
            const coverFile = coverRel?.attributes?.fileName;
            const coverUrl = coverFile ? `${MANGADEX_COVER_URL}/${m.id}/${coverFile}` : null;

            // MangaDex tags each entry by `group` (genre vs theme) — kept
            // separate rather than merged into one array.
            const tags = attr.tags || [];
            const genres = tags
                .filter(t => t?.attributes?.group === 'genre')
                .map(t => t?.attributes?.name?.en)
                .filter(Boolean);
            const themes = tags
                .filter(t => t?.attributes?.group === 'theme')
                .map(t => t?.attributes?.name?.en)
                .filter(Boolean);

            const titleObj = attr.title || {};
            const altTitles = attr.altTitles || [];
            const engAltTitle = altTitles.find(t => t?.en)?.en;

            const descObj = attr.description || {};

            return {
                id: `mangadex-${m.id}`,
                title: {
                    english: titleObj.en || engAltTitle || Object.values(titleObj)[0] || 'Unknown Title',
                    romaji: titleObj['ja-ro'] || null
                },
                averageScore: null, // Skipped for speed (requires a secondary /statistics call)
                // popularity: intentionally omitted, same reasoning as averageScore
                // above — normalizeResult() defaults this to null, which is
                // accurate here, not a bug.
                genres,
                themes,
                // publicationDemographic is a single value (e.g. "shounen"),
                // wrapped in an array to match the other adapters' shape.
                demographics: attr.publicationDemographic ? [attr.publicationDemographic] : [],
                description: descObj.en || null,
                coverImage: { large: coverUrl },
                chapters: attr.lastChapter || null,
                status: REVERSE_MD_STATUS[attr.status] || attr.status || 'Unknown'
            };
        });
    } catch (error) {
        clearTimeout(timeout);
        console.error('MangaDex API Error:', error);
        return [];
    }
}

