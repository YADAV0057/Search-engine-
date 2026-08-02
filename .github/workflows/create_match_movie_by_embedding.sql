-- Entry 107 Step 2: query-time semantic search for movies.
-- Exact mirror of the existing match_media_by_embedding() (manga side),
-- scoped to movie_entities / entity_type='movie' instead of lexicon_entities.
--
-- Verified live before writing this (2026-08-02): movie_entities has the
-- same shape as lexicon_entities (source_id, name, metadata jsonb,
-- embedding vector), so this is a direct copy with the table/filter swapped,
-- not a new design.

CREATE OR REPLACE FUNCTION public.match_movie_by_embedding(query_embedding vector, match_count integer DEFAULT 30)
 RETURNS TABLE(source_id text, name text, metadata jsonb, similarity double precision)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT source_id, name, metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM public.movie_entities
  WHERE entity_type = 'movie' AND embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$function$;
