-- Gmail throttles free accounts that send large bursts, even when the rolling
-- daily total is below the documented limit. Pace claims so the worker cannot
-- drain the whole queue in a few minutes: at most 40 sends per rolling hour and
-- 200 per rolling day, on top of the per-run batch size.

create or replace function public.ideaforge_email_claim(p_limit integer default 10)
returns table (
  id uuid,
  team_id uuid,
  recipient_email text,
  recipient_name text,
  team_name text,
  team_code text,
  member_names text[],
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
declare
  v_daily_remaining integer;
  v_hourly_remaining integer;
  v_limit integer;
begin
  if p_limit is null or p_limit < 1 then
    return;
  end if;

  perform pg_advisory_xact_lock(73821941, 1);

  select greatest(
    0,
    200
      - count(*) filter (where o.status = 'sent' and o.sent_at >= now() - interval '24 hours')
      - count(*) filter (where o.status = 'sending')
  )::integer
  into v_daily_remaining
  from public.ideaforge_email_outbox o;

  select greatest(
    0,
    40
      - count(*) filter (where o.status = 'sent' and o.sent_at >= now() - interval '1 hour')
  )::integer
  into v_hourly_remaining
  from public.ideaforge_email_outbox o;

  v_limit := least(p_limit, v_daily_remaining, v_hourly_remaining, 200);
  if v_limit < 1 then
    return;
  end if;

  return query
  with candidates as (
    select o.id
    from public.ideaforge_email_outbox o
    where o.status = 'pending'
      and o.next_attempt_at <= now()
      and o.attempt_count < 5
    order by o.next_attempt_at, o.created_at
    limit v_limit
    for update skip locked
  ),
  claimed as (
    update public.ideaforge_email_outbox o
    set status = 'sending',
        attempt_count = o.attempt_count + 1,
        locked_at = now(),
        last_error = null
    from candidates c
    where o.id = c.id
    returning o.id, o.team_id, o.recipient_email, o.recipient_name,
      o.team_name, o.team_code, o.member_names, o.attempt_count
  )
  select c.id, c.team_id, c.recipient_email, c.recipient_name,
    c.team_name, c.team_code, c.member_names, c.attempt_count
  from claimed c;
end;
$$;

revoke all on function public.ideaforge_email_claim(integer) from public, anon, authenticated;
grant execute on function public.ideaforge_email_claim(integer) to service_role;
