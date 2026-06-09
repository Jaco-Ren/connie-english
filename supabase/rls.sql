-- Connie's English Learning Tracker
-- Supabase RLS and project configuration.
--
-- Run this in Supabase SQL Editor after the tables exist and after both users
-- have matching rows in public.profiles.
--
-- Required profiles rows, example:
-- insert into public.profiles (id, role)
-- values
--   ('00000000-0000-0000-0000-000000000000', 'connie'),
--   ('11111111-1111-1111-1111-111111111111', 'jaco')
-- on conflict (id) do update set role = excluded.role;

begin;

-- Keep the proofs bucket compatible with the current frontend, which stores
-- public image URLs in public.tasks.proof_url.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'proofs',
  'proofs',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Helper functions prevent policy recursion when policies need to check
-- public.profiles. SECURITY DEFINER lets the function read profiles even when
-- the caller's profile SELECT policy is narrow.
create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
  limit 1
$$;

create or replace function public.is_jaco()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_profile_role() = 'jaco'
$$;

create or replace function public.is_connie()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_profile_role() = 'connie'
$$;

revoke all on function public.current_profile_role() from public;
revoke all on function public.is_jaco() from public;
revoke all on function public.is_connie() from public;
grant execute on function public.current_profile_role() to authenticated;
grant execute on function public.is_jaco() to authenticated;
grant execute on function public.is_connie() to authenticated;

-- Baseline grants. RLS still decides which rows/actions are allowed.
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant select on public.tasks to authenticated;
grant insert, update, delete on public.tasks to authenticated;
grant select, insert, update on public.notes to authenticated;
grant select, insert, delete on public.score_adjustments to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter table public.tasks
add column if not exists late_submit_unlocked_at timestamptz,
add column if not exists late_submit_unlocked_by uuid,
add column if not exists custom_title text,
add column if not exists custom_points integer,
add column if not exists custom_created_by uuid,
add column if not exists custom_review_status text,
add column if not exists custom_requested_at timestamptz,
add column if not exists custom_reviewed_at timestamptz,
add column if not exists custom_reviewed_by uuid,
add column if not exists custom_repeat_rule text,
add column if not exists custom_weekdays text,
add column if not exists custom_series_id text,
add column if not exists custom_is_template boolean,
add column if not exists custom_deleted_dates text,
add column if not exists custom_stopped_from date;

create or replace function public.has_approved_custom_task_template(
  series_id text,
  requested_task_key text,
  owner_id uuid,
  target_date date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tasks template
    where template.custom_series_id = series_id
      and template.task_key = requested_task_key
      and template.custom_created_by = owner_id
      and template.custom_review_status = 'approved'
      and template.custom_repeat_rule = 'weekly'
      and coalesce(template.custom_is_template, false) = true
      and template.task_date <= target_date
      and (template.custom_stopped_from is null or target_date < template.custom_stopped_from)
      and (',' || coalesce(template.custom_weekdays, '') || ',') like ('%,' || extract(dow from target_date)::int || ',%')
      and (',' || coalesce(template.custom_deleted_dates, '') || ',') not like ('%,' || target_date::text || ',%')
    limit 1
  )
$$;

revoke all on function public.has_approved_custom_task_template(text, text, uuid, date) from public;
grant execute on function public.has_approved_custom_task_template(text, text, uuid, date) to authenticated;

alter table public.tasks
drop constraint if exists tasks_status_check;

alter table public.tasks
add constraint tasks_status_check
check (status in ('none', 'pending', 'approved', 'rejected'));

alter table public.tasks
drop constraint if exists tasks_task_key_check;

alter table public.tasks
add constraint tasks_task_key_check
check (
  task_key in ('words', 'reading', 'listening')
  or task_key ~ '^custom-[a-z0-9-]+$'
);

alter table public.tasks
drop constraint if exists tasks_custom_task_fields_check;

