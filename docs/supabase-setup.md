# Supabase Setup

This project uses Supabase Auth, PostgreSQL, Realtime, and Storage. The frontend currently expects one Connie learner account and one Jaco reviewer account.

## Frontend Dependencies

The app reads and writes these Supabase resources:

- `public.profiles`
- `public.tasks`
- `public.notes`
- `public.score_adjustments`
- Storage bucket: `proofs`
- Realtime publication for `tasks`, `notes`, and `score_adjustments`

## Expected Tables

The RLS script assumes these columns already exist.

### `public.profiles`

| Column | Expected type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Same value as `auth.users.id` |
| `role` | `text` | Must be `connie` or `jaco` |

Recommended constraint:

```sql
alter table public.profiles
add constraint profiles_role_check
check (role in ('connie', 'jaco'));
```

### `public.tasks`

| Column | Expected type | Notes |
| --- | --- | --- |
| `task_date` | `date` | Part of unique key with `task_key` |
| `task_key` | `text` | `words`, `reading`, or `listening` |
| `status` | `text` | `pending`, `approved`, or `rejected` |
| `proof_url` | `text` | Public Storage URL, or a JSON array of public Storage URLs for multi-image proof |
| `proof_name` | `text` | Original uploaded filename, or a JSON array of filenames for multi-image proof |
| `submitted_at` | `timestamptz` | Set by frontend |
| `reviewed_at` | `timestamptz` | Set when Jaco reviews |
| `reviewed_by` | `uuid` | Jaco user id |

Recommended constraints:

```sql
alter table public.tasks
add constraint tasks_task_key_check
check (task_key in ('words', 'reading', 'listening'));

alter table public.tasks
add constraint tasks_status_check
check (status in ('pending', 'approved', 'rejected'));

alter table public.tasks
add constraint tasks_task_date_task_key_key
unique (task_date, task_key);
```

### `public.notes`

| Column | Expected type | Notes |
| --- | --- | --- |
| `id` | `integer` | The frontend uses row `id = 1` |
| `content` | `text` | Stores `Jaco note ||| Connie message` |
| `updated_at` | `timestamptz` | Set by frontend |

Current limitation: both messages are stored in one `content` column, separated by `|||`. Because of that, RLS can only protect the whole row, not each person's half of the message. A future schema migration should split this into `jaco_note` and `connie_message`.

### `public.score_adjustments`

| Column | Expected type | Notes |
| --- | --- | --- |
| `id` | integer or bigint | Primary key |
| `points` | integer | Positive or negative |
| `reason` | text | Shown in UI |
| `created_by` | uuid | Jaco user id |
| `created_at` | timestamptz | Recommended default: `now()` |

## Applying RLS

1. Create the Connie and Jaco Auth users in Supabase.
2. Copy their user UUIDs from **Authentication > Users**.
3. Insert or update profile rows:

```sql
insert into public.profiles (id, role)
values
  ('CONNIE_USER_UUID_HERE', 'connie'),
  ('JACO_USER_UUID_HERE', 'jaco')
on conflict (id) do update set role = excluded.role;
```

4. Open [supabase/rls.sql](../supabase/rls.sql).
5. Run it in **Supabase Dashboard > SQL Editor**.
6. Test with both accounts.

The script is designed to be re-runnable: it drops known policy names before recreating them.

## Policy Summary

After applying [supabase/rls.sql](../supabase/rls.sql):

- Only an authenticated user can read the app data.
- Each user can read only their own row in `profiles`.
- Connie can create or replace pending task submissions.
- Connie cannot modify approved task rows from the browser client.
- Jaco can approve, reject, or revoke approval on task rows.
- Both known roles can read and update the shared `notes` row.
- Only Jaco can create or delete score adjustments.
- Connie can upload proof images to the `proofs` bucket.
- Jaco can delete proof images if manual cleanup is needed.

## Storage Notes

The current frontend calls `getPublicUrl()` and stores the returned URL in `tasks.proof_url`, so the `proofs` bucket is configured as public in the RLS script.

For `reading` and `listening`, the frontend allows multiple proof images. To avoid a database migration, multi-image rows store `proof_url` and `proof_name` as JSON arrays in the existing `text` columns. Single-image rows can still store plain text, and the frontend supports both formats.

That means anyone who has a proof image URL can view that image. If proof images need to be private later, change the frontend to use signed URLs before making the bucket private.

## Realtime Notes

The frontend subscribes to Postgres changes for:

- `public.tasks`
- `public.notes`
- `public.score_adjustments`

The RLS script adds these tables to the `supabase_realtime` publication if they are not already present. In the Supabase UI, this corresponds to enabling Realtime for those tables.

## Smoke Test

After running the script:

1. Log in as Connie.
2. Upload a proof image for today's task.
3. Confirm the task appears as pending.
4. Log in as Jaco.
5. Approve the pending task.
6. Confirm Connie's score increases after refresh or realtime sync.
7. Try creating a score adjustment as Connie through the browser console or API; it should fail.
8. Try submitting a replacement proof for an approved task as Connie; it should fail.
