-- Scheduler proposal for IdeaForge. Do not run until the target project's
-- pg_cron, pg_net, and Vault availability has been checked.
--
-- Store the exact deployed project URL and the same high-entropy value as
-- IDEAFORGE_EMAIL_WORKER_TOKEN in Supabase Vault. Do not commit those values.
-- Example only:
-- select vault.create_secret('https://<project-ref>.supabase.co', 'ideaforge_supabase_url');
-- select vault.create_secret('<worker token>', 'ideaforge_email_worker_token');
--
-- Read-only preflight:
-- select extname from pg_extension where extname in ('pg_cron', 'pg_net', 'supabase_vault');
-- select jobid, jobname, schedule, active from cron.job
-- where jobname = 'ideaforge-email-worker';
--
-- This script only creates an invocation helper and one 5-minute cron job.
-- It does not enable sending; the Edge Function stays off unless
-- IDEAFORGE_EMAIL_SENDING_ENABLED=true is explicitly configured.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not installed; do not continue until the target project is reviewed';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_net is not installed; do not continue until the target project is reviewed';
  end if;
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception 'Supabase Vault is not installed; do not continue until the target project is reviewed';
  end if;
  if not exists (
    select 1
    where (
      select count(*)
      from vault.decrypted_secrets
      where name in ('ideaforge_supabase_url', 'ideaforge_email_worker_token')
    ) = 2
  ) then
    raise exception 'Required IdeaForge scheduler secrets are missing from Vault';
  end if;
  if exists (
    select 1 from cron.job
    where jobname = 'ideaforge-email-worker'
  ) then
    raise exception 'The IdeaForge email cron job already exists; inspect it before changing anything';
  end if;
end;
$$;

create function public.ideaforge_invoke_email_worker()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, vault, net, pg_temp
as $$
declare
  v_url text;
  v_token text;
  v_request_id bigint;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'ideaforge_supabase_url';

  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'ideaforge_email_worker_token';

  if v_url is null or v_token is null then
    raise exception 'IdeaForge email scheduler secrets are unavailable';
  end if;

  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/ideaforge-email-worker',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.ideaforge_invoke_email_worker() from public, anon, authenticated;

do $$
begin
  perform cron.schedule(
    'ideaforge-email-worker',
    '*/5 * * * *',
    'select public.ideaforge_invoke_email_worker();'
  );
end;
$$;
