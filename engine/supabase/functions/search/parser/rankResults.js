export function rankResults(results, { qualityThreshold = 0.55 } = {}) {
  if (!Array.isArray(results)) return [];

  return results
    .map((item) => {
      const title = item?.title?.romaji || item?.title?.english || "";
      const description = item?.description || "";
      const genres = Array.isArray(item?.genres) ? item.genres : [];

      // Favor candidates that have enough metadata to explain a search match.
      // Missing descriptions should not be penalized heavily, but should
      // not rank above a similarly relevant complete record.
      const metadataScore =
        (title ? 0.35 : 0) +
        (description ? 0.45 : 0) +
        (genres.length > 0 ? 0.20 : 0);

      const score = Number.isFinite(item?.finalScore)
        ? item.finalScore
        : Number(item?.averageScore || 0) / 100;

      return {
        item,
        finalScore: score,
        metadataScore,
        isUsable: title.length > 0 && metadataScore >= qualityThreshold,
      };
    })
    .sort((a, b) => {
      if (a.isUsable !== b.isUsable) return a.isUsable ? -1 : 1;
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      return b.metadataScore - a.metadataScore;
    })
    .map(({ item }) => item);
}

export function computeRankingWeights() {
  return {};
}

export function computeMoodIntensity() {
  return 0;
}
