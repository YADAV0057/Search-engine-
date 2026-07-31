-- Migration: schedule backfill-movie-embeddings to run continuously via pg_cron
--
-- Mirrors the existing "backfill-embeddings-job" (manga) exactly in shape:
-- same schedule cadence, same vault-secret auth pattern, same header name
-- (backfill-movie-embeddings reuses BACKFILL_SECRET / x-backfill-secret,
-- see index.ts comments — "reuse, don't duplicate" convention).
--
-- Before running this migration:
--   1. Confirm BACKFILL_SECRET is set as an Edge Function secret for
--      backfill-movie-embeddings (it's read from the same env var as
--      manga's backfill-embeddings, so if that's already set project-wide
--      this is a no-op).
--   2. Confirm the 'backfill_secret' entry already in vault.decrypted_secrets
--      (used by the existing manga job) holds the same value BACKFILL_SECRET
--      expects. If backfill-movie-embeddings uses a different secret value,
--      add a separate vault secret and swap the name below.
--
-- Safe to re-run: unschedules any existing job with this name first.

select cron.unschedule('backfill-movie-embeddings-job')
where exists (
  select 1 from cron.job where jobname = 'backfill-movie-embeddings-job'
);

select cron.schedule(
  'backfill-movie-embeddings-job',
  '* * * * *', -- every minute, same cadence as manga's backfill-embeddings-job
  $$
  select net.http_post(
    url := 'https://uvperhzhnosjtkwxxnte.supabase.co/functions/v1/backfill-movie-embeddings',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-backfill-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'backfill_secret')
    ),
    body := jsonb_build_object('batchSize', 15),
    timeout_milliseconds := 45000
  );
  $$
);

