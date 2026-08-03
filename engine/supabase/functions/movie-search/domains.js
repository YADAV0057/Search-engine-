// engine/supabase/functions/movie-search/domains.js 
//
// Movie-specific query planning. Deliberately NOT shared with manga's domains.js —
// see Movie Search — Architecture & UX Plan (2026-07-28) for why.
//
// STAGE 2 (2026-07-31): keyword-signature (mood) matching is now wired in.
// Previously `keywordSignature` was a permanent stub (`null`) — see git blame /
// Prioritized Next Steps (2026-07-31) item #1/#4. This resolves the free-text
// query against `movie_keyword_signatures` (genre_weights per matched mood term)
// so queries like "sad movies" or "funny movies" get real genre-weighted
// boosting instead of falling through to literal title/overview substring
// matching in rankResults.js. Falls back to the old text-only behavior
// (keywordSignature: null) if no signature rows match or supabase isn't passed.
//
// STAGE 3 (2026-08-02): fixes the bug where Stage 2's mood matching only ever
// re-ranked a candidate pool that TMDB itself had already filtered down to
// literal title/overview substring matches — because index.ts always called
// tmdb.discoverMovies() with `searchText` set, which routes to TMDB's
// /search/movie (literal text search) rather than /discover/movie (genre-based
// discovery), regardless of whether a keyword signature matched. A query like
// "sad movie" therefore only ever surfaced titles that literally contained the
// word "sad" (e.g. "Sad Silent Movie") — real sad films without "sad" in the
// title (Manchester by the Sea, The Fault in Our Stars, etc.) were never even
// fetched, so no amount of re-ranking could surface them.
//
// Fix: detect when a query is a PURE mood expression — i.e. after stripping
// noise words ("movie", "please", ...) and the matched keyword-signature
// term(s) themselves, nothing distinguishing is left over (no title fragment,
// actor name, plot description, etc.). Only in that case do we set
// `moodOnlyQuery: true` and derive `discoverGenres` from the signature's
// strongest-weighted genres. index.ts/tmdb.ts use these to route retrieval
// through /discover/movie instead of /search/movie. A query that happens to
// contain a seeded mood word AND other distinguishing text (e.g. "sad batman
// movie") is left on the literal-search path exactly as before — this only
// changes behavior for queries that are mood-only.
//
// Pattern borrowed from the manga pipeline (exclusion-term parsing, reference-title
// detection) — not the code, per Entry 89/90's lesson.

// Minimal TMDB genre name -> id map for the launch set. Extend as needed;
// TMDB's /genre/movie/list endpoint is the source of truth if this drifts.
const GENRE_NAME_TO_ID = {
  action: 28,
  adventure: 12,
  animation: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  fantasy: 14,
  history: 36,
  horror: 27,
  music: 10402,
  mystery: 9648,
  romance: 10749,
  "sci-fi": 878,
  "science fiction": 878,
  thriller: 53,
  war: 10752,
  western: 37,
};

// Words that signal the user wants to EXCLUDE a term rather than match it,
// e.g. "thriller but not gory". Mirrors the exclusion-term parsing pattern
// already proven on the manga side.
const EXCLUSION_MARKERS = ["not", "no", "without", "except", "excluding"];

function extractExclusions(rawQuery) {
  const tokens = rawQuery.toLowerCase().split(/\s+/);
  const exclusions = [];
  const keepTokens = [];

  for (let i = 0; i < tokens.length; i++) {
    if (EXCLUSION_MARKERS.includes(tokens[i]) && tokens[i + 1]) {
      exclusions.push(tokens[i + 1]);
      i++; // skip the excluded term itself
      continue;
    }
    keepTokens.push(tokens[i]);
  }

  return { cleanedQuery: keepTokens.join(" ").trim(), exclusions };
}

