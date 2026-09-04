-- SGODX production monitoring: READ-ONLY queries only.
-- Do not execute automatically from the application.
-- Results are intentionally aggregated and omit emails, payment IDs,
-- access tokens, public codes and image paths.

-- 1. Resumen de jobs creados en las últimas 24 horas.
select
  date_trunc('hour', created_at) as hour_utc,
  status,
  count(*)::bigint as jobs
from public.jobs
where created_at >= now() - interval '24 hours'
group by 1, 2
order by 1, 2;

-- 2. Distribución de payment_status en las últimas 24 horas.
select
  coalesce(payment_status, 'NULL') as payment_status,
  count(*)::bigint as jobs
from public.jobs
where created_at >= now() - interval '24 hours'
group by 1
order by 1;

-- 3. Conteo de jobs fallidos en las últimas 24 horas.
select count(*)::bigint as failed_jobs
from public.jobs
where status = 'failed'
  and created_at >= now() - interval '24 hours';

-- 4. Pagos aprobados cuyo job todavía no está completado.
select count(*)::bigint as approved_without_completed_job
from public.jobs
where payment_status = 'approved'
  and status <> 'completed';

-- 5. Jobs processing durante más de 15 minutos según updated_at.
select count(*)::bigint as processing_over_15_minutes
from public.jobs
where status = 'processing'
  and updated_at < now() - interval '15 minutes';

-- 6. Jobs con email de resultado fallido en las últimas 24 horas.
select count(*)::bigint as result_email_failed
from public.jobs
where email_status = 'failed'
  and updated_at >= now() - interval '24 hours';

-- 7. Confirmaciones contractuales fallidas en las últimas 24 horas.
select count(*)::bigint as confirmation_email_failed
from public.legal_acceptances
where confirmation_email_status = 'failed'
  and created_at >= now() - interval '24 hours';

-- 8. Aceptaciones legales creadas en las últimas 24 horas por estado de correo.
select
  date_trunc('hour', accepted_at) as hour_utc,
  confirmation_email_status,
  count(*)::bigint as legal_acceptances
from public.legal_acceptances
where accepted_at >= now() - interval '24 hours'
group by 1, 2
order by 1, 2;

-- 9. Jobs Legal Center v1 con y sin aceptación legal persistida.
-- La estructura real identifica estos jobs mediante metadata JSON.
select
  count(*) filter (where la.job_id is not null)::bigint as legal_v1_with_acceptance,
  count(*) filter (where la.job_id is null)::bigint as legal_v1_without_acceptance
from public.jobs as j
left join public.legal_acceptances as la on la.job_id = j.id
where j.metadata ->> 'legal_center_checkout' = 'v1'
  and j.metadata ->> 'legal_center_version' is not null;

-- 10. Jobs completados con resultado pero sin inicio de retención.
select count(*)::bigint as completed_without_retention_start
from public.jobs
where status = 'completed'
  and output_image_path is not null
  and media_retention_started_at is null;

-- 11. Media con retención vencida y sin marca de purge.
select count(*)::bigint as retention_over_30_days_not_purged
from public.jobs
where media_retention_started_at < now() - interval '30 days'
  and media_retention_started_at is not null
  and media_purged_at is null;

-- 12. Conteo agregado de Customer.
select count(*)::bigint as customers
from public.customers;

-- 13. Conteo agregado de SGX PASS.
select count(*)::bigint as sgx_passes
from public.sgx_passes;

-- 14. Orders recientes por estado, sin exponer payment IDs.
select
  date_trunc('hour', created_at) as hour_utc,
  status,
  count(*)::bigint as orders
from public.orders
where created_at >= now() - interval '24 hours'
group by 1, 2
order by 1, 2;

