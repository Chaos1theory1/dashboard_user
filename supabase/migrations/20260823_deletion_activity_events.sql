-- Extend the production audit trail with direct deletion and review outcomes.
alter table public.production_activity_log
  drop constraint if exists production_activity_log_action_type_check;

alter table public.production_activity_log
  add constraint production_activity_log_action_type_check
  check (action_type in (
    'added','modified','photo_added','delete_requested',
    'photo_deleted','delete_approved','delete_rejected'
  ));
