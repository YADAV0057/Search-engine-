// engine/supabase/functions/backfill-movie-embeddings/index.ts
//
// PHASE 4 of Movie Search — Build Strategy (Phased). Movie-side counterpart
// to backfill-embeddings/index.ts (manga). Same overall shape — batch of
// rows with embedding IS NULL, embed via Gemini, write back — retargeted at
// movie_entities (entity_type='movie') instead of lexicon_entities
// (entity_type='media').
//
// Started now rather than waiting for full Phase 3 completion, per the
// Architecture & UX Plan's explicit sequencing: "Start this as soon as
// Phase 3 has *some* keyword-signature coverage" — movie_keyword_signatures
// has 16 rows as of 2026-07-31, which counts.
//
// WHAT'S DIFFERENT FROM manga's backfill-embeddings, AND WHY:
//   - Source text: manga fetches display data live from MangaDex per-row
//     at embed time. Movies don't need that extra hop — harvest-movies has
//     already written overview/genre_names/keyword_ids into movie_entities'
//     own metadata jsonb, so this function reads straight from the table
//     it's embedding rather than calling out to TMDB again.
//   - Keyword names: metadata only stores keyword_ids (TMDB numeric IDs),
//     not names — harvest-movies writes ids because that's what TMDB's
//     movie-details response gives you inline, and resolving every id to a
//     name at harvest time would mean an extra API call per movie. The
//     names already exist as their own rows in movie_entities
//     (entity_type='keyword', source_id=TMDB keyword id, per
//     harvest-movie-keywords' own vocab query) — so this function batch-
//     resolves ids -> names once per run via a single IN() query, not
//     per-row, then joins in-memory. Cast/director are deliberately
//     excluded from the embedding text per the Architecture doc (Open
//     Item #3 decision): those are a structured-lookup problem, not a
//     semantic one, and would dilute the mood-matching signal.
//   - Embedding source text shape: `title. overview Genres: g1, g2.
//     Keywords: k1, k2.` — mirrors manga's `title. synopsis Tags: t1, t2.`
//     shape exactly, per the doc's "title + overview + genre names +
//     keyword names" spec.
//   - API keys: GEMINI_API_KEY2 (primary) / GEMINI_API_KEY3 (fallback on
//     429) — confirmed reserved specifically for this function (Notion
//     Entry 99), kept separate from manga's GEMINI_API_KEY to isolate
//     quota/rate limits per-domain. Falls back key2 -> key3 only on a 429;
//     any other failure is recorded and the row is skipped (retried next
//     run), same as manga's single-key failure handling.
//   - Auth: reuses BACKFILL_SECRET (same env var, same x-backfill-secret
//     header) rather than minting a new secret — same "reuse, don't
//     duplicate" convention harvest-movie-keywords already followed for
//     HARVEST_SECRET.
//   - vector(768) / output_dimensionality:768 — reused unchanged from
//     manga's proven config (Entry 88), not re-litigated.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY2 = Deno.env.get("GEMINI_API_KEY2"); // primary for movie embeddings
const GEMINI_API_KEY3 = Deno.env.get("GEMINI_API_KEY3"); // fallback on 429
const BACKFILL_SECRET = Deno.env.get("BACKFILL_SECRET"); // reused from backfill-embeddings (manga)

const EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

const OVERVIEW_MAX_CHARS = 1500;
const CALL_GAP_MS = 300;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;

interface EmbedResult {
  embedding: number[] | null;
  error: string | null;
  keyUsed?: "key2" | "key3";
}