alter table public.tasks
add constraint tasks_custom_task_fields_check
check (
  (
    task_key in ('words', 'reading', 'listening')
    and custom_title is null
    and custom_points is null
    and custom_created_by is null
    and custom_review_status is null
    and custom_requested_at is null
    and custom_reviewed_at is null
    and custom_reviewed_by is null
    and custom_repeat_rule is null
    and custom_weekdays is null
    and custom_series_id is null
    and custom_is_template is null
    and custom_deleted_dates is null
    and custom_stopped_from is null
  )
  or (
    task_key ~ '^custom-[a-z0-9-]+$'
    and length(btrim(coalesce(custom_title, ''))) between 1 and 40
    and custom_points between 1 and 100
    and custom_created_by is not null
    and custom_review_status in ('pending', 'approved', 'rejected')
    and coalesce(custom_repeat_rule, 'once') in ('once', 'weekly')
    and (
      custom_deleted_dates is null
      or custom_deleted_dates ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(,[0-9]{4}-[0-9]{2}-[0-9]{2})*$'
    )
    and (
      custom_stopped_from is null
      or (
        custom_repeat_rule = 'weekly'
        and custom_stopped_from >= task_date
      )
    )
    and (
      (
        coalesce(custom_repeat_rule, 'once') = 'once'
        and custom_weekdays is null
      )
      or (
        custom_repeat_rule = 'weekly'
        and custom_weekdays ~ '^[0-6](,[0-6]){0,6}$'
        and custom_series_id is not null
      )
    )
    and (
      (
        custom_review_status in ('pending', 'rejected')
        and status = 'none'
      )
      or (
        custom_review_status = 'approved'
        and status in ('none', 'pending', 'approved', 'rejected')
      )
    )
  )
);

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.notes enable row level security;
alter table public.score_adjustments enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (id = auth.uid());

-- Profile role changes should be done by a Supabase admin/service role, not
-- from the browser client. No insert/update/delete policies are intentionally
-- created for public.profiles.

drop policy if exists "tasks_select_authenticated" on public.tasks;
create policy "tasks_select_authenticated"
on public.tasks
for select
to authenticated
using (true);

drop policy if exists "tasks_insert_connie_pending" on public.tasks;
create policy "tasks_insert_connie_pending"
on public.tasks
for insert
to authenticated
with check (
  public.is_connie()
  and (
    (
      task_key in ('words', 'reading', 'listening')
      and status = 'pending'
      and custom_title is null
      and custom_points is null
      and custom_created_by is null
      and custom_review_status is null
      and custom_requested_at is null
      and custom_reviewed_at is null
      and custom_reviewed_by is null
      and custom_repeat_rule is null
      and custom_weekdays is null
      and custom_series_id is null
      and custom_is_template is null
      and custom_deleted_dates is null
      and custom_stopped_from is null
      and reviewed_at is null
      and reviewed_by is null
    )
    or (
      task_key ~ '^custom-[a-z0-9-]+$'
      and status = 'none'
      and length(btrim(coalesce(custom_title, ''))) between 1 and 40
      and custom_points between 1 and 100
      and custom_created_by = auth.uid()
      and custom_review_status = 'pending'
      and custom_requested_at is not null
      and custom_reviewed_at is null
      and custom_reviewed_by is null
      and coalesce(custom_repeat_rule, 'once') in ('once', 'weekly')
      and (
        (
          coalesce(custom_repeat_rule, 'once') = 'once'
          and custom_weekdays is null
          and coalesce(custom_is_template, false) = false
        )
        or (
          custom_repeat_rule = 'weekly'
          and custom_weekdays ~ '^[0-6](,[0-6]){0,6}$'
          and custom_series_id is not null
          and custom_is_template is true
        )
      )
      and proof_url is null
      and proof_name is null
      and submitted_at is null
      and reviewed_at is null
      and reviewed_by is null
      and custom_stopped_from is null
    )
    or (
      task_key ~ '^custom-[a-z0-9-]+$'
      and status = 'pending'
      and length(btrim(coalesce(custom_title, ''))) between 1 and 40
      and custom_points between 1 and 100
      and custom_created_by = auth.uid()
      and custom_review_status = 'approved'
      and custom_requested_at is not null
      and custom_reviewed_at is not null
      and custom_reviewed_by is not null
      and custom_repeat_rule = 'weekly'
      and custom_weekdays ~ '^[0-6](,[0-6]){0,6}$'
      and custom_series_id is not null
      and coalesce(custom_is_template, false) = false
      and proof_url is not null
      and submitted_at is not null
      and reviewed_at is null
      and reviewed_by is null
      and public.has_approved_custom_task_template(custom_series_id, task_key, auth.uid(), task_date)
    )
  )
);

