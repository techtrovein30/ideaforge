-- Accept valid email addresses from college and other domains for team members.
-- Team contacts must still match the email of their signed-in Google account.

alter table public.ideaforge_members
  drop constraint if exists ideaforge_members_email_check;

alter table public.ideaforge_members
  add constraint ideaforge_members_email_check
  check (
    btrim(email) ~* '^[^@[:space:]]+@[^@[:space:].]+([.][^@[:space:].]+)+$'
  );

create or replace function public.ideaforge_register_team(
  p_team_name text,
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

  if (
    select count(distinct lower(btrim(m.value ->> 'email')))
    from jsonb_array_elements(p_members) as m(value)
  ) <> v_member_count then
    raise exception 'Each team member must use a different email address';
  end if;

  insert into public.ideaforge_teams (team_name)
  values (btrim(p_team_name))
  returning id into v_team_id;

  insert into public.ideaforge_members (
    team_id,
    full_name,
    college_name,
    mobile_number,
    email,
    is_team_contact
  )
  select
    v_team_id,
    btrim(m.value ->> 'full_name'),
    btrim(m.value ->> 'college_name'),
    btrim(m.value ->> 'mobile_number'),
    lower(btrim(m.value ->> 'email')),
    m.ordinality = 1
  from jsonb_array_elements(p_members) with ordinality as m(value, ordinality);

  return v_team_id;
end;
$$;

revoke all on function public.ideaforge_register_team(text, jsonb) from public;
grant execute on function public.ideaforge_register_team(text, jsonb) to authenticated;
