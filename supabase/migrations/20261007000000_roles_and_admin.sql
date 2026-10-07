-- Roles (user / employee / admin), admin activity log, site announcements,
-- and the admin functions the app's Admin page calls.
--
-- Who can do what:
--   user      - their own data only
--   employee  - read-only staff: see all users and profiles, monitoring, activity log,
--               send password-reset emails
--   admin     - everything: change roles, edit any profile, announcements, and
--               (via the Netlify admin function) set passwords, suspend, delete, create users

create type public.app_role as enum ('user', 'employee', 'admin');

-- Roles live in their own table with NO write policies, so nobody can change a
-- role directly - only through admin_set_role() below.
create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.app_role not null default 'user',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create index user_roles_updated_by_idx on public.user_roles (updated_by);
alter table public.user_roles enable row level security;

-- ---------- Role helpers ----------
create function public.my_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select role from public.user_roles where user_id = (select auth.uid())),
    'user'::public.app_role
  );
$$;

create function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$ select public.my_role() = 'admin'; $$;

create function public.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$ select public.my_role() in ('admin', 'employee'); $$;

create policy "Users see their own role; staff see all roles"
  on public.user_roles for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_staff()));

-- Staff can view every profile (users still only see their own).
alter policy "Users can view their own profile" on public.profiles
  using ((select auth.uid()) = id or (select public.is_staff()));
alter policy "Users can view their own profile" on public.profiles
  rename to "Users view their own profile; staff view all";

-- ---------- Admin activity log ----------
create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  actor_email text,
  action text not null check (char_length(action) <= 64),
  target_id uuid,
  target_email text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index admin_audit_log_created_at_idx on public.admin_audit_log (created_at desc);
create index admin_audit_log_actor_id_idx on public.admin_audit_log (actor_id);
alter table public.admin_audit_log enable row level security;

create policy "Staff can read the admin log"
  on public.admin_audit_log for select to authenticated
  using ((select public.is_staff()));

