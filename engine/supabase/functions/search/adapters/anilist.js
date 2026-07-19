// ==========================================
// ANILIST API ENGINE (js/anilist.js)
// ==========================================
// CHANGED: now consumes a SearchPlan (js/parser/searchPlanner.js) instead of
// the simple parser's { cleanQuery, statusFilter, isVibeOrTag }. The old
// top-level parser.js / parseSmartQuery import is kept as a re-export only
// for any other file that may still depend on it — it's no longer used here.
//
// CHANGED (READLINKS_UPGRADE_PLAN.md Step 8): the media query now also
// requests `staff` (sorted by relevance, capped at 3 entries -- AniList
// lists creators first, so the top entry is almost always the actual
// author/artist rather than a minor contributor). resultNormalizer.js
// reads this into item.author, which Step 1's Google fallback query
// already knew how to use the moment it existed (it was written to
// degrade gracefully with author omitted until this step landed).
// Jikan/Kitsu/MangaDex results simply have no `staff` property on their
// raw media objects, so resultNormalizer.js's extraction resolves to null
// for those sources -- no adapter-specific branching needed there.
/**
 * @param {import('./parser/searchPlanner.js').SearchPlan} plan
 * @param {number} page
 * @param {boolean} isKorean - restrict to countryOfOrigin: KR (used for the
 *   dual Korean/global fetch in search.js when the plan is genre-driven)
 * @param {number} limit
 */
export async function fetchFromAniListUnified(plan, page = 1, isKorean = false, limit = 10) {
    // Country enum must be raw (unquoted), not a string
    const countryFilter = isKorean ? ', countryOfOrigin: "KR"' : '';
    let queryArgs = `$page: Int, $perPage: Int`;

    let mediaArgs = `type: MANGA, isAdult: false${countryFilter}`;
    let variables = { page: page, perPage: limit };

    // A plan is "genre-driven" if the planner surfaced any primary genres or
    // secondary themes (both are AniList genre strings post-normalization —
    // AniList doesn't distinguish "genre" from "theme" the way our intent
    // object does, so we search on the union of both).
    const genreList = [...(plan.primaryGenres || []), ...(plan.secondaryThemes || [])];
    const isGenreSearch = genreList.length > 0;
    const freeText = (plan.cleanQuery || '').trim();

    if (isGenreSearch) {
        queryArgs += `, $genres: [String]`;
        mediaArgs += `, genre_in: $genres`;
        variables.genres = genreList;
    } else if (freeText.length > 0) {
        queryArgs += `, $search: String`;
        mediaArgs += `, search: $search`;
        variables.search = freeText;
    }
    // else: blank query (default page load / browse) — no search/genre_in arg at all

    // NEW: exclude genres the planner determined should be avoided (mood-based
    // avoids + explicit "no romance"-style negations, per ruleEngine.js/pipeline.js)
    if (plan.excludedGenres && plan.excludedGenres.length > 0) {
        queryArgs += `, $excludedGenres: [String]`;
        mediaArgs += `, genre_not_in: $excludedGenres`;
        variables.excludedGenres = plan.excludedGenres;
    }

    if (plan.filters?.statusFilter) {
        queryArgs += `, $status: MediaStatus`;
        mediaArgs += `, status: $status`;
        variables.status = plan.filters.statusFilter;
    }

    // Sort: preserves the original defaults (POPULARITY_DESC for genre/blank
    // search, [SEARCH_MATCH, POPULARITY_DESC] for free text) and adds
    // explicit "rating"/"trending"/"date" options now that the planner can
    // request them.
    // FIX: 'trending' and 'date' used to fall through to the generic
    // POPULARITY_DESC branch below, silently making Trending Today
    // identical to a plain popularity sort, and making New Releases'
    // "newest first" request a no-op (compounded by startDate never being
    // requested at all — see the query string below).
    let sortValues;
    if (plan.filters?.sort === 'rating') {
        sortValues = ['SCORE_DESC'];
    } else if (plan.filters?.sort === 'trending') {
        sortValues = ['TRENDING_DESC'];
    } else if (plan.filters?.sort === 'date') {
        sortValues = ['START_DATE_DESC'];
    } else if (isGenreSearch || !variables.search) {
        sortValues = ['POPULARITY_DESC'];
    } else {
        sortValues = ['SEARCH_MATCH', 'POPULARITY_DESC'];
    }
    mediaArgs += `, sort: [${sortValues.join(', ')}]`;

    const query = `
        query (${queryArgs}) {
            Page(page: $page, perPage: $perPage) {
                media(${mediaArgs}) {
                    id title { romaji english } averageScore genres description(asHtml: false) coverImage { large } chapters status popularity startDate { year month day }
                    staff(sort: RELEVANCE, perPage: 3) { edges { role node { name { full } } } }
                }
            }
        }
    `;

    try {
        const response = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables })
        });

        if (!response.ok) {
            console.error(`AniList API returned HTTP ${response.status}`);
            return [];
        }

        const data = await response.json();

        if (data.errors) {
            console.error("AniList GraphQL Error:", data.errors);
            return [];
        }

        const media = data.data ? data.data.Page.media : [];

        // FIX: fetch.js's fetchNewReleases() reads m.releaseDate directly,
        // but AniList only ever gave us startDate:{year,month,day} — that
        // field was always undefined, so the client-side "newest first"
        // sort had nothing to sort and New Releases just showed whatever
        // POPULARITY_DESC happened to return. Build a real ISO date (or
        // null if AniList hasn't set one, e.g. an unannounced release).
        return media.map(m => {
            const sd = m.startDate;
            const releaseDate = (sd && sd.year)
                ? `${sd.year}-${String(sd.month || 1).padStart(2, '0')}-${String(sd.day || 1).padStart(2, '0')}`
                : null;
            return { ...m, releaseDate };
        });
    } catch (error) {
        console.error("AniList API Error:", error);
        return [];
    }
}

