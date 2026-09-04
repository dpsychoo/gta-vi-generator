-- SGODX ROAD TO VI EVENT SYSTEM v1 - PROPOSED READ-ONLY POSTFLIGHT.
-- Run only after Migration B in an approved window. This file only inspects
-- catalog metadata and returns one Results-compatible table.

with
expected_tables(table_name) as (
  values
    ('events'),
    ('event_entries'),
    ('event_rules')
),
expected_columns(table_name, column_name) as (
  values
    ('events', 'description'),
    ('events', 'entry_starts_at'),
    ('events', 'entry_ends_at'),
    ('events', 'rules_version'),
    ('events', 'updated_at'),
    ('event_entries', 'rules_version'),
    ('event_entries', 'rules_accepted_at'),
    ('event_entries', 'updated_at'),
    ('event_rules', 'id'),
    ('event_rules', 'event_id'),
    ('event_rules', 'version'),
    ('event_rules', 'title'),
    ('event_rules', 'content'),
    ('event_rules', 'content_hash'),
    ('event_rules', 'published_at'),
    ('event_rules', 'created_at')
),
expected_constraints(table_name, constraint_name) as (
  values
    ('events', 'events_entry_dates_check'),
    ('events', 'events_rules_version_fkey'),
    ('event_rules', 'event_rules_event_version_key'),
    ('event_rules', 'event_rules_content_check'),
    ('event_entries', 'event_entries_rules_acceptance_check'),
    ('event_entries', 'event_entries_rules_version_fkey'),
    ('sgx_passes', 'sgx_passes_id_customer_id_key'),
    ('event_entries', 'event_entries_pass_customer_fkey')
),
expected_indexes(table_name, index_name) as (
  values
    ('event_rules', 'event_rules_event_published_idx'),
    ('event_entries', 'event_entries_event_customer_key')
),
table_checks as (
  select
    'B'::text as section,
    'road_tables_present'::text as check_name,
    jsonb_object_agg(table_name, to_regclass('public.' || table_name) is not null)::text as value,
    case when bool_and(to_regclass('public.' || table_name) is not null) then 'PASS' else 'SKIP' end as status,
    case when bool_and(to_regclass('public.' || table_name) is not null)
      then 'Road to VI event ownership' else 'table_or_column_missing' end::text as detail
  from expected_tables
),
column_checks as (
  select
    'B'::text as section,
    'road_required_columns'::text as check_name,
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
    )::text as value,
    case when bool_and(exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = expected_columns.table_name
        and c.column_name = expected_columns.column_name
    )) then 'PASS' else 'SKIP' end as status,
    case when bool_and(exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = expected_columns.table_name
        and c.column_name = expected_columns.column_name
    )) then 'event windows, versioned rules, and entry acceptance fields'
    else 'table_or_column_missing' end::text as detail
  from expected_columns
),
constraint_checks as (
  select
    'B'::text as section,
    'road_constraints'::text as check_name,
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
    )::text as value,
    case
      when not bool_and(to_regclass('public.' || expected_constraints.table_name) is not null)
        then 'SKIP'
      when bool_and(exists (
      select 1
      from pg_constraint c
      where c.conrelid = to_regclass('public.' || expected_constraints.table_name)
        and c.conname = expected_constraints.constraint_name
    )) then 'PASS' else 'FAIL'
    end as status,
    case when not bool_and(to_regclass('public.' || expected_constraints.table_name) is not null)
      then 'table_or_column_missing'
      else 'window, rules pointer, Customer/PASS, and entry idempotency constraints' end::text as detail
  from expected_constraints
),
index_checks as (
  select
    'B'::text as section,
    'road_indexes'::text as check_name,
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
    )::text as value,
    case
      when not bool_and(to_regclass('public.' || expected_indexes.table_name) is not null)
        then 'SKIP'
      when bool_and(exists (
      select 1
      from pg_indexes i
      where i.schemaname = 'public'
        and i.tablename = expected_indexes.table_name
        and i.indexname = expected_indexes.index_name
    )) then 'PASS' else 'FAIL'
    end as status,
    case when not bool_and(to_regclass('public.' || expected_indexes.table_name) is not null)
      then 'table_or_column_missing'
      else 'rules lookup and Customer-level entry idempotency indexes' end::text as detail
  from expected_indexes
),
rls_checks as (
  select
    'B'::text as section,
    'road_rls_enabled'::text as check_name,
    jsonb_object_agg(
      expected_tables.table_name,
      coalesce(c.relrowsecurity, false)
    )::text as value,
    case
      when not bool_and(c.oid is not null) then 'SKIP'
      when bool_and(coalesce(c.relrowsecurity, false)) then 'PASS'
      else 'FAIL'
    end as status,
    case when not bool_and(c.oid is not null)
      then 'table_or_column_missing'
      else 'event data and rules are not publicly writable' end::text as detail
  from expected_tables
  left join pg_class c on c.oid = to_regclass('public.' || expected_tables.table_name)
),
results as (
  select * from table_checks
  union all select * from column_checks
  union all select * from constraint_checks
  union all select * from index_checks
  union all select * from rls_checks
)
select section, check_name, value, status, detail
from results
order by check_name;
