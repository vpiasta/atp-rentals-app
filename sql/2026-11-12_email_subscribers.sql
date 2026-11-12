-- Applied to Supabase (project caqdkxukezpckqphogwl) on 2026-11-12 via migration "email_subscribers_optin"
create table if not exists public.email_subscribers (
  id bigserial primary key,
  email text not null unique,
  name text,
  listing_id bigint,
  lang text not null default 'es',
  status text not null default 'pending' check (status in ('pending','confirmed','unsubscribed','contact')),
  source text,
  token uuid not null default gen_random_uuid() unique,
  consent_text text,
  consent_ip text,
  created_at timestamptz not null default now(),
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz
);
alter table public.email_subscribers enable row level security;
