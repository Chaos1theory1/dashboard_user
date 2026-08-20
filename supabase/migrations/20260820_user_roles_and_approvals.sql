-- Dynamic users/RBAC for Mycelium Tech Digital.
-- The Node backend seeds the same tables and permissions at runtime.
create table if not exists public.app_roles(id bigserial primary key,code text unique not null,name text not null,created_at timestamptz not null default now());
create table if not exists public.app_permissions(id bigserial primary key,code text unique not null,description text);
create table if not exists public.app_role_permissions(role_id bigint not null references public.app_roles(id) on delete cascade,permission_id bigint not null references public.app_permissions(id) on delete cascade,primary key(role_id,permission_id));
create table if not exists public.app_users(auth_user_id uuid primary key,email text unique not null,username text unique not null,display_name text,role_id bigint not null references public.app_roles(id),active boolean not null default true,must_change_password boolean not null default false,last_seen_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table if not exists public.photo_deletion_requests(id bigserial primary key,photo_type text not null check(photo_type in ('petri','lc','grain')),photo_record_id bigint not null,photo_url text not null,context_data jsonb not null default '{}'::jsonb,reason text,status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),requested_by uuid,requested_by_name text not null,requested_at timestamptz not null default now(),reviewed_by uuid,reviewed_by_name text,reviewed_at timestamptz,review_note text);
create unique index if not exists ux_photo_deletion_pending on public.photo_deletion_requests(photo_type,photo_record_id) where status='pending';
do $$ begin
  if not exists(select 1 from pg_constraint where conname='app_users_auth_user_fk') then
    alter table public.app_users add constraint app_users_auth_user_fk foreign key(auth_user_id) references auth.users(id) on delete cascade;
  end if;
  if not exists(select 1 from pg_constraint where conname='photo_delete_requested_by_fk') then
    alter table public.photo_deletion_requests add constraint photo_delete_requested_by_fk foreign key(requested_by) references auth.users(id) on delete set null;
  end if;
  if not exists(select 1 from pg_constraint where conname='photo_delete_reviewed_by_fk') then
    alter table public.photo_deletion_requests add constraint photo_delete_reviewed_by_fk foreign key(reviewed_by) references auth.users(id) on delete set null;
  end if;
end $$;

insert into public.app_roles(code,name) values ('admin','Administrateur'),('operator','Opérateur'),('viewer','Lecture seule') on conflict(code) do update set name=excluded.name;
insert into public.app_permissions(code,description) values ('users.manage','Gérer les utilisateurs'),('photo.upload','Ajouter des photos'),('photo.edit','Modifier des photos'),('photo.delete.request','Demander une suppression'),('photo.delete.direct','Supprimer immédiatement'),('photo.delete.approve','Approuver les suppressions') on conflict(code) do update set description=excluded.description;
insert into public.app_role_permissions(role_id,permission_id) select r.id,p.id from public.app_roles r cross join public.app_permissions p where r.code='admin' on conflict do nothing;
insert into public.app_role_permissions(role_id,permission_id) select r.id,p.id from public.app_roles r join public.app_permissions p on p.code in ('photo.upload','photo.edit','photo.delete.request') where r.code='operator' on conflict do nothing;

create or replace function public.create_application_user() returns trigger language plpgsql security definer set search_path=public as $$
declare default_role_id bigint;
begin
  select id into default_role_id from public.app_roles where code='operator';
  insert into public.app_users(auth_user_id,email,username,display_name,role_id,active,must_change_password)
  values(new.id,coalesce(new.email,new.id::text),coalesce(new.raw_user_meta_data->>'username',split_part(coalesce(new.email,new.id::text),'@',1)),coalesce(new.raw_user_meta_data->>'display_name',new.raw_user_meta_data->>'username',split_part(coalesce(new.email,new.id::text),'@',1)),default_role_id,true,true)
  on conflict(auth_user_id) do nothing;
  return new;
end;$$;
drop trigger if exists create_application_user_after_signup on auth.users;
create trigger create_application_user_after_signup after insert on auth.users for each row execute function public.create_application_user();

create or replace function public.sync_application_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
  update public.app_users set
    email=coalesce(new.email,email),
    username=coalesce(nullif(new.raw_user_meta_data->>'username',''),username),
    display_name=coalesce(nullif(new.raw_user_meta_data->>'display_name',''),display_name),
    updated_at=now()
  where auth_user_id=new.id;
  return new;
end;$$;
drop trigger if exists sync_application_user_after_auth_update on auth.users;
create trigger sync_application_user_after_auth_update after update of email,raw_user_meta_data on auth.users for each row execute function public.sync_application_user();

alter table public.app_users enable row level security;
alter table public.app_roles enable row level security;
alter table public.app_permissions enable row level security;
alter table public.app_role_permissions enable row level security;
alter table public.photo_deletion_requests enable row level security;
