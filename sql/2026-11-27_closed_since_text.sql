-- 2026-11-27 (already applied in Supabase by Claude): allow a year-only
-- "closed since" date. Column changed from date to text: 'YYYY-MM' or 'YYYY'.
-- The public-key column grant (25 Nov 2026) is kept by ALTER COLUMN TYPE.
alter table public.listings
  alter column closed_since type text using to_char(closed_since, 'YYYY-MM');
alter table public.listings
  add constraint listings_closed_since_format
  check (closed_since is null or closed_since ~ '^\d{4}(-(0[1-9]|1[0-2]))?(-01)?$');
notify pgrst, 'reload schema';
