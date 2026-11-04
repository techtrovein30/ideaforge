create table public.ideaforge_email_delivery_history (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid,
  outbox_id uuid,
  kind text not null check (kind in ('participant', 'batch_confirmation')),
  status text not null check (status in ('reserved', 'sent', 'released')),
  recipient_email text not null,
  reserved_at timestamptz not null default now(),
  sent_at timestamptz,
  gmail_message_id text
);

create index ideaforge_email_delivery_history_sent_idx
  on public.ideaforge_email_delivery_history (sent_at)
  where status = 'sent';
create index ideaforge_email_delivery_history_reserved_idx
  on public.ideaforge_email_delivery_history (reserved_at)
  where status = 'reserved';

alter table public.ideaforge_email_delivery_history enable row level security;
revoke all on public.ideaforge_email_delivery_history from public, anon, authenticated;
grant select, insert, update on public.ideaforge_email_delivery_history to service_role;

insert into public.ideaforge_email_delivery_history (
  outbox_id, kind, status, recipient_email, reserved_at, sent_at, gmail_message_id
)
select id, 'participant', 'sent', coalesce(recipient_email, ''), coalesce(sent_at, now()),
  coalesce(sent_at, now()), gmail_message_id
from public.ideaforge_email_outbox
where status = 'sent';

create function public.ideaforge_email_mark_sent(p_id uuid, p_message_id text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
declare
  v_recipient_email text;
  v_sent_at timestamptz := now();
begin
  update public.ideaforge_email_outbox
  set status = 'sent',
      sent_at = v_sent_at,
      locked_at = null,
      gmail_message_id = p_message_id,
      last_error = null
  where id = p_id
    and status = 'sending'
  returning recipient_email into v_recipient_email;

  if not found then
    raise exception 'Email job is no longer marked as sending';
  end if;

  insert into public.ideaforge_email_delivery_history (
    outbox_id, kind, status, recipient_email, reserved_at, sent_at, gmail_message_id
  )
  values (p_id, 'participant', 'sent', coalesce(v_recipient_email, ''), v_sent_at, v_sent_at, p_message_id);
end;
$$;

revoke all on function public.ideaforge_email_mark_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.ideaforge_email_mark_sent(uuid, text) to service_role;

create function public.ideaforge_email_mark_canary_sent(p_batch_id uuid, p_message_id text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
begin
  update public.ideaforge_email_delivery_history
  set status = 'sent',
      sent_at = now(),
      gmail_message_id = p_message_id
  where batch_id = p_batch_id
    and kind = 'batch_confirmation'
    and status = 'reserved';

  if not found then
    raise exception 'Batch confirmation slot is no longer reserved';
  end if;
end;
$$;

revoke all on function public.ideaforge_email_mark_canary_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.ideaforge_email_mark_canary_sent(uuid, text) to service_role;

create function public.ideaforge_email_release_canary(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
begin
  update public.ideaforge_email_delivery_history
  set status = 'released'
  where batch_id = p_batch_id
    and kind = 'batch_confirmation'
    and status = 'reserved';
end;
$$;

revoke all on function public.ideaforge_email_release_canary(uuid) from public, anon, authenticated;
grant execute on function public.ideaforge_email_release_canary(uuid) to service_role;

drop function public.ideaforge_email_claim(integer);

create function public.ideaforge_email_claim(p_limit integer default 10)
returns table (
  id uuid,
  team_id uuid,
  recipient_email text,
  recipient_name text,
  team_name text,
  team_code text,
  member_names text[],
  attempt_count integer,
  batch_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
declare
  v_daily_remaining integer;
  v_limit integer;
  v_batch_id uuid := gen_random_uuid();
begin
  if p_limit is null or p_limit < 1 then
    return;
  end if;

  perform pg_advisory_xact_lock(73821941, 1);

  select greatest(
    0,
    200
      - (select count(*)
         from public.ideaforge_email_delivery_history h
         where h.status = 'sent'
           and h.sent_at >= now() - interval '24 hours')
      - (select count(*)
         from public.ideaforge_email_delivery_history h
         where h.status = 'reserved'
           and h.reserved_at >= now() - interval '24 hours')
      - (select count(*)
         from public.ideaforge_email_outbox o
         where o.status = 'sending')
  )::integer
  into v_daily_remaining;

  v_limit := least(p_limit, greatest(0, v_daily_remaining - 1), 200);
  if v_limit < 1 then
    return;
  end if;

  return query
  with candidates as (
    select o.id
    from public.ideaforge_email_outbox o
    where o.status = 'pending'
      and o.next_attempt_at <= now()
      and o.attempt_count < 5
    order by o.next_attempt_at, o.created_at
    limit v_limit
    for update skip locked
  ),
  claimed as (
    update public.ideaforge_email_outbox o
    set status = 'sending',
        attempt_count = o.attempt_count + 1,
        locked_at = now(),
        last_error = null
    from candidates c
    where o.id = c.id
    returning o.id, o.team_id, o.recipient_email, o.recipient_name,
      o.team_name, o.team_code, o.member_names, o.attempt_count
  ),
  reservation as (
    insert into public.ideaforge_email_delivery_history (
      batch_id, kind, status, recipient_email
    )
    select v_batch_id, 'batch_confirmation', 'reserved', 'suvedhansuveg14@gmail.com'
    where exists (select 1 from claimed)
    returning batch_id
  )
  select c.id, c.team_id, c.recipient_email, c.recipient_name,
    c.team_name, c.team_code, c.member_names, c.attempt_count, r.batch_id
  from claimed c
  cross join reservation r;
end;
$$;

revoke all on function public.ideaforge_email_claim(integer) from public, anon, authenticated;
grant execute on function public.ideaforge_email_claim(integer) to service_role;
