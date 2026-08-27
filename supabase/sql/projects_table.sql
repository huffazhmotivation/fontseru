-- Cloud storage for FontSeru projects (the "Save to Cloud" / "Open from
-- Cloud" feature). Run this once in the Supabase SQL editor for this
-- project — it is additive and does not touch `profiles` or any other
-- existing table.
--
-- Each row is one saved project, owned by exactly one user. The full
-- project JSON (the same shape written to a .fs file by
-- src/utils/projectIO.ts) is stored in `data`, so opening a cloud project
-- is byte-for-byte the same as opening a downloaded .fs file.
--
-- Cloud Save/Open is a PRO-only feature — see the policies below. If you
-- already ran an earlier version of this file (before the PRO check was
-- added), this whole script is safe to re-run: `create table`/`create
-- index if not exists` are no-ops on the existing table, and the four
-- policies are dropped and recreated with the PRO check added.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One saved slot per (user, name) — "Save" on an existing name overwrites
-- it instead of creating a duplicate row, mirroring how "Save" behaves for
-- local .fs files.
create unique index if not exists projects_user_id_name_key
  on public.projects (user_id, name);

create index if not exists projects_user_id_updated_at_idx
  on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;

-- RLS policies (below) control *which rows* a role can touch, but Postgres
-- separately requires a base GRANT on the table itself before RLS is even
-- consulted — without it every query fails with "permission denied for
-- table projects" regardless of how permissive the policies are. Tables
-- created through Supabase's own dashboard/migrations get this
-- automatically; a table created by hand in the SQL Editor does not, so
-- it's granted explicitly here. `authenticated` is every logged-in user;
-- `anon` deliberately gets nothing, since cloud projects are private.
grant select, insert, update, delete on public.projects to authenticated;

-- A signed-in user can only ever see, create, update, or delete their own
-- projects, AND only while their `profiles.plan` is 'pro' — Cloud Save is a
-- PRO-only feature, and this is the real enforcement point (the UI lock in
-- FileMenu.tsx is just a convenience; a FREE user calling the API directly
-- would still be blocked here). There is no anon access at all — cloud
-- projects are private. Postgres has no `CREATE POLICY IF NOT EXISTS`, so
-- each policy is dropped first (safe no-op if it doesn't exist yet) and
-- then recreated, which makes this script safe to re-run.
drop policy if exists "projects: read own rows" on public.projects;
create policy "projects: read own rows"
on public.projects for select
to authenticated
using (
  auth.uid() = user_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.plan = 'pro')
);

drop policy if exists "projects: insert own rows" on public.projects;
create policy "projects: insert own rows"
on public.projects for insert
to authenticated
with check (
  auth.uid() = user_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.plan = 'pro')
);

drop policy if exists "projects: update own rows" on public.projects;
create policy "projects: update own rows"
on public.projects for update
to authenticated
using (
  auth.uid() = user_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.plan = 'pro')
)
with check (
  auth.uid() = user_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.plan = 'pro')
);

drop policy if exists "projects: delete own rows" on public.projects;
create policy "projects: delete own rows"
on public.projects for delete
to authenticated
using (
  auth.uid() = user_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.plan = 'pro')
);

-- Keep `updated_at` accurate on every overwrite without relying on the
-- client to set it correctly.
create or replace function public.projects_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row
execute function public.projects_set_updated_at();

-- ------------------------------------------------------------ STORAGE QUOTA
-- Caps total Cloud storage at 100 MB per user, across all of their saved
-- projects combined. This is the real enforcement point — it runs inside
-- the database on every insert/update, so it can't be bypassed by the
-- client skipping a check. To change the limit, edit `quota_bytes` below
-- and re-run just this function (the trigger doesn't need to change).
create or replace function public.projects_enforce_quota()
returns trigger
language plpgsql
as $$
declare
  quota_bytes bigint := 100 * 1024 * 1024; -- 100 MB
  other_rows_bytes bigint;
  new_row_bytes bigint;
  total_bytes bigint;
begin
  new_row_bytes := octet_length(new.data::text);

  -- Sum every other project this user already has saved (on UPDATE, this
  -- excludes the row's own previous size, which `new_row_bytes` replaces).
  select coalesce(sum(octet_length(data::text)), 0)
  into other_rows_bytes
  from public.projects
  where user_id = new.user_id
    and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

  total_bytes := other_rows_bytes + new_row_bytes;

  if total_bytes > quota_bytes then
    raise exception
      'Cloud storage quota exceeded: this would use % of your % MB limit.',
      pg_size_pretty(total_bytes), (quota_bytes / 1024 / 1024)
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_enforce_quota on public.projects;
create trigger projects_enforce_quota
before insert or update on public.projects
for each row
execute function public.projects_enforce_quota();

-- Lets the client show "X of 100 MB used" before the user even tries to
-- save, without needing SELECT access to every row's full `data` payload.
-- `security invoker` (the default) means this still only ever sums the
-- calling user's own rows, same as the RLS-filtered SELECT policy above.
create or replace function public.get_project_storage_usage()
returns bigint
language sql
stable
as $$
  select coalesce(sum(octet_length(data::text)), 0) from public.projects;
$$;

grant execute on function public.get_project_storage_usage() to authenticated;
