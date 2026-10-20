-- Restart-proof email campaigns: every recipient is stored before sending.
-- Run ONCE in the Supabase SQL Editor BEFORE publishing the server.js that
-- uses it (without this table, campaigns are refused with a warning email).
create table if not exists public.campaign_recipients (
  id            bigserial primary key,
  campaign_id   bigint not null references public.campaigns(id) on delete cascade,
  email         text   not null,
  member        jsonb,
  status        text   not null default 'pending'
                check (status in ('pending','sending','sent','error')),
  attempted_at  timestamptz,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists campaign_recipients_queue_idx
  on public.campaign_recipients (campaign_id, status, id);

-- Server-only table: no access with the public key
alter table public.campaign_recipients enable row level security;
revoke all on public.campaign_recipients from anon, authenticated;

-- The 2026-09-11 campaign was cut off by a server restart after 752 of 1155
-- emails (752 'followup_sent' log entries that day); record it as such.
update public.campaigns
   set status = 'interrupted', sent_count = 752
 where id = 2 and status = 'sending';

notify pgrst, 'reload schema';
