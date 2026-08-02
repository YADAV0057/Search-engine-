// engine/supabase/functions/search/embedOnDemand.js
//
// ON-DEMAND ("LIVE") EMBEDDING for manga — Notion Entry 107's Step 1,
// movie-side counterpart already written as movie-search's embedOnDemand.ts.
//
// PROBLEM THIS REPLACES: backfill-embeddings-job (pg_cron, every 1 minute)
// blindly sweeps lexicon_entities WHERE embedding IS NULL in source_id
// order — completely disconnected from what people actually search for.
// Confirmed live 2026-08-02: only 2,241/61,025 media rows embedded (3.7%)
// despite running every minute since mid-July. At current pace this would
// take months to finish, and is spending Gemini calls + DB writes on
// titles nobody has ever searched for.
//
// WHAT THIS DOES INSTEAD: after a manga search response is already built
// (zero added latency to the request — same EdgeRuntime.waitUntil()
// pattern movie-search's embedOnDemand.ts already uses), check which of
// THIS QUERY'S OWN RESULTS are missing an embedding, and embed just those
// (capped small, see MAX_EMBEDS_PER_REQUEST below) in the background. A
// title only ever gets embedded once someone actually searches for
// something that surfaces it — the exact "live embedding" behavior
// requested in Notion Entry 107.
//
// JOIN KEY, confirmed directly against live data (not assumed):
//   lexicon_entities.source_id === `mangadex-${mangadexId}`
//   adapters/mangadex.js's result shape: `id: `mangadex-${m.id}``
// These match byte-for-byte (spot-checked 5 live rows), so results whose
// `id` starts with "mangadex-" can be joined straight to
// lexicon_entities.source_id with no transformation.
//
// SCOPE LIMITATION, stated plainly rather than silently assumed away:
// AniList/Jikan/Kitsu-sourced results have NO corresponding
// lexicon_entities row at all (Entry 37: AniList-side media harvest has
// never completed; only MangaDex-sourced rows exist). Only
// "mangadex-"-prefixed result ids can be embedded via this path. This
// does not regress anything — those other results already couldn't be
// semantically matched before this change either — but it does mean
// on-demand coverage will only ever grow for the MangaDex-sourced slice
// of results until the AniList harvest gap (Entry 37/38) is separately
// fixed.
//
// EMBED LOGIC (fetchMangaDexDisplayData / embedText) is copied from
// backfill-embeddings/index.ts v8 verbatim, not reinvented — same model
// (gemini-embedding-001), same output_dimensionality:768 to match the
// existing vector(768) column, same source-text shape. Kept as a literal
// copy rather than a shared import because these are two separate Edge
// Function deployments (search vs backfill-embeddings) with no shared
// module loader between them today — flagging as a possible follow-up
// dedup, not fixed here.

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

// Small and deliberately conservative — this runs in the background after
// the response is already sent, but still costs real Gemini calls +
// MangaDex fetches per invocation. 5 embeds/request is enough to make
// real progress on popular queries without turning a single search into
// a mini batch job. Tune up once this is confirmed stable in production.
const MAX_EMBEDS_PER_REQUEST = 5;

