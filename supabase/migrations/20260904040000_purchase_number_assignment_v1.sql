-- PROPOSAL ONLY. Requires Migration C. Do not execute in this local phase.
-- Defines queue admission and backend RPC: no historical numbering or seeds.
-- The explicit transaction also prevents a window with default PUBLIC access.
begin;

-- Durable admission position, NOT the commercial purchase_number. Existing
-- rows remain NULL; the initial historical backfill has its own fixed ordering.
alter table public.orders add column purchase_queue_position bigint;
alter table public.orders add constraint orders_purchase_queue_position_positive
  check (purchase_queue_position is null or purchase_queue_position > 0);

-- Gaps from aborted/duplicate inserts are harmless INTERNAL queue positions.
-- CACHE 1 is essential: no session may retain a lower ticket for a later row.
-- The commercial number still uses the transactional counter, never nextval.
create sequence public.purchase_queue_position_v1_seq as bigint
  increment by 1 minvalue 1 start with 1 cache 1 no cycle;
alter sequence public.purchase_queue_position_v1_seq owner to postgres;
revoke all on sequence public.purchase_queue_position_v1_seq from public, anon, authenticated, service_role;

-- Reserve positions for the approved population that exists when D is
-- installed. The backfill fills positions 1..N; the first post-D approval
-- receives N+1. This only advances the new internal sequence object.
select pg_catalog.setval(
  'public.purchase_queue_position_v1_seq'::regclass,
  greatest(coalesce((select count(*) from public.orders where status = 'approved'), 0), 1)::bigint,
  coalesce((select count(*) > 0 from public.orders where status = 'approved'), false)
);

create unique index orders_purchase_queue_position_key
  on public.orders (purchase_queue_position) where purchase_queue_position is not null;
create index orders_purchase_queue_pending_idx
  on public.orders (purchase_queue_position)
  where purchase_number is null and purchase_queue_position is not null;

create function public.guard_purchase_queue_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $queue_guard$
declare
  v_assignment_context text;
begin
  v_assignment_context := pg_catalog.current_setting('sgodx.purchase_assignment_context', true);
  if tg_op = 'DELETE' then
    if old.purchase_queue_position is not null or old.purchase_number is not null then
      raise exception 'registered_purchase_must_be_retained';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.purchase_queue_position is not null or new.purchase_number is not null then
      raise exception 'purchase_position_must_be_server_assigned';
    end if;
  else
    if new.purchase_queue_position is distinct from old.purchase_queue_position then
      if not (
        old.purchase_queue_position is null
        and new.purchase_queue_position is not null
        and old.purchase_number is null
        and new.purchase_number is null
        and new.status = 'approved'
        and v_assignment_context = 'backfill'
        and session_user = 'postgres'
      ) then
        raise exception 'purchase_queue_position_is_immutable';
      end if;
    end if;
    if old.purchase_number is not null and new.purchase_number is distinct from old.purchase_number then
      raise exception 'purchase_number_is_permanent';
    end if;
    if old.purchase_number is null and new.purchase_number is not null
      and not (
        old.purchase_queue_position is not null
        and new.purchase_queue_position is not distinct from old.purchase_queue_position
        and new.status = 'approved'
        and v_assignment_context in ('rpc', 'backfill')
        and (v_assignment_context = 'rpc' or session_user = 'postgres')
      ) then
      raise exception 'purchase_number_is_server_assigned';
    end if;
    if (old.purchase_queue_position is not null or old.purchase_number is not null)
      and new.id is distinct from old.id then
      raise exception 'registered_order_id_is_immutable';
    end if;
  end if;
  if new.status = 'approved' and new.purchase_number is null
    and new.purchase_queue_position is null then
    -- An Order writer already holds its table lock BEFORE this trigger runs.
    -- This trigger MUST NOT acquire the counter: that would invert lock order.
    new.purchase_queue_position := pg_catalog.nextval('public.purchase_queue_position_v1_seq'::regclass);
  end if;
  return new;
end
$queue_guard$;

alter function public.guard_purchase_queue_v1() owner to postgres;
revoke all on function public.guard_purchase_queue_v1() from public, anon, authenticated, service_role;
create trigger orders_purchase_queue_guard_v1
  before insert or update or delete on public.orders
  for each row execute function public.guard_purchase_queue_v1();

