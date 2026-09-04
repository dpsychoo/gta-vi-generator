-- PROPOSED ADMINISTRATIVE OPERATION ONLY: PURCHASE NUMBER BACKFILL v1.
-- Do not run as a migration and do not run without an approved production
-- window. It requires Migration C to have completed successfully.
-- It assigns numbers only; it does not create milestones or awards.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- This is the same transition mutex that the future assignment RPC must use.
-- It prevents an assignment RPC from running while the counter is prepared.
select pg_advisory_xact_lock(
  hashtextextended('sgodx.purchase_number_assignment', 0)
);

do $$
declare
  counter_rows bigint;
  counter_state text;
  counter_id smallint;
  missing_approved_at bigint;
  assigned_before_backfill bigint;
begin
  select count(*)
    into counter_rows
  from public.purchase_counter
  where id = 1;

  if counter_rows <> 1 then
    raise exception 'purchase_counter_singleton_missing_or_duplicated';
  end if;

  select id, assignment_state
    into counter_id, counter_state
  from public.purchase_counter
  where id = 1
  for update;

  if counter_state <> 'paused' then
    raise exception 'purchase_counter_must_be_paused_before_backfill';
  end if;

  select count(*)
    into missing_approved_at
  from public.orders
  where status = 'approved'
    and approved_at is null;

  if missing_approved_at <> 0 then
    raise exception 'approved_orders_without_approved_at=%', missing_approved_at;
  end if;

  select count(*)
    into assigned_before_backfill
  from public.orders
  where purchase_number is not null;

  if assigned_before_backfill <> 0 then
    raise exception 'existing_purchase_numbers_require_manual_reconciliation=%', assigned_before_backfill;
  end if;

  update public.purchase_counter
  set assignment_state = 'backfill',
      updated_at = timezone('utc', now())
  where id = 1;
end
$$;

-- Assign the complete current approved population deterministically. The
-- NULL predicate is defensive and prevents renumbering if this script is
-- reviewed against a partially populated database.
with ranked_orders as (
  select
    id,
    row_number() over (order by approved_at asc, id asc)::bigint as assigned_number
  from public.orders
  where status = 'approved'
    and approved_at is not null
    and purchase_number is null
), assigned as (
  update public.orders as orders
  set purchase_number = ranked_orders.assigned_number
  from ranked_orders
  where orders.id = ranked_orders.id
    and orders.purchase_number is null
  returning orders.id
)
select count(*)::bigint as assigned_orders
from assigned;

do $$
declare
  approved_total bigint;
  approved_numbered bigint;
  assigned_total bigint;
  min_number bigint;
  max_number bigint;
  duplicate_groups bigint;
begin
  select count(*)
    into approved_total
  from public.orders
  where status = 'approved';

  select count(*)
    into approved_numbered
  from public.orders
  where status = 'approved'
    and purchase_number is not null;

  select count(*), min(purchase_number), max(purchase_number)
    into assigned_total, min_number, max_number
  from public.orders
  where purchase_number is not null;

  select count(*)
    into duplicate_groups
  from (
    select purchase_number
    from public.orders
    where purchase_number is not null
    group by purchase_number
    having count(*) > 1
  ) duplicates;

  if approved_total <> approved_numbered then
    raise exception 'approved_order_not_numbered=%', approved_total - approved_numbered;
  end if;

  if assigned_total <> approved_total then
    raise exception 'unexpected_non_approved_purchase_number_rows=%', assigned_total - approved_total;
  end if;

  if duplicate_groups <> 0 then
    raise exception 'purchase_number_duplicate_groups=%', duplicate_groups;
  end if;

  if approved_total = 0 then
    if min_number is not null or max_number is not null then
      raise exception 'empty_approved_population_has_numbers';
    end if;
  elsif min_number <> 1 or max_number <> approved_total then
    raise exception 'purchase_number_range_is_not_contiguous';
  end if;
end
$$;

update public.purchase_counter
set last_purchase_number = coalesce((
      select max(purchase_number)
      from public.orders
    ), 0),
    assignment_state = 'live',
    updated_at = timezone('utc', now())
where id = 1;

-- No historical milestone awards are created here. Any future configured
-- milestone requires a separate reviewed reconciliation operation.
select
  'BACKFILL' as section,
  'purchase_number_backfill' as check_name,
  jsonb_build_object(
    'approved_orders', (select count(*) from public.orders where status = 'approved'),
    'numbered_orders', (select count(*) from public.orders where purchase_number is not null),
    'counter_last', (select last_purchase_number from public.purchase_counter where id = 1),
    'counter_state', (select assignment_state from public.purchase_counter where id = 1)
  )::text as value,
  'PASS' as status,
  'historical numbers assigned; no milestone awards created' as detail;

commit;
