-- Admin audit trail for Petri, liquid mycelium and grain journal work.
-- Writes and reads go through the authenticated Node backend only.
create table if not exists public.production_activity_log (
  id bigserial primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name text not null,
  actor_role text not null,
  module text not null check (module in ('petri','lc','grain')),
  action_type text not null check (action_type in ('added','modified','photo_added','delete_requested')),
  item_id bigint not null,
  item_label text not null,
  day_index integer,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_production_activity_created_at
  on public.production_activity_log(created_at desc);
create index if not exists ix_production_activity_actor_month
  on public.production_activity_log(actor_user_id,created_at desc);
create index if not exists ix_production_activity_item
  on public.production_activity_log(module,item_id,created_at desc);

alter table public.production_activity_log enable row level security;
