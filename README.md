# New Search Engine — Project Log

Standing log for the from-scratch, multi-niche search engine (replaces the
old MangaMood mood/vector engine attempts). This file gets updated in place
as decisions happen — not replaced by new files each session.

---

## 1. Why this exists

The old mood engine (`js/parser/*` in the MyManga repo) and its follow-up
Vector Engine attempt are being left alone in the original repo, untouched,
while this is built separately from scratch. MyManga itself stays on
Firebase and is unaffected by any of this. Old engine files may be
salvaged into this project selectively — nothing carries over automatically.

## 2. Architecture decisions (confirmed)

- **Separate repo, separate cloud, separate Firebase project** from MyManga.
  No shared config between the two; the only contact point is an HTTP call.
- **Engine does the API calls, not the client.** Every niche frontend
  (moodmanga.in first, more later) sends a request to this engine; the
  engine calls AniList/Jikan/MangaDex/etc. itself, normalizes and ranks
  results, and returns a finished list. Per-source adapters, waterfall,
  and normalization live here, not in any frontend.
- **Multi-niche from day one.** API contract carries a `domain` field even
  though manga is the only live niche right now — retrofitting this later
  is expensive, so it's in the contract from the first version. Each niche
  frontend is its own separate deploy/domain (see section 7); they all call
  the same engine URL.
- **Caching is the primary latency/quota strategy.** A Postgres cache
  (`search_cache`, see `supabase/migrations/`) keyed on
  `domain + normalized query + filters`, with a TTL, sits in front of
  every external API call.
- **Request strategy:** tiered fallback (try source 1, only fall through to
  source 2+ if empty), not parallel fan-out — conserves shared API quota
  across all future niches/projects.

## 3. Stack decision (confirmed)

- **Backend: Supabase.** Postgres for the cache table, Edge Functions
  (Deno) for the actual engine logic. Chosen specifically because Edge
  Functions have no restriction on outbound calls to third-party APIs —
  Firebase's free Spark plan blocks exactly that for Cloud Functions, which
  ruled it out for this piece even though MyManga stays on Firebase for
  everything else.
- **Frontends: Vercel**, one project per niche domain (moodmanga.in, and
  whatever comes next), each pointing at the same engine URL.
- **Engine URL, for now:** the project's free `*.supabase.co` subdomain.
  No dedicated domain purchased yet — not worth it before a second niche
  exists. Revisit if/when niche frontends restructure into subdomains of
  one company domain (explicitly deferred, see section 5).
- **CORS:** explicit origin allowlist in `cors.js`, not a wildcard — the
  engine's quota is shared across every niche, so it shouldn't be open to
  arbitrary callers. Add each real frontend domain to the list as it
  launches.

## 4. Files salvaged from the old engine

| Old file | Verdict | Notes |
|---|---|---|
| `parser/normalize.js` | ✅ Ported as-is | No deps, pure function |
| `parser/dictionary/lexicon.js` | ✅ Ported | Only needs `afinn-165`; import swapped to `npm:afinn-165` for Deno |
| `parser/dictionary/synopsisAnalyzer.js` | ✅ Ported as-is | Only depends on lexicon.js |
| `parser/synonyms.js` | ⚠️ Ported, not wired in yet | Imports SYNONYM_MAP from `dictionary.js` — stub with empty maps in place, domains.js doesn't call this yet |
| `parser/fuzzyMatch.js` | ⚠️ Ported, not wired in yet | Same `dictionary.js` dependency as synonyms.js |
| `parser/searchPlanner.js` | ⚠️ Ported, partially wired | `buildPlanFromGenreList()` is used live in `domains.js`. `buildSearchPlan()` (the full MangaIntent-based version) needs the mood/NLU pipeline ported before it's usable — `domains.js` builds a minimal plan directly in the meantime |
| `adapters/anilist.js` | ✅ Ported | Dropped the dead `parser.js` re-export shim |
| `adapters/jikan.js` | ✅ Ported | Browser `config.js` import replaced with `Deno.env.get('JIKAN_URL')` + public default |
| `adapters/kitsu.js` | ✅ Ported | Same env var swap as jikan.js |
| `comick.js` | ❌ Not carried over | Read-link resolver, not a search source — out of this engine's scope |
| `shikimoriClient.js` | ❌ Not carried over | Offline dictionary-harvester script, not part of the live `/search` request path |
| `aiPanel.js` | ❌ Not carried over | Pure DOM/UI, belongs in a frontend, not the engine |
| `search.js` | ❌ Not carried over | Old client orchestrator (Firebase, DOM grid). Its waterfall pattern is what `domains.js` follows, but the file itself was UI-coupled |

## 5. Open questions / not yet decided

- Auth/guard on the public endpoint beyond CORS (API key, rate limit) —
  currently open to any request from an allowlisted origin, no per-caller
  limit.
- Whether/when to buy a dedicated engine domain instead of the free
  `*.supabase.co` URL.
- Whether niche frontends eventually move to subdomains of one company
  domain — explicitly deferred, not a current-scope decision.
- Cache cleanup job for expired rows (currently just ignored as misses,
  never deleted — fine at this scale).
- Full mood/NLU intent pipeline (`buildIntent()` → `buildSearchPlan()`) —
  not ported yet; `domains.js` uses a minimal plan builder in its place.

## 6. Change log

- **2026-07-12** — Engine skeleton stood up: Supabase Edge Function
  (`supabase/functions/search/`), `search_cache` migration, manga domain
  wired to AniList → Jikan → Kitsu waterfall, CORS allowlist seeded with
  moodmanga.in. Stack decision (Supabase + Vercel, Firebase ruled out for
  compute) recorded in section 3.

## 7. Where each file goes / repo layout

```
engine/
├── README.md
├── .env.example
└── supabase/
    ├── migrations/
    │   └── 0001_search_cache.sql      # run via `supabase db push`
    └── functions/
        └── search/                     # deployed as the `search` Edge Function
            ├── index.js                 # entry point — CORS, cache, routing
            ├── cors.js                  # allowlisted frontend origins
            ├── cache.js                 # search_cache read/write + key hashing
            ├── domains.js                # niche registry — add new niches here
            ├── parser/
            │   ├── normalize.js
            │   ├── synonyms.js           # not wired in yet, see section 4
            │   ├── fuzzyMatch.js         # not wired in yet, see section 4
            │   ├── dictionary.js          # empty stub, replace when the real dictionary is built
            │   ├── searchPlanner.js
            │   └── dictionary/
            │       ├── lexicon.js
            │       └── synopsisAnalyzer.js
            └── adapters/
                ├── anilist.js
                ├── jikan.js
                └── kitsu.js
```

**Deploying:**
```
supabase link --project-ref <your-project-ref>
supabase db push                          # creates search_cache
supabase functions deploy search
```

**Each niche frontend** (Vercel project) needs one env var:
```
ENGINE_URL=https://<your-project-ref>.functions.supabase.co/search
```
and calls it with:
```
POST {ENGINE_URL}
{ "domain": "manga", "query": "...", "filters": { ... } }
```
