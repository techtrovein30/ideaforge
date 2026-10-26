-- Use short, easy-to-read codes for newly registered teams.
-- Existing team codes stay unchanged.

create or replace function public.ideaforge_assign_short_team_code()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set row_security = off
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_candidate text;
  v_index integer;
begin
  if new.team_code is not null and btrim(new.team_code) <> '' then
    return new;
  end if;

  perform pg_advisory_xact_lock(73821941, 2);

  loop
    v_candidate := 'IF-';
    for v_index in 1..6 loop
      v_candidate := v_candidate
        || substr(v_alphabet, floor(random() * length(v_alphabet))::integer + 1, 1);
    end loop;

    exit when not exists (
      select 1
      from public.ideaforge_teams t
      where t.team_code = v_candidate
    );
  end loop;

  new.team_code := v_candidate;
  return new;
end;
$$;

revoke all on function public.ideaforge_assign_short_team_code() from public, anon, authenticated;

alter table public.ideaforge_teams
  alter column team_code drop default;

drop trigger if exists ideaforge_assign_short_team_code on public.ideaforge_teams;
create trigger ideaforge_assign_short_team_code
before insert on public.ideaforge_teams
for each row
execute function public.ideaforge_assign_short_team_code();
