// js/parser/dictionary/synopsisAnalyzer.js
//
// Turns a plot synopsis/description into the subjective fields
// (tone, intensity, boosts, excludes) that AniList/Jikan/ANN tags alone
// can't give us. Pure local computation — AFINN-165 lookup + a small
// manga-trope routing table (see lexicon.js) — no network calls, no LLM.

import { getWordData, MANGA_ROUTING } from './lexicon.js';

// Above/below this average AFINN score, the synopsis is called
// positive/negative rather than neutral. A small deadzone around 0 avoids
// mislabeling mildly-worded neutral synopses.
const TONE_DEADZONE = 0.15;

/** Lowercases and strips punctuation (keeping apostrophes/hyphens, since AFINN has entries like "can't stand"). */
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9'\-\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function topN(countMap, n) {
    return [...countMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([key]) => key);
}

/**
 * @param {string} text  Plot synopsis / description (plain text, HTML already stripped).
 * @returns {{ tone: string, intensity: number, boosts: string[],
 *             excludes: { genres: string[], themes: string[] },
 *             sampleSize: number, matchedSentimentWords: number }}
 */
export function analyzeSynopsis(text) {
    if (!text || !text.trim()) {
        // No synopsis to work with — fall back to the same neutral
        // placeholders the harvester used before this analyzer existed.
        return {
            tone: "neutral",
            intensity: 0.5,
            boosts: [],
            excludes: { genres: [], themes: [] },
            sampleSize: 0,
            matchedSentimentWords: 0
        };
    }

    const words = tokenize(text);

    let scoreTotal = 0;
    let intensityTotal = 0;
    let sentimentWordCount = 0;

    const boostCounts = new Map();
    const excludeGenreCounts = new Map();
    const excludeThemeCounts = new Map();

    words.forEach(word => {
        const sentiment = getWordData(word);
        if (sentiment) {
            scoreTotal += sentiment.score;
            intensityTotal += sentiment.intensity;
            sentimentWordCount++;
        }

        const routing = MANGA_ROUTING[word];
        if (routing) {
            (routing.boosts || []).forEach(b => boostCounts.set(b, (boostCounts.get(b) || 0) + 1));
            (routing.excludes?.genres || []).forEach(g => excludeGenreCounts.set(g, (excludeGenreCounts.get(g) || 0) + 1));
            (routing.excludes?.themes || []).forEach(t => excludeThemeCounts.set(t, (excludeThemeCounts.get(t) || 0) + 1));
        }
    });

    const avgScore = sentimentWordCount > 0 ? scoreTotal / sentimentWordCount : 0;
    const tone = avgScore > TONE_DEADZONE ? "positive"
        : avgScore < -TONE_DEADZONE ? "negative"
        : "neutral";

    // No sentiment words matched at all -> stay at the same 0.5 neutral
    // default as before, rather than claiming false confidence at 0.
    const intensity = sentimentWordCount > 0
        ? parseFloat(Math.min(1, intensityTotal / sentimentWordCount).toFixed(2))
        : 0.5;

    return {
        tone,
        intensity,
        boosts: topN(boostCounts, 5),
        excludes: {
            genres: topN(excludeGenreCounts, 3),
            themes: topN(excludeThemeCounts, 3)
        },
        sampleSize: words.length,
        matchedSentimentWords: sentimentWordCount
    };
}
