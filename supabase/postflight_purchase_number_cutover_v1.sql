-- SGODX PURCHASE NUMBER CUTOVER v1 - READ-ONLY POSTFLIGHT.
-- Run manually in the Supabase SQL Editor after the reviewed operation.
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
    'required_cutover_tables'::text as check_name,
    jsonb_build_object(
      'orders', orders_relation is not null,
      'customers', customers_relation is not null,
      'sgx_passes', passes_relation is not null,
      'jobs', jobs_relation is not null,
      'purchase_counter', counter_relation is not null,
      'purchase_milestones', milestones_relation is not null,
      'purchase_milestone_rules', rules_relation is not null,
      'purchase_milestone_awards', awards_relation is not null
    )::text as value,
    case when orders_relation is not null and customers_relation is not null
      and passes_relation is not null and jobs_relation is not null
      and counter_relation is not null and milestones_relation is not null
      and rules_relation is not null and awards_relation is not null
      then 'PASS' else 'SKIP' end as status,
    case when orders_relation is not null and customers_relation is not null
      and passes_relation is not null and jobs_relation is not null
      and counter_relation is not null and milestones_relation is not null
      and rules_relation is not null and awards_relation is not null
      then 'all cutover tables are present'
      else 'table_or_column_missing' end as detail
  from state

  union all
  select 20, 'A', 'migration_d_objects',
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
      when pg_catalog.to_regprocedure('public.guard_purchase_queue_v1()') is not null
        and pg_catalog.to_regprocedure('public.assign_purchase_number_v1(uuid)') is not null
        and exists (
          select 1 from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname = 'purchase_queue_position_v1_seq'
            and c.relkind = 'S'
        )
        and exists (
          select 1 from pg_catalog.pg_trigger t
          where t.tgrelid = orders_relation
            and t.tgname = 'orders_purchase_queue_guard_v1'
            and not t.tgisinternal
        )
      then 'PASS' else 'FAIL' end,
    case when orders_relation is null then 'table_or_column_missing'
      else 'Migration D queue and assignment objects remain present' end
  from state
),
check_specs as (
  select state.*, specs.sort_order, specs.section, specs.check_name,
    specs.can_run, specs.query_text
  from state
  cross join lateral (
    values
      (
        100, 'B', 'counter_live_and_synchronized',
        counter_relation is not null and orders_relation is not null
          and array['purchase_counter.id', 'purchase_counter.assignment_state',
            'purchase_counter.last_purchase_number', 'orders.purchase_number']
            <@ column_keys,
        $sql$
          with metrics as (
            select
              count(*) as counter_rows,
              bool_and(id = 1 and assignment_state = 'live') as singleton_live,
              max(last_purchase_number) as counter_last,
              (select coalesce(max(purchase_number), 0) from public.orders)
                as orders_max
            from public.purchase_counter
          )
          select jsonb_build_object(
            'counter_rows', counter_rows,
            'singleton_live', singleton_live,
            'last_purchase_number', counter_last::text,
            'max_order_purchase_number', orders_max::text,
            'synchronized', counter_rows = 1 and singleton_live
              and counter_last = orders_max
          )::text as value,
          case when counter_rows = 1 and singleton_live
            and counter_last = orders_max then 'PASS' else 'FAIL' end as status,
          'counter must be singleton, live and equal to max purchase_number'
            as detail
          from metrics
        $sql$
      ),
      (
        110, 'C', 'approved_orders_all_numbered',
        orders_relation is not null
          and array['orders.status', 'orders.purchase_number'] <@ column_keys,
        $sql$
          select jsonb_build_object(
            'approved', count(*),
            'approved_without_purchase_number', count(*) filter (
              where purchase_number is null)
          )::text as value,
          case when count(*) filter (where purchase_number is null) = 0
            then 'PASS' else 'FAIL' end as status,
          'every approved Order must have a commercial number' as detail
          from public.orders
          where status = 'approved'
        $sql$
      ),
      (
        120, 'D', 'approved_orders_all_positioned',
        orders_relation is not null
          and array['orders.status', 'orders.purchase_queue_position'] <@ column_keys,
        $sql$
          select jsonb_build_object(
            'approved', count(*),
            'approved_without_queue_position', count(*) filter (
              where purchase_queue_position is null)
          )::text as value,
          case when count(*) filter (where purchase_queue_position is null) = 0
            then 'PASS' else 'FAIL' end as status,
          'every approved Order must have a queue position' as detail
          from public.orders
          where status = 'approved'
        $sql$
      ),
      (
        130, 'E', 'purchase_number_duplicates',
        orders_relation is not null
          and array['orders.purchase_number'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'duplicate non-null commercial numbers must be zero' as detail
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
        140, 'E', 'purchase_queue_position_duplicates',
        orders_relation is not null
          and array['orders.purchase_queue_position'] <@ column_keys,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'duplicate non-null queue positions must be zero' as detail
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
        150, 'F', 'purchase_number_continuity',
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
            'continuous_1_to_N', numbered_count = 0
              or (min_number = 1 and max_number = numbered_count
                and nonpositive_count = 0)
          )::text as value,
          case when numbered_count = 0
            or (min_number = 1 and max_number = numbered_count
              and nonpositive_count = 0)
            then 'PASS' else 'FAIL' end as status,
          'commercial numbers must be continuous from 1 to N' as detail
          from metrics
        $sql$
      ),
      (
        160, 'G', 'queue_number_order_coherence',
        orders_relation is not null
          and array['orders.purchase_queue_position', 'orders.purchase_number']
            <@ column_keys,
        $sql$
          with ordered as (
            select purchase_queue_position, purchase_number,
              row_number() over (order by purchase_queue_position asc,
                purchase_number asc) as queue_rank,
              row_number() over (order by purchase_number asc,
                purchase_queue_position asc) as number_rank
            from public.orders
            where purchase_number is not null
          )
          select jsonb_build_object(
            'numbered_rows', count(*),
            'queue_min', min(purchase_queue_position)::text,
            'queue_max', max(purchase_queue_position)::text,
            'queue_and_number_order_match', coalesce(bool_and(
              queue_rank = number_rank), true)
          )::text as value,
          case when coalesce(bool_and(queue_rank = number_rank), true)
            then 'PASS' else 'FAIL' end as status,
          'commercial order must follow durable queue order; internal queue gaps may remain'
            as detail
          from ordered
        $sql$
      ),
      (
        170, 'G', 'latest_approved_order',
        orders_relation is not null
          and array['orders.id', 'orders.job_id', 'orders.status',
            'orders.approved_at', 'orders.purchase_queue_position',
            'orders.purchase_number'] <@ column_keys,
        $sql$
          select coalesce((
            select jsonb_build_object(
              'id', id::text,
              'job_id', job_id::text,
              'status', status,
              'approved_at', approved_at::text,
              'purchase_queue_position', purchase_queue_position::text,
              'purchase_number', purchase_number::text)
            from public.orders
            where status = 'approved'
            order by approved_at desc, id desc
            limit 1
          ), '{}'::jsonb)::text as value,
          'INFO' as status,
          'review the latest approved Order number against the demonstrated production ordering'
            as detail
        $sql$
      ),
      (
        180, 'H', 'lifecycle_and_integrity_blockers',
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
                and o.purchase_queue_position is not null)
                as nonapproved_queued,
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
            'nonapproved_queued', nonapproved_queued,
            'nonpositive_purchase_number', nonpositive_purchase_number,
            'nonpositive_queue_position', nonpositive_queue_position
          )::text as value,
          case when approved_without_approved_at
              + approved_missing_identity_or_job
              + approved_customer_pass_mismatch
              + nonapproved_numbered
              + nonapproved_queued
              + nonpositive_purchase_number
              + nonpositive_queue_position = 0
            then 'PASS' else 'FAIL' end as status,
          'all lifecycle and identity blockers must be zero' as detail
          from metrics
        $sql$
      ),
      (
        190, 'I', 'purchase_milestones_count',
        milestones_relation is not null,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'milestone table must remain empty during numbering stabilization'
              as detail
          from public.purchase_milestones
        $sql$
      ),
      (
        200, 'I', 'purchase_milestone_rules_count',
        rules_relation is not null,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'milestone rule table must remain empty during numbering stabilization'
              as detail
          from public.purchase_milestone_rules
        $sql$
      ),
      (
        210, 'I', 'purchase_milestone_awards_count',
        awards_relation is not null,
        $sql$
          select count(*)::text as value,
            case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
            'award table must remain empty during numbering stabilization'
              as detail
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
  select 10000 as sort_order, 'J'::text as section, 'blockers'::text as check_name,
    count(*) filter (where status in ('FAIL', 'SKIP'))::text as value,
    case when count(*) filter (where status in ('FAIL', 'SKIP')) = 0
      then 'PASS' else 'FAIL' end as status,
    'any FAIL or SKIP blocks acceptance of the postflight result'
      as detail
  from results
)
select section, check_name, value, status, detail
from (select * from results union all select * from summary) all_results
order by sort_order, section, check_name;