async function embedText(text) {
  if (!GEMINI_API_KEY) return { embedding: null, error: 'GEMINI_API_KEY not set' };
  try {
    const res = await fetch(`${EMBED_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        output_dimensionality: 768
      })
    });
    if (!res.ok) {
      const bodyText = await res.text();
      console.error('[embedOnDemand] Gemini embed failed', res.status, bodyText);
      return { embedding: null, error: `Gemini ${res.status}: ${bodyText.slice(0, 300)}` };
    }
    const data = await res.json();
    const values = data?.embedding?.values ?? null;
    if (!values) {
      return { embedding: null, error: `Gemini 200 but no embedding.values: ${JSON.stringify(data).slice(0, 300)}` };
    }
    return { embedding: values, error: null };
  } catch (err) {
    console.error('[embedOnDemand] embedText error', err);
    return { embedding: null, error: `exception: ${String(err).slice(0, 300)}` };
  }
}

async function fetchMangaDexDisplayData(mangadexId) {
  try {
    const res = await fetch(`https://api.mangadex.org/manga/${mangadexId}?includes[]=tag`);
    if (!res.ok) {
      console.error('[embedOnDemand] MangaDex non-ok', mangadexId, res.status);
      return null;
    }
    const json = await res.json();
    const attrs = json?.data?.attributes;
    if (!attrs) return null;
    const synopsis = attrs.description?.en ?? Object.values(attrs.description ?? {})[0] ?? '';
    const tags = (attrs.tags ?? [])
      .map((t) => t?.attributes?.name?.en)
      .filter(Boolean);
    const title = attrs.title?.en ?? Object.values(attrs.title ?? {})[0] ?? null;
    const status = attrs.status ?? null;
    return { synopsis, tags, title, status };
  } catch (err) {
    console.error('[embedOnDemand] MangaDex fetch error', err);
    return null;
  }
}

/**
 * Embeds up to MAX_EMBEDS_PER_REQUEST titles from THIS search's own
 * results that don't have an embedding yet. Call via
 * EdgeRuntime.waitUntil(embedMissingMedia(results, supabase)) AFTER the
 * response has already been built — this must never add latency to the
 * request itself, same principle as movie-search's embedOnDemand.ts.
 *
 * Safe no-op if: no GEMINI_API_KEY, no mangadex-sourced results, or
 * everything in this batch is already embedded.
 */
export async function embedMissingMedia(results, supabase) {
  if (!GEMINI_API_KEY || !Array.isArray(results) || results.length === 0) return;

  const mangadexSourceIds = results
    .map((r) => r?.id)
    .filter((id) => typeof id === 'string' && id.startsWith('mangadex-'));

  if (mangadexSourceIds.length === 0) return;

  // Only fetch rows that are (a) in this result set and (b) actually
  // missing an embedding — no point re-checking already-embedded titles.
  const { data: candidates, error: fetchErr } = await supabase
    .from('lexicon_entities')
    .select('source_id, name, metadata')
    .eq('entity_type', 'media')
    .in('source_id', mangadexSourceIds)
    .is('embedding', null)
    .limit(MAX_EMBEDS_PER_REQUEST);

  if (fetchErr) {
    console.error('[embedOnDemand] candidate fetch failed', fetchErr);
    return;
  }
  if (!candidates || candidates.length === 0) return;

  for (const row of candidates) {
    const mangadexId = row.metadata?.mangadexId;
    if (!mangadexId) continue;

    const content = await fetchMangaDexDisplayData(mangadexId);
    if (!content || !content.synopsis) continue;

    const cleanSynopsis = content.synopsis
      .replace(/\[.*?\]/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .trim()
      .slice(0, 1500);

    const sourceText = `${row.name}. ${cleanSynopsis}${
      content.tags.length ? ` Tags: ${content.tags.join(', ')}.` : ''
    }`;

    const { embedding, error: embedError } = await embedText(sourceText);
    if (!embedding) {
      if (embedError) console.error(`[embedOnDemand] embed failed for ${row.source_id}:`, embedError);
      continue;
    }

    const displayMetadata = {
      ...row.metadata,
      title: content.title || row.name,
      genres: content.tags,
      description: cleanSynopsis,
      status: content.status
    };

    const { error: updateError } = await supabase
      .from('lexicon_entities')
      .update({ embedding, embedding_source_text: sourceText, metadata: displayMetadata })
      .eq('entity_type', 'media')
      .eq('source_id', row.source_id);

    if (updateError) {
      console.error(`[embedOnDemand] update failed for ${row.source_id}:`, updateError);
    }

    // Same 300ms courtesy gap backfill-embeddings uses between rows —
    // avoids hammering MangaDex/Gemini back-to-back within one request.
    await new Promise((r) => setTimeout(r, 300));
  }
}
