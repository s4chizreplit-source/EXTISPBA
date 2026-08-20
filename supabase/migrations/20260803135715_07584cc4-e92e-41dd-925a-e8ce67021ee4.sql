create or replace function public.ensure_user_profile()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_name text;
begin
  if v_uid is null then
    return;
  end if;

  select u.email,
         coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email,'@',1))
    into v_email, v_name
  from auth.users u
  where u.id = v_uid;

  if v_email is null then
    return;
  end if;

  insert into public.profiles (user_id, email, full_name)
  values (v_uid, v_email, v_name)
  on conflict (user_id) do update
    set email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name);

  insert into public.wallets (user_id, balance)
  values (v_uid, 0)
  on conflict (user_id) do nothing;
end;
$$;

grant execute on function public.ensure_user_profile() to authenticated;

-- backfill existing users
insert into public.profiles (user_id, email, full_name)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email,'@',1))
from auth.users u
where u.email is not null
on conflict (user_id) do nothing;

insert into public.wallets (user_id, balance)
select u.id, 0 from auth.users u
on conflict (user_id) do nothing;