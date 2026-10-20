-- Ranking seniority: start date of the CURRENT continuous membership
-- (trial + paid without a gap > 7 days count as one period).
-- Run ONCE in Supabase (SQL editor) BEFORE deploying the server.js that
-- ranks by member_since.
alter table public.listings add column if not exists member_since date;
alter table public.listings add column if not exists membership_ended date;
comment on column public.listings.member_since is 'Start of current continuous membership (trial counts if followed within 7 days). Maintained by trigger tps_track_member_since. Used for feature_rank ordering.';
comment on column public.listings.membership_ended is 'Latest membership/trial end date ever held. Maintained by trigger tps_track_member_since (survives membership_paid_until being cleared on demotion).';

create or replace function public.tps_track_member_since() returns trigger
language plpgsql set search_path = public as $f$
declare
  was_active boolean := false;
  now_active boolean;
  last_end   date;
begin
  now_active := coalesce(NEW.is_member,false) and NEW.membership_paid_until is not null
                and NEW.membership_paid_until >= current_date;
  if TG_OP = 'INSERT' then
    if now_active and NEW.member_since is null then NEW.member_since := current_date; end if;
    return NEW;
  end if;
  was_active := coalesce(OLD.is_member,false) and OLD.membership_paid_until is not null
                and OLD.membership_paid_until >= current_date;
  last_end := greatest(OLD.membership_ended, OLD.membership_paid_until);
  NEW.membership_ended := greatest(NEW.membership_ended, last_end);
  if now_active and not was_active then
    -- (re)starting: keep seniority only if the previous period ended at most 7 days ago
    if NEW.member_since is null or last_end is null or current_date > last_end + 7 then
      NEW.member_since := current_date;
    end if;
  elsif now_active and NEW.member_since is null then
    NEW.member_since := current_date;
  end if;
  return NEW;
end $f$;

drop trigger if exists trg_tps_track_member_since on public.listings;
create trigger trg_tps_track_member_since
  before insert or update on public.listings
  for each row execute function public.tps_track_member_since();

-- Restore trial dates erased by paid approvals (they block a second free trial)
update public.listings l
   set trial_started_at = a.reviewed_at
  from (select distinct on (listing_id) listing_id, coalesce(reviewed_at, created_at) reviewed_at
          from public.membership_applications
         where membership_type = 'trial' and status in ('approved','archived') and listing_id is not null
         order by listing_id, created_at) a
 where l.id = a.listing_id and l.trial_started_at is null;

-- Backfill current members (from application history):
--   11134 Aparthotel Boquete: trial+paid approved 2026-06-14
--   11144 Casitas Vista Verde: trial 2026-07-20, ended 08-19, paid 08-23 (4-day gap, within grace)
--   11255 El Regalo: paid 2026-07-21
--   11066 Casa Cayuco: trial 07-24 ended 08-23, paid 10-20 (58-day gap) -> restarts
update public.listings set member_since = '2026-06-14' where id = 11134;
update public.listings set member_since = '2026-07-20' where id = 11144;
update public.listings set member_since = '2026-07-21' where id = 11255;
update public.listings set member_since = '2026-10-20' where id = 11066;
update public.listings set membership_ended = membership_paid_until
 where membership_paid_until is not null and membership_ended is null;

-- Apply the new order right away (server recalculates on the next event anyway)
update public.listings set feature_rank = 1 where id = 11134;
update public.listings set feature_rank = 2 where id = 11144;
update public.listings set feature_rank = 3 where id = 11255;
update public.listings set feature_rank = 4 where id = 11066;
