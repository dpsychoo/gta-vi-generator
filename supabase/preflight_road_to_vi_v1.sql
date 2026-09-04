-- PROPOSED READ-ONLY PREFLIGHT: SGODX ROAD TO VI / EVENT SYSTEM v1.
-- Do not execute automatically and do not run against production in this phase.
-- This file contains catalog SELECTs, read-only dynamic SELECTs, and one
-- consolidated Results SELECT for the checks that were previously NOTICEs.

-- A. Detected version/schema.
select
  'A' as section,
  current_schema() as detected_schema,
  current_setting('server_version') as server_version,
  current_setting('server_version_num') as server_version_num;

-- A. Expected table presence.
select
  'A' as section,
  expected.table_name,
  case when to_regclass('public.' || expected.table_name) is null then 'missing' else 'present' end as status
from (values
  ('events'), ('event_entries'), ('customers'), ('sgx_passes'), ('orders'), ('jobs'),
  ('legal_acceptances'), ('event_rules')
) as expected(table_name)
order by expected.table_name;

select
  'A' as section,
  table_name,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'events', 'event_entries', 'customers', 'sgx_passes', 'orders', 'jobs',
    'legal_acceptances', 'event_rules'
  )
order by table_name, ordinal_position;

-- This explicitly exposes the PK/UNIQUE/FK/check definitions needed to review
-- the composite Customer/PASS FK and both entry idempotency keys.
select
  'A' as section,
  c.conname,
  c.conrelid::regclass as table_name,
  c.contype,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
where c.conrelid in (
  to_regclass('public.events'),
  to_regclass('public.event_entries'),
  to_regclass('public.customers'),
  to_regclass('public.sgx_passes'),
  to_regclass('public.orders'),
  to_regclass('public.jobs'),
  to_regclass('public.event_rules')
)
order by c.conrelid::regclass::text, c.conname;

select
  'A' as section,
  exists (
    select 1 from pg_constraint c
    where c.conrelid = to_regclass('public.sgx_passes')
      and c.contype = 'p'
      and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
  ) as sgx_passes_has_pk_id,
  exists (
    select 1 from pg_constraint c
    where c.conrelid = to_regclass('public.sgx_passes')
      and c.contype = 'u'
      and pg_get_constraintdef(c.oid) = 'UNIQUE (customer_id)'
  ) as sgx_passes_has_unique_customer_id,
  exists (
    select 1 from pg_constraint c
    where c.conrelid = to_regclass('public.sgx_passes')
      and c.contype = 'u'
      and pg_get_constraintdef(c.oid) = 'UNIQUE (id, customer_id)'
  ) as sgx_passes_has_unique_id_customer_id,
  exists (
    select 1 from pg_constraint c
    where c.conrelid = to_regclass('public.event_entries')
      and c.contype = 'u'
      and pg_get_constraintdef(c.oid) = 'UNIQUE (event_id, sgx_pass_id)'
  ) as event_entries_has_unique_event_pass,
  exists (
    select 1 from pg_class i
    join pg_namespace n on n.oid = i.relnamespace
    where n.nspname = 'public'
      and i.relname = 'event_entries_event_customer_key'
      and i.relkind = 'i'
  ) as event_entries_has_unique_event_customer;

select
  'A' as section,
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'events', 'event_entries', 'customers', 'sgx_passes', 'orders', 'jobs',
    'event_rules'
  )
order by tablename, indexname;

-- I. RLS state.
select
  'I' as section,
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  coalesce(policy_counts.policy_count, 0) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join (
  select polrelid, count(*)::bigint as policy_count
  from pg_policy
  group by polrelid
) policy_counts on policy_counts.polrelid = c.oid
where n.nspname = 'public'
  and c.relname in (
    'events', 'event_entries', 'customers', 'sgx_passes', 'orders', 'jobs',
    'legal_acceptances', 'event_rules'
  )
order by c.relname;

-- I. Policy definitions.
select
  'I' as section,
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'events', 'event_entries', 'customers', 'sgx_passes', 'orders', 'jobs',
    'legal_acceptances', 'event_rules'
  )
