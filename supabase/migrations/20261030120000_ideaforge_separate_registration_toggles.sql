-- Separate registration on/off controls for internal and external teams.
--
-- Existing projects keep the current status for both types the first time this
-- migration runs. Re-running the migration never resets independent toggles.

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ideaforge_settings'
      and column_name = 'registration_open_internal'
  ) then
    alter table public.ideaforge_settings
      add column registration_open_internal boolean not null default true;

    update public.ideaforge_settings
    set registration_open_internal = registration_open
    where id = true;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ideaforge_settings'
      and column_name = 'registration_open_external'
  ) then
    alter table public.ideaforge_settings
      add column registration_open_external boolean not null default true;

    update public.ideaforge_settings
    set registration_open_external = registration_open
    where id = true;
  end if;
end;
$$;

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
  v_registration_open boolean;
  v_authenticated_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
begin
  if auth.uid() is null or v_authenticated_email = '' then
    raise exception 'Sign in before registering your team';
  end if;

  if p_team_name is null or char_length(btrim(p_team_name)) not between 2 and 60 then
    raise exception 'Team name must contain between 2 and 60 characters';
  end if;

  if p_registration_type is null or p_registration_type not in ('internal', 'external') then
    raise exception 'Registration type must be internal or external';
  end if;

  select case p_registration_type
    when 'internal' then s.registration_open_internal
    else s.registration_open_external
  end
  into v_registration_open
  from public.ideaforge_settings s
  where s.id = true;

  if not coalesce(v_registration_open, false) then
    raise exception '% registration is currently closed', initcap(p_registration_type);
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