// ==========================================
// New 2026-07-19 -- Entry 49 gap #4 (referenceTitle.js). Two small,
// single-media queries (not Page-based like the search above) used only
// when domains.js has already confirmed a "like X" reference against the
// real TITLE vocab and needs to (a) resolve X to an AniList id, then
// (b) pull AniList's own curated "if you liked X, you'll like Y"
// recommendations edge -- real user-curated similarity data, which is a
// much better signal for "similar to a specific title" than genre
// overlap could ever be, and doesn't require the embedding infra Entry
// 31/40 flagged as a bigger, unbuilt project.
// ==========================================

function buildReleaseDate(startDate) {
    if (!startDate || !startDate.year) return null;
    return `${startDate.year}-${String(startDate.month || 1).padStart(2, '0')}-${String(startDate.day || 1).padStart(2, '0')}`;
}

const MEDIA_FIELDS = `
    id title { romaji english } averageScore genres description(asHtml: false) coverImage { large } chapters status popularity startDate { year month day }
    staff(sort: RELEVANCE, perPage: 3) { edges { role node { name { full } } } }
`;

/**
 * Resolves a confirmed reference-title string (already matched against
 * lexicon_entities by referenceTitle.js -- this is NOT a free-text search
 * against unverified user input) to its single best AniList media id.
 * Returns null on no match, HTTP failure, or GraphQL error -- callers
 * must degrade gracefully (fall back to the pre-existing waterfall), same
 * as every other adapter failure path in this file.
 */
export async function fetchAniListMediaBySearch(title) {
    if (!title) return null;

    const query = `
        query ($search: String) {
            Media(search: $search, type: MANGA, isAdult: false, sort: [SEARCH_MATCH]) {
                id
                title { romaji english }
                genres
            }
        }
    `;

    try {
        const response = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { search: title } })
        });

        if (!response.ok) {
            console.error(`AniList API returned HTTP ${response.status} (media lookup)`);
            return null;
        }

        const data = await response.json();
        if (data.errors || !data.data?.Media) {
            if (data.errors) console.error("AniList GraphQL Error (media lookup):", data.errors);
            return null;
        }

        return data.data.Media;
    } catch (error) {
        console.error("AniList API Error (media lookup):", error);
        return null;
    }
}

/**
 * Pulls AniList's own `recommendations` edge for a resolved media id,
 * sorted by community RATING_DESC (AniList's own vote-weighted ordering,
 * not something this project computes). Maps each node to the same flat
 * result shape fetchFromAniListUnified() returns (including the same
 * releaseDate construction) so domains.js/rankResults.js/resultNormalizer.js
 * don't need a second code path to consume these.
 */
export async function fetchAniListRecommendations(mediaId, limit = 10) {
    if (!mediaId) return [];

    const query = `
        query ($id: Int, $perPage: Int) {
            Media(id: $id, type: MANGA) {
                recommendations(sort: [RATING_DESC], perPage: $perPage) {
                    nodes {
                        mediaRecommendation { ${MEDIA_FIELDS} }
                    }
                }
            }
        }
    `;

    try {
        const response = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { id: mediaId, perPage: limit } })
        });

        if (!response.ok) {
            console.error(`AniList API returned HTTP ${response.status} (recommendations)`);
            return [];
        }

        const data = await response.json();
        if (data.errors || !data.data?.Media) {
            if (data.errors) console.error("AniList GraphQL Error (recommendations):", data.errors);
            return [];
        }

        const nodes = data.data.Media.recommendations?.nodes || [];
        return nodes
            .map((n) => n.mediaRecommendation)
            // AniList returns a null mediaRecommendation for a recommended
            // entry that's since been deleted/made private -- drop those
            // rather than passing a hole through to the normalizer.
            .filter(Boolean)
            .map((m) => ({ ...m, releaseDate: buildReleaseDate(m.startDate) }));
    } catch (error) {
        console.error("AniList API Error (recommendations):", error);
        return [];
    }
}