async function callGeminiEmbed(apiKey: string, text: string): Promise<{ ok: boolean; status?: number; embedding?: number[]; bodyText?: string }> {
  const res = await fetch(`${EMBED_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      output_dimensionality: 768,
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    return { ok: false, status: res.status, bodyText };
  }
  const data = await res.json();
  const values = data?.embedding?.values ?? null;
  if (!values) {
    return { ok: false, status: res.status, bodyText: `200 but no embedding.values: ${JSON.stringify(data).slice(0, 300)}` };
  }
  return { ok: true, embedding: values };
}

// Primary/fallback exactly per Architecture doc: GEMINI_API_KEY2 is
// primary, GEMINI_API_KEY3 is the fallback used specifically on 429
// (rate-limit) errors — not on other failure types, so a bad-request or
// auth error doesn't silently burn the fallback key's quota too.
async function embedText(text: string): Promise<EmbedResult> {
  if (!GEMINI_API_KEY2 && !GEMINI_API_KEY3) {
    return { embedding: null, error: "neither GEMINI_API_KEY2 nor GEMINI_API_KEY3 is set" };
  }

  if (GEMINI_API_KEY2) {
    try {
      const primary = await callGeminiEmbed(GEMINI_API_KEY2, text);
      if (primary.ok) return { embedding: primary.embedding!, error: null, keyUsed: "key2" };
      if (primary.status !== 429) {
        console.error("[backfill-movie-embeddings] key2 non-429 failure", primary.status, primary.bodyText);
        return { embedding: null, error: `key2 Gemini ${primary.status}: ${(primary.bodyText || "").slice(0, 300)}` };
      }
      console.error("[backfill-movie-embeddings] key2 429, falling back to key3");
    } catch (err) {
      return { embedding: null, error: `key2 exception: ${String(err).slice(0, 300)}` };
    }
  }

  if (GEMINI_API_KEY3) {
    try {
      const fallback = await callGeminiEmbed(GEMINI_API_KEY3, text);
      if (fallback.ok) return { embedding: fallback.embedding!, error: null, keyUsed: "key3" };
      return { embedding: null, error: `key3 Gemini ${fallback.status}: ${(fallback.bodyText || "").slice(0, 300)}` };
    } catch (err) {
      return { embedding: null, error: `key3 exception: ${String(err).slice(0, 300)}` };
    }
  }

  return { embedding: null, error: "key2 429'd and no GEMINI_API_KEY3 configured to fall back to" };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  const authHeader = req.headers.get("x-backfill-secret");
  if (!BACKFILL_SECRET || authHeader !== BACKFILL_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let batchSize = DEFAULT_BATCH_SIZE;
  try {
    const body = await req.json();
    if (typeof body?.batchSize === "number") {
      batchSize = Math.min(MAX_BATCH_SIZE, Math.max(1, body.batchSize));
    }
  } catch {
    // no body / not JSON — use default
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: rows, error } = await supabase
    .from("movie_entities")
    .select("source_id, name, metadata")
    .eq("entity_type", "movie")
    .is("embedding", null)
    .limit(batchSize);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return new Response(
      JSON.stringify({ done: true, processed: 0, message: "No movie rows left to embed." }),
      { status: 200 }
    );
  }

  // Batch-resolve keyword_ids -> names in one query rather than per-row,
  // since the same keyword ids recur heavily across movies (see header
  // note). movie_entities' keyword rows use source_id as the TMDB keyword
  // id, stored as text (primary key is (entity_type, source_id) text).
  const allKeywordIds = new Set<string>();
  for (const row of rows) {
    const ids: unknown[] = row.metadata?.keyword_ids ?? [];
    for (const id of ids) allKeywordIds.add(String(id));
  }

  const keywordNameById = new Map<string, string>();
  if (allKeywordIds.size > 0) {
    const { data: kwRows, error: kwErr } = await supabase
      .from("movie_entities")
      .select("source_id, name")
      .eq("entity_type", "keyword")
      .in("source_id", Array.from(allKeywordIds));
    if (kwErr) {
      console.error("[backfill-movie-embeddings] keyword name lookup failed", kwErr);
      // Not fatal — proceed without keyword names rather than failing the
      // whole batch; embedding text just falls back to title+overview+genres.
    } else {
      for (const kw of kwRows || []) {
        if (kw.name) keywordNameById.set(kw.source_id, kw.name);
      }
    }
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let key2Used = 0;
  let key3Used = 0;
  let lastError: string | null = null;

  for (const row of rows) {
    const overview: string = row.metadata?.overview ?? "";
    const genreNames: string[] = row.metadata?.genre_names ?? [];
    const keywordIds: unknown[] = row.metadata?.keyword_ids ?? [];
    const keywordNames = keywordIds
      .map((id) => keywordNameById.get(String(id)))
      .filter((n): n is string => Boolean(n));

    if (!overview && genreNames.length === 0 && keywordNames.length === 0) {
      // Nothing meaningful to embed yet (e.g. unreleased title with a
      // blank overview and no keywords harvested) — skip for now, will be
      // picked up again once harvest-movies fills in more metadata.
      skipped++;
      continue;
    }

    const cleanOverview = overview
      .replace(/https?:\/\/\S+/g, "")
      .trim()
      .slice(0, OVERVIEW_MAX_CHARS);

    const sourceText =
      `${row.name}. ${cleanOverview}` +
      (genreNames.length ? ` Genres: ${genreNames.join(", ")}.` : "") +
      (keywordNames.length ? ` Keywords: ${keywordNames.join(", ")}.` : "");

    const { embedding, error: embedError, keyUsed } = await embedText(sourceText);
    if (!embedding) {
      failed++;
      if (embedError) lastError = embedError;
      await sleep(CALL_GAP_MS);
      continue;
    }
    if (keyUsed === "key2") key2Used++;
    if (keyUsed === "key3") key3Used++;

    const { error: updateError } = await supabase
      .from("movie_entities")
      .update({ embedding, embedding_source_text: sourceText })
      .eq("entity_type", "movie")
      .eq("source_id", row.source_id);

    if (updateError) {
      console.error("[backfill-movie-embeddings] update failed", row.source_id, updateError);
      failed++;
      lastError = `DB update failed: ${updateError.message}`;
    } else {
      processed++;
    }

    await sleep(CALL_GAP_MS);
  }

  return new Response(
    JSON.stringify({
      done: false,
      batchSize,
      processed,
      skipped,
      failed,
      key2Used,
      key3Used,
      hasGeminiKey2: !!GEMINI_API_KEY2,
      hasGeminiKey3: !!GEMINI_API_KEY3,
      lastError,
      note: "Call again to continue; only rows with embedding IS NULL are ever picked up.",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});

