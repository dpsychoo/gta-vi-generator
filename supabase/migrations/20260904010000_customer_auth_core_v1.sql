-- PROPOSED ONLY: SGODX CUSTOMER AUTH CORE v1.
-- Apply only after the existing Customer identity schema is approved.
-- This migration owns reusable Customer authentication infrastructure only.
-- No token, session, rate-limit key, or secret is seeded here.

create table if not exists public.customer_auth_tokens (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  token_hash text not null,
  purpose text not null default 'customer_login',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint customer_auth_tokens_token_hash_key unique (token_hash),
  constraint customer_auth_tokens_purpose_format_check check (
    purpose ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  constraint customer_auth_tokens_expiry_check check (expires_at > created_at)
);

create index if not exists customer_auth_tokens_customer_purpose_idx
  on public.customer_auth_tokens (customer_id, purpose, created_at desc);

create index if not exists customer_auth_tokens_active_idx
  on public.customer_auth_tokens (purpose, expires_at)
  where used_at is null;

create table if not exists public.customer_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  session_token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz,
  constraint customer_sessions_token_hash_key unique (session_token_hash),
  constraint customer_sessions_expiry_check check (expires_at > created_at)
);

create index if not exists customer_sessions_customer_idx
  on public.customer_sessions (customer_id, created_at desc);

create index if not exists customer_sessions_active_idx
  on public.customer_sessions (expires_at)
  where revoked_at is null;

create table if not exists public.customer_auth_rate_limits (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  key_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  blocked_until timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint customer_auth_rate_limits_scope_key unique (scope, key_hash),
  constraint customer_auth_rate_limits_scope_check check (scope in ('email', 'ip')),
  constraint customer_auth_rate_limits_count_check check (request_count >= 0)
);

create index if not exists customer_auth_rate_limits_blocked_idx
  on public.customer_auth_rate_limits (blocked_until)
  where blocked_until is not null;

alter table public.customer_auth_tokens enable row level security;
alter table public.customer_sessions enable row level security;
alter table public.customer_auth_rate_limits enable row level security;
