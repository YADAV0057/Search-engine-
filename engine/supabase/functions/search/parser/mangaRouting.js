export const VALID_ROUTING_GENRES = [
  'action', 'adventure', 'comedy', 'drama', 'fantasy', 'horror', 
  'mystery', 'psychological', 'romance', 'scifi', 'sliceoflife',
  'sports', 'supernatural', 'thriller'
];

export const MANGA_ROUTING = {
  calm:          { boost: ['sliceoflife'],                    exclude: ['horror', 'thriller'] },
  comfort:       { boost: ['sliceoflife', 'drama'],           exclude: ['horror'] },
  joy:           { boost: ['comedy', 'sliceoflife'],          exclude: ['horror', 'psychological'] },
  excitement:    { boost: ['action', 'adventure', 'sports'],  exclude: [] },
  thrill:        { boost: ['thriller', 'action', 'mystery'],  exclude: ['sliceoflife'] },
  adrenaline:    { boost: ['action', 'sports', 'adventure'],  exclude: ['sliceoflife'] },
  tension:       { boost: ['thriller', 'mystery', 'psychological'], exclude: ['comedy', 'sliceoflife'] },
  dread:         { boost: ['horror', 'psychological', 'thriller'], exclude: ['comedy', 'sliceoflife'] },
  fear:          { boost: ['horror', 'thriller'],             exclude: ['comedy', 'sliceoflife'] },
  disgust:       { boost: ['horror'],                         exclude: ['comedy', 'romance'] },
  // FIX 2026-07-19 (Notion "Backend Update List" Entry 49, gap #2):
  // 'sadness' used to boost 'psychological' alongside 'drama'. That genre
  // is exactly what dark/horror-adjacent titles (Monster, Berserk, Uzumaki)
  // carry, so a plain "I want to cry" query pulled them in with nothing to
  // filter them back out -- 'excludeGenres' was empty for this key, and
  // 'psychological' isn't excluded elsewhere in the pipeline for a sadness
  // signal. Root cause: sadness (tearjerker/loss) and dark/disturbing
  // content share this one genre bucket at the genre-classification level
  // this catalog uses -- there's no finer-grained tag system (checked
  // VALID_ROUTING_GENRES/adapters directly; only these 14 genres exist,
  // no tag-level boost/exclude). Fix: stop boosting 'psychological' for
  // sadness, explicitly exclude 'horror'/'psychological' so tearjerker
  // queries can't surface dark content, and add 'romance'/'sliceoflife'
  // to boost since that's where actual tearjerkers (Your Lie in April,
  // A Silent Voice) live in this genre taxonomy. Genuinely dark/traumatic
  // queries are unaffected -- they route through 'trauma'/'dread' below,
  // which still boost 'psychological' on purpose.
  sadness:       { boost: ['drama', 'romance', 'sliceoflife'], exclude: ['comedy', 'horror', 'psychological'] },
  melancholy:    { boost: ['drama', 'sliceoflife'],           exclude: ['comedy'] },
  trauma:        { boost: ['psychological', 'drama'],         exclude: ['comedy'] },
  awe:           { boost: ['fantasy', 'scifi', 'adventure'],  exclude: [] },
  wonder:        { boost: ['fantasy', 'adventure', 'scifi'],  exclude: [] },
  curiosity:     { boost: ['mystery', 'scifi'],               exclude: [] },
  whimsy:        { boost: ['comedy', 'fantasy', 'sliceoflife'], exclude: ['horror'] },
  nostalgia:     { boost: ['sliceoflife', 'drama'],           exclude: [] },
  romance:       { boost: ['romance'],                        exclude: [] },
  arousal:       { boost: ['romance'],                        exclude: [] },
  warmth:        { boost: ['sliceoflife', 'romance'],         exclude: ['horror'] },
  hope:          { boost: ['drama', 'adventure', 'sports'],   exclude: [] },
  determination: { boost: ['sports', 'action', 'adventure'],  exclude: [] },
  elegance:      { boost: ['drama', 'romance'],               exclude: [] },
  identity:      { boost: ['psychological', 'drama'],         exclude: [] },
  positive:      { boost: ['comedy', 'sliceoflife'],          exclude: [] },
  negative:      { boost: ['drama', 'psychological'],         exclude: [] }
};

