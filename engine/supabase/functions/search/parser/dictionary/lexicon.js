// SAVE AS: engine/supabase/functions/search/parser/dictionary/lexicon.js

// js/parser/dictionary/lexicon.js
//
// Bridges general-English sentiment (AFINN-165, 3382 pre-scored words) with
// manga-specific routing (a small hand-written map of tropes AFINN has no
// opinion on, e.g. "isekai" or "villainess" aren't emotionally charged
// words, but they strongly imply certain genres/themes to boost or avoid).
//
// Everything here runs 100% locally/offline — no LLM calls, no recurring
// cost, safe to run inside the GitHub Actions harvest job.

// Deno Edge Functions resolve bare npm specifiers via the "npm:" prefix
// instead of a package.json/node_modules install step.
import { afinn165 } from 'npm:afinn-165';

/**
 * Converts an AFINN score (-5..+5) into:
 *   - intensity: 0.0-1.0 (how emotionally charged the word is, regardless of direction)
 *   - tone: "positive" | "negative" | "neutral"
 * Returns null for words AFINN has no opinion on (most words — AFINN is a
 * sentiment lexicon, not a dictionary).
 */
export function getWordData(word) {
    // afinn165 is a plain object map — guard against prototype pollution
    // footguns (words like "constructor", "toString") per the package's own
    // README warning.
    if (!Object.prototype.hasOwnProperty.call(afinn165, word)) return null;

    const score = afinn165[word];
    const intensity = parseFloat((Math.abs(score) / 5).toFixed(2));
    const tone = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";

    return { score, intensity, tone };
}

/**
 * Manga-specific trope routing. AFINN can tell you "revenge" isn't a happy
 * word, but it can't tell you revenge stories skew Seinen/Action and clash
 * with Comedy/SliceOfLife — that's domain knowledge, so it's hand-written
 * here rather than derived. Keep this list small and high-confidence;
 * anything ambiguous is better left to the synopsis's actual sentiment.
 *
 * boosts: flat trope/keyword strings, same style as the hand-curated
 *   entries in properties.js (e.g. revenge.boosts = ["dark","survival","antihero"]).
 * excludes: split into genres/themes so it slots directly into the
 *   {genres:[], themes:[]} shape harvested_knowledge.js entries expect.
 */
export const MANGA_ROUTING = {
    magic:        { boosts: ["magic"],        excludes: { genres: [], themes: [] } },
    sword:        { boosts: ["swordplay"],    excludes: { genres: [], themes: [] } },
    ninja:        { boosts: ["ninja"],        excludes: { genres: [], themes: [] } },
    demon:        { boosts: ["dark", "supernatural"], excludes: { genres: [], themes: ["Iyashikei"] } },
    ghost:        { boosts: ["supernatural"], excludes: { genres: [], themes: [] } },
    monster:      { boosts: ["monsters"],     excludes: { genres: ["Comedy"], themes: ["Iyashikei", "Fluff"] } },
    curse:        { boosts: ["dark", "supernatural"], excludes: { genres: [], themes: ["Fluff"] } },
    reincarnation:{ boosts: ["isekai"],       excludes: { genres: [], themes: [] } },
    revenge:      { boosts: ["dark", "survival", "antihero"], excludes: { genres: ["Comedy", "SliceOfLife"], themes: ["Iyashikei", "Fluff", "Gag"] } },
    murder:       { boosts: ["dark", "violent"], excludes: { genres: ["Comedy", "SliceOfLife"], themes: ["Iyashikei", "Fluff", "Gag"] } },
    blood:        { boosts: ["gore", "violent"], excludes: { genres: ["Comedy", "SliceOfLife"], themes: ["Iyashikei", "Fluff"] } },
    war:          { boosts: ["survival", "violent"], excludes: { genres: ["Comedy"], themes: ["Iyashikei", "Fluff"] } },
    apocalypse:   { boosts: ["survival", "dark"], excludes: { genres: ["Comedy", "SliceOfLife"], themes: ["Iyashikei", "Fluff"] } },
    death:        { boosts: ["dark"],         excludes: { genres: [], themes: ["Gag"] } },
    tournament:   { boosts: ["competition"],  excludes: { genres: [], themes: [] } },
    dungeon:      { boosts: ["isekai", "adventure"], excludes: { genres: [], themes: [] } },
    guild:        { boosts: ["isekai", "adventure"], excludes: { genres: [], themes: [] } },
    school:       { boosts: ["school-life"],  excludes: { genres: [], themes: [] } },
    villainess:   { boosts: ["villainess"],   excludes: { genres: [], themes: [] } },
    romance:      { boosts: ["romance"],      excludes: { genres: [], themes: [] } },
    wedding:      { boosts: ["romance", "wholesome"], excludes: { genres: ["Horror"], themes: ["Gore", "Despair"] } },
    healing:      { boosts: ["wholesome", "iyashikei"], excludes: { genres: ["Horror", "Psychological"], themes: ["Gore", "Survival"] } },
    family:       { boosts: ["found-family"], excludes: { genres: [], themes: [] } },
    friendship:   { boosts: ["found-family"], excludes: { genres: [], themes: [] } },
    android:      { boosts: ["sci-fi"],       excludes: { genres: [], themes: [] } },
    robot:        { boosts: ["sci-fi"],       excludes: { genres: [], themes: [] } },
    prophecy:     { boosts: ["fated", "mystery"], excludes: { genres: [], themes: [] } },
    detective:    { boosts: ["mystery"],      excludes: { genres: ["Comedy"], themes: ["Gag"] } }
};

