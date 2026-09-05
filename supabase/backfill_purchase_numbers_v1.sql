-- PROPOSED ADMINISTRATIVE OPERATION ONLY: PURCHASE NUMBER BACKFILL v1.
-- Do not run as a migration and do not run without an approved production
-- window. It requires Migrations C/D and the compatible webhook rollout.
-- It assigns numbers only; it does not create milestones or awards.
-- Historical prefix: queue positions 1..N are assigned by approved_at ASC,
-- id ASC. Queue positions already admitted after D are not reset or
-- renumbered. After this fixed cut, live uses durable queue admission order.

begin isolation level read committed;

set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local sgodx.purchase_assignment_context = 'backfill';

do $$
declare
  counter_state text;
  counter_id smallint;
  counter_last bigint;
  missing_approved_at bigint;
  assigned_before_backfill bigint;
  blocked_queue_rows bigint;
  legacy_approved bigint;
  existing_queue_count bigint;
  existing_queue_min bigint;
begin
  -- GLOBAL LOCK ORDER: counter FIRST, Orders AFTER. No advisory mutex.
  select id, assignment_state, last_purchase_number
    into counter_id, counter_state, counter_last
  from public.purchase_counter
  where id = 1
  for update;

  if not found then
    raise exception 'purchase_counter_singleton_missing';
  end if;

  if counter_state <> 'paused' then
    raise exception 'purchase_counter_must_be_paused_before_backfill';
  end if;

  if counter_last <> 0 then
    raise exception 'nonzero_purchase_counter_requires_manual_reconciliation';
  end if;

  -- Freeze writes only for this short administrative transaction. Existing
  -- writers finish before this lock is granted; subsequent inserts/approvals
  -- wait until COMMIT, persist afterwards and call the now-live RPC.
  -- READ COMMITTED gives the ranking a fresh snapshot AFTER the lock grant.
  -- Ordinary readers remain available. RPC callers must not hold Order locks
  -- before acquiring the counter (the webhook uses separate transactions).
  lock table public.orders in share row exclusive mode;

  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.orders'::regclass
      and tgname = 'orders_purchase_queue_guard_v1'
      and tgfoid = 'public.guard_purchase_queue_v1()'::regprocedure
      and tgenabled = 'O' and not tgisinternal
  ) then
    raise exception 'purchase_queue_admission_guard_required';
  end if;

  select count(*) into blocked_queue_rows from public.orders
  where purchase_queue_position is not null and purchase_number is null
    and status <> 'approved';
  if blocked_queue_rows <> 0 then
    raise exception 'queued_nonapproved_orders_require_lifecycle_review';
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

  -- D reserves the first N sequence values for the approved population that
  -- existed at cutover. Therefore any already-admitted post-D row must start
  -- strictly after the historical prefix that this operation will fill.
  select count(*) into legacy_approved
  from public.orders
  where status = 'approved'
    and approved_at is not null
    and purchase_number is null
    and purchase_queue_position is null;

  select count(*), min(purchase_queue_position)
    into existing_queue_count, existing_queue_min
  from public.orders
  where purchase_queue_position is not null;

  if existing_queue_count <> 0 and existing_queue_min <= legacy_approved then
    raise exception 'queue_positions_precede_historical_cutover';
  end if;

  update public.purchase_counter
  set assignment_state = 'backfill',
      updated_at = timezone('utc', now())
  where id = 1;
end
$$;

-- Fill the historical internal queue prefix before assigning commercial
-- numbers. The trigger allows this one-way NULL -> value transition only in
-- this transaction, with the admin context above. New post-D rows already
-- have positions after this prefix because D reserved the sequence range.
with ranked_legacy as (
  select
    id,
    row_number() over (order by approved_at asc, id asc)::bigint as assigned_queue_position
  from public.orders
  where status = 'approved'
    and approved_at is not null
    and purchase_number is null
    and purchase_queue_position is null
), assigned_queue as (
  update public.orders as orders
  set purchase_queue_position = ranked_legacy.assigned_queue_position
  from ranked_legacy
  where orders.id = ranked_legacy.id
    and orders.purchase_queue_position is null
  returning orders.id
)
select count(*)::bigint as assigned_queue_positions
from assigned_queue;

do $$
declare
  missing_queue_position bigint;
  sequence_last_value bigint;
  max_queue_position bigint;
begin
  select count(*) into missing_queue_position
  from public.orders
  where status = 'approved'
    and purchase_number is null
    and purchase_queue_position is null;

  if missing_queue_position <> 0 then
    raise exception 'approved_orders_without_queue_position=%', missing_queue_position;
  end if;

  -- D already reserved this sequence range before the historical prefix was
  -- filled. Do not reset it: rollback/duplicate gaps are valid internally.
  -- This assertion fails closed if a manually reviewed database is behind.
  select last_value into sequence_last_value
  from public.purchase_queue_position_v1_seq;
  select max(purchase_queue_position) into max_queue_position
  from public.orders;
  if sequence_last_value < coalesce(max_queue_position, 0) then
    raise exception 'queue_sequence_behind_historical_positions';
  end if;
end
$$;

-- Assign the complete current approved population deterministically by the
-- durable queue position. The NULL predicate is defensive and prevents
-- renumbering if this script is reviewed against a partially populated DB.
with ranked_orders as (
  select
    id,
    row_number() over (order by purchase_queue_position asc)::bigint as assigned_number
  from public.orders
  where status = 'approved'
    and purchase_queue_position is not null
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
  approved_positioned bigint;
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

  select count(*)
    into approved_positioned
  from public.orders
  where status = 'approved'
    and purchase_queue_position is not null;

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

  if approved_total <> approved_positioned then
    raise exception 'approved_order_without_queue_position=%', approved_total - approved_positioned;
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
