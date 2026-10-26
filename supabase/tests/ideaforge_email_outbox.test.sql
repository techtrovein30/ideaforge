-- Run only against a disposable local/test database after applying
-- migrations/20261025230000_ideaforge_email_confirmation.sql and
-- migrations/20261026210000_ideaforge_admin_checkin.sql.
-- The transaction is always rolled back and never sends email.

begin;

do $$
declare
  v_team_id uuid := gen_random_uuid();
  v_queue_count integer;
  v_status text;
  v_recipient text;
  v_team_code text;
  v_outbox_team_code text;
begin
  insert into public.ideaforge_teams (
    id, team_name, payment_status, payment_utr, screenshot_path
  )
  values (
    v_team_id, 'Email trigger test', 'pending_review', v_team_id::text,
    v_team_id::text || '/test.png'
  );

  insert into public.ideaforge_members (
    team_id, full_name, college_name, mobile_number, email, is_team_contact
  )
  values (
    v_team_id, 'Test Participant', 'Test College', '9876543210',
    'ideaforge-test-' || v_team_id::text || '@gmail.com', true
  );

  update public.ideaforge_teams
  set payment_status = 'approved'
  where id = v_team_id;

  select team_code
  into v_team_code
  from public.ideaforge_teams
  where id = v_team_id;

  select count(*), min(status), min(recipient_email), min(team_code)
  into v_queue_count, v_status, v_recipient, v_outbox_team_code
  from public.ideaforge_email_outbox
  where team_id = v_team_id;

  if v_queue_count <> 1 or v_status <> 'pending'
    or v_recipient <> ('ideaforge-test-' || v_team_id::text || '@gmail.com')
    or v_outbox_team_code <> v_team_code then
    raise exception 'Approval should queue one confirmation with the team contact and unique code.';
  end if;

  update public.ideaforge_teams
  set payment_status = 'pending_review'
  where id = v_team_id;

  update public.ideaforge_teams
  set payment_status = 'approved'
  where id = v_team_id;

  select count(*)
  into v_queue_count
  from public.ideaforge_email_outbox
  where team_id = v_team_id;

  if v_queue_count <> 1 then
    raise exception 'Repeated approval transitions must not duplicate the confirmation.';
  end if;
end;
$$;

rollback;