-- Staff-only; the actor is always the caller, so entries can't be forged for someone else.
create function public.log_admin_action(p_action text, p_target uuid default null, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.admin_audit_log (actor_id, actor_email, action, target_id, target_email, details)
  values (
    auth.uid(),
    (select email from auth.users where id = auth.uid()),
    left(p_action, 64),
    p_target,
    coalesce((select email from auth.users where id = p_target), p_details ->> 'email'),
    coalesce(p_details, '{}'::jsonb)
  );
end;
$$;

-- ---------- Site announcements ----------
create table public.announcements (
  id bigint generated always as identity primary key,
  message text not null check (char_length(message) between 1 and 280),
  level text not null default 'info' check (level in ('info', 'warning')),
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index announcements_created_by_idx on public.announcements (created_by);
alter table public.announcements enable row level security;

create policy "Signed-in users read active announcements"
  on public.announcements for select to authenticated
  using (active or (select public.is_admin()));

-- ---------- Admin functions ----------
create function public.admin_list_users()
returns table (
  id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  email_confirmed_at timestamptz, banned_until timestamptz, role public.app_role,
  full_name text, school text, major text, graduation_year smallint, monthly_income numeric
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at, u.email_confirmed_at, u.banned_until,
           coalesce(r.role, 'user'::public.app_role),
           p.full_name, p.school, p.major, p.graduation_year, p.monthly_income
    from auth.users u
    left join public.user_roles r on r.user_id = u.id
    left join public.profiles p on p.id = u.id
    order by u.created_at desc;
end;
$$;

create function public.admin_stats()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_staff() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'total', count(*),
    'new_7d', count(*) filter (where u.created_at > now() - interval '7 days'),
    'new_30d', count(*) filter (where u.created_at > now() - interval '30 days'),
    'active_24h', count(*) filter (where u.last_sign_in_at > now() - interval '24 hours'),
    'active_7d', count(*) filter (where u.last_sign_in_at > now() - interval '7 days'),
    'unconfirmed', count(*) filter (where u.email_confirmed_at is null),
    'banned', count(*) filter (where u.banned_until > now()),
    'profiles_completed', count(*) filter (where coalesce(p.full_name, '') <> ''),
    'admins', count(*) filter (where r.role = 'admin'),
    'employees', count(*) filter (where r.role = 'employee'),
    'users', count(*) filter (where coalesce(r.role, 'user') = 'user')
  )
  into result
  from auth.users u
  left join public.user_roles r on r.user_id = u.id
  left join public.profiles p on p.id = u.id;

  result := result || jsonb_build_object('signups_by_day', (
    select jsonb_agg(jsonb_build_object('day', d.day::date, 'count', coalesce(c.n, 0)) order by d.day)
    from generate_series((current_date - 29)::timestamp, current_date::timestamp, interval '1 day') as d(day)
    left join (
      select created_at::date as day, count(*) as n from auth.users
      where created_at >= current_date - 29 group by 1
    ) c on c.day = d.day::date
  ));
  return result;
end;
$$;

create function public.admin_set_role(p_user uuid, p_role public.app_role)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  old_role public.app_role;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can change roles' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'You can''t change your own role' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  old_role := coalesce((select role from public.user_roles where user_id = p_user), 'user');
  insert into public.user_roles (user_id, role, updated_at, updated_by)
  values (p_user, p_role, now(), auth.uid())
  on conflict (user_id) do update
    set role = excluded.role, updated_at = now(), updated_by = excluded.updated_by;
  if old_role is distinct from p_role then
    perform public.log_admin_action('role.change', p_user, jsonb_build_object('from', old_role, 'to', p_role));
  end if;
end;
$$;

create function public.admin_update_profile(
  p_user uuid, p_full_name text, p_school text, p_major text,
  p_graduation_year smallint, p_monthly_income numeric
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can edit other profiles' using errcode = '42501';
  end if;
  insert into public.profiles (id, full_name, school, major, graduation_year, monthly_income)
  values (p_user, nullif(trim(p_full_name), ''), nullif(trim(p_school), ''), nullif(trim(p_major), ''),
          p_graduation_year, p_monthly_income)
  on conflict (id) do update set
    full_name = excluded.full_name, school = excluded.school, major = excluded.major,
    graduation_year = excluded.graduation_year, monthly_income = excluded.monthly_income;
  perform public.log_admin_action('profile.update', p_user, '{}'::jsonb);
end;
$$;

create function public.admin_set_announcement(p_message text, p_level text default 'info')
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can post announcements' using errcode = '42501';
  end if;
  update public.announcements set active = false where active;
  insert into public.announcements (message, level, created_by)
  values (trim(p_message), coalesce(p_level, 'info'), auth.uid());
  perform public.log_admin_action('announcement.post', null, jsonb_build_object('message', trim(p_message)));
end;
$$;

create function public.admin_clear_announcement()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can remove announcements' using errcode = '42501';
  end if;
  update public.announcements set active = false where active;
  perform public.log_admin_action('announcement.clear', null, '{}'::jsonb);
end;
$$;

-- New sign-ups get a profile and the "user" role.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'user') on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Existing accounts start as "user". Make yourself admin with:
--   update public.user_roles set role = 'admin'
--   where user_id = (select id from auth.users where email = 'you@example.com');
insert into public.user_roles (user_id, role)
select id, 'user' from auth.users
on conflict (user_id) do nothing;

-- ---------- Permissions: signed-in users only (each function checks the role itself) ----------
revoke execute on function
  public.my_role(), public.is_admin(), public.is_staff(),
  public.log_admin_action(text, uuid, jsonb),
  public.admin_list_users(), public.admin_stats(),
  public.admin_set_role(uuid, public.app_role),
  public.admin_update_profile(uuid, text, text, text, smallint, numeric),
  public.admin_set_announcement(text, text), public.admin_clear_announcement()
from public, anon;

grant execute on function
  public.my_role(), public.is_admin(), public.is_staff(),
  public.log_admin_action(text, uuid, jsonb),
  public.admin_list_users(), public.admin_stats(),
  public.admin_set_role(uuid, public.app_role),
  public.admin_update_profile(uuid, text, text, text, smallint, numeric),
  public.admin_set_announcement(text, text), public.admin_clear_announcement()
to authenticated;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
