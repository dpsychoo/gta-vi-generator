-- SGODX PURCHASE MILESTONES v1 - PROPOSED READ-ONLY PREFLIGHT.
-- Do not execute automatically. This file only reads catalog metadata and
-- data, and returns one Results-compatible table.
-- No historical backfill, counter creation, milestone creation, or number
-- assignment is performed here.

with
catalog as (
  select
    to_regclass('public.orders') as orders_relation,
    to_regclass('public.customers') as customers_relation,
    to_regclass('public.sgx_passes') as passes_relation,
    to_regclass('public.jobs') as jobs_relation,
    to_regclass('public.purchase_milestones') as milestones_relation,
    to_regclass('public.purchase_milestone_awards') as awards_relation,
    to_regclass('public.purchase_counter') as counter_relation
),
available_columns as (
  select coalesce(
    array_agg(table_name || '.' || column_name order by table_name, ordinal_position),
    array[]::text[]
  ) as column_keys
  from information_schema.columns
  where table_schema = 'public'
    and table_name in (
      'orders', 'customers', 'sgx_passes', 'jobs',
      'purchase_milestones', 'purchase_milestone_awards', 'purchase_counter'
    )
),
state as (
  select
    catalog.*,
    available_columns.column_keys,
    exists (
      select 1
      from pg_constraint c
      where c.conrelid = catalog.orders_relation
        and c.contype = 'p'
        and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
    ) as orders_id_is_pk
  from catalog
  cross join available_columns
),
static_results as (
  select
    10 as sort_order,
    'A'::text as section,
    'schema_table_presence'::text as check_name,
    jsonb_build_object(
      'orders', state.orders_relation is not null,
      'customers', state.customers_relation is not null,
      'sgx_passes', state.passes_relation is not null,
      'jobs', state.jobs_relation is not null,
      'purchase_milestones', state.milestones_relation is not null,
      'purchase_milestone_awards', state.awards_relation is not null,
      'purchase_counter', state.counter_relation is not null
    )::text as value,
    'INFO'::text as status,
    'catalog presence; missing optional objects are returned as SKIP below'::text as detail
  from state

  union all

  select
    20,
    'A',
    'orders_candidate_columns',
    array_to_json(array(
      select replace(column_key, 'orders.', '')
      from unnest(state.column_keys) as keys(column_key)
      where column_key in (
        'orders.id', 'orders.status', 'orders.approved_at', 'orders.created_at',
        'orders.mercadopago_payment_id', 'orders.payment_id',
        'orders.provider_payment_id', 'orders.external_payment_id',
        'orders.customer_id', 'orders.sgx_pass_id', 'orders.job_id',
        'orders.purchase_number', 'orders.refunded_at',
        'orders.refund_id', 'orders.chargeback_at',
        'orders.chargeback_id', 'orders.reversed_at', 'orders.reversal_id'
      )
      order by column_key
    ))::text,
    'INFO',
    'columns relevant to historical ordering, provider evidence, reversal state, and rollout'
  from state

  union all

  select
    30,
    'A',
    'provider_identifier_columns_available',
    array_to_json(array(
      select replace(column_key, 'orders.', '')
      from unnest(state.column_keys) as keys(column_key)
      where column_key in (
        'orders.mercadopago_payment_id', 'orders.payment_id',
        'orders.provider_payment_id', 'orders.external_payment_id'
      )
      order by column_key
    ))::text,
    'INFO',
    'provider identifiers are evidence candidates; no provider value is exposed'
  from state

  union all

  select
    40,
    'A',
    'refund_reversal_columns_available',
    array_to_json(array(
      select replace(column_key, 'orders.', '')
      from unnest(state.column_keys) as keys(column_key)
      where column_key in (
        'orders.refunded_at', 'orders.refund_id', 'orders.chargeback_at',
        'orders.chargeback_id', 'orders.reversed_at', 'orders.reversal_id'
      )
      order by column_key
    ))::text,
    'INFO',
    'current status and these columns are the only versioned reversal evidence found by this preflight'
  from state

  union all

  select
    50,
    'A',
    'stable_order_tiebreaker',
    case when state.orders_id_is_pk then 'orders.id' else null end,
    case when state.orders_id_is_pk then 'PASS' else 'SKIP' end,
    case when state.orders_id_is_pk
      then 'deterministic unique primary key; immutability remains a privilege/application invariant'
      else 'stable_tiebreaker_missing'
    end
  from state

  union all

  select
    60,
    'F',
    'purchase_milestones_table_state',
    case when state.milestones_relation is null then null else 'table_present' end,
    case when state.milestones_relation is null then 'SKIP' else 'INFO' end,
    case when state.milestones_relation is null then 'table_or_column_missing'
      else 'inspect purchase_number uniqueness and configuration before use'
    end
  from state

  union all

  select
    70,
    'G',
    'purchase_milestone_awards_table_state',
    case when state.awards_relation is null then null else 'table_present' end,
    case when state.awards_relation is null then 'SKIP' else 'INFO' end,
    case when state.awards_relation is null then 'table_or_column_missing'
      else 'inspect award idempotency and order/customer/PASS references before use'
    end
  from state
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
        'orders_status_counts',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys) then format($sql$
            select
              coalesce(jsonb_object_agg(status, total), '{}'::jsonb)::text as value,
              'INFO' as status,
              'all current order status counts' as detail
            from (
              select status, count(*)::bigint as total
              from %s
              group by status
              order by status
            ) grouped_statuses
          $sql$, state.orders_relation) end
      ),
      (
        110,
        'B',
        'approved_orders_count',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              'INFO' as status,
              'current orders with status approved; historical scope candidate' as detail
            from %s
            where status = 'approved'
          $sql$, state.orders_relation) end
      ),
      (
        120,
        'B',
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
              'approved rows without the timestamp required for deterministic historical order' as detail
            from %s
            where status = 'approved'
              and approved_at is null
          $sql$, state.orders_relation) end
      ),
      (
        130,
        'B',
        'approved_orders_without_created_at',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.created_at' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.created_at' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'approved rows without a secondary historical timestamp' as detail
            from %s
            where status = 'approved'
              and created_at is null
          $sql$, state.orders_relation) end
      ),
      (
        140,
        'B',
        'approved_at_ties',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.approved_at' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.approved_at' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'tie_groups', count(*)::bigint,
                'tied_rows', coalesce(sum(group_size), 0)::bigint
              )::text as value,
              'INFO' as status,
              'same approved_at values require orders.id as deterministic tie-breaker' as detail
            from (
              select approved_at, count(*)::bigint as group_size
              from %s
              where status = 'approved'
                and approved_at is not null
              group by approved_at
              having count(*) > 1
            ) tied
          $sql$, state.orders_relation) end
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
              'approved orders without a Customer row' as detail
            from %s orders
            left join %s customers on customers.id = orders.customer_id
            where orders.status = 'approved'
              and customers.id is null
          $sql$, state.orders_relation, state.customers_relation) end
      ),
      (
        160,
        'D',
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
              'approved orders without an SGX PASS row' as detail
            from %s orders
            left join %s passes on passes.id = orders.sgx_pass_id
            where orders.status = 'approved'
              and passes.id is null
          $sql$, state.orders_relation, state.passes_relation) end
      ),
      (
        170,
        'D',
        'approved_order_pass_customer_mismatches',
        state.orders_relation is not null
          and state.passes_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.customer_id' = any(state.column_keys)
          and 'orders.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys)
          and 'sgx_passes.customer_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and state.passes_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.customer_id' = any(state.column_keys)
          and 'orders.sgx_pass_id' = any(state.column_keys)
          and 'sgx_passes.id' = any(state.column_keys)
          and 'sgx_passes.customer_id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'approved order Customer differs from PASS Customer' as detail
            from %s orders
            join %s passes on passes.id = orders.sgx_pass_id
            where orders.status = 'approved'
              and passes.customer_id <> orders.customer_id
          $sql$, state.orders_relation, state.passes_relation) end
      ),
      (
        180,
        'D',
        'approved_orders_without_job',
        state.orders_relation is not null
          and state.jobs_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.job_id' = any(state.column_keys)
          and 'jobs.id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and state.jobs_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.job_id' = any(state.column_keys)
          and 'jobs.id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'approved orders without a Job row' as detail
            from %s orders
            left join %s jobs on jobs.id = orders.job_id
            where orders.status = 'approved'
              and jobs.id is null
          $sql$, state.orders_relation, state.jobs_relation) end
      ),
      (
        200,
        'C',
        'approved_order_mercadopago_payment_id_coverage',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.mercadopago_payment_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.mercadopago_payment_id' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'approved_rows', count(*)::bigint,
                'with_identifier', count(*) filter (where mercadopago_payment_id is not null)::bigint
              )::text as value,
              'INFO' as status,
              'Mercado Pago identifier coverage among approved orders' as detail
            from %s
            where status = 'approved'
          $sql$, state.orders_relation) end
      ),
      (
        210,
        'C',
        'approved_order_payment_id_coverage',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.payment_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.payment_id' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'approved_rows', count(*)::bigint,
                'with_identifier', count(*) filter (where payment_id is not null)::bigint
              )::text as value,
              'INFO' as status,
              'generic payment identifier coverage among approved orders' as detail
            from %s
            where status = 'approved'
          $sql$, state.orders_relation) end
      ),
      (
        220,
        'C',
        'approved_order_provider_payment_id_coverage',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.provider_payment_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.provider_payment_id' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'approved_rows', count(*)::bigint,
                'with_identifier', count(*) filter (where provider_payment_id is not null)::bigint
              )::text as value,
              'INFO' as status,
              'provider_payment_id coverage among approved orders' as detail
            from %s
            where status = 'approved'
          $sql$, state.orders_relation) end
      ),
      (
        230,
        'C',
        'approved_order_external_payment_id_coverage',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.external_payment_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.external_payment_id' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'approved_rows', count(*)::bigint,
                'with_identifier', count(*) filter (where external_payment_id is not null)::bigint
              )::text as value,
              'INFO' as status,
              'external_payment_id coverage among approved orders' as detail
            from %s
            where status = 'approved'
          $sql$, state.orders_relation) end
      ),
      (
        240,
        'C',
        'orders_refund_chargeback_status_counts',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'refunded', count(*) filter (where status = 'refunded')::bigint,
                'chargeback', count(*) filter (where status = 'chargeback')::bigint,
                'cancelled', count(*) filter (where status = 'cancelled')::bigint,
                'failed', count(*) filter (where status = 'failed')::bigint,
                'rejected', count(*) filter (where status = 'rejected')::bigint
              )::text as value,
              'INFO' as status,
              'current reversal-related order statuses; prior status history is not reconstructed' as detail
            from %s
          $sql$, state.orders_relation) end
      ),
      (
        300,
        'E',
        'approved_orders_without_purchase_number',
        state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.purchase_number' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.status' = any(state.column_keys)
          and 'orders.purchase_number' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'INFO' end as status,
              'approved rows still requiring one-time historical assignment' as detail
            from %s
            where status = 'approved'
              and purchase_number is null
          $sql$, state.orders_relation) end
      ),
      (
        310,
        'E',
        'purchase_number_state',
        state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'assigned_total', count(*) filter (where purchase_number is not null)::bigint,
                'assigned_approved', count(*) filter (where status = 'approved' and purchase_number is not null)::bigint,
                'assigned_non_approved', count(*) filter (where status <> 'approved' and purchase_number is not null)::bigint,
                'max_assigned', coalesce(max(purchase_number), 0)::bigint
              )::text as value,
              'INFO' as status,
              'purchase numbers are permanent; non-approved rows may retain an assigned number after reversal' as detail
            from %s
          $sql$, state.orders_relation) end
      ),
      (
        320,
        'E',
        'purchase_number_duplicates',
        state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'duplicate assigned purchase numbers' as detail
            from (
              select purchase_number
              from %s
              where purchase_number is not null
              group by purchase_number
              having count(*) > 1
            ) duplicate_numbers
          $sql$, state.orders_relation) end
      ),
      (
        330,
        'E',
        'purchase_number_nonpositive',
        state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys),
        'table_or_column_missing',
        case when state.orders_relation is not null
          and 'orders.purchase_number' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'assigned purchase numbers must be positive' as detail
            from %s
            where purchase_number is not null
              and purchase_number <= 0
          $sql$, state.orders_relation) end
      ),
      (
        400,
        'F',
        'purchase_milestone_duplicate_numbers',
        state.milestones_relation is not null
          and 'purchase_milestones.purchase_number' = any(state.column_keys),
        'table_or_column_missing',
        case when state.milestones_relation is not null
          and 'purchase_milestones.purchase_number' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'a global purchase number may map to at most one milestone' as detail
            from (
              select purchase_number
              from %s
              group by purchase_number
              having count(*) > 1
            ) duplicate_milestones
          $sql$, state.milestones_relation) end
      ),
      (
        410,
        'G',
        'purchase_milestone_award_duplicate_milestones',
        state.awards_relation is not null
          and 'purchase_milestone_awards.milestone_id' = any(state.column_keys),
        'table_or_column_missing',
        case when state.awards_relation is not null
          and 'purchase_milestone_awards.milestone_id' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'one milestone must have at most one award' as detail
            from (
              select milestone_id
              from %s
              group by milestone_id
              having count(*) > 1
            ) duplicate_awards
          $sql$, state.awards_relation) end
      ),
      (
        420,
        'G',
        'purchase_milestone_award_order_reference_issues',
        state.awards_relation is not null
          and state.orders_relation is not null
          and 'purchase_milestone_awards.order_id' = any(state.column_keys)
          and 'purchase_milestone_awards.customer_id' = any(state.column_keys)
          and 'purchase_milestone_awards.sgx_pass_id' = any(state.column_keys)
          and 'purchase_milestone_awards.purchase_number' = any(state.column_keys)
          and 'orders.id' = any(state.column_keys)
          and 'orders.customer_id' = any(state.column_keys)
          and 'orders.sgx_pass_id' = any(state.column_keys)
          and 'orders.purchase_number' = any(state.column_keys),
        'table_or_column_missing',
        case when state.awards_relation is not null
          and state.orders_relation is not null
          and 'purchase_milestone_awards.order_id' = any(state.column_keys)
          and 'purchase_milestone_awards.customer_id' = any(state.column_keys)
          and 'purchase_milestone_awards.sgx_pass_id' = any(state.column_keys)
          and 'purchase_milestone_awards.purchase_number' = any(state.column_keys)
          and 'orders.id' = any(state.column_keys)
          and 'orders.customer_id' = any(state.column_keys)
          and 'orders.sgx_pass_id' = any(state.column_keys)
          and 'orders.purchase_number' = any(state.column_keys) then format($sql$
            select
              count(*)::text as value,
              case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
              'award snapshot does not match its Order identity or permanent number' as detail
            from %s awards
            left join %s orders on orders.id = awards.order_id
            where orders.id is null
               or orders.customer_id is distinct from awards.customer_id
               or orders.sgx_pass_id is distinct from awards.sgx_pass_id
               or orders.purchase_number is distinct from awards.purchase_number
          $sql$, state.awards_relation, state.orders_relation) end
      ),
      (
        500,
        'H',
        'purchase_counter_state',
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
              jsonb_build_object(
                'rows', count(*)::bigint,
                'last_purchase_number', coalesce(max(last_purchase_number), 0)::bigint,
                'assignment_states', coalesce(jsonb_object_agg(assignment_state, total), '{}'::jsonb)
              )::text as value,
              case when count(*) = 1 then 'INFO' else 'FAIL' end as status,
              'counter must remain a single locked row; assignment_state is the backfill/live gate' as detail
            from (
              select assignment_state, last_purchase_number, count(*) over (partition by assignment_state) as total
              from %s
            ) counter_rows
          $sql$, state.counter_relation) end
      ),
      (
        510,
        'H',
        'purchase_counter_vs_orders_max',
        state.counter_relation is not null
          and state.orders_relation is not null
          and 'purchase_counter.id' = any(state.column_keys)
          and 'purchase_counter.last_purchase_number' = any(state.column_keys)
          and 'orders.purchase_number' = any(state.column_keys),
        'table_or_column_missing',
        case when state.counter_relation is not null
          and state.orders_relation is not null
          and 'purchase_counter.id' = any(state.column_keys)
          and 'purchase_counter.last_purchase_number' = any(state.column_keys)
          and 'orders.purchase_number' = any(state.column_keys) then format($sql$
            select
              jsonb_build_object(
                'counter_rows', (select count(*) from %s where id = 1),
                'counter_last', (select coalesce(max(last_purchase_number), 0) from %s where id = 1),
                'orders_max', (select coalesce(max(purchase_number), 0) from %s)
              )::text as value,
              case
                when (select count(*) from %s where id = 1) = 1
                 and (select coalesce(max(last_purchase_number), 0) from %s where id = 1)
                   = (select coalesce(max(purchase_number), 0) from %s)
                then 'PASS' else 'FAIL'
              end as status,
              'counter and durable Order maximum must agree before live assignment' as detail
          $sql$, state.counter_relation, state.counter_relation, state.orders_relation,
            state.counter_relation, state.counter_relation, state.orders_relation) end
      )
  ) as specs(sort_order, section, check_name, can_run, missing_detail, query_text)
),
raw_results as (
  select
    check_specs.*,
    case when can_run then query_to_xml(query_text, true, false, '') end as result_xml
  from check_specs
),
evaluated_results as (
  select
    sort_order,
    section,
    check_name,
    case when can_run then (xpath('string(/table/row/value)', result_xml))[1]::text end as value,
    case when can_run then coalesce((xpath('string(/table/row/status)', result_xml))[1]::text, 'INFO') else 'SKIP' end as status,
    case when can_run then coalesce((xpath('string(/table/row/detail)', result_xml))[1]::text, 'read-only check') else missing_detail end as detail
  from raw_results
)
select section, check_name, value, status, detail
from (
  select sort_order, section, check_name, value, status, detail
  from static_results
  union all
  select sort_order, section, check_name, value, status, detail
  from evaluated_results
) results
order by sort_order;
