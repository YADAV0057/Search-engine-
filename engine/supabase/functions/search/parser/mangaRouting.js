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
  sadness:       { boost: ['drama', 'psychological'],         exclude: ['comedy'] },
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

export function getRoutingForMood(aggregate) {
  if (!aggregate || Object.keys(aggregate).length === 0) {
    return { boostGenres: [], excludeGenres: [] };
  }

  const boostWeights = new Map();
  const excludeSet = new Set();

  for (const [emotion, intensity] of Object.entries(aggregate)) {
    const routing = MANGA_ROUTING[emotion.toLowerCase()];
    if (!routing) continue;

    const weight = typeof intensity === 'number' ? intensity : 1;

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

  return { boostGenres, excludeGenres: [...excludeSet] };
}
