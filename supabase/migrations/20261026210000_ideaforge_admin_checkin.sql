-- Team codes, leader-profile QR data, and admin check-in tools.
-- Apply after schema.sql and 20261025230000_ideaforge_email_confirmation.sql.

alter table public.ideaforge_teams
  add column if not exists team_code text,
  add column if not exists checked_in_at timestamptz,
  add column if not exists checked_in_by uuid references auth.users (id) on delete set null;

update public.ideaforge_teams
set team_code = 'IF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
where team_code is null;

alter table public.ideaforge_teams
  alter column team_code set default (
    'IF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  alter column team_code set not null;

create unique index if not exists ideaforge_teams_team_code_unique
  on public.ideaforge_teams (team_code);

create index if not exists ideaforge_teams_checked_in_idx
  on public.ideaforge_teams (checked_in_at)
  where checked_in_at is not null;

alter table public.ideaforge_email_outbox
  add column if not exists team_code text;

update public.ideaforge_email_outbox o
set team_code = t.team_code
from public.ideaforge_teams t
where o.team_id = t.id
  and o.team_code is null;

alter table public.ideaforge_email_outbox
  alter column team_code set not null;

create or replace function public.ideaforge_queue_payment_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
declare
  v_recipient_email text;
  v_recipient_name text;
  v_member_names text[];
begin
  select m.email, m.full_name
  into v_recipient_email, v_recipient_name
  from public.ideaforge_members m
  where m.team_id = new.id
  order by m.is_team_contact desc, m.created_at, m.id
  limit 1;

  select coalesce(
    array_agg(m.full_name order by m.is_team_contact desc, m.created_at, m.id),
    '{}'::text[]
  )
  into v_member_names
  from public.ideaforge_members m
  where m.team_id = new.id;

  insert into public.ideaforge_email_outbox (
    team_id,
    team_code,
    recipient_email,
    recipient_name,
    team_name,
    member_names,
    status,
    last_error
  )
  values (
    new.id,
    new.team_code,
    v_recipient_email,
    v_recipient_name,
    new.team_name,
    v_member_names,
    case when v_recipient_email is null then 'failed' else 'pending' end,
    case
      when v_recipient_email is null
        then 'No team member email was available at approval time.'
      else null
    end
  )
  on conflict (team_id, kind) do nothing;

  return new;
end;
$$;

revoke all on function public.ideaforge_queue_payment_confirmation() from public;

drop function public.ideaforge_email_claim(integer);

create function public.ideaforge_email_claim(p_limit integer default 20)
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
  v_remaining integer;
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
  into v_remaining
  from public.ideaforge_email_outbox o;

  v_limit := least(p_limit, v_remaining, 100);
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

create or replace function public.ideaforge_get_my_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_team jsonb;
  v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
begin
  if auth.uid() is null or v_email = '' then
    raise exception 'Sign in to view your team profile'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'team_id', t.id,
    'team_name', t.team_name,
    'team_code', t.team_code,
    'payment_status', t.payment_status
  )
  into v_team
  from public.ideaforge_teams t
  join public.ideaforge_members m on m.team_id = t.id
  where m.is_team_contact
    and lower(m.email) = v_email
  limit 1;

  return v_team;
end;
$$;

revoke all on function public.ideaforge_get_my_team() from public, anon;
grant execute on function public.ideaforge_get_my_team() to authenticated;

create or replace function public.ideaforge_check_in_team(p_team_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_admin_id uuid := auth.uid();
  v_team_id uuid;
  v_team_name text;
  v_team_code text;
  v_checked_in_at timestamptz;
  v_already_checked_in boolean;
  v_attendee_count integer;
begin
  if v_admin_id is null or not public.is_ideaforge_admin() then
    raise exception 'Only IdeaForge admins may check in teams'
      using errcode = '42501';
  end if;

  if p_team_code is null or btrim(p_team_code) = '' then
    raise exception 'Enter a team code';
  end if;

  select t.id, t.team_name, t.team_code, t.checked_in_at
  into v_team_id, v_team_name, v_team_code, v_checked_in_at
  from public.ideaforge_teams t
  where upper(t.team_code) = upper(btrim(p_team_code))
  for update;

  if not found then
    raise exception 'No team was found for that code';
  end if;

  v_already_checked_in := v_checked_in_at is not null;

  if not v_already_checked_in then
    update public.ideaforge_teams
    set checked_in_at = now(),
        checked_in_by = v_admin_id
    where id = v_team_id
    returning checked_in_at into v_checked_in_at;
  end if;

  select count(*)::integer
  into v_attendee_count
  from public.ideaforge_members m
  where m.team_id = v_team_id;

  return jsonb_build_object(
    'team_name', v_team_name,
    'team_code', v_team_code,
    'attendee_count', v_attendee_count,
    'checked_in_at', v_checked_in_at,
    'already_checked_in', v_already_checked_in
  );
end;
$$;

revoke all on function public.ideaforge_check_in_team(text) from public, anon;
grant execute on function public.ideaforge_check_in_team(text) to authenticated;
