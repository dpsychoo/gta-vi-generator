-- SGODX PURCHASE NUMBER CUTOVER v1 - READ-ONLY PREFLIGHT.
-- Run manually in the Supabase SQL Editor only after reviewing the result set.
-- Every result has: section, check_name, value, status, detail.
-- No customer email, token, payment credential or sensitive metadata is read.

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
  select 20, 'A', 'counter_table',
    coalesce(counter_relation::text, ''),
    case when counter_relation is null then 'SKIP' else 'PASS' end,
    case when counter_relation is null then 'table_or_column_missing'
      else 'public.purchase_counter is present' end
  from state

  union all
  select 30, 'A', 'required_cutover_columns',
    jsonb_build_object(
      'orders.status', 'orders.status' = any(column_keys),
      'orders.approved_at', 'orders.approved_at' = any(column_keys),
      'orders.customer_id', 'orders.customer_id' = any(column_keys),
      'orders.sgx_pass_id', 'orders.sgx_pass_id' = any(column_keys),
      'orders.job_id', 'orders.job_id' = any(column_keys),
      'orders.purchase_queue_position', 'orders.purchase_queue_position' = any(column_keys),
      'orders.purchase_number', 'orders.purchase_number' = any(column_keys),
      'counter.id', 'purchase_counter.id' = any(column_keys),
      'counter.last_purchase_number', 'purchase_counter.last_purchase_number' = any(column_keys),
      'counter.assignment_state', 'purchase_counter.assignment_state' = any(column_keys)
    )::text,
    case when array[
      'orders.status', 'orders.approved_at', 'orders.customer_id',
      'orders.sgx_pass_id', 'orders.job_id',
      'orders.purchase_queue_position', 'orders.purchase_number',
      'purchase_counter.id', 'purchase_counter.last_purchase_number',
      'purchase_counter.assignment_state'
    ] <@ column_keys then 'PASS' else 'SKIP' end,
    case when array[
      'orders.status', 'orders.approved_at', 'orders.customer_id',
      'orders.sgx_pass_id', 'orders.job_id',
      'orders.purchase_queue_position', 'orders.purchase_number',
      'purchase_counter.id', 'purchase_counter.last_purchase_number',
      'purchase_counter.assignment_state'
    ] <@ column_keys then 'required cutover columns are present'
      else 'table_or_column_missing' end
  from state

  union all
  select 40, 'N', 'migration_d_objects',
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
      when exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'purchase_queue_position_v1_seq'
          and c.relkind = 'S'
      )
      and exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'orders_purchase_queue_position_key'
          and c.relkind = 'i'
      )
      and exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'orders_purchase_queue_pending_idx'
          and c.relkind = 'i'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint c
        join pg_catalog.pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public'
          and c.conname = 'orders_purchase_queue_position_positive'
      )
      and pg_catalog.to_regprocedure('public.guard_purchase_queue_v1()') is not null
      and exists (
        select 1 from pg_catalog.pg_trigger t
        where t.tgrelid = orders_relation
          and t.tgname = 'orders_purchase_queue_guard_v1'
          and not t.tgisinternal
      )
      and pg_catalog.to_regprocedure('public.assign_purchase_number_v1(uuid)') is not null
      then 'PASS' else 'FAIL' end,
    case when orders_relation is null then 'table_or_column_missing'
      else 'Migration D queue and assignment objects must be installed' end
  from state
),
check_specs as (
  select state.*, specs.sort_order, specs.section, specs.check_name,
    specs.can_run, specs.query_text
  from state
  cross join lateral (
    values
      (
        100, 'A', 'purchase_counter_state',
        counter_relation is not null
          and array['purchase_counter.id', 'purchase_counter.assignment_state',
            'purchase_counter.last_purchase_number'] <@ column_keys,
        $sql$
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', id::text,
            'assignment_state', assignment_state,
            'last_purchase_number', last_purchase_number::text)
            order by id), '[]'::jsonb)::text as value,
            case when count(*) = 1 and bool_and(
              id = 1 and assignment_state = 'paused'
              and last_purchase_number = 0)
              then 'PASS' else 'FAIL' end as status,
            'cutover requires singleton id=1, assignment_state=paused, last_purchase_number=0'
              as detail
          from public.purchase_counter
        $sql$
      ),
      (
        110, 'B', 'approved_orders_total',
        orders_relation is not null
          and array['orders.status'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            'INFO' as status,
            'approved population; compare with the reviewed production evidence'
              as detail
          from public.orders
          where status = 'approved'
        $sql$
      ),
      (
        120, 'C', 'approved_orders_with_purchase_number',
        orders_relation is not null
          and array['orders.status', 'orders.purchase_number'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'existing approved commercial numbers require manual reconciliation'
              as detail
          from public.orders
          where status = 'approved' and purchase_number is not null
        $sql$
      ),
      (
        130, 'C', 'all_orders_with_purchase_number',
        orders_relation is not null
          and array['orders.purchase_number'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'the historical cutover expects no commercial number anywhere'
              as detail
          from public.orders
          where purchase_number is not null
        $sql$
      ),
      (
        140, 'D', 'approved_orders_without_purchase_number',
        orders_relation is not null
          and array['orders.status', 'orders.purchase_number'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            'INFO' as status,
            'approved rows awaiting the historical number operation' as detail
          from public.orders
          where status = 'approved' and purchase_number is null
        $sql$
      ),
      (
        150, 'E', 'approved_orders_with_queue_position',
        orders_relation is not null
          and array['orders.status', 'orders.purchase_queue_position'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            'INFO' as status,
            'already-admitted approved rows; existing positions must remain unchanged'
              as detail
          from public.orders
          where status = 'approved' and purchase_queue_position is not null
        $sql$
      ),
      (
        160, 'F', 'approved_orders_without_queue_position',
        orders_relation is not null
          and array['orders.status', 'orders.purchase_queue_position'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            'INFO' as status,
            'legacy approved rows to receive deterministic historical positions'
              as detail
          from public.orders
          where status = 'approved' and purchase_queue_position is null
        $sql$
      ),
      (
        170, 'G', 'approved_orders_ordered_by_approved_at_id',
        orders_relation is not null
          and array['orders.id', 'orders.job_id', 'orders.status',
            'orders.approved_at', 'orders.purchase_queue_position',
            'orders.purchase_number'] <@ column_keys,
        $sql$
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', id::text,
            'job_id', job_id::text,
            'status', status,
            'approved_at', approved_at::text,
            'purchase_queue_position', purchase_queue_position::text,
            'purchase_number', purchase_number::text)
            order by approved_at asc, id asc), '[]'::jsonb)::text as value,
            'INFO' as status,
            'safe approved Order listing; ordered by approved_at ASC, id ASC'
              as detail
          from public.orders
          where status = 'approved'
        $sql$
      ),
      (
        180, 'H', 'purchase_number_duplicates',
        orders_relation is not null
          and array['orders.purchase_number'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'duplicate non-null commercial numbers' as detail
          from (
            select purchase_number
            from public.orders
            where purchase_number is not null
            group by purchase_number
            having count(*) > 1
          ) duplicates
        $sql$
      ),
      (
        190, 'I', 'purchase_queue_position_duplicates',
        orders_relation is not null
          and array['orders.purchase_queue_position'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'duplicate non-null internal queue positions' as detail
          from (
            select purchase_queue_position
            from public.orders
            where purchase_queue_position is not null
            group by purchase_queue_position
            having count(*) > 1
          ) duplicates
        $sql$
      ),
      (
        200, 'J', 'purchase_number_continuity_current',
        orders_relation is not null
          and array['orders.purchase_number'] <@ column_keys,
        $sql$
          with metrics as (
            select count(*) as numbered_count,
              coalesce(min(purchase_number), 0) as min_number,
              coalesce(max(purchase_number), 0) as max_number,
              count(*) filter (where purchase_number <= 0) as nonpositive_count
            from public.orders
            where purchase_number is not null
          )
          select jsonb_build_object(
            'numbered_count', numbered_count,
            'min_number', min_number,
            'max_number', max_number,
            'nonpositive_count', nonpositive_count,
            'contiguous', numbered_count = 0
              or (min_number = 1 and max_number = numbered_count
                and nonpositive_count = 0)
          )::text as value,
          case when numbered_count = 0
            or (min_number = 1 and max_number = numbered_count
              and nonpositive_count = 0)
            then 'PASS' else 'FAIL' end as status,
          'current commercial numbers must be empty or continuous from 1'
            as detail
          from metrics
        $sql$
      ),
      (
        210, 'K', 'purchase_milestones_count',
        milestones_relation is not null,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'expected zero configured milestones during numbering cutover'
              as detail
          from public.purchase_milestones
        $sql$
      ),
      (
        220, 'L', 'purchase_milestone_rules_count',
        rules_relation is not null,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'expected zero milestone rules during numbering cutover'
              as detail
          from public.purchase_milestone_rules
        $sql$
      ),
      (
        230, 'M', 'purchase_milestone_awards_count',
        awards_relation is not null,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'expected zero awards during numbering cutover' as detail
          from public.purchase_milestone_awards
        $sql$
      ),
      (
        240, 'N', 'historical_queue_barrier',
        orders_relation is not null
          and array['orders.status', 'orders.purchase_number',
            'orders.purchase_queue_position'] <@ column_keys,
        $sql$
          with metrics as (
            select
              count(*) filter (where status = 'approved'
                and purchase_number is null
                and purchase_queue_position is null) as legacy_approved,
              count(*) filter (where purchase_queue_position is not null)
                as existing_queue_count,
              min(purchase_queue_position) as min_existing_queue
            from public.orders
          )
          select jsonb_build_object(
            'legacy_approved_without_queue', legacy_approved,
            'existing_queue_count', existing_queue_count,
            'min_existing_queue', min_existing_queue,
            'positions_are_after_historical_prefix',
              existing_queue_count = 0 or min_existing_queue > legacy_approved
          )::text as value,
          case when existing_queue_count = 0
            or min_existing_queue > legacy_approved then 'PASS' else 'FAIL' end
            as status,
          'existing queue positions must not precede the historical prefix'
            as detail
          from metrics
        $sql$
      ),
      (
        250, 'N', 'cutover_integrity_blockers',
        orders_relation is not null and customers_relation is not null
          and passes_relation is not null and jobs_relation is not null
          and array['orders.status', 'orders.approved_at', 'orders.customer_id',
            'orders.sgx_pass_id', 'orders.job_id', 'orders.purchase_number',
            'orders.purchase_queue_position', 'customers.id', 'sgx_passes.id',
            'sgx_passes.customer_id', 'jobs.id'] <@ column_keys,
        $sql$
          with metrics as (
            select
              count(*) filter (where o.status = 'approved'
                and o.approved_at is null) as approved_without_approved_at,
              count(*) filter (where o.status = 'approved'
                and (o.customer_id is null or c.id is null
                  or o.sgx_pass_id is null or p.id is null
                  or o.job_id is null or j.id is null)
              ) as approved_missing_identity_or_job,
              count(*) filter (where o.status = 'approved'
                and p.id is not null
                and p.customer_id is distinct from o.customer_id
              ) as approved_customer_pass_mismatch,
              count(*) filter (where o.status <> 'approved'
                and o.purchase_number is not null) as nonapproved_numbered,
              count(*) filter (where o.status <> 'approved'
                and o.purchase_queue_position is not null
                and o.purchase_number is null) as nonapproved_queued_unnumbered,
              count(*) filter (where o.purchase_number <= 0)
                as nonpositive_purchase_number,
              count(*) filter (where o.purchase_queue_position <= 0)
                as nonpositive_queue_position
            from public.orders o
            left join public.customers c on c.id = o.customer_id
            left join public.sgx_passes p on p.id = o.sgx_pass_id
            left join public.jobs j on j.id = o.job_id
          )
          select jsonb_build_object(
            'approved_without_approved_at', approved_without_approved_at,
            'approved_missing_identity_or_job', approved_missing_identity_or_job,
            'approved_customer_pass_mismatch', approved_customer_pass_mismatch,
            'nonapproved_numbered', nonapproved_numbered,
            'nonapproved_queued_unnumbered', nonapproved_queued_unnumbered,
            'nonpositive_purchase_number', nonpositive_purchase_number,
            'nonpositive_queue_position', nonpositive_queue_position
          )::text as value,
          case when approved_without_approved_at
              + approved_missing_identity_or_job
              + approved_customer_pass_mismatch
              + nonapproved_numbered
              + nonapproved_queued_unnumbered
              + nonpositive_purchase_number
              + nonpositive_queue_position = 0
            then 'PASS' else 'FAIL' end as status,
          'all Migration D and backfill integrity blockers must be zero'
            as detail
          from metrics
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
  select 10000 as sort_order, 'O'::text as section, 'blockers'::text as check_name,
    count(*) filter (where status in ('FAIL', 'SKIP'))::text as value,
    case when count(*) filter (where status in ('FAIL', 'SKIP')) = 0
      then 'PASS' else 'FAIL' end as status,
    'any FAIL or SKIP blocks the administrative cutover; INFO rows require review'
      as detail
  from results
)
select section, check_name, value, status, detail
from (select * from results union all select * from summary) all_results
order by sort_order, section, check_name;