// FIX 2026-07-19 (Notion "Backend Update List" Entry 49, gap #3):
// "dark but wholesome" only returned dark titles (Berserk, Tokyo Ghoul).
// Root cause: getRoutingForMood() above merges every active emotion into
// ONE additive weighted boost list. When two emotions are both present --
// e.g. dread (boosts horror/psychological) and comfort (boosts
// sliceoflife/drama, EXCLUDES horror) -- their signals get blended into a
// single list rather than treated as two things that both need to be
// true. A candidate only has to score well on ONE side to rank top, so a
// popular pure-horror title beats a rare dark-AND-wholesome one every
// time, even though the merged boost list nominally includes both sides'
// genres.
//
// Fix: detect when two active emotions in the aggregate are in genuine
// conflict -- one's `boost` list overlaps the other's `exclude` list (or
// vice versa) -- since that's a reliable signal the person means two
// distinct, simultaneously-required moods ("X but Y"), not one blended
// mood that happens to touch two genres. When found, return the two
// genre clusters separately so rankResults.js can reward candidates that
// hit BOTH clusters, instead of just summing weight across a merged list.
//
// Deliberately conservative: only fires on a genuine boost/exclude
// conflict between two SUFFICIENTLY WEIGHTED emotions (reuses the same
// order-of-magnitude threshold as domains.js's
// MOOD_GENRE_INCLUSION_THRESHOLD, duplicated here rather than imported to
// keep this module dependency-free of domains.js). An ordinary single-
// mood query (just "sadness", or "dread" alone) never has two emotions to
// compare, so this returns null and rankResults.js's new conjunction
// bonus contributes nothing -- existing single-mood ranking behavior is
// completely unaffected.
//
// Only checks pairs, not full N-way combinations -- "X but Y but Z"
// three-clause conjunctions aren't handled by this pass; scoped to the
// concrete two-clause case QA actually found ("dark but wholesome").
// Worth revisiting if a real three-clause query shows up in testing.
const CONJUNCTIVE_WEIGHT_THRESHOLD = 2;

export function detectConjunctiveClusters(aggregate) {
  if (!aggregate) return null;

  const activeEmotions = Object.entries(aggregate)
    .filter(([emotion, weight]) => weight >= CONJUNCTIVE_WEIGHT_THRESHOLD && MANGA_ROUTING[emotion.toLowerCase()]);

  if (activeEmotions.length < 2) return null;

  for (let i = 0; i < activeEmotions.length; i++) {
    for (let j = i + 1; j < activeEmotions.length; j++) {
      const [emotionA, weightA] = activeEmotions[i];
      const [emotionB, weightB] = activeEmotions[j];
      const routingA = MANGA_ROUTING[emotionA.toLowerCase()];
      const routingB = MANGA_ROUTING[emotionB.toLowerCase()];

      const aBoostsWhatBExcludes = routingA.boost.some((g) => routingB.exclude.includes(g));
      const bBoostsWhatAExcludes = routingB.boost.some((g) => routingA.exclude.includes(g));

      if (aBoostsWhatBExcludes || bBoostsWhatAExcludes) {
        return {
          clusterA: { emotion: emotionA, genres: routingA.boost, weight: weightA },
          clusterB: { emotion: emotionB, genres: routingB.boost, weight: weightB },
        };
      }
    }
  }

  return null;
}

// Entry 66 (2026-07-19, by Claude): getRoutingForMood() also returns
// `emotionGenreMap` now -- the per-emotion {weight, genres} list BEFORE
// it gets fanned out and collapsed into the flat `boostGenres` pool below.
//
// Root cause this fixes: `boostGenres` sums each emotion's weight into
// EVERY genre it maps to, so an emotion mapped to 3 genres (e.g. `tension`
// -> thriller/mystery/psychological) contributes 3x more pool mass per
// unit of weight than an emotion mapped to 1 genre (e.g. `romance` ->
// romance), even though the lexicon never said tension mattered 3x more.
// `emotionMatchScore()` in rankResults.js then divides by that inflated
// pool total, so a candidate's score depends on how many genres an
// emotion happens to map to in this table, not on the lexicon's actual
// {romance:7, tension:4} weights. Concretely: "Enemies To Lovers"
// ({romance:7, tension:4}) let a candidate with zero romance content but
// all 3 tension-genres (Thriller+Mystery+Psychological) outscore a real
// romance drama with fewer total genre tags -- see Backend Update List
// Entry 63/65/66 for the full repro.
//
// `emotionGenreMap` preserves each emotion as one undivided unit so
// rankResults.js can cap its contribution at its own lexicon weight
// regardless of how many genres it fans out to. `boostGenres` is
// UNCHANGED and kept as-is -- applyMoodBoost(), the response's `routing`
// field (aiPanel.js's "why" display), and negatedRouting's exclude-genre
// derivation all still use the flat pool exactly as before; only
// rankResults.js's emotionMatchScore() switches to the new field.
export function getRoutingForMood(aggregate) {
  if (!aggregate || Object.keys(aggregate).length === 0) {
    return { boostGenres: [], excludeGenres: [], emotionGenreMap: [] };
  }

  const boostWeights = new Map();
  const excludeSet = new Set();
  const emotionGenreMap = [];

  for (const [emotion, intensity] of Object.entries(aggregate)) {
    const routing = MANGA_ROUTING[emotion.toLowerCase()];
    if (!routing) continue;

    const weight = typeof intensity === 'number' ? intensity : 1;

    emotionGenreMap.push({ emotion, weight, genres: routing.boost });

    for (const genre of routing.boost) {
      boostWeights.set(genre, (boostWeights.get(genre) || 0) + weight);
    }
    for (const genre of routing.exclude) {
      excludeSet.add(genre);
    }
  }

  for (const genre of excludeSet) {
    boostWeights.delete(genre);
  }

  const boostGenres = [...boostWeights.entries()]
    .map(([genre, weight]) => ({ genre, weight }))
    .sort((a, b) => b.weight - a.weight);

  return { boostGenres, excludeGenres: [...excludeSet], emotionGenreMap };
}
