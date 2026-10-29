alter table public.ideaforge_teams
  add column if not exists registration_type text not null default 'external';

alter table public.ideaforge_teams
  drop constraint if exists ideaforge_teams_registration_type_check;

alter table public.ideaforge_teams
  add constraint ideaforge_teams_registration_type_check
  check (registration_type in ('internal', 'external'));

alter table public.ideaforge_members
  add column if not exists register_number text;

alter table public.ideaforge_members
  drop constraint if exists ideaforge_members_register_number_check;

alter table public.ideaforge_members
  add constraint ideaforge_members_register_number_check
  check (
    register_number is null
    or char_length(btrim(register_number)) between 1 and 40
  );

create unique index if not exists ideaforge_members_register_number_unique
  on public.ideaforge_members (lower(btrim(register_number)))
  where register_number is not null;

alter table public.ideaforge_teams
  drop constraint if exists ideaforge_teams_payment_status_check;

alter table public.ideaforge_teams
  add constraint ideaforge_teams_payment_status_check
  check (payment_status in ('awaiting_payment', 'pending_review', 'approved', 'rejected', 'not_required'));

alter table public.ideaforge_teams
  drop constraint if exists ideaforge_payment_fields_match_status;

alter table public.ideaforge_teams
  add constraint ideaforge_payment_fields_match_status check (
    (
      payment_status in ('awaiting_payment', 'not_required')
      and payment_utr is null
      and screenshot_path is null
    )
    or (
      payment_status not in ('awaiting_payment', 'not_required')
      and payment_utr is not null
      and screenshot_path is not null
    )
  );

drop function if exists public.ideaforge_register_team(text, jsonb);

create or replace function public.ideaforge_register_team(
  p_team_name text,
  p_registration_type text,
  p_members jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id uuid;
  v_member_count integer;
  v_constraint_name text;
  v_authenticated_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
begin
  if auth.uid() is null or v_authenticated_email = '' then
    raise exception 'Sign in before registering your team';
  end if;

  if not coalesce(
    (select s.registration_open from public.ideaforge_settings s where s.id = true),
    false
  ) then
    raise exception 'Registration is currently closed';
  end if;

  if p_team_name is null or char_length(btrim(p_team_name)) not between 2 and 60 then
    raise exception 'Team name must contain between 2 and 60 characters';
  end if;

  if p_registration_type is null or p_registration_type not in ('internal', 'external') then
    raise exception 'Registration type must be internal or external';
  end if;

  if p_members is null or jsonb_typeof(p_members) <> 'array' then
    raise exception 'Members must be supplied as a JSON array';
  end if;

  if lower(btrim(coalesce(p_members -> 0 ->> 'email', ''))) <> v_authenticated_email then
    raise exception 'The team contact email must match your signed-in account';
  end if;

  v_member_count := jsonb_array_length(p_members);
  if v_member_count not between 2 and 5 then
    raise exception 'A team must have between 2 and 5 members';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_members) as m(value)
    where
      jsonb_typeof(m.value) <> 'object'
      or nullif(btrim(m.value ->> 'full_name'), '') is null
      or char_length(btrim(m.value ->> 'full_name')) > 100
      or nullif(btrim(m.value ->> 'college_name'), '') is null
      or char_length(btrim(m.value ->> 'college_name')) > 160
      or coalesce(btrim(m.value ->> 'mobile_number'), '') !~ '^[0-9+() -]{7,18}$'
      or coalesce(btrim(m.value ->> 'email'), '') !~* '^[^@[:space:]]+@[^@[:space:].]+([.][^@[:space:].]+)+$'
  ) then
    raise exception 'Every member needs a valid name, college, mobile number, and email address';
  end if;

  if p_registration_type = 'internal' and exists (
    select 1
    from jsonb_array_elements(p_members) as m(value)
    where coalesce(jsonb_typeof(m.value -> 'register_number'), '') <> 'string'
      or char_length(btrim(m.value ->> 'register_number')) not between 1 and 40
  ) then
    raise exception 'Every internal member must provide a register number of 1 to 40 characters';
  end if;

  if (
    select count(distinct lower(btrim(m.value ->> 'email')))
    from jsonb_array_elements(p_members) as m(value)
  ) <> v_member_count then
    raise exception 'Each team member must use a different email address';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_members) as m(value)
    join public.ideaforge_members registered
      on lower(registered.email) = lower(btrim(m.value ->> 'email'))
  ) then
    raise exception 'One or more email addresses are already registered on a team. If this is your own account, open My profile; otherwise verify the address or contact the organizers.'
      using errcode = '23505';
  end if;

  if p_registration_type = 'internal' and (
    select count(distinct lower(btrim(m.value ->> 'register_number')))
    from jsonb_array_elements(p_members) as m(value)
  ) <> v_member_count then
    raise exception 'Each team member must provide a different register number';
  end if;

  if p_registration_type = 'internal' and exists (
    select 1
    from jsonb_array_elements(p_members) as m(value)
    join public.ideaforge_members registered
      on lower(btrim(registered.register_number)) = lower(btrim(m.value ->> 'register_number'))
  ) then
    raise exception 'One or more register numbers are already registered. Check the numbers or contact the organizers.'
      using errcode = '23505';
  end if;

  insert into public.ideaforge_teams (team_name, registration_type, payment_status)
  values (
    btrim(p_team_name),
    p_registration_type,
    case when p_registration_type = 'internal' then 'not_required' else 'awaiting_payment' end
  )
  returning id into v_team_id;

  begin
    insert into public.ideaforge_members (
      team_id,
      full_name,
      college_name,
      mobile_number,
      email,
      register_number,
      is_team_contact
    )
    select
      v_team_id,
      btrim(m.value ->> 'full_name'),
      btrim(m.value ->> 'college_name'),
      btrim(m.value ->> 'mobile_number'),
      lower(btrim(m.value ->> 'email')),
      case
        when p_registration_type = 'internal' then btrim(m.value ->> 'register_number')
        else null
      end,
      m.ordinality = 1
    from jsonb_array_elements(p_members) with ordinality as m(value, ordinality);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'ideaforge_members_email_unique' then
        raise exception 'One or more email addresses are already registered on a team. If this is your own account, open My profile; otherwise verify the address or contact the organizers.'
          using errcode = '23505';
      elsif v_constraint_name = 'ideaforge_members_register_number_unique' then
        raise exception 'One or more register numbers are already registered. Check the numbers or contact the organizers.'
          using errcode = '23505';
      end if;
      raise;
  end;

  return v_team_id;
end;
$$;

revoke all on function public.ideaforge_register_team(text, text, jsonb) from public;
grant execute on function public.ideaforge_register_team(text, text, jsonb) to authenticated;

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
    'registration_type', t.registration_type,
    'team_code', case
      when t.payment_status <> 'awaiting_payment' then t.team_code
      else null
    end,
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
            'register_number', m.register_number,
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
