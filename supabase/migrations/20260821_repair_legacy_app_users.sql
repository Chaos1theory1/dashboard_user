-- Repairs installations made from the earlier RBAC draft where app_users used user_id.
do $$ begin
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='user_id')
     and not exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='auth_user_id') then
    alter table public.app_users rename column user_id to auth_user_id;
  end if;
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='user_id')
     and exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='auth_user_id') then
    update public.app_users set auth_user_id=coalesce(auth_user_id,user_id);
    alter table public.app_users drop column user_id cascade;
  end if;
end $$;

alter table public.app_users add column if not exists email text;
alter table public.app_users add column if not exists display_name text;
alter table public.app_users add column if not exists active boolean not null default true;
alter table public.app_users add column if not exists must_change_password boolean not null default false;
alter table public.app_users add column if not exists last_seen_at timestamptz;
alter table public.app_users add column if not exists updated_at timestamptz not null default now();
update public.app_users u set email=a.email,updated_at=now() from auth.users a where a.id=u.auth_user_id and (u.email is null or u.email='');
create unique index if not exists ux_app_users_email on public.app_users(lower(email)) where email is not null;

alter table public.photo_deletion_requests add column if not exists context_data jsonb not null default '{}'::jsonb;
alter table public.photo_deletion_requests add column if not exists reason text;
alter table public.photo_deletion_requests add column if not exists requested_by_name text;
alter table public.photo_deletion_requests add column if not exists reviewed_by uuid;
alter table public.photo_deletion_requests add column if not exists reviewed_by_name text;
alter table public.photo_deletion_requests add column if not exists reviewed_at timestamptz;
alter table public.photo_deletion_requests add column if not exists review_note text;
update public.photo_deletion_requests set requested_by_name='Utilisateur' where requested_by_name is null;

do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.app_users'::regclass and contype='p') then
    alter table public.app_users add primary key(auth_user_id);
  end if;
end $$;

insert into public.app_roles(code,name) values
  ('admin','Administrateur'),('operator','Opérateur'),('viewer','Lecture seule')
on conflict(code) do update set name=excluded.name;

create or replace function public.create_application_user()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  default_role_id bigint;
  candidate_username text;
begin
  select id into default_role_id from public.app_roles where code='operator';
  if default_role_id is null then
    insert into public.app_roles(code,name) values('operator','Opérateur') returning id into default_role_id;
  end if;
  candidate_username:=coalesce(nullif(new.raw_user_meta_data->>'username',''),split_part(coalesce(new.email,new.id::text),'@',1));
  if exists(select 1 from public.app_users where lower(username)=lower(candidate_username)) then
    candidate_username:=candidate_username||'_'||left(new.id::text,8);
  end if;
  insert into public.app_users(auth_user_id,email,username,display_name,role_id,active,must_change_password)
  values(new.id,coalesce(new.email,new.id::text),candidate_username,coalesce(nullif(new.raw_user_meta_data->>'display_name',''),candidate_username),default_role_id,true,true)
  on conflict(auth_user_id) do nothing;
  return new;
exception when others then
  raise warning 'app_users profile creation failed for %: %',new.id,sqlerrm;
  return new;
end;$$;

drop trigger if exists create_application_user_after_signup on auth.users;
create trigger create_application_user_after_signup
after insert on auth.users for each row execute function public.create_application_user();