order by tablename, policyname;

-- Output map: A schema/version, B events, C event_entries, D customers,
-- E SGX PASS, F orders/jobs, G duplicates, H integrity, I RLS/policies,
-- J Customer Auth delegated to its own preflight, K anomalies/blockers.
select section, output_scope
from (values
  ('A', 'detected version, schema, tables, columns, constraints, indexes'),
  ('B', 'events and event lifecycle status counts'),
  ('C', 'event_entries and entry status counts'),
  ('D', 'customers and approved-order customer integrity'),
  ('E', 'sgx_passes and current valid participant aggregate'),
  ('F', 'orders/jobs and approved purchase integrity'),
  ('G', 'duplicate slugs and duplicate entry keys'),
  ('H', 'Customer/PASS integrity and orphan checks'),
  ('I', 'RLS and policies'),
  ('J', 'Customer Auth delegated to preflight_customer_auth_core_v1.sql'),
  ('K', 'anomalies and blockers requiring review')
) as output_sections(section, output_scope)
order by section;

-- B-K. Consolidated Results output. query_to_xml is used only as a
-- read-only bridge for dynamic SELECT text, because static SQL cannot parse a
-- relation or column that is not present. Missing prerequisites are guarded
-- before query_to_xml is evaluated and become SKIP rows.
with
catalog as (
  select
    to_regclass('public.events') as events_relation,
    to_regclass('public.event_entries') as entries_relation,
    to_regclass('public.customers') as customers_relation,
    to_regclass('public.sgx_passes') as passes_relation,
    to_regclass('public.orders') as orders_relation,
    to_regclass('public.jobs') as jobs_relation,
    to_regclass('public.event_rules') as rules_relation
),
available_columns as (
  select coalesce(
    array_agg(table_name || '.' || column_name order by table_name, ordinal_position),
    array[]::text[]
  ) as column_keys
  from information_schema.columns
  where table_schema = 'public'
    and table_name in (
      'events', 'event_entries', 'customers', 'sgx_passes', 'orders', 'jobs',
      'event_rules'
    )
),
state as (
  select catalog.*, available_columns.column_keys
  from catalog
  cross join available_columns
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
        10,
        'G',
        'event_slug_duplicates',
        state.events_relation is not null
          and 'events.slug' = any(state.column_keys),
        'table_or_column_missing',
        case when state.events_relation is not null
          and 'events.slug' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'duplicate event slugs' as detail
            from (
              select slug
              from %s
              group by slug
              having count(*) > 1
            ) duplicate_slugs
          $sql$, state.events_relation) end
      ),
      (
        20,
        'B',
        'events_status_counts',
        state.events_relation is not null
          and 'events.status' = any(state.column_keys),
        'table_or_column_missing',
        case when state.events_relation is not null
          and 'events.status' = any(state.column_keys) then format($sql$
            select
              coalesce(jsonb_object_agg(status, total), '{}'::jsonb)::text as value,
              'INFO' as status,
              'event lifecycle status counts' as detail
            from (
              select status, count(*)::bigint as total
              from %s
              group by status
              order by status
            ) grouped_statuses
          $sql$, state.events_relation) end
      ),
      (
        30,
        'C',
        'event_entries_status_counts',
        state.entries_relation is not null
          and 'event_entries.status' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and 'event_entries.status' = any(state.column_keys) then format($sql$
            select
              coalesce(jsonb_object_agg(status, total), '{}'::jsonb)::text as value,
              'INFO' as status,
              'event entry status counts' as detail
            from (
              select status, count(*)::bigint as total
              from %s
              group by status
              order by status
            ) grouped_statuses
          $sql$, state.entries_relation) end
      ),
      (
        40,
        'G',
        'duplicates_event_customer',
        state.entries_relation is not null
          and 'event_entries.event_id' = any(state.column_keys)
          and 'event_entries.customer_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and 'event_entries.event_id' = any(state.column_keys)
          and 'event_entries.customer_id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'duplicate event/customer groups; excess_rows=' || coalesce(sum(row_count - 1), 0)::text as detail
            from (
              select event_id, customer_id, count(*)::bigint as row_count
              from %s
              group by event_id, customer_id
              having count(*) > 1
            ) duplicate_groups
          $sql$, state.entries_relation) end
      ),
      (
        50,
        'G',
        'duplicates_event_pass',
        state.entries_relation is not null
          and 'event_entries.event_id' = any(state.column_keys)
          and 'event_entries.sgx_pass_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and 'event_entries.event_id' = any(state.column_keys)
          and 'event_entries.sgx_pass_id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'duplicate event/PASS groups' as detail
            from (
              select event_id, sgx_pass_id
              from %s
              group by event_id, sgx_pass_id
              having count(*) > 1
            ) duplicate_groups
          $sql$, state.entries_relation) end
      ),
      (
        60,
        'H',
        'entry_pass_customer_mismatches',
        state.entries_relation is not null
          and state.passes_relation is not null
          and 'event_entries.sgx_pass_id' = any(state.column_keys)
          and 'event_entries.customer_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys)
          and 'sgx_passes.customer_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and state.passes_relation is not null
          and 'event_entries.sgx_pass_id' = any(state.column_keys)
          and 'event_entries.customer_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys)
          and 'sgx_passes.customer_id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'entry customer differs from PASS customer' as detail
            from %s entries
            join %s passes on passes.id = entries.sgx_pass_id
            where passes.customer_id <> entries.customer_id
          $sql$, state.entries_relation, state.passes_relation) end
      ),
      (
        70,
        'H',
        'entry_event_orphans',
        state.entries_relation is not null
          and state.events_relation is not null
          and 'event_entries.event_id' = any(state.column_keys)
          and 'events.id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and state.events_relation is not null
          and 'event_entries.event_id' = any(state.column_keys)
          and 'events.id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'entries without an event' as detail
            from %s entries
            left join %s events on events.id = entries.event_id
            where events.id is null
          $sql$, state.entries_relation, state.events_relation) end
      ),
      (
        80,
        'H',
        'entry_customer_orphans',
        state.entries_relation is not null
          and state.customers_relation is not null
          and 'event_entries.customer_id' = any(state.column_keys)
          and 'customers.id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and state.customers_relation is not null
          and 'event_entries.customer_id' = any(state.column_keys)
          and 'customers.id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'entries without a customer' as detail
            from %s entries
            left join %s customers on customers.id = entries.customer_id
            where customers.id is null
          $sql$, state.entries_relation, state.customers_relation) end
      ),
      (
        90,
        'H',
        'entry_pass_orphans',
        state.entries_relation is not null
          and state.passes_relation is not null
          and 'event_entries.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and state.passes_relation is not null
          and 'event_entries.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'entries without a PASS' as detail
            from %s entries
            left join %s passes on passes.id = entries.sgx_pass_id
            where passes.id is null
          $sql$, state.entries_relation, state.passes_relation) end
      ),
      (
        100,
        'K',
        'event_rules_pointer_checks',
        state.events_relation is not null
          and state.rules_relation is not null
          and 'events.id' = any(state.column_keys)
          and 'events.rules_version' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys)
          and 'event_rules.version' = any(state.column_keys),
        'table_or_column_missing',
        case when state.events_relation is not null
          and state.rules_relation is not null
          and 'events.id' = any(state.column_keys)
          and 'events.rules_version' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys)
          and 'event_rules.version' = any(state.column_keys) then
          'select ''available'' as value, ''INFO'' as status, ''pointer component checks are reported below'' as detail'
        end
      ),
      (
        110,
        'K',
        'event_rules_missing_pointer',
        state.events_relation is not null
          and state.rules_relation is not null
          and 'events.id' = any(state.column_keys)
          and 'events.rules_version' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys)
          and 'event_rules.version' = any(state.column_keys),
        'table_or_column_missing',
        case when state.events_relation is not null
          and state.rules_relation is not null
          and 'events.id' = any(state.column_keys)
          and 'events.rules_version' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys)
          and 'event_rules.version' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'events whose configured rules pointer has no matching rule row' as detail
            from %s events
            left join %s rules
              on rules.event_id = events.id
             and rules.version = events.rules_version
            where events.rules_version is not null
              and rules.event_id is null
          $sql$, state.events_relation, state.rules_relation) end
      ),
      (
        120,
        'K',
        'event_rules_unpublished_pointer',
        state.events_relation is not null
          and state.rules_relation is not null
          and 'events.id' = any(state.column_keys)
          and 'events.rules_version' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys)
          and 'event_rules.version' = any(state.column_keys)
          and 'event_rules.published_at' = any(state.column_keys),
        case when not ('event_rules.published_at' = any(state.column_keys))
          then 'published_at_column_missing' else 'table_or_column_missing' end,
        case when state.events_relation is not null
          and state.rules_relation is not null
          and 'events.id' = any(state.column_keys)
          and 'events.rules_version' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys)
          and 'event_rules.version' = any(state.column_keys)
          and 'event_rules.published_at' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'matching event rule rows without published_at' as detail
            from %s events
            join %s rules
              on rules.event_id = events.id
             and rules.version = events.rules_version
            where events.rules_version is not null
              and rules.published_at is null
          $sql$, state.events_relation, state.rules_relation) end
      ),
      (
        130,
        'K',
        'event_rules_orphans',
        state.events_relation is not null
          and state.rules_relation is not null
          and 'events.id' = any(state.column_keys)
          and 'event_rules.id' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.events_relation is not null
          and state.rules_relation is not null
          and 'events.id' = any(state.column_keys)
          and 'event_rules.id' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'rule rows without an event' as detail
            from %s rules
            left join %s events on events.id = rules.event_id
            where events.id is null
          $sql$, state.rules_relation, state.events_relation) end
      ),
      (
        140,
        'K',
        'entry_rules_missing_row',
        state.entries_relation is not null
          and state.rules_relation is not null
          and 'event_entries.event_id' = any(state.column_keys)
          and 'event_entries.rules_version' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys)
          and 'event_rules.version' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and state.rules_relation is not null
          and 'event_entries.event_id' = any(state.column_keys)
          and 'event_entries.rules_version' = any(state.column_keys)
          and 'event_rules.event_id' = any(state.column_keys)
          and 'event_rules.version' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'entries whose rules_version has no matching rule row' as detail
            from %s entries
            left join %s rules
              on rules.event_id = entries.event_id
             and rules.version = entries.rules_version
            where entries.rules_version is not null
              and rules.event_id is null
          $sql$, state.entries_relation, state.rules_relation) end
      ),
      (
        150,
        'D',
        'approved_orders_without_customer',
        state.orders_relation is not null
          and state.customers_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.customer_id' = any(state.column_keys)
          and 'customers.id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and state.customers_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.customer_id' = any(state.column_keys)
          and 'customers.id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'approved orders without a customer' as detail
            from %s orders
            left join %s customers on customers.id = orders.customer_id
            where orders.status = 'approved'
              and customers.id is null
          $sql$, state.orders_relation, state.customers_relation) end
      ),
      (
        160,
        'E',
        'approved_orders_without_pass',
        state.orders_relation is not null
          and state.passes_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and state.passes_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'approved orders without a PASS' as detail
            from %s orders
            left join %s passes on passes.id = orders.sgx_pass_id
            where orders.status = 'approved'
              and passes.id is null
          $sql$, state.orders_relation, state.passes_relation) end
      ),
      (
        170,
        'F',
        'approved_orders_without_approved_at',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.approved_at' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.approved_at' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'approved orders without approved_at' as detail
            from %s orders
            where orders.status = 'approved'
              and orders.approved_at is null
          $sql$, state.orders_relation) end
      ),
      (
        180,
        'F',
        'orders_without_job',
        state.orders_relation is not null
          and state.jobs_relation is not null
          and 'orders.job_id' = any(state.column_keys)
          and 'jobs.id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and state.jobs_relation is not null
          and 'orders.job_id' = any(state.column_keys)
          and 'jobs.id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'orders without a matching job' as detail
            from %s orders
            left join %s jobs on jobs.id = orders.job_id
            where jobs.id is null
          $sql$, state.orders_relation, state.jobs_relation) end
      ),
      (
        240,
        'E',
        'participant_count_current_valid',
        state.entries_relation is not null
          and state.passes_relation is not null
          and 'event_entries.status' = any(state.column_keys)
          and 'event_entries.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys)
          and 'sgx_passes.status' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and state.passes_relation is not null
          and 'event_entries.status' = any(state.column_keys)
          and 'event_entries.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys)
          and 'sgx_passes.status' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              'INFO' as status,
              'entered or locked entries joined to active PASSes' as detail
            from %s entries
            join %s passes on passes.id = entries.sgx_pass_id
            where entries.status in ('entered', 'locked')
              and passes.status = 'active'
          $sql$, state.entries_relation, state.passes_relation) end
      ),
      (
        250,
        'E',
        'participant_count_excluded_inactive_pass',
        state.entries_relation is not null
          and state.passes_relation is not null
          and 'event_entries.status' = any(state.column_keys)
          and 'event_entries.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys)
          and 'sgx_passes.status' = any(state.column_keys),
        'table_or_column_missing',
        case when state.entries_relation is not null
          and state.passes_relation is not null
          and 'event_entries.status' = any(state.column_keys)
          and 'event_entries.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys)
          and 'sgx_passes.status' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              'INFO' as status,
              'entered or locked entries joined to non-active PASSes' as detail
            from %s entries
            join %s passes on passes.id = entries.sgx_pass_id
            where entries.status in ('entered', 'locked')
              and passes.status <> 'active'
          $sql$, state.entries_relation, state.passes_relation) end
      )
  ) as specs(sort_order, section, check_name, can_run, missing_detail, query_text)
),
raw_results as (
  select
    check_specs.*,
    case when can_run then query_to_xml(query_text, true, false, '') end as result_xml
  from check_specs
),
evaluated as (
  select
    sort_order,
    section,
    check_name,
    case when can_run then (xpath('string(/table/row/value)', result_xml))[1]::text end as value,
    case when can_run then coalesce((xpath('string(/table/row/status)', result_xml))[1]::text, 'INFO') else 'SKIP' end as status,
    case when can_run then coalesce((xpath('string(/table/row/detail)', result_xml))[1]::text, 'read-only check') else missing_detail end as detail
  from raw_results
),
blocker_candidates as (
  select *
  from evaluated
  where check_name in (
    'event_slug_duplicates',
    'duplicates_event_customer',
    'duplicates_event_pass',
    'entry_pass_customer_mismatches',
    'entry_event_orphans',
    'entry_customer_orphans',
    'entry_pass_orphans',
    'event_rules_missing_pointer',
    'event_rules_unpublished_pointer',
    'event_rules_orphans',
    'entry_rules_missing_row',
    'approved_orders_without_customer',
    'approved_orders_without_pass',
    'approved_orders_without_approved_at',
    'orders_without_job'
  )
),
blocker_summary as (
  select
    999 as sort_order,
    'K'::text as section,
    'blockers'::text as check_name,
    count(*) filter (where status = 'FAIL')::text as value,
    case
      when count(*) filter (where status = 'FAIL') > 0 then 'FAIL'
      when count(*) filter (where status = 'SKIP') = count(*) then 'SKIP'
      else 'PASS'
    end as status,
    case
      when count(*) filter (where status = 'FAIL') > 0 then
        'failing_checks=' || string_agg(check_name, ', ' order by check_name) filter (where status = 'FAIL')
      when count(*) filter (where status = 'SKIP') > 0 then
        'no failing checks; skipped checks require schema review'
      else
        'no blocking integrity anomalies'
    end as detail
  from blocker_candidates
)
select section, check_name, value, status, detail
from (
  select sort_order, section, check_name, value, status, detail
  from evaluated
  union all
  select sort_order, section, check_name, value, status, detail
  from blocker_summary
) results
order by sort_order;
