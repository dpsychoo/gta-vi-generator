-- SGX VI PASS identity and future event participation model.
-- Run this migration before deploying the application changes.

create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  normalized_email text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint customers_normalized_email_key unique (normalized_email)
);

create table if not exists public.sgx_passes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  public_code text not null,
  status text not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  constraint sgx_passes_customer_id_key unique (customer_id),
  constraint sgx_passes_public_code_key unique (public_code),
  constraint sgx_passes_status_check check (status in ('active', 'suspended', 'revoked')),
  constraint sgx_passes_public_code_format_check check (
    public_code ~ '^SGX-VI-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$'
  )
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  sgx_pass_id uuid not null references public.sgx_passes(id) on delete restrict,
  mercadopago_payment_id text not null,
  status text not null,
  amount numeric(12, 2) not null,
  currency text not null,
  created_at timestamptz not null default timezone('utc', now()),
  approved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint orders_job_id_key unique (job_id),
  constraint orders_mercadopago_payment_id_key unique (mercadopago_payment_id),
  constraint orders_status_check check (status in ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'chargeback', 'failed')),
  constraint orders_amount_check check (amount >= 0),
  constraint orders_currency_check check (currency ~ '^[A-Z]{3}$')
);

alter table public.sgx_passes
  add column if not exists first_order_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sgx_passes_first_order_id_fkey'
      and conrelid = 'public.sgx_passes'::regclass
  ) then
    alter table public.sgx_passes
      add constraint sgx_passes_first_order_id_fkey
      foreign key (first_order_id) references public.orders(id) on delete set null;
  end if;
end
$$;

alter table public.jobs
  add column if not exists customer_id uuid,
  add column if not exists sgx_pass_id uuid,
  add column if not exists access_token_expires_at timestamptz;

alter table public.jobs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'jobs_customer_id_fkey'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_customer_id_fkey
      foreign key (customer_id) references public.customers(id) on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'jobs_sgx_pass_id_fkey'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_sgx_pass_id_fkey
      foreign key (sgx_pass_id) references public.sgx_passes(id) on delete set null;
  end if;
end
$$;

create index if not exists customers_email_idx
  on public.customers (email);

create index if not exists orders_customer_id_idx
  on public.orders (customer_id);

create index if not exists orders_sgx_pass_id_idx
  on public.orders (sgx_pass_id);

create index if not exists jobs_customer_id_idx
  on public.jobs (customer_id)
  where customer_id is not null;

create index if not exists jobs_sgx_pass_id_idx
  on public.jobs (sgx_pass_id)
  where sgx_pass_id is not null;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  status text not null default 'draft',
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint events_slug_key unique (slug),
  constraint events_status_check check (status in ('draft', 'active', 'closed', 'archived')),
  constraint events_dates_check check (ends_at is null or starts_at is null or ends_at >= starts_at)
);

create table if not exists public.event_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  sgx_pass_id uuid not null references public.sgx_passes(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  status text not null default 'eligible',
  eligible boolean not null default true,
  entered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint event_entries_event_pass_key unique (event_id, sgx_pass_id),
  constraint event_entries_status_check check (status in ('eligible', 'entered', 'locked', 'ineligible', 'withdrawn'))
);

create index if not exists event_entries_customer_id_idx
  on public.event_entries (customer_id);

alter table public.customers enable row level security;
alter table public.sgx_passes enable row level security;
alter table public.orders enable row level security;
alter table public.events enable row level security;
alter table public.event_entries enable row level security;
