-- Applied to Supabase on 29 Oct 2026 (migration "listings_aviso_public_optin").
-- Members may choose to show their aviso de operación number (listings.license_number)
-- on their public listing. Off by default: for individuals the number contains their cédula.
alter table public.listings add column if not exists aviso_public boolean not null default false;

-- Public pages (anon key) never read license_number directly; they get it only through
-- this function, and only when the member opted in and the membership is active.
create or replace function public.listing_public_aviso(p_id integer)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select license_number
  from listings
  where id = p_id
    and aviso_public
    and license_number is not null
    and is_member
    and membership_paid_until >= current_date
$$;
revoke all on function public.listing_public_aviso(integer) from public;
grant execute on function public.listing_public_aviso(integer) to anon, authenticated;

-- ATP report link for listing pages: url + edition date only.
create or replace function public.atp_report_info()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'url',  pdf_url,
    'date', substring(pdf_url from '(\d{1,2}-\d{1,2}-\d{4})\.pdf$'))
  from pdf_meta
  where pdf_url ~ '^https?://'
  order by last_updated desc
  limit 1
$$;
revoke all on function public.atp_report_info() from public;
grant execute on function public.atp_report_info() to anon, authenticated;
