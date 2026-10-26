-- Admin payment re-upload requests and team-leader resubmission.
-- Apply after 20261026210000_ideaforge_admin_checkin.sql.

alter table public.ideaforge_payment_reviews
  drop constraint if exists ideaforge_payment_reviews_decision_check;

alter table public.ideaforge_payment_reviews
  add constraint ideaforge_payment_reviews_decision_check
  check (decision in ('approved', 'rejected', 'reupload_requested'));

create or replace function public.ideaforge_can_upload_payment(p_team_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.ideaforge_teams t
      join public.ideaforge_members m on m.team_id = t.id
      where t.id::text = p_team_id
        and t.payment_status in ('awaiting_payment', 'rejected')
        and m.is_team_contact
        and lower(m.email) = lower(btrim(coalesce(auth.jwt() ->> 'email', '')))
    );
$$;

revoke all on function public.ideaforge_can_upload_payment(text) from public, anon;
grant execute on function public.ideaforge_can_upload_payment(text) to authenticated;

drop policy if exists "Teams can upload their payment proof" on storage.objects;
create policy "Team contacts can upload payment proof"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'ideaforge-payment-proofs'
    and split_part(name, '/', 2) <> ''
    and split_part(name, '/', 3) = ''
    and public.ideaforge_can_upload_payment(split_part(name, '/', 1))
  );

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
declare
  v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
begin
  if auth.uid() is null or v_email = '' then
    raise exception 'Sign in as the team leader to submit payment details'
      using errcode = '42501';
  end if;

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
      payment_submitted_at = now(),
      reviewed_at = null,
      reviewed_by = null
  where t.id = p_team_id
    and t.payment_status in ('awaiting_payment', 'rejected')
    and exists (
      select 1
      from public.ideaforge_members m
      where m.team_id = t.id
        and m.is_team_contact
        and lower(m.email) = v_email
    );

  if not found then
    raise exception 'Team was not found, or payment is not awaiting submission';
  end if;
end;
$$;

revoke all on function public.ideaforge_submit_payment(uuid, text, text) from public, anon;
grant execute on function public.ideaforge_submit_payment(uuid, text, text) to authenticated;

create or replace function public.ideaforge_request_payment_reupload(
  p_team_id uuid,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid := auth.uid();
  v_note text := nullif(btrim(p_note), '');
begin
  if v_admin_id is null or not public.is_ideaforge_admin() then
    raise exception 'Only IdeaForge admins may request payment re-uploads'
      using errcode = '42501';
  end if;

  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'Re-upload instructions cannot exceed 1000 characters';
  end if;

  update public.ideaforge_teams
  set payment_status = 'rejected',
      reviewed_at = now(),
      reviewed_by = v_admin_id
  where id = p_team_id
    and payment_status = 'pending_review';

  if not found then
    raise exception 'Team was not found or is not awaiting payment review';
  end if;

  insert into public.ideaforge_payment_reviews (team_id, reviewer_id, decision, note)
  values (
    p_team_id,
    v_admin_id,
    'reupload_requested',
    coalesce(v_note, 'Please upload a clear payment proof and verify the UTR before resubmitting.')
  );
end;
$$;

revoke all on function public.ideaforge_request_payment_reupload(uuid, text) from public, anon;
grant execute on function public.ideaforge_request_payment_reupload(uuid, text) to authenticated;

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
    'payment_status', t.payment_status,
    'payment_note', review.note
  )
  into v_team
  from public.ideaforge_teams t
  join public.ideaforge_members m on m.team_id = t.id
  left join lateral (
    select r.note
    from public.ideaforge_payment_reviews r
    where r.team_id = t.id
      and r.decision = 'reupload_requested'
    order by r.created_at desc
    limit 1
  ) review on true
  where m.is_team_contact
    and lower(m.email) = v_email
  limit 1;

  return v_team;
end;
$$;

revoke all on function public.ideaforge_get_my_team() from public, anon;
grant execute on function public.ideaforge_get_my_team() to authenticated;
