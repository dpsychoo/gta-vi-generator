-- PROPOSED ONLY: SGODX ROAD TO VI / EVENT SYSTEM v1.
-- This migration owns event configuration, event rules, entries, and their
-- Customer/PASS integrity. Customer Auth Core and Purchase Milestones are
-- deliberately maintained in separate migrations.

alter table public.events
  add column if not exists description text,
  add column if not exists entry_starts_at timestamptz,
  add column if not exists entry_ends_at timestamptz,
  add column if not exists rules_version text,
  add column if not exists updated_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'events_entry_dates_check'
      and conrelid = 'public.events'::regclass
  ) then
    alter table public.events
      add constraint events_entry_dates_check
      check (
        (entry_starts_at is null) = (entry_ends_at is null)
        and (entry_ends_at is null or entry_ends_at >= entry_starts_at)
        and (starts_at is null or entry_starts_at is null or entry_starts_at >= starts_at)
        and (ends_at is null or entry_ends_at is null or entry_ends_at <= ends_at)
      );
  end if;
end
$$;

create table if not exists public.event_rules (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  version text not null,
  title text not null,
  content text not null,
  content_hash text not null,
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint event_rules_event_version_key unique (event_id, version),
  constraint event_rules_content_check check (content <> '' and content_hash <> '')
);

create index if not exists event_rules_event_published_idx
  on public.event_rules (event_id, published_at desc);

alter table public.event_entries
  add column if not exists rules_version text,
  add column if not exists rules_accepted_at timestamptz,
  add column if not exists updated_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'events_rules_version_fkey'
      and conrelid = 'public.events'::regclass
  ) then
    alter table public.events
      add constraint events_rules_version_fkey
      foreign key (id, rules_version)
      references public.event_rules (event_id, version);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_entries_rules_acceptance_check'
      and conrelid = 'public.event_entries'::regclass
  ) then
    alter table public.event_entries
      add constraint event_entries_rules_acceptance_check
      check ((rules_version is null) = (rules_accepted_at is null));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_entries_rules_version_fkey'
      and conrelid = 'public.event_entries'::regclass
  ) then
    alter table public.event_entries
      add constraint event_entries_rules_version_fkey
      foreign key (event_id, rules_version)
      references public.event_rules (event_id, version);
  end if;
end
$$;

create unique index if not exists event_entries_event_customer_key
  on public.event_entries (event_id, customer_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sgx_passes_id_customer_id_key'
      and conrelid = 'public.sgx_passes'::regclass
  ) then
    alter table public.sgx_passes
      add constraint sgx_passes_id_customer_id_key unique (id, customer_id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_entries_pass_customer_fkey'
      and conrelid = 'public.event_entries'::regclass
  ) then
    alter table public.event_entries
      add constraint event_entries_pass_customer_fkey
      foreign key (sgx_pass_id, customer_id)
      references public.sgx_passes (id, customer_id);
  end if;
end
$$;

alter table public.events enable row level security;
alter table public.event_entries enable row level security;
alter table public.event_rules enable row level security;
