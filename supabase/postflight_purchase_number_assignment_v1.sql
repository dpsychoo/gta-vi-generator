-- PROPOSED READ-ONLY POSTFLIGHT D / repeatable operational monitoring.
-- Never invokes the assignment RPC. One Results table, no procedural output.
-- All query_to_xml inputs below are fixed, read-only SELECT statements.
with
rpc as (
  select p.*, r.rolname as owner_name
  from pg_catalog.pg_proc p
  join pg_catalog.pg_roles r on r.oid = p.proowner
  where p.oid = pg_catalog.to_regprocedure('public.assign_purchase_number_v1(uuid)')
),
rpc_acl as (
  select a.* from rpc p
  cross join lateral pg_catalog.aclexplode(
    coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
  ) a
),
columns_available as (
  select coalesce(array_agg(table_name || '.' || column_name), array[]::text[])
    || case when pg_catalog.to_regclass('public.purchase_queue_position_v1_seq') is not null
      then array['__purchase_queue_position_sequence__']::text[] else array[]::text[] end as keys
  from information_schema.columns where table_schema = 'public'
),
queue_sequence as (
  select c.oid, c.relowner, c.relacl, r.rolname, s.*
  from pg_catalog.pg_class c join pg_catalog.pg_sequence s on s.seqrelid = c.oid
  join pg_catalog.pg_roles r on r.oid = c.relowner
  where c.oid = pg_catalog.to_regclass('public.purchase_queue_position_v1_seq')
),
static_results as (
  select 10 as sort_order, 'A'::text as section, 'assignment_rpc_exists'::text as check_name,
    (select count(*)::text from rpc) as value,
    case when exists (select 1 from rpc) then 'PASS' else 'FAIL' end as status,
    'public.assign_purchase_number_v1(uuid)'::text as detail
  union all
  select 20, 'A', 'assignment_rpc_owner_security',
    (select jsonb_build_object('owner', owner_name, 'security_definer', prosecdef,
      'settings', proconfig, 'volatile', provolatile)::text from rpc),
    case when exists (select 1 from rpc where owner_name = 'postgres' and prosecdef
      and provolatile = 'v' and 'search_path=pg_catalog, pg_temp' = any(proconfig)
      and 'lock_timeout=2s' = any(proconfig)) then 'PASS' else 'FAIL' end,
    'trusted postgres owner; fixed catalog-first path; bounded lock wait'
  union all
  select 30, 'A', 'assignment_rpc_return_contract',
    (select pg_catalog.pg_get_function_result(oid) from rpc),
    case when exists (select 1 from rpc where pronargs = 1 and proretset
      and proargnames = array['p_order_id', 'outcome', 'purchase_number',
        'milestone_reached', 'milestone_id', 'award_id', 'reason']::text[]
      and proallargtypes = array['uuid'::regtype::oid, 'text'::regtype::oid,
        'text'::regtype::oid, 'boolean'::regtype::oid, 'uuid'::regtype::oid,
        'uuid'::regtype::oid, 'text'::regtype::oid]) then 'PASS' else 'FAIL' end,
    'number is decimal text to preserve bigint; one row per invocation'
  union all
  select 40, 'A', 'assignment_rpc_public_execute',
    (select count(*)::text from rpc_acl where grantee = 0 and privilege_type = 'EXECUTE'),
    case when not exists (select 1 from rpc) then 'FAIL'
      when exists (select 1 from rpc_acl where grantee = 0 and privilege_type = 'EXECUTE')
      then 'FAIL' else 'PASS' end,
    'PUBLIC must have no execution permission'
  union all
  select 50, 'A', 'assignment_rpc_backend_only_execute',
    (select jsonb_object_agg(r.rolname, pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))::text
      from rpc p cross join pg_catalog.pg_roles r
      where r.rolname in ('anon', 'authenticated', 'service_role')),
    case when not exists (select 1 from rpc) then 'FAIL'
      when (select count(*) from pg_catalog.pg_roles
        where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then 'FAIL'
      when exists (select 1 from rpc p cross join pg_catalog.pg_roles r
        where r.rolname in ('anon', 'authenticated', 'service_role')
        and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
          is distinct from (r.rolname = 'service_role')) then 'FAIL'
      when exists (select 1 from rpc_acl a cross join rpc p
        where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
          and (a.grantee is distinct from
            (select oid from pg_catalog.pg_roles where rolname = 'service_role')
            or a.is_grantable)) then 'FAIL'
      else 'PASS' end,
    'effective anon/authenticated denied; service_role allowed without delegation; owner implicit'
  union all
  select 60, 'A', 'assignment_rpc_overloads', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    'one reviewed signature only'
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assign_purchase_number_v1'
  union all
  select 70, 'A', 'purchase_queue_admission_guard',
    (select pg_catalog.pg_get_triggerdef(t.oid) from pg_catalog.pg_trigger t
      where t.tgrelid = pg_catalog.to_regclass('public.orders')
        and t.tgname = 'orders_purchase_queue_guard_v1'),
    case when exists (select 1 from pg_catalog.pg_trigger t
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where t.tgrelid = pg_catalog.to_regclass('public.orders')
        and t.tgname = 'orders_purchase_queue_guard_v1' and t.tgtype = 31
        and t.tgenabled = 'O' and not t.tgisinternal
        and p.oid = pg_catalog.to_regprocedure('public.guard_purchase_queue_v1()')
        and p.prosecdef and p.provolatile = 'v' and r.rolname = 'postgres'
        and 'search_path=pg_catalog, pg_temp' = any(p.proconfig)
        and not exists (select 1 from pg_catalog.aclexplode(
          coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where a.grantee <> p.proowner)) then 'PASS' else 'FAIL' end,
    'enabled row guard with trusted owner; admission, immutable priority and permanent numbers'
  union all
  select 80, 'A', 'purchase_queue_sequence_security',
    (select jsonb_build_object('owner', rolname, 'cache', seqcache,
      'increment', seqincrement, 'cycle', seqcycle)::text from queue_sequence),
    case when exists (select 1 from queue_sequence s where s.rolname = 'postgres'
      and s.seqcache = 1 and s.seqincrement = 1 and s.seqmin = 1 and not s.seqcycle
      and not exists (select 1 from pg_catalog.aclexplode(
        coalesce(s.relacl, pg_catalog.acldefault('s', s.relowner))) a
        where a.grantee <> s.relowner)
      and not exists (select 1 from pg_catalog.pg_roles r
        where r.rolname in ('anon', 'authenticated', 'service_role')
          and pg_catalog.has_sequence_privilege(r.oid, s.oid, 'USAGE, SELECT, UPDATE')))
      then 'PASS' else 'FAIL' end,
    'internal queue only; CACHE 1 required; no direct sequence access for API roles'
  union all
  select 85, 'A', 'purchase_queue_position_column',
    case when exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name = 'purchase_queue_position'
    ) then 'present' else 'missing' end,
    case when exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name = 'purchase_queue_position'
    ) then 'PASS' else 'SKIP' end,
    case when exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name = 'purchase_queue_position'
    ) then 'D durable admission column is present'
      else 'table_or_column_missing' end
  union all
  select 90, 'A', 'purchase_queue_indexes', count(*)::text,
    case when count(*) = 2 and bool_and(i.indisvalid)
      and bool_or(c.relname = 'orders_purchase_queue_position_key' and i.indisunique)
      then 'PASS' else 'FAIL' end,
    'unique queue position and pending queue index'
  from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
  where i.indrelid = pg_catalog.to_regclass('public.orders')
    and c.relname in ('orders_purchase_queue_position_key', 'orders_purchase_queue_pending_idx')
),
check_specs(sort_order, section, check_name, required_columns, query_text) as (
  values
  (100, 'B', 'purchase_counter_state',
    array['purchase_counter.id', 'purchase_counter.assignment_state', 'purchase_counter.last_purchase_number'],
    $sql$
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'state', assignment_state,
        'last_purchase_number', last_purchase_number::text)), '[]'::jsonb)::text as value,
        case when count(*) = 1 and bool_and(id = 1 and last_purchase_number >= 0
          and assignment_state in ('paused', 'backfill', 'live')) then 'PASS' else 'FAIL' end as status,
        'D leaves the counter unchanged; paused is expected before controlled backfill'::text as detail
      from public.purchase_counter
    $sql$),
  (110, 'B', 'approved_without_purchase_number',
    array['orders.status', 'orders.purchase_number', 'purchase_counter.id', 'purchase_counter.assignment_state'],
    $sql$
      select count(*)::text as value,
        case when count(*) = 0 then 'PASS'
          when (select assignment_state from public.purchase_counter where id = 1) = 'live'
          then 'FAIL' else 'INFO' end as status,
        'DEGRADED when live: repair the head first; later targets must defer; expected backlog while paused'::text as detail
      from public.orders where status = 'approved' and purchase_number is null
    $sql$),
  (120, 'B', 'counter_vs_max_purchase_number',
    array['orders.purchase_number', 'purchase_counter.id', 'purchase_counter.last_purchase_number'],
    $sql$
      select jsonb_build_object('counter', c.last_purchase_number::text,
        'max_purchase_number', o.max_number::text)::text as value,
        case when c.last_purchase_number = o.max_number then 'PASS' else 'FAIL' end as status,
        'ALERT on divergence; maximum includes refunded/chargeback orders; never reset numbering'::text as detail
      from (select coalesce(max(purchase_number), 0) as max_number from public.orders) o
      left join public.purchase_counter c on c.id = 1
    $sql$),
  (130, 'B', 'purchase_number_duplicates', array['orders.purchase_number'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'duplicate non-null purchase numbers'::text as detail
      from (select purchase_number from public.orders where purchase_number is not null
        group by purchase_number having count(*) > 1) d
    $sql$),
  (140, 'B', 'purchase_number_continuity', array['orders.purchase_number'],
    $sql$
      select jsonb_build_object('numbered', count(*)::text, 'min', min(purchase_number)::text,
        'max', max(purchase_number)::text)::text as value,
        case when count(*) = 0 or (min(purchase_number) = 1
          and max(purchase_number) = count(*) and count(distinct purchase_number) = count(*))
        then 'PASS' else 'FAIL' end as status,
        'permanent contiguous range across ALL statuses; a reversal retains its number'::text as detail
      from public.orders where purchase_number is not null
    $sql$),
  (150, 'B', 'approved_order_identity_integrity',
    array['orders.status', 'orders.approved_at', 'orders.customer_id', 'orders.sgx_pass_id',
      'customers.id', 'sgx_passes.id', 'sgx_passes.customer_id'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'approved orders need approval time and an existing matching Customer/PASS pair'::text as detail
      from public.orders o left join public.customers c on c.id = o.customer_id
      left join public.sgx_passes p on p.id = o.sgx_pass_id
      where o.status = 'approved' and (o.approved_at is null or c.id is null or p.id is null
        or p.customer_id is distinct from o.customer_id)
    $sql$),
  (160, 'B', 'numbering_health',
    array['orders.status', 'orders.purchase_number', 'orders.purchase_queue_position',
      'purchase_counter.id', 'purchase_counter.assignment_state'],
    $sql$
      select jsonb_build_object('health', case when q.pending = 0 then 'HEALTHY' else 'DEGRADED' end,
        'counter_state', c.assignment_state, 'approved_without_number', q.approved_pending,
        'pending_including_blocked_head', q.pending)::text as value,
        case when c.assignment_state is null then 'FAIL'
          when q.pending = 0 then 'PASS'
          when c.assignment_state = 'live' then 'FAIL' else 'INFO' end as status,
        'backlog blocks later targets, never paid image fulfillment; observe again after in-flight requests finish'::text as detail
      from (select count(*) filter (where status = 'approved') as approved_pending,
        count(*) as pending from public.orders where purchase_number is null
        and (status = 'approved' or purchase_queue_position is not null)) q
      left join public.purchase_counter c on c.id = 1
    $sql$),
  (170, 'B', 'purchase_queue_head',
    array['orders.id', 'orders.status', 'orders.purchase_number', 'orders.purchase_queue_position'],
    $sql$
      select coalesce((select jsonb_build_object('order_id', id, 'status', status,
        'queue_position', purchase_queue_position::text) from public.orders
        where purchase_number is null and purchase_queue_position is not null
        order by purchase_queue_position asc limit 1), '{}'::jsonb)::text as value,
        'INFO'::text as status,
        'repair ONLY this internal Order ID through the same RPC; inspect missing-position and lifecycle alerts first'::text as detail
    $sql$),
  (180, 'B', 'approved_missing_queue_position',
    array['orders.status', 'orders.purchase_number', 'orders.purchase_queue_position',
      'purchase_counter.id', 'purchase_counter.assignment_state'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS'
        when (select assignment_state from public.purchase_counter where id = 1) = 'live'
        then 'FAIL' else 'INFO' end as status,
        'legacy NULL positions are expected before initial backfill; live gap stops ALL new numbers'::text as detail
      from public.orders where status = 'approved' and purchase_number is null and purchase_queue_position is null
    $sql$),
  (185, 'B', 'queue_overtaking_detected', array['orders.purchase_number', 'orders.purchase_queue_position'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'NO-GO if a pending position precedes one already numbered; no automatic renumbering or queue reset'::text as detail
      from public.orders where purchase_number is null and purchase_queue_position <=
        (select max(purchase_queue_position) from public.orders where purchase_number is not null)
    $sql$),
  (190, 'B', 'queue_head_lifecycle_blockers',
    array['orders.status', 'orders.purchase_number', 'orders.purchase_queue_position'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'registered non-approved pending orders require lifecycle review; never silently skip or requeue them'::text as detail
      from public.orders where purchase_number is null and purchase_queue_position is not null and status <> 'approved'
    $sql$),
  (195, 'B', 'queue_position_integrity', array['orders.purchase_queue_position'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'positive unique internal positions; gaps from rollbacks or duplicate notifications are allowed'::text as detail
      from (select purchase_queue_position from public.orders where purchase_queue_position is not null
        group by purchase_queue_position having count(*) > 1 or purchase_queue_position <= 0) invalid
    $sql$),
  (197, 'B', 'queue_sequence_ahead_of_max_position',
    array['orders.purchase_queue_position', '__purchase_queue_position_sequence__'],
    $sql$
      with queue as (
        select max(purchase_queue_position) as max_position
        from public.orders
      ), sequence_state as (
        select last_value from public.purchase_queue_position_v1_seq
      )
      select jsonb_build_object(
        'sequence_last_value', sequence_state.last_value::text,
        'max_queue_position', queue.max_position::text
      )::text as value,
      case when sequence_state.last_value >= coalesce(queue.max_position, 0)
        then 'PASS' else 'FAIL' end as status,
      'the internal sequence must not be behind manually assigned historical positions'
        as detail
      from queue cross join sequence_state
    $sql$),
  (200, 'C', 'award_snapshot_integrity',
    array['purchase_milestone_awards.id', 'purchase_milestone_awards.order_id',
      'purchase_milestone_awards.customer_id', 'purchase_milestone_awards.sgx_pass_id',
      'purchase_milestone_awards.purchase_number', 'purchase_milestone_awards.milestone_id',
      'purchase_milestone_awards.rules_version', 'purchase_milestone_awards.awarded_at',
      'orders.id', 'orders.customer_id', 'orders.sgx_pass_id', 'orders.purchase_number',
      'purchase_milestones.id', 'purchase_milestones.purchase_number',
      'purchase_milestone_rules.id', 'purchase_milestone_rules.milestone_id',
      'purchase_milestone_rules.version', 'purchase_milestone_rules.published_at',
      'customers.id', 'sgx_passes.id', 'sgx_passes.customer_id'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'award must match Order/Customer/PASS/number and milestone/published rule; no PII output'::text as detail
      from public.purchase_milestone_awards a
      left join public.orders o on o.id = a.order_id
      left join public.customers c on c.id = a.customer_id
      left join public.sgx_passes p on p.id = a.sgx_pass_id
      left join public.purchase_milestones m on m.id = a.milestone_id
      left join public.purchase_milestone_rules r on r.milestone_id = a.milestone_id and r.version = a.rules_version
      where o.id is null or c.id is null or p.id is null or m.id is null or r.id is null
        or a.customer_id is distinct from o.customer_id or a.sgx_pass_id is distinct from o.sgx_pass_id
        or a.customer_id is distinct from p.customer_id
        or a.purchase_number is distinct from o.purchase_number
        or a.purchase_number is distinct from m.purchase_number
        or r.published_at is null or r.published_at > a.awarded_at
    $sql$),
  (210, 'C', 'award_milestone_duplicates', array['purchase_milestone_awards.milestone_id'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'at most one award per milestone'::text as detail
      from (select milestone_id from public.purchase_milestone_awards group by milestone_id having count(*) > 1) d
    $sql$),
  (220, 'C', 'milestone_award_state_integrity',
    array['purchase_milestones.id', 'purchase_milestones.status', 'purchase_milestone_awards.id',
      'purchase_milestone_awards.milestone_id'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'reached requires an award; an award keeps its milestone reached even when the claim is void'::text as detail
      from public.purchase_milestones m left join public.purchase_milestone_awards a on a.milestone_id = m.id
      where (m.status = 'reached' and a.id is null) or (a.id is not null and m.status <> 'reached')
    $sql$),
  (230, 'C', 'active_milestone_published_rules',
    array['purchase_milestones.id', 'purchase_milestones.status', 'purchase_milestones.rules_version',
      'purchase_milestone_rules.milestone_id', 'purchase_milestone_rules.version',
      'purchase_milestone_rules.published_at', 'purchase_milestone_rules.title',
      'purchase_milestone_rules.content', 'purchase_milestone_rules.content_hash'],
    $sql$
      select count(*)::text as value, case when count(*) = 0 then 'PASS' else 'FAIL' end as status,
        'active configuration requires a nonblank version and already published nonblank rules'::text as detail
      from public.purchase_milestones m left join public.purchase_milestone_rules r
        on r.milestone_id = m.id and r.version = m.rules_version
      where m.status = 'active' and (nullif(btrim(m.rules_version), '') is null
        or r.published_at is null or r.published_at > current_timestamp
        or nullif(btrim(r.title), '') is null or nullif(btrim(r.content), '') is null
        or nullif(btrim(r.content_hash), '') is null)
    $sql$),
  (240, 'C', 'milestone_award_population',
    array['purchase_milestones.id', 'purchase_milestone_awards.id'],
    $sql$
      select jsonb_build_object('milestones', (select count(*) from public.purchase_milestones),
        'awards', (select count(*) from public.purchase_milestone_awards))::text as value,
        'INFO'::text as status, 'D has no seed or RPC invocation; expected zero in the current rollout'::text as detail
    $sql$)
),
ready_checks as (
  select s.*, s.required_columns <@ c.keys as can_run from check_specs s cross join columns_available c
),
raw_results as materialized (
  select r.*, case when can_run then pg_catalog.query_to_xml(query_text, true, false, '') end as result_xml
  from ready_checks r
),
data_results as (
  select sort_order, section, check_name,
    case when can_run then (xpath('string(/table/row/value)', result_xml))[1]::text end as value,
    case when can_run then (xpath('string(/table/row/status)', result_xml))[1]::text else 'SKIP' end as status,
    case when can_run then (xpath('string(/table/row/detail)', result_xml))[1]::text
      else 'table_or_column_missing' end as detail
  from raw_results
),
results as materialized (
  select * from static_results union all select * from data_results
),
summary as (
  select 1000 as sort_order, 'K'::text as section, 'blockers'::text as check_name,
    count(*) filter (where status in ('FAIL', 'SKIP'))::text as value,
    case when count(*) filter (where status in ('FAIL', 'SKIP')) = 0 then 'PASS' else 'FAIL' end as status,
    'FAIL or missing prerequisites block rollout; paused backlog is INFO, not permission to open live'::text as detail
  from results
)
select section, check_name, value, status, detail
from (select * from results union all select * from summary) all_results
order by sort_order, section, check_name;
