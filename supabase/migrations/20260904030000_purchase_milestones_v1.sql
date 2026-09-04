-- PROPOSED ONLY: SGODX PURCHASE MILESTONES v1.
-- This migration creates the additive schema only. It does not assign
-- purchase numbers, create real milestones, create awards, or backfill data.
-- The assignment RPC and historical backfill are separate reviewed steps.

alter table public.orders
  add column if not exists purchase_number bigint;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_purchase_number_positive_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_purchase_number_positive_check
      check (purchase_number is null or purchase_number > 0);
  end if;
end
$$;

create unique index if not exists orders_purchase_number_key
  on public.orders (purchase_number)
  where purchase_number is not null;

-- This redundant composite key allows awards to prove that their copied
-- Order/Customer/PASS/number tuple belongs to one exact Order row.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_identity_purchase_number_key'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_identity_purchase_number_key
      unique (id, customer_id, sgx_pass_id, purchase_number);
  end if;
end
$$;

create table if not exists public.purchase_counter (
  id smallint primary key,
  last_purchase_number bigint not null default 0,
  assignment_state text not null default 'paused',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint purchase_counter_singleton_check check (id = 1),
  constraint purchase_counter_number_check check (last_purchase_number >= 0),
  constraint purchase_counter_state_check check (
    assignment_state in ('paused', 'backfill', 'live')
  )
);

insert into public.purchase_counter (id, last_purchase_number, assignment_state)
values (1, 0, 'paused')
on conflict (id) do nothing;

create table if not exists public.purchase_milestones (
  id uuid primary key default gen_random_uuid(),
  purchase_number bigint not null,
  name text not null,
  reward_type text not null,
  reward_amount numeric(12, 2),
  reward_currency text,
  status text not null default 'draft',
  rules_version text,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint purchase_milestones_number_key unique (purchase_number),
  constraint purchase_milestones_number_check check (purchase_number > 0),
  constraint purchase_milestones_name_check check (name <> ''),
  constraint purchase_milestones_reward_amount_check check (
    reward_amount is null or reward_amount >= 0
  ),
  constraint purchase_milestones_reward_currency_check check (
    reward_currency is null or reward_currency ~ '^[A-Z]{3}$'
  ),
  constraint purchase_milestones_status_check check (
    status in ('draft', 'scheduled', 'active', 'reached', 'cancelled')
  ),
  constraint purchase_milestones_dates_check check (
    ends_at is null or starts_at is null or ends_at >= starts_at
  )
);

create unique index if not exists purchase_milestones_id_number_key
  on public.purchase_milestones (id, purchase_number);

create table if not exists public.purchase_milestone_rules (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.purchase_milestones(id),
  version text not null,
  title text not null,
  content text not null,
  content_hash text not null,
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint purchase_milestone_rules_version_key unique (milestone_id, version),
  constraint purchase_milestone_rules_content_check check (
    title <> '' and content <> '' and content_hash <> ''
  )
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_milestones_rules_pointer_fkey'
      and conrelid = 'public.purchase_milestones'::regclass
  ) then
    alter table public.purchase_milestones
      add constraint purchase_milestones_rules_pointer_fkey
      foreign key (id, rules_version)
      references public.purchase_milestone_rules (milestone_id, version);
  end if;
end
$$;

create index if not exists purchase_milestone_rules_published_idx
  on public.purchase_milestone_rules (milestone_id, published_at desc);

create table if not exists public.purchase_milestone_awards (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.purchase_milestones(id),
  order_id uuid not null references public.orders(id),
  customer_id uuid not null references public.customers(id),
  sgx_pass_id uuid not null references public.sgx_passes(id),
  purchase_number bigint not null,
  milestone_name text not null,
  reward_type text not null,
  reward_amount numeric(12, 2),
  reward_currency text,
  rules_version text not null,
  claim_rules_version text,
  awarded_at timestamptz not null default timezone('utc', now()),
  claim_status text not null default 'awarded',
  claimed_at timestamptz,
  verified_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint purchase_milestone_awards_milestone_key unique (milestone_id),
  constraint purchase_milestone_awards_claim_status_check check (
    claim_status in ('awarded', 'claimed', 'verified', 'void', 'expired')
  ),
  constraint purchase_milestone_awards_number_fkey
    foreign key (milestone_id, purchase_number)
    references public.purchase_milestones (id, purchase_number),
  constraint purchase_milestone_awards_rules_fkey
    foreign key (milestone_id, rules_version)
    references public.purchase_milestone_rules (milestone_id, version),
  constraint purchase_milestone_awards_claim_rules_fkey
    foreign key (milestone_id, claim_rules_version)
    references public.purchase_milestone_rules (milestone_id, version),
  constraint purchase_milestone_awards_order_snapshot_fkey
    foreign key (order_id, customer_id, sgx_pass_id, purchase_number)
    references public.orders (id, customer_id, sgx_pass_id, purchase_number)
);

create index if not exists purchase_milestone_awards_customer_status_idx
  on public.purchase_milestone_awards (customer_id, claim_status, awarded_at desc);

create index if not exists purchase_milestone_awards_order_idx
  on public.purchase_milestone_awards (order_id);

alter table public.purchase_counter enable row level security;
alter table public.purchase_milestones enable row level security;
alter table public.purchase_milestone_rules enable row level security;
alter table public.purchase_milestone_awards enable row level security;
