-- Admin-only registration deletion with a permanent audit snapshot.
--
-- A team row cascades to ideaforge_members, ideaforge_payment_reviews, and
-- ideaforge_email_outbox. Storage files do NOT cascade, so the RPC returns the
-- full list of proof paths for the browser to remove with the Storage API.

create table if not exists public.ideaforge_deleted_teams (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  team_code text,
  team_name text not null,
  registration_type text,
  payment_status text,
  payment_utr text,
  screenshot_paths text[] not null default '{}',
  checked_in_at timestamptz,
  team_created_at timestamptz,
  members jsonb not null default '[]'::jsonb,
  payment_reviews jsonb not null default '[]'::jsonb,
  email_outbox jsonb not null default '[]'::jsonb,
  note text check (note is null or char_length(note) <= 1000),
  deleted_by uuid references auth.users (id) on delete set null,
  deleted_by_email text,
  deleted_at timestamptz not null default now()
);

create index if not exists ideaforge_deleted_teams_deleted_at_idx
  on public.ideaforge_deleted_teams (deleted_at desc);

alter table public.ideaforge_deleted_teams enable row level security;

drop policy if exists "Admins can view deleted teams" on public.ideaforge_deleted_teams;
create policy "Admins can view deleted teams"
  on public.ideaforge_deleted_teams for select
  to authenticated
  using (public.is_ideaforge_admin());

revoke all on public.ideaforge_deleted_teams from anon, authenticated;
grant select on public.ideaforge_deleted_teams to authenticated;

create or replace function public.ideaforge_delete_team(
  p_team_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
declare
  v_admin_id uuid := auth.uid();
  v_admin_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_team public.ideaforge_teams%rowtype;
  v_members jsonb;
  v_reviews jsonb;
  v_emails jsonb;
  v_paths text[];
  v_archive_id uuid;
begin
  if v_admin_id is null or not public.is_ideaforge_admin() then
    raise exception 'Only IdeaForge admins may delete registrations'
      using errcode = '42501';
  end if;

  if p_team_id is null then
    raise exception 'A team id is required';
  end if;

  if p_note is not null and char_length(p_note) > 1000 then
    raise exception 'Deletion note cannot exceed 1000 characters';
  end if;

  select *
  into v_team
  from public.ideaforge_teams t
  where t.id = p_team_id
  for update;

  if not found then
    raise exception 'Team was not found or was already deleted'
      using errcode = 'P0002';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'full_name', m.full_name,
        'college_name', m.college_name,
        'mobile_number', m.mobile_number,
        'email', m.email,
        'register_number', m.register_number,
        'is_team_contact', m.is_team_contact,
        'created_at', m.created_at
      )
      order by m.is_team_contact desc, m.created_at, m.id
    ),
    '[]'::jsonb
  )
  into v_members
  from public.ideaforge_members m
  where m.team_id = p_team_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'decision', r.decision,
        'note', r.note,
        'reviewer_id', r.reviewer_id,
        'created_at', r.created_at
      )
      order by r.created_at, r.id
    ),
    '[]'::jsonb
  )
  into v_reviews
  from public.ideaforge_payment_reviews r
  where r.team_id = p_team_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'recipient_email', o.recipient_email,
        'recipient_name', o.recipient_name,
        'status', o.status,
        'attempt_count', o.attempt_count,
        'sent_at', o.sent_at,
        'created_at', o.created_at
      )
      order by o.created_at, o.id
    ),
    '[]'::jsonb
  )
  into v_emails
  from public.ideaforge_email_outbox o
  where o.team_id = p_team_id;

  -- Every payment upload lives under the team UUID prefix. This catches the
  -- current proof and any older proofs left behind by re-upload requests.
  select coalesce(array_agg(o.name order by o.name), '{}'::text[])
  into v_paths
  from storage.objects o
  where o.bucket_id = 'ideaforge-payment-proofs'
    and split_part(o.name, '/', 1) = p_team_id::text;

  insert into public.ideaforge_deleted_teams (
    team_id,
    team_code,
    team_name,
    registration_type,
    payment_status,
    payment_utr,
    screenshot_paths,
    checked_in_at,
    team_created_at,
    members,
    payment_reviews,
    email_outbox,
    note,
    deleted_by,
    deleted_by_email
  )
  values (
    v_team.id,
    v_team.team_code,
    v_team.team_name,
    v_team.registration_type,
    v_team.payment_status,
    v_team.payment_utr,
    v_paths,
    v_team.checked_in_at,
    v_team.created_at,
    v_members,
    v_reviews,
    v_emails,
    nullif(btrim(p_note), ''),
    v_admin_id,
    nullif(v_admin_email, '')
  )
  returning id into v_archive_id;

  delete from public.ideaforge_teams t
  where t.id = p_team_id;

  return jsonb_build_object(
    'archive_id', v_archive_id,
    'team_id', v_team.id,
    'team_name', v_team.team_name,
    'team_code', v_team.team_code,
    'screenshot_paths', to_jsonb(v_paths)
  );
end;
$$;

revoke all on function public.ideaforge_delete_team(uuid, text) from public, anon;
grant execute on function public.ideaforge_delete_team(uuid, text) to authenticated;

-- Make the new RPC and audit table visible to PostgREST immediately.
notify pgrst, 'reload schema';
