-- Return the signed-in team contact's registration, roster, and payment details.
-- Resubmission is allowed only after the latest admin review requested it.

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
    'payment_utr', t.payment_utr,
    'screenshot_path', t.screenshot_path,
    'payment_submitted_at', t.payment_submitted_at,
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
    ),
    'can_resubmit', (
      t.payment_status = 'rejected'
      and latest_review.decision = 'reupload_requested'
    ),
    'payment_note', case
      when t.payment_status = 'rejected'
        and latest_review.decision = 'reupload_requested'
        then latest_review.note
      else null
    end
  )
  into v_team
  from public.ideaforge_teams t
  join public.ideaforge_members contact
    on contact.team_id = t.id
   and contact.is_team_contact
   and lower(contact.email) = v_email
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

create or replace function public.ideaforge_can_view_my_payment_proof(p_team_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.ideaforge_teams t
      join public.ideaforge_members m
        on m.team_id = t.id
       and m.is_team_contact
       and lower(m.email) = lower(btrim(coalesce(auth.jwt() ->> 'email', '')))
      where t.id::text = p_team_id
    );
$$;

revoke all on function public.ideaforge_can_view_my_payment_proof(text)
  from public, anon;
grant execute on function public.ideaforge_can_view_my_payment_proof(text)
  to authenticated;

drop policy if exists "Team contacts can view their payment proof"
  on storage.objects;
create policy "Team contacts can view their payment proof"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'ideaforge-payment-proofs'
    and public.ideaforge_can_view_my_payment_proof(
      split_part(storage.objects.name, '/', 1)
    )
  );

create or replace function public.ideaforge_can_upload_payment(p_team_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.ideaforge_teams t
      join public.ideaforge_members m
        on m.team_id = t.id
       and m.is_team_contact
       and lower(m.email) = lower(btrim(coalesce(auth.jwt() ->> 'email', '')))
      where t.id::text = p_team_id
        and (
          t.payment_status = 'awaiting_payment'
          or (
            t.payment_status = 'rejected'
            and exists (
              select 1
              from public.ideaforge_payment_reviews current_review
              where current_review.team_id = t.id
                and current_review.decision = 'reupload_requested'
                and not exists (
                  select 1
                  from public.ideaforge_payment_reviews newer_review
                  where newer_review.team_id = t.id
                    and (newer_review.created_at, newer_review.id)
                        > (current_review.created_at, current_review.id)
                )
            )
          )
        )
    );
$$;

revoke all on function public.ideaforge_can_upload_payment(text)
  from public, anon;
grant execute on function public.ideaforge_can_upload_payment(text)
  to authenticated;

create or replace function public.ideaforge_submit_payment(
  p_team_id uuid,
  p_utr text,
  p_screenshot_path text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
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
    and exists (
      select 1
      from public.ideaforge_members m
      where m.team_id = t.id
        and m.is_team_contact
        and lower(m.email) = v_email
    )
    and (
      t.payment_status = 'awaiting_payment'
      or (
        t.payment_status = 'rejected'
        and exists (
          select 1
          from public.ideaforge_payment_reviews current_review
          where current_review.team_id = t.id
            and current_review.decision = 'reupload_requested'
            and not exists (
              select 1
              from public.ideaforge_payment_reviews newer_review
              where newer_review.team_id = t.id
                and (newer_review.created_at, newer_review.id)
                    > (current_review.created_at, current_review.id)
            )
        )
      )
    );

  if not found then
    raise exception 'Team was not found, or payment submission is not currently allowed';
  end if;
end;
$$;

revoke all on function public.ideaforge_submit_payment(uuid, text, text)
  from public, anon;
grant execute on function public.ideaforge_submit_payment(uuid, text, text)
  to authenticated;
