-- Read-only preflight for SGODX LEGAL CENTER v1.
-- The catalog checks are safe when optional tables do not exist.
-- The dynamic statements below execute SELECT-only data checks and emit counts via NOTICE.

select
  table_schema,
  table_name,
  'present' as status
from information_schema.tables
where table_schema = 'public'
  and table_name in ('jobs', 'customers', 'legal_acceptances')
union all
select
  'public' as table_schema,
  expected.table_name,
  'missing' as status
from (values ('jobs'), ('customers'), ('legal_acceptances')) as expected(table_name)
where to_regclass('public.' || expected.table_name) is null
order by table_name;

select
  table_name,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'jobs' and column_name in ('media_purged_at', 'media_retention_started_at'))
    or (table_name = 'legal_acceptances' and column_name in (
      'id', 'job_id', 'customer_id', 'terms_version', 'privacy_version',
      'refund_policy_version', 'immediate_execution_accepted',
      'retract_exclusion_acknowledged', 'accepted_at', 'source',
      'confirmation_email_status', 'confirmation_sent_at', 'created_at'
    ))
  )
order by table_name, ordinal_position;

select
  c.conname,
  c.conrelid::regclass as table_name,
  c.contype,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
where c.conrelid in (
  to_regclass('public.jobs'),
  to_regclass('public.legal_acceptances')
)
order by c.conrelid::regclass::text, c.conname;

select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('jobs', 'legal_acceptances')
order by tablename, indexname;

select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  (
    select count(*)
    from pg_policy p
    where p.polrelid = c.oid
  ) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('jobs', 'legal_acceptances')
order by c.relname;

do $preflight_read_only$
declare
  jobs_relation regclass := to_regclass('public.jobs');
  customers_relation regclass := to_regclass('public.customers');
  legal_relation regclass := to_regclass('public.legal_acceptances');
  duplicate_groups bigint;
  excess_rows bigint;
  job_orphan_rows bigint;
  customer_orphan_rows bigint;
  total_jobs bigint;
  jobs_with_legal_acceptance bigint;
  jobs_with_retention_start bigint;
  jobs_with_media_purged bigint;
  jobs_has_id boolean;
  jobs_has_retention_start boolean;
  jobs_has_media_purged boolean;
  legal_has_job_id boolean;
  legal_has_customer_id boolean;
  customers_has_id boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'id'
  ) into jobs_has_id;
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'media_retention_started_at'
  ) into jobs_has_retention_start;
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'media_purged_at'
  ) into jobs_has_media_purged;
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'legal_acceptances' and column_name = 'job_id'
  ) into legal_has_job_id;
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'legal_acceptances' and column_name = 'customer_id'
  ) into legal_has_customer_id;
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'customers' and column_name = 'id'
  ) into customers_has_id;

  if legal_relation is null then
    raise notice 'legal_acceptance_duplicates: duplicate_groups=NULL, excess_rows=NULL, reason=table_missing';
    raise notice 'legal_acceptance_orphans: job_orphan_rows=NULL, customer_orphan_rows=NULL, reason=table_missing';
  elsif not legal_has_job_id then
    raise notice 'legal_acceptance_duplicates: duplicate_groups=NULL, excess_rows=NULL, reason=job_id_column_missing';
    raise notice 'legal_acceptance_orphans: job_orphan_rows=NULL, customer_orphan_rows=NULL, reason=job_id_column_missing';
  else
    execute format($query$
      select count(*)::bigint, coalesce(sum(row_count - 1), 0)::bigint
      from (
        select job_id, count(*)::bigint as row_count
        from %s
        group by job_id
        having count(*) > 1
      ) duplicate_groups
    $query$, legal_relation)
    into duplicate_groups, excess_rows;

    if jobs_relation is null or not jobs_has_id then
      job_orphan_rows := null;
    else
      execute format($query$
        select count(*)::bigint
        from %s legal
        left join %s jobs on jobs.id = legal.job_id
        where jobs.id is null
      $query$, legal_relation, jobs_relation)
      into job_orphan_rows;
    end if;

    if customers_relation is null or not customers_has_id or not legal_has_customer_id then
      customer_orphan_rows := null;
    else
      execute format($query$
        select count(*)::bigint
        from %s legal
        left join %s customers on customers.id = legal.customer_id
        where legal.customer_id is not null
          and customers.id is null
      $query$, legal_relation, customers_relation)
      into customer_orphan_rows;
    end if;

    raise notice 'legal_acceptance_duplicates: duplicate_groups=%, excess_rows=%', duplicate_groups, excess_rows;
    raise notice 'legal_acceptance_orphans: job_orphan_rows=%, customer_orphan_rows=%', job_orphan_rows, customer_orphan_rows;
  end if;

  if jobs_relation is null then
    raise notice 'job_statistics: total_jobs=NULL, jobs_with_legal_acceptance=NULL, jobs_with_media_retention_started_at=NULL, jobs_with_media_purged_at=NULL, reason=table_missing';
  else
    execute format('select count(*)::bigint from %s', jobs_relation)
      into total_jobs;

    if legal_relation is null or not legal_has_job_id or not jobs_has_id then
      jobs_with_legal_acceptance := null;
    else
      execute format($query$
        select count(*)::bigint
        from %s jobs
        where exists (
          select 1
          from %s legal
          where legal.job_id = jobs.id
        )
      $query$, jobs_relation, legal_relation)
        into jobs_with_legal_acceptance;
    end if;

    if jobs_has_retention_start then
      execute format('select count(*)::bigint from %s where media_retention_started_at is not null', jobs_relation)
        into jobs_with_retention_start;
    else
      jobs_with_retention_start := null;
    end if;

    if jobs_has_media_purged then
      execute format('select count(*)::bigint from %s where media_purged_at is not null', jobs_relation)
        into jobs_with_media_purged;
    else
      jobs_with_media_purged := null;
    end if;

    raise notice 'job_statistics: total_jobs=%, jobs_with_legal_acceptance=%, jobs_with_media_retention_started_at=%, jobs_with_media_purged_at=%',
      total_jobs, jobs_with_legal_acceptance, jobs_with_retention_start, jobs_with_media_purged;
  end if;
end
$preflight_read_only$;