drop policy if exists "tasks_update_connie_resubmit" on public.tasks;
create policy "tasks_update_connie_resubmit"
on public.tasks
for update
to authenticated
using (
  public.is_connie()
  and (
    (
      task_key in ('words', 'reading', 'listening')
      and status in ('pending', 'rejected')
    )
    or (
      task_key ~ '^custom-[a-z0-9-]+$'
      and custom_created_by = auth.uid()
      and custom_review_status = 'approved'
      and status in ('none', 'pending', 'rejected')
    )
  )
)
with check (
  public.is_connie()
  and (
    (
      task_key in ('words', 'reading', 'listening')
      and status = 'pending'
      and custom_title is null
      and custom_points is null
      and custom_created_by is null
      and custom_review_status is null
      and custom_requested_at is null
      and custom_reviewed_at is null
      and custom_reviewed_by is null
      and custom_repeat_rule is null
      and custom_weekdays is null
      and custom_series_id is null
      and custom_is_template is null
      and custom_deleted_dates is null
      and custom_stopped_from is null
      and reviewed_at is null
      and reviewed_by is null
    )
    or (
      task_key ~ '^custom-[a-z0-9-]+$'
      and status = 'pending'
      and length(btrim(coalesce(custom_title, ''))) between 1 and 40
      and custom_points between 1 and 100
      and custom_created_by = auth.uid()
      and custom_review_status = 'approved'
      and custom_requested_at is not null
      and custom_reviewed_at is not null
      and custom_reviewed_by is not null
      and coalesce(custom_repeat_rule, 'once') in ('once', 'weekly')
      and (
        (
          coalesce(custom_repeat_rule, 'once') = 'once'
          and custom_weekdays is null
        )
        or (
          custom_repeat_rule = 'weekly'
          and custom_weekdays ~ '^[0-6](,[0-6]){0,6}$'
          and custom_series_id is not null
        )
      )
      and proof_url is not null
      and submitted_at is not null
      and reviewed_at is null
      and reviewed_by is null
      and (custom_stopped_from is null or task_date < custom_stopped_from)
    )
  )
);

-- Jaco uses upsert() in the current frontend. Allow insert as well as update so
-- ON CONFLICT paths do not fail if a row is missing or Supabase requires INSERT
-- permission for the upsert call.
drop policy if exists "tasks_insert_jaco_admin" on public.tasks;
create policy "tasks_insert_jaco_admin"
on public.tasks
for insert
to authenticated
with check (
  public.is_jaco()
  and (
    (
      task_key in ('words', 'reading', 'listening')
      and status in ('pending', 'approved', 'rejected')
      and custom_title is null
      and custom_points is null
      and custom_created_by is null
      and custom_review_status is null
      and custom_requested_at is null
      and custom_reviewed_at is null
      and custom_reviewed_by is null
      and custom_repeat_rule is null
      and custom_weekdays is null
      and custom_series_id is null
      and custom_is_template is null
      and custom_deleted_dates is null
      and custom_stopped_from is null
    )
    or (
      task_key ~ '^custom-[a-z0-9-]+$'
      and status in ('none', 'pending', 'approved', 'rejected')
      and length(btrim(coalesce(custom_title, ''))) between 1 and 40
      and custom_points between 1 and 100
      and custom_created_by is not null
      and custom_review_status in ('pending', 'approved', 'rejected')
      and custom_requested_at is not null
      and coalesce(custom_repeat_rule, 'once') in ('once', 'weekly')
      and (
        (
          coalesce(custom_repeat_rule, 'once') = 'once'
          and custom_weekdays is null
        )
        or (
          custom_repeat_rule = 'weekly'
          and custom_weekdays ~ '^[0-6](,[0-6]){0,6}$'
          and custom_series_id is not null
        )
      )
    )
  )
);

