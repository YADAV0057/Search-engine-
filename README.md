# New Search Engine — Project Log

Standing log for the from-scratch, multi-niche search engine (replaces the
old MangaMood mood/vector engine attempts). This file gets updated in place
as decisions happen — not replaced by new files each session.

---

## 1. Why this exists

The old mood engine (`js/parser/*` in the MyManga repo) and its follow-up
Vector Engine attempt are being left alone in the original repo, untouched,
while this is built separately from scratch. Old engine files may be
salvaged into this project selectively — nothing carries over automatically.

## 2. Architecture decisions (confirmed)

- **Separate repo, separate cloud, separate Firebase project** from MyManga.
  No shared config between the two; the only contact point is an HTTP call.
- **Engine does the API calls, not the client.** MyManga's `search.js` will
  send a request to this engine; the engine calls AniList/Jikan/MangaDex/etc.
  itself, normalizes and ranks results, and returns a finished list.
  MyManga's per-source adapters, waterfall, circuit breaker, and normalizer
  move into this engine.
- **Multi-niche from day one.** API contract carries a `domain`/niche field
  even though manga is the only live niche right now — retrofitting this
  later is expensive, so it's in the contract from the first version.
- **Caching is the primary latency/quota strategy.** A cache (Firestore or
  similar) keyed on `domain + normalized query + filters`, with a TTL, sits
  in front of every external API call. This is also what keeps this
  engine's own API keys from getting rate-limited once multiple client
  projects share it.
- **Request strategy:** tiered fallback (try source 1, only fall through to
  source 2+ if empty), not parallel fan-out — conserves shared API quota
  across all future niches/projects. Per-source timeout with fast fallback
  instead of waiting out a slow API.

## 3. Draft API contract (subject to change — update this section, don't fork it)

```
POST /search
{
  "domain": "manga",
  "query": "...",
  "filters": { ... }
}
→
{
  "results": [ ...normalized items... ]
}
```

## 4. Files salvaged from the old engine

*(updated as files are reviewed — nothing here yet)*

| Old file | Verdict | Notes |
|---|---|---|
| — | — | — |

## 5. Open questions / not yet decided

- Cache TTL per query type (search vs. stable reference data)
- Auth/guard on the public endpoint (API key, App Check, rate limit)
- Region/hosting choice for the new backend
- Ranking/scoring approach for the new engine (not yet designed)

## 6. Change log

- *(entries added here as decisions are made — most recent on top)*
- 
