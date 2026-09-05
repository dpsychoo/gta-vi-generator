-- SGODX PURCHASE NUMBER ASSIGNMENT v1 - PROPOSED READ-ONLY PREFLIGHT.
-- Do not execute automatically. This file only reads catalog metadata and
-- data, then returns one Results-compatible table for the SQL Editor.
-- Migration D, queue admission, number assignment, backfill, milestones and
-- awards are intentionally absent from this preflight.

with
catalog as (
  select
    to_regclass('public.orders') as orders_relation,
    to_regclass('public.customers') as customers_relation,
    to_regclass('public.sgx_passes') as passes_relation,
    to_regclass('public.jobs') as jobs_relation,
    to_regclass('public.purchase_counter') as counter_relation,
    to_regclass('public.purchase_milestones') as milestones_relation,
    to_regclass('public.purchase_milestone_rules') as rules_relation,
    to_regclass('public.purchase_milestone_awards') as awards_relation
),
available_columns as (
  select coalesce(
    array_agg(table_name || '.' || column_name order by table_name, ordinal_position),
    array[]::text[]
  ) as column_keys
  from information_schema.columns
  where table_schema = 'public'
    and table_name in (
      'orders', 'customers', 'sgx_passes', 'jobs', 'purchase_counter',
      'purchase_milestones', 'purchase_milestone_rules',
      'purchase_milestone_awards'
    )
),
state as (
  select catalog.*, available_columns.column_keys
  from catalog cross join available_columns
),
static_results as (
  select 10 as sort_order, 'A'::text as section,
    'orders_table'::text as check_name,
    coalesce(orders_relation::text, '') as value,
    case when orders_relation is null then 'SKIP' else 'PASS' end as status,
    case when orders_relation is null then 'table_or_column_missing'
      else 'public.orders is present' end as detail
  from state

  union all
  select 20, 'A', 'orders_purchase_number_column',
    case when 'orders.purchase_number' = any(column_keys) then 'present' else 'missing' end,
    case when 'orders.purchase_number' = any(column_keys) then 'PASS' else 'SKIP' end,
    case when 'orders.purchase_number' = any(column_keys)
      then 'commercial number column is present before D'
      else 'table_or_column_missing' end
  from state

  union all
  select 30, 'A', 'orders_purchase_queue_position_absent',
    case when orders_relation is null then null
      else case when 'orders.purchase_queue_position' = any(column_keys)
        then 'present' else 'absent' end end,
    case when orders_relation is null then 'SKIP'
      when 'orders.purchase_queue_position' = any(column_keys) then 'FAIL'
      else 'EXPECTED_ABSENT' end,
    case when orders_relation is null then 'table_or_column_missing'
      when 'orders.purchase_queue_position' = any(column_keys)
        then 'Migration D appears to have been applied already'
      else 'D queue column is not installed' end
  from state

  union all
  select 40, 'A', 'purchase_counter_table',
    coalesce(counter_relation::text, ''),
    case when counter_relation is null then 'SKIP' else 'PASS' end,
    case when counter_relation is null then 'table_or_column_missing'
      else 'public.purchase_counter is present' end
  from state

  union all
  select 50, 'A', 'milestone_schema_tables',
    jsonb_build_object(
      'purchase_milestones', milestones_relation is not null,
      'purchase_milestone_rules', rules_relation is not null,
      'purchase_milestone_awards', awards_relation is not null
    )::text,
    case when milestones_relation is not null
      and rules_relation is not null and awards_relation is not null
      then 'PASS' else 'SKIP' end,
    case when milestones_relation is not null
      and rules_relation is not null and awards_relation is not null
      then 'Migration C milestone schema is present; no seed is expected'
      else 'table_or_column_missing' end
  from state

  union all
  select 60, 'A', 'd_named_objects_absent',
    jsonb_build_object(
      'queue_sequence', exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'purchase_queue_position_v1_seq'
          and c.relkind = 'S'
      ),
      'queue_unique_index', exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'orders_purchase_queue_position_key'
          and c.relkind = 'i'
      ),
      'queue_pending_index', exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'orders_purchase_queue_pending_idx'
          and c.relkind = 'i'
      ),
      'queue_positive_constraint', exists (
        select 1 from pg_catalog.pg_constraint c
        join pg_catalog.pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public'
          and c.conname = 'orders_purchase_queue_position_positive'
      ),
      'queue_guard_function', pg_catalog.to_regprocedure(
        'public.guard_purchase_queue_v1()') is not null,
      'queue_guard_trigger', exists (
        select 1 from pg_catalog.pg_trigger t
        where t.tgrelid = orders_relation
          and t.tgname = 'orders_purchase_queue_guard_v1'
          and not t.tgisinternal
      ),
      'assignment_rpc', pg_catalog.to_regprocedure(
        'public.assign_purchase_number_v1(uuid)') is not null
    )::text,
    case when orders_relation is null then 'SKIP'
      when not exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (
            'purchase_queue_position_v1_seq',
            'orders_purchase_queue_position_key',
            'orders_purchase_queue_pending_idx'
          )
      )
      and not exists (
        select 1 from pg_catalog.pg_constraint c
        join pg_catalog.pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public'
          and c.conname = 'orders_purchase_queue_position_positive'
      )
      and pg_catalog.to_regprocedure('public.guard_purchase_queue_v1()') is null
      and pg_catalog.to_regprocedure('public.assign_purchase_number_v1(uuid)') is null
      then 'EXPECTED_ABSENT' else 'FAIL' end,
    case when orders_relation is null then 'table_or_column_missing'
      when not exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (
            'purchase_queue_position_v1_seq',
            'orders_purchase_queue_position_key',
            'orders_purchase_queue_pending_idx'
          )
      )
      and not exists (
        select 1 from pg_catalog.pg_constraint c
        join pg_catalog.pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public'
          and c.conname = 'orders_purchase_queue_position_positive'
      )
      and pg_catalog.to_regprocedure('public.guard_purchase_queue_v1()') is null
      and pg_catalog.to_regprocedure('public.assign_purchase_number_v1(uuid)') is null
      then 'D named objects are not installed'
      else 'one or more D named objects already exist; review before applying D' end
  from state
  union all
  select 70, 'A', 'purchase_queue_sequence_absent',
    case when exists (
      select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'purchase_queue_position_v1_seq'
        and c.relkind = 'S'
    ) then 'present' else 'absent' end,
    case when exists (
      select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'purchase_queue_position_v1_seq'
        and c.relkind = 'S'
    ) then 'FAIL' else 'EXPECTED_ABSENT' end,
    'D sequence must not be installed before the migration' from state

  union all
  select 80, 'A', 'purchase_queue_trigger_absent',
    case when orders_relation is null then null when exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = orders_relation
        and t.tgname = 'orders_purchase_queue_guard_v1'
        and not t.tgisinternal
    ) then 'present' else 'absent' end,
    case when orders_relation is null then 'SKIP'
      when exists (
        select 1 from pg_catalog.pg_trigger t
        where t.tgrelid = orders_relation
          and t.tgname = 'orders_purchase_queue_guard_v1'
          and not t.tgisinternal
      ) then 'FAIL' else 'EXPECTED_ABSENT' end,
    case when orders_relation is null then 'table_or_column_missing'
      else 'D trigger must not be installed before the migration' end from state

  union all
  select 90, 'A', 'purchase_queue_guard_function_absent',
    case when pg_catalog.to_regprocedure('public.guard_purchase_queue_v1()')
      is null then 'absent' else 'present' end,
    case when pg_catalog.to_regprocedure('public.guard_purchase_queue_v1()')
      is null then 'EXPECTED_ABSENT' else 'FAIL' end,
    'D trigger function must not exist before the migration' from state

  union all
  select 95, 'A', 'assignment_rpc_absent',
    case when pg_catalog.to_regprocedure('public.assign_purchase_number_v1(uuid)')
      is null then 'absent' else 'present' end,
    case when pg_catalog.to_regprocedure('public.assign_purchase_number_v1(uuid)')
      is null then 'EXPECTED_ABSENT' else 'FAIL' end,
    'D assignment RPC must not exist before the migration' from state
),
check_specs as (
  select state.*, specs.sort_order, specs.section, specs.check_name,
    specs.can_run, specs.query_text
  from state
  cross join lateral (
    values
      (
        100, 'B', 'purchase_counter_state',
        state.counter_relation is not null
          and array['purchase_counter.id', 'purchase_counter.assignment_state',
            'purchase_counter.last_purchase_number'] <@ state.column_keys,
        $sql$
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', id, 'assignment_state', assignment_state,
            'last_purchase_number', last_purchase_number::text)), '[]'::jsonb)::text as value,
            case when count(*) = 1 and bool_and(id = 1
              and last_purchase_number = 0 and assignment_state = 'paused')
              then 'PASS' else 'FAIL' end as status,
            'expected singleton id=1, last_purchase_number=0, assignment_state=paused' as detail
          from public.purchase_counter
        $sql$
      ),
      (
        110, 'B', 'approved_orders_population',
        state.orders_relation is not null
          and array['orders.status', 'orders.purchase_number'] <@ state.column_keys,
        $sql$
          select jsonb_build_object(
            'approved', count(*) filter (where status = 'approved'),
            'approved_without_purchase_number', count(*) filter (
              where status = 'approved' and purchase_number is null),
            'numbered_rows', count(*) filter (where purchase_number is not null)
          )::text as value,
          'INFO' as status,
          'expected initial evidence: 3 approved orders and 0 numbered orders' as detail
          from public.orders
        $sql$
      ),
      (
        115, 'B', 'approved_orders_without_purchase_number',
        state.orders_relation is not null
          and array['orders.status', 'orders.purchase_number'] <@ state.column_keys,
        $sql$
          select count(*)::text as value,
            'INFO' as status,
            'expected approved backlog before D/backfill; initial evidence is 3'
              as detail
          from public.orders
          where status = 'approved' and purchase_number is null
        $sql$
      ),
      (
        120, 'B', 'approved_orders_without_approved_at',
        state.orders_relation is not null
          and array['orders.status', 'orders.approved_at'] <@ state.column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'approved orders require approved_at for the historical prefix' as detail
          from public.orders
          where status = 'approved' and approved_at is null
        $sql$
      ),
      (
        130, 'B', 'existing_purchase_number_rows',
        state.orders_relation is not null
          and array['orders.purchase_number'] <@ state.column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'D/backfill expects zero existing commercial numbers' as detail
          from public.orders where purchase_number is not null
        $sql$
      ),
      (
        140, 'C', 'approved_orders_without_customer_pass_job',
        state.orders_relation is not null and state.customers_relation is not null
          and state.passes_relation is not null and state.jobs_relation is not null
          and array['orders.status', 'orders.customer_id', 'orders.sgx_pass_id',
            'orders.job_id', 'customers.id', 'sgx_passes.id', 'jobs.id'] <@ state.column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'approved orders must have Customer, PASS and Job rows' as detail
          from public.orders o
          left join public.customers c on c.id = o.customer_id
          left join public.sgx_passes p on p.id = o.sgx_pass_id
          left join public.jobs j on j.id = o.job_id
          where o.status = 'approved'
            and (o.customer_id is null or c.id is null
              or o.sgx_pass_id is null or p.id is null
              or o.job_id is null or j.id is null)
        $sql$
      ),
      (
        150, 'C', 'approved_customer_pass_mismatches',
        state.orders_relation is not null and state.passes_relation is not null
          and array['orders.status', 'orders.customer_id', 'orders.sgx_pass_id',
            'sgx_passes.id', 'sgx_passes.customer_id'] <@ state.column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'approved Order customer_id must match the PASS customer_id' as detail
          from public.orders o
          join public.sgx_passes p on p.id = o.sgx_pass_id
          where o.status = 'approved'
            and p.customer_id is distinct from o.customer_id
        $sql$
      ),
      (
        160, 'G', 'purchase_number_duplicates',
        state.orders_relation is not null
          and array['orders.purchase_number'] <@ state.column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'duplicate non-null commercial purchase numbers' as detail
          from (
            select purchase_number from public.orders
            where purchase_number is not null
            group by purchase_number having count(*) > 1
          ) duplicates
        $sql$
      ),
      (
        170, 'G', 'max_purchase_number',
        state.orders_relation is not null
          and array['orders.purchase_number'] <@ state.column_keys,
        $sql$
          select coalesce(max(purchase_number), 0)::text as value,
            'INFO' as status,
            'commercial counter baseline; expected 0 before D/backfill' as detail
          from public.orders
        $sql$
      ),
      (
        180, 'F', 'purchase_milestones_rows',
        state.milestones_relation is not null,
        $sql$
          select count(*)::text as value,
            'INFO' as status,
            'configured milestone rows; expected 0 in the current rollout' as detail
          from public.purchase_milestones
        $sql$
      ),
      (
        190, 'F', 'purchase_milestone_rules_rows',
        state.rules_relation is not null,
        $sql$
          select count(*)::text as value,
            'INFO' as status,
            'configured milestone rule rows; expected 0 in the current rollout' as detail
          from public.purchase_milestone_rules
        $sql$
      ),
      (
        200, 'F', 'purchase_milestone_awards_rows',
        state.awards_relation is not null,
        $sql$
          select count(*)::text as value,
            'INFO' as status,
            'historical awards; expected 0 before any live milestone is reached' as detail
          from public.purchase_milestone_awards
        $sql$
      )
  ) specs(sort_order, section, check_name, can_run, query_text)
),
raw_results as materialized (
  select r.*, case when can_run
    then pg_catalog.query_to_xml(query_text, true, false, '') end as result_xml
  from check_specs r
),
data_results as (
  select sort_order, section, check_name,
    case when can_run then (xpath('string(/table/row/value)', result_xml))[1]::text end as value,
    case when can_run then (xpath('string(/table/row/status)', result_xml))[1]::text
      else 'SKIP' end as status,
    case when can_run then (xpath('string(/table/row/detail)', result_xml))[1]::text
      else 'table_or_column_missing' end as detail
  from raw_results
),
results as materialized (
  select * from static_results
  union all
  select * from data_results
),
summary as (
  select 1000 as sort_order, 'K'::text as section, 'blockers'::text as check_name,
    count(*) filter (where status in ('FAIL', 'SKIP'))::text as value,
    case when count(*) filter (where status in ('FAIL', 'SKIP')) = 0
      then 'PASS' else 'FAIL' end as status,
    'FAIL or missing prerequisites block Migration D; EXPECTED_ABSENT and INFO are not blockers'
      ::text as detail
  from results
)
select section, check_name, value, status, detail
from (select * from results union all select * from summary) all_results
order by sort_order, section, check_name;