drop policy if exists "tasks_update_jaco_review" on public.tasks;
create policy "tasks_update_jaco_review"
on public.tasks
for update
to authenticated
using (public.is_jaco())
with check (
  public.is_jaco()
  and (
    (
      task_key in ('words', 'reading', 'listening')
      and status in ('pending', 'approved', 'rejected')
      and custom_title is null
      and custom_points is null
      and custom_created_by is null
      and custom_review_status is null
      and custom_requested_at is null
      and custom_reviewed_at is null
      and custom_reviewed_by is null
      and custom_repeat_rule is null
      and custom_weekdays is null
      and custom_series_id is null
      and custom_is_template is null
      and custom_deleted_dates is null
      and custom_stopped_from is null
    )
    or (
      task_key ~ '^custom-[a-z0-9-]+$'
      and status in ('none', 'pending', 'approved', 'rejected')
      and length(btrim(coalesce(custom_title, ''))) between 1 and 40
      and custom_points between 1 and 100
      and custom_created_by is not null
      and custom_review_status in ('pending', 'approved', 'rejected')
      and custom_requested_at is not null
      and coalesce(custom_repeat_rule, 'once') in ('once', 'weekly')
      and (
        (
          coalesce(custom_repeat_rule, 'once') = 'once'
          and custom_weekdays is null
        )
        or (
          custom_repeat_rule = 'weekly'
          and custom_weekdays ~ '^[0-6](,[0-6]){0,6}$'
          and custom_series_id is not null
        )
      )
    )
  )
);

drop policy if exists "tasks_delete_jaco_custom" on public.tasks;
create policy "tasks_delete_jaco_custom"
on public.tasks
for delete
to authenticated
using (
  public.is_jaco()
  and task_key ~ '^custom-[a-z0-9-]+$'
);

drop policy if exists "notes_select_authenticated" on public.notes;
create policy "notes_select_authenticated"
on public.notes
for select
to authenticated
using (id = 1);

drop policy if exists "notes_insert_known_roles" on public.notes;
create policy "notes_insert_known_roles"
on public.notes
for insert
to authenticated
with check (
  id = 1
  and public.current_profile_role() in ('connie', 'jaco')
);

drop policy if exists "notes_update_known_roles" on public.notes;
create policy "notes_update_known_roles"
on public.notes
for update
to authenticated
using (
  id = 1
  and public.current_profile_role() in ('connie', 'jaco')
)
with check (
  id = 1
  and public.current_profile_role() in ('connie', 'jaco')
);

drop policy if exists "score_adjustments_select_authenticated" on public.score_adjustments;
create policy "score_adjustments_select_authenticated"
on public.score_adjustments
for select
to authenticated
using (true);

drop policy if exists "score_adjustments_insert_jaco" on public.score_adjustments;
create policy "score_adjustments_insert_jaco"
on public.score_adjustments
for insert
to authenticated
with check (
  public.is_jaco()
  and created_by = auth.uid()
);

drop policy if exists "score_adjustments_delete_jaco" on public.score_adjustments;
create policy "score_adjustments_delete_jaco"
on public.score_adjustments
for delete
to authenticated
using (public.is_jaco());

alter table storage.objects enable row level security;

drop policy if exists "proofs_select_authenticated" on storage.objects;
create policy "proofs_select_authenticated"
on storage.objects
for select
to authenticated
using (bucket_id = 'proofs');

drop policy if exists "proofs_insert_connie" on storage.objects;
create policy "proofs_insert_connie"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'proofs'
  and public.is_connie()
  and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
);

drop policy if exists "proofs_update_connie" on storage.objects;
create policy "proofs_update_connie"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'proofs'
  and public.is_connie()
)
with check (
  bucket_id = 'proofs'
  and public.is_connie()
  and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
);

drop policy if exists "proofs_delete_jaco" on storage.objects;
create policy "proofs_delete_jaco"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'proofs'
  and public.is_jaco()
);

-- Realtime needs the tables in the supabase_realtime publication.
do $$
declare
  table_name text;
begin
  foreach table_name in array array['tasks', 'notes', 'score_adjustments']
  loop
    if not exists (
      select 1
      from pg_publication pub
      join pg_publication_rel rel on rel.prpubid = pub.oid
      join pg_class cls on cls.oid = rel.prrelid
      join pg_namespace ns on ns.oid = cls.relnamespace
      where pub.pubname = 'supabase_realtime'
        and ns.nspname = 'public'
        and cls.relname = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end $$;

commit;
