do $$
declare
  v_user_id uuid;
begin
  select id
  into v_user_id
  from auth.users
  where lower(email) = lower('deepapreya@gmail.com');

  if v_user_id is null then
    raise exception 'Sign in once with deepapreya@gmail.com before granting IdeaForge admin access';
  end if;

  insert into public.ideaforge_admins (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;
end;
$$;
