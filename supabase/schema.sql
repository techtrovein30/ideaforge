-- IdeaForge hackathon schema
-- Run this file in Supabase Dashboard -> SQL Editor for the IdeaForge project.
-- This script is intended to be safe to re-run.
--
-- Before using the admin console:
-- 1. Sign in to IdeaForge once with the Google account that should be an admin.
-- 2. Replace ADMIN_GOOGLE_EMAIL in the bootstrap query at the bottom and run it.
--
-- Public browser access uses only the Supabase URL and anon/publishable key.
-- Never place a service-role key in this website.

create table if not exists public.ideaforge_settings (
  id boolean primary key default true check (id),
  registration_open boolean not null default true,
  registration_open_internal boolean not null default true,
  registration_open_external boolean not null default true,
  participant_checkin_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

insert into public.ideaforge_settings (id, registration_open, registration_open_internal, registration_open_external)
values (true, true, true, true)
on conflict (id) do nothing;

create table if not exists public.ideaforge_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.ideaforge_teams (
  id uuid primary key default gen_random_uuid(),
  team_name text not null check (char_length(btrim(team_name)) between 2 and 60),
  payment_status text not null default 'awaiting_payment'
    check (payment_status in ('awaiting_payment', 'pending_review', 'approved', 'rejected')),
  payment_utr text,
  screenshot_path text,
  created_at timestamptz not null default now(),
  payment_submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  constraint ideaforge_payment_fields_match_status check (
    (payment_status = 'awaiting_payment' and payment_utr is null and screenshot_path is null)
    or
    (payment_status <> 'awaiting_payment' and payment_utr is not null and screenshot_path is not null)
  )
);

create table if not exists public.ideaforge_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.ideaforge_teams (id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 100),
  college_name text not null check (char_length(btrim(college_name)) between 1 and 160),
  mobile_number text not null check (
    char_length(btrim(mobile_number)) between 7 and 18
    and btrim(mobile_number) ~ '^[0-9+() -]+$'
  ),
  email text not null check (btrim(email) ~* '^[^@[:space:]]+@[^@[:space:].]+([.][^@[:space:].]+)+$'),
  is_team_contact boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists ideaforge_members_email_unique
  on public.ideaforge_members (lower(email));

create unique index if not exists ideaforge_one_contact_per_team
  on public.ideaforge_members (team_id)
  where is_team_contact;

create unique index if not exists ideaforge_payment_utr_unique
  on public.ideaforge_teams (lower(btrim(payment_utr)))
  where payment_utr is not null;

create table if not exists public.ideaforge_payment_reviews (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.ideaforge_teams (id) on delete cascade,
  reviewer_id uuid not null references auth.users (id),
  decision text not null check (decision in ('approved', 'rejected')),
  note text check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now()
);

create or replace function public.is_ideaforge_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select exists (
    select 1
    from public.ideaforge_admins a
    where a.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_ideaforge_admin() from public;
grant execute on function public.is_ideaforge_admin() to anon, authenticated;

create or replace function public.ideaforge_can_upload_payment(p_team_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select exists (
    select 1
    from public.ideaforge_teams t
    where t.id::text = p_team_id
      and t.payment_status = 'awaiting_payment'
  );
$$;

revoke all on function public.ideaforge_can_upload_payment(text) from public;
grant execute on function public.ideaforge_can_upload_payment(text) to anon, authenticated;

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

  if exists (
    select 1
    from jsonb_array_elements(p_members) as m(value)
    join public.ideaforge_members registered
      on lower(registered.email) = lower(btrim(m.value ->> 'email'))
  ) then
    raise exception 'One or more email addresses are already registered on a team. If this is your own account, open My profile; otherwise verify the address or contact the organizers.'
      using errcode = '23505';
  end if;

  insert into public.ideaforge_teams (team_name)
  values (btrim(p_team_name))
  returning id into v_team_id;

  begin
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
  exception
    when unique_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'ideaforge_members_email_unique' then
        raise exception 'One or more email addresses are already registered on a team. If this is your own account, open My profile; otherwise verify the address or contact the organizers.'
          using errcode = '23505';
      end if;
      raise;
  end;

  return v_team_id;
end;
$$;

revoke all on function public.ideaforge_register_team(text, jsonb) from public;
grant execute on function public.ideaforge_register_team(text, jsonb) to authenticated;

create or replace function public.ideaforge_submit_payment(
  p_team_id uuid,
  p_utr text,
  p_screenshot_path text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_utr is null or char_length(btrim(p_utr)) not between 4 and 80 then
    raise exception 'UTR must contain between 4 and 80 characters';
  end if;

  if p_screenshot_path is null
    or split_part(p_screenshot_path, '/', 1) <> p_team_id::text
    or split_part(p_screenshot_path, '/', 2) = ''
    or split_part(p_screenshot_path, '/', 3) <> ''
  then
    raise exception 'Screenshot path must be a single file inside the team folder';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'ideaforge-payment-proofs'
      and o.name = p_screenshot_path
  ) then
    raise exception 'Payment screenshot has not been uploaded';
  end if;

  update public.ideaforge_teams t
  set payment_status = 'pending_review',
      payment_utr = btrim(p_utr),
      screenshot_path = p_screenshot_path,
      payment_submitted_at = now()
  where t.id = p_team_id
    and t.payment_status = 'awaiting_payment';

  if not found then
    raise exception 'Team was not found or payment was already submitted';
  end if;
end;
$$;

revoke all on function public.ideaforge_submit_payment(uuid, text, text) from public;
grant execute on function public.ideaforge_submit_payment(uuid, text, text) to anon, authenticated;

create or replace function public.ideaforge_review_payment(
  p_team_id uuid,
  p_decision text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid := auth.uid();
begin
  if v_admin_id is null or not public.is_ideaforge_admin() then
    raise exception 'Only IdeaForge admins may review payments'
      using errcode = '42501';
  end if;

  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  if p_note is not null and char_length(p_note) > 1000 then
    raise exception 'Review note cannot exceed 1000 characters';
  end if;

  update public.ideaforge_teams t
  set payment_status = p_decision,
      reviewed_at = now(),
      reviewed_by = v_admin_id
  where t.id = p_team_id
    and t.payment_status = 'pending_review';

  if not found then
    raise exception 'Team was not found or is not awaiting payment review';
  end if;

  insert into public.ideaforge_payment_reviews (team_id, reviewer_id, decision, note)
  values (p_team_id, v_admin_id, p_decision, nullif(btrim(p_note), ''));
end;
$$;

revoke all on function public.ideaforge_review_payment(uuid, text, text) from public;
grant execute on function public.ideaforge_review_payment(uuid, text, text) to authenticated;

alter table public.ideaforge_settings enable row level security;
alter table public.ideaforge_admins enable row level security;
alter table public.ideaforge_teams enable row level security;
alter table public.ideaforge_members enable row level security;
alter table public.ideaforge_payment_reviews enable row level security;

drop policy if exists "Anyone can read registration status" on public.ideaforge_settings;
create policy "Anyone can read registration status"
  on public.ideaforge_settings for select
  to anon, authenticated
  using (true);

drop policy if exists "Admins can update registration status" on public.ideaforge_settings;
create policy "Admins can update registration status"
  on public.ideaforge_settings for update
  to authenticated
  using (public.is_ideaforge_admin())
  with check (public.is_ideaforge_admin());

drop policy if exists "Admins can view admin list" on public.ideaforge_admins;
create policy "Admins can view admin list"
  on public.ideaforge_admins for select
  to authenticated
  using (public.is_ideaforge_admin());

drop policy if exists "Admins can view teams" on public.ideaforge_teams;
create policy "Admins can view teams"
  on public.ideaforge_teams for select
  to authenticated
  using (public.is_ideaforge_admin());

drop policy if exists "Admins can update teams" on public.ideaforge_teams;
create policy "Admins can update teams"
  on public.ideaforge_teams for update
  to authenticated
  using (public.is_ideaforge_admin())
  with check (public.is_ideaforge_admin());

drop policy if exists "Admins can delete teams" on public.ideaforge_teams;
create policy "Admins can delete teams"
  on public.ideaforge_teams for delete
  to authenticated
  using (public.is_ideaforge_admin());

drop policy if exists "Admins can view members" on public.ideaforge_members;
create policy "Admins can view members"
  on public.ideaforge_members for select
  to authenticated
  using (public.is_ideaforge_admin());

drop policy if exists "Admins can manage members" on public.ideaforge_members;
create policy "Admins can manage members"
  on public.ideaforge_members for all
  to authenticated
  using (public.is_ideaforge_admin())
  with check (public.is_ideaforge_admin());

drop policy if exists "Admins can view payment reviews" on public.ideaforge_payment_reviews;
create policy "Admins can view payment reviews"
  on public.ideaforge_payment_reviews for select
  to authenticated
  using (public.is_ideaforge_admin());

grant select on public.ideaforge_settings to anon, authenticated;
grant update on public.ideaforge_settings to authenticated;
grant select on public.ideaforge_admins to authenticated;
grant select, update, delete on public.ideaforge_teams to authenticated;
grant select, insert, update, delete on public.ideaforge_members to authenticated;
grant select on public.ideaforge_payment_reviews to authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'ideaforge-payment-proofs',
  'ideaforge-payment-proofs',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Payment proofs are private. Public users may upload only into a valid,
-- awaiting-payment team folder; only admins may read or delete stored files.
drop policy if exists "Teams can upload their payment proof" on storage.objects;
create policy "Teams can upload their payment proof"
  on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'ideaforge-payment-proofs'
    and split_part(name, '/', 2) <> ''
    and split_part(name, '/', 3) = ''
    and public.ideaforge_can_upload_payment(split_part(name, '/', 1))
  );

drop policy if exists "Admins can view payment proofs" on storage.objects;
create policy "Admins can view payment proofs"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'ideaforge-payment-proofs'
    and public.is_ideaforge_admin()
  );

drop policy if exists "Admins can delete payment proofs" on storage.objects;
create policy "Admins can delete payment proofs"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'ideaforge-payment-proofs'
    and public.is_ideaforge_admin()
  );

-- Admin bootstrap (manual, after the admin has signed in with Google once):
-- Replace the email with the exact Google account that should administer
-- IdeaForge, uncomment the query, and run it in the SQL Editor.
--
-- insert into public.ideaforge_admins (user_id)
-- select id
-- from auth.users
-- where lower(email) = lower('ADMIN_GOOGLE_EMAIL')
-- on conflict (user_id) do nothing;
