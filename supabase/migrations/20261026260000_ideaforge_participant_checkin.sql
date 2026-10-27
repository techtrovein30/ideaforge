-- Let every registered team member view team status and check in with an
-- admin-issued, short-lived QR session. Payment proof remains team-contact-only.

create table if not exists public.ideaforge_checkin_sessions (
  token uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.ideaforge_checkin_sessions enable row level security;
revoke all on table public.ideaforge_checkin_sessions from public, anon, authenticated;

create or replace function public.ideaforge_get_my_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
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
    'payment_status', t.payment_status,
    'created_at', t.created_at,
    'checked_in_at', t.checked_in_at,
    'is_team_contact', member.is_team_contact,
    'payment_utr', case when member.is_team_contact then t.payment_utr else null end,
    'screenshot_path', case when member.is_team_contact then t.screenshot_path else null end,
    'payment_submitted_at', case
      when member.is_team_contact then t.payment_submitted_at
      else null
    end,
    'members', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'full_name', m.full_name,
            'college_name', m.college_name,
            'mobile_number', m.mobile_number,
            'email', m.email,
            'is_team_contact', m.is_team_contact
          )
          order by m.is_team_contact desc, m.created_at, m.id
        ),
        '[]'::jsonb
      )
      from public.ideaforge_members m
      where m.team_id = t.id
        and (member.is_team_contact or lower(m.email) = v_email)
    ),
    'can_resubmit', (
      member.is_team_contact
      and t.payment_status = 'rejected'
      and latest_review.decision = 'reupload_requested'
    ),
    'payment_note', case
      when member.is_team_contact
        and t.payment_status = 'rejected'
        and latest_review.decision = 'reupload_requested'
        then latest_review.note
      else null
    end
  )
  into v_team
  from public.ideaforge_teams t
  join public.ideaforge_members member
    on member.team_id = t.id
   and lower(member.email) = v_email
  left join lateral (
    select r.decision, r.note
    from public.ideaforge_payment_reviews r
    where r.team_id = t.id
    order by r.created_at desc, r.id desc
    limit 1
  ) latest_review on true
  limit 1;

  return v_team;
end;
$$;

revoke all on function public.ideaforge_get_my_team() from public, anon;
grant execute on function public.ideaforge_get_my_team() to authenticated;

create or replace function public.ideaforge_create_checkin_session()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
declare
  v_admin_id uuid := auth.uid();
  v_token uuid;
  v_expires_at timestamptz := now() + interval '5 minutes';
begin
  if v_admin_id is null or not public.is_ideaforge_admin() then
    raise exception 'Only IdeaForge admins may create check-in QR codes'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(73821941, 2);

  delete from public.ideaforge_checkin_sessions;

  insert into public.ideaforge_checkin_sessions (created_by, expires_at)
  values (v_admin_id, v_expires_at)
  returning token into v_token;

  return jsonb_build_object('token', v_token, 'expires_at', v_expires_at);
end;
$$;

revoke all on function public.ideaforge_create_checkin_session() from public, anon;
grant execute on function public.ideaforge_create_checkin_session() to authenticated;

create or replace function public.ideaforge_check_in_my_team(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
declare
  v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_team_id uuid;
  v_team_name text;
  v_team_code text;
  v_checked_in_at timestamptz;
  v_already_checked_in boolean;
  v_attendee_count integer;
begin
  if auth.uid() is null or v_email = '' then
    raise exception 'Sign in with the Google account registered on your team'
      using errcode = '42501';
  end if;

  if p_token is null or not exists (
    select 1
    from public.ideaforge_checkin_sessions s
    where s.token = p_token
      and s.expires_at > now()
  ) then
    raise exception 'This check-in QR has expired. Ask an admin to display a new one';
  end if;

  select t.id, t.team_name, t.team_code, t.checked_in_at
  into v_team_id, v_team_name, v_team_code, v_checked_in_at
  from public.ideaforge_teams t
  join public.ideaforge_members m
    on m.team_id = t.id
   and lower(m.email) = v_email
  for update of t;

  if not found then
    raise exception 'No registered team matches this Google account';
  end if;

  v_already_checked_in := v_checked_in_at is not null;

  if not v_already_checked_in then
    update public.ideaforge_teams
    set checked_in_at = now(),
        checked_in_by = auth.uid()
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

revoke all on function public.ideaforge_check_in_my_team(uuid) from public, anon;
grant execute on function public.ideaforge_check_in_my_team(uuid) to authenticated;
