alter table public.ideaforge_settings
  add column if not exists participant_checkin_enabled boolean not null default false;