function matchGenresInText(text) {
  const lower = text.toLowerCase();
  const ids = [];
  for (const [name, id] of Object.entries(GENRE_NAME_TO_ID)) {
    if (lower.includes(name) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Stopwords stripped before we look for mood/keyword-signature matches, so
// "sad movies" and "funny movie" reduce to the actual mood token ("sad",
// "funny") rather than requiring the literal phrase "sad movies" to exist
// as a row. This is intentionally tiny — just enough to unblock the common
// "<mood> movie(s)" / "<mood> film(s)" phrasing seen in QA — not a general
// stopword list.
const NOISE_WORDS = new Set(["movie", "movies", "film", "films", "a", "some", "please", "me", "show", "find"]);

// Strips trailing/leading punctuation (straight/curly quotes, commas, etc.)
// from a token before comparing it against NOISE_WORDS or a matched
// signature term. Without this, a stray character appended by the frontend
// (e.g. a query arriving as `sad movie"`) produces a token like `movie"`
// that doesn't match the `movie` entry in NOISE_WORDS, silently defeating
// the noise-word strip and, before this stage, defeating moodOnlyQuery
// detection below too.
function stripPunctuation(word) {
  return word.replace(/^[\s"'“”‘’.,!?;:()]+|[\s"'“”‘’.,!?;:()]+$/g, "");
}

function candidateMoodTokens(cleanedQuery) {
  const words = cleanedQuery
    .toLowerCase()
    .split(/\s+/)
    .map(stripPunctuation)
    .filter((w) => w && !NOISE_WORDS.has(w));

  // Both individual words and the full stripped phrase are candidates —
  // covers single-word moods ("sad") and multi-word signature terms already
  // seeded ("mind bending", "coming of age") without requiring "movies" etc.
  // to have been stripped out of THOSE first (they don't contain noise words).
  const phrase = words.join(" ");
  const tokens = new Set(words);
  if (phrase) tokens.add(phrase);
  // Also try the raw cleaned query un-stripped, in case a seeded term
  // legitimately contains a noise word (none currently do, but cheap to cover).
  if (cleanedQuery.trim()) tokens.add(cleanedQuery.trim().toLowerCase());
  return [...tokens].filter(Boolean);
}

/**
 * Looks up `movie_keyword_signatures` for any row whose normalized_term or
 * aliases match a token/phrase derived from the query. Merges genre_weights
 * across all matches (summed) into TMDB genre ids for use by the ranker.
 *
 * Returns null (not an empty object) when nothing matches, so callers can
 * cheaply check `if (keywordSignature)` — mirrors rankResults.js's existing
 * hasAnySemanticScore-style "only trust this signal if it's actually present"
 * gating pattern.
 */
async function matchKeywordSignature(supabase, cleanedQuery) {
  if (!supabase || !cleanedQuery) return null;

  const tokens = candidateMoodTokens(cleanedQuery);
  if (tokens.length === 0) return null;

  try {
    const { data, error } = await supabase
      .from("movie_keyword_signatures")
      .select("normalized_term, term, aliases, genre_weights, tag_weights")
      .or(`normalized_term.in.(${tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(",")}),aliases.ov.{${tokens.map((t) => t.replace(/[{},]/g, "")).join(",")}}`);

    if (error) {
      console.error("[movie-search/domains] keyword-signature lookup failed:", error);
      return null;
    }
    if (!data || data.length === 0) return null;

    // Merge genre_weights across every matched signature row (summed, not
    // averaged — a query matching two moods that both point at Drama should
    // boost Drama more than a query matching only one).
    const genreWeights = {};
    const matchedTerms = [];
    for (const row of data) {
      matchedTerms.push(row.normalized_term);
      for (const [genreName, weight] of Object.entries(row.genre_weights ?? {})) {
        const id = GENRE_NAME_TO_ID[genreName.toLowerCase()];
        if (id == null) continue; // seeded genre name doesn't map to a known TMDB id — skip rather than guess
        genreWeights[id] = (genreWeights[id] ?? 0) + Number(weight ?? 0);
      }
    }

    if (Object.keys(genreWeights).length === 0) return null;

    // Normalize to 0-1 so rankResults.js can treat this the same shape as
    // any other 0-1 signal, same convention as textRelevanceScore/qualityScore.
    const maxWeight = Math.max(...Object.values(genreWeights));
    const normalizedGenreWeights = {};
    for (const [id, w] of Object.entries(genreWeights)) {
      normalizedGenreWeights[id] = maxWeight > 0 ? w / maxWeight : 0;
    }

    return { matchedTerms, genreWeights: normalizedGenreWeights };
  } catch (err) {
    // A broken mood lookup should degrade to the old text-only behavior,
    // not take the whole search request down with it.
    console.error("[movie-search/domains] keyword-signature lookup threw:", err);
    return null;
  }
}

// STAGE 3: true when, after stripping noise words and the matched
// keyword-signature term(s) out of the cleaned query, nothing distinguishing
// is left over. A leftover token (a title fragment, actor name, plot
// description, additional untagged genre word, etc.) means the user wants
// more than pure mood matching, so we leave retrieval on the literal
// /search/movie path — this function only returns true for queries that are
// mood expressions and nothing else.
function isMoodOnlyQuery(cleanedQuery, matchedTerms) {
  const matchedWords = new Set(
    matchedTerms.flatMap((t) => t.toLowerCase().split(/\s+/).map(stripPunctuation)),
  );

  const leftover = cleanedQuery
    .toLowerCase()
    .split(/\s+/)
    .map(stripPunctuation)
    .filter((w) => w && !NOISE_WORDS.has(w) && !matchedWords.has(w));

  return leftover.length === 0;
}

// STAGE 3: picks the genres to send to /discover/movie for a mood-only
// query. Only genres at or above half the peak matched weight are used
// (capped to the top 3), so a signature that boosts one dominant genre
// (e.g. sad -> Drama 9, Romance 3) doesn't drag in a long tail of
// weakly-related genres and dilute results.
function pickDiscoverGenres(genreWeights) {
  return Object.entries(genreWeights)
    .filter(([, weight]) => weight >= 0.5)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([id]) => id)
    .join(",");
}

/**
 * Parses the incoming request into a structured search intent.
 *
 * @param {object} input
 * @param {string} [input.query] - free-text mood/keyword query
 * @param {string} [input.language] - explicit language filter chip (ISO 639-1)
 * @param {string} [input.watchProviders] - explicit provider filter chip (comma-separated TMDB provider IDs)
 * @param {string} [input.watchRegion] - explicit region override (ISO 3166-1), defaults to auto-detected region upstream
 * @param {string} [input.genres] - explicit genre filter chip (comma-separated TMDB genre IDs)
 * @param {number} [input.page]
 * @param {import('@supabase/supabase-js').SupabaseClient} [supabase] - passed by index.ts so
 *   keyword-signature matching can query movie_keyword_signatures. Optional so
 *   parseMovieQuery still works (minus mood matching) if ever called without it.
 */
export async function parseMovieQuery(input, supabase) {
  // TV SUPPORT FIX (2026-08-02): this was never being set, so
  // intent.mediaType was always undefined regardless of what the request
  // asked for. index.ts's runWaterfall() branches on
  // `intent.mediaType === "tv"` to pick the TV-only TMDB tier — with this
  // missing, every TV request silently ran the movie pipeline instead
  // (wrong results, not even an error). Defaults to "movie", matching
  // index.ts's own MovieSearchRequest.mediaType default per its header note.
  const mediaType = input.mediaType === "tv" ? "tv" : "movie";

  const rawQuery = (input.query ?? "").trim();
  const { cleanedQuery, exclusions } = rawQuery ? extractExclusions(rawQuery) : { cleanedQuery: "", exclusions: [] };

  // Explicit filter chips always win over anything inferred from free text.
  const inferredGenreIds = input.genres ? [] : matchGenresInText(cleanedQuery);

  const keywordSignature = input.genres ? null : await matchKeywordSignature(supabase, cleanedQuery);

  // STAGE 3: only meaningful when a signature actually matched and the user
  // didn't already pin an explicit genre chip (that case is unambiguous —
  // always literal/discover per the chip, mood routing doesn't apply).
  const moodOnlyQuery =
    !input.genres && keywordSignature != null && isMoodOnlyQuery(cleanedQuery, keywordSignature.matchedTerms);

  const discoverGenres = moodOnlyQuery ? pickDiscoverGenres(keywordSignature.genreWeights) : undefined;

  return {
    // TV SUPPORT FIX (2026-08-02) — see note above.
    mediaType,
    searchText: cleanedQuery || undefined,
    rawQuery,
    exclusions,
    language: input.language || undefined,
    watchProviders: input.watchProviders || undefined,
    watchRegion: input.watchRegion || undefined,
    genres:
      input.genres ||
      (inferredGenreIds.length ? inferredGenreIds.join(",") : undefined) ||
      (discoverGenres || undefined),
    page: input.page ?? 1,
    // Real as of Stage 2 (2026-07-31) — see matchKeywordSignature() above.
    // Shape: { matchedTerms: string[], genreWeights: { [tmdbGenreId]: 0-1 } } | null
    keywordSignature,
    // Real as of Stage 3 (2026-08-02) — see header note above. When true,
    // index.ts/tmdb.ts route TMDB retrieval through /discover/movie (using
    // `genres` above, derived from the matched signature) instead of the
    // literal-text /search/movie tier.
    moodOnlyQuery,
  };
}
