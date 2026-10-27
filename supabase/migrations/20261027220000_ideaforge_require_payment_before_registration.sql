-- A team is not registered, and its team code is not released, until payment
-- proof has been submitted.

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
