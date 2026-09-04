-- SGODX CUSTOMER AUTH CORE v1 - PROPOSED READ-ONLY PREFLIGHT.
-- Do not execute automatically. This file only reads catalog metadata and
-- current Auth state and returns one Results-compatible table.
-- Missing tables or columns are SKIP, never a reason to execute a fallback.

with
catalog as (
  select
    to_regclass('public.customer_auth_tokens') as tokens_relation,
    to_regclass('public.customer_sessions') as sessions_relation,
    to_regclass('public.customer_auth_rate_limits') as rate_limits_relation
),
available_columns as (
  select coalesce(
    array_agg(table_name || '.' || column_name order by table_name, ordinal_position),
    array[]::text[]
  ) as column_keys
  from information_schema.columns
  where table_schema = 'public'
    and table_name in (
      'customer_auth_tokens', 'customer_sessions', 'customer_auth_rate_limits'
    )
),
state as (
  select catalog.*, available_columns.column_keys
  from catalog
  cross join available_columns
),
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
static_results as (
  select
    10 as sort_order,
    'A'::text as section,
    'auth_tables_present'::text as check_name,
    jsonb_object_agg(
      expected_tables.table_name,
      to_regclass('public.' || expected_tables.table_name) is not null
    )::text as value,
    case when bool_and(to_regclass('public.' || expected_tables.table_name) is not null)
      then 'PASS' else 'SKIP' end as status,
    case when bool_and(to_regclass('public.' || expected_tables.table_name) is not null)
      then 'Customer Auth Core table ownership'
      else 'table_or_column_missing' end as detail
  from expected_tables

  union all

  select
    20,
    'A',
    'auth_required_columns',
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
    )) then 'token hashes, opaque sessions, expiry, and HMAC rate-limit fields'
    else 'table_or_column_missing' end
  from expected_columns

  union all

  select
    30,
    'A',
    'auth_constraints',
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
      else 'hash uniqueness, purpose format, expiry, scope, and non-negative counters'
    end
  from expected_constraints

  union all

  select
    40,
    'A',
    'auth_indexes',
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
      else 'lookup and active-state indexes'
    end
  from expected_indexes

  union all

  select
    50,
    'A',
    'auth_rls_enabled',
    jsonb_object_agg(
      expected_tables.table_name,
      coalesce(c.relrowsecurity, false)
    )::text,
    case
      when not bool_and(c.oid is not null) then 'SKIP'
      when bool_and(coalesce(c.relrowsecurity, false)) then 'PASS'
      else 'FAIL'
    end,
    case when not bool_and(c.oid is not null)
      then 'table_or_column_missing'
      else 'Auth tables must not be publicly writable' end
  from expected_tables
  left join pg_class c on c.oid = to_regclass('public.' || expected_tables.table_name)

  union all

  select
    60,
    'A',
    'customer_login_default',
    coalesce(max(c.column_default), 'missing')::text,
    case
      when not exists (
        select 1
        from information_schema.columns c2
        where c2.table_schema = 'public'
          and c2.table_name = 'customer_auth_tokens'
          and c2.column_name = 'purpose'
      ) then 'SKIP'
      when max(c.column_default) like '%customer_login%' then 'PASS'
      else 'FAIL'
    end,
    case when not exists (
      select 1
      from information_schema.columns c2
      where c2.table_schema = 'public'
        and c2.table_name = 'customer_auth_tokens'
        and c2.column_name = 'purpose'
    ) then 'table_or_column_missing'
    else 'purpose is reusable Customer Auth, not Road to VI-specific' end
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'customer_auth_tokens'
    and c.column_name = 'purpose'
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
        'auth_token_purpose_counts',
        state.tokens_relation is not null
          and 'customer_auth_tokens.purpose' = any(state.column_keys),
        'table_or_column_missing',
        case when state.tokens_relation is not null
          and 'customer_auth_tokens.purpose' = any(state.column_keys) then format($sql$
            select
              coalesce(jsonb_object_agg(purpose, purpose_count), '{}'::jsonb)::text as value,
              'INFO' as status,
              'token purpose distribution; hashes and token values are not exposed' as detail
            from (
              select purpose, count(*)::bigint as purpose_count
              from %s
              group by purpose
              order by purpose
            ) purposes
          $sql$, state.tokens_relation) end
      ),
      (
        110,
        'B',
        'active_expired_auth_tokens',
        state.tokens_relation is not null
          and 'customer_auth_tokens.expires_at' = any(state.column_keys)
          and 'customer_auth_tokens.used_at' = any(state.column_keys),
        'table_or_column_missing',
        case when state.tokens_relation is not null
          and 'customer_auth_tokens.expires_at' = any(state.column_keys)
          and 'customer_auth_tokens.used_at' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'INFO' end as status,
              'unused auth tokens whose expiry has passed' as detail
            from %s
            where used_at is null
              and expires_at <= now()
          $sql$, state.tokens_relation) end
      ),
      (
        120,
        'B',
        'active_expired_sessions',
        state.sessions_relation is not null
          and 'customer_sessions.expires_at' = any(state.column_keys)
          and 'customer_sessions.revoked_at' = any(state.column_keys),
        'table_or_column_missing',
        case when state.sessions_relation is not null
          and 'customer_sessions.expires_at' = any(state.column_keys)
          and 'customer_sessions.revoked_at' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'INFO' end as status,
              'unrevoked sessions whose expiry has passed' as detail
            from %s
            where revoked_at is null
              and expires_at <= now()
          $sql$, state.sessions_relation) end
      ),
      (
        130,
        'B',
        'rate_limit_state',
        state.rate_limits_relation is not null
          and 'customer_auth_rate_limits.request_count' = any(state.column_keys)
          and 'customer_auth_rate_limits.blocked_until' = any(state.column_keys),
        'table_or_column_missing',
        case when state.rate_limits_relation is not null
          and 'customer_auth_rate_limits.request_count' = any(state.column_keys)
          and 'customer_auth_rate_limits.blocked_until' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'rows', count(*),
                'nonzero_request_rows', count(*) filter (where request_count > 0),
                'currently_blocked_rows', count(*) filter (where blocked_until > now())
              )::text as value,
              'INFO' as status,
              'counts only; key hashes are not exposed' as detail
            from %s
          $sql$, state.rate_limits_relation) end
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