create function public.assign_purchase_number_v1(p_order_id uuid)
returns table (
  outcome text,
  purchase_number text,
  milestone_reached boolean,
  milestone_id uuid,
  award_id uuid,
  reason text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '2s'
as $function$
declare
  v_order public.orders%rowtype;
  v_counter public.purchase_counter%rowtype;
  v_milestone public.purchase_milestones%rowtype;
  v_rule public.purchase_milestone_rules%rowtype;
  v_next bigint;
  v_max bigint;
  v_awarded_at timestamptz;
  v_milestone_id uuid;
  v_award_id uuid;
  v_head_id uuid;
  v_max_assigned_queue bigint;
begin
  -- Optional idempotent fast path: reads only, no Order row lock.
  select o.* into v_order from public.orders as o where o.id = p_order_id;
  if not found then
    return query select 'not_found'::text, null::text, false,
      null::uuid, null::uuid, 'order_not_found'::text;
    return;
  end if;

  if v_order.purchase_number is not null then
    select a.milestone_id, a.id into v_milestone_id, v_award_id
    from public.purchase_milestone_awards as a where a.order_id = v_order.id;
    return query select 'existing'::text, v_order.purchase_number::text,
      v_award_id is not null, v_milestone_id, v_award_id, null::text;
    return;
  end if;

  if v_order.status <> 'approved' then
    return query select 'not_approved'::text, null::text, false,
      null::uuid, null::uuid, 'order_not_approved'::text;
    return;
  end if;

  perform pg_catalog.set_config('sgodx.purchase_assignment_context', 'rpc', true);

  -- A stale repeatable-read snapshot could hide an earlier committed writer.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'purchase_assignment_requires_read_committed';
  end if;

  -- GLOBAL LOCK ORDER: counter FIRST, Order AFTER, then milestone/rule.
  -- Callers must not already hold Order locks in this transaction.
  select c.* into v_counter
  from public.purchase_counter as c where c.id = 1 for update;
  if not found then
    raise exception 'purchase_counter_missing';
  end if;
  if v_counter.assignment_state in ('paused', 'backfill') then
    return query select 'deferred'::text, null::text, false,
      null::uuid, null::uuid, ('counter_' || v_counter.assignment_state)::text;
    return;
  end if;
  if v_counter.assignment_state <> 'live' then
    raise exception 'purchase_counter_invalid_state';
  end if;

  -- Drain IN-FLIGHT WRITERS, not the business queue: wait for their commit or
  -- rollback before reading the queue with a fresh READ COMMITTED snapshot.
  -- Future writers cannot allocate a ticket until this table barrier releases.
  -- Without this barrier, an uncommitted earlier ticket could be overtaken.
  lock table public.orders in share row exclusive mode;

  select o.* into v_order from public.orders as o
  where o.id = p_order_id for update;
  if not found then
    return query select 'not_found'::text, null::text, false,
      null::uuid, null::uuid, 'order_not_found'::text;
    return;
  end if;

  -- Another RPC or the backfill may have assigned while we waited.
  if v_order.purchase_number is not null then
    select a.milestone_id, a.id into v_milestone_id, v_award_id
    from public.purchase_milestone_awards as a where a.order_id = v_order.id;
    return query select 'existing'::text, v_order.purchase_number::text,
      v_award_id is not null, v_milestone_id, v_award_id, null::text;
    return;
  end if;
  if v_order.status <> 'approved' then
    return query select 'not_approved'::text, null::text, false,
      null::uuid, null::uuid, 'order_not_approved'::text;
    return;
  end if;

  -- Fail closed if the initial backfill/admission mechanism was bypassed.
  if exists (select 1 from public.orders as o where o.status = 'approved'
    and o.purchase_number is null and o.purchase_queue_position is null) then
    return query select 'deferred'::text, null::text, false,
      null::uuid, null::uuid, 'queue_position_missing'::text;
    return;
  end if;

  -- Do not skip a registered head whose status/identity became invalid: a
  -- lifecycle or integrity issue must not give its position to a later Order.
  select o.id into v_head_id from public.orders as o
  where o.purchase_number is null and o.purchase_queue_position is not null
  order by o.purchase_queue_position asc limit 1;
  if v_head_id is distinct from v_order.id then
    return query select 'deferred'::text, null::text, false,
      null::uuid, null::uuid, 'prior_pending'::text;
    return;
  end if;

  select max(o.purchase_queue_position) into v_max_assigned_queue
  from public.orders as o where o.purchase_number is not null;
  if v_order.purchase_queue_position <= v_max_assigned_queue then
    return query select 'deferred'::text, null::text, false,
      null::uuid, null::uuid, 'queue_order_violation'::text;
    return;
  end if;
  if v_order.approved_at is null then
    raise exception 'approved_order_without_approved_at';
  end if;
  if v_order.customer_id is null or v_order.sgx_pass_id is null
    or not exists (
      select 1 from public.customers as c
      join public.sgx_passes as p on p.customer_id = c.id
      where c.id = v_order.customer_id and p.id = v_order.sgx_pass_id
    ) then
    raise exception 'order_customer_pass_integrity_error';
  end if;

  select coalesce(max(o.purchase_number), 0) into v_max from public.orders as o;
  if v_counter.last_purchase_number <> v_max then
    raise exception 'purchase_counter_out_of_sync';
  end if;
  if v_counter.last_purchase_number = 9223372036854775807 then
    raise exception 'purchase_counter_exhausted';
  end if;
  v_next := v_counter.last_purchase_number + 1;

  update public.orders as o set purchase_number = v_next
  where o.id = v_order.id and o.purchase_number is null;
  if not found then
    raise exception 'purchase_number_assignment_conflict';
  end if;
  update public.purchase_counter as c
  set last_purchase_number = v_next, updated_at = pg_catalog.clock_timestamp()
  where c.id = 1;

  select m.* into v_milestone from public.purchase_milestones as m
  where m.purchase_number = v_next for update;
  if found and v_milestone.status = 'active'
    and nullif(pg_catalog.btrim(v_milestone.rules_version), '') is not null then
    -- Prevent concurrent edits of the selected published rule during award.
    select r.* into v_rule from public.purchase_milestone_rules as r
    where r.milestone_id = v_milestone.id
      and r.version = v_milestone.rules_version for share;
    v_awarded_at := pg_catalog.clock_timestamp();
    if found and v_rule.published_at is not null
      and v_rule.published_at <= v_awarded_at
      and (v_milestone.starts_at is null or v_milestone.starts_at <= v_awarded_at)
      and (v_milestone.ends_at is null or v_awarded_at <= v_milestone.ends_at)
      and nullif(pg_catalog.btrim(v_rule.title), '') is not null
      and nullif(pg_catalog.btrim(v_rule.content), '') is not null
      and nullif(pg_catalog.btrim(v_rule.content_hash), '') is not null then
      -- No conflict suppression: a genuine integrity failure rolls back
      -- Order, counter, award and milestone together. Retries use existing.
      insert into public.purchase_milestone_awards as a (
        milestone_id, order_id, customer_id, sgx_pass_id, purchase_number,
        milestone_name, reward_type, reward_amount, reward_currency,
        rules_version, awarded_at, claim_status
      ) values (
        v_milestone.id, v_order.id, v_order.customer_id, v_order.sgx_pass_id, v_next,
        v_milestone.name, v_milestone.reward_type, v_milestone.reward_amount,
        v_milestone.reward_currency, v_milestone.rules_version, v_awarded_at, 'awarded'
      ) returning a.id into v_award_id;
      v_milestone_id := v_milestone.id;
      update public.purchase_milestones as m
      set status = 'reached', updated_at = v_awarded_at where m.id = v_milestone.id;
    end if;
  end if;

  -- Decimal text preserves PostgreSQL bigint exactly in JSON/JavaScript.
  return query select 'assigned'::text, v_next::text,
    v_award_id is not null, v_milestone_id, v_award_id, null::text;
end
$function$;

alter function public.assign_purchase_number_v1(uuid) owner to postgres;
revoke all on function public.assign_purchase_number_v1(uuid) from public, anon, authenticated;
grant execute on function public.assign_purchase_number_v1(uuid) to service_role;

commit;
