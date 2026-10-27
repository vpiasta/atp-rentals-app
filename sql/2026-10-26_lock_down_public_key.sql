-- 2026-10-26 — Lock down what the public (publishable) key can do.
-- Apply ONLY after the server.js that uses supabaseAdmin for listings,
-- membership_applications, password_reset_tokens, settings and listing_events is live.
--
-- Before: anyone with the public key could read every column of listings
-- (member_password, rep_cedula, ruc, documents, notes…), insert and update any listing,
-- update membership applications, and list blog preview tokens.
-- After: the public key can only READ the columns the public PHP pages show.

-- ── listings: read-only, public columns only ──
drop policy if exists "Allow inserts" on public.listings;
drop policy if exists "Allow updates" on public.listings;
drop policy if exists "No deletes allowed on listings" on public.listings;
-- "Allow reads for everyone" (SELECT, all rows) stays; columns are limited by the grant below.
revoke all on public.listings from anon, authenticated;
grant select (
    id, created_at, name, phone, email, province, rental_type, atp_active,
    address, description_en, description_es, photos, website_url, booking_url,
    is_member, membership_paid_until, slug, custom_links, phone_member, email_member,
    registry_source, apatel_member, feature_rank, listing_keywords
) on public.listings to anon, authenticated;

-- ── membership_applications: server-only ──
drop policy if exists "Allow application inserts" on public.membership_applications;
drop policy if exists "Allow application updates" on public.membership_applications;
drop policy if exists "Allow public inserts" on public.membership_applications;
revoke all on public.membership_applications from anon, authenticated;

-- ── password_reset_tokens: server-only (had no policies; remove table rights too) ──
revoke all on public.password_reset_tokens from anon, authenticated;

-- ── blog_preview_tokens: checked by blog-post.php with the server key ──
drop policy if exists "Allow public read of preview tokens" on public.blog_preview_tokens;
revoke all on public.blog_preview_tokens from anon, authenticated;

-- ── settings (holds admin_ip): server-only ──
drop policy if exists "Allow public read" on public.settings;
revoke all on public.settings from anon, authenticated;

-- ── listing_events: written by server.js only ──
drop policy if exists "Allow public insert" on public.listing_events;
revoke all on public.listing_events from anon, authenticated;

notify pgrst, 'reload schema';
