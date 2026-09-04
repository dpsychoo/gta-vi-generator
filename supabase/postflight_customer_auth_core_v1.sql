-- SGODX CUSTOMER AUTH CORE v1 - PROPOSED READ-ONLY POSTFLIGHT.
-- Run only after Migration A in an approved window. This file only inspects
-- catalog metadata and returns one Results-compatible table.

with
expected_tables(table_name) as (
  values
    ('customer_auth_tokens'),
    ('customer_sessions'),
    ('customer_auth_rate_limits')
),
expected_columns(table_name, column_name) as (
  values
    ('customer_auth_tokens', 'id'),
    ('customer_auth_tokens', 'customer_id'),
    ('customer_auth_tokens', 'token_hash'),
    ('customer_auth_tokens', 'purpose'),
    ('customer_auth_tokens', 'expires_at'),
    ('customer_auth_tokens', 'used_at'),
    ('customer_auth_tokens', 'created_at'),
    ('customer_sessions', 'id'),
    ('customer_sessions', 'customer_id'),
    ('customer_sessions', 'session_token_hash'),
    ('customer_sessions', 'expires_at'),
    ('customer_sessions', 'revoked_at'),
    ('customer_sessions', 'created_at'),
    ('customer_sessions', 'last_seen_at'),
    ('customer_auth_rate_limits', 'id'),
    ('customer_auth_rate_limits', 'scope'),
    ('customer_auth_rate_limits', 'key_hash'),
    ('customer_auth_rate_limits', 'window_started_at'),
    ('customer_auth_rate_limits', 'request_count'),
    ('customer_auth_rate_limits', 'blocked_until'),
    ('customer_auth_rate_limits', 'created_at'),
    ('customer_auth_rate_limits', 'updated_at')
),
expected_constraints(table_name, constraint_name) as (
  values
    ('customer_auth_tokens', 'customer_auth_tokens_token_hash_key'),
    ('customer_auth_tokens', 'customer_auth_tokens_purpose_format_check'),
    ('customer_auth_tokens', 'customer_auth_tokens_expiry_check'),
    ('customer_sessions', 'customer_sessions_token_hash_key'),
    ('customer_sessions', 'customer_sessions_expiry_check'),
    ('customer_auth_rate_limits', 'customer_auth_rate_limits_scope_key'),
    ('customer_auth_rate_limits', 'customer_auth_rate_limits_scope_check'),
    ('customer_auth_rate_limits', 'customer_auth_rate_limits_count_check')
),
expected_indexes(table_name, index_name) as (
  values
    ('customer_auth_tokens', 'customer_auth_tokens_customer_purpose_idx'),
    ('customer_auth_tokens', 'customer_auth_tokens_active_idx'),
    ('customer_sessions', 'customer_sessions_customer_idx'),
    ('customer_sessions', 'customer_sessions_active_idx'),
    ('customer_auth_rate_limits', 'customer_auth_rate_limits_blocked_idx')
),
table_checks as (
  select
    'A'::text as section,
    'auth_tables_present'::text as check_name,
    jsonb_object_agg(table_name, to_regclass('public.' || table_name) is not null)::text as value,
    case when bool_and(to_regclass('public.' || table_name) is not null) then 'PASS' else 'SKIP' end as status,
    case when bool_and(to_regclass('public.' || table_name) is not null)
      then 'Customer Auth Core table ownership' else 'table_or_column_missing' end::text as detail
  from expected_tables
),
column_checks as (
  select
    'A'::text as section,
    'auth_required_columns'::text as check_name,
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
    )) then 'token hash, opaque session, expiry, and HMAC rate-limit fields'
    else 'table_or_column_missing' end::text as detail
  from expected_columns
),
constraint_checks as (
  select
    'A'::text as section,
    'auth_constraints'::text as check_name,
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
      else 'hash uniqueness, purpose format, expiry, scope, and non-negative counters' end::text as detail
  from expected_constraints
),
index_checks as (
  select
    'A'::text as section,
    'auth_indexes'::text as check_name,
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
      else 'lookup and active-state indexes' end::text as detail
  from expected_indexes
),
rls_checks as (
  select
    'A'::text as section,
    'auth_rls_enabled'::text as check_name,
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
      else 'Auth tables must not be publicly writable' end::text as detail
  from expected_tables
  left join pg_class c on c.oid = to_regclass('public.' || expected_tables.table_name)
),
purpose_check as (
  select
    'A'::text as section,
    'customer_login_default'::text as check_name,
    coalesce(max(column_default), 'missing')::text as value,
    case when not exists (
      select 1
      from information_schema.columns c0
      where c0.table_schema = 'public'
        and c0.table_name = 'customer_auth_tokens'
        and c0.column_name = 'purpose'
    ) then 'SKIP'
    when exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'customer_auth_tokens'
        and c.column_name = 'purpose'
        and c.column_default like '%customer_login%'
    ) then 'PASS' else 'FAIL' end as status,
    case when not exists (
      select 1
      from information_schema.columns c0
      where c0.table_schema = 'public'
        and c0.table_name = 'customer_auth_tokens'
        and c0.column_name = 'purpose'
    ) then 'table_or_column_missing'
    else 'purpose is general Customer Auth, not Road to VI-specific' end::text as detail
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'customer_auth_tokens'
    and column_name = 'purpose'
),
results as (
  select * from table_checks
  union all select * from column_checks
  union all select * from constraint_checks
  union all select * from index_checks
  union all select * from rls_checks
  union all select * from purpose_check
)
select section, check_name, value, status, detail
from results
order by check_name;
