-- SGODX LEGAL CENTER v1: versioned checkout consent and media retention marker.
-- Additive only. Do not apply this file from the application runtime.

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  terms_version text not null,
  privacy_version text not null,
  refund_policy_version text not null,
  immediate_execution_accepted boolean not null,
  retract_exclusion_acknowledged boolean not null,
  accepted_at timestamptz not null,
  source text not null,
  confirmation_email_status text not null default 'pending',
  confirmation_sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint legal_acceptances_job_id_key unique (job_id),
  constraint legal_acceptances_immediate_execution_check check (immediate_execution_accepted is true),
  constraint legal_acceptances_retract_exclusion_check check (retract_exclusion_acknowledged is true),
  constraint legal_acceptances_confirmation_status_check check (confirmation_email_status in ('pending', 'sent', 'failed'))
);

alter table public.jobs
  add column if not exists media_retention_started_at timestamptz,
  add column if not exists media_purged_at timestamptz;

create index if not exists legal_acceptances_customer_id_idx
  on public.legal_acceptances (customer_id)
  where customer_id is not null;

create index if not exists legal_acceptances_accepted_at_idx
  on public.legal_acceptances (accepted_at);

create index if not exists legal_acceptances_confirmation_status_idx
  on public.legal_acceptances (confirmation_email_status)
  where confirmation_email_status <> 'sent';

create index if not exists jobs_media_retention_idx
  on public.jobs (media_retention_started_at, media_purged_at)
  where media_purged_at is null;

alter table public.legal_acceptances enable row level security;
