-- SGODX PURCHASE MILESTONES v1 - PROPOSED READ-ONLY POSTFLIGHT.
-- Run only after Migration C in an approved window. This file only inspects
-- catalog metadata and current rows and returns one Results-compatible table.
-- A successful additive postflight expects no milestone or award seed rows.

with
catalog as (
  select
    to_regclass('public.orders') as orders_relation,
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
      'orders', 'purchase_counter', 'purchase_milestones',
      'purchase_milestone_rules', 'purchase_milestone_awards'
    )
),
state as (
  select catalog.*, available_columns.column_keys
  from catalog
  cross join available_columns
),
expected_tables(table_name) as (
  values
    ('orders'),
    ('purchase_counter'),
    ('purchase_milestones'),
    ('purchase_milestone_rules'),
    ('purchase_milestone_awards')
),
expected_columns(table_name, column_name) as (
  values
    ('orders', 'purchase_number'),
    ('purchase_counter', 'id'),
    ('purchase_counter', 'last_purchase_number'),
    ('purchase_counter', 'assignment_state'),
    ('purchase_counter', 'created_at'),
    ('purchase_counter', 'updated_at'),
    ('purchase_milestones', 'id'),
    ('purchase_milestones', 'purchase_number'),
    ('purchase_milestones', 'name'),
    ('purchase_milestones', 'reward_type'),
    ('purchase_milestones', 'reward_amount'),
    ('purchase_milestones', 'reward_currency'),
    ('purchase_milestones', 'status'),
    ('purchase_milestones', 'rules_version'),
    ('purchase_milestones', 'starts_at'),
    ('purchase_milestones', 'ends_at'),
    ('purchase_milestones', 'created_at'),
    ('purchase_milestones', 'updated_at'),
    ('purchase_milestone_rules', 'id'),
    ('purchase_milestone_rules', 'milestone_id'),
    ('purchase_milestone_rules', 'version'),
    ('purchase_milestone_rules', 'title'),
    ('purchase_milestone_rules', 'content'),
    ('purchase_milestone_rules', 'content_hash'),
    ('purchase_milestone_rules', 'published_at'),
    ('purchase_milestone_rules', 'created_at'),
    ('purchase_milestone_awards', 'id'),
    ('purchase_milestone_awards', 'milestone_id'),
    ('purchase_milestone_awards', 'order_id'),
    ('purchase_milestone_awards', 'customer_id'),
    ('purchase_milestone_awards', 'sgx_pass_id'),
    ('purchase_milestone_awards', 'purchase_number'),
    ('purchase_milestone_awards', 'milestone_name'),
    ('purchase_milestone_awards', 'reward_type'),
    ('purchase_milestone_awards', 'reward_amount'),
    ('purchase_milestone_awards', 'reward_currency'),
    ('purchase_milestone_awards', 'rules_version'),
    ('purchase_milestone_awards', 'claim_rules_version'),
    ('purchase_milestone_awards', 'awarded_at'),
    ('purchase_milestone_awards', 'claim_status'),
    ('purchase_milestone_awards', 'claimed_at'),
    ('purchase_milestone_awards', 'verified_at'),
    ('purchase_milestone_awards', 'voided_at'),
    ('purchase_milestone_awards', 'void_reason'),
    ('purchase_milestone_awards', 'created_at'),
    ('purchase_milestone_awards', 'updated_at')
),
expected_constraints(table_name, constraint_name) as (
  values
    ('orders', 'orders_purchase_number_positive_check'),
    ('orders', 'orders_identity_purchase_number_key'),
    ('purchase_counter', 'purchase_counter_singleton_check'),
    ('purchase_counter', 'purchase_counter_number_check'),
    ('purchase_counter', 'purchase_counter_state_check'),
    ('purchase_milestones', 'purchase_milestones_number_key'),
    ('purchase_milestones', 'purchase_milestones_number_check'),
    ('purchase_milestones', 'purchase_milestones_name_check'),
    ('purchase_milestones', 'purchase_milestones_reward_amount_check'),
    ('purchase_milestones', 'purchase_milestones_reward_currency_check'),
    ('purchase_milestones', 'purchase_milestones_status_check'),
    ('purchase_milestones', 'purchase_milestones_dates_check'),
    ('purchase_milestone_rules', 'purchase_milestone_rules_version_key'),
    ('purchase_milestone_rules', 'purchase_milestone_rules_content_check'),
    ('purchase_milestones', 'purchase_milestones_rules_pointer_fkey'),
    ('purchase_milestone_awards', 'purchase_milestone_awards_milestone_key'),
    ('purchase_milestone_awards', 'purchase_milestone_awards_claim_status_check'),
    ('purchase_milestone_awards', 'purchase_milestone_awards_number_fkey'),
    ('purchase_milestone_awards', 'purchase_milestone_awards_rules_fkey'),
    ('purchase_milestone_awards', 'purchase_milestone_awards_claim_rules_fkey'),
    ('purchase_milestone_awards', 'purchase_milestone_awards_order_snapshot_fkey')
),
expected_indexes(table_name, index_name) as (
  values
    ('orders', 'orders_purchase_number_key'),
    ('purchase_milestones', 'purchase_milestones_id_number_key'),
    ('purchase_milestone_rules', 'purchase_milestone_rules_published_idx'),
    ('purchase_milestone_awards', 'purchase_milestone_awards_customer_status_idx'),
    ('purchase_milestone_awards', 'purchase_milestone_awards_order_idx')
),
static_results as (
  select
    10 as sort_order,
    'A'::text as section,
    'purchase_milestone_tables_present'::text as check_name,
    jsonb_object_agg(
      expected_tables.table_name,
      to_regclass('public.' || expected_tables.table_name) is not null
    )::text as value,
    case when bool_and(to_regclass('public.' || expected_tables.table_name) is not null)
      then 'PASS' else 'SKIP' end as status,
    case when bool_and(to_regclass('public.' || expected_tables.table_name) is not null)
      then 'Migration C table ownership'
      else 'table_or_column_missing' end as detail
  from expected_tables

  union all

  select
    20,
    'A',
    'purchase_milestone_required_columns',
    jsonb_agg(
      jsonb_build_object(
        'table', expected_columns.table_name,
        'column', expected_columns.column_name,
        'present', exists (
          select 1
          from information_schema.columns c
          where c.table_schema = 'public'
            and c.table_name = expected_columns.table_name
            and c.column_name = expected_columns.column_name
        )
      )
      order by expected_columns.table_name, expected_columns.column_name
    )::text,
    case when bool_and(exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = expected_columns.table_name
        and c.column_name = expected_columns.column_name
    )) then 'PASS' else 'SKIP' end,
    case when bool_and(exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = expected_columns.table_name
        and c.column_name = expected_columns.column_name
    )) then 'purchase number, counter, rule, award, and claim fields'
    else 'table_or_column_missing' end
  from expected_columns

  union all

  select
    30,
    'A',
    'purchase_milestone_constraints',
    jsonb_agg(
      jsonb_build_object(
        'table', expected_constraints.table_name,
        'constraint', expected_constraints.constraint_name,
        'present', exists (
          select 1
          from pg_constraint c
          where c.conrelid = to_regclass('public.' || expected_constraints.table_name)
            and c.conname = expected_constraints.constraint_name
        )
      )
      order by expected_constraints.table_name, expected_constraints.constraint_name
    )::text,
    case
      when not bool_and(to_regclass('public.' || expected_constraints.table_name) is not null)
        then 'SKIP'
      when bool_and(exists (
        select 1
        from pg_constraint c
        where c.conrelid = to_regclass('public.' || expected_constraints.table_name)
          and c.conname = expected_constraints.constraint_name
      )) then 'PASS'
      else 'FAIL'
    end,
    case
      when not bool_and(to_regclass('public.' || expected_constraints.table_name) is not null)
        then 'table_or_column_missing'
      else 'positive number, singleton counter, versioned rules, and award integrity constraints'
    end
  from expected_constraints

  union all

  select
    40,
    'A',
    'purchase_milestone_indexes',
    jsonb_agg(
      jsonb_build_object(
        'table', expected_indexes.table_name,
        'index', expected_indexes.index_name,
        'present', exists (
          select 1
          from pg_indexes i
          where i.schemaname = 'public'
            and i.tablename = expected_indexes.table_name
            and i.indexname = expected_indexes.index_name
        )
      )
      order by expected_indexes.table_name, expected_indexes.index_name
    )::text,
    case
      when not bool_and(to_regclass('public.' || expected_indexes.table_name) is not null)
        then 'SKIP'
      when bool_and(exists (
        select 1
        from pg_indexes i
        where i.schemaname = 'public'
          and i.tablename = expected_indexes.table_name
          and i.indexname = expected_indexes.index_name
      )) then 'PASS'
      else 'FAIL'
    end,
    case
      when not bool_and(to_regclass('public.' || expected_indexes.table_name) is not null)
        then 'table_or_column_missing'
      else 'unique order number and lookup indexes'
    end
  from expected_indexes

  union all

  select
    50,
    'A',
    'purchase_milestone_rls_enabled',
    jsonb_object_agg(
      expected_tables.table_name,
      coalesce(c.relrowsecurity, false)
    )::text as value,
    case
      when not bool_and(c.oid is not null) then 'SKIP'
      when bool_and(coalesce(c.relrowsecurity, false)) then 'PASS'
      else 'FAIL'
    end,
    case when not bool_and(c.oid is not null)
      then 'table_or_column_missing'
      else 'counter, milestone, rule, and award tables are not publicly writable' end
  from expected_tables
  left join pg_class c on c.oid = to_regclass('public.' || expected_tables.table_name)
),
check_specs as (
  select
    state.*,
    specs.sort_order,
    specs.section,
    specs.check_name,
    specs.can_run,
    specs.missing_detail,
    specs.query_text
  from state
  cross join lateral (
    values
      (
        100,
        'B',
        'purchase_counter_bootstrap_state',
        state.counter_relation is not null
          and 'purchase_counter.id' = any(state.column_keys)
          and 'purchase_counter.last_purchase_number' = any(state.column_keys)
          and 'purchase_counter.assignment_state' = any(state.column_keys),
        'table_or_column_missing',
        case when state.counter_relation is not null
          and 'purchase_counter.id' = any(state.column_keys)
          and 'purchase_counter.last_purchase_number' = any(state.column_keys)
          and 'purchase_counter.assignment_state' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 1 then 'PASS' else 'FAIL' end as status,
              'Migration C bootstrap row id=1, number=0, state=paused; backfill changes this intentionally' as detail
            from %s
            where id = 1
              and last_purchase_number = 0
              and assignment_state = 'paused'
          $sql$, state.counter_relation) end
      ),
      (
        110,
        'B',
        'purchase_milestone_seed_rows',
        state.milestones_relation is not null
          and state.awards_relation is not null,
        'table_or_column_missing',
        case when state.milestones_relation is not null
          and state.awards_relation is not null then format($sql$
            select
              jsonb_build_object(
                'milestones', (select count(*) from %s),
                'awards', (select count(*) from %s)
              )::text as value,
              case when (select count(*) from %s) = 0
                and (select count(*) from %s) = 0 then 'PASS' else 'INFO' end as status,
              'Migration C must not seed real milestone or award rows' as detail
          $sql$, state.milestones_relation, state.awards_relation,
            state.milestones_relation, state.awards_relation) end
      ),
      (
        120,
        'B',
        'orders_purchase_number_population',
        state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys)
          and 'orders.status' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys)
          and 'orders.status' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'approved_total', count(*) filter (where status = 'approved'),
                'approved_numbered', count(*) filter (where status = 'approved' and purchase_number is not null),
                'approved_without_number', count(*) filter (where status = 'approved' and purchase_number is null),
                'all_numbered', count(*) filter (where purchase_number is not null)
              )::text as value,
              'INFO' as status,
              'number assignment and historical backfill are separate reviewed operations' as detail
            from %s
          $sql$, state.orders_relation) end
      ),
      (
        130,
        'B',
        'purchase_number_duplicates',
        state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'duplicate non-null purchase numbers' as detail
            from (
              select purchase_number
              from %s
              where purchase_number is not null
              group by purchase_number
              having count(*) > 1
            ) duplicates
          $sql$, state.orders_relation) end
      )
  ) as specs(sort_order, section, check_name, can_run, missing_detail, query_text)
),
raw_results as (
  select
    check_specs.*,
    case when can_run then query_to_xml(query_text, true, false, '') end as result_xml
  from check_specs
),
dynamic_results as (
  select
    sort_order,
    section,
    check_name,
    case when can_run then (xpath('string(/table/row/value)', result_xml))[1]::text end as value,
    case when can_run then coalesce((xpath('string(/table/row/status)', result_xml))[1]::text, 'INFO')
      else 'SKIP' end as status,
    case when can_run then coalesce((xpath('string(/table/row/detail)', result_xml))[1]::text, 'read-only check')
      else missing_detail end as detail
  from raw_results
),
results as (
  select sort_order, section, check_name, value, status, detail
  from static_results
  union all
  select sort_order, section, check_name, value, status, detail
  from dynamic_results
)
select section, check_name, value, status, detail
from results
order by sort_order, section, check_name;
