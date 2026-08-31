-- Execute this migration manually in Supabase SQL Editor.
-- Existing jobs remain without a capability and are rejected by the protected APIs.

alter table public.jobs
  add column if not exists access_token_hash text,
  add column if not exists access_token_encrypted text;

create index if not exists jobs_access_token_hash_idx
  on public.jobs (access_token_hash)
  where access_token_hash is not null;
