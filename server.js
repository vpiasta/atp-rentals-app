// TrustedPanamaStays.com - server.js
// Updated to use Supabase database:
//   - On startup: serve from DB immediately, check PDF URL in background
//   - Only re-parse PDF when ATP publishes a new one (URL changes)
// env refresh June 2026

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
// pdfjs-dist v5 is ESM-only — no CommonJS build exists, so it must be loaded
// via dynamic import() even from this CommonJS file. Cached after first load
// so every call to parsePDFWithCoordinates() doesn't re-import.
let _pdfjsLib = null;
async function getPdfjsLib() {
    if (!_pdfjsLib) {
        _pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return _pdfjsLib;
}
const PDFJS_STANDARD_FONTS_URL = path.join(
    path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts'
) + '/';
const { supabase, supabaseAdmin } = require('./db');   // <-- Supabase client
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;
const https = require('https');
const http = require('http');
const APATEL_ROSTER = require('./apatel_emails.json');
const fs = require('fs');

app.use(cors());
// Default express.json() body-size limit is 100kb — too small for admin
// campaign sends with large recipient lists (e.g. ~1,150 rentals' worth of
// name/email/id/slug pushes the JSON body past 100kb). Raised to 5mb, which
// comfortably covers campaign payloads for years of growth.
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// Suppress PDF.js font warnings
const originalConsoleWarn = console.warn;
console.warn = function(...args) {
    if (args[0] && typeof args[0] === 'string' && args[0].includes('fetchStandardFontData')) {
        return;
    }
    originalConsoleWarn.apply(console, args);
};

// ─── In-memory state (still used for fast serving) ───────────────────────────
let CURRENT_RENTALS = [];
let PDF_URL = 'PDF URL not found';
let PDF_HEADING = 'Hospedajes Registrados - ATP';
let PDF_STATUS = "Not loaded";
let PDF_RENTALS = [];
let DATA_SOURCE = "";
let PENDING_ATP_DIFF = null; // set when a new PDF is parsed but not yet reviewed/applied

// ─── Column boundaries (unchanged) ───────────────────────────────────────────
const COLUMN_BOUNDARIES = {
    NOMBRE:   { start: 0,   end: 184 },
    MODALIDAD:{ start: 184, end: 265 },
    CORREO:   { start: 265, end: 481 },
    TELEFONO: { start: 481, end: 600 }
};


// ═════════════════════════════════════════════════════════════════════════════
//  DATABASE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

// Load all listings from Supabase into memory
async function loadListingsFromDB() {
    let allData = [];
    let from = 0;
    const BATCH = 1000;
    while (true) {
        const { data, error } = await supabase
            .from('listings')
            .select('*')
            .range(from, from + BATCH - 1);
        if (error) throw error;
        allData = allData.concat(data);
        if (data.length < BATCH) break;
        from += BATCH;
    }
    return allData;
}

// ── Compute what WOULD change, without writing anything — for admin review ──
async function computeAtpDiff(parsedRentals) {
    const normalize = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
    const normalizePhone = s => (s||'').replace(/\D/g,'');
    let existing = [];
    {
        let from = 0;
        const BATCH = 1000;
        while (true) {
            const { data, error } = await supabaseAdmin
                .from('listings')
                .select('id, name, province, phone, email, rental_type, atp_active, is_member')
                .or('registry_source.is.null,registry_source.neq.mici') // include NULL (native ATP listings) and anything not explicitly MiCI
                .range(from, from + BATCH - 1);
            if (error) throw new Error(error.message);
            existing = existing.concat(data);
            if (data.length < BATCH) break;
            from += BATCH;
        }
      }
      const existingMap = new Map();
    (existing || []).forEach(l => existingMap.set(`${normalize(l.name)}|${normalize(l.province)}`, l));
    const seenIds = new Set();
    const toInsert = [];
    const toReactivate = [];
    let tempIdCounter = 0;
    for (const rental of parsedRentals) {
        const key   = `${normalize(rental.name)}|${normalize(rental.province)}`;
        const match = existingMap.get(key);
        if (match) {
            seenIds.add(match.id);
            if (!match.atp_active) toReactivate.push({ id: match.id, name: match.name });
        } else {
            toInsert.push({
                tempId:      tempIdCounter++,
                name:        rental.name,
                province:    rental.province,
                phone:       rental.phone || '',
                email:       rental.email || '',
                rental_type: rental.rental_type || ''
            });
        }
    }
    const missing = (existing || []).filter(l => l.atp_active && !seenIds.has(l.id));
    const mapDropped = l => ({
        id: l.id, name: l.name, province: l.province,
        phone: l.phone || '', email: l.email || '', rental_type: l.rental_type || ''
    });
    const toDeactivateNonMembers = missing.filter(l => !l.is_member).map(mapDropped);
    const toFlagMembers          = missing.filter(l => l.is_member).map(mapDropped);

    // Flag likely renames: same normalized phone on both a "new" and a "dropped"
    // entry. Purely a UI hint for admin review — never auto-applied.
    const droppedByPhone = new Map();
    [...toDeactivateNonMembers, ...toFlagMembers].forEach(d => {
        const p = normalizePhone(d.phone);
        if (p.length >= 7) droppedByPhone.set(p, d.id);
    });
    toInsert.forEach(n => {
        const p = normalizePhone(n.phone);
        if (p.length >= 7 && droppedByPhone.has(p)) n.possibleMatchId = droppedByPhone.get(p);
    });

    return { toInsert, toReactivate, toDeactivateNonMembers, toFlagMembers, totalParsed: parsedRentals.length };
}

// ── Email the owner whenever a new/unreviewed ATP diff is waiting ──
async function notifyAtpDiffPending(diff) {
    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    const subject = `ATP report updated — ${diff.toInsert.length} new, ${diff.toDeactivateNonMembers.length + diff.toFlagMembers.length} dropped — review needed`;

    const listOrNone = (arr) => arr.length
        ? '<ul style="margin:0.3rem 0 0 1.2rem;">' + arr.map(x => `<li>${x.name}${x.id?` (ID: ${x.id})`:''}</li>`).join('') + '</ul>'
        : '<p style="color:#888;margin:0.3rem 0 0 0.2rem;">— ninguno —</p>';

        const message = `
    <html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;margin:0;padding:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="margin:0 auto 1.5rem;">
        <tr><td bgcolor="#005ca9" style="background-color:#005ca9;" width="600">
            <img src="https://trustedpanamastays.com/images/email-header.png" alt="Trusted Panama Stays — El reporte de la ATP ha sido actualizado" width="600" style="display:block;width:600px;border:0;color:#ffffff;font-size:22px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;text-align:center;padding:40px 20px;background-color:#005ca9;">
        </td></tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="margin:0 auto;">
        <tr><td height="20" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
        <tr><td style="padding:0 20px;">
    <p style="margin-top:0;">La ATP publicó un nuevo reporte de hospedajes vigentes. Aquí un resumen de los cambios detectados — <strong>nada se ha aplicado todavía</strong>, requiere su revisión en el panel de admin:</p>
    <div style="background:#f0f7ff;border:1px solid #c0d8f0;border-radius:8px;padding:1rem;margin:1rem 0;">
        <strong style="color:#005ca9;">➕ Nuevos hospedajes (${diff.toInsert.length})</strong>
        ${listOrNone(diff.toInsert)}
    </div>
    <div style="background:#f0f7ff;border:1px solid #c0d8f0;border-radius:8px;padding:1rem;margin:1rem 0;">
        <strong style="color:#005ca9;">🔄 Reactivados (${diff.toReactivate.length})</strong>
        ${listOrNone(diff.toReactivate)}
    </div>
    <div style="background:#f5f5f5;border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0;">
        <strong style="color:#555;">➖ Ya no en el reporte — no miembros (${diff.toDeactivateNonMembers.length})</strong>
        ${listOrNone(diff.toDeactivateNonMembers)}
    </div>
    ${diff.toFlagMembers.length ? `
    <div style="background:#fde8e8;border:1px solid #ffcccc;border-radius:8px;padding:1rem;margin:1rem 0;">
        <strong style="color:#cc0000;">⚠️ Miembros pagos ya no en el reporte (${diff.toFlagMembers.length})</strong>
        <p style="font-size:0.82rem;color:#a00;margin:0.3rem 0 0;">Su membresía NO será modificada automáticamente.</p>
        ${listOrNone(diff.toFlagMembers)}
    </div>` : ''}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:1.5rem auto;">
        <tr><td style="background-color:#005ca9;border-radius:10px;padding:16px 40px;" align="center">
            <a href="https://trustedpanamastays.com/admin.html?from=AtpUpdate" style="color:white;text-decoration:none;font-weight:700;font-size:1.1rem;display:inline-block;">📋 Revisar en el panel de admin →</a>
        </td></tr>
    </table>
    <p style="text-align:center;">
        <span style="font-size:0.72rem;color:#999;">
            Este botón lo lleva a: trustedpanamastays.com/admin.html<br>
            (el enlace pasa por nuestro proveedor de correo, por eso la URL visible es distinta)
        </span>
    </p>
    <hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
    <p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>
        </td></tr>
    </table>
    </body></html>`;

    await execFileAsync('php', [notifyPath, subject, message, 'info@trustedpanamastays.com']).catch(err =>
        console.error('ATP diff notification email failed:', err.message)
    );
}


// ── Merge parsed ATP rentals into the DB without erasing collected member data ──
// Matches on normalized name+province (ATP's PDF has no stable ID — the aviso de
// operación number isn't published in the report). Inserts new listings, marks
// matched ones as seen, and soft-deletes (atp_active=false) anything no longer
// in the report. Never hard-deletes — members enrich data beyond what ATP provides.
async function mergeListingsWithDB(parsedRentals) {
    const nowIso = new Date().toISOString();
    const normalize = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();

    let existing = [];
    {
        let from = 0;
        const BATCH = 1000;
        while (true) {
            const { data, error } = await supabaseAdmin
                .from('listings')
                .select('id, name, province, atp_active, is_member')
                .or('registry_source.is.null,registry_source.neq.mici') // include NULL (native ATP listings) and anything not explicitly MiCI
                .range(from, from + BATCH - 1);
            if (error) throw new Error(error.message);
            existing = existing.concat(data);
            if (data.length < BATCH) break;
            from += BATCH;
        }
      }
      const existingMap = new Map();
      (existing || []).forEach(l => existingMap.set(`${normalize(l.name)}|${normalize(l.province)}`, l));
      const seenIds = new Set();
      let inserted = 0, updated = 0;

    for (const rental of parsedRentals) {
        const key   = `${normalize(rental.name)}|${normalize(rental.province)}`;
        const match = existingMap.get(key);

        if (match) {
            seenIds.add(match.id);
            const updates = { atp_last_seen: nowIso };
            if (!match.atp_active) updates.atp_active = true; // reappeared — clear any stale flag
            if (!match.atp_active) updates.atp_review_flagged_at = null;
            await supabaseAdmin.from('listings').update(updates).eq('id', match.id);
            updated++;
        } else {
            const { error: insertErr } = await supabaseAdmin.from('listings').insert({
                name:            rental.name,
                rental_type:     rental.rental_type,
                email:           rental.email,
                phone:           rental.phone,
                province:        rental.province,
                registry_source: 'atp',
                atp_active:      true,
                atp_first_seen:  nowIso,
                atp_last_seen:   nowIso
            });
            if (insertErr) console.error('Insert failed for', rental.name, insertErr.message);
            else inserted++;
        }
    }

    // Anything previously active but not seen in this PDF is no longer ATP-listed
    const missing = (existing || []).filter(l => l.atp_active && !seenIds.has(l.id));
    let deactivatedNonMembers = 0, flaggedMembers = 0;

    for (const l of missing) {
        await supabaseAdmin.from('listings').update({ atp_active: false }).eq('id', l.id);

        if (!l.is_member) {
            deactivatedNonMembers++; // no longer publicly visible — normal delisting
            continue;
        }

        // Supporting (paying) member dropped from ATP — flag for review, don't touch membership
        await supabaseAdmin.from('listings').update({ atp_review_flagged_at: nowIso }).eq('id', l.id);
        flaggedMembers++;
        await sendAtpReviewEmail(l.id, l.name);
        await logEvent('atp_member_flagged_for_review', { listing_id: l.id, name: l.name });
    }

    console.log(`✅ Merge complete: ${inserted} inserted, ${updated} matched, ${deactivatedNonMembers} non-members deactivated, ${flaggedMembers} members flagged for review`);
    return { inserted, updated, deactivatedNonMembers, flaggedMembers };
}

// ── Notify admin + member when a supporting member's listing drops off ATP ──
async function sendAtpReviewEmail(listingId, propertyName) {
    const { data: listing } = await supabaseAdmin
        .from('listings')
        .select('email_member, email, contact_name')
        .eq('id', listingId)
        .single();

    const memberEmail = listing?.email_member || listing?.email;
    const contactName = listing?.contact_name || 'propietario/a';
    const notifyPath   = path.join(__dirname, 'public', 'notify.php');

    // Notify TPS admin regardless of whether the member has an email
    const adminMsg = `<p>El hospedaje miembro <strong>${propertyName}</strong> (ID: ${listingId}) ya no aparece en el reporte vigente de la ATP.</p><p>Su membresía NO ha sido modificada. Requiere revisión manual.</p>`;
    await execFileAsync('php', [notifyPath, `⚠️ Miembro fuera del registro ATP — ${propertyName}`, adminMsg, 'info@trustedpanamastays.com']).catch(console.error);

    if (memberEmail && memberEmail.includes('@')) {
        const memberMsg = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
</div>
<p>Estimado/a <strong>${contactName}</strong>,</p>
<p>Notamos que <strong>${propertyName}</strong> ya no aparece en el reporte vigente de hospedajes de la ATP.</p>
<p>Su membresía en Trusted Panama Stays <strong>sigue activa</strong> — esto no la afecta. Sin embargo, nos gustaría confirmar con usted si su registro ante la ATP sigue vigente, o si hubo algún cambio.</p>
<p>¿Podría confirmarnos la situación respondiendo a este correo?</p>
<p>Preguntas? <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>
</body></html>`;
        await execFileAsync('php', [notifyPath, `Consulta sobre su registro ATP — ${propertyName}`, memberMsg, memberEmail]).catch(console.error);
    }
}

// Update pdf_meta with the new URL
async function savePdfMeta(pdfUrl, pdfHeading) {
    // Try update first, then insert if no row exists.
    // Uses supabaseAdmin — the anon client's writes were being silently blocked
    // by RLS (no error thrown, but zero rows actually affected), which is why
    // pdf_meta was frozen at a stale "force-reload" placeholder since 2026-06-05
    // despite every apply-atp-diff run logging a false "✅ pdf_meta updated".
    const existing = await getSavedPdfUrl();
    if (existing) {
        const { data, error } = await supabaseAdmin
            .from('pdf_meta')
            .update({ pdf_url: pdfUrl, pdf_heading: pdfHeading, last_updated: new Date().toISOString() })
            .eq('id', existing.id)
            .select();
        if (error) throw error;
        if (!data || data.length === 0) throw new Error('pdf_meta update affected 0 rows — check RLS policy for id=' + existing.id);
    } else {
        const { data, error } = await supabaseAdmin
            .from('pdf_meta')
            .insert({ pdf_url: pdfUrl, pdf_heading: pdfHeading, last_updated: new Date().toISOString() })
            .select();
        if (error) throw error;
        if (!data || data.length === 0) throw new Error('pdf_meta insert returned no row');
    }
    console.log('✅ pdf_meta updated in Supabase (confirmed via .select())');
}

// Get the saved PDF URL from pdf_meta table
async function getSavedPdfUrl() {
    const { data, error } = await supabaseAdmin
        .from('pdf_meta')
        .select('*')
        .limit(1)
        .single();
    if (error) return null;
    return data;   // { id, pdf_url, pdf_heading, last_updated }
}


// ═════════════════════════════════════════════════════════════════════════════
//  STARTUP LOGIC
// ═════════════════════════════════════════════════════════════════════════════

async function initializeData() {
    console.log('🚀 Starting TrustedPanamaStays server...');

    // STEP 1: Load from database immediately so the site responds fast
    try {
        const dbListings = await loadListingsFromDB();
        if (dbListings && dbListings.length > 0) {
            CURRENT_RENTALS = dbListings;
            DATA_SOURCE = 'supabase';
            PDF_STATUS = `Loaded ${dbListings.length} listings from database`;
            console.log(`✅ STEP 1: Loaded ${dbListings.length} listings from Supabase — site is live`);

            // Also restore the saved PDF URL and heading
            const meta = await getSavedPdfUrl();
            if (meta) {
                PDF_URL = meta.pdf_url || PDF_URL;
                PDF_HEADING = meta.pdf_heading || PDF_HEADING;
                console.log(`✅ STEP 1: Restored PDF meta: ${PDF_URL}`);
            }
        } else {
            console.log('ℹ️  STEP 1: Database is empty — will parse PDF now');
        }
    } catch (err) {
        console.error('❌ STEP 1: Could not load from Supabase:', err.message);
    }

    // STEP 2: Check ATP for a new PDF in the background (don't block startup)
    checkForPdfUpdate().catch(err =>
        console.error('❌ Background PDF check failed:', err.message)
    );
}

let PDF_CHECK_IN_PROGRESS = false; // prevents overlapping runs (e.g. GitHub Actions curl retries) from re-parsing and re-emailing

// Background check: only re-parses PDF when the URL has changed
async function checkForPdfUpdate() {
    if (PDF_CHECK_IN_PROGRESS) {
        console.log('⏭️  STEP 2: Check already in progress — skipping overlapping run');
        return;
    }
    PDF_CHECK_IN_PROGRESS = true;
    console.log('🔄 STEP 2: Checking ATP for PDF updates (background)...');
    try {
        const atpResult = await getLatestPdfUrl();
        const newUrl = atpResult.pdfUrl;
        if (!newUrl) {
            console.log('⚠️  Could not retrieve PDF URL from ATP — skipping update');
            return;
        }
        // Compare with what's saved in the database
        const meta = await getSavedPdfUrl();
        const savedUrl = meta ? meta.pdf_url : null;
        if (newUrl === savedUrl && CURRENT_RENTALS.length > 0) {
            console.log('✅ STEP 2: PDF URL unchanged — using existing database data');
            PDF_URL = newUrl;
            PDF_HEADING = atpResult.headingText || PDF_HEADING;
            return;
        }
        // A diff for this exact URL is already pending admin review — don't
        // re-parse the whole PDF and re-send the notification email every
        // time this runs again before it's been reviewed.
        if (PENDING_ATP_DIFF && PENDING_ATP_DIFF.newUrl === newUrl) {
            console.log('⏭️  STEP 2: Diff for this PDF is already pending admin review — skipping re-parse and re-notification');
            return;
        }
        // URL has changed (or DB was empty) — re-parse the PDF
        console.log(`🆕 STEP 2: New PDF detected!`);
        console.log(`   Old: ${savedUrl}`);
        console.log(`   New: ${newUrl}`);
        // Temporarily set URL so parsePDFWithCoordinates picks it up
        PDF_URL = newUrl;
        PDF_HEADING = atpResult.headingText || PDF_HEADING;
        const result = await parsePDFWithCoordinates();
        if (result.success && PDF_RENTALS.length > 0) {
            // Compute what would change, but wait for admin review before writing/emailing
            const diff = await computeAtpDiff(PDF_RENTALS);
            PENDING_ATP_DIFF = {
                newUrl, newHeading: PDF_HEADING,
                parsedRentals: PDF_RENTALS,
                diff,
                computedAt: new Date().toISOString()
            };
            await logEvent('atp_diff_pending', {
                new_url: newUrl,
                inserts: diff.toInsert.length,
                reactivations: diff.toReactivate.length,
                deactivations: diff.toDeactivateNonMembers.length,
                flagged_members: diff.toFlagMembers.length
            });
            console.log(`📋 STEP 2: New PDF parsed — ${diff.toInsert.length} new, ${diff.toReactivate.length} reactivated, ${diff.toDeactivateNonMembers.length} to deactivate, ${diff.toFlagMembers.length} members flagged — awaiting admin review`);
            const hasChanges = diff.toInsert.length + diff.toReactivate.length + diff.toDeactivateNonMembers.length + diff.toFlagMembers.length > 0;
            if (hasChanges) {
                await notifyAtpDiffPending(diff);
            } else {
                console.log('📋 STEP 2: No actual changes in this diff — skipping notification email');
            }
        }
    } catch (err) {
        console.error('❌ STEP 2: PDF update check failed:', err.message);
        // If we already have data from STEP 1, keep serving it — no problem
    } finally {
        PDF_CHECK_IN_PROGRESS = false;
    }
}

async function checkPendingAtpApplications() {
    console.log('🔄 Checking pending ATP applications...');
    try {
        // Get all applications waiting for ATP registration
        const { data: pending, error } = await supabase
            .from('membership_applications')
            .select('*')
            .eq('status', 'pending_atp')
            .eq('auto_activate', true);

        if (error || !pending || pending.length === 0) {
            console.log('ℹ️  No pending ATP applications to check');
            return;
        }

        console.log(`🔍 Found ${pending.length} pending ATP application(s)`);
        const bcrypt = require('bcrypt');
        const notifyPath = require('path').join(__dirname, 'public', 'notify.php');

        for (const app of pending) {
            // Try to find matching listing by name similarity
            // Normalize accents for matching
            const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
            const appWords = normalize(app.property_name).split(/\s+/).filter(w => w.length >= 3);
            const { data: candidates } = await supabaseAdmin
                .from('listings')
                .select('id, name, province, is_member')
                .limit(2000);
            const scored = (candidates||[]).map(l => {
                const lName = normalize(l.name);
                const wordMatches = appWords.filter(w => lName.includes(w)).length;
                const provinceBonus = l.province === app.province ? 1 : 0;
                return { ...l, score: wordMatches * 10 + provinceBonus };
                }).filter(l => {
                  const lWords = normalize(l.name).split(/\s+/).filter(w => w.length >= 3);
                  const required = Math.min(2, appWords.length, lWords.length) * 10;
                  return l.score >= required;
                })
              .sort((a,b) => b.score - a.score);
            if (!scored.length) {
                console.log(`⏳ No ATP match yet for: ${app.property_name}`);
                continue;
            }
            // Use best match (first result)
            const listing = scored[0];

            // Skip if already a member
            if (listing.is_member) {
                console.log(`⚠️  Listing ${listing.id} already a member, skipping`);
                continue;
            }

            console.log(`✅ Found ATP match for ${app.property_name}: ${listing.name} (ID: ${listing.id})`);

            // Generate password
            const chars    = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
            const password = Array.from({ length: 10 }, () =>
                chars[Math.floor(Math.random() * chars.length)]).join('');
            const hash = await bcrypt.hash(password, 10);

            // Set trial expiry to 30 days from now
            const paidUntil = new Date();
            paidUntil.setDate(paidUntil.getDate() + 30);
            const paidUntilStr = paidUntil.toISOString().split('T')[0];

            const baseSlug = app.property_name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            let slug = baseSlug;
            const { data: slugConflict } = await supabaseAdmin.from('listings').select('id, name').eq('slug', baseSlug).maybeSingle();
            if (slugConflict) {
                slug = baseSlug + '-' + listingId;
                const conflictMsg = `<p>El nuevo miembro <strong>${app.property_name}</strong> (ID: ${listingId}) tiene un conflicto de slug con el miembro existente <strong>${slugConflict.name}</strong> (ID: ${slugConflict.id}).</p><p>Slug en conflicto: <code>${baseSlug}</code></p><p>Se ha asignado temporalmente el slug <code>${slug}</code>. Por favor, asigne un slug más apropiado en el panel de administración.</p>`;
                const notifyPath = path.join(__dirname, 'public', 'notify.php');
                execFileAsync('php', [notifyPath, 'Conflicto de slug — ' + app.property_name, conflictMsg, 'info@trustedpanamastays.com'], { timeout: 15000 }).catch(console.error);
            }

            // Activate listing
            await supabase.from('listings').update({
                is_member:             true,
                is_trial:              true,
                trial_started_at:      new Date().toISOString(),
                membership_paid_until: paidUntilStr,
                member_password:       hash,
                contact_name:          app.contact_name,
                slug,
                invitation_status:     'member',
                verified_at:           new Date().toISOString(),
                verified_by:           'auto_atp'
            }).eq('id', listing.id);

            // Update application
            await supabaseAdmin.from('membership_applications').update({
                status:      'approved',
                listing_id:  listing.id,
                reviewed_at: new Date().toISOString(),
                reviewed_by: 'system_auto'
            }).eq('id', app.id);

            // Send welcome email
            const listingUrl = `https://trustedpanamastays.com/listing.html?id=${listing.id}&lang=es`;
            const payUrl     = `https://trustedpanamastays.com/pay.html`;

            const welcomeMsg = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">¡Buenas noticias de Trusted Panama Stays!</h1>
</div>
<p>Estimado/a <strong>${app.contact_name}</strong>,</p>
<p>Su hospedaje <strong>${listing.name}</strong> acaba de aparecer en el registro público de hospedajes de la ATP, y hemos activado automáticamente su membresía de prueba gratuita.</p>
<p>Su prueba está activa hasta el <strong>${paidUntilStr}</strong>.</p>
<h3 style="color:#005ca9;margin-top:1.2rem;">Sus datos de acceso:</h3>
<table style="border:1px solid #e1e5e9;border-radius:8px;background:#f8f9fa;width:100%;margin-bottom:1rem;">
    <tr><td style="padding:8px;font-weight:bold;">URL:</td>
        <td style="padding:8px;"><a href="${listingUrl}">${listingUrl}</a></td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Contraseña:</td>
        <td style="padding:8px;font-family:monospace;font-size:1.1rem;"><strong>${password}</strong></td></tr>
    <tr><td style="padding:8px;font-weight:bold;">N° membresía:</td>
        <td style="padding:8px;font-family:monospace;"><strong>${listing.id}</strong></td></tr>
</table>
<p style="background:#fffbe6;padding:1rem;border-radius:6px;border:1px solid #FFD700;margin-top:1rem;">
    <strong>⚠️ Recordatorio:</strong> Su prueba vence el <strong>${paidUntilStr}</strong>.
    Recibirá un recordatorio 5 días antes.<br>
    Para renovar: <a href="${payUrl}">${payUrl}</a> · N° membresía: <strong>${listing.id}</strong>
</p>
<p style="margin-top:1rem;">Para editar su listado, visite el enlace y haga clic en <strong>🔐 Acceso</strong>.</p>
<p>¿Preguntas? <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>
</body></html>`;

            const hasEmail = !!(app.contact_email && app.contact_email.includes('@'));
            if (hasEmail) {
                try {
                    await execFileAsync('php', [
                        notifyPath,
                        `¡Su hospedaje está activo en Trusted Panama Stays! — ${listing.name}`,
                        welcomeMsg,
                        app.contact_email
                    ], { timeout: 15000 });
                    console.log(`📧 Welcome email sent to ${app.contact_email}`);
                } catch (emailErr) {
                    console.error(`❌ Welcome email failed for ${app.contact_email}:`, emailErr.message);
                }
            }

            await logEvent('pending_atp_activated', {
                application_id: app.id,
                listing_id:     listing.id,
                property_name:  listing.name,
                paid_until:     paidUntilStr
            });

            console.log(`✅ Auto-activated: ${listing.name} (ID: ${listing.id})`);
        }

    } catch (err) {
        console.error('❌ checkPendingAtpApplications error:', err.message);
    }
}


// Call on startup
initializeData();


// ═════════════════════════════════════════════════════════════════════════════
//  ATP WEBSITE & PDF FUNCTIONS  (unchanged from original)
// ═════════════════════════════════════════════════════════════════════════════

// ── Extract the report's own update date from its filename, e.g.
// ".../REPORTE-HOSPEDAJES-VIGENTE-2-7-2026.pdf" → day 2, month 7, year 2026
function extractPdfDateFromUrl(url) {
    if (!url) return null;
    const match = url.match(/(\d{1,2})-(\d{1,2})-(\d{4})\.pdf$/i);
    if (!match) return null;
    const [, day, month, year] = match;
    const date = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function getLatestPdfUrl() {
    console.log('🔄 Fetching PDF URL via PHP...');

    // Write a small PHP script to a temp file and execute it
    const phpScript = `<?php
$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => 'https://www.atp.gob.pa/industrias/hoteleros/',
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
]);
$html = curl_exec($ch);
curl_close($ch);
preg_match('/<a[^>]+href="([^"]*\\.pdf)"[^>]*>\\s*Descargar PDF\\s*<\\/a>/i', $html, $matches);
if (!empty($matches[1])) {
    echo json_encode(['pdfUrl' => $matches[1]]);
} else {
    preg_match('/href="(https?:\\/\\/www\\.atp\\.gob\\.pa\\/[^"]*\\.pdf)"/i', $html, $matches2);
    if (!empty($matches2[1])) {
        echo json_encode(['pdfUrl' => $matches2[1]]);
    } else {
        echo json_encode(['error' => 'No PDF found']);
    }
}
?>`;

    const tmpFile = '/tmp/get_pdf_url.php';
    require('fs').writeFileSync(tmpFile, phpScript);

    const { stdout } = await execFileAsync('php', [tmpFile], { timeout: 20000 });
    const data = JSON.parse(stdout);

    if (data.error) throw new Error(data.error);
    if (!data.pdfUrl) throw new Error('No PDF URL returned');

    console.log('✅ PDF URL:', data.pdfUrl);
    return {
        pdfUrl: data.pdfUrl,
        headingText: 'Hospedajes - Registrados por la Autoridad de Turismo de Panamá (ATP)'
    };
}
function extractPdfAndHeading(html, baseUrl) {
    console.log('🔍 Extracting PDF URL and heading...');

    // New ATP structure: simple anchor tag with .pdf href near "Descargar PDF" text
    // Matches: <a href="https://www.atp.gob.pa/.../something.pdf">Descargar PDF</a>
    const pdfLinkRegex = /<a[^>]+href="([^"]*\.pdf)"[^>]*>\s*Descargar PDF\s*<\/a>/i;
    const match = html.match(pdfLinkRegex);

    if (match) {
        const pdfUrl = new URL(match[1], baseUrl).href;
        console.log('✅ Found PDF URL:', pdfUrl);

        // Extract heading from h3 near "Registrados por"
        const headingText = extractHeadingTextImproved(html, baseUrl);
        return { pdfUrl, headingText, fullMatch: true };
    }

    // Fallback: find ANY .pdf link on the page from atp.gob.pa
    console.log('⚠️  Primary regex failed, trying fallback...');
    const fallbackRegex = /href="(https:\/\/www\.atp\.gob\.pa\/[^"]*\.pdf)"/i;
    const fallbackMatch = html.match(fallbackRegex);
    if (fallbackMatch) {
        console.log('✅ Fallback PDF URL found:', fallbackMatch[1]);
        return {
            pdfUrl: fallbackMatch[1],
            headingText: extractHeadingTextImproved(html, baseUrl),
            fullMatch: false
        };
    }

    console.log('❌ No PDF URL found');
    return { pdfUrl: null, headingText: null };
}

function extractHeadingTextImproved(html, baseUrl) {
    const h4Match = html.match(/<h4[^>]*>([^<]+)<\/h4>/i);
    const h3Match = html.match(/<h3[^>]*>([^<]+)<\/h3>/i);
    let headingParts = [];
    if (h4Match && h4Match[1]) headingParts.push(h4Match[1].trim());
    if (h3Match && h3Match[1]) headingParts.push(h3Match[1].trim());
    if (headingParts.length > 0) {
        const fullHeading = headingParts.join(' - ');
        console.log('📝 Extracted full heading:', fullHeading);
        return fullHeading;
    }
    const hospedajesIndex = html.indexOf('Hospedajes');
    if (hospedajesIndex !== -1) {
        const context = html.substring(Math.max(0, hospedajesIndex - 50), hospedajesIndex + 500);
        const dateMatch = context.match(/Actualizado al (\d+ de [a-z]+ de \d{4})/i);
        if (dateMatch) {
            return `Hospedajes - Registrados por la Autoridad de Turismo de Panamá (ATP). ${dateMatch[0]}`;
        }
    }
    return "Hospedajes - Registrados por la Autoridad de Turismo de Panamá (ATP)";
}

function extractHeadingText(html) {
    const h4Match = html.match(/<h4[^>]*>([^<]+)<\/h4>/i);
    const h3Match = html.match(/<h3[^>]*>([^<]+)<\/h3>/i);
    let headingText = 'Hospedajes';
    if (h4Match && h3Match) {
        headingText = `${h4Match[1].trim()} - ${h3Match[1].trim()}`;
    } else if (h3Match) {
        headingText = `Hospedajes - ${h3Match[1].trim()}`;
    }
    console.log('📝 Extracted heading text:', headingText);
    return headingText;
}

function extractHeadingTextFromContext(context) {
    const h3Match = context.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const h4Match = context.match(/<h4[^>]*>([^<]+)<\/h4>/);
    let headingParts = [];
    if (h4Match && h4Match[1]) headingParts.push(h4Match[1].trim());
    if (h3Match && h3Match[1]) headingParts.push(h3Match[1].trim());
    if (headingParts.length > 0) return headingParts.join(' - ');
    return "Hospedajes Registrados por la Autoridad de Turismo de Panamá (ATP)";
}

function extractFormattedDate(headingText) {
    try {
        console.log('📅 Extracting date from heading:', headingText);
        const datePatterns = [
            /Actualizado al (\d+ de [a-z]+ de \d{4})/i,
            /(\d+ de [a-z]+ de \d{4})/i,
        ];
        for (const pattern of datePatterns) {
            const match = headingText.match(pattern);
            if (match) {
                const dateStr = match[1];
                console.log('📅 Found date string:', dateStr);
                return convertSpanishDateToUS(dateStr);
            }
        }
        if (PDF_URL) {
            const urlDateMatch = PDF_URL.match(/\/(\d{4})\/(\d{2})\/.*?(\d{1,2})-(\d{1,2})-(\d{4})/);
            if (urlDateMatch) {
                const [, year, month, day] = urlDateMatch;
                const date = new Date(year, month - 1, day);
                return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            }
        }
        const currentDate = new Date();
        return currentDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch (error) {
        console.error('❌ Error extracting date:', error);
        return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
}

function convertSpanishDateToUS(spanishDate) {
    const months = {
        'enero': 'January', 'febrero': 'February', 'marzo': 'March', 'abril': 'April',
        'mayo': 'May', 'junio': 'June', 'julio': 'July', 'agosto': 'August',
        'septiembre': 'September', 'octubre': 'October', 'noviembre': 'November', 'diciembre': 'December'
    };
    const deMatch = spanishDate.match(/(\d+) de ([a-z]+) de (\d{4})/i);
    if (deMatch) {
        const [, day, monthEs, year] = deMatch;
        const monthEn = months[monthEs.toLowerCase()];
        if (monthEn) return `${monthEn} ${parseInt(day)}, ${year}`;
    }
    const slashMatch = spanishDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
        const [, day, month, year] = slashMatch;
        const date = new Date(year, month - 1, day);
        return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
    return spanishDate;
}

function groupIntoRows(textItems) {
    const rows = {};
    const Y_TOLERANCE = 1.5;
    textItems.forEach(item => {
        if (!item.text.trim()) return;
        const existingKey = Object.keys(rows).find(y => Math.abs(parseFloat(y) - item.y) <= Y_TOLERANCE);
        const rowY = existingKey || item.y.toString();
        if (!rows[rowY]) rows[rowY] = [];
        rows[rowY].push(item);
    });
    return Object.entries(rows)
        .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
        .map(([y, items]) => ({ y: parseFloat(y), items: items.sort((a, b) => a.x - b.x) }));
}

function parseRowData(row) {
    const rental = { name: '', rental_type: '', email: '', phone: '' };
    row.items.forEach(item => {
        if (item.x >= COLUMN_BOUNDARIES.NOMBRE.start && item.x < COLUMN_BOUNDARIES.NOMBRE.end) {
            rental.name += (rental.name ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.MODALIDAD.start && item.x < COLUMN_BOUNDARIES.MODALIDAD.end) {
            rental.rental_type += (rental.rental_type ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.CORREO.start && item.x < COLUMN_BOUNDARIES.CORREO.end) {
            rental.email += item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.TELEFONO.start && item.x < COLUMN_BOUNDARIES.TELEFONO.end) {
            rental.phone += (rental.phone ? ' ' : '') + item.text;
        }
    });
    rental.name = rental.name.trim();
    rental.rental_type = rental.rental_type.trim();
    rental.email = rental.email.trim();
    rental.phone = rental.phone.trim();
    return rental;
}

function isContinuationRow(rowData, previousRowData) {
    if (previousRowData.rental_type === 'Hostal' && rowData.rental_type === 'Familiar') return true;
    if (previousRowData.rental_type === 'Sitio de' && rowData.rental_type === 'acampar') return true;
    if (!rowData.rental_type) return true;
    if (previousRowData.email && rowData.email && !rowData.rental_type) {
        const complete = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(previousRowData.email);
        if (!complete) return true;
    }
    if (previousRowData.phone && rowData.phone && !rowData.rental_type) {
        if (previousRowData.phone.endsWith('-')) return true;
        if (previousRowData.phone.endsWith('/') && !rowData.phone.endsWith('/')) return true;
    }
    return false;
}

function mergeRentalRows(prev, cont) {
    const merged = { ...prev };
    if (cont.name) merged.name = (prev.name + ' ' + cont.name).trim();
    if (cont.rental_type) {
        if (prev.rental_type === 'Hostal' && cont.rental_type === 'Familiar') merged.rental_type = 'Hostal Familiar';
        else if (prev.rental_type === 'Sitio de' && cont.rental_type === 'acampar') merged.rental_type = 'Sitio de acampar';
    }
    if (cont.email) merged.email = (prev.email + cont.email).trim();
    if (cont.phone) {
        if (prev.phone.endsWith('/')) merged.phone = (prev.phone + ' ' + cont.phone).trim();
        else if (prev.phone.endsWith('-')) merged.phone = (prev.phone.slice(0, -1) + cont.phone).trim();
        else merged.phone = (prev.phone + ' ' + cont.phone).trim();
    }
    return merged;
}

function isHeaderRow(rowText) {
    if (rowText.includes('Reporte de Hospedajes vigentes') ||
        rowText.includes('Página') ||
        rowText.includes('Total por provincia') ||
        rowText.includes('rep_hos_web')) {
        return true;
    }
    if (rowText.includes('Nombre') && (rowText.includes('Modalidad') || rowText.includes('Correo'))) {
        return true;
    }
    return false;
}

// PDF parsing (unchanged logic, just called from checkForPdfUpdate now)
async function parsePDFWithCoordinates() {
    const startTime = Date.now();
    try {
        console.log('Starting parsePDFWithCoordinates()...');
        PDF_STATUS = "Downloading PDF...";

        // Download the PDF (PDF_URL already set by checkForPdfUpdate)
        let response;
        try {
            console.log('🔄 Trying direct PDF download...');
            response = await axios.get(PDF_URL, {
                responseType: 'arraybuffer',
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/pdf, */*',
                    'Referer': 'https://www.atp.gob.pa/'
                }
            });
            console.log('✅ Direct download successful');
        } catch (directError) {
            console.log('❌ Direct download failed, trying proxy...');
            const proxyPdfUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(PDF_URL)}`;
            response = await axios.get(proxyPdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            console.log('✅ Proxy download successful');
        }

        const data = new Uint8Array(response.data);
        if (!(data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)) {
            throw new Error('Invalid PDF format');
        }
        console.log('Processing PDF...');
        const pdfjsLib = await getPdfjsLib();
        const pdf = await pdfjsLib.getDocument({ data, standardFontDataUrl: PDFJS_STANDARD_FONTS_URL }).promise;
        const numPages = pdf.numPages;
        console.log(`PDF loaded with ${numPages} pages...`);

        const allRentals = [];
        let currentProvince = '';
        let currentRental = null;

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const textItems = textContent.items.map(item => ({
                text: item.str,
                x: Math.round(item.transform[4] * 100) / 100,
                y: Math.round(item.transform[5] * 100) / 100,
                page: pageNum
            }));

            const rows = groupIntoRows(textItems);
            console.log(`Page ${pageNum}: ${rows.length} rows found`);

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowText = row.items.map(item => item.text).join(' ');

                if (rowText.includes('Provincia:')) {
                    currentProvince = rowText.replace('Provincia:', '').replace(/Total.*/, '').trim();
                    console.log(`Found province: ${currentProvince}`);
                    continue;
                }
                if (isHeaderRow(rowText) || !currentProvince) continue;
                if (rowText.includes('Total por')) continue;

                const rowData = parseRowData(row);

                if (currentRental && isContinuationRow(rowData, currentRental)) {
                    currentRental = mergeRentalRows(currentRental, rowData);
                    continue;
                }
                if (currentRental && rowData.name && rowData.name.trim() &&
                    (rowData.type || rowData.email || rowData.phone)) {
                    allRentals.push(currentRental);
                    currentRental = { ...rowData, province: currentProvince };
                } else if (!currentRental && rowData.name && rowData.name.trim() &&
                           (rowData.type || rowData.email || rowData.phone)) {
                    currentRental = { ...rowData, province: currentProvince };
                } else if (!currentRental && rowData.name && rowData.name.trim()) {
                    currentRental = { ...rowData, province: currentProvince };
                }
            }
        }

        if (currentRental) allRentals.push(currentRental);

        PDF_RENTALS = allRentals;
        PDF_STATUS = `PDF parsed: ${allRentals.length} rentals found from ${numPages} pages`;
        console.log(`✅ ${PDF_STATUS}`);
        return { success: true, rentals: allRentals.length };

    } catch (error) {
        console.error(`❌ PDF parsing failed:`, error.message);
        PDF_STATUS = `PDF parsing failed: ${error.message}`;
        throw error;
    }
}


// ═════════════════════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', (req, res) => {
    try {
        res.json({
            total_rentals: CURRENT_RENTALS.length,
            last_updated: new Date().toISOString(),
            status: PDF_STATUS || "Data Loaded",
            features: "Search by name, type, province",
            data_source: DATA_SOURCE || 'unknown'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load statistics', total_rentals: 0 });
    }
});


app.get('/api/provinces', async (req, res) => {
    // Start with ATP in-memory counts
    const provinceCounts = CURRENT_RENTALS.reduce((acc, rental) => {
        if (rental.province) acc[rental.province] = (acc[rental.province] || 0) + 1;
        return acc;
    }, {});

    // Add MiCI listings from database
    try {
        const { data: miciListings } = await supabase
            .from('listings')
            .select('province')
            .eq('registry_source', 'mici')
            .eq('atp_active', false);

        if (miciListings) {
            miciListings.forEach(r => {
                if (r.province) provinceCounts[r.province] = (provinceCounts[r.province] || 0) + 1;
            });
        }
    } catch (err) {
        console.error('Error fetching MiCI province counts:', err.message);
    }

    const provinces = Object.entries(provinceCounts)
        .map(([province, count]) => ({ province, count }))
        .sort((a, b) => a.province.localeCompare(b.province));

    res.json(provinces);
});

app.get('/api/types', (req, res) => {
    const types = [...new Set(CURRENT_RENTALS.map(r => r.rental_type))].filter(Boolean).sort();
    res.json(types);
});

app.get('/api/rentals', async (req, res) => {
    const { search, province, type, keyword } = req.query;

    // Enrich ATP-sourced rentals with member-edited data BEFORE filtering, so
    // search (and type/province filters) can match either the original ATP
    // registry value or the member-corrected value.
    let enriched = CURRENT_RENTALS;
    try {
        const ids = CURRENT_RENTALS.map(r => r.id).filter(Boolean);
        if (ids.length > 0) {
            let memberData = [];
            let from = 0;
            const BATCH = 1000;
            while (true) {
                const { data, error } = await supabase
                    .from('listings')
                    .select('id, phone_member, email_member, address, photos, is_member, membership_paid_until, slug, rental_type, apatel_member, feature_rank, listing_keywords')
                    .in('id', ids)
                    .range(from, from + BATCH - 1);
                if (error) throw error;
                memberData = memberData.concat(data);
                if (data.length < BATCH) break;
                from += BATCH;
            }
            const memberMap = {};
            memberData.forEach(m => { memberMap[m.id] = m; });
            enriched = CURRENT_RENTALS.map(r => {
                const m = memberMap[r.id];
                if (!m) return r;
                return {
                    ...r,
                    phone_member:          m.phone_member || null,
                    email_member:          m.email_member || null,
                    address:               m.address || null,
                    photos:                m.photos || null,
                    is_member:             m.is_member || false,
                    membership_paid_until: m.membership_paid_until || null,
                    slug:                  m.slug || null,
                    rental_type:           m.rental_type || r.rental_type,
                    feature_rank:          m.feature_rank || 0,
                    listing_keywords:      m.listing_keywords || [],
                    apatel_member:         m.apatel_member || false
                };
            });
        }
    } catch (err) {
        console.error('Error enriching rentals with member data:', err.message);
    }

    let filtered = [...enriched];

    // Apply filters to ATP listings
    if (search) {
        // Direct ID or phone search — strip common phone formatting (spaces, hyphens, dots, slashes)
        // so a number can be typed any way and still match.
        const idSearch = search.replace('#','').trim();
        const digitsOnly = idSearch.replace(/[\s\-\.\/]/g, '');
        const isNumericSearch = digitsOnly.length > 0 && /^\d+$/.test(digitsOnly);

        if (isNumericSearch && digitsOnly.length <= 5) {
            // Short numeric input — treat as a listing ID
            const idMatch = filtered.find(r => String(r.id) === digitsOnly);
            filtered = idMatch ? [idMatch] : [];
        } else if (isNumericSearch && digitsOnly.length >= 7) {
            // Longer numeric input — treat as a phone number. Check both the
            // ATP-registry phone AND the member-edited phone, comparing digits-only
            // on both sides so formatting (spaces/hyphens/dots) never matters.
            filtered = filtered.filter(r => {
                const atpDigits    = (r.phone||'').replace(/[^\d]/g,'');
                const memberDigits = (r.phone_member||'').replace(/[^\d]/g,'');
                return atpDigits.includes(digitsOnly) || memberDigits.includes(digitsOnly);
            });
        } else if (isNumericSearch) {
            // 6 digits is ambiguous — too long for an ID, too short for a real phone number
            filtered = [];
        } else {
        const s = search.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const words = s.split(/\s+/).filter(w => w.length >= 3);
        const normalize = str => (str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        // Score each listing
        const tokenize = str => (str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[\s@._\-\/]+/).filter(t => t.length > 0);
        const scored = filtered.map(r => {
            const n = normalize(r.name);
            const e = normalize(r.email_member || r.email || '');
            const p = normalize(r.phone_member || r.phone || '');
            const v = normalize(r.province||'');
            const allTokens = [...tokenize(r.name), ...tokenize(r.email_member||r.email||''), ...tokenize(r.phone_member||r.phone||''), ...tokenize(r.province||''), ...tokenize(r.address||'')];
            let score = 0;
            const a = normalize(r.address||'');
            const sRe = new RegExp('(^|\\s)' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)');
            if (sRe.test(n) || sRe.test(e) || sRe.test(p) || sRe.test(v)) score = 100;
            else if (n.includes(s) || e.includes(s) || p.includes(s) || v.includes(s)) score = 90;
            else if (words.every(w => allTokens.some(t => t === w))) score = 80;
            else if (words.some(w => allTokens.some(t => t === w))) score = 40;
            else if (words.some(w => n.includes(w) || e.includes(w) || p.includes(w) || v.includes(w))) score = 5;
            if (score > 0) {
                if (r.is_member)     score += 3;
                if (r.apatel_member) score += 2;
                if (r.atp_active)    score += 1;
            }
            return { r, score };
        });
        const atpGood = scored.filter(x => x.score >= 40);
        const atpFinal = atpGood.length > 0 ? atpGood : scored.filter(x => x.score > 0);
        atpFinal.sort((a, b) => b.score - a.score);
        filtered = atpFinal.map(x => x.r);
        } // end else (non-ID search)
    }
    if (province) filtered = filtered.filter(r => r.province === province);
    if (type)     filtered = filtered.filter(r => r.rental_type === type);

    // Add MiCI-only listings from database (not in ATP PDF)
    try {
        let miciQuery = supabase
            .from('listings')
            .select('id, name, phone, email, province, rental_type, phone_member, email_member, address, photos, is_member, membership_paid_until, slug, registry_source, atp_active')
            .eq('registry_source', 'mici')
            .eq('atp_active', false);

        // Apply same filters to MiCI listings
        if (province) miciQuery = miciQuery.eq('province', province);
        if (type)     miciQuery = miciQuery.eq('rental_type', type);

        const { data: miciListings } = await miciQuery;

        if (miciListings && miciListings.length > 0) {
          let miciFiltered = miciListings;
          if (search) {
              const s = search.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              const words = s.split(/\s+/).filter(w => w.length >= 3);
              const normalize = str => (str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              const tokenizeMici = str => (str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[\s@._\-\/]+/).filter(t => t.length > 0);
              const scored = miciListings.map(r => {
                  const n = normalize(r.name);
                  const e = normalize(r.email_member || r.email || '');
                  const p = normalize(r.phone_member || r.phone || '');
                  const v = normalize(r.province||'');
                  const allTokens = [...tokenizeMici(r.name), ...tokenizeMici(r.email_member||r.email||''), ...tokenizeMici(r.phone_member||r.phone||''), ...tokenizeMici(r.province||'')];
                  let score = 0;
                  const a = normalize(r.address||'');
                  const sRe = new RegExp('(^|\\s)' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)');
                  if (sRe.test(n) || sRe.test(e) || sRe.test(p) || sRe.test(v)) score = 100;
                  else if (n.includes(s) || e.includes(s) || p.includes(s) || v.includes(s)) score = 90;
                  else if (words.every(w => allTokens.some(t => t === w))) score = 80;
                  else if (words.some(w => allTokens.some(t => t === w))) score = 40;
                  else if (words.some(w => n.includes(w) || e.includes(w) || p.includes(w) || v.includes(w))) score = 5;
                  if (score > 0) {
                      if (r.is_member)     score += 3;
                      if (r.apatel_member) score += 2;
                      if (r.atp_active)    score += 1;
                  }
                  return { r, score };
              });
              const miciGood = scored.filter(x => x.score >= 40);
              const miciFinal = miciGood.length > 0 ? miciGood : scored.filter(x => x.score > 0);
              miciFinal.sort((a, b) => b.score - a.score);
              miciFiltered = miciFinal.map(x => x.r);
          }
          filtered = [...filtered, ...miciFiltered];
      }
    } catch (err) {
        console.error('Error fetching MiCI listings:', err.message);
    }


    // Deduplicate: MiCI listings may share name with ATP listings
    // Keep MiCI version (has registry_source) over ATP version when duplicate
    const seen = new Map();
    for (const r of filtered) {
        const key = `${r.name?.toLowerCase().trim()}|${r.province?.toLowerCase().trim()}`;
        if (!seen.has(key)) {
            seen.set(key, r);
        } else {
            // Prefer the one with registry_source set (MiCI) over bare ATP entry
            const existing = seen.get(key);
            if (!existing.registry_source && r.registry_source) {
                seen.set(key, r);
            }
        }
    }
    filtered = Array.from(seen.values());
    const keywords = req.query.keyword
        ? (Array.isArray(req.query.keyword) ? req.query.keyword : [req.query.keyword])
        : [];
    if (keywords.length) filtered = filtered.filter(r =>
        Array.isArray(r.listing_keywords) && keywords.every(kw => r.listing_keywords.includes(kw))
    );
    if (!search) {
        filtered.sort((a, b) => {
            const ra = a.feature_rank || 0;
            const rb = b.feature_rank || 0;
            if (ra > 0 && rb > 0) return ra - rb;
            if (ra > 0) return -1;
            if (rb > 0) return 1;
            return 0;
        });
    }
    res.json(filtered);
});

app.get('/api/status', (req, res) => {
    res.json({
        status: PDF_STATUS,
        lastUpdated: new Date().toISOString(),
        rentalsCount: CURRENT_RENTALS.length,
        pdfUrl: PDF_URL,
        pdfHeading: PDF_HEADING,
        dataSource: DATA_SOURCE,
        isFallback: DATA_SOURCE === 'fallback'
    });
});

app.get('/api/pdf-source', (req, res) => {
    res.json({ pdfUrl: PDF_URL });
});

app.get('/api/pdf-info', (req, res) => {
    const formattedDate = extractFormattedDate(PDF_HEADING);
    res.json({ pdfUrl: PDF_URL, heading: PDF_HEADING, formattedDate, lastUpdated: new Date().toISOString() });
});

app.get('/api/ping', (req, res) => {
    res.json({ message: 'pong', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString(), pdf_status: PDF_STATUS, total_rentals: CURRENT_RENTALS.length });
});

// Manual trigger to check ATP for updates. By default does a genuine check —
// only re-parses if the PDF URL actually changed. Pass ?force=true to bypass
// that and re-parse regardless (e.g. to re-run the diff after a code change).
app.post('/api/reload-pdf', async (req, res) => {
    // Accepts either an admin session token (from the admin panel button) OR
    // the shared secret (from the daily GitHub Actions cron job), since the
    // latter runs from rotating IPs and can't pass the IP-locked admin login.
    const bearer = req.headers['authorization']?.replace('Bearer ', '');
    let isAdminToken = false;
    if (bearer) {
        try {
            isAdminToken = Buffer.from(bearer, 'base64').toString().split(':')[0] === 'admin';
        } catch {}
    }
    const bodySecret = req.body?.secret;
    const isCronSecret = bodySecret && bodySecret === process.env.ADMIN_SECRET;
    if (!isAdminToken && !isCronSecret) return res.status(403).json({ error: 'Denied' });
    try {
        console.log('🔄 PDF reload triggered...');
        if (req.query.force === 'true') {
            await supabaseAdmin.from('pdf_meta').update({ pdf_url: 'force-reload' }).neq('id', 0);
        }
        await checkForPdfUpdate();
        res.json({
            success: true,
            dataSource: DATA_SOURCE,
            rentalsCount: CURRENT_RENTALS.length,
            pdfUrl: PDF_URL,
            heading: PDF_HEADING,
            pendingDiff: !!PENDING_ATP_DIFF
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Debug endpoints
app.get('/api/debug-rentals', (req, res) => {
    res.json({
        CURRENT_RENTALS_length: CURRENT_RENTALS.length,
        PDF_URL, PDF_HEADING, PDF_STATUS, DATA_SOURCE
    });
});

app.get('/api/test-heading', async (req, res) => {
    try {
        const result = await getLatestPdfUrl();
        res.json(result);
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// The /api/debug-reload endpoint was removed because it could rewrite the database unintentionally

// Slug endpoint to find record with slug and ID
app.get('/api/listing/slug/:slug', async (req, res) => {
    const { slug } = req.params;
    const { data, error } = await supabase
        .from('listings')
        .select('id, name, phone, email, province, rental_type, atp_active, atp_first_seen, atp_last_seen, address, description_en, description_es, photos, website_url, booking_url, is_member, membership_paid_until, contact_name, slug, phone_member, email_member, custom_links, is_trial, trial_started_at, registry_source, apatel_member, listing_keywords')
        .eq('slug', slug)
        .single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
});

app.get('/api/listing/:id', async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
        .from('listings')
        .select('id, name, phone, email, province, rental_type, atp_active, atp_first_seen, atp_last_seen, address, description_en, description_es, photos, website_url, booking_url, is_member, membership_paid_until, contact_name, phone_member, email_member, custom_links, slug, is_trial, trial_started_at, registry_source, apatel_member, listing_keywords')
        .eq('id', id)
        .single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
});

// ── Admin-only: mint a valid listing session token without the member's ──
// password. Uses the exact same token format /api/listing-login produces,
// so it works identically once loaded — no password reset, no shared
// credential, member's own password is completely untouched.
app.get('/api/admin/listing-access-token/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const { data, error } = await supabaseAdmin
        .from('listings').select('id, is_member').eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'Listing not found' });
    const token = Buffer.from(`${id}:${Date.now()}:${process.env.ADMIN_SECRET}`).toString('base64');
    res.json({ token });
});


app.post('/api/listing-login', async (req, res) => {
    const bcrypt = require('bcrypt');
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ error: 'Missing id or password' });

    const { data, error } = await supabase
        .from('listings')
        .select('id, member_password, membership_paid_until, is_member')
        .eq('id', id)
        .single();

    if (error || !data || !data.is_member) {
        return res.status(403).json({ error: 'Not a member' });
    }

    // Check membership is still valid
    const paidUntil = new Date(data.membership_paid_until);
    if (paidUntil < new Date()) {
        return res.status(403).json({ error: 'Membership expired' });
    }

    // Verify password
    const match = await bcrypt.compare(password, data.member_password);
    if (!match) return res.status(401).json({ error: 'Invalid password' });

    // Return a simple session token (id + timestamp, signed)
    const token = Buffer.from(`${id}:${Date.now()}:${process.env.ADMIN_SECRET}`).toString('base64');
    res.json({ token, message: 'Login successful' });
});

app.post('/api/listing-update', async (req, res) => {
    const bcrypt = require('bcrypt');
    const { id, token, address, phone_member, email_member, description_en,
        description_es, website_url, booking_url, photos, custom_links, listing_keywords } = req.body;

    // Verify token
    try {
        const decoded = Buffer.from(token, 'base64').toString();
        const [tokenId] = decoded.split(':');
        if (tokenId !== String(id)) return res.status(403).json({ error: 'Invalid token' });
    } catch {
        return res.status(403).json({ error: 'Invalid token' });
    }

    // Only allow member-owned fields — never ATP fields
    const { error } = await supabaseAdmin
        .from('listings')
        .update({ address, phone_member, email_member, description_en, description_es, website_url, booking_url, photos, custom_links, listing_keywords })
        .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });

    // Re-rank featured listings — a member adding photos/description here can
    // move them into a higher tier (e.g. trial+photo vs trial+no-photo), which
    // this endpoint previously never triggered a recalculation for.
    await recalculateFeatureRanks();

    res.json({ success: true });
});

app.post('/api/listing-photo-upload', upload.single('photo'), async (req, res) => {
    const { listingId, token } = req.body;
    if (!listingId || !token) return res.status(400).json({ error: 'Missing params' });

    // Verify token
    try {
        const decoded = Buffer.from(token, 'base64').toString();
        const [tokenId] = decoded.split(':');
        if (tokenId !== String(listingId)) return res.status(403).json({ error: 'Invalid token' });
    } catch {
        return res.status(403).json({ error: 'Invalid token' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file received' });

        // Upload to Supabase Storage
        // Sanitize filename: remove accents, spaces, special chars
        const safeName = req.file.originalname
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')   // remove accents
        .replace(/[^a-zA-Z0-9._-]/g, '_') // replace special chars with underscore
        .replace(/_+/g, '_')               // collapse multiple underscores
        .toLowerCase();
        const fileName = `${listingId}/${Date.now()}-${safeName}`;
        const { error } = await supabase.storage
        .from('listing-photos')
        .upload(fileName, req.file.buffer, {
            contentType: req.file.mimetype,
            upsert: false
        });

    if (error) return res.status(500).json({ error: error.message });

    // Return public URL
    const { data } = supabase.storage
        .from('listing-photos')
        .getPublicUrl(fileName);

    res.json({ url: data.publicUrl });
});

// ── Update admin IP (call this from phone/PC daily) ───────────────────────────
app.get('/api/update-admin-ip', async (req, res) => {
    const { secret, ip: explicitIp } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).send('Denied');
    // Prefer an explicitly-passed IP (from updateMyIP.php, which already knows
    // the real caller's IP from its own $_SERVER["REMOTE_ADDR"]) over detecting
    // it from this request's connection — since this endpoint is often called
    // server-side via curl from aparthotel-boquete.com, the connection's own
    // IP is the shared hosting server's IP, not the actual admin's device.
    const ip = explicitIp || req.headers['x-forwarded-for']?.split(',')[0].trim()
             || req.socket.remoteAddress;
    const { error } = await supabaseAdmin
        .from('settings')
        .upsert({ key: 'admin_ip', value: ip, updated_at: new Date().toISOString() });
    if (error) return res.status(500).send('Error: ' + error.message);
    console.log(`✅ Admin IP updated to: ${ip}${explicitIp ? ' (explicit)' : ' (detected from connection)'}`);
    res.send(`✅ Admin IP updated: ${ip}`);
});

app.post('/api/admin/update-ip', requireAdmin, async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
             || req.socket.remoteAddress;
    const { error } = await supabaseAdmin
        .from('settings')
        .upsert({ key: 'admin_ip', value: ip, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('admin_update_ip', { ip });
    res.json({ success: true, ip });
});

// ── Check admin IP helper ─────────────────────────────────────────────────────
async function getAdminIP() {
    const { data } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'admin_ip')
        .single();
    return data ? data.value : null;
}

// ── Admin login (IP + password) ───────────────────────────────────────────────
const adminLoginRateLimit = new Map(); // ip -> { count, reset }

app.post('/api/admin-login', async (req, res) => {
    const { password } = req.body;
    const visitorIP = req.headers['x-forwarded-for']?.split(',')[0].trim()
                    || req.socket.remoteAddress;

    // Password is now the sole login gate — IP allowlisting was removed
    // (unreliable across the CDN/proxy chain; see Aug 2026 debugging).
    // Basic brute-force protection instead: max 8 attempts per IP / 15 min.
    const now = Date.now();
    const rl = adminLoginRateLimit.get(visitorIP) || { count: 0, reset: now + 15 * 60 * 1000 };
    if (now > rl.reset) { rl.count = 0; rl.reset = now + 15 * 60 * 1000; }
    rl.count++;
    adminLoginRateLimit.set(visitorIP, rl);
    if (rl.count > 8) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Wrong password' });
    }

    const token = Buffer.from(`admin:${Date.now()}:${process.env.ADMIN_SECRET}`).toString('base64');
    console.log(`✅ Admin login from ${visitorIP}`);
    res.json({ token });
});

// ── Admin auth middleware ──────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });

    try {
        const decoded = Buffer.from(token, 'base64').toString();
        const [role, timestamp, secret] = decoded.split(':');
        if (role !== 'admin') return res.status(403).json({ error: 'Not admin' });
        if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Invalid token' });

        // Token expires after 4 hours
        if (Date.now() - parseInt(timestamp) > 4 * 60 * 60 * 1000) {
            return res.status(401).json({ error: 'Session expired' });
        }

        next();
    } catch {
        return res.status(403).json({ error: 'Invalid token' });
    }
}

// ── Admin API: get all members ────────────────────────────────────────────────
app.get('/api/admin/members', requireAdmin, async (req, res) => {
    let allData = [];
    let from = 0;
    const BATCH = 1000;
    while (true) {
      const { data, error } = await supabase
          .from('listings')
          .select('id, name, email, phone, province, rental_type, is_member, is_trial, membership_paid_until, invitation_sent_at, invitation_status, atp_active, slug, contact_name, notes, password_changed, apatel_member, feature_rank, whatsapp, photos, registry_source')
          .order('name')
          .range(from, from + BATCH - 1);
        if (error) return res.status(500).json({ error: error.message });
        allData = allData.concat(data);
        if (data.length < BATCH) break;
        from += BATCH;
    }
    res.json(allData);
});

// ── Admin API: update member ──────────────────────────────────────────────────
app.post('/api/admin/update-member', requireAdmin, async (req, res) => {
    const { id, is_member, membership_paid_until, contact_name,
            slug, notes, phone, email, rental_type, apatel_member, set_featured } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const updates = { is_member, membership_paid_until, contact_name, slug, notes };
    if (phone         !== undefined) updates.phone         = phone || null;
    if (email         !== undefined) updates.email         = email || null;
    if (rental_type   !== undefined) updates.rental_type   = rental_type || null;
    if (apatel_member !== undefined) updates.apatel_member = !!apatel_member;
    if (set_featured  !== undefined) {
        if (!set_featured) {
            updates.feature_rank = 0;
        } else {
            // Check if already featured
            const { data: current } = await supabaseAdmin
                .from('listings').select('feature_rank').eq('id', id).single();
            if (!current?.feature_rank || current.feature_rank === 0) {
                updates.feature_rank = 999; // Will be recalculated
            }
        }
    }
    const { error } = await supabaseAdmin
        .from('listings')
        .update(updates)
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    if (set_featured !== undefined) await recalculateFeatureRanks();
    await logEvent('admin_update_member', { id, is_member, contact_name, apatel_member, set_featured });
    res.json({ success: true });
});

// ── Admin API: correct the RUC/DV on file for an application ─────────────────
// RUC/DV live on membership_applications (keyed by application_id, not
// listing_id) — this lets the admin fix a wrong or outdated tax ID (e.g. an
// old provisional foreigner ID that was mistakenly recorded instead of a
// real RUC) directly from the member-detail panel, independent of issuing
// an invoice. The invoice form reads the application fresh each time it's
// opened, so a correction saved here is picked up automatically next time.
app.post('/api/admin/update-application-ruc', requireAdmin, async (req, res) => {
    const { application_id, ruc, ruc_dv, business_name, personal_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'Missing application_id' });
    const updates = {
        ruc:    ruc !== undefined ? (ruc ? String(ruc).trim() : null) : undefined,
        ruc_dv: ruc_dv !== undefined ? (ruc_dv ? String(ruc_dv).trim() : null) : undefined,
        business_name: business_name !== undefined ? (business_name ? String(business_name).trim() : null) : undefined,
        // Cédula or passport number, used to pre-fill the invoice form's
        // Consumidor Final/Extranjero path when there's no RUC on file
        // (added 2026-08-23 — see membership_applications.personal_id).
        personal_id: personal_id !== undefined ? (personal_id ? String(personal_id).trim() : null) : undefined
    };
    Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });
    const { error } = await supabaseAdmin
        .from('membership_applications')
        .update(updates)
        .eq('id', application_id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('admin_update_application_ruc', { application_id, ...updates });
    res.json({ success: true });
});

// ── Admin API: set member password ────────────────────────────────────────────
app.post('/api/admin/set-password', requireAdmin, async (req, res) => {
    const bcrypt = require('bcrypt');
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ error: 'Missing fields' });
    const hash = await bcrypt.hash(password, 10);
    const { error } = await supabase
        .from('listings')
        .update({ member_password: hash })
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('admin_set_password', { id });
    res.json({ success: true });
});

// ── Admin API: mark invitation sent ──────────────────────────────────────────
app.post('/api/admin/mark-invited', requireAdmin, async (req, res) => {
    const { id } = req.body;
    const { error } = await supabase
        .from('listings')
        .update({ invitation_sent_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('invitation_sent', { id });
    res.json({ success: true });
});

// ── Send a real invitation email to a single listing (used by the admin ──
// panel's status badge, so clicking "INVITE" actually invites instead of
// just relabeling the status without contacting anyone).
app.post('/api/admin/invite-single', requireAdmin, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const { data: listing, error: fetchErr } = await supabaseAdmin
        .from('listings')
        .select('id, name, email, slug')
        .eq('id', id)
        .single();
    if (fetchErr || !listing) return res.status(404).json({ error: 'Listing not found' });
    if (!listing.email || !listing.email.includes('@')) {
        return res.status(400).json({ error: 'This listing has no valid email on file' });
    }

    const listUrl = listing.slug
        ? `https://trustedpanamastays.com/listing.html?slug=${listing.slug}&lang=es`
        : `https://trustedpanamastays.com/listing.html?id=${listing.id}&lang=es`;
    const joinUrl = 'https://trustedpanamastays.com/join.html';

    const subject = `Su hospedaje ya está en Trusted Panama Stays — ${listing.name}`;
    const message = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.3rem 0 0;font-size:0.88rem;">Directorio de hospedajes legalmente registrados en Panamá</p>
</div>
<p>Estimado/a propietario/a de <strong>${listing.name}</strong>,</p>
<p>Le contactamos porque su hospedaje aparece en el registro oficial de la ATP.</p>
<p>Hemos creado <strong>Trusted Panama Stays</strong>, un directorio gratuito para turistas internacionales que buscan hospedajes legalmente registrados en Panamá — sin las comisiones de Booking.com o Airbnb (15–20%).</p>
<div style="background:#f0f7ff;border:1px solid #c0d8f0;border-radius:8px;padding:1rem;margin:1rem 0;">
    <p style="margin:0 0 0.5rem;font-weight:bold;color:#005ca9;">Su hospedaje ya aparece en nuestro directorio:</p>
    <p style="margin:0;"><a href="${listUrl}" style="color:#005ca9;font-size:1rem;">${listUrl}</a></p>
</div>
<p>Con una <strong>membresía de prueba gratuita</strong> (sin costo, sin obligación) puede agregar hasta 20 fotos, descripción en inglés y español, dirección completa, y enlaces a su sitio web y sistema de reservas.</p>
<p style="text-align:center;margin:1.5rem 0;">
    <a href="${joinUrl}" style="background:#005ca9;color:white;padding:12px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;display:inline-block;">
        Solicitar membresía gratuita →
    </a>
</p>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">
    Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
    <a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a>
</p>
</body></html>`;

    try {
        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        await execFileAsync('php', [notifyPath, subject, message, listing.email], { timeout: 15000 });
        await supabaseAdmin.from('listings').update({
            invitation_status: 'invited',
            invitation_sent_at: new Date().toISOString(),
            general_campaign_sent_at: new Date().toISOString() // so the batch campaign doesn't re-send later
        }).eq('id', id);
        await logEvent('invitation_email_sent', { listing_id: id, name: listing.name, email: listing.email, source: 'manual_single' });
        res.json({ success: true });
    } catch (err) {
        console.error(`Manual invite failed for ${listing.name}:`, err.message);
        res.status(500).json({ error: 'Failed to send invitation email: ' + err.message });
    }
});

// ── Extracts a WhatsApp-ready international number from a phone string that ──
// may contain multiple numbers separated by '/'. A number prefixed with '-'
// (e.g. "-64427132") has been confirmed NOT on WhatsApp and is permanently
// skipped — this makes re-running the scan always safe.
function resolveWhatsAppNumber(phoneStr) {
    if (!phoneStr) return null;
    const parts = phoneStr.split('/').map(p => p.trim()).filter(Boolean);
    for (const raw of parts) {
        if (raw.startsWith('-')) continue; // confirmed not on WhatsApp
        const hasPlus = raw.startsWith('+');
        const digits  = raw.replace(/\D/g,'');
        if (!digits) continue;
        if (hasPlus) return digits;
        if (digits.length === 11 && digits.startsWith('1')) return digits;
        if (digits.length === 10) return '1' + digits;
        if (digits.length === 8 && digits.startsWith('6')) return '507' + digits;
    }
    return null;
}

// ── Scan the whole directory and populate/refresh the whatsapp column ────────
app.post('/api/admin/scan-whatsapp-candidates', requireAdmin, async (req, res) => {
    try {
        let all = [];
        let from = 0;
        const BATCH = 1000;
        while (true) {
            const { data, error } = await supabaseAdmin
                .from('listings').select('id, phone, whatsapp').range(from, from + BATCH - 1);
            if (error) throw new Error(error.message);
            all = all.concat(data);
            if (data.length < BATCH) break;
            from += BATCH;
        }
        let updated = 0, cleared = 0, unchanged = 0;
        for (const l of all) {
            const candidate = resolveWhatsAppNumber(l.phone);
            if (candidate !== (l.whatsapp || null)) {
                await supabaseAdmin.from('listings').update({ whatsapp: candidate }).eq('id', l.id);
                candidate ? updated++ : cleared++;
            } else {
                unchanged++;
            }
        }
        await logEvent('whatsapp_scan_completed', { updated, cleared, unchanged, total: all.length });
        res.json({ success: true, updated, cleared, unchanged, total: all.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Confirm a number is NOT on WhatsApp: mark it in the phone field so a ────
// future scan never re-suggests it, clear the whatsapp column, and revert
// the (incorrectly set) invited status since no message actually arrived.
app.post('/api/admin/mark-whatsapp-invalid', requireAdmin, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
        const { data: listing, error: fetchErr } = await supabaseAdmin
            .from('listings').select('id, phone, whatsapp').eq('id', id).single();
        if (fetchErr || !listing) return res.status(404).json({ error: 'Listing not found' });

        let newPhone = listing.phone || '';
        if (listing.whatsapp && newPhone) {
            newPhone = newPhone.split('/').map(part => {
                const trimmed = part.trim();
                if (trimmed.startsWith('-')) return part;
                return resolveWhatsAppNumber(trimmed) === listing.whatsapp ? part.replace(trimmed, '-' + trimmed) : part;
            }).join('/');
        }

        // Immediately check if another mobile number in the same field is a
        // fresh candidate — resolveWhatsAppNumber already skips '-' prefixed
        // (confirmed invalid) numbers, so this naturally finds the next one.
        const nextCandidate = resolveWhatsAppNumber(newPhone);

        const { error } = await supabaseAdmin.from('listings').update({
            phone: newPhone,
            whatsapp: nextCandidate,
            invitation_status: 'not_invited',
            invitation_sent_at: null
        }).eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        await logEvent('whatsapp_marked_invalid', { listing_id: id, old_phone: listing.phone, new_phone: newPhone, next_candidate: nextCandidate });
        res.json({ success: true, phone: newPhone, whatsapp: nextCandidate });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Editable WhatsApp campaign message (Spanish) — stored in the settings ────
// table instead of hardcoded, so wording can change without a code deploy.
// {name} and {url} are replaced with the listing's name and its listing page link.
const WA_TEMPLATE_DEFAULT = `Hola! Su hospedaje *{name}* aparece en *Trusted Panama Stays*, el directorio oficial de hospedajes registrados ante la ATP en Panamá.\n\nCon una membresía de prueba (30 días gratis) puede agregar fotos, descripción completa y enlaces de reserva a su perfil.\n\nMás información: https://trustedpanamastays.com/about.html?lang=es\n\nVer su listado actual: {url}\n\n¿Le interesa? Con gusto le ayudamos a configurar su perfil.`;

app.get('/api/admin/wa-template', requireAdmin, async (req, res) => {
    const { data } = await supabaseAdmin.from('settings').select('value').eq('key', 'wa_campaign_template_es').maybeSingle();
    res.json({ template: data?.value || WA_TEMPLATE_DEFAULT, isDefault: !data?.value });
});

app.post('/api/admin/wa-template', requireAdmin, async (req, res) => {
    const { template } = req.body;
    if (!template || !template.trim()) return res.status(400).json({ error: 'Template cannot be empty' });
    const { error } = await supabaseAdmin.from('settings').upsert({
        key: 'wa_campaign_template_es', value: template, updated_at: new Date().toISOString()
    });
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('wa_template_updated', {});
    res.json({ success: true });
});

// ── WhatsApp campaign queue — persistent, click-through-one-at-a-time list ───
app.post('/api/admin/wa-queue/add', requireAdmin, async (req, res) => {
    const { targets } = req.body;
    if (!Array.isArray(targets) || !targets.length) return res.status(400).json({ error: 'No targets provided' });
    const rows = targets.filter(t => t.whatsapp).map(t => ({
        listing_id: t.id, name: t.name, slug: t.slug || null, whatsapp: t.whatsapp, status: 'pending'
    }));
    if (!rows.length) return res.status(400).json({ error: 'Ninguno de los seleccionados tiene WhatsApp confirmado' });
    const ids = rows.map(r => r.listing_id);
    await supabaseAdmin.from('wa_campaign_queue').delete().eq('status', 'pending').in('listing_id', ids);
    const { error } = await supabaseAdmin.from('wa_campaign_queue').insert(rows);
    if (error) return res.status(500).json({ error: error.message });

    // Log to campaign history — envío manual/gradual uno-a-uno, así que no se
    // rastrea sent_count en vivo (se completaría de a poco, quizás en varios
    // días); esta entrada queda como registro de qué y cuándo se agregó.
    try {
        const { data: waTemplateRow } = await supabaseAdmin.from('settings').select('value').eq('key', 'wa_campaign_template_es').maybeSingle();
        await supabaseAdmin.from('campaigns').insert({
            channel: 'whatsapp',
            body_html: waTemplateRow?.value || WA_TEMPLATE_DEFAULT,
            target_description: `Cola de WhatsApp — ${rows.length} agregado(s)`,
            recipient_count: rows.length,
            status: 'queued'
        });
    } catch (err) {
        console.error('Campaign history log (wa-queue add) failed:', err.message);
    }

    res.json({ success: true, added: rows.length });
});

app.get('/api/admin/wa-queue', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('wa_campaign_queue')
        .select('id, listing_id, name, slug, whatsapp, status, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/admin/wa-queue/:id/mark-sent', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const { data: row } = await supabaseAdmin.from('wa_campaign_queue').select('listing_id').eq('id', id).single();
    await supabaseAdmin.from('wa_campaign_queue').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', id);
    if (row) {
        await supabaseAdmin.from('listings').update({
            invitation_status: 'invited', invitation_sent_at: new Date().toISOString()
        }).eq('id', row.listing_id);
    }
    res.json({ success: true });
});

app.post('/api/admin/wa-queue/:id/skip', requireAdmin, async (req, res) => {
    await supabaseAdmin.from('wa_campaign_queue').update({ status: 'skipped' }).eq('id', parseInt(req.params.id));
    res.json({ success: true });
});

// ── Campaign history — "what did we send, when, and to how many" ────────────
// Covers every email blast (send-followup-all/new/reminder/specific, all of
// which funnel through sendToRosterList) and every WhatsApp queue batch
// (wa-queue/add). Built so a quick look answers "what was the latest
// campaign?" without having to remember or dig through event_log.
app.get('/api/admin/campaigns', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('campaigns')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── Editable help-panel content, one file per topic ──────────────────────────
// Every topic (general guide + each per-button snippet) is its own HTML file
// under public/help/, fetched on demand and editable via the same Quill panel.
// Whitelisted keys only — never accepts an arbitrary filename from the request.
const HELP_FILES = {
    'general-es':        'general-es.html',
    'applications':      'applications-es.html',
    'invoices':          'invoices-es.html',
    'log':               'log-es.html',
    'campaign':          'campaign-es.html',
    'analytics':         'analytics-es.html',
    'ip':                'ip-es.html',
    'atpsync':           'atpsync-es.html',
    'keywords':          'keywords-es.html',
    'stat-total':        'stat-total-es.html',
    'stat-members':      'stat-members-es.html',
    'stat-expired':      'stat-expired-es.html',
    'stat-not-invited':  'stat-not-invited-es.html',
    'stat-invited':      'stat-invited-es.html',
    'stat-no-response':  'stat-no-response-es.html',
    'stat-refused':      'stat-refused-es.html'
    // add one entry here each time a new button/section gets tagged with data-help
};

app.get('/api/admin/help-content/:key', requireAdmin, async (req, res) => {
    if (!HELP_FILES[req.params.key]) return res.status(400).json({ error: 'Unknown help content key' });
    try {
        const { data } = await supabaseAdmin
            .from('help_content').select('html').eq('key', req.params.key).maybeSingle();
        if (data) return res.json({ html: data.html });

        // Not in the database yet — fall back to the seed file under public/help/
        // (covers the one-time migration; once saved via the editor, the DB row wins from then on)
        const filePath = path.join(__dirname, 'public', 'help', HELP_FILES[req.params.key]);
        const html = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
        res.json({ html });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/save-help-content', requireAdmin, async (req, res) => {
    const { key, html } = req.body;
    if (!HELP_FILES[key]) return res.status(400).json({ error: 'Unknown help content key' });
    if (typeof html !== 'string' || !html.trim()) return res.status(400).json({ error: 'Empty content' });
    try {
        const { error } = await supabaseAdmin
            .from('help_content')
            .upsert({ key, html, updated_at: new Date().toISOString() });
        if (error) throw error;
        await logEvent('help_content_edited', { key });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/set-invitation-status', requireAdmin, async (req, res) => {
    const { id, status } = req.body;
    if (!id || !status) return res.status(400).json({ error: 'Missing fields' });
    const validStatuses = ['not_invited', 'invited', 'no_response', 'refused'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const updates = { invitation_status: status };
    if (status === 'invited') updates.invitation_sent_at = new Date().toISOString();
    if (status === 'refused') updates.refused_at = new Date().toISOString();
    const { error } = await supabaseAdmin
        .from('listings')
        .update(updates)
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('invitation_status_changed', { id, status });
    res.json({ success: true });
});

// ── Event logger ──────────────────────────────────────────────────────────────
async function logEvent(type, data) {
    try {
        const { error } = await supabaseAdmin.from('event_log').insert({
            event_type: type,
            event_data: data,
            created_at: new Date().toISOString()
        });
        if (error) console.error('Log error (RLS/insert):', error.message);
    } catch (err) {
        console.error('Log error:', err.message);
    }
}

// ─── SECTION A: EMAIL HELPERS ─────────────────────────────────────────────────

function generateWaText(app, type, password, paidUntil) {
    const listingUrl = 'https://trustedpanamastays.com/listing.html?id=' + app.listing_id + '&lang=es';
    const payUrl     = 'https://trustedpanamastays.com/pay.html';
    if (type === 'approved_trial')
        return 'Hola! Somos Trusted Panama Stays.\n\nSu hospedaje *' + app.property_name + '* ha sido verificado y su membresía de prueba gratuita está activa hasta el *' + paidUntil + '*.\n\nSus datos de acceso:\nURL: ' + listingUrl + '\nContraseña: ' + password + '\n\nRecibirá un recordatorio 5 días antes del vencimiento.\n\nPreguntas? info@trustedpanamastays.com';
    if (type === 'approved_paid')
        return 'Hola! Somos Trusted Panama Stays.\n\nSu hospedaje *' + app.property_name + '* ha sido verificado y su membresía está activa hasta el *' + paidUntil + '*.\n\nSus datos de acceso:\nURL: ' + listingUrl + '\nContraseña: ' + password + '\n\nPreguntas? info@trustedpanamastays.com';
    if (type === 'rejected_payment')
        return 'Hola! Somos Trusted Panama Stays.\n\nHemos revisado su solicitud para *' + app.property_name + '*.\n\nSus documentos de identidad son válidos.\nSin embargo, el comprobante de pago requiere revisión.\n\nSu número de membresía es: *' + app.listing_id + '*\n\nPara enviar el comprobante correcto, visite:\n' + payUrl + '\n\nAl realizar el pago, incluya el nombre de su hospedaje y provincia en el campo MENSAJE.\n\nPreguntas? info@trustedpanamastays.com';
    return '';
}

function generateEmailHtml(app, type, password, paidUntil, rejectReason) {
    const listingUrl = 'https://trustedpanamastays.com/listing.html?id=' + app.listing_id + '&lang=es';
    const payUrl     = 'https://trustedpanamastays.com/pay.html';
    const hdr = '<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;"><h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1></div>';
    const ftr = '<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;"><p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>';

    if (type === 'approved_trial' || type === 'approved_paid') {
        const addendumPath = path.join(__dirname, 'public', 'templates', 'welcome_addendum.html');
              let addendum = '';
              try { addendum = fs.readFileSync(addendumPath, 'utf8'); } catch(e) {}
        const planText = type === 'approved_trial' ? 'prueba gratuita de 30 días' : (app.duration_months === 24 ? 'membresía de 2 años' : 'membresía de 1 año');
        const trialNote = type === 'approved_trial'
            ? '<p style="background:#fffbe6;padding:1rem;border-radius:6px;border:1px solid #FFD700;margin-top:1rem;"><strong>Recordatorio:</strong> Su prueba vence el <strong>' + paidUntil + '</strong>. Para renovar visite: <a href="' + payUrl + '">' + payUrl + '</a> · N° membresía: <strong>' + app.listing_id + '</strong></p>'
            : '';
        return '<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">' + hdr +
            '<p>Estimado/a <strong>' + app.contact_name + '</strong>,</p>' +
            '<p>Su ' + planText + ' para <strong>' + app.property_name + '</strong> está activa hasta el <strong>' + paidUntil + '</strong>.</p>' +
            '<h3 style="color:#005ca9;">Sus datos de acceso:</h3>' +
            '<table style="border:1px solid #e1e5e9;border-radius:8px;background:#f8f9fa;width:100%;margin-bottom:1rem;">' +
            '<tr><td style="padding:8px;font-weight:bold;">URL:</td><td><a href="' + listingUrl + '">' + listingUrl + '</a></td></tr>' +
            '<tr><td style="padding:8px;font-weight:bold;">Contraseña:</td><td style="font-family:monospace;font-size:1.1rem;"><strong>' + password + '</strong></td></tr>' +
            '<tr><td style="padding:8px;font-weight:bold;">N° membresía:</td><td style="font-family:monospace;"><strong>' + app.listing_id + '</strong></td></tr>' +
            '</table>' + trialNote + addendum +
            '<p>Para editar su listado, haga clic en Acceso en el enlace arriba.</p>' +
            '<p>Preguntas? <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>' + ftr + '</body></html>';
    }
    if (type === 'rejected_payment') {
        return '<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">' + hdr +
            '<p>Estimado/a <strong>' + app.contact_name + '</strong>,</p>' +
            '<p>Sus documentos de identidad son válidos.</p>' +
            '<div style="background:#fffbe6;border:1px solid #FFD700;border-radius:8px;padding:1rem;margin:1rem 0;"><strong>Comprobante de pago:</strong> ' + (rejectReason || 'El comprobante recibido no corresponde al monto de membresía.') + '</div>' +
            '<table style="border:1px solid #e1e5e9;border-radius:8px;background:#f8f9fa;width:100%;margin-bottom:1rem;">' +
            '<tr><td style="padding:8px;font-weight:bold;">N° membresía:</td><td style="font-family:monospace;font-size:1.1rem;"><strong>' + app.listing_id + '</strong></td></tr>' +
            '<tr><td style="padding:8px;font-weight:bold;">Página de pago:</td><td><a href="' + payUrl + '">' + payUrl + '</a></td></tr>' +
            '</table>' +
            '<p>Al pagar, incluya el nombre de su hospedaje y provincia en el campo MENSAJE.</p>' +
            '<p>Preguntas? <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>' + ftr + '</body></html>';
    }
    return '<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">' + hdr +
        '<p>Estimado/a <strong>' + app.contact_name + '</strong>,</p>' +
        '<p>No podemos aprobar su solicitud para <strong>' + app.property_name + '</strong>.</p>' +
        '<div style="background:#fde8e8;border:1px solid #ffcccc;border-radius:8px;padding:1rem;margin:1rem 0;"><strong>' + (rejectReason || 'Documentos inválidos.') + '</strong></div>' +
        '<p>Puede volver a aplicar en: <a href="https://trustedpanamastays.com/join.html">join.html</a></p>' +
        '<p>Preguntas? <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>' + ftr + '</body></html>';
}

// ── Admin: get log entries ────────────────────────────────────────────────────
app.get('/api/admin/log', requireAdmin, async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const { data, error } = await supabaseAdmin
        .from('event_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── Admin: IP info ────────────────────────────────────────────────────────────
app.get('/api/admin/ip-info', requireAdmin, async (req, res) => {
    const yourIP = req.headers['x-forwarded-for']?.split(',')[0].trim()
                 || req.socket.remoteAddress;
    const adminIP = await getAdminIP();
    res.json({ adminIP, yourIP });
});

app.get('/api/test-anthropic', async (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({
        error: 'No',
        received_length: secret?.length,
        expected_length: process.env.ADMIN_SECRET?.length
    });
    res.json({
        key_exists: !!process.env.ANTHROPIC_API_KEY,
        key_prefix: process.env.ANTHROPIC_API_KEY?.substring(0, 10) + '...'
    });
});

app.get('/api/env-check', (req, res) => {
    res.json({
        keys_present: Object.keys(process.env).filter(k =>
            ['ADMIN_SECRET','ADMIN_PASSWORD','SUPABASE_URL','SUPABASE_ANON_KEY','ANTHROPIC_API_KEY']
            .includes(k)
        ),
        total_env_vars: Object.keys(process.env).length
    });
});

// ── TEMPORARY DEBUG — diagnosing IP-detection mismatch, remove once resolved ──
app.get('/api/debug-ip', (req, res) => {
    res.json({
        x_forwarded_for_raw: req.headers['x-forwarded-for'] || null,
        computed_visitor_ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
        socket_remote_address: req.socket.remoteAddress,
        x_real_ip: req.headers['x-real-ip'] || null,
        cf_connecting_ip: req.headers['cf-connecting-ip'] || null
    });
});

app.get('/api/secret-debug', (req, res) => {
    const { secret } = req.query;
    const stored = process.env.ADMIN_SECRET;
    res.json({
        received:          secret,
        stored_first_char: stored?.charCodeAt(0),
        stored_last_char:  stored?.charCodeAt(stored.length-1),
        received_first:    secret?.charCodeAt(0),
        received_last:     secret?.charCodeAt(secret.length-1),
        match:             secret === stored
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  MEMBERSHIP APPLICATION ENDPOINT
// ═════════════════════════════════════════════════════════════════════════════

// ── Multer config for membership docs (10MB limit) ────────────────────────────
const uploadDocs = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }  // 10MB
});

// ── POST /api/membership-apply ────────────────────────────────────────────────
app.post('/api/membership-apply',
    uploadDocs.fields([
        { name: 'file_aviso',  maxCount: 1 },
        { name: 'file_cedula', maxCount: 1 },
        { name: 'file_pago',   maxCount: 1 }
    ]),
    async (req, res) => {

    const {
        property_name, province, contact_name, contact_email,
        contact_phone, how_found, membership_type,
        duration_months, payment_method,
        registration_type, listing_phone, listing_email, listing_id_hint
    } = req.body;

    if (!property_name || !contact_name || !contact_email || !contact_phone) {
        return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
             || req.socket.remoteAddress;

    try {
        // ── Try to find matching listing (ATP only) ───────────────────────
        let listingId = null;
        const isMici  = registration_type === 'mici';

        if (!isMici) {
          if (listing_id_hint) {
            // Frontend already identified the listing via dropdown
            const { data: hintListing } = await supabase
                .from('listings')
                .select('id, name, is_trial, trial_started_at, is_member')
                .eq('id', parseInt(listing_id_hint))
                .single();
            if (hintListing) {
                listingId = hintListing.id;
                if (membership_type === 'trial' &&
                    (hintListing.trial_started_at || hintListing.is_member)) {
                    return res.status(400).json({
                        error: 'Este hospedaje ya ha tenido una membresía de prueba o activa. Solo se permite una prueba gratuita por hospedaje. Por favor seleccione un plan de pago.'
                    });
                }
            }
          } else {
            // Fallback: word-by-word scoring match
            const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
            const appWords = normalize(property_name).split(/\s+/).filter(w => w.length >= 3);
            const { data: candidates } = await supabase
                .from('listings')
                .select('id, name, province, is_trial, trial_started_at, is_member')
                .limit(2000);
            const scored = (candidates||[]).map(l => {
                const lName = normalize(l.name);
                const lWords = normalize(l.name).split(/\s+/).filter(w => w.length >= 3);
                const matches = appWords.filter(w => lName.includes(w)).length;
                const provinceBonus = l.province === province ? 1 : 0;
                return { ...l, score: matches * 10 + provinceBonus };
            }).filter(l => {
                const lWords = l.name.split(/\s+/).filter(w => w.length >= 3);
                return l.score >= Math.min(2, appWords.length, lWords.length) * 10;
            }).sort((a,b) => b.score - a.score);
            const matchingListings = scored.slice(0, 1);
            if (matchingListings && matchingListings.length > 0) {
                listingId = matchingListings[0].id;
                if (membership_type === 'trial' &&
                    (matchingListings[0].trial_started_at || matchingListings[0].is_member)) {
                    return res.status(400).json({
                        error: 'Este hospedaje ya ha tenido una membresía de prueba o activa. Solo se permite una prueba gratuita por hospedaje. Por favor seleccione un plan de pago.'
                    });
                }
            }
          }
        }

        // ── Upload documents to Supabase Storage ──────────────────────────
        const documents = [];
        const fileFields = [
            { key: 'file_aviso',  type: 'aviso_operacion' },
            { key: 'file_cedula', type: 'cedula' },
            { key: 'file_pago',   type: 'comprobante_pago' }
        ];

        for (const { key, type } of fileFields) {
            const file = req.files?.[key]?.[0];
            if (!file) continue;
            const safeName = file.originalname
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-zA-Z0-9._-]/g, '_')
                .replace(/_+/g, '_').toLowerCase();
            const fileName = `applications/${Date.now()}-${type}-${safeName}`;
            const { error: uploadError } = await supabaseAdmin.storage
                .from('member-documents')
                .upload(fileName, file.buffer, {
                    contentType: file.mimetype,
                    upsert: false
                });
            if (uploadError) {
                console.error(`Upload error for ${type}:`, uploadError.message);
            } else {
                documents.push({
                    type, path: fileName,
                    uploaded: new Date().toISOString(),
                    mime: file.mimetype, size: file.size
                });
            }
        }

        // ── Build notes string ────────────────────────────────────────────
        const notesParts = [];
        if (how_found)     notesParts.push(`Cómo nos conoció: ${how_found}`);
        if (isMici && listing_phone) notesParts.push(`listing_phone: ${listing_phone}`);
        if (isMici && listing_email) notesParts.push(`listing_email: ${listing_email}`);
        const notesStr = notesParts.length ? notesParts.join(' | ') : null;

        // ── Block duplicate applications for the SAME confirmed listing only ──
        // Matching by property name is unreliable (a real case had two mismatched
        // names for the same property, only resolved by manual research), so this
        // only auto-blocks when listingId is a confirmed match — never on email
        // alone, since one owner may legitimately apply for multiple properties.
        // Unmatched/ambiguous cases are left for manual review, same as before.
        if (listingId) {
            const { data: dupeApps } = await supabaseAdmin
                .from('membership_applications')
                .select('id')
                .eq('listing_id', listingId)
                .in('status', ['pending', 'pre_approved'])
                .limit(1);
            if (dupeApps && dupeApps.length > 0) {
                return res.status(400).json({
                    error: 'Ya existe una solicitud pendiente para este hospedaje. Por favor espere a que sea revisada antes de enviar otra.'
                });
            }
        }

        // ── Save application to database ──────────────────────────────────
        const { data: application, error: insertError } = await supabaseAdmin
            .from('membership_applications')
            .insert({
                listing_id:        listingId,
                property_name:     property_name.trim(),
                province,
                contact_name:      contact_name.trim(),
                contact_email:     contact_email.trim().toLowerCase(),
                contact_phone:     contact_phone.trim(),
                membership_type,
                duration_months:   parseInt(duration_months) || 0,
                payment_method,
                documents:         documents.length ? documents : null,
                notes:             notesStr,
                ip_address:        ip,
                status:            'pending',
                registration_type: isMici ? 'mici' : 'atp'
            })
            .select()
            .single();

        if (insertError) throw new Error(insertError.message);

        await logEvent('membership_application_received', {
            application_id: application.id,
            property_name, membership_type,
            listing_id: listingId,
            registration_type: isMici ? 'mici' : 'atp'
        });

        // ── Send notification email to admin ──────────────────────────────
        const planText = membership_type === 'trial'
            ? 'Prueba gratuita 30 días'
            : (duration_months == 24 ? '2 años ($45)' : '1 año ($24)');

        const regBadge = isMici
            ? '<span style="background:#4a1a6b;color:#d4adf5;padding:2px 8px;border-radius:10px;font-size:12px;">MiCI</span>'
            : '<span style="background:#1a5c1a;color:#adf5ad;padding:2px 8px;border-radius:10px;font-size:12px;">ATP</span>';

        const subject = `Nueva solicitud de membresía: ${property_name}`;
        const message = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;">
<h2 style="color:#005ca9;">Nueva Solicitud de Membresía ${regBadge}</h2>
<table style="border-collapse:collapse;width:100%;max-width:500px;">
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Tipo:</td><td style="padding:6px;">${isMici ? '📄 Solo Aviso de Operación (MiCI)' : '✅ Registrado ATP'}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Hospedaje:</td><td style="padding:6px;">${property_name}</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Provincia:</td><td style="padding:6px;">${province}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Contacto:</td><td style="padding:6px;">${contact_name}</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Correo:</td><td style="padding:6px;">${contact_email}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Teléfono:</td><td style="padding:6px;">${contact_phone}</td></tr>
    ${isMici && listing_phone ? `<tr><td style="padding:6px;font-weight:bold;color:#555;">Tel. público:</td><td style="padding:6px;">${listing_phone}</td></tr>` : ''}
    ${isMici && listing_email ? `<tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Correo público:</td><td style="padding:6px;">${listing_email}</td></tr>` : ''}
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Plan:</td><td style="padding:6px;">${planText}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Pago:</td><td style="padding:6px;">${payment_method || 'N/A'}</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Documentos:</td><td style="padding:6px;">${documents.length} archivo(s)</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">ATP match:</td><td style="padding:6px;">${isMici ? 'N/A (MiCI)' : (listingId ? 'Sí (ID: '+listingId+')' : 'No encontrado')}</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">ID Solicitud:</td><td style="padding:6px;">${application.id}</td></tr>
</table>
<p style="margin-top:1rem;">
    <a href="https://trustedpanamastays.com/admin.html"
       style="background:#005ca9;color:white;padding:8px 16px;text-decoration:none;border-radius:5px;">
        Ver en Panel de Admin
    </a>
</p>
<p style="color:#888;font-size:12px;margin-top:1rem;">Trusted Panama Stays · info@trustedpanamastays.com</p>
</body></html>`;

        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        try {
            await execFileAsync('php', [notifyPath, subject, message, 'info@trustedpanamastays.com'], { timeout: 15000 });
        } catch (emailErr) {
            console.error('Email notification failed:', emailErr.message);
            await logEvent('notification_email_failed', { application_id: application.id, error: emailErr.message });
        }

        // ── Auto AI verification ──────────────────────────────────────────
        let autoVerifyResult = null;
        try {
            autoVerifyResult = await runAiVerification(application.id);
        } catch(verErr) {
            console.error('Auto-verify error:', verErr.message);
        }

        // ── Auto-approve trial on PASS ────────────────────────────────────
        if (autoVerifyResult?.overall_result === 'PASS' && membership_type === 'trial' && listingId) {
            try {
                const trialDays   = 30;
                const paidUntil   = new Date(Date.now() + trialDays * 86400000);
                const paidUntilStr = paidUntil.toISOString().split('T')[0];
                const bcrypt      = require('bcrypt');
                const password    = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 5);
                const hash        = await bcrypt.hash(password, 10);
                const slug        = await generateUniqueSlug(application.property_name, listingId);
                await supabaseAdmin.from('listings').update({
                    is_member: true, is_trial: true,
                    trial_started_at: new Date().toISOString(),
                    membership_paid_until: paidUntilStr,
                    member_password: hash, slug,
                    email_member: application.contact_email,
                    phone_member: application.contact_phone,
                    contact_name: application.contact_name,
                    feature_rank: 999
                }).eq('id', listingId);
                await supabaseAdmin.from('membership_applications').update({
                    status: 'approved',
                    reviewed_at: new Date().toISOString(),
                    reviewed_by: 'auto-ai',
                    documents_verified: true
                }).eq('id', application.id);
                await recalculateFeatureRanks();
                const msgType  = 'approved_trial';
                const emailHtml = generateEmailHtml({ ...application, listing_id: listingId }, msgType, password, paidUntilStr);
                const notifyPath = path.join(__dirname, 'public', 'notify.php');
                await execFileAsync('php', [notifyPath, `¡Bienvenido a Trusted Panama Stays! — ${application.property_name}`, emailHtml, application.contact_email], { timeout: 15000 }).catch(console.error);
                console.log(`✅ Auto-approved trial for ${application.property_name}`);
                return res.json({ success: true, application_id: application.id, listing_found: true, auto_approved: true, registration_type: 'atp' });
            } catch(autoErr) {
                console.error('Auto-approve error:', autoErr.message);
            }
        }

        res.json({ success: true, application_id: application.id, listing_found: !!listingId, registration_type: isMici ? 'mici' : 'atp' });

    } catch (err) {
        console.error('Membership application error:', err.message);
        await logEvent('membership_application_error', { error: err.message, property_name });
        res.status(500).json({ error: 'Error al procesar la solicitud: ' + err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  APPLICATIONS ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// ── Get all applications ──────────────────────────────────────────────────────
app.get('/api/admin/applications', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('membership_applications')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── Get single application ────────────────────────────────────────────────────
app.get('/api/admin/application/:id', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('membership_applications')
        .select('*')
        .eq('id', req.params.id)
        .single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    // Fetch latest payment amount from payments table
    const { data: payment } = await supabaseAdmin
          .from('payments')
          .select('amount_total, payment_date')
          .eq('application_id', req.params.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
    res.json({ ...data, amount_paid: payment?.amount_total || null });
});

// ── Update application status ─────────────────────────────────────────────────
app.post('/api/admin/application-status', requireAdmin, async (req, res) => {
    const { id, status, notes } = req.body;
    if (!id || !status) return res.status(400).json({ error: 'Missing fields' });
    const { error } = await supabaseAdmin
        .from('membership_applications')
        .update({ status, notes, reviewed_at: new Date().toISOString(), reviewed_by: 'admin' })
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('application_status_changed', { id, status });
    res.json({ success: true });
});

// ── Cross-check the application's stored duration against the actual
// recorded payment amount before crediting membership time. duration_months
// is set at submission time from either the customer's form selection or an
// AI plan guess, and both can end up wrong even after the 2026-08-22 fix to
// /api/submit-payment (e.g. an application entered/edited another way) — the
// verified payment amount is the most reliable signal available, so it wins
// over a disagreeing duration_months rather than being silently trusted.
// (Root cause of the 2026-08-22 Casitas Vista Verde case: a $48.15/2-year
// payment got credited as only 1 year because this endpoint trusted a stale
// duration_months=12 without ever looking at the recorded payment amount.)
async function resolveApprovedDurationMonths(app) {
    if (app.membership_type === 'trial') return 0;
    let months = app.duration_months || 12;
    try {
        const { data: payment } = await supabaseAdmin.from('payments')
            .select('amount_total').eq('application_id', app.id)
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
        const total = parseFloat(payment?.amount_total);
        const TOL = 0.5; // rounding tolerance in dollars
        if (!isNaN(total)) {
            if (Math.abs(total - 48.15) < TOL) months = 24;
            else if (Math.abs(total - 25.68) < TOL) months = 12;
            if (months !== (app.duration_months || 12)) {
                console.warn(`Approve-application: correcting duration for application ${app.id} — stored ${app.duration_months} months, payment amount $${total} implies ${months} months.`);
                await logEvent('duration_corrected_at_approval', { application_id: app.id, stored_months: app.duration_months, corrected_months: months, payment_amount: total });
            }
        }
    } catch (err) {
        console.error('resolveApprovedDurationMonths check failed:', err.message);
    }
    return months;
}

// ── Approve application ───────────────────────────────────────────────────────
app.post('/api/admin/approve-application', requireAdmin, async (req, res) => {
    const bcrypt = require('bcrypt');
    const { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'Missing application_id' });
    const { data: app, error: appError } = await supabaseAdmin.from('membership_applications').select('*').eq('id', application_id).single();
    if (appError || !app) return res.status(404).json({ error: 'Application not found' });
    try {
        const isTrial  = app.membership_type === 'trial';
        let listingId  = app.listing_id;

        // ── No ATP listing match — MiCI creates new listing, ATP sets pending ─
        if (!listingId) {
            const isMiciApp = app.registration_type === 'mici';

            if (isMiciApp) {
                // ── MiCI: create a brand new listing ─────────────────────
                // Extract listing_phone and listing_email from notes
                const notes = app.notes || '';
                const extractNote = (key) => {
                    const match = notes.match(new RegExp(`${key}:\\s*([^|]+)`));
                    return match ? match[1].trim() : null;
                };
                const pubPhone = extractNote('listing_phone') || app.contact_phone;
                const pubEmail = extractNote('listing_email') || app.contact_email;

                const chars    = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
                const password = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
                const hash     = await bcrypt.hash(password, 10);

                const correctedMonths = await resolveApprovedDurationMonths(app);
                const paidUntil = new Date();
                if (isTrial) paidUntil.setDate(paidUntil.getDate() + 30);
                else paidUntil.setFullYear(paidUntil.getFullYear() + (correctedMonths === 24 ? 2 : 1));
                const paidUntilStr = paidUntil.toISOString().split('T')[0];
                const slug = await generateUniqueSlug(app.property_name, 'new');

                const { data: newListing, error: insertError } = await supabaseAdmin
                    .from('listings')
                    .insert({
                        name:                  app.property_name,
                        province:              app.province,
                        registry_source:       'mici',
                        atp_active:            false,
                        is_member:             true,
                        is_trial:              isTrial,
                        trial_started_at:      isTrial ? new Date().toISOString() : null,
                        membership_paid_until: paidUntilStr,
                        member_password:       hash,
                        contact_name:          app.contact_name,
                        phone:                 pubPhone,
                        email:                 pubEmail,
                        slug,
                        invitation_status:     'member',
                        verified_at:           new Date().toISOString(),
                        verified_by:           'admin'
                    })
                    .select()
                    .single();

                if (insertError) throw new Error('Could not create MiCI listing: ' + insertError.message);
                listingId = newListing.id;

                // Update application with new listing_id and approved status
                await supabaseAdmin.from('membership_applications').update({
                    listing_id:  listingId,
                    status:      'approved',
                    reviewed_at: new Date().toISOString(),
                    reviewed_by: 'admin'
                }).eq('id', application_id);

                // Log invoice for paid plans
                if (!isTrial) {
                    const amount = correctedMonths === 24 ? 45 : 24;
                    const itbms  = parseFloat((amount * 0.07).toFixed(2));
                    await supabaseAdmin.from('event_log').insert({
                      event_type: 'invoice_pending',
                      event_data: { application_id, listing_id: listingId, property_name: app.property_name, contact_name: app.contact_name, contact_email: app.contact_email, ruc: null, amount, itbms, total: parseFloat((amount+itbms).toFixed(2)), plan: correctedMonths+' months', payment_method: app.payment_method, date: new Date().toISOString() },
                      created_at: new Date().toISOString()
                  });
                }

                // Send welcome email
                const msgType   = isTrial ? 'approved_trial' : 'approved_paid';
                const emailHtml = generateEmailHtml({ ...app, listing_id: listingId }, msgType, password, paidUntilStr);
                const waMsg     = generateWaText({ ...app, listing_id: listingId }, msgType, password, paidUntilStr);
                const hasEmail  = !!(app.contact_email && app.contact_email.includes('@'));
                let emailSent   = false;
                let waText      = null;

                if (hasEmail) {
                    const notifyPath = path.join(__dirname, 'public', 'notify.php');
                    try {
                        await execFileAsync('php', [notifyPath, 'Membresía aprobada - ' + app.property_name, emailHtml, app.contact_email], { timeout: 15000 });
                        emailSent = true;
                    } catch (err) { console.error('Welcome email failed:', err.message); waText = waMsg; }
                } else { waText = waMsg; }

                const phone = app.contact_phone?.replace(/[^\d]/g,'').substring(0,8) || null;
                await logEvent('application_approved_mici', { application_id, listing_id: listingId, property_name: app.property_name, paid_until: paidUntilStr });
                return res.json({ success: true, password, paid_until: paidUntilStr, listing_id: listingId, property_name: app.property_name, email_sent: emailSent, whatsapp_text: waText, phone, mici: true });

            } else {
                // ── ATP: no match found — set to pending_atp ─────────────
                const directoryUrl = 'https://trustedpanamastays.com/index_es.html';

                await supabaseAdmin.from('membership_applications').update({
                    status:             'pending_atp',
                    documents_verified: true,
                    auto_activate:      true,
                    notes:              'Documentos verificados. En espera de registro ATP.',
                    reviewed_at:        new Date().toISOString(),
                    reviewed_by:        'admin'
                }).eq('id', application_id);

                const notFoundMsg = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
</div>
<p>Estimado/a <strong>${app.contact_name}</strong>,</p>
<p>Gracias por su solicitud de membresía en <strong>TrustedPanamaStays.com</strong>.</p>
<p>Hemos recibido y verificado sus documentos. Ellos cumplen con los requisitos para la membresía, pero no hemos podido encontrar su hospedaje en el <em>Reporte de Hospedajes vigentes</em> de la ATP.</p>
<div style="background:#fffbe6;border:1px solid #FFD700;border-radius:8px;padding:1rem;margin:1rem 0;">
    <p style="margin:0 0 0.5rem;font-weight:bold;">¿Qué significa esto?</p>
    <p style="margin:0;font-size:0.9rem;">Su hospedaje aún no aparece en el registro oficial de la ATP. Una vez que su registro sea aprobado por la ATP y aparezca en su lista pública, activaremos su membresía de prueba gratuita de 30 días <strong>automáticamente</strong> — sin que usted tenga que hacer nada más.</p>
</div>
<p>Para registrarse con la ATP, visite:</p>
<p><a href="https://www.atp.gob.pa/industrias/hoteleros/" style="color:#005ca9;">https://www.atp.gob.pa/industrias/hoteleros/</a></p>
<p style="font-size:0.85rem;color:#666;">Si cree que su hospedaje ya está registrado bajo un nombre diferente, responda a este correo con el nombre exacto como aparece en el directorio:<br>
<a href="${directoryUrl}" style="color:#005ca9;">${directoryUrl}</a></p>
<p>¿Preguntas? <a href="mailto:info@trustedpanamastays.com" style="color:#005ca9;">info@trustedpanamastays.com</a></p>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>
</body></html>`;

                const hasEmail   = !!(app.contact_email && app.contact_email.includes('@'));
                let emailSent    = false;
                let waText       = null;
                const waFallback = `Hola! Somos Trusted Panama Stays.\n\nHemos verificado sus documentos para *${app.property_name}*. Todo está en orden, pero su hospedaje aún no aparece en el registro de la ATP.\n\nCuando la ATP registre su hospedaje, activaremos su membresía de prueba automáticamente.\n\nPara registrarse: https://www.atp.gob.pa/industrias/hoteleros/\n\nPreguntas? info@trustedpanamastays.com`;

                if (hasEmail) {
                    const notifyPath = path.join(__dirname, 'public', 'notify.php');
                    try {
                        await execFileAsync('php', [notifyPath, `Solicitud de membresía — ${app.property_name}`, notFoundMsg, app.contact_email], { timeout: 15000 });
                        emailSent = true;
                    } catch (err) { console.error('Not-found email failed:', err.message); waText = waFallback; }
                } else { waText = waFallback; }

                await logEvent('application_pending_atp', { application_id, property_name: app.property_name, email_sent: emailSent });
                const phone = app.contact_phone?.replace(/[^\d]/g,'').substring(0,8) || null;
                return res.json({ success: true, pending_atp: true, email_sent: emailSent, whatsapp_text: waText, property_name: app.property_name, phone });
            }
        }

        // ── Block duplicate trial ─────────────────────────────────────────
        if (isTrial && listingId) {
            const { data: existing } = await supabase.from('listings').select('is_trial, trial_started_at, is_member').eq('id', listingId).single();
            if (existing?.trial_started_at || existing?.is_member) {
                await supabaseAdmin.from('membership_applications').update({ status: 'rejected', notes: 'Rechazado automáticamente: ya tuvo prueba o membresía.', reviewed_at: new Date().toISOString(), reviewed_by: 'system' }).eq('id', application_id);
                await logEvent('application_auto_rejected', { application_id, reason: 'existing_trial_or_membership', listing_id: listingId });
                return res.status(400).json({ error: 'Este hospedaje ya tuvo una prueba gratuita o membresía. Solicitud rechazada automáticamente.' });
            }
        }

        // ── Generate password ─────────────────────────────────────────────
        const chars    = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        const password = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const hash     = await bcrypt.hash(password, 10);

        // ── Calculate dates ───────────────────────────────────────────────
        const correctedMonths = await resolveApprovedDurationMonths(app);
        const paidUntil = new Date();
        if (isTrial) paidUntil.setDate(paidUntil.getDate() + 30);
        else paidUntil.setFullYear(paidUntil.getFullYear() + (correctedMonths === 24 ? 2 : 1));
        const paidUntilStr = paidUntil.toISOString().split('T')[0];
        const slug = await generateUniqueSlug(app.property_name, listingId);

        // ── Update listing ────────────────────────────────────────────────
        await supabaseAdmin.from('listings').update({
            is_member:             true,
            is_trial:              isTrial,
            trial_started_at:      isTrial ? new Date().toISOString() : null,
            membership_paid_until: paidUntilStr,
            member_password:       hash,
            contact_name:          app.contact_name,
            slug,
            invitation_status:     'member',
            verified_at:           new Date().toISOString(),
            verified_by:           'admin'
        }).eq('id', listingId);

        // ── Log invoice for paid plans ────────────────────────────────────
        if (!isTrial) {
            const amount = correctedMonths === 24 ? 45 : 24;
            const itbms  = parseFloat((amount * 0.07).toFixed(2));
            await supabaseAdmin.from('event_log').insert({
                event_type: 'invoice_pending',
                event_data: { application_id, listing_id: listingId, property_name: app.property_name, contact_name: app.contact_name, contact_email: app.contact_email, ruc: null, amount, itbms, total: parseFloat((amount+itbms).toFixed(2)), plan: correctedMonths+' months', payment_method: app.payment_method, date: new Date().toISOString() },
                created_at: new Date().toISOString()
            });
        }

        // ── Update application status ─────────────────────────────────────
        await supabaseAdmin.from('membership_applications').update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: 'admin' }).eq('id', application_id);

        // ── Send welcome email ────────────────────────────────────────────
        const msgType   = isTrial ? 'approved_trial' : 'approved_paid';
        const emailHtml = generateEmailHtml({ ...app, listing_id: listingId }, msgType, password, paidUntilStr);
        const waMsg     = generateWaText({ ...app, listing_id: listingId }, msgType, password, paidUntilStr);
        const hasEmail  = !!(app.contact_email && app.contact_email.includes('@'));
        let emailSent   = false;
        let waText      = null;

        if (hasEmail) {
            const notifyPath = path.join(__dirname, 'public', 'notify.php');
            try {
                await execFileAsync('php', [notifyPath, 'Membresía aprobada - ' + app.property_name, emailHtml, app.contact_email], { timeout: 15000 });
                emailSent = true;
            } catch (err) { console.error('Welcome email failed:', err.message); waText = waMsg; }
        } else { waText = waMsg; }

        const phone = app.contact_phone?.replace(/[^\d]/g,'').substring(0,8) || null;
        await logEvent('application_approved', { application_id, listing_id: listingId, membership_type: app.membership_type, paid_until: paidUntilStr });
        await recalculateFeatureRanks();
        res.json({ success: true, password, paid_until: paidUntilStr, listing_id: listingId, property_name: app.property_name, email_sent: emailSent, whatsapp_text: waText, phone });

    } catch (err) {
        console.error('Approve error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ── Reject application ────────────────────────────────────────────────────────
app.post('/api/admin/reject-application', requireAdmin, async (req, res) => {
    const { application_id, reason, custom_note, is_payment_issue, silent } = req.body;
    if (!application_id || !reason) return res.status(400).json({ error: 'Missing fields' });
    const { data: app, error: appError } = await supabaseAdmin.from('membership_applications').select('*').eq('id', application_id).single();
    if (appError || !app) return res.status(404).json({ error: 'Not found' });

    const fullReason = reason + (custom_note ? '. ' + custom_note : '');
    const newStatus = silent ? 'archived' : 'rejected';
    await supabaseAdmin.from('membership_applications').update({ status: newStatus, notes: 'Razón: ' + fullReason, reviewed_at: new Date().toISOString(), reviewed_by: 'admin' }).eq('id', application_id);
    await logEvent('application_rejected', { application_id, reason, is_payment_issue, silent });
    if (silent) return res.json({ success: true, email_sent: false });
    const hasEmail  = !!(app.contact_email && app.contact_email.includes('@'));
    let emailSent   = false;
    let waText      = null;
    const msgType   = is_payment_issue ? 'rejected_payment' : 'rejected_other';
    const emailHtml = generateEmailHtml(app, msgType, null, null, fullReason);
    const waMsg     = generateWaText({ ...app, listing_id: app.listing_id }, msgType, null, null);

    if (hasEmail) {
        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        try { await execFileAsync('php', [notifyPath, 'Solicitud de membresía - ' + app.property_name, emailHtml, app.contact_email], { timeout: 15000 }); emailSent = true; }
        catch (err) { console.error('Rejection email failed:', err.message); waText = waMsg; }
    } else { waText = waMsg; }

    const phone = app.contact_phone?.replace(/[^\d]/g,'').substring(0,8) || null;
    res.json({ success: true, email_sent: emailSent, whatsapp_text: waText, property_name: app.property_name, phone });
});

// ── Get pending invoice log (for monthly QB export) ───────────────────────────
app.get('/api/admin/invoice-log', requireAdmin, async (req, res) => {
    try {
        // Legacy pending-invoice log entries (not yet issued through eFacturaPty)
        const { data: pendingEvents, error: pendingErr } = await supabaseAdmin
            .from('event_log')
            .select('*')
            .eq('event_type', 'invoice_pending')
            .order('created_at', { ascending: false });
        if (pendingErr) throw new Error(pendingErr.message);

        // Real issued invoices — from the payments table (CUFE, actual amounts from eFacturaPty)
        const { data: payments, error: payErr } = await supabaseAdmin
            .from('payments')
            .select('*')
            .order('created_at', { ascending: false });
        if (payErr) throw new Error(payErr.message);

        const listingIds = [...new Set(payments.map(p => p.listing_id).filter(Boolean))];
        const appIds      = [...new Set(payments.map(p => p.application_id).filter(Boolean))];

        const { data: listings } = listingIds.length
            ? await supabaseAdmin.from('listings').select('id, name').in('id', listingIds)
            : { data: [] };
        const { data: apps } = appIds.length
            ? await supabaseAdmin.from('membership_applications').select('id, contact_name, contact_email, ruc, ruc_dv, duration_months').in('id', appIds)
            : { data: [] };

        const listingMap = {}; (listings||[]).forEach(l => listingMap[l.id] = l);
        const appMap      = {}; (apps||[]).forEach(a => appMap[a.id] = a);

        const issuedInvoices = (payments||[]).map(p => {
            const listing = listingMap[p.listing_id] || {};
            const app     = appMap[p.application_id] || {};
            return {
                created_at: p.invoice_date || p.created_at,
                event_data: {
                    property_name:  listing.name || null,
                    contact_name:   app.contact_name || null,
                    contact_email:  app.contact_email || null,
                    ruc:            app.ruc ? `${app.ruc}-${app.ruc_dv||''}` : null,
                    plan:           app.duration_months ? `${app.duration_months} months` : null,
                    amount:         p.amount_net,
                    itbms:          p.itbms,
                    total:          p.amount_total,
                    payment_method: p.payment_method,
                    invoice_url:    p.invoice_url
                }
            };
        });

        // A single transaction can show up twice: once as a legacy 'invoice_pending'
        // event_log row (written at approval time, before the payments-table flow
        // existed for that application) and again as its real `payments` row
        // (written once the payment is recorded, whether or not it has been
        // invoiced yet). Once a payments row exists for an application_id, that
        // row is the accurate one — drop the matching legacy event_log entry so
        // the client doesn't appear twice in the Facturas list.
        // (2026-08-23: found via Daniel Gerber/Casitas Vista Verde appearing
        // twice — once from his approval-time event_log entry, once from his
        // actual payments row.)
        const paymentAppIds = new Set((payments||[]).map(p => p.application_id).filter(Boolean));
        const dedupedPendingEvents = (pendingEvents||[]).filter(e => {
            const appId = e.event_data && e.event_data.application_id;
            return !(appId && paymentAppIds.has(appId));
        });

        const combined = [...issuedInvoices, ...dedupedPendingEvents]
            .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

        res.json(combined);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get applicant contact/documents + payment/invoice info for a given listing ──
app.get('/api/admin/listing-application-info/:listingId', requireAdmin, async (req, res) => {
    const listingId = parseInt(req.params.listingId);
    try {
        const { data: applications } = await supabaseAdmin
            .from('membership_applications')
            .select('*')
            .eq('listing_id', listingId)
            .order('created_at', { ascending: false });

        const application = applications?.[0] || null;

        // Verification documents (Aviso de Operación, Cédula) are only
        // collected on the ORIGINAL join.html signup — a later renewal via
        // pay.html only carries a payment-proof document. Since this route
        // only ever surfaces the single most recent application, those
        // original documents would otherwise disappear from the admin's
        // member-detail view the moment a renewal application exists for
        // the same listing (2026-08-23: found via the Daniel Gerber/Casitas
        // Vista Verde invoice — his Aviso/Cédula, needed to confirm his RUC,
        // were on his original application but no longer reachable here).
        // Merge documents across every application on file so nothing that
        // was ever uploaded becomes unreachable — newest copy of each type wins.
        if (application && applications.length > 1) {
            const seenTypes = new Map();
            for (const app of applications) { // already newest-first
                for (const doc of (app.documents || [])) {
                    if (!seenTypes.has(doc.type)) seenTypes.set(doc.type, doc);
                }
            }
            application.documents = Array.from(seenTypes.values());
        }

        const { data: payment } = await supabaseAdmin
            .from('payments')
            .select('*')
            .eq('listing_id', listingId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        res.json({ application: application || null, payment: payment || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/submit-payment',
    uploadDocs.fields([{ name: 'file_pago', maxCount: 1 }]),
    async (req, res) => {
    const { listing_id, duration_months, payment_method, contact_email,
            contact_ruc, contact_dv, contact_name: contact_bname, token } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'Missing listing_id' });
    if (token) {
        try {
            const decoded = Buffer.from(token, 'base64').toString();
            const [tokenId] = decoded.split(':');
            if (tokenId !== String(listing_id)) return res.status(403).json({ error: 'Invalid token' });
        } catch { return res.status(403).json({ error: 'Invalid token' }); }
    }
    try {
        const { data: listing } = await supabase
            .from('listings')
            .select('id, name, province, email, email_member, phone, contact_name')
            .eq('id', listing_id).single();
        if (!listing) return res.status(404).json({ error: 'Listing not found' });

        // Upload payment proof
        let documentPath = null;
        const file = req.files?.file_pago?.[0];
        if (file) {
            const safeName = file.originalname.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').toLowerCase();
            const fileName = 'payments/' + listing_id + '/' + Date.now() + '-' + safeName;
            const { error: uploadError } = await supabaseAdmin.storage.from('member-documents').upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });
            if (!uploadError) documentPath = fileName;
        }

        // ── AI verify payment proof ───────────────────────────────────────────
        let verificationResult = 'PENDING';
        let verificationSummary = 'PAY:PENDING:no_proof';
        let autoActivated = false;
        let detectedPlan = duration_months === '24' ? '2year' : '1year';
        let aiData = null; // populated below if AI verification runs; stays null otherwise

        if (documentPath && file) {
            try {
                const { data: fileData } = await supabaseAdmin.storage.from('member-documents').download(documentPath);
                if (fileData) {
                    const arrayBuffer = await fileData.arrayBuffer();
                    const base64 = Buffer.from(arrayBuffer).toString('base64');
                    const isPdf = file.mimetype === 'application/pdf';
                    const docContent = isPdf
                        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
                        : { type: 'image',    source: { type: 'base64', media_type: file.mimetype,        data: base64 } };

                    const expected1yr = (24 * 1.07).toFixed(2);
                    const expected2yr = (45 * 1.07).toFixed(2);

                    const prompt = `Verify this payment proof for a Panama business directory membership.
Property ID: ${listing_id}, Name: ${listing.name}
Expected amounts WITH 7% ITBMS included: $${expected1yr} (1 year = $24 + ITBMS) or $${expected2yr} (2 years = $45 + ITBMS).
IMPORTANT: $24.00 or $45.00 WITHOUT ITBMS is INCORRECT. Only $${expected1yr} or $${expected2yr} are correct amounts.
If amount is $45.00 (without ITBMS), set amount_matches to false and note underpayment of $3.15.
The transfer description/mensaje should contain "TPS ${listing_id}".
CRITICAL: "amount_found" must be the exact number printed on the receipt — read it
digit by digit, do not round or guess toward either expected amount above. Set
"plan" strictly from which expected amount "amount_found" actually matches
(2year if it matches $${expected2yr}, 1year if it matches $${expected1yr}) — if it
matches neither, set "plan" to "unclear" rather than guessing.
Return ONLY a JSON object (the example values below are placeholders only —
do not copy them, they are intentionally NOT one of the expected amounts):
{
  "amount_found": 33.30,
  "amount_matches": true,
  "date": "2026-07-18",
  "date_recent": true,
  "description_ok": true,
  "description_text": "TPS 11134",
  "bank": "Banco General",
  "confirmation": "#1545221148",
  "destination_account": "104313259",
  "status_text": "REALIZADA",
  "plan": "unclear",
  "overall": "REVIEW",
  "notes": "brief summary"
}
overall: PASS (amount correct, recent, REALIZADA), REVIEW (minor issues), FAIL (wrong amount or fake).`;

                    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
                        model: 'claude-opus-4-5', max_tokens: 500,
                        messages: [{ role: 'user', content: [docContent, { type: 'text', text: prompt }] }]
                    }, { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 30000 });

                    aiData = JSON.parse(aiResp.data.content[0].text.replace(/\`\`\`json\n?|\n?\`\`\`/g, '').trim());
                    // Derive the plan from the amount actually read off the receipt
                    // rather than trusting a separately-generated "plan" field (or
                    // the raw form default) that can disagree with it — amount_found
                    // is the most reliable signal available here, and trusting a
                    // mismatched plan field silently under-credits a paying customer
                    // (2026-08-22: a $48.15/2-year receipt got stored as 12 months
                    // because aiData.plan didn't match what the receipt actually said).
                    const foundAmount = parseFloat(aiData.amount_found);
                    const PLAN_TOL = 0.5; // rounding tolerance in dollars
                    if (!isNaN(foundAmount) && Math.abs(foundAmount - parseFloat(expected2yr)) < PLAN_TOL) {
                        detectedPlan = '2year';
                    } else if (!isNaN(foundAmount) && Math.abs(foundAmount - parseFloat(expected1yr)) < PLAN_TOL) {
                        detectedPlan = '1year';
                    } else {
                        detectedPlan = aiData.plan || detectedPlan; // amount doesn't clearly match either price
                    }
                    verificationResult = aiData.overall || 'REVIEW';
                    verificationSummary = `PAY:${verificationResult}:${aiData.amount_found}:${aiData.date}:${aiData.description_text||''}:${aiData.bank||''}:${aiData.confirmation||''}`;

                    if (verificationResult === 'PASS') {
                      // Extend from existing paid_until if still in future, otherwise from today
                        const { data: currentListing } = await supabaseAdmin.from('listings').select('membership_paid_until').eq('id', listing_id).single();
                        const baseDate = new Date(Math.max(
                          new Date(currentListing?.membership_paid_until || 0).getTime(),
                          new Date().getTime()
                        ));
                        detectedPlan === '2year' ? baseDate.setFullYear(baseDate.getFullYear() + 2) : baseDate.setFullYear(baseDate.getFullYear() + 1);
                        const paidUntilStr = baseDate.toISOString().split('T')[0];
                        await supabaseAdmin.from('listings').update({ is_member: true, is_trial: false, membership_paid_until: paidUntilStr, invitation_status: 'member' }).eq('id', listing_id);
                        autoActivated = true;
                        await recalculateFeatureRanks();
                        await logEvent('payment_auto_activated', { listing_id: parseInt(listing_id), plan: detectedPlan, paid_until: paidUntilStr });
                    }
                }
            } catch(aiErr) {
                console.error('Payment AI verify error:', aiErr.message);
                verificationResult = 'ERROR';
                verificationSummary = 'PAY:ERROR:' + aiErr.message.substring(0, 50);
            }
        }

        // Insert application record
        const months = detectedPlan === '2year' ? 24 : 12;
        const { data: submission } = await supabaseAdmin.from('membership_applications').insert({
            listing_id:          parseInt(listing_id),
            property_name:       listing.name,
            province:            listing.province,
            contact_name:        listing.contact_name || '',
            contact_email:       contact_email || listing.email_member || listing.email || '',
            contact_phone:       listing.phone || '',
            membership_type:     'paid',
            duration_months:     months,
            payment_method:      payment_method || 'transfer',
            ruc:                 contact_ruc || null,
            ruc_dv:              contact_dv || null,
            business_name:       contact_bname || null,
            documents:           documentPath ? [{ type: 'comprobante_pago', path: documentPath, uploaded: new Date().toISOString(), mime: file?.mimetype, size: file?.size }] : null,
            notes:               'Payment renewal submission',
            status:              autoActivated ? 'pre_approved' : 'pending',
            verification_result: verificationSummary
        }).select().single();

        // ── Record the reported/verified amount in the payments table so the ──
        // admin panel's "Send Invoice" form can read amount_paid reliably,
        // instead of falling back to parsing it out of verification_result text.
        // This is NOT an issued invoice yet (no CUFE) — just the proof-of-payment
        // amount, same 'pending' status the admin-application lookup expects.
        if (submission) {
            const reportedTotal = aiData?.amount_found ? parseFloat(aiData.amount_found) : null;
            const netAmount   = reportedTotal ? Math.round(reportedTotal / 1.07 * 100) / 100 : null;
            const itbmsAmount = netAmount ? Math.round(netAmount * 0.07 * 100) / 100 : null;
            await supabaseAdmin.from('payments').insert({
                listing_id:     parseInt(listing_id),
                application_id: submission.id,
                amount_net:     netAmount,
                itbms:          itbmsAmount,
                amount_total:   reportedTotal,
                payment_method: payment_method || 'transfer',
                invoice_date:   new Date().toISOString().split('T')[0],
                status:         'pending'
            }).then(({ error }) => {
                if (error) console.error('Failed to record payment amount:', error.message);
            });
        }

        // Send notification email
        const statusIcon = verificationResult === 'PASS' ? '✅' : verificationResult === 'REVIEW' ? '⚠️' : '❌';
        const subject = 'Comprobante de pago recibido: ' + listing.name;
        const message = `<html><body style="font-family:Arial,sans-serif;font-size:14px;"><h2 style="color:#005ca9;">Comprobante de Pago Recibido</h2><p><strong>Hospedaje:</strong> ${listing.name}<br><strong>ID:</strong> ${listing_id}<br><strong>Verificación AI:</strong> ${statusIcon} ${verificationResult}<br><strong>Detalle:</strong> ${verificationSummary}</p>${autoActivated ? '<p style="color:#00a859;font-weight:bold;">✅ Membresía pre-activada automáticamente</p>' : '<p style="color:#e67e22;">⚠️ Requiere revisión manual</p>'}<p><a href="https://trustedpanamastays.com/admin.html" style="background:#005ca9;color:white;padding:8px 16px;text-decoration:none;border-radius:5px;">Ver en Admin</a></p></body></html>`;
        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        await execFileAsync('php', [notifyPath, subject, message, 'info@trustedpanamastays.com'], { timeout: 15000 }).catch(err => console.error('Payment notify failed:', err.message));

        await logEvent('payment_submitted', { listing_id: parseInt(listing_id), duration_months: months, has_proof: !!documentPath, verification: verificationResult });
        res.json({ success: true, submission_id: submission?.id, verification: verificationResult, auto_activated: autoActivated, summary: verificationSummary });

    } catch (err) {
        console.error('Payment submission error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/admin/document-url', requireAdmin, async (req, res) => {
    const { path: filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: 'Missing path' });
    const { data, error } = await supabaseAdmin.storage
        .from('member-documents')
        .createSignedUrl(filePath, 3600);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
});

// ── POST /api/listing-change-password ─────────────────────────────────────────
app.post('/api/listing-change-password', async (req, res) => {
    const bcrypt = require('bcrypt');
    const { id, token, current_password, new_password } = req.body;
    if (!id || !token || !current_password || !new_password)
        return res.status(400).json({ error: 'Missing fields' });
    if (new_password.length < 6)
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    // Verify token
    try {
        const decoded = Buffer.from(token, 'base64').toString();
        const [tokenId] = decoded.split(':');
        if (tokenId !== String(id)) return res.status(403).json({ error: 'Invalid token' });
    } catch { return res.status(403).json({ error: 'Invalid token' }); }

    // Get current password hash
    const { data, error } = await supabase
        .from('listings')
        .select('member_password')
        .eq('id', id)
        .single();
    if (error || !data) return res.status(404).json({ error: 'Listing not found' });

    // Verify current password
    const match = await bcrypt.compare(current_password, data.member_password);
    if (!match) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    // Save new password
    const hash = await bcrypt.hash(new_password, 10);
    const { error: updateError } = await supabase
        .from('listings')
        .update({ member_password: hash, password_changed: true })
        .eq('id', id);
    if (updateError) return res.status(500).json({ error: updateError.message });

    await logEvent('member_password_changed', { listing_id: id });
    res.json({ success: true });
});

// ── POST /api/request-password-reset ─────────────────────────────────────────
app.post('/api/request-password-reset', async (req, res) => {
    const { listing_id, email } = req.body;
    if (!listing_id || !email)
        return res.status(400).json({ error: 'Missing fields' });

    // Find listing and verify email matches
    const { data: listing, error } = await supabase
        .from('listings')
        .select('id, name, email_member, email')
        .eq('id', listing_id)
        .single();

    if (error || !listing) {
        // Don't reveal if listing exists — always return success
        return res.json({ success: true });
    }

    const memberEmail = (listing.email_member || listing.email || '').toLowerCase().trim();
    const inputEmail  = email.toLowerCase().trim();

    if (memberEmail !== inputEmail) {
        // Email doesn't match — still return success (security)
        return res.json({ success: true });
    }

    // Generate reset token
    const crypto = require('crypto');
    const token  = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Save token to database
    const { error: insertError } = await supabase
        .from('password_reset_tokens')
        .insert({
            listing_id: listing.id,
            token,
            expires_at: expires.toISOString(),
            used: false
        });
    if (insertError) return res.status(500).json({ error: 'Could not create reset token' });

    // Send reset email
    const resetUrl = `https://trustedpanamastays.com/reset-password.html?token=${token}&id=${listing.id}`;
    const subject  = 'Recuperación de contraseña — Trusted Panama Stays';
    const message  = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
</div>
<p>Hemos recibido una solicitud para restablecer la contraseña de <strong>${listing.name}</strong>.</p>
<p>Haga clic en el siguiente enlace para crear una nueva contraseña:</p>
<p style="margin:1.5rem 0;">
    <a href="${resetUrl}"
       style="background:#005ca9;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:bold;">
        Restablecer contraseña
    </a>
</p>
<p style="color:#666;font-size:0.85rem;">Este enlace es válido por <strong>1 hora</strong>.</p>
<p style="color:#666;font-size:0.85rem;">Si no solicitó este cambio, ignore este mensaje — su contraseña no cambiará.</p>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>
</body></html>`;

    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    try {
        await execFileAsync('php', [notifyPath, subject, message, memberEmail], { timeout: 15000 });
    } catch (err) {
        console.error('Reset email failed:', err.message);
        return res.status(500).json({ error: 'Could not send reset email' });
    }

    await logEvent('password_reset_requested', { listing_id: listing.id });
    res.json({ success: true });
});

// ── POST /api/reset-password ──────────────────────────────────────────────────
app.post('/api/reset-password', async (req, res) => {
    const bcrypt = require('bcrypt');
    const { token, listing_id, new_password } = req.body;
    if (!token || !listing_id || !new_password)
        return res.status(400).json({ error: 'Missing fields' });
    if (new_password.length < 6)
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    // Find and validate token
    const { data: resetToken, error } = await supabase
        .from('password_reset_tokens')
        .select('*')
        .eq('token', token)
        .eq('listing_id', listing_id)
        .eq('used', false)
        .single();

    if (error || !resetToken)
        return res.status(400).json({ error: 'Enlace inválido o ya utilizado' });

    if (new Date(resetToken.expires_at) < new Date())
        return res.status(400).json({ error: 'El enlace ha expirado. Solicite uno nuevo.' });

    // Save new password
    const hash = await bcrypt.hash(new_password, 10);
    const { error: updateError } = await supabase
        .from('listings')
        .update({ member_password: hash, password_changed: true })
        .eq('id', listing_id);
    if (updateError) return res.status(500).json({ error: updateError.message });

    // Mark token as used
    await supabase
        .from('password_reset_tokens')
        .update({ used: true })
        .eq('id', resetToken.id);

    await logEvent('password_reset_completed', { listing_id });
    res.json({ success: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Featured listing
//  Now returns ALL listings with feature_rank > 0, ordered by rank desc
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/featured-listing', async (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data: listings, error } = await supabase
          .from('listings')
          .select('id, name, phone, email, province, rental_type, phone_member, email_member, address, photos, is_member, membership_paid_until, slug, website_url, booking_url, registry_source, atp_active, apatel_member, is_trial, feature_rank')
          .gt('feature_rank', 0)
          .eq('is_member', true)
          .gte('membership_paid_until', today)
          .order('feature_rank', { ascending: false });

        if (error) throw new Error(error.message);
        if (!listings || listings.length === 0)
            return res.status(404).json({ error: 'No featured listings' });

        res.json(listings);  // returns array
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



app.post('/api/admin/send-invitation-emails', requireAdmin, async (req, res) => {
    const { filter, dry_run } = req.body;
    // filter: 'all' | 'apatel' | 'no-email' (for WA list)
    // dry_run: true = just count, don't send

    try {
        // Build query
        let query = supabase
            .from('listings')
            .select('id, name, email, province, rental_type, slug, apatel_member, invitation_status, invitation_sent_at, atp_active')
            .eq('is_member', false)  // non-members only
            .is('invitation_sent_at', null); // not yet invited

            if (filter === 'apatel') query = query.eq('apatel_member', true);
            if (filter === 'no-email') {
                query = query.or('email.is.null,email.eq.,email.ilike.no%,email.ilike.n/t');
            } else {
                query = query.not('email', 'is', null).neq('email', '').not('email', 'ilike', 'no%').not('email', 'ilike', 'n/t');
            }

            let { data: listings, error } = await query;
            if (error) throw new Error(error.message);

            // Final validation pass: a proper email regex catches anything that slipped
            // through the SQL-level filter — malformed addresses (missing @), stray phone
            // numbers typed into the email field, etc. Never count/send to these.
            const isValidEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e||'').trim());
            if (filter !== 'no-email') {
                listings = (listings||[]).filter(l => isValidEmail(l.email));
            }

            if (!listings || listings.length === 0)
                return res.json({ success: true, sent: 0, skipped: 0, message: 'No eligible listings found' });

            if (dry_run)
                return res.json({ success: true, dry_run: true, count: listings.length,
                    has_email: listings.filter(l => isValidEmail(l.email)).length,
                    no_email: listings.filter(l => !isValidEmail(l.email)).length,
                    apatel: listings.filter(l => l.apatel_member).length });

        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        let sent = 0, skipped = 0, errors = 0;

        for (const listing of listings) {
            if (!listing.email || !listing.email.includes('@')) { skipped++; continue; }

            const listUrl = listing.slug
                ? `https://trustedpanamastays.com/listing.html?slug=${listing.slug}&lang=es`
                : `https://trustedpanamastays.com/listing.html?id=${listing.id}&lang=es`;
            const joinUrl = 'https://trustedpanamastays.com/join.html';

            const isApatel = listing.apatel_member;
            const greeting = `Le contactamos porque su hospedaje aparece en el registro público de hospedajes de la ATP.`;

            const subject = `Su hospedaje ya está en Trusted Panama Stays — ${listing.name}`;
            const message = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.3rem 0 0;font-size:0.88rem;">Directorio de hospedajes legalmente registrados en Panamá</p>
</div>

<p>Estimado/a propietario/a de <strong>${listing.name}</strong>,</p>
<p>${greeting}</p>
<p>Hemos creado <strong>Trusted Panama Stays</strong>, un directorio gratuito para turistas internacionales que buscan hospedajes legalmente registrados en Panamá — sin las comisiones de Booking.com o Airbnb (15–20%).</p>

<div style="background:#f0f7ff;border:1px solid #c0d8f0;border-radius:8px;padding:1rem;margin:1rem 0;">
    <p style="margin:0 0 0.5rem;font-weight:bold;color:#005ca9;">Su hospedaje ya aparece en nuestro directorio:</p>
    <p style="margin:0;"><a href="${listUrl}" style="color:#005ca9;font-size:1rem;">${listUrl}</a></p>
</div>

<p>Con una <strong>membresía de prueba gratuita</strong> (sin costo, sin obligación) puede:</p>
<ul style="margin:0.5rem 0 1rem 1.5rem;line-height:2;">
    <li>Agregar hasta <strong>20 fotos</strong> de su hospedaje</li>
    <li>Publicar una <strong>descripción en inglés y español</strong></li>
    <li>Mostrar su <strong>dirección completa</strong></li>
    <li>Incluir enlaces a su <strong>sitio web y sistema de reservas</strong></li>
</ul>

<p style="text-align:center;margin:1.5rem 0;">
    <a href="${joinUrl}" style="background:#005ca9;color:white;padding:12px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;display:inline-block;">
        Solicitar membresía gratuita →
    </a>
</p>

<p style="font-size:0.85rem;color:#666;">
    El costo después del período de prueba es solo <strong>$24/año + ITBMS</strong> — menos de $2 al mes.<br>
    Hospedajes informales son excluidos de la plataforma.
</p>

<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">
    Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
    <a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a><br>
    Para cancelar estas comunicaciones responda con "No gracias".
</p>
</body></html>`;

            try {
                await execFileAsync('php', [
                    notifyPath, subject, message, listing.email
                ], { timeout: 15000 });

                // Mark as invited
                await supabase.from('listings').update({
                    invitation_status:  'invited',
                    invitation_sent_at: new Date().toISOString()
                }).eq('id', listing.id);

                await logEvent('invitation_email_sent', {
                    listing_id: listing.id,
                    name:       listing.name,
                    email:      listing.email,
                    apatel:     isApatel
                });

                sent++;

                // Throttle — 1 email per 300ms to avoid SMTP limits
                await new Promise(r => setTimeout(r, 300));

            } catch (err) {
                console.error(`Email failed for ${listing.name}:`, err.message);
                errors++;
            }
        }

        res.json({ success: true, sent, skipped, errors, total: listings.length });

    } catch (err) {
        console.error('Send invitations error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ── GET /api/admin/invitation-stats ──────────────────────────────────────────
app.get('/api/admin/invitation-stats', requireAdmin, async (req, res) => {
    try {
      let data = [];
      let from = 0;
      const BATCH = 1000;
      while (true) {
          const { data: batch, error } = await supabase
              .from('listings')
              .select('id, email, apatel_member, invitation_status, invitation_sent_at, is_member')
              .eq('is_member', false)
              .range(from, from + BATCH - 1);
          if (error) throw new Error(error.message);
          data = data.concat(batch);
          if (batch.length < BATCH) break;
          from += BATCH;
      }

        const stats = {
            total_non_members: data.length,
            has_email:         data.filter(l => l.email && l.email.includes('@')).length,
            no_email:          data.filter(l => !l.email || !l.email.includes('@')).length,
            apatel:            data.filter(l => l.apatel_member).length,
            apatel_email:      data.filter(l => l.apatel_member && l.email && l.email.includes('@')).length,
            not_invited:       data.filter(l => !l.invitation_sent_at).length,
            invited:           data.filter(l => !!l.invitation_sent_at).length,
        };
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/track ───────────────────────────────────────────────────────────
// Lightweight event tracking — no auth required, rate limited by IP
const trackRateLimit = new Map(); // ip -> {count, reset}

app.post('/api/track', async (req, res) => {
    const { event_type, listing_id } = req.body;
    if (!event_type) return res.status(400).json({ error: 'Missing event_type' });

    // Rate limit: max 60 events per IP per minute
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    const rl  = trackRateLimit.get(ip) || { count: 0, reset: now + 60000 };
    if (now > rl.reset) { rl.count = 0; rl.reset = now + 60000; }
    rl.count++;
    trackRateLimit.set(ip, rl);
    if (rl.count > 60) return res.status(429).json({ error: 'Rate limited' });

    // Clean up old entries periodically
    if (trackRateLimit.size > 10000) {
        for (const [k, v] of trackRateLimit) {
            if (now > v.reset) trackRateLimit.delete(k);
        }
    }

    try {
        await supabase.from('listing_events').insert({
            event_type,
            listing_id: listing_id ? parseInt(listing_id) : null,
            ip,
            created_at: new Date().toISOString()
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── GET /api/admin/analytics ──────────────────────────────────────────────────
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    try {
        const adminIp = await getAdminIP(); // excluded from all counts below

        // Total counts by event type
        let totalsQuery = supabaseAdmin
            .from('listing_events')
            .select('event_type')
            .gte('created_at', since);
        if (adminIp) totalsQuery = totalsQuery.or(`ip.is.null,ip.neq.${adminIp}`);
        const { data: totals } = await totalsQuery;
        const counts = {};
        (totals || []).forEach(e => {
            counts[e.event_type] = (counts[e.event_type] || 0) + 1;
        });
        // Top listings by views
        let viewsQuery = supabaseAdmin
            .from('listing_events')
            .select('listing_id')
            .eq('event_type', 'listing_view')
            .gte('created_at', since)
            .not('listing_id', 'is', null);
        if (adminIp) viewsQuery = viewsQuery.or(`ip.is.null,ip.neq.${adminIp}`);
        const { data: views } = await viewsQuery;

        const listingCounts = {};
        (views || []).forEach(e => {
            listingCounts[e.listing_id] = (listingCounts[e.listing_id] || 0) + 1;
        });

        const topListings = Object.entries(listingCounts)
            .sort(([,a],[,b]) => b - a)
            .slice(0, 20)
            .map(([id, count]) => ({ listing_id: parseInt(id), views: count }));

        // Enrich with listing names
        if (topListings.length > 0) {
            const ids = topListings.map(l => l.listing_id);
            const { data: names } = await supabase
                .from('listings')
                .select('id, name, province, slug')
                .in('id', ids);
            const nameMap = {};
            (names || []).forEach(l => { nameMap[l.id] = l; });
            topListings.forEach(l => {
                const info = nameMap[l.listing_id] || {};
                l.name     = info.name || '—';
                l.province = info.province || '';
                l.slug     = info.slug || '';
            });
        }

        res.json({ days, since, counts, top_listings: topListings });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── GET /api/admin/analytics/listing/:id ─────────────────────────────────────
app.get('/api/admin/analytics/listing/:id', requireAdmin, async (req, res) => {
    const listingId = parseInt(req.params.id);
    const days      = parseInt(req.query.days) || 30;
    const since     = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    try {
        const adminIp = await getAdminIP();
        let eventsQuery = supabaseAdmin
            .from('listing_events')
            .select('event_type, created_at')
            .eq('listing_id', listingId)
            .gte('created_at', since)
            .order('created_at', { ascending: false });
        if (adminIp) eventsQuery = eventsQuery.or(`ip.is.null,ip.neq.${adminIp}`);
        const { data: events } = await eventsQuery;

        const counts = {};
        (events || []).forEach(e => {
            counts[e.event_type] = (counts[e.event_type] || 0) + 1;
        });

        // Daily breakdown
        const daily = {};
        (events || []).forEach(e => {
            const day = e.created_at.split('T')[0];
            if (!daily[day]) daily[day] = {};
            daily[day][e.event_type] = (daily[day][e.event_type] || 0) + 1;
        });

        res.json({ listing_id: listingId, days, counts, daily });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── GET /api/admin/send-weekly-report ─────────────────────────────────────────
app.get('/api/admin/send-weekly-report', async (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).send('Denied');

    try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const { data: events } = await supabaseAdmin
            .from('listing_events')
            .select('event_type, listing_id, created_at')
            .gte('created_at', since);

        const counts = {};
        const listingCounts = {};
        (events || []).forEach(e => {
            counts[e.event_type] = (counts[e.event_type] || 0) + 1;
            if (e.listing_id) {
                listingCounts[e.listing_id] = (listingCounts[e.listing_id] || 0) + 1;
            }
        });

        const topListings = Object.entries(listingCounts)
            .sort(([,a],[,b]) => b - a)
            .slice(0, 10);

        // Get listing names
        if (topListings.length > 0) {
            const ids = topListings.map(([id]) => parseInt(id));
            const { data: names } = await supabase.from('listings').select('id, name').in('id', ids);
            const nameMap = {};
            (names || []).forEach(l => { nameMap[l.id] = l.name; });

            const rows = topListings.map(([id, count]) =>
                `<tr><td style="padding:6px 12px;">${nameMap[id] || id}</td><td style="padding:6px 12px;text-align:center;"><strong>${count}</strong></td></tr>`
            ).join('');

            const message = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;">📊 Weekly Analytics Report</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.3rem 0 0;">Trusted Panama Stays · Last 7 days</p>
</div>
<h3 style="color:#005ca9;">Summary</h3>
<table style="border-collapse:collapse;width:100%;margin-bottom:1.5rem;">
    <tr style="background:#f8f9fa;"><td style="padding:6px 12px;">Site visits</td><td style="padding:6px 12px;text-align:center;"><strong>${counts.site_visit || 0}</strong></td></tr>
    <tr><td style="padding:6px 12px;">Listing views</td><td style="padding:6px 12px;text-align:center;"><strong>${counts.listing_view || 0}</strong></td></tr>
    <tr style="background:#f8f9fa;"><td style="padding:6px 12px;">WhatsApp clicks</td><td style="padding:6px 12px;text-align:center;"><strong>${counts.whatsapp_click || 0}</strong></td></tr>
    <tr><td style="padding:6px 12px;">Email clicks</td><td style="padding:6px 12px;text-align:center;"><strong>${counts.email_click || 0}</strong></td></tr>
    <tr style="background:#f8f9fa;"><td style="padding:6px 12px;">Website clicks</td><td style="padding:6px 12px;text-align:center;"><strong>${counts.website_click || 0}</strong></td></tr>
    <tr><td style="padding:6px 12px;">Booking clicks</td><td style="padding:6px 12px;text-align:center;"><strong>${counts.booking_click || 0}</strong></td></tr>
    <tr style="background:#f8f9fa;"><td style="padding:6px 12px;">Photo browses</td><td style="padding:6px 12px;text-align:center;"><strong>${counts.photo_browse || 0}</strong></td></tr>
</table>
<h3 style="color:#005ca9;">Top Listings by Activity</h3>
<table style="border-collapse:collapse;width:100%;">
    <tr style="background:#005ca9;color:white;"><th style="padding:6px 12px;text-align:left;">Listing</th><th style="padding:6px 12px;">Events</th></tr>
    ${rows}
</table>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA</p>
</body></html>`;

            const notifyPath = require('path').join(__dirname, 'public', 'notify.php');
            await execFileAsync('php', [notifyPath, 'Weekly Analytics Report — Trusted Panama Stays', message, 'info@trustedpanamastays.com'], { timeout: 15000 });
        }

        res.json({ success: true, events: events?.length || 0, counts });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/admin/apatel-campaign-stats ──────────────────────────────────────
app.get('/api/admin/apatel-campaign-stats', requireAdmin, async (req, res) => {
    try {
        const { data } = await supabaseAdmin
            .from('event_log')
            .select('event_data')
            .eq('event_type', 'apatel_campaign_sent')
            .order('created_at', { ascending: false });

        const sent      = data?.length || 0;
        const remaining = 121 - sent;
        const lastSent  = data?.[0]?.event_data;

        res.json({ sent, remaining, total: 121, last_sent: lastSent });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Preview: builds the actual email HTML using the real template function,
// with example placeholder values — so the in-panel preview genuinely matches
// what a real recipient receives, instead of a separately-maintained copy.
app.post('/api/admin/preview-followup-html', requireAdmin, async (req, res) => {
    const { body } = req.body;
    if (typeof body !== 'string') return res.status(400).json({ error: 'Missing body' });
    const sampleBody = body.includes('{url}')
        ? body.split('{url}').join('https://trustedpanamastays.com/listing.php?id=00000&lang=es')
        : body;
    const html = buildFollowupHtml('HOTEL EJEMPLO', 'Juan García', sampleBody);
    res.json({ html });
});


// ── POST /api/admin/send-followup-test ───────────────────────────────────────
// Send test email to info@ only
app.post('/api/admin/send-followup-test', requireAdmin, async (req, res) => {
    const { subject, body, from } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Missing subject or body' });

    const sender = resolveSender(from);
    const testSubject = subject.includes('{id}') ? subject.split('{id}').join('99999') : subject;
    const fullHtml = buildFollowupHtml('HOTEL EJEMPLO', 'Juan García', body);
    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    try {
        await execFileAsync('php', [
            notifyPath,
            '[TEST] ' + testSubject,
            fullHtml,
            'info@trustedpanamastays.com',
            sender.email,
            sender.name
        ], { timeout: 15000 });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── POST /api/admin/send-followup-all ────────────────────────────────────────
// Send follow-up to all APATEL members
app.post('/api/admin/send-followup-all', requireAdmin, async (req, res) => {
    const { subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Missing subject or body' });

    const APATEL_ROSTER = require('./apatel_emails.json');
    const notifyPath    = path.join(__dirname, 'public', 'notify.php');
    let sent = 0, errors = 0;
    let sampleCopy = null; // first successfully-sent email, included in the report below
    // Send in background, return immediately
    res.json({ success: true, message: 'Campaign started', total: APATEL_ROSTER.length });

    let campaignId = null;
    try {
        const { data: campaignRow } = await supabaseAdmin.from('campaigns').insert({
            subject, body_html: body, from_email: 'info@trustedpanamastays.com', channel: 'email',
            target_description: 'Todos los miembros APATEL (roster completo)',
            recipient_count: APATEL_ROSTER.length, status: 'sending'
        }).select('id').single();
        campaignId = campaignRow?.id || null;
    } catch (err) {
        console.error('Campaign history log (start) failed:', err.message);
    }

    for (const member of APATEL_ROSTER) {
    if (!member.email || !member.email.includes('@')) continue;
    try {
        const html = buildFollowupHtml(member.hotel, member.manager, body);
        await execFileAsync('php', [notifyPath, subject, html, member.email], { timeout: 15000 });
        if (!sampleCopy) sampleCopy = { subject, html, to: member.email };
        await logEvent('followup_sent', { hotel: member.hotel, email: member.email });
        sent++;
        await new Promise(r => setTimeout(r, 600));
    } catch (err) {
        errors++;
        console.error(`Follow-up failed for ${member.hotel}:`, err.message);
    }
}
// Send completion report to admin — includes a real copy of the first
// successfully-sent email.
const sampleHtml = sampleCopy
    ? `<hr style="margin:1.5rem 0;"><p style="color:#666;font-size:0.85rem;">Copia real enviada a ${sampleCopy.to} (asunto: "${sampleCopy.subject}"):</p><div style="border:1px solid #ddd;border-radius:8px;padding:1rem;">${sampleCopy.html}</div>`
    : '<p style="color:#888;">(Ningún correo se envió con éxito — no hay copia disponible.)</p>';
const report = `<p>Follow-up campaign complete: <strong>${sent}</strong> sent, ${errors} errors out of ${APATEL_ROSTER.length} total.</p>${sampleHtml}`;
execFileAsync('php', [notifyPath, 'Follow-up campaign complete — Trusted Panama Stays', report, 'info@trustedpanamastays.com'], { timeout: 15000 }).catch(console.error);
console.log(`Follow-up done: ${sent} sent, ${errors} errors`);

if (campaignId) {
    supabaseAdmin.from('campaigns').update({
        sent_count: sent, error_count: errors, status: 'completed', finished_at: new Date().toISOString()
    }).eq('id', campaignId).then(({ error }) => { if (error) console.error('Campaign history log (finish) failed:', error.message); });
}
});


// ── Allowed "From" addresses for admin-composed campaign emails ──────────────
const ALLOWED_SENDERS = {
    'info@trustedpanamastays.com': 'Trusted Panama Stays',
    'members@trustedpanamastays.com': 'Trusted Panama Stays'
};
function resolveSender(from) {
    const email = ALLOWED_SENDERS[from] ? from : 'info@trustedpanamastays.com';
    return { email, name: ALLOWED_SENDERS[email] };
}

// ── Helper: wrap body content in full email template ─────────────────────────
function buildFollowupHtml(hotel, manager, bodyContent) {
    const firstName = (manager || '').split(' ')[0];
    const greeting = firstName && firstName.length > 2
        ? (hotel ? `${firstName}, propietario/a de <strong>${hotel}</strong>` : firstName)
        : (hotel ? `propietario/a de <strong>${hotel}</strong>` : 'propietario/a');
        return `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;margin:0;padding:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="margin:0 auto 1.5rem;">
    <tr><td bgcolor="#005ca9" style="background-color:#005ca9;" width="600">
        <img src="https://trustedpanamastays.com/images/email-header.png" alt="Trusted Panama Stays — Directorio de hospedajes legalmente registrados en Panamá" width="600" style="display:block;width:600px;border:0;color:#ffffff;font-size:22px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;text-align:center;padding:40px 20px;background-color:#005ca9;">
    </td></tr>
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="margin:0 auto;">
<tr><td height="20" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
    <tr><td style="padding:0 20px;">
<p style="margin-top:0;">Estimado/a ${greeting},</p>
${bodyContent}
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">
    Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
    <a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a><br>
    Para cancelar estas comunicaciones responda con "No gracias".
</p>
    </td></tr>
</table>
</body></html>`;
}

const TEMPLATES_DIR = path.join(__dirname, 'public', 'templates');

// ── Load a template file's raw content — used by both the campaign composer's
// /api/admin/templates routes and the automated trial-lifecycle emails below ──
function loadTemplateFile(name) {
    const filePath = path.join(TEMPLATES_DIR, name);
    if (!fs.existsSync(filePath)) throw new Error(`Template not found: ${name} — check public/templates/`);
    return fs.readFileSync(filePath, 'utf8');
}

// ── Fill {placeholder} tokens in a template with values from an object ──
function fillTemplate(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.split(`{${key}}`).join(value != null ? String(value) : '');
    }
    return result;
}

// Ensure templates directory exists
if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

// Seed a starter reminder template for contacted-but-not-subscribed APATEL
// members, if it doesn't already exist — editable via the admin template manager.
const reminderTemplatePath = path.join(TEMPLATES_DIR, 'apatel_reminder_not_subscribed.html');
if (!fs.existsSync(reminderTemplatePath)) {
    const reminderTemplate = `
<p>Le escribimos nuevamente porque hace un tiempo le compartimos información sobre <strong>Trusted Panama Stays</strong>, y notamos que aún no ha activado su membresía.</p>
<p>Como recordatorio, su hospedaje ya aparece en el directorio, y con una <strong>membresía de prueba gratuita de 30 días</strong> (sin costo, sin obligación) puede:</p>
<ul style="line-height:2;margin:0.5rem 0 1rem 1.5rem;">
    <li>Agregar hasta <strong>20 fotos</strong> de su hospedaje</li>
    <li>Publicar una <strong>descripción en inglés y español</strong></li>
    <li>Mostrar su <strong>dirección completa</strong> y enlaces de reserva</li>
</ul>
<p>Si ya no le interesa, puede ignorar este mensaje sin problema — no volveremos a insistir.</p>
<p style="text-align:center;margin:1.5rem 0;">
    <a href="https://trustedpanamastays.com/join.html" style="background:#005ca9;color:white;padding:12px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;display:inline-block;">
        Solicitar membresía gratuita →
    </a>
</p>
<p style="font-size:0.85rem;color:#666;">Creado por Volker Piasta, propietario del Aparthotel Boquete y miembro de APATEL.</p>`;
fs.writeFileSync(reminderTemplatePath, reminderTemplate.trim(), 'utf8');
}

// Seed the original APATEL direct-invitation email as a real, editable
// template (was previously hardcoded server-side in the now-retired
// send-apatel-campaign endpoint) — {url} is replaced per recipient with
// their actual listing page by sendToRosterList().
const apatelDirectPath = path.join(TEMPLATES_DIR, 'apatel_direct_invitation.html');
if (!fs.existsSync(apatelDirectPath)) {
const apatelDirectTemplate = `
<p>Como miembro de <strong>APATEL</strong>, le escribimos con una invitación especial.</p>
<p>Hemos creado <strong>Trusted Panama Stays</strong>, un directorio en línea para turistas internacionales que buscan hospedajes legalmente registrados en Panamá — sin las comisiones de Booking.com o Airbnb (15–20%).</p>
<div style="background:#f0f7ff;border:1px solid #c0d8f0;border-radius:8px;padding:1rem;margin:1rem 0;">
<p style="margin:0 0 0.5rem;font-weight:bold;color:#005ca9;">Su hospedaje ya aparece en nuestro directorio:</p>
<p style="margin:0;"><a href="{url}" style="color:#005ca9;font-size:0.95rem;">{url}</a></p>
</div>
<p>Con una <strong>membresía de prueba gratuita</strong> (sin costo, sin obligación) puede agregar:</p>
<ul style="margin:0.5rem 0 1rem 1.5rem;line-height:2;">
<li>Hasta <strong>20 fotos</strong> de su hospedaje</li>
<li>Descripción en <strong>inglés y español</strong></li>
<li>Dirección completa y enlaces a su sitio web</li>
<li>Botones de contacto directo (WhatsApp, correo, reservas)</li>
</ul>
<p style="text-align:center;margin:1.5rem 0;">
<a href="https://trustedpanamastays.com/join.html" style="background:#005ca9;color:white;padding:12px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;display:inline-block;">
    Solicitar membresía gratuita →
</a>
</p>
<p style="font-size:0.85rem;color:#666;">
Creado por Volker Piasta, propietario del <strong>Aparthotel Boquete</strong> y miembro de APATEL.<br>
El costo después de la prueba es solo <strong>$24/año + ITBMS</strong> — menos de $2 al mes.
</p>`;
fs.writeFileSync(apatelDirectPath, apatelDirectTemplate.trim(), 'utf8');
}

// ── GET /api/admin/templates ──────────────────────────────────────────────────
app.get('/api/admin/templates', requireAdmin, (req, res) => {
    try {
        const files = fs.readdirSync(TEMPLATES_DIR)
            .filter(f => f.endsWith('.html'))
            .sort();
        res.json({ templates: files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/admin/templates/:name ───────────────────────────────────────────
app.get('/api/admin/templates/:name', requireAdmin, (req, res) => {
    try {
        const name = req.params.name.replace(/[^a-z0-9_.-]/gi, '_');
        const filePath = path.join(TEMPLATES_DIR, name);
        if (!filePath.startsWith(TEMPLATES_DIR)) return res.status(403).json({ error: 'Invalid path' });
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Template not found' });
        const content = fs.readFileSync(filePath, 'utf8');
        res.json({ name, content });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/admin/templates/:name ──────────────────────────────────────────
app.post('/api/admin/templates/:name', requireAdmin, (req, res) => {
    try {
        const name = req.params.name.replace(/[^a-z0-9_.-]/gi, '_');
        if (!name.endsWith('.html')) return res.status(400).json({ error: 'Must be .html file' });
        const filePath = path.join(TEMPLATES_DIR, name);
        if (!filePath.startsWith(TEMPLATES_DIR)) return res.status(403).json({ error: 'Invalid path' });
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'Missing content' });
        fs.writeFileSync(filePath, content, 'utf8');
        res.json({ success: true, name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/admin/send-welcome-manual', requireAdmin, async (req, res) => {
    const { listing_id, contact_name, property_name, email, password, paid_until, type } = req.body;
    const appData = { listing_id, contact_name, property_name, email, duration_months: 0 };
    const html = generateEmailHtml(appData, type || 'approved_trial', password, paid_until);
    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    try {
        // Send to member
        await execFileAsync('php', [notifyPath, 'Membresía aprobada — ' + property_name, html, email], { timeout: 15000 });
        // Send CC to admin
        await execFileAsync('php', [notifyPath, '[COPIA] Membresía aprobada — ' + property_name, html, 'info@trustedpanamastays.com'], { timeout: 15000 });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  Smart campaign recipient endpoints
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/apatel-roster-count ───────────────────────────────────────
app.get('/api/admin/apatel-roster-count', requireAdmin, (req, res) => {
    try {
        const roster = require('./apatel_emails.json');
        res.json({ count: roster.filter(m => m.email && m.email.includes('@')).length });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/admin/apatel-contacted-not-member-count ──────────────────────────
// Returns APATEL roster members who WERE contacted (invitation sent) but are
// NOT currently an active member — the "reminder" segment, as opposed to the
// "never contacted" segment above.
app.get('/api/admin/apatel-contacted-not-member-count', requireAdmin, async (req, res) => {
    try {
        const roster = require('./apatel_emails.json');
        const { data } = await supabaseAdmin
            .from('listings')
            .select('email, email_member, is_member, membership_paid_until, invitation_sent_at, apatel_contacted_at')
            .eq('apatel_member', true);

        const today = new Date().toISOString().split('T')[0];
        const isActiveMember = l => l.is_member && l.membership_paid_until && l.membership_paid_until >= today;
        const wasContacted   = l => !!l.invitation_sent_at || !!l.apatel_contacted_at;

        const contactedNotMemberEmails = new Set();
        (data||[]).forEach(l => {
            if (wasContacted(l) && !isActiveMember(l)) {
                if (l.email) contactedNotMemberEmails.add(l.email.toLowerCase().trim());
                if (l.email_member) contactedNotMemberEmails.add(l.email_member.toLowerCase().trim());
            }
        });

        const targets = roster.filter(m => m.email && contactedNotMemberEmails.has(m.email.toLowerCase().trim()));
        res.json({ count: targets.length });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/admin/apatel-not-contacted-count ─────────────────────────────────
// Returns count of APATEL roster members whose email is NOT in any invited listing
app.get('/api/admin/apatel-not-contacted-count', requireAdmin, async (req, res) => {
    try {
        const roster = require('./apatel_emails.json');
        // Get all APATEL listings that have been contacted
        const { data } = await supabaseAdmin
            .from('listings')
            .select('email, email_member')
            .eq('apatel_member', true)
            .not('apatel_contacted_at', 'is', null);
        const contactedEmails = new Set();
        (data||[]).forEach(l => {
            if (l.email) contactedEmails.add(l.email.toLowerCase().trim());
            if (l.email_member) contactedEmails.add(l.email_member.toLowerCase().trim());
        });
        const notContacted = roster.filter(m => m.email && !contactedEmails.has(m.email.toLowerCase().trim()));
        res.json({ count: notContacted.length });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/admin/send-followup-reminder ────────────────────────────────────
// Send to APATEL roster members who were contacted but never became members
app.post('/api/admin/send-followup-reminder', requireAdmin, async (req, res) => {
    const { subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Missing subject or body' });

    const roster = require('./apatel_emails.json');
    const { data } = await supabaseAdmin
        .from('listings')
        .select('email, email_member, is_member, membership_paid_until, invitation_sent_at, apatel_contacted_at')
        .eq('apatel_member', true);

    const today = new Date().toISOString().split('T')[0];
    const isActiveMember = l => l.is_member && l.membership_paid_until && l.membership_paid_until >= today;
    const wasContacted   = l => !!l.invitation_sent_at || !!l.apatel_contacted_at;

    const contactedNotMemberEmails = new Set();
    (data||[]).forEach(l => {
        if (wasContacted(l) && !isActiveMember(l)) {
            if (l.email) contactedNotMemberEmails.add(l.email.toLowerCase().trim());
            if (l.email_member) contactedNotMemberEmails.add(l.email_member.toLowerCase().trim());
        }
    });

    const targets = roster.filter(m => m.email && contactedNotMemberEmails.has(m.email.toLowerCase().trim()));

    res.json({ success: true, message: `Sending reminder to ${targets.length} contacted-but-not-subscribed APATEL members`, total: targets.length });
    await sendToRosterList(targets, subject, body, null, 'APATEL contactados sin membresía (recordatorio)');
});

// ── POST /api/admin/send-followup-new ────────────────────────────────────────
// Send to APATEL roster members not yet contacted
app.post('/api/admin/send-followup-new', requireAdmin, async (req, res) => {
    const { subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Missing subject or body' });

    const roster = require('./apatel_emails.json');
    // Get contacted emails from DB
    const { data } = await supabaseAdmin
        .from('listings')
        .select('email, email_member')
        .eq('apatel_member', true)
        .not('invitation_sent_at', 'is', null);
    const contactedEmails = new Set();
    (data||[]).forEach(l => {
        if (l.email) contactedEmails.add(l.email.toLowerCase());
        if (l.email_member) contactedEmails.add(l.email_member.toLowerCase());
    });
    const targets = roster.filter(m => m.email && !contactedEmails.has(m.email.toLowerCase()));

    res.json({ success: true, message: `Sending to ${targets.length} not-yet-contacted APATEL members`, total: targets.length });
    await sendToRosterList(targets, subject, body, null, 'APATEL no contactados aún (nuevo)');
});

app.post('/api/admin/send-followup-specific', requireAdmin, async (req, res) => {
    const { subject, body, emails, targets: directTargets, from } = req.body;
    let targets;
    if (Array.isArray(directTargets) && directTargets.length) {
        // Called from the Hospedajes-tab selection — real listing names/emails
        // already provided directly, no roster lookup needed for the greeting.
        // id/slug are passed through so resolveListingUrl() can skip the fuzzy
        // name-match lookup and use the exact listing directly.
        targets = directTargets.map(t => ({ hotel: t.name, email: t.email, manager: t.contact_name || '', id: t.id, slug: t.slug }));
    } else if (emails?.length) {
        // Plain email list (the "specific emails" textbox) — try matching
        // against the APATEL roster for a name, otherwise send unpersonalized.
        const roster = require('./apatel_emails.json');
        const rosterMap = {};
        roster.forEach(m => { if (m.email) rosterMap[m.email.toLowerCase()] = m; });
        targets = emails.map(email => {
            const match = rosterMap[email.toLowerCase()];
            return match || { hotel: email, email, manager: '' };
        });
    } else {
        return res.status(400).json({ error: 'Missing fields' });
    }
    if (!subject || !body || !targets.length) return res.status(400).json({ error: 'Missing fields' });
    res.json({ success: true, message: `Sending to ${targets.length} recipients`, total: targets.length });
    const specificDescription = (Array.isArray(directTargets) && directTargets.length)
        ? `Envío específico — selección directa (${targets.length} hospedajes)`
        : `Envío específico — lista de correos (${targets.length})`;
    await sendToRosterList(targets, subject, body, from, specificDescription);
});

// ── Helper: send to a list of roster-format members ───────────────────────────
// Finds a member's listing URL: uses an exact id/slug if the caller already
// knows it (e.g. selections made in the Hospedajes tab), otherwise falls back
// to a fuzzy name match against the database (needed for roster-based sends
// like APATEL, which have no listing id on file) — same lookup the old
// standalone APATEL campaign used, now shared by every send path.
async function resolveListingUrl(member) {
    try {
        let listing = null;
        if (member.id) {
            const { data } = await supabase.from('listings').select('id, slug').eq('id', member.id).maybeSingle();
            listing = data;
        } else if (member.hotel) {
            const { data } = await supabase
                .from('listings')
                .select('id, slug')
                .ilike('name', `%${member.hotel.substring(0, 15)}%`)
                .limit(1);
            listing = data?.[0];
        }
        if (!listing) return 'https://trustedpanamastays.com/index_es.html';
        return listing.slug
            ? `https://trustedpanamastays.com/listing.php?slug=${listing.slug}&lang=es`
            : `https://trustedpanamastays.com/listing.php?id=${listing.id}&lang=es`;
    } catch {
        return 'https://trustedpanamastays.com/index_es.html';
    }
}

async function sendToRosterList(targets, subject, body, from, targetDescription) {
    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    const sender = resolveSender(from);
    let sent = 0, errors = 0;
    let sampleCopy = null; // the first successfully-sent email, included below so the report always shows the real content — even for a 1-recipient campaign

    // Log this send to the campaigns table so "what did we send and when" has
    // an answer later — see /api/admin/campaigns. Logging failures must never
    // block the actual send, so every step here is best-effort.
    let campaignId = null;
    try {
        const { data: campaignRow } = await supabaseAdmin.from('campaigns').insert({
            subject, body_html: body, from_email: sender.email, channel: 'email',
            target_description: targetDescription || null, recipient_count: targets.length, status: 'sending'
        }).select('id').single();
        campaignId = campaignRow?.id || null;
    } catch (err) {
        console.error('Campaign history log (start) failed:', err.message);
    }

    for (const member of targets) {
        if (!member.email || !member.email.includes('@')) continue;
        try {
            // Replace the {url} placeholder (if the message uses it) with this
            // recipient's actual listing page — works for any send path.
            const listingUrl = body.includes('{url}') ? await resolveListingUrl(member) : null;
            const personalizedBody = listingUrl ? body.split('{url}').join(listingUrl) : body;
            // Replace the {id} placeholder (if the subject uses it) with this
            // recipient's listing ID — e.g. for the [TPS-{id}] reply tag.
            const personalizedSubject = (subject.includes('{id}') && member.id)
                ? subject.split('{id}').join(member.id)
                : subject;
            const html = buildFollowupHtml(member.hotel || member.email, member.manager || '', personalizedBody);
            await execFileAsync('php', [notifyPath, personalizedSubject, html, member.email, sender.email, sender.name], { timeout: 15000 });
            if (!sampleCopy) sampleCopy = { subject: personalizedSubject, html, to: member.email };
            // Mark as contacted in DB
            await supabase.from('listings')
                .update({ apatel_contacted_at: new Date().toISOString() })
                .or(`email.ilike.%${member.email}%,email_member.ilike.%${member.email}%`)
                .eq('apatel_member', true);
            await logEvent('followup_sent', { hotel: member.hotel, email: member.email, listing_id: member.id || null });
            sent++;
            await new Promise(r => setTimeout(r, 600));
        } catch (err) {
            errors++;
            console.error(`Failed for ${member.hotel||member.email}:`, err.message);
        }
    }
    // Completion report to admin — always includes a real copy of the first
    // successfully-sent email, so you can see exactly what went out.
    const sampleHtml = sampleCopy
        ? `<hr style="margin:1.5rem 0;"><p style="color:#666;font-size:0.85rem;">Copia real enviada a ${sampleCopy.to} (asunto: "${sampleCopy.subject}"):</p><div style="border:1px solid #ddd;border-radius:8px;padding:1rem;">${sampleCopy.html}</div>`
        : '<p style="color:#888;">(Ningún correo se envió con éxito — no hay copia disponible.)</p>';
    const report = `<p>Campaign complete: <strong>${sent}</strong> sent, ${errors} errors out of ${targets.length} total.</p>${sampleHtml}`;
    execFileAsync('php', [path.join(__dirname, 'public', 'notify.php'),
        'Campaign complete — Trusted Panama Stays', report, 'info@trustedpanamastays.com'],
        { timeout: 15000 }).catch(console.error);
    console.log(`Campaign done: ${sent} sent, ${errors} errors`);

    if (campaignId) {
        try {
            await supabaseAdmin.from('campaigns').update({
                sent_count: sent, error_count: errors, status: 'completed', finished_at: new Date().toISOString()
            }).eq('id', campaignId);
        } catch (err) {
            console.error('Campaign history log (finish) failed:', err.message);
        }
    }
}

// ── Reusable AI verification function ────────────────────────────────────────
async function runAiVerification(application_id) {
    const { data: app } = await supabaseAdmin
        .from('membership_applications').select('*').eq('id', application_id).single();
    if (!app || !app.documents?.length) return null;
    const imageContents = [];
    for (const doc of app.documents) {
        const { data: fileData, error: dlError } = await supabaseAdmin.storage
            .from('member-documents').download(doc.path);
        if (dlError) continue;
        const base64 = Buffer.from(await fileData.arrayBuffer()).toString('base64');
        if (doc.mime === 'application/pdf') {
            imageContents.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } });
        } else {
            imageContents.push({ type: 'image', source: { type: 'base64', media_type: doc.mime, data: base64 } });
        }
        imageContents.push({ type: 'text', text: `The above document is the: ${doc.type.replace(/_/g,' ').toUpperCase()}` });
    }
    if (!imageContents.length) return null;
    const expected1yr = (24 * 1.07).toFixed(2);
    const expected2yr = (45 * 1.07).toFixed(2);
    const prompt = `You are verifying membership application documents for a Panama tourism rental directory.
Application details:
- Property name: ${app.property_name}
- Contact/representative name: ${app.contact_name}
- Province: ${app.province}
- Plan: ${app.membership_type === 'trial' ? 'Free trial' : app.duration_months + ' months paid'}
- Payment method: ${app.payment_method || 'none'}
Expected amounts WITH 7% ITBMS included: $${expected1yr} (1 year = $24 + ITBMS) or $${expected2yr} (2 years = $45 + ITBMS).
IMPORTANT: $24.00 or $45.00 WITHOUT ITBMS is INCORRECT. Only $${expected1yr} or $${expected2yr} are correct amounts.
If amount is $45.00 (without ITBMS), set amount_matches to false and note underpayment of $3.15.
IMPORTANT - Panamanian Aviso de Operación document layout:
- LEFT box labeled "Aviso de Operación No." contains the LICENSE NUMBER (not the RUC)
- RIGHT box labeled "Expedido a favor de" contains the owner/company name and below it the RUC number
Please verify and return ONLY a JSON object:
{
  "aviso_operacion": { "found": true/false, "business_name": "...", "ruc": "...", "ruc_dv": "...", "legal_rep": "...", "valid": true/false, "notes": "..." },
  "cedula": { "found": true/false, "id_holder_name": "...", "id_number": "...", "notes": "..." },
  "payment": { "found": true/false, "amount": "...", "date": "...", "method": "...", "notes": "..." },
  "verification": { "names_match": true/false, "names_match_detail": "...", "payment_matches": true/false, "payment_match_detail": "...", "overall_result": "PASS/FAIL/REVIEW", "overall_notes": "..." }
}
Return ONLY the JSON, no other text.`;
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-opus-4-5', max_tokens: 1500,
        messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: prompt }] }]
    }, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        timeout: 60000
    });
    const result = JSON.parse(response.data.content[0].text.replace(/```json\n?|\n?```/g, '').trim());
    await supabaseAdmin.from('membership_applications').update({
        ruc: result.aviso_operacion?.ruc || null,
        ruc_dv: result.aviso_operacion?.ruc_dv || null,
        business_name: result.aviso_operacion?.business_name || null,
        verification_result: `${result.verification?.overall_result}:${result.verification?.overall_notes?.substring(0,100)}`
    }).eq('id', application_id);
    await logEvent('ai_verification_completed', { application_id, result: result.verification?.overall_result });
    return result.verification;
}

// ── Recalculate feature ranks for all featured listings ───────────────────────
async function recalculateFeatureRanks() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const { data: featured } = await supabaseAdmin
            .from('listings')
            .select('id, is_trial, membership_paid_until, trial_started_at, photos')
            .eq('is_member', true)
            .gte('membership_paid_until', today);
        if (!featured || !featured.length) return;

        // Sort: paid+photo, paid+no photo, trial+photo, trial+no photo
        // Within each group: by trial_started_at ASC (oldest first), nulls last
        const hasPhoto = l => Array.isArray(l.photos) && l.photos.length > 0;
        const tier = l => {
            if (!l.is_trial && hasPhoto(l))  return 0;
            if (!l.is_trial && !hasPhoto(l)) return 1;
            if (l.is_trial  && hasPhoto(l))  return 2;
            return 3;
        };
        featured.sort((a, b) => {
            const td = tier(a) - tier(b);
            if (td !== 0) return td;
            // Both have a real trial_started_at — use it to rank by seniority
            if (a.trial_started_at && b.trial_started_at) {
                const diff = new Date(a.trial_started_at) - new Date(b.trial_started_at);
                if (diff !== 0) return diff;
            }
            // Otherwise (at least one has no trial date — e.g. went straight to a
            // supporting membership) fall back to listing ID, which is always
            // present and deterministic — avoids ties depending on arbitrary
            // database row order, which was the actual bug here.
            return a.id - b.id;
        });

        for (let i = 0; i < featured.length; i++) {
            await supabaseAdmin
                .from('listings')
                .update({ feature_rank: i + 1 })
                .eq('id', featured[i].id);
        }
        // Zero out anyone who isn't currently a valid active member — covers
        // both natural expiry (is_member still true, date lapsed) and manual
        // deactivation (is_member already false), which the old query missed
        // since it required is_member = true.
        await supabaseAdmin
            .from('listings')
            .update({ feature_rank: 0 })
            .neq('feature_rank', 0)
            .or(`is_member.eq.false,membership_paid_until.lt.${today}`);
        console.log(`Feature ranks recalculated for ${featured.length} listings`);
    } catch (err) {
        console.error('recalculateFeatureRanks error:', err.message);
    }
}

// ── GET /api/admin/recalculate-ranks ─────────────────────────────────────────
app.get('/api/admin/recalculate-ranks', requireAdmin, async (req, res) => {
    await recalculateFeatureRanks();
    res.json({ success: true });
});

// ── Refresh the in-memory listings cache from the database, without a restart ──
// Useful after a direct DB change, or if apply-atp-diff's own in-memory
// refresh step was interrupted (e.g. a server restart mid-request).
app.post('/api/admin/refresh-cache', requireAdmin, async (req, res) => {
    try {
        CURRENT_RENTALS = await loadListingsFromDB();
        res.json({ success: true, count: CURRENT_RENTALS.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Quick CSV export/backup for any table — since Supabase dashboard export UI ──
// isn't available on this plan. Handles pagination for tables over 1000 rows.
app.get('/api/admin/export-table', requireAdmin, async (req, res) => {
    const { table } = req.query;
    const allowed = ['listings', 'membership_applications', 'payments', 'event_log'];
    if (!allowed.includes(table)) return res.status(400).json({ error: 'Table not allowed for export' });

    try {
        let allData = [];
        let from = 0;
        const BATCH = 1000;
        while (true) {
            const { data, error } = await supabaseAdmin
                .from(table)
                .select('*')
                .range(from, from + BATCH - 1);
            if (error) throw new Error(error.message);
            allData = allData.concat(data);
            if (data.length < BATCH) break;
            from += BATCH;
        }

        if (allData.length === 0) {
            return res.status(404).send('No rows found');
        }

        const headers = Object.keys(allData[0]);
        const escapeCsv = (val) => {
            if (val === null || val === undefined) return '';
            const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
            return `"${str.replace(/"/g, '""')}"`;
        };
        const csvRows = [
            headers.join(','),
            ...allData.map(row => headers.map(h => escapeCsv(row[h])).join(','))
        ];
        const csv = csvRows.join('\n');

        const dateStr = new Date().toISOString().split('T')[0];
        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', `attachment; filename="${table}_backup_${dateStr}.csv"`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── ATP status check: 3 states — (1) no update, (2) link changed but not yet
// parsed, (3) already parsed and awaiting review. States 1/2 do a cheap live
// check (just the ATP webpage, no PDF download); state 3 is free (in memory).
app.get('/api/admin/atp-diff', requireAdmin, async (req, res) => {
    if (PENDING_ATP_DIFF) {
        return res.json({
            state: 3,
            pending: true,
            computedAt: PENDING_ATP_DIFF.computedAt,
            newUrl: PENDING_ATP_DIFF.newUrl,
            reportDate: extractPdfDateFromUrl(PENDING_ATP_DIFF.newUrl),
            diff: PENDING_ATP_DIFF.diff
        });
    }
    try {
        const meta = await getSavedPdfUrl();
        const savedUrl  = meta ? meta.pdf_url : null;
        const atpResult = await getLatestPdfUrl(); // cheap: page fetch only, no PDF download
        const liveUrl = atpResult.pdfUrl;

        if (liveUrl === savedUrl) {
            return res.json({ state: 1, pending: false, savedUrl, reportDate: extractPdfDateFromUrl(savedUrl) });
        }
        return res.json({ state: 2, pending: false, savedUrl, liveUrl, reportDate: extractPdfDateFromUrl(liveUrl) });
    } catch (err) {
        res.json({ state: 'unknown', error: err.message });
    }
});

// ── Apply the pending ATP diff: writes changes + sends flagged-member emails ──
app.post('/api/admin/apply-atp-diff', requireAdmin, async (req, res) => {
    if (!PENDING_ATP_DIFF) return res.status(400).json({ error: 'No pending diff to apply' });
    try {
        const { newUrl, newHeading, parsedRentals } = PENDING_ATP_DIFF;
        const result = await mergeListingsWithDB(parsedRentals);
        await savePdfMeta(newUrl, newHeading);

        // Reload from DB so IDs/enrichment stay correct — never assign PDF_RENTALS directly
        CURRENT_RENTALS = await loadListingsFromDB();
        DATA_SOURCE = 'atp-pdf';
        PENDING_ATP_DIFF = null;

        await checkPendingAtpApplications();
        await logEvent('atp_diff_applied', result);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Manually confirm a "new" entry is actually a rename of a "dropped" entry ──
// Renames the existing listing in place instead of drop+insert, preserving its
// ID, atp_first_seen, and any member/admin data. Marks both diff entries as
// matched so "Apply changes" skips them afterward.
app.post('/api/admin/atp-diff/confirm-match', requireAdmin, async (req, res) => {
    if (!PENDING_ATP_DIFF) return res.status(400).json({ error: 'No pending diff' });
    const { droppedId, newTempId } = req.body || {};
    if (droppedId == null || newTempId == null) return res.status(400).json({ error: 'droppedId and newTempId required' });
    try {
        const diff = PENDING_ATP_DIFF.diff;
        const newEntry = diff.toInsert.find(x => x.tempId === newTempId && !x.matched);
        const droppedInList = diff.toDeactivateNonMembers.find(x => x.id === droppedId && !x.matched)
                            || diff.toFlagMembers.find(x => x.id === droppedId && !x.matched);
        if (!newEntry || !droppedInList) return res.status(400).json({ error: 'Match entries not found or already matched' });

        const nowIso = new Date().toISOString();
        const { error } = await supabaseAdmin.from('listings').update({
            name:                  newEntry.name,
            province:              newEntry.province,
            phone:                 newEntry.phone || null,
            email:                 newEntry.email || null,
            rental_type:           newEntry.rental_type || null,
            atp_active:            true,
            atp_last_seen:         nowIso,
            atp_review_flagged_at: null
        }).eq('id', droppedId);
        if (error) throw new Error(error.message);

        newEntry.matched = true;
        droppedInList.matched = true;
        await logEvent('atp_diff_manual_match', { listing_id: droppedId, old_name: droppedInList.name, new_name: newEntry.name });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Ask Claude (with web search) what happened to a dropped ATP listing ──
// Only called on-demand from the admin panel, never from the automated
// daily checkForPdfUpdate flow — keeps this slow, external-API-dependent
// step fully decoupled from the resource-sensitive cron path.
async function analyzeDroppedListing(dropped, candidateNames) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on the server');

    const candidatesText = candidateNames.length
        ? `Also, these NEW businesses appeared in the same updated ATP report (same source, same update cycle):\n${candidateNames.map(n => `- ${n}`).join('\n')}`
        : 'No new businesses appeared in this report update.';

    const prompt = `A short-term rental / hotel business registered with Panama's ATP (Autoridad de Turismo de Panamá) tourism registry no longer appears in the latest official ATP report.

Business details:
- Name: ${dropped.name}
- Province: ${dropped.province}
- Phone: ${dropped.phone || 'unknown'}
- Type: ${dropped.rental_type || 'unknown'}

${candidatesText}

Please research and determine ONE of the following:
1. This business likely renamed/rebranded and is one of the NEW businesses listed above — say which one and why.
2. This business likely closed, stopped operating, or did not renew its ATP registration — say what evidence supports this.
3. Unclear — not enough information available.

Respond in exactly this format:
VERDICT: renamed|closed|unclear
MATCH: <exact name from the new list above, or "none">
EXPLANATION: <2-3 sentences, mention what you found>`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
        })
    });
    if (!response.ok) {
        throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

    const verdictM     = text.match(/VERDICT:\s*(renamed|closed|unclear)/i);
    const matchM       = text.match(/MATCH:\s*(.+)/i);
    const explanationM = text.match(/EXPLANATION:\s*([\s\S]+)/i);

    return {
        verdict:     verdictM ? verdictM[1].toLowerCase() : 'unclear',
        matchName:   (matchM && matchM[1].trim().toLowerCase() !== 'none') ? matchM[1].trim() : null,
        explanation: explanationM ? explanationM[1].trim() : text.trim()
    };
}

// ── On-demand: ask Claude what happened to one dropped listing ──
app.post('/api/admin/atp-diff/analyze-dropped', requireAdmin, async (req, res) => {
    if (!PENDING_ATP_DIFF) return res.status(400).json({ error: 'No pending diff' });
    const { droppedId } = req.body || {};
    if (droppedId == null) return res.status(400).json({ error: 'droppedId required' });
    try {
        const diff = PENDING_ATP_DIFF.diff;
        const dropped = diff.toDeactivateNonMembers.find(x => x.id === droppedId && !x.matched)
                      || diff.toFlagMembers.find(x => x.id === droppedId && !x.matched);
        if (!dropped) return res.status(400).json({ error: 'Listing not found in pending diff' });

        const candidateNames = (diff.toInsert || []).filter(x => !x.matched).map(x => x.name);
        const analysis = await analyzeDroppedListing(dropped, candidateNames);
        res.json(analysis);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/admin/document-url ───────────────────────────────────────────────
app.get('/api/admin/document-url', requireAdmin, async (req, res) => {
    const { path: docPath } = req.query;
    if (!docPath) return res.status(400).json({ error: 'Missing path' });
    try {
        const { data, error } = await supabaseAdmin.storage
            .from('member-documents')
            .createSignedUrl(docPath, 300); // 5 min expiry
        if (error) return res.status(500).json({ error: error.message });
        res.json({ url: data.signedUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Download the CAFE (invoice PDF) from eFacturaPty, proxied through our server ──
// so the API bearer token never reaches the browser.
app.get('/api/admin/invoice-pdf/:invoiceId', requireAdmin, async (req, res) => {
    const { invoiceId } = req.params;
    try {
        const response = await axios.get(
            `https://api.efacturapty.com/api/v1/Invoices/${invoiceId}/cafe-file`,
            {
                headers: {
                    'Accept':           'application/pdf',
                    'Accept-Language':  'es-PA',
                    'Authorization':    'Bearer ' + process.env.EFACTURA_API_KEY
                },
                responseType: 'arraybuffer',
                timeout: 30000
            }
        );
        res.set('Content-Type', 'application/pdf');
        res.send(Buffer.from(response.data));
    } catch (err) {
        const errMsg = err.response?.data || err.message;
        console.error('CAFE download error:', errMsg);
        res.status(500).json({ error: 'Could not download invoice PDF', detail: errMsg });
    }
});

// ── POST /api/admin/verify-documents ──────────────────────────────────────────
app.post('/api/admin/verify-documents', requireAdmin, async (req, res) => {
    const { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'Missing application_id' });

    const { data: app, error: appError } = await supabaseAdmin
        .from('membership_applications')
        .select('*')
        .eq('id', application_id)
        .single();
    if (appError || !app) return res.status(404).json({ error: 'Application not found' });
    if (!app.documents || !app.documents.length)
        return res.status(400).json({ error: 'No documents to verify' });

    try {
        const imageContents = [];

        // Download each document from Supabase Storage
        for (const doc of app.documents) {
            const { data: fileData, error: dlError } = await supabaseAdmin.storage
                .from('member-documents')
                .download(doc.path);
            if (dlError) { console.error('Doc download error:', dlError.message); continue; }

            const arrayBuffer = await fileData.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');

            // Claude supports both images and PDFs natively
            if (doc.mime === 'application/pdf') {
                imageContents.push({
                    type: 'document',
                    source: { type: 'base64', media_type: 'application/pdf', data: base64 }
                });
            } else {
                imageContents.push({
                    type: 'image',
                    source: { type: 'base64', media_type: doc.mime, data: base64 }
                });
            }
            imageContents.push({
                type: 'text',
                text: `The above document is the: ${doc.type.replace(/_/g,' ').toUpperCase()}`
            });
        }

        if (!imageContents.length) {
            return res.status(400).json({
                error: 'No image documents available for AI verification.'
            });
        }

        const prompt = `You are verifying membership application documents for a Panama tourism rental directory.

Application details:
- Property name: ${app.property_name}
- Contact/representative name: ${app.contact_name}
- Province: ${app.province}
- Plan: ${app.membership_type === 'trial' ? 'Free trial' : app.duration_months + ' months paid'}
- Payment method: ${app.payment_method || 'none'}
- Amount expected: ${app.duration_months === 24 ? '$45' : app.duration_months === 12 ? '$24' : 'none (trial)'}

IMPORTANT - Panamanian Aviso de Operación document layout:
- LEFT box labeled "Aviso de Operación No." contains the LICENSE NUMBER (not the RUC)
- RIGHT box labeled "Expedido a favor de" contains the owner/company name and below it the RUC number
- RUC format examples: 8-822-1374 or 1401220-1-627960 (short number, NOT the full aviso number)
- The DV (dígito verificador) appears after the RUC separated by a dash
Please verify the documents and return ONLY a JSON object with this structure:
{
  "aviso_operacion": {
    "found": true/false,
    "business_name": "Company or person name from RIGHT box under 'Expedido a favor de' heading",
    "ruc": "RUC number from the RIGHT box 'Expedido a favor de' below the busines name (format: 8-822-1374 or 1401220-1-627960)",
    "ruc_dv": "DV digit shown after the RUC in the RIGHT box",
    "legal_rep": "legal representative name",
    "license_number": "Aviso de Operación number from the LEFT box 'Aviso de Operación No.' (this is NOT the RUC)",
    "valid": true/false,
    "notes": "any issues found"
  },
  "cedula": {
    "found": true/false,
    "id_holder_name": "name on ID",
    "id_number": "ID number",
    "notes": "any issues"
  },
  "payment": {
    "found": true/false,
    "amount": "amount shown",
    "date": "payment date",
    "method": "payment method detected",
    "notes": "any issues"
  },
  "verification": {
    "names_match": true/false,
    "names_match_detail": "explanation",
    "payment_matches": true/false,
    "payment_match_detail": "explanation",
    "overall_result": "PASS/FAIL/REVIEW",
    "overall_notes": "summary recommendation"
  }
}
Return ONLY the JSON, no other text.`;

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-opus-4-5',
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: [...imageContents, { type: 'text', text: prompt }]
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            timeout: 60000
        });

        const content = response.data.content[0].text;
        const clean   = content.replace(/```json\n?|\n?```/g, '').trim();
        const result  = JSON.parse(clean);

        await logEvent('ai_verification_completed', {
            application_id,
            result: result.verification?.overall_result
        });
        // Save extracted RUC data to application
        if (result.aviso_operacion) {
            await supabaseAdmin
                .from('membership_applications')
                .update({
                    ruc:          result.aviso_operacion.ruc || null,
                    ruc_dv:       result.aviso_operacion.ruc_dv || null,
                    business_name: result.aviso_operacion.business_name || null
                })
                .eq('id', application_id);
        }

        res.json({ success: true, verification: result });

    } catch (err) {
        console.error('AI verification error:', err.message);
        res.status(500).json({ error: 'AI verification failed: ' + err.message });
    }
});

// Determine whether a listing has verified ownership documents on file —
// same check /api/payment-info uses (a non-archived membership_applications
// row with a recorded RUC). If not, renewal must route through join.html
// (to collect documents) rather than pay.html (which assumes RUC/DV known).
async function hasDocumentedApplication(listingId) {
    const { data } = await supabaseAdmin
        .from('membership_applications')
        .select('id')
        .eq('listing_id', listingId)
        .not('ruc', 'is', null)
        .neq('status', 'archived')
        .limit(1)
        .maybeSingle();
    return !!data;
}

// ── Shared email wrapper (header table + footer, matches site style) ────────
// Greeting logic intentionally mirrors buildFollowupHtml() exactly — templates
// used by either wrapper must NOT include their own greeting line, so a
// template behaves identically whether sent by the automated cron or manually
// from the Campaña tab.
function wrapTrialEmailHtml(hotel, manager, bodyHtml) {
    const firstName = (manager || '').split(' ')[0];
    const greeting = firstName && firstName.length > 2
        ? (hotel ? `${firstName}, propietario/a de <strong>${hotel}</strong>` : firstName)
        : (hotel ? `propietario/a de <strong>${hotel}</strong>` : 'propietario/a');
    return `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;margin:0;padding:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="margin:0 auto 1.5rem;">
    <tr><td bgcolor="#005ca9" style="background-color:#005ca9;" width="600">
        <img src="https://trustedpanamastays.com/images/email-header.png" alt="Trusted Panama Stays — Directorio de hospedajes legalmente registrados en Panamá" width="600" style="display:block;width:600px;border:0;color:#ffffff;font-size:22px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;text-align:center;padding:40px 20px;background-color:#005ca9;">
    </td></tr>
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="margin:0 auto;">
    <tr><td height="20" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
    <tr><td style="padding:0 20px;">
<p style="margin-top:0;">Estimado/a ${greeting},</p>
${bodyHtml}
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">
    Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
    <a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a>
</p>
    </td></tr>
</table>
</body></html>`;
}

// ── GET /api/send-trial-reminders (called daily by GitHub Action) ───────────
// Full trial lifecycle, all stages checked in one daily pass:
//   1. 5 days before expiry           → renewal reminder
//   2. 2 days (48h) before expiry     → one-time 7-day extension offer (click link)
//   3. On expiry (original or extended) → final notice + demotion
app.get('/api/send-trial-reminders', async (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).send('Denied');

    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    const today    = new Date();
    const dateStr  = d => d.toISOString().split('T')[0];
    const plusDays = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };

    const results = { reminder5day: 0, extensionOffer: 0, finalNotice: 0, errors: 0 };

    try {
        // ── Stage 1: 5-day renewal reminder ──────────────────────────────────
        const { data: dueReminder } = await supabaseAdmin
            .from('listings')
            .select('id, name, contact_name, email_member, email, membership_paid_until, slug, photos')
            .eq('is_member', true).eq('is_trial', true)
            .is('trial_reminder_sent_at', null)
            .lte('membership_paid_until', dateStr(plusDays(5)));

        for (const listing of dueReminder || []) {
            const toEmail = listing.email_member || listing.email;
            if (!toEmail || !toEmail.includes('@')) continue;
            try {
              const name = listing.contact_name || 'propietario/a';
              const listingUrl = listing.slug
                  ? `https://trustedpanamastays.com/listing.html?slug=${listing.slug}&lang=es`
                  : `https://trustedpanamastays.com/listing.html?id=${listing.id}&lang=es`;
              const documented = await hasDocumentedApplication(listing.id);
              const renewUrl = documented
                  ? `https://trustedpanamastays.com/pay.html?id=${listing.id}`
                  : `https://trustedpanamastays.com/join.html?id=${listing.id}`;
              const renewLabel = documented ? 'Renovar membresía →' : 'Completar registro →';
              const noPhotosBlock = (!listing.photos || !listing.photos.length) ? `
<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:1rem;margin:1rem 0;">
    <p style="margin:0;color:#856404;"><strong>💡 Notamos que su listado aún no tiene fotos.</strong> Con solo una foto, su hospedaje aparecerá destacado en la página principal de Trusted Panama Stays.</p>
</div>` : '';
                const body = fillTemplate(loadTemplateFile('trial_reminder_5day.html'), {
                name, listing_name: listing.name, expiry_date: listing.membership_paid_until,
                listing_id: listing.id, renew_url: renewUrl, renew_label: renewLabel,
                listing_url: listingUrl, no_photos_block: noPhotosBlock
                });
                await execFileAsync('php', [notifyPath, `Su prueba gratuita vence en 5 días — ${listing.name}`, wrapTrialEmailHtml(listing.name, listing.contact_name, body), toEmail, 'info@trustedpanamastays.com', 'Trusted Panama Stays', 'info@trustedpanamastays.com'], { timeout: 15000 });await supabaseAdmin.from('listings').update({ trial_reminder_sent_at: new Date().toISOString() }).eq('id', listing.id);
                await logEvent('trial_reminder_sent', { listing_id: listing.id, email: toEmail });
                results.reminder5day++;
            } catch (err) { results.errors++; console.error(`5-day reminder failed for listing ${listing.id}:`, err.message); }
        }

        // ── Stage 2: 48-hour extension offer (one-time click-to-extend link) ─
        const { data: dueOffer } = await supabaseAdmin
            .from('listings')
            .select('id, name, contact_name, email_member, email, membership_paid_until')
            .eq('is_member', true).eq('is_trial', true)
            .is('trial_extension_offer_sent_at', null)
            .lte('membership_paid_until', dateStr(plusDays(2)));

        for (const listing of dueOffer || []) {
            const toEmail = listing.email_member || listing.email;
            if (!toEmail || !toEmail.includes('@')) continue;
            try {
                const token = Buffer.from(`${listing.id}:${Date.now()}:${process.env.ADMIN_SECRET}`).toString('base64');
                const extendUrl = `https://trustedpanamastays.com/api/extend-trial?id=${listing.id}&token=${encodeURIComponent(token)}`;
                const name = listing.contact_name || 'propietario/a';
                const body = fillTemplate(loadTemplateFile('trial_extension_offer.html'), {
                    name, listing_name: listing.name, expiry_date: listing.membership_paid_until, extend_url: extendUrl
                });
                await execFileAsync('php', [notifyPath, `¿Necesita más tiempo? 7 días gratis — ${listing.name}`, wrapTrialEmailHtml(listing.name, listing.contact_name, body), toEmail, 'info@trustedpanamastays.com', 'Trusted Panama Stays', 'info@trustedpanamastays.com'], { timeout: 15000 });
                await supabaseAdmin.from('listings').update({ trial_extension_offer_sent_at: new Date().toISOString() }).eq('id', listing.id);
                await logEvent('trial_extension_offer_sent', { listing_id: listing.id, email: toEmail });
                results.extensionOffer++;
            } catch (err) { results.errors++; console.error(`Extension offer failed for listing ${listing.id}:`, err.message); }
        }

        // ── Stage 3: expiry reached (original or extended) → final notice, then demote.
        const { data: dueFinalNotice } = await supabaseAdmin
            .from('listings')
            .select('id, name, contact_name, email_member, email, trial_extended_at')
            .eq('is_member', true).eq('is_trial', true)
            .is('trial_final_notice_sent_at', null)
            .lte('membership_paid_until', dateStr(today));

        for (const listing of dueFinalNotice || []) {
            const toEmail = listing.email_member || listing.email;
            const wasExtended = !!listing.trial_extended_at;
            try {
              if (toEmail && toEmail.includes('@')) {
                  const name = listing.contact_name || 'propietario/a';
                  const documented = await hasDocumentedApplication(listing.id);
                  const renewUrl = documented
                      ? `https://trustedpanamastays.com/pay.html?id=${listing.id}`
                      : `https://trustedpanamastays.com/join.html?id=${listing.id}`;
                const body = fillTemplate(loadTemplateFile('trial_final_notice.html'), {
                    name, listing_name: listing.name,
                    extended_note: wasExtended ? ' (incluyendo los 7 días adicionales)' : '',
                    renew_url: renewUrl
                });
                await execFileAsync('php', [notifyPath, `Su prueba gratuita ha finalizado — ${listing.name}`, wrapTrialEmailHtml(listing.name, listing.contact_name, body), toEmail, 'info@trustedpanamastays.com', 'Trusted Panama Stays', 'info@trustedpanamastays.com'], { timeout: 15000 });
              }
                await supabaseAdmin.from('listings').update({
                    trial_final_notice_sent_at: new Date().toISOString(),
                    is_member: false, is_trial: false, membership_paid_until: null
                }).eq('id', listing.id);
                await logEvent('trial_expired_demoted', { listing_id: listing.id, extended: wasExtended, email: toEmail || null });
                results.finalNotice++;
            } catch (err) { results.errors++; console.error(`Final notice/demotion failed for listing ${listing.id}:`, err.message); }
        }

        if (results.finalNotice > 0) await recalculateFeatureRanks();

        res.json({ success: true, ...results });
    } catch (err) {
        console.error('Trial lifecycle check error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Shared validation for the extend-trial token, used by both the GET
// confirmation page and the POST that actually performs the extension. ──
async function validateExtendTrialToken(id, token) {
    const decoded = Buffer.from(token || '', 'base64').toString();
    const [tokenId, tokenTime, tokenSecret] = decoded.split(':');
    if (tokenId !== String(id) || tokenSecret !== process.env.ADMIN_SECRET) {
        return { ok: false, title: 'Enlace inválido', message: 'Este enlace no es válido.' };
    }
    if (Date.now() - parseInt(tokenTime, 10) > 10 * 24 * 60 * 60 * 1000) {
        return { ok: false, title: 'Enlace vencido', message: 'Este enlace ya no es válido.' };
    }

    const { data: listing, error } = await supabaseAdmin
        .from('listings')
        .select('id, is_member, is_trial, membership_paid_until, trial_extended_at')
        .eq('id', id).single();
    if (error || !listing) return { ok: false, title: 'No encontrado', message: 'No se encontró su hospedaje.' };
    if (listing.trial_extended_at) {
        return { ok: false, title: 'Ya utilizado', message: 'Este enlace de extensión ya fue utilizado anteriormente.' };
    }
    if (!listing.is_member || !listing.is_trial) {
        return { ok: false, title: 'No disponible', message: 'Su prueba gratuita ya no está activa.' };
    }
    return { ok: true, listing };
}

// ── GET /api/extend-trial — shows a confirmation page only. Does NOT touch
// the database, so an email security scanner or link-prefetcher (e.g.
// Microsoft Defender Safe Links) that silently fetches this URL before a
// human opens the email can no longer burn the one-time token. The actual
// extension only happens when a visitor clicks the button below, which
// fires the POST route beneath this one. ──
app.get('/api/extend-trial', async (req, res) => {
    const { id, token } = req.query;
    const showPage = (title, message, ok) => res.send(`<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px 20px;color:#111;">
<h2 style="color:${ok ? '#00a859' : '#c0392b'};">${title}</h2><p>${message}</p>
<p><a href="https://trustedpanamastays.com" style="color:#005ca9;">trustedpanamastays.com</a></p>
</body></html>`);

    try {
        const result = await validateExtendTrialToken(id, token);
        if (!result.ok) return showPage(result.title, result.message, false);

        return res.send(`<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px 20px;color:#111;">
<h2 style="color:#00a859;">¿Confirmar 7 días adicionales?</h2>
<p>Haga clic en el botón para activar la extensión de su prueba gratuita.</p>
<button id="confirmBtn" style="background-color:#00a859;color:white;border:none;border-radius:8px;padding:12px 32px;font-weight:700;font-size:1rem;cursor:pointer;">Sí, deme 7 días más →</button>
<p id="resultMsg" style="margin-top:20px;"></p>
<script>
document.getElementById('confirmBtn').addEventListener('click', async () => {
    const btn = document.getElementById('confirmBtn');
    btn.disabled = true; btn.textContent = 'Procesando…';
    try {
        const resp = await fetch('/api/extend-trial/confirm?id=${encodeURIComponent(id || '')}&token=${encodeURIComponent(token || '')}', { method: 'POST' });
        const data = await resp.json();
        document.getElementById('resultMsg').innerHTML = data.success
            ? '<strong style="color:#00a859;">¡Listo! Su prueba ahora vence el ' + data.newExpiry + '.</strong>'
            : '<strong style="color:#c0392b;">' + (data.message || 'Ocurrió un error.') + '</strong>';
        if (data.success) { btn.style.display = 'none'; } else { btn.disabled = false; btn.textContent = 'Sí, deme 7 días más →'; }
    } catch (e) {
        document.getElementById('resultMsg').innerHTML = '<strong style="color:#c0392b;">Ocurrió un error. Por favor contáctenos.</strong>';
        btn.disabled = false; btn.textContent = 'Sí, deme 7 días más →';
    }
});
</script>
</body></html>`);
    } catch (err) {
        console.error('extend-trial error:', err.message);
        return showPage('Error', 'Ocurrió un error. Por favor contáctenos.', false);
    }
});

// ── POST /api/extend-trial/confirm — performs the actual extension. Only
// reachable via an explicit click on the confirmation page above. ──
app.post('/api/extend-trial/confirm', async (req, res) => {
    const { id, token } = req.query;
    try {
        const result = await validateExtendTrialToken(id, token);
        if (!result.ok) return res.json({ success: false, message: result.message });

        const listing = result.listing;
        const base = listing.membership_paid_until ? new Date(listing.membership_paid_until) : new Date();
        base.setDate(base.getDate() + 7);
        const newExpiry = base.toISOString().split('T')[0];

        await supabaseAdmin.from('listings').update({
            membership_paid_until: newExpiry,
            trial_extended_at: new Date().toISOString()
        }).eq('id', id);
        await logEvent('trial_extended', { listing_id: id, new_expiry: newExpiry });

        return res.json({ success: true, newExpiry });
    } catch (err) {
        console.error('extend-trial confirm error:', err.message);
        return res.json({ success: false, message: 'Ocurrió un error. Por favor contáctenos.' });
    }
});


async function generateUniqueSlug(propertyName, listingId) {
    const baseSlug = propertyName.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const { data: conflict } = await supabaseAdmin
        .from('listings').select('id, name').eq('slug', baseSlug).maybeSingle();

    if (conflict) {
        const tempSlug = baseSlug + '-' + listingId;
        const conflictMsg = `<p>El nuevo miembro <strong>${propertyName}</strong> (ID: ${listingId}) tiene un conflicto de slug con <strong>${conflict.name}</strong> (ID: ${conflict.id}).</p><p>Slug: <code>${baseSlug}</code></p><p>Slug temporal asignado: <code>${tempSlug}</code>. Por favor corrija en el panel de administración.</p>`;
        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        execFileAsync('php', [notifyPath, 'Conflicto de slug — ' + propertyName, conflictMsg, 'info@trustedpanamastays.com'], { timeout: 15000 }).catch(console.error);
        return tempSlug;
    }
    return baseSlug;
}

// ── GET /api/keywords ─────────────────────────────────────────────────────────
app.get('/api/keywords', async (req, res) => {
    const { data, error } = await supabase
        .from('keywords')
        .select('slug, label_es, label_en, category_es, category_en, sort_order')
        .order('category_es')
        .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── GET /api/keywords/active ──────────────────────────────────────────────────
// Only keywords used by at least one member
app.get('/api/keywords/active', async (req, res) => {
    const { data, error } = await supabase
        .from('listings')
        .select('listing_keywords')
        .eq('is_member', true)
        .not('listing_keywords', 'is', null);
    if (error) return res.status(500).json({ error: error.message });
    const used = new Set(data.flatMap(r => r.listing_keywords || []));
    const { data: kw } = await supabase
        .from('keywords')
        .select('slug, label_es, label_en, category_es, category_en, sort_order')
        .order('category_es')
        .order('sort_order');
    res.json((kw || []).filter(k => used.has(k.slug)));
});

// ── POST /api/keyword-suggestion ─────────────────────────────────────────────
app.post('/api/keyword-suggestion', async (req, res) => {
    const { suggestion, listing_id, lang } = req.body;
    if (!suggestion) return res.status(400).json({ error: 'Missing suggestion' });
    await supabaseAdmin.from('event_log').insert({
        event_type: 'keyword_suggestion',
        event_data: { suggestion, listing_id, lang },
        created_at: new Date().toISOString()
    });
    res.json({ success: true });
});

// ── GET /api/admin/keyword-suggestions ───────────────────────────────────────
app.get('/api/admin/keyword-suggestions', requireAdmin, async (req, res) => {
    const { data } = await supabaseAdmin
        .from('event_log')
        .select('id, event_data, created_at')
        .eq('event_type', 'keyword_suggestion')
        .order('created_at', { ascending: false });
    const suggestions = (data||[]).map(r => ({
        id: r.id,
        suggestion: r.event_data?.suggestion || '',
        listing_id: r.event_data?.listing_id,
        created_at: r.created_at
    }));
    res.json({ suggestions });
});

// ── POST /api/admin/keyword-approve ──────────────────────────────────────────
app.post('/api/admin/keyword-approve', requireAdmin, async (req, res) => {
    const { slug, label_es, label_en, category_es, category_en, event_id } = req.body;
    const { error } = await supabaseAdmin.from('keywords').insert({
        slug, label_es, label_en, category_es, category_en, sort_order: 99
    });
    if (error) return res.status(500).json({ error: error.message });
    // Delete from event_log
    if (event_id) await supabaseAdmin.from('event_log').delete().eq('id', event_id);
    res.json({ success: true });
});

// ── POST /api/admin/keyword-dismiss ──────────────────────────────────────────
app.post('/api/admin/keyword-dismiss', requireAdmin, async (req, res) => {
    const { event_id } = req.body;
    await supabaseAdmin.from('event_log').delete().eq('id', event_id);
    res.json({ success: true });
});

// ── POST /api/admin/keyword-delete ───────────────────────────────────────────
app.post('/api/admin/keyword-delete', requireAdmin, async (req, res) => {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'Missing slug' });
    const { error } = await supabaseAdmin.from('keywords').delete().eq('slug', slug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});


// ── GET /api/payment-info ─────────────────────────────────────────────────────
app.get('/api/payment-info', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const { data } = await supabaseAdmin
        .from('membership_applications')
        .select('contact_name, business_name, ruc, ruc_dv, contact_email')
        .eq('listing_id', parseInt(id))
        .not('ruc', 'is', null)
        .neq('status', 'archived')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json({
        name:   data.business_name || data.contact_name || null,
        ruc:    data.ruc || null,
        ruc_dv: data.ruc_dv || null,
        email:  data.contact_email || null
    });
});


/// ── eFactura payment-method mapping (per eFacturaPty API docs) ────────────────
// Source of truth for formaPago codes. Extend this map as new payment methods
// are supported — the invoice code itself never needs to change, only this map.
const EFACTURA_FORMA_PAGO = {
    transfer:        '08',
    transferencia:   '08',
    deposito:        '08',
    cash:            '02',
    efectivo:        '02',
    credit_card:     '03',
    tarjeta_credito: '03',
    debit_card:      '04',
    tarjeta_debito:  '04',
    check:           '09',
    cheque:          '09'
};
function resolveFormaPago(paymentMethod) {
    if (!paymentMethod) return EFACTURA_FORMA_PAGO.transfer;
    const key = paymentMethod.toString().trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents (transferéncia → transferencia)
        .replace(/\s+/g, '_');
    return EFACTURA_FORMA_PAGO[key] || EFACTURA_FORMA_PAGO.transfer;
}

// -------------------------------------------------------------------------------
// ── POST /api/admin/issue-invoice ─────────────────────────────────────────────
// Called from admin panel "Issue Invoice & Activate" button
// -------------------------------------------------------------------------------
app.post('/api/admin/issue-invoice', requireAdmin, async (req, res) => {
    const { listing_id, application_id, plan, business_name, ruc, ruc_dv, email } = req.body;
    // receptor_type: 'ruc' (Contribuyente, tipoReceptorFe 01 — default, keeps
    // old callers working unchanged), 'cedula' (Consumidor Final, 02 — a
    // Panamanian member who has no RUC), or 'pasaporte' (Extranjero, 04 — a
    // foreign member who has no RUC). Added 2026-08-23: not every member has
    // a valid RUC (see the Daniel Gerber/Casitas Vista Verde case — a foreign
    // E-cédula holder without a registered RUC/NT), and eFacturaPty supports
    // invoicing those cases directly instead of blocking on a missing RUC.
    const receptorType = req.body.receptor_type || 'ruc';
    const personalId = (req.body.personal_id || '').trim();
    const personalIdCountry = (req.body.personal_id_country || '').trim().toUpperCase();

    if (!listing_id || !plan || !business_name || !email)
        return res.status(400).json({ error: 'Missing required fields' });
    if (!['ruc', 'cedula', 'pasaporte'].includes(receptorType))
        return res.status(400).json({ error: 'Invalid receptor_type' });
    if (receptorType === 'ruc' && (!ruc || !ruc_dv))
        return res.status(400).json({ error: 'Missing RUC/DV' });
    if (receptorType === 'cedula' && !personalId)
        return res.status(400).json({ error: 'Missing cédula number' });
    if (receptorType === 'pasaporte' && (!personalId || !personalIdCountry))
        return res.status(400).json({ error: 'Missing passport number or country' });

    // ── Guard against issuing a second real DGI fiscal invoice for the same
    // payment — unlike the 'payments' insert further below (which only
    // dedupes by an already-returned CUFE), nothing previously stopped this
    // route from being called twice and creating two separate real invoices
    // in eFacturaPty for the same transaction. Block it up front instead.
    try {
        let existingQuery = supabaseAdmin.from('payments').select('cufe, invoice_url, invoice_date').eq('status', 'invoiced');
        existingQuery = application_id ? existingQuery.eq('application_id', application_id) : existingQuery.eq('listing_id', listing_id);
        const { data: alreadyInvoiced } = await existingQuery.order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (alreadyInvoiced) {
            return res.status(400).json({
                error: `An invoice was already issued for this payment on ${alreadyInvoiced.invoice_date} (CUFE ${alreadyInvoiced.cufe || 'unknown'}). Issuing another would create a duplicate fiscal invoice — check the Facturas tab or ${alreadyInvoiced.invoice_url || 'efacturapty.com'} instead.`
            });
        }
    } catch (guardErr) {
        console.error('issue-invoice duplicate-check failed (continuing):', guardErr.message);
    }

        const planCode    = plan === '2year' ? 'TPS02' : 'TPS01';
        const planDesc    = plan === '2year' ? 'Membresía Trusted Panama Stays — 2 años' : 'Membresía Trusted Panama Stays — 1 año';
        const totalPaid   = parseFloat(req.body.amount_total) || (plan === '2year' ? 48.15 : 25.68);
        const netAmount   = Math.round(totalPaid / 1.07 * 100) / 100;
        const itbmsAmount = Math.round(netAmount * 0.07 * 100) / 100;
        const grossAmount = Math.round((netAmount + itbmsAmount) * 100) / 100;
        const planPrice   = netAmount; // kept for backward compat with invoice body fields

        // Derive the actual payment method from the application record (set either
        // from the join-application form or from AI-detected verification in
        // pay.html), rather than assuming transfer — falls back to transfer if
        // no application is linked or no method was recorded.
        let recognizedPaymentMethod = null;
        if (application_id) {
            const { data: appRow } = await supabaseAdmin
                .from('membership_applications')
                .select('payment_method')
                .eq('id', application_id)
                .single();
            recognizedPaymentMethod = appRow?.payment_method || null;
        }
        const formaPagoCode = resolveFormaPago(recognizedPaymentMethod);

        // Multiple recipients: member + TPS copy
        const recipients = `${email};info@trustedpanamastays.com`;

        // Receptor block varies by category — the operation itself is always
        // a domestic (Panamá) sale of services regardless of the buyer's
        // nationality or documentation, so destinoOperacion/paisReceptor
        // never change; only tipoReceptorFe and its associated identification
        // sub-object do. Built 2026-08-23 from the eFacturaPty schema the
        // user pasted from
        // https://efacturapty.stoplight.io/docs/efactura-api/branches/main/w217235zxgsai-obtiene-los-datos-de-una-factura
        let informacionReceptor;
        if (receptorType === 'cedula') {
            // Consumidor Final (02). Per the pasted schema, none of
            // datosRucReceptor/direccionReceptor/ubicacionReceptor/
            // grupoIdentificacionExtranjera are required — or even offered —
            // for this category, and there is no dedicated field for a
            // buyer's cédula number. Folded into nombreRazonReceptor purely
            // for our own paper trail; it does not reach a structured DGI
            // field. nombreRazonReceptor itself isn't required for 02 either,
            // but a real, successfully-authorized invoice in this same
            // eFacturaPty account (Aparthotel Boquete → Shelia Miller, see
            // the extranjero case below) populated it anyway, so we do too.
            informacionReceptor = {
                tipoReceptorFe:      '02',
                nombreRazonReceptor: personalId ? `${business_name} (Cédula ${personalId})` : business_name,
                correoReceptor:      recipients,
                paisReceptor:        'PA'
            };
        } else if (receptorType === 'pasaporte') {
            // Extranjero (04). grupoIdentificacionExtranjera's own field
            // names were NOT visible in the schema pasted 2026-08-23 —
            // Stoplight didn't expand that nested object. The shape below
            // (numeroIdentificacion + paisIdentificacion) is a BEST GUESS at
            // eFacturaPty's JSON mapping, inferred from a real,
            // successfully-authorized DGI XML invoice on this same
            // certificate/account (Aparthotel Boquete → Shelia Miller, US
            // passport 578949663), whose raw <gIdExt> element carries
            // <dIdExt> (id number) + <dPaisExt> (2-letter country) — NOT
            // confirmed against eFacturaPty's actual JSON schema. If this
            // fails validation, nothing is activated/saved (see the
            // `!authorized` branch below) and the raw error response names
            // exactly what's wrong — paste it back to correct the field
            // names in one more pass.
            informacionReceptor = {
                tipoReceptorFe:      '04',
                grupoIdentificacionExtranjera: {
                    numeroIdentificacion: personalId,
                    paisIdentificacion:   personalIdCountry
                },
                nombreRazonReceptor: business_name,
                correoReceptor:      recipients,
                paisReceptor:        'PA'
            };
        } else {
            // RUC-holder (Contribuyente, 01) — unchanged existing path.
            informacionReceptor = {
                tipoReceptorFe:   '01',
                datosRucReceptor: {
                    tipoContribuyente: 2,
                    rucReceptor:       ruc,
                    digitoVerificador: ruc_dv
                },
                nombreRazonReceptor: business_name,
                correoReceptor:      recipients,
                paisReceptor:        'PA'
            };
        }

    const invoiceBody = {
        datosGenerales: {
            tipoDocumento:     '01',  // Factura de operación interna
            puntoFacturacion:  '200',
            fechaEmision:      new Date().toISOString(),
            naturalezaOperacion: '01', // Venta
            tipoOperacion:     1,      // Salida/venta
            destinoOperacion:  1,      // Panamá (always — same-country service regardless of receptor category)
            tipoTransaccionVenta: 4,   // Prestación de servicio
            tipoSucursal:      1,
            informacionReceptor
        },
        listaItems: [{
            numeroSecuenciaItem:              1,
            descripcionProductoServicio:      planDesc,
            codigoInternoItem:                planCode,
            cantidadProductoServicio:         1,
            codigoItemCodificacionPanamenaAbreviada: 81,  // Servicios de tecnología
            grupoPrecios: {
                precioUnitarioTransferencia: netAmount,
                precioItem:                  netAmount,
                sumaPrecioItem:              grossAmount
            },
            grupoITBMS: {
                tasaITBMSAplicable: '01',  // 7% ITBMS
                montoITBMS:         itbmsAmount
            }
        }],
        totales: {
            tiempoPago: 1,  // Contado — the only other required field in this object
            grupoFormasPago: [{
                formaPago:       formaPagoCode,
                valorCuotaPagada: grossAmount
            }]
            // totalNeto, totalITBMS, totalGravado, valorTotalFactura, sumaValoresRecibidos,
            // numeroTotalItems, totalTodosItems, etc. are all "Calculado por el sistema"
            // per the eFacturaPty docs — left out so eFacturaPty derives and validates
            // them itself instead of us recomputing (and risking a mismatch).
        }
    };

    try {
        const response = await axios.post(
            'https://api.efacturapty.com/api/v1/Invoices',
            invoiceBody,
            {
                headers: {
                    'Content-Type':    'application/json',
                    'Accept-Language': 'es-PA',
                    'Authorization':   'Bearer ' + process.env.EFACTURA_API_KEY
                },
                timeout: 30000
            }
        );

        const invoice     = response.data;
        const resProc     = invoice?.rRetEnviFe?.xProtFe?.rProtFe?.gInfProt?.gResProc || [];
        const environment  = invoice?.rRetEnviFe?.iAmb; // 1 = producción, 2 = pruebas/sandbox
        const isProduction = environment === 1;
        const authorized   = invoice.autorizada === true && isProduction;

        // eFacturaPty's "invoice" field is an opaque UUID (used only for the
        // CAFE PDF URL, /Invoices/{id}/cafe-file) — not a human-readable
        // invoice number. The only field in the raw response that behaves
        // like a running document sequence is "secuence" (eFacturaPty's own
        // spelling); paired with our fixed puntoFacturacion ("200") it
        // reproduces the "puntoFacturacion-correlativo" style number used in
        // Volker's accounting filenames (e.g. "200-020"). Best-effort
        // mapping, added 2026-08-23, not confirmed against an official
        // eFacturaPty field-name doc — if a number on a downloaded CAFE PDF
        // ever doesn't match this, the raw response saved to event_log
        // (`efactura_raw_response`) has the real data to work out the right
        // field.
        const invoiceNumber = (invoice.secuence !== undefined && invoice.secuence !== null)
            ? `${invoiceBody.datosGenerales.puntoFacturacion}-${String(invoice.secuence).padStart(3, '0')}`
            : null;

        await logEvent('efactura_raw_response', {
            listing_id, application_id,
            status: response.status,
            raw_response: invoice
        });

        if (!authorized) {
            const mappedErrors = resProc.length
                ? resProc.map(e => ({ codigo: e.dCodRes, mensaje: e.dMsgRes }))
                : [{ codigo: 'NOT_AUTHORIZED', mensaje: 'autorizada = false, sin detalle de error' }];
            if (invoice.autorizada === true && !isProduction) {
                mappedErrors.push({ codigo: 'SANDBOX_MODE', mensaje: `Factura autorizada pero en ambiente de PRUEBAS (iAmb=${environment}) — no se guarda como factura real. Cambie a "en vivo" en admin.efacturapty.com si desea emitir de verdad.` });
            }
            await logEvent('invoice_errors', { listing_id, application_id, errors: mappedErrors });
            return res.status(422).json({
                error: isProduction ? 'Invoice not authorized' : 'Invoice authorized in sandbox mode — not saved as real',
                errors: mappedErrors,
                cufe: invoice.cufe || null,
                invoice_id: invoice.invoice || null,
                raw_response: invoice
            });
        }

        // Activate membership
        const paidUntil = new Date();
        plan === '2year'
            ? paidUntil.setFullYear(paidUntil.getFullYear() + 2)
            : paidUntil.setFullYear(paidUntil.getFullYear() + 1);
        const paidUntilStr = paidUntil.toISOString().split('T')[0];

        await supabaseAdmin.from('listings').update({
            is_member:             true,
            is_trial:              false,
            membership_paid_until: paidUntilStr,
            invitation_status:     'member'
        }).eq('id', listing_id);

        if (application_id) {
            const appUpdates = {
                status:      'approved',
                reviewed_at: new Date().toISOString(),
                reviewed_by: 'admin',
                notes:       `Invoice issued: ${invoice.cufe || invoice.invoice || 'ok'}`
            };
            // Sync whichever ID the invoice actually used back onto the
            // application record (2026-08-23) — previously only the
            // separate "Guardar RUC" field in the member panel persisted
            // ruc/ruc_dv/personal_id; an ID typed directly into the invoice
            // form (e.g. Daniel Gerber's cédula) was used for that one
            // invoice and then lost, leaving "N° ID (si no hay RUC)" blank
            // next time the panel was opened even though the invoice had
            // succeeded. Now every successful invoice writes its ID back.
            if (receptorType === 'ruc') {
                if (ruc)    appUpdates.ruc    = String(ruc).trim();
                if (ruc_dv) appUpdates.ruc_dv = String(ruc_dv).trim();
            } else if (personalId) {
                appUpdates.personal_id = personalId;
            }
            await supabaseAdmin.from('membership_applications').update(appUpdates).eq('id', application_id);
        }

        await recalculateFeatureRanks();
        await logEvent('invoice_issued', {
            listing_id, plan, amount: planPrice,
            cufe: invoice.cufe, invoice_id: invoice.invoice,
            receptor_type: receptorType,
            personal_id: receptorType !== 'ruc' ? personalId : undefined,
            personal_id_country: receptorType === 'pasaporte' ? personalIdCountry : undefined
        });

        // Guard against duplicate inserts (e.g. accidental double-click)
        const { data: existingPayment } = await supabaseAdmin
            .from('payments')
            .select('id')
            .eq('cufe', invoice.cufe)
            .maybeSingle();

        if (!existingPayment) {
            await supabaseAdmin.from('payments').insert({
                listing_id:     parseInt(listing_id),
                application_id: application_id ? parseInt(application_id) : null,
                amount_net:     planPrice,
                itbms:          Math.round(planPrice * 0.07 * 100) / 100,
                amount_total:   Math.round(planPrice * 1.07 * 100) / 100,
                payment_method: recognizedPaymentMethod || 'transfer',
                cufe:           invoice.cufe || null,
                invoice_uuid:   invoice.invoice || null,
                invoice_url:    invoice.invoice ? `https://admin.efacturapty.com/external/invoices/${invoice.invoice}` : null,
                invoice_number: invoiceNumber,
                invoice_date:   new Date().toISOString().split('T')[0],
                status:         'invoiced'
            });
        } else {
            console.log(`Skipped duplicate payment insert for CUFE ${invoice.cufe} — already recorded`);
        }

        res.json({ success: true, paid_until: paidUntilStr, invoice, invoice_number: invoiceNumber });

    } catch (err) {
        const errMsg = err.response?.data || err.message;
        console.error('eFactura error:', errMsg);
        res.status(500).json({ error: 'Invoice failed', detail: errMsg });
    }
});

// -------------------------------------------------------------------------------
// ── Invoice reconciliation ("Update invoices") — added 2026-08-23 ────────────
// Replaces the old "📋 Manual" button/flow, which posted to a
// /api/admin/confirm-payment route that never existed (see project notes).
// Real need it replaces: sometimes an invoice has to be created by hand
// directly on admin.efacturapty.com (e.g. a receptor category or correction
// our form doesn't support yet) — that invoice is real and DGI-authorized,
// but TPS's own `payments` table never learns about it. These two routes let
// the admin pull the list of invoices eFacturaPty actually has on file, spot
// the ones missing from `payments`, and link each one to the right TPS
// listing on purpose (never silently/automatically).
// -------------------------------------------------------------------------------

// GET /api/admin/efactura-unlinked-invoices?days=400
// Lists eFacturaPty invoices (filtered to TPS's own billing point, "200" —
// the same eFacturaPty account/certificate is also used for Aparthotel
// Boquete's unrelated invoices, which must never leak into this list) that
// have no matching row in `payments` yet. For each one, suggests a TPS
// listing/application match by RUC first, then by receptor name, but never
// auto-links — the admin picks/confirms via /api/admin/efactura-link-invoice.
app.get('/api/admin/efactura-unlinked-invoices', requireAdmin, async (req, res) => {
    const days = parseInt(req.query.days) || 400;
    const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    try {
        // 1) Pull every invoice we already know about, so we only surface
        // genuinely missing ones.
        const { data: knownPayments } = await supabaseAdmin
            .from('payments')
            .select('cufe')
            .not('cufe', 'is', null);
        const knownCufes = new Set((knownPayments || []).map(p => p.cufe));

        // 2) Page through eFacturaPty's own invoice list for our billing
        // point only. Capped at 10 pages (≈1000 invoices) as a sanity
        // backstop — TPS's real volume is nowhere near that.
        const found = [];
        for (let page = 1; page <= 10; page++) {
            const response = await axios.get('https://api.efacturapty.com/api/v1/Invoices', {
                headers: {
                    'Accept':          'application/json',
                    'Accept-Language': 'es-PA',
                    'Authorization':   'Bearer ' + process.env.EFACTURA_API_KEY
                },
                params: {
                    BillingPoint: '200',
                    DateFrom:     dateFrom,
                    PageSize:     100,
                    Page:         page
                },
                timeout: 30000
            });
            const pageItems = response.data?.items || response.data?.data || response.data || [];
            if (!Array.isArray(pageItems) || pageItems.length === 0) break;
            found.push(...pageItems);
            if (pageItems.length < 100) break;
        }

        const unlinked = found.filter(inv => inv.cufe && !knownCufes.has(inv.cufe));

        // 3) Best-effort suggested match — RUC first (exact), then a loose
        // name match. Never used to auto-link, only to pre-fill the review
        // UI so the admin has less to type.
        const { data: apps } = await supabaseAdmin
            .from('membership_applications')
            .select('id, listing_id, ruc, business_name')
            .order('created_at', { ascending: false });

        const suggestions = unlinked.map(inv => {
            const ruc  = inv.rucReceiver || inv.ruc || null;
            const name = (inv.nameReceiver || inv.name || '').trim();
            let match = ruc ? (apps || []).find(a => a.ruc && a.ruc === ruc) : null;
            if (!match && name) {
                const nameLower = name.toLowerCase();
                match = (apps || []).find(a =>
                    a.business_name && (
                        a.business_name.toLowerCase().includes(nameLower) ||
                        nameLower.includes(a.business_name.toLowerCase())
                    )
                );
            }
            const totalAmount = inv.totalAmount ?? inv.totalAmounttITBMS ?? null;
            // Same $48.15/2yr vs $25.68/1yr amount heuristic used elsewhere
            // in this file (see approve-application's duration correction) —
            // just a pre-filled guess, admin can override before linking.
            let guessedMonths = 12;
            if (totalAmount !== null) {
                if (Math.abs(totalAmount - 48.15) < 0.5) guessedMonths = 24;
                else if (Math.abs(totalAmount - 25.68) < 0.5) guessedMonths = 12;
            }
            return {
                cufe:               inv.cufe,
                invoice_uuid:       inv.id,
                invoice_number:     inv.invoiceNumber || null,
                issue_date:         inv.issueDate || null,
                status:             inv.status || null,
                receptor_name:      inv.nameReceiver || inv.name || null,
                receptor_ruc:       ruc,
                amount_total:       totalAmount,
                amount_itbms:       inv.totalAmounttITBMS ?? null,
                suggested_listing_id:     match ? match.listing_id : null,
                suggested_application_id: match ? match.id : null,
                suggested_name:           match ? match.business_name : null,
                guessed_months:     guessedMonths
            };
        });

        res.json({ invoices: suggestions });
    } catch (err) {
        const errMsg = err.response?.data || err.message;
        console.error('efactura-unlinked-invoices error:', errMsg);
        res.status(500).json({ error: 'Could not fetch invoice list', detail: errMsg });
    }
});

// POST /api/admin/efactura-link-invoice
// Admin-confirmed: record one eFacturaPty invoice found above into
// `payments` and activate membership on the chosen listing, exactly
// mirroring what /api/admin/issue-invoice does on success — this is meant
// to reach the same end state as if the automated flow had worked.
app.post('/api/admin/efactura-link-invoice', requireAdmin, async (req, res) => {
    const {
        cufe, invoice_uuid, invoice_number, issue_date,
        amount_total, amount_itbms, listing_id, application_id, duration_months
    } = req.body;
    if (!cufe || !invoice_uuid || !listing_id || !duration_months)
        return res.status(400).json({ error: 'Missing required fields' });

    try {
        const { data: existing } = await supabaseAdmin
            .from('payments').select('id').eq('cufe', cufe).maybeSingle();
        if (existing) return res.status(409).json({ error: 'This invoice is already linked' });

        const total = parseFloat(amount_total) || 0;
        const itbms = amount_itbms !== undefined && amount_itbms !== null
            ? parseFloat(amount_itbms)
            : Math.round(total * (0.07 / 1.07) * 100) / 100;
        const net = Math.round((total - itbms) * 100) / 100;

        const baseDate = issue_date ? new Date(issue_date) : new Date();
        const paidUntil = new Date(baseDate);
        parseInt(duration_months) === 24
            ? paidUntil.setFullYear(paidUntil.getFullYear() + 2)
            : paidUntil.setFullYear(paidUntil.getFullYear() + 1);
        const paidUntilStr = paidUntil.toISOString().split('T')[0];

        await supabaseAdmin.from('listings').update({
            is_member:             true,
            is_trial:              false,
            membership_paid_until: paidUntilStr,
            invitation_status:     'member'
        }).eq('id', listing_id);

        if (application_id) {
            await supabaseAdmin.from('membership_applications').update({
                status:      'approved',
                reviewed_at: new Date().toISOString(),
                reviewed_by: 'admin',
                notes:       `Invoice linked from efacturapty.com reconciliation: ${cufe}`
            }).eq('id', application_id);
        }

        await supabaseAdmin.from('payments').insert({
            listing_id:     parseInt(listing_id),
            application_id: application_id ? parseInt(application_id) : null,
            amount_net:     net,
            itbms:          itbms,
            amount_total:   total,
            payment_method: 'manual (efacturapty.com)',
            cufe:           cufe,
            invoice_uuid:   invoice_uuid,
            invoice_url:    `https://admin.efacturapty.com/external/invoices/${invoice_uuid}`,
            invoice_number: invoice_number || null,
            invoice_date:   issue_date ? String(issue_date).split('T')[0] : new Date().toISOString().split('T')[0],
            status:         'invoiced'
        });

        await recalculateFeatureRanks();
        await logEvent('invoice_linked_manual', { listing_id, application_id, cufe, invoice_number });

        res.json({ success: true, paid_until: paidUntilStr });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/admin/deactivate-membership ────────────────────────────────────
app.post('/api/admin/deactivate-membership', requireAdmin, async (req, res) => {
    const { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'Missing application_id' });

    const { data: app } = await supabaseAdmin
        .from('membership_applications')
        .select('listing_id, duration_months')
        .eq('id', application_id)
        .single();
    if (!app) return res.status(404).json({ error: 'Application not found' });

    // Get listing's previous paid_until before pre-approval
    const { data: listing } = await supabaseAdmin
        .from('listings')
        .select('is_trial, trial_started_at, membership_paid_until')
        .eq('id', app.listing_id)
        .single();

    // Revert: if they had a trial before, restore trial state
    // Otherwise deactivate completely
    const hadTrial = listing?.trial_started_at && listing?.is_trial;
    const updates = hadTrial
        ? { is_member: true, is_trial: true, membership_paid_until: listing.membership_paid_until }
        : { is_member: false, is_trial: false, membership_paid_until: null };

    await supabaseAdmin.from('listings').update(updates).eq('id', app.listing_id);
    await supabaseAdmin.from('membership_applications')
        .update({ status: 'rejected', notes: 'Payment not received — membership deactivated' })
        .eq('id', application_id);

    await recalculateFeatureRanks();
    await logEvent('membership_deactivated', { listing_id: app.listing_id, application_id });
    res.json({ success: true });
});

// ── General ATP Campaign — daily batch of 280 emails at 10am Panama ──────────
async function sendGeneralCampaignBatch() {
    try {
        // Guard against duplicate runs: the schedule below re-registers itself
        // every time the Node process restarts (e.g. on redeploy), so multiple
        // restarts near 10am — or several instances briefly overlapping — can
        // each try to fire. A plain "check, then later write" guard has a race
        // window (multiple callers can all pass the check before any of them
        // writes back), which is what let 3 duplicate sends through on
        // 2026-07-25. Fixed with an atomic claim: only the FIRST caller to
        // insert today's row succeeds; every other concurrent caller sees a
        // conflict and bails out immediately, before querying any listings.
        const todayStr = new Date().toISOString().split('T')[0];
        const claimKey = 'general_campaign_last_run_' + todayStr;
        const { error: claimError } = await supabaseAdmin
            .from('settings')
            .insert({ key: claimKey, value: todayStr, updated_at: new Date().toISOString() });
        if (claimError) {
            // Insert failed = another instance already claimed today (unique
            // constraint conflict) — this is the expected, safe outcome for
            // every caller except the first.
            console.log('General campaign: already claimed today by another run — skipping duplicate trigger');
            return;
        }

        // Check if there are any to send
        const { data: rawListings } = await supabaseAdmin
            .from('listings')
            .select('id, name, email, province, rental_type, slug, apatel_member')
            .eq('is_member', false)
            .eq('atp_active', true)
            .is('general_campaign_sent_at', null)
            .is('invitation_sent_at', null)
            .not('email', 'is', null)
            .limit(280);  // Stay under Brevo 300/day (leaves room for other emails)

        // Same email-validity filter as the manual campaign button — excludes
        // blank strings and placeholder text ("no aporto", "n/t", etc.) that
        // pass the DB's not-null check but aren't real addresses.
        const isValidEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e||'').trim());
        const listings = (rawListings || []).filter(l => isValidEmail(l.email));

        if (!listings || listings.length === 0) {
            console.log('General campaign: no eligible listings with a valid email today');
            return; // nothing to report — no notification sent
        }

        // Load template
        const templatePath = path.join(__dirname, 'public', 'templates', 'atp_general_campaign_es.html');
        let templateBody = '';
        try { templateBody = fs.readFileSync(templatePath, 'utf8'); }
        catch(e) { console.error('General campaign template not found'); return; }

        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        let sent = 0, errors = 0;

        for (const listing of listings) {
            if (!listing.email || !listing.email.includes('@')) continue;
            try {
              const subject = 'Su hospedaje en Trusted Panama Stays — directorio verificado de turismo';
              const html = `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;margin:0;padding:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="margin:0 auto 1.5rem;">
  <tr><td bgcolor="#005ca9" style="background-color:#005ca9;" width="600">
      <img src="https://trustedpanamastays.com/images/email-header.png" alt="Trusted Panama Stays — Directorio de hospedajes legalmente registrados en Panamá" width="600" style="display:block;width:600px;border:0;color:#ffffff;font-size:22px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;text-align:center;padding:40px 20px;background-color:#005ca9;">
  </td></tr>
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="margin:0 auto;">
  <tr><td height="20" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
  <tr><td style="padding:0 20px;">
<p style="margin-top:0;">Estimado/a propietario/a de <strong>${listing.name}</strong>,</p>
${templateBody}
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
<a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a><br>
<a href="https://trustedpanamastays.com/index.php?lang=es" style="color:#7ec8e3;">trustedpanamastays.com</a></p>
  </td></tr>
</table>
</body></html>`;

                await execFileAsync('php', [notifyPath, subject, html, listing.email], { timeout: 15000 });

                await supabaseAdmin.from('listings').update({
                    general_campaign_sent_at: new Date().toISOString(),
                    invitation_status: 'invited',
                    invitation_sent_at: new Date().toISOString()
                }).eq('id', listing.id);

                sent++;
                await new Promise(r => setTimeout(r, 200)); // 200ms between emails
            } catch(err) {
                console.error(`General campaign failed for ${listing.name}:`, err.message);
                errors++;
            }
        }

        await logEvent('general_campaign_batch', { sent, errors, remaining: listings.length - sent });
          console.log(`General campaign batch: ${sent} sent, ${errors} errors`);

          // Only notify if something actually happened — no point emailing "0 sent, 0 errors"
          if (sent > 0 || errors > 0) {
              const notifyPath2 = path.join(__dirname, 'public', 'notify.php');
              const adminMsg = `<p>General campaign batch completed: <strong>${sent} sent</strong>, ${errors} errors.</p>`;
              execFileAsync('php', [notifyPath2, `TPS General Campaign: ${sent} sent`, adminMsg, 'info@trustedpanamastays.com'], { timeout: 15000 }).catch(console.error);
          }
    } catch(err) {
        console.error('sendGeneralCampaignBatch error:', err.message);
    }
}

// Schedule at 10am Panama time (UTC-5 = 15:00 UTC)
const msUntil10am = (() => {
    const next = new Date();
    next.setUTCHours(15, 0, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    return next - new Date();
})();
// General campaign scheduler
  setTimeout(() => {
     sendGeneralCampaignBatch();
     setInterval(sendGeneralCampaignBatch, 24 * 60 * 60 * 1000);
 }, msUntil10am);


// ── POST /api/admin/send-general-campaign-now ────────────────────────────────
app.post('/api/admin/send-general-campaign-now', requireAdmin, async (req, res) => {
    res.json({ success: true, message: 'Batch started' });
    sendGeneralCampaignBatch(); // Run in background
});

// ── Message history for one or more members — no 200-entry cap, matches by
// listing_id when available, falls back to email match for older entries
// logged before listing_id was captured ──
app.get('/api/admin/message-history', requireAdmin, async (req, res) => {
    const EMAIL_EVENT_TYPES = ['followup_sent', 'trial_reminder_sent', 'trial_extension_offer_sent', 'trial_expired_demoted'];
    const ids    = (req.query.ids || '').split(',').map(s => parseInt(s)).filter(Boolean);
    const emails = (req.query.emails || '').split(',').map(s => s.toLowerCase().trim()).filter(Boolean);
    if (!ids.length && !emails.length) return res.status(400).json({ error: 'ids or emails required' });
    try {
        let query = supabaseAdmin
            .from('event_log')
            .select('event_type, event_data, created_at')
            .in('event_type', EMAIL_EVENT_TYPES)
            .order('created_at', { ascending: false })
            .limit(1000);
        if (req.query.from) query = query.gte('created_at', req.query.from);
        if (req.query.to)   query = query.lte('created_at', req.query.to + 'T23:59:59');
        const { data, error } = await query;
        if (error) throw new Error(error.message);

        const matched = (data || []).filter(row => {
            const d = row.event_data || {};
            if (d.listing_id != null && ids.includes(Number(d.listing_id))) return true;
            if (d.email && emails.includes(String(d.email).toLowerCase())) return true;
            return false;
        });
        res.json(matched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Inbound application email webhook (Hostinger) ─────────────────────────────
// Phase 2: full parsing. Confirmed live payload shape (2026-08-01): Hostinger's
// "Agentic Mail" message.received event delivers plainBody/htmlBody inline
// (not truncated) plus attachments[] with pre-signed, time-limited GCS
// fileUrls — no follow-up Mail REST API call needed.

// Extract the listing ID from a [TPS-#####] tag in the subject line, e.g.
// "Re: Trial Listing Application [TPS-1234]" → 1234.
function extractListingIdFromSubject(subject) {
    const m = (subject || '').match(/\[TPS-(\d+)\]/i);
    return m ? parseInt(m[1], 10) : null;
}

// Primary description extraction: look for the delimiter markers we ask
// senders to reply between. Handles both the Spanish and English marker
// text, and strips leading "> " reply-quote prefixes some mail clients add
// per line if the sender replied inline rather than at the top.
function extractDescriptionByDelimiter(plainBody) {
    if (!plainBody) return null;
    const unquoted = plainBody.replace(/^>+\s?/gm, '');
    const m = unquoted.match(/-{3,}\s*(?:INICIO DESCRIPCI[ÓO]N|DESCRIPTION START)\s*-{3,}\s*([\s\S]*?)\s*-{3,}\s*(?:FIN DESCRIPCI[ÓO]N|DESCRIPTION END)\s*-{3,}/i);
    if (!m) return null;
    const text = m[1].trim();
    return text.length >= 5 ? text : null;
}

// Fallback: ask the AI to pull just the description out of a messy reply
// (greetings/signature/quoted history included), when the delimiter wasn't
// followed. Text-only — no images — matching runAiVerification()'s call
// pattern but with a much smaller prompt/response.
async function aiExtractDescription(plainBody) {
    if (!plainBody) return null;
    const prompt = `The following is an email reply from a hotel/rental owner to a signup campaign. They were asked to write a short description of their property, but may not have followed the requested format (they may have included greetings, a signature, quoted previous messages, or unrelated text).

Extract ONLY the property description text, in the sender's own words. If no genuine property description is present at all, return an empty string.

Email body:
"""
${plainBody.slice(0, 4000)}
"""

Return ONLY a JSON object, no other text:
{ "description": "..." }`;
    try {
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-opus-4-5', max_tokens: 500,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
        }, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            timeout: 30000
        });
        const result = JSON.parse(response.data.content[0].text.replace(/```json\n?|\n?```/g, '').trim());
        const text = (result.description || '').trim();
        return text.length >= 5 ? text : null;
    } catch (err) {
        console.error('aiExtractDescription error:', err.message);
        return null;
    }
}

// Very rough language guess — good enough to flag for admin review, not a
// substitute for careful checking. Counts a handful of common Spanish-only
// stopwords vs English-only stopwords.
function detectLanguage(text) {
    if (!text) return null;
    const t = ' ' + text.toLowerCase() + ' ';
    const esHits = (t.match(/ (el|la|los|las|de|para|con|nuestro|nuestra|hospedaje|habitaciones) /g) || []).length;
    const enHits = (t.match(/ (the|and|for|with|our|rooms|property) /g) || []).length;
    if (esHits === 0 && enHits === 0) return null;
    return esHits >= enHits ? 'es' : 'en';
}

// Sanitize an attachment filename the same way as /api/listing-photo-upload,
// for consistency across both storage paths.
function safeAttachmentName(originalname) {
    return originalname
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();
}

app.post('/api/inbound-application', express.json({ limit: '10mb' }), async (req, res) => {
    const auth = req.get('authorization') || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== process.env.INBOUND_WEBHOOK_SECRET) {
        return res.status(401).send('Unauthorized');
    }
    res.sendStatus(200); // acknowledge immediately, per Hostinger's guidance

    try {
        const payload = req.body?.data || {};
        const subject = payload.subject || '';
        const senderEmail = payload.from || null;
        const plainBody = payload.plainBody || '';
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

        const listingId = extractListingIdFromSubject(subject);
        const matchMethod = listingId ? 'subject_tag' : 'unmatched';

        let descriptionText = extractDescriptionByDelimiter(plainBody);
        let extractionMethod = descriptionText ? 'delimiter' : null;
        if (!descriptionText) {
            descriptionText = await aiExtractDescription(plainBody);
            if (descriptionText) extractionMethod = 'ai_fallback';
        }

        const detectedLang = detectLanguage(descriptionText);

        // Insert first (without photos) to obtain the submission id, which
        // is needed for the pending/{submission_id}/ storage path.
        const { data: inserted, error: insertErr } = await supabaseAdmin
            .from('pending_submissions')
            .insert({
                listing_id: listingId,
                sender_email: senderEmail,
                subject,
                description_text: descriptionText,
                detected_lang: detectedLang,
                extraction_method: extractionMethod,
                match_method: matchMethod,
                raw_payload: req.body,
                status: 'pending'
            })
            .select('id')
            .single();
        if (insertErr) throw insertErr;
        const submissionId = inserted.id;

        // Download each attachment from its pre-signed GCS URL and re-upload
        // to Supabase Storage under pending/{submissionId}/ — kept separate
        // from the real listing-photos tree until admin approval.
        const storedPhotos = [];
        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            if (!att.fileUrl || !(att.contentType || '').startsWith('image/')) continue;
            try {
                const fileRes = await axios.get(att.fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
                const safeName = safeAttachmentName(att.filename || `photo-${i}.jpg`);
                const storagePath = `pending/${submissionId}/${i}-${safeName}`;
                const { error: upErr } = await supabaseAdmin.storage
                    .from('listing-photos')
                    .upload(storagePath, Buffer.from(fileRes.data), {
                        contentType: att.contentType,
                        upsert: false
                    });
                if (upErr) throw upErr;
                const { data: urlData } = supabaseAdmin.storage.from('listing-photos').getPublicUrl(storagePath);
                storedPhotos.push({ url: urlData.publicUrl, filename: att.filename || null, sizeBytes: att.sizeBytes || null });
            } catch (attErr) {
                console.error(`Inbound application: attachment ${i} failed:`, attErr.message);
            }
        }

        if (storedPhotos.length) {
            await supabaseAdmin.from('pending_submissions')
                .update({ photos: storedPhotos })
                .eq('id', submissionId);
        }

        await logEvent('inbound_application_parsed', {
            submissionId, listingId, matchMethod, extractionMethod,
            photosStored: storedPhotos.length, photosTotal: attachments.length
        });
        console.log(`📩 Inbound application #${submissionId} parsed — listing ${listingId || 'UNMATCHED'}, ${extractionMethod || 'NO DESCRIPTION'}, ${storedPhotos.length}/${attachments.length} photos`);
    } catch (err) {
        console.error('Inbound application processing error:', err.message);
        // Fall back to raw capture so the submission isn't lost entirely — grab
        // subject/sender defensively (so the admin has something to go on
        // without opening raw_payload) and store the actual error message, so
        // a future failure is diagnosable from the database alone instead of
        // needing server logs nobody here can reach.
        let fallbackSubject = null, fallbackSender = null;
        try {
            fallbackSubject = req.body?.data?.subject || null;
            fallbackSender  = req.body?.data?.from || null;
        } catch (_) { /* ignore — payload shape unexpected */ }
        try {
            await supabaseAdmin.from('pending_submissions').insert({
                raw_payload: req.body,
                status: 'raw_unparsed',
                subject: fallbackSubject,
                sender_email: fallbackSender,
                reviewer_notes: `Auto-capture error: ${err.message}`
            });
        } catch (fallbackErr) {
            console.error('Inbound application fallback capture also failed:', fallbackErr.message);
        }
    }
});

// ── Admin: hasslefree-trial submission review ─────────────────────────────────
// Lists every pending_submissions row (any status), enriched with the current
// name/membership status of whatever listing it's matched to, if any.
app.get('/api/admin/pending-submissions', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('pending_submissions')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const listingIds = [...new Set((data || []).filter(s => s.listing_id).map(s => s.listing_id))];
    let listingsById = {};
    if (listingIds.length) {
        const { data: listings } = await supabaseAdmin
            .from('listings')
            .select('id, name, is_member, is_trial, membership_paid_until')
            .in('id', listingIds);
        listingsById = Object.fromEntries((listings || []).map(l => [l.id, l]));
    }
    res.json((data || []).map(s => ({ ...s, listing: s.listing_id ? (listingsById[s.listing_id] || null) : null })));
});

// Translates a single listing description field into whichever language is
// missing. Same forced tool-use pattern as the blog's translate endpoint, but
// scoped to one plain-text field instead of a full HTML post body.
async function translateListingDescription(sourceText, sourceLang) {
    if (!sourceText) return null;
    const targetField = sourceLang === 'en' ? 'description_es' : 'description_en';
    const targetLangName = sourceLang === 'en' ? 'natural Panama Spanish' : 'natural English';
    const TOOL = {
        name: 'save_description_translation',
        description: 'Save the translated short-term-rental property description.',
        input_schema: {
            type: 'object',
            properties: { translated_text: { type: 'string' } },
            required: ['translated_text']
        }
    };
    const prompt = `Translate the following short-term rental property description into ${targetLangName}, for a listing on Trusted Panama Stays (trustedpanamastays.com). Keep it natural, welcoming, and similar in length to the original — this is marketing copy for travelers, not a literal word-for-word translation. Call the save_description_translation tool with only the translated text, no extra commentary.

DESCRIPTION:
${sourceText}`;
    try {
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-5',
            max_tokens: 2000,
            thinking: { type: 'disabled' },
            tools: [TOOL],
            tool_choice: { type: 'tool', name: 'save_description_translation' },
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
        }, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            timeout: 30000
        });
        const toolBlock = (response.data.content || []).find(b => b.type === 'tool_use' && b.name === 'save_description_translation');
        if (!toolBlock || !toolBlock.input?.translated_text) return null;
        return { [targetField]: toolBlock.input.translated_text };
    } catch (err) {
        console.error('translateListingDescription error:', err.message);
        return null;
    }
}

// Simple welcome-back email for a RETURNING member being reactivated — no new
// password is generated or shown (they already have one; member_password only
// ever holds a bcrypt hash, so an existing plaintext password can't be
// recovered here to redisplay — reset-password.html covers that case).
function reactivationEmailHtml(propertyName, contactName, listingId, paidUntil) {
    const listingUrl = 'https://trustedpanamastays.com/listing.html?id=' + listingId + '&lang=es';
    const hdr = '<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;"><h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1></div>';
    const ftr = '<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;"><p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>';
    return '<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">' + hdr +
        '<p>Estimado/a <strong>' + (contactName || 'propietario/a') + '</strong>,</p>' +
        '<p>Su membresía de prueba para <strong>' + propertyName + '</strong> ha sido reactivada y está activa hasta el <strong>' + paidUntil + '</strong>.</p>' +
        '<p>Puede iniciar sesión con su contraseña existente aquí: <a href="' + listingUrl + '">' + listingUrl + '</a>. Si no la recuerda, use la opción de recuperar contraseña en esa misma página.</p>' +
        '<p>Preguntas? <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>' + ftr + '</body></html>';
}

function trialSubmissionDenialEmailHtml(reason) {
    const hdr = '<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;"><h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1></div>';
    const ftr = '<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;"><p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>';
    return '<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">' + hdr +
        '<p>Estimado/a propietario/a,</p>' +
        '<p>Gracias por su interés en Trusted Panama Stays. Por el momento no podemos activar su membresía de prueba' + (reason ? ': <strong>' + reason + '</strong>' : '.') + '</p>' +
        '<p>Si desea volver a intentarlo, puede responder a este correo o visitar <a href="https://trustedpanamastays.com/join.html">join.html</a>.</p>' +
        '<p>Preguntas? <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>' + ftr + '</body></html>';
}

// ── Admin: approve a hasslefree-trial email submission ────────────────────────
// listing_id / description_text in the body override the auto-detected values
// — the admin panel always sends the current contents of those two editable
// fields, whether or not they were changed, so this also fixes a bad auto-match
// or a mis-parsed description as part of approving.
app.post('/api/admin/pending-submissions/:id/approve', requireAdmin, async (req, res) => {
    const submissionId = parseInt(req.params.id);
    const { listing_id, description_text } = req.body;

    const { data: submission, error: subErr } = await supabaseAdmin
        .from('pending_submissions').select('*').eq('id', submissionId).single();
    if (subErr || !submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status === 'approved' || submission.status === 'denied') {
        return res.status(400).json({ error: 'This submission was already reviewed' });
    }

    const listingId = parseInt(listing_id) || submission.listing_id;
    if (!listingId) return res.status(400).json({ error: 'No listing ID — enter one before approving' });

    const { data: listing, error: listErr } = await supabaseAdmin
        .from('listings').select('*').eq('id', listingId).single();
    if (listErr || !listing) return res.status(404).json({ error: 'No listing found with ID ' + listingId });

    try {
        const bcrypt = require('bcrypt');
        const isFirstTime = !listing.member_password;
        let password = null;

        const paidUntil = new Date();
        paidUntil.setDate(paidUntil.getDate() + 30);
        const paidUntilStr = paidUntil.toISOString().split('T')[0];

        const updates = {
            is_member: true, is_trial: true,
            trial_started_at: new Date().toISOString(),
            membership_paid_until: paidUntilStr,
            invitation_status: 'member'
        };

        // Photos: append newly-submitted ones, never remove what's already there
        // — an existing member's photos are untouched if this submission has none.
        const newUrls = (submission.photos || []).map(p => p.url).filter(Boolean);
        if (newUrls.length) {
            const existing = Array.isArray(listing.photos) ? listing.photos : [];
            updates.photos = [...existing, ...newUrls.filter(u => !existing.includes(u))];
        }

        const finalDescription = (description_text !== undefined ? description_text : submission.description_text) || null;
        const descLang = submission.detected_lang === 'en' ? 'en' : 'es'; // default es if undetected
        if (finalDescription) {
            updates[descLang === 'en' ? 'description_en' : 'description_es'] = finalDescription;
        }

        if (isFirstTime) {
            const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
            password = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
            updates.member_password = await bcrypt.hash(password, 10);
        }

        const { data: updatedListing, error: updateErr } = await supabaseAdmin
            .from('listings').update(updates).eq('id', listingId).select().single();
        if (updateErr) throw updateErr;

        // Auto-translate into whichever language is still missing, if we now
        // have exactly one of the two description fields filled in.
        if (finalDescription) {
            const haveEn = !!updatedListing.description_en;
            const haveEs = !!updatedListing.description_es;
            if (haveEn !== haveEs) {
                const translated = await translateListingDescription(finalDescription, descLang);
                if (translated) await supabaseAdmin.from('listings').update(translated).eq('id', listingId);
            }
        }

        await supabaseAdmin.from('pending_submissions').update({
            status: 'approved', reviewed_at: new Date().toISOString(), listing_id: listingId
        }).eq('id', submissionId);

        let emailSent = false;
        const toEmail = updatedListing.email_member || updatedListing.email || submission.sender_email;
        if (toEmail && toEmail.includes('@')) {
            const notifyPath = path.join(__dirname, 'public', 'notify.php');
            const emailHtml = password
                ? generateEmailHtml({ property_name: updatedListing.name, contact_name: updatedListing.contact_name, listing_id: listingId }, 'approved_trial', password, paidUntilStr)
                : reactivationEmailHtml(updatedListing.name, updatedListing.contact_name, listingId, paidUntilStr);
            try {
                await execFileAsync('php', [notifyPath, 'Membresía de prueba activada — ' + updatedListing.name, emailHtml, toEmail, 'info@trustedpanamastays.com', 'Trusted Panama Stays', 'info@trustedpanamastays.com'], { timeout: 15000 });
                emailSent = true;
            } catch (mailErr) { console.error('Trial submission approval email failed:', mailErr.message); }
        }

        await recalculateFeatureRanks();
        await logEvent('pending_submission_approved', { submission_id: submissionId, listing_id: listingId, first_time_member: isFirstTime });
        res.json({ success: true, listing_id: listingId, password, email_sent: emailSent });
    } catch (err) {
        console.error('Approve pending submission error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Admin: deny a hasslefree-trial email submission ───────────────────────────
app.post('/api/admin/pending-submissions/:id/deny', requireAdmin, async (req, res) => {
    const submissionId = parseInt(req.params.id);
    const { reason } = req.body;

    const { data: submission, error: subErr } = await supabaseAdmin
        .from('pending_submissions').select('*').eq('id', submissionId).single();
    if (subErr || !submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status === 'approved' || submission.status === 'denied') {
        return res.status(400).json({ error: 'This submission was already reviewed' });
    }

    await supabaseAdmin.from('pending_submissions').update({
        status: 'denied', reviewed_at: new Date().toISOString(), reviewer_notes: reason || null
    }).eq('id', submissionId);

    let emailSent = false;
    if (submission.sender_email && submission.sender_email.includes('@')) {
        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        try {
            await execFileAsync('php', [notifyPath, 'Sobre su solicitud — Trusted Panama Stays', trialSubmissionDenialEmailHtml(reason), submission.sender_email, 'info@trustedpanamastays.com', 'Trusted Panama Stays', 'info@trustedpanamastays.com'], { timeout: 15000 });
            emailSent = true;
        } catch (mailErr) { console.error('Trial submission denial email failed:', mailErr.message); }
    }

    await logEvent('pending_submission_denied', { submission_id: submissionId, reason: reason || null });
    res.json({ success: true, email_sent: emailSent });
});

// ═════════════════════════════════════════════════════════════════════════════
//  BLOG
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/blog/posts — public, published only ──────────────────────────────
app.get('/api/blog/posts', async (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'es';
    const { data, error } = await supabase
        .from('blog_posts')
        .select(`id, slug, title_${lang}, excerpt_${lang}, meta_description_${lang}, featured_image_url, category, author, published_at`)
        .eq('status', 'published')
        .order('published_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── GET /api/blog/post/:slug — public, published only ─────────────────────────
app.get('/api/blog/post/:slug', async (req, res) => {
    const { data, error } = await supabase
        .from('blog_posts')
        .select('*')
        .eq('slug', req.params.slug)
        .eq('status', 'published')
        .single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
});

// ── GET /api/admin/blog/pending — drafts awaiting review ──────────────────────
app.get('/api/admin/blog/pending', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('blog_posts')
        .select('*')
        .eq('status', 'pending_review')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── GET /api/admin/blog/all — every post, any status ───────────────────────────
app.get('/api/admin/blog/all', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('blog_posts')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── POST /api/admin/blog/:id/edit — admin edits a draft before approving ──────
app.post('/api/admin/blog/:id/edit', requireAdmin, async (req, res) => {
    const { title_en, title_es, excerpt_en, excerpt_es, body_en, body_es,
            meta_description_en, meta_description_es, featured_image_url, category, slug } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (title_en !== undefined) updates.title_en = title_en;
    if (title_es !== undefined) updates.title_es = title_es;
    if (excerpt_en !== undefined) updates.excerpt_en = excerpt_en;
    if (excerpt_es !== undefined) updates.excerpt_es = excerpt_es;
    if (body_en !== undefined) updates.body_en = body_en;
    if (body_es !== undefined) updates.body_es = body_es;
    if (meta_description_en !== undefined) updates.meta_description_en = meta_description_en;
    if (meta_description_es !== undefined) updates.meta_description_es = meta_description_es;
    if (featured_image_url !== undefined) updates.featured_image_url = featured_image_url;
    if (category !== undefined) updates.category = category;
    if (slug !== undefined) updates.slug = slug;
    const { error } = await supabaseAdmin.from('blog_posts').update(updates).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_post_edited', { id: req.params.id });
    res.json({ success: true });
});

// ── POST /api/admin/blog/:id/approve ───────────────────────────────────────────
app.post('/api/admin/blog/:id/approve', requireAdmin, async (req, res) => {
    const { error } = await supabaseAdmin.from('blog_posts').update({
        status: 'published',
        published_at: new Date().toISOString()
    }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_post_approved', { id: req.params.id });
    res.json({ success: true });
});

// ── POST /api/admin/blog/:id/reject ────────────────────────────────────────────
app.post('/api/admin/blog/:id/reject', requireAdmin, async (req, res) => {
    const { error } = await supabaseAdmin.from('blog_posts').update({ status: 'rejected' }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_post_rejected', { id: req.params.id });
    res.json({ success: true });
});

// ── POST /api/admin/blog/:id/unpublish — take a live post back to draft ──────
app.post('/api/admin/blog/:id/unpublish', requireAdmin, async (req, res) => {
    const { error } = await supabaseAdmin.from('blog_posts').update({ status: 'pending_review', published_at: null }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_post_unpublished', { id: req.params.id });
    res.json({ success: true });
});

// ── POST /api/admin/blog/:id/delete ────────────────────────────────────────────
app.post('/api/admin/blog/:id/delete', requireAdmin, async (req, res) => {
    const { error } = await supabaseAdmin.from('blog_posts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_post_deleted', { id: req.params.id });
    res.json({ success: true });
});

// ── GET /api/admin/blog/:id/preview-link — mints a random one-time token, ────
// stored in blog_preview_tokens (valid 24h). blog-post.php checks it by
// querying Supabase directly — no self-referencing HTTPS call back into
// this same Node app, which was unreliable on shared hosting.
app.get('/api/admin/blog/:id/preview-link', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin.from('blog_posts').select('id, slug').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    const token = require('crypto').randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error: insertErr } = await supabaseAdmin.from('blog_preview_tokens').insert({
        post_id: data.id, token, expires_at: expiresAt
    });
    if (insertErr) return res.status(500).json({ error: 'Could not create preview link: ' + insertErr.message });
    res.json({
        url_en: `https://trustedpanamastays.com/blog-post.php?slug=${encodeURIComponent(data.slug)}&preview=${encodeURIComponent(token)}`,
        url_es: `https://trustedpanamastays.com/blog-post.php?slug=${encodeURIComponent(data.slug)}&lang=es&preview=${encodeURIComponent(token)}`
    });
});

// ── POST /api/admin/blog/material — save a raw idea (FB post, legal analysis, ──
// note) for later use, not tied to any specific post yet.
app.post('/api/admin/blog/material', requireAdmin, async (req, res) => {
    const { title, content, source_type } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Missing content' });
    const { data, error } = await supabaseAdmin.from('blog_source_material').insert({
        title: title || null,
        content: content.trim(),
        source_type: source_type || 'note'
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_material_added', { id: data.id, source_type: data.source_type });
    res.json({ success: true, material: data });
});

// ── GET /api/admin/blog/material — list everything, unused first ─────────────
app.get('/api/admin/blog/material', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('blog_source_material')
        .select('*')
        .order('used', { ascending: true })
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── POST /api/admin/blog/material/:id/delete ──────────────────────────────────
app.post('/api/admin/blog/material/:id/delete', requireAdmin, async (req, res) => {
    const { error } = await supabaseAdmin.from('blog_source_material').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── POST /api/admin/blog/material/:id/edit — update a saved material item ────
app.post('/api/admin/blog/material/:id/edit', requireAdmin, async (req, res) => {
    const { title, content, source_type } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Missing content' });
    const { data, error } = await supabaseAdmin.from('blog_source_material').update({
        title: title || null,
        content: content.trim(),
        source_type: source_type || 'note'
    }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_material_edited', { id: data.id, source_type: data.source_type });
    res.json({ success: true, material: data });
});

// ── POST /api/admin/blog/knowledge — add PERMANENT reference material (law ──
// texts, your write-ups, corrected post examples). Unlike Material Bank, these
// are never marked "used" — every future draft is grounded in ALL of them.
app.post('/api/admin/blog/knowledge', requireAdmin, async (req, res) => {
    const { title, content, category } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Missing content' });
    const { data, error } = await supabaseAdmin.from('blog_knowledge_base').insert({
        title: title || null,
        content: content.trim(),
        category: category || 'reference'
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_knowledge_added', { id: data.id, category: data.category });
    res.json({ success: true, knowledge: data });
});

// ── GET /api/admin/blog/knowledge ─────────────────────────────────────────────
app.get('/api/admin/blog/knowledge', requireAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from('blog_knowledge_base')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── POST /api/admin/blog/knowledge/:id/delete ─────────────────────────────────
app.post('/api/admin/blog/knowledge/:id/delete', requireAdmin, async (req, res) => {
    const { error } = await supabaseAdmin.from('blog_knowledge_base').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── POST /api/admin/blog/knowledge/:id/edit — update a saved knowledge item ──
app.post('/api/admin/blog/knowledge/:id/edit', requireAdmin, async (req, res) => {
    const { title, content, category } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Missing content' });
    const { data, error } = await supabaseAdmin.from('blog_knowledge_base').update({
        title: title || null,
        content: content.trim(),
        category: category || 'reference'
    }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('blog_knowledge_edited', { id: data.id, category: data.category });
    res.json({ success: true, knowledge: data });
});

// ── POST /api/admin/blog/generate-series — kicks off series generation and ───
// returns immediately with a job id; the actual 1-3 minute AI call runs in
// the background. A synchronous version reliably got killed by Hostinger's
// reverse-proxy timeout on long requests, leaving the browser with a
// meaningless "Request failed" even when generation succeeded server-side.
app.post('/api/admin/blog/generate-series', requireAdmin, async (req, res) => {
    const seedText = req.body?.seed_text;
    if (!seedText || !seedText.trim()) return res.status(400).json({ error: 'Missing seed_text' });
    const { data: job, error: jobErr } = await supabaseAdmin.from('blog_series_jobs').insert({ status: 'running' }).select().single();
    if (jobErr) return res.status(500).json({ error: jobErr.message });
    res.json({ success: true, job_id: job.id });

    generateBlogSeries(seedText).then(async (chapters) => {
        await supabaseAdmin.from('blog_series_jobs').update({
            status: 'done',
            chapter_ids: chapters.map(c => c.id),
            chapter_count: chapters.length,
            finished_at: new Date().toISOString()
        }).eq('id', job.id);
    }).catch(async (err) => {
        console.error('Blog series generation error:', err.message);
        await supabaseAdmin.from('blog_series_jobs').update({
            status: 'error',
            error_message: err.message,
            finished_at: new Date().toISOString()
        }).eq('id', job.id);
    });
});

// ── GET /api/admin/blog/generate-series/:jobId/status — polled by the admin ──
// panel every few seconds while a series job runs in the background.
app.get('/api/admin/blog/generate-series/:jobId/status', requireAdmin, async (req, res) => {
    const { data: job, error } = await supabaseAdmin.from('blog_series_jobs').select('*').eq('id', req.params.jobId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true, job });
});

// ── Rotating topic list for AI-proposed posts. Editable here — no DB needed ────
// for something this simple; expand freely as ideas come up.
const BLOG_TOPIC_IDEAS = [
    'Why booking an ATP-registered rental protects tourists legally and financially',
    'How to verify a short-term rental is legally registered in Panama',
    'The difference between ATP and MiCI registration for Panama rentals',
    'What Panama\'s tourism authority requires from legal short-term rental hosts',
    'Seasonal travel guide: best times to visit Panama\'s different regions',
    'Common scams to avoid when booking accommodation in Panama',
    'What documents a legitimate Panama rental host should be able to show you',
    'Boquete vs. Bocas del Toro vs. Panama City: choosing where to stay'
];

// ── Generates one bilingual blog post via the Anthropic API. If seedText is ───
// provided, the post is built from the user's own notes/concept explanation
// instead of an AI-chosen topic. Always lands as 'pending_review' — never
// auto-publishes, per the current human-approval workflow.
// 2026-08-15: switched from "ask for JSON in prose, regex-strip fences, then
// JSON.parse" (fragile — a stray unescaped quote or a mid-generation cutoff
// in ~1500 words of bilingual HTML silently broke JSON.parse with an
// unreadable error) to a forced tool call, which guarantees a structurally
// valid object back from the API. Also now flags a token-limit cutoff
// explicitly and surfaces the real Anthropic API error body instead of
// axios's generic status-code message.
async function generateBlogDraft(seedText) {
    let mode = seedText ? 'seed' : 'topic';
    let materialUsed = null;
    if (!seedText) {
        const { data: material } = await supabaseAdmin
            .from('blog_source_material')
            .select('*')
            .eq('used', false)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();
        if (material) {
            seedText = material.content;
            materialUsed = material;
            mode = 'material';
        }
    }
    const topic = seedText || BLOG_TOPIC_IDEAS[Math.floor(Math.random() * BLOG_TOPIC_IDEAS.length)];
    const { data: knowledgeRows } = await supabaseAdmin
        .from('blog_knowledge_base')
        .select('title, content, category')
        .order('created_at', { ascending: true });
    const knowledgeBlock = (knowledgeRows && knowledgeRows.length)
        ? knowledgeRows.map(k => `[${k.category || 'reference'}] ${k.title || '(untitled)'}\n${k.content}`).join('\n\n---\n\n')
        : null;
    const prompt = `You are writing a blog post for Trusted Panama Stays, a directory of legally ATP/MiCI-registered short-term rentals in Panama (trustedpanamastays.com). The audience is international tourists researching where to stay in Panama, plus Panama property owners considering registering their rental legally.
${knowledgeBlock ? `REFERENCE MATERIAL — verified, owner-provided knowledge about Panama's actual laws and regulations. Ground every legal or factual claim in this material. Do NOT state specific legal requirements, law numbers, deadlines, fees, or procedures unless explicitly supported below — if something legal isn't covered here, omit it or phrase it generally (e.g. "consult a lawyer for current requirements") rather than inventing specifics:\n\n"""${knowledgeBlock}"""\n\n` : ''}${seedText
    ? `Turn the following rough notes/concept explanation into a polished, well-structured blog post. Preserve the author's intent and any factual specifics — do not invent facts they didn't provide:\n\n"""${seedText}"""`
    : `Write an original blog post on this topic: "${topic}"`}
Requirements:
- Write in ENGLISH ONLY for now — a Spanish version is translated separately later, after this English version has been reviewed/edited
- Structure: use <h2>/<h3> for section headings (NEVER <h1>, that's reserved for the title), <p> paragraphs, <ul>/<ol> only where a list is genuinely clearer than prose
- Where natural, include ONE internal link back to the directory: <a href="/index.php">our directory</a> — don't force it if it doesn't fit
- No inline styling — plain semantic HTML only
- Tone: helpful, credible, not salesy
- Be conservative with legal specifics not covered by the reference material above — general guidance and "consult a professional" framing is safer than a confident but unverified legal claim
- Length: 500-900 words
When finished, call the save_blog_post tool with the completed draft — do not include any other prose.`;

    const BLOG_POST_TOOL = {
        name: 'save_blog_post',
        description: 'Save the completed English blog post draft.',
        input_schema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'URL-friendly slug in English' },
                title_en: { type: 'string' },
                excerpt_en: { type: 'string', description: 'One sentence, under 25 words' },
                meta_description_en: { type: 'string', description: 'Under 155 characters' },
                body_en: { type: 'string', description: 'HTML: h2/h3/p/ul/ol only, never h1' },
                category: { type: 'string', description: 'One or two words, e.g. Legal Compliance, Travel Guide, Area Guide' }
            },
            required: ['slug', 'title_en', 'excerpt_en', 'meta_description_en', 'body_en']
        }
    };

    let response;
    try {
        response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-5',
            max_tokens: 8000,
            thinking: { type: 'disabled' },
            tools: [BLOG_POST_TOOL],
            tool_choice: { type: 'tool', name: 'save_blog_post' },
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
        }, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            timeout: 60000
        });
    } catch (axiosErr) {
        const apiMsg = axiosErr.response?.data?.error?.message || axiosErr.message;
        throw new Error('Anthropic API call failed: ' + apiMsg);
    }

    if (response.data.stop_reason === 'max_tokens') {
        throw new Error('The AI response was cut off before finishing (hit the token limit) — try shorter/more focused notes and generate again.');
    }
    const toolBlock = (response.data.content || []).find(b => b.type === 'tool_use' && b.name === 'save_blog_post');
    if (!toolBlock || !toolBlock.input) {
        throw new Error('Claude did not return the expected draft. stop_reason=' + response.data.stop_reason + ' — ' + JSON.stringify(response.data.content).slice(0, 400));
    }
    const draft = toolBlock.input;

    const baseSlug = (draft.slug || draft.title_en).toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const { data: conflict } = await supabaseAdmin.from('blog_posts').select('id').eq('slug', baseSlug).maybeSingle();
    const finalSlug = conflict ? `${baseSlug}-${Date.now()}` : baseSlug;
    const { data: inserted, error } = await supabaseAdmin.from('blog_posts').insert({
        slug: finalSlug,
        title_en: draft.title_en,
        excerpt_en: draft.excerpt_en,
        meta_description_en: draft.meta_description_en,
        body_en: draft.body_en,
        category: draft.category || null,
        status: 'pending_review',
        ai_generated: true
    }).select().single();
    if (error) throw new Error(error.message);
    if (materialUsed) {
        await supabaseAdmin.from('blog_source_material')
            .update({ used: true, used_in_post_id: inserted.id })
            .eq('id', materialUsed.id);
    }
    await logEvent('blog_draft_generated', {
        id: inserted.id, mode,
        topic: mode === 'topic' ? topic : null,
        material_id: materialUsed?.id || null,
        knowledge_entries_used: knowledgeRows?.length || 0
    });
    return inserted;
}


// ── POST /api/admin/blog/generate-draft ────────────────────────────────────────
// Called from the admin panel ("Generate topic idea" or "Generate from my notes")
// AND from the weekly GitHub Actions cron (shared secret, same pattern as /api/reload-pdf).
app.post('/api/admin/blog/generate-draft', async (req, res) => {
    const bearer = req.headers['authorization']?.replace('Bearer ', '');
    let isAdminToken = false;
    if (bearer) {
        try { isAdminToken = Buffer.from(bearer, 'base64').toString().split(':')[0] === 'admin'; } catch {}
    }
    const isCronSecret = req.body?.secret && req.body.secret === process.env.ADMIN_SECRET;
    if (!isAdminToken && !isCronSecret) return res.status(403).json({ error: 'Denied' });

    try {
        const draft = await generateBlogDraft(req.body?.seed_text || null);
        res.json({ success: true, draft });
    } catch (err) {
        console.error('Blog draft generation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Writes an entire bilingual multi-chapter blog series in a single ─────────
// Anthropic call, grounded in the Knowledge Base same as generateBlogDraft().
// One call (not N independent ones) so chapters actually reference each other
// and read as a continuing story instead of repeating the same ground.
async function generateBlogSeries(seedText, jobId) {
    const { data: knowledgeRows } = await supabaseAdmin
        .from('blog_knowledge_base')
        .select('title, content, category')
        .order('created_at', { ascending: true });
    const knowledgeBlock = (knowledgeRows && knowledgeRows.length)
        ? knowledgeRows.map(k => `[${k.category || 'reference'}] ${k.title || '(untitled)'}\n${k.content}`).join('\n\n---\n\n')
        : null;

    const planPrompt = `You are planning a multi-part blog SERIES for Trusted Panama Stays (trustedpanamastays.com), a directory of legally ATP/MiCI-registered short-term rentals in Panama.
${knowledgeBlock ? `REFERENCE MATERIAL — ground the plan in this, don't invent facts it doesn't support:\n\n"""${knowledgeBlock}"""\n\n` : ''}Here is the author's brief:

"""${seedText}"""

Break this into a sequence of chapters that will each become a separate blog post, telling one continuing story (if the brief suggests a range like "5 or 6", pick whichever fits the material better). For each chapter, give an English title (prefixed "Part X of N: ") and a 2-3 sentence internal angle/summary describing exactly what that chapter should cover and how it connects to the chapter before it — this angle is a writing plan, it will not be published. Spanish translation happens separately later, after each English chapter has been reviewed — don't produce Spanish here.
Call the plan_blog_series tool with the full plan.`;

    const PLAN_TOOL = {
        name: 'plan_blog_series',
        description: 'Save the chapter-by-chapter plan for a blog series (English title + internal angle, no body text yet).',
        input_schema: {
            type: 'object',
            properties: {
                chapters: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            title_en: { type: 'string' },
                            angle: { type: 'string', description: 'Internal writing brief for this chapter — not published' }
                        },
                        required: ['title_en', 'angle']
                    }
                }
            },
            required: ['chapters']
        }
    };

    let planResponse;
    try {
        planResponse = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-5',
            max_tokens: 3000,
            thinking: { type: 'disabled' },
            tools: [PLAN_TOOL],
            tool_choice: { type: 'tool', name: 'plan_blog_series' },
            messages: [{ role: 'user', content: [{ type: 'text', text: planPrompt }] }]
        }, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            timeout: 60000
        });
    } catch (axiosErr) {
        const apiMsg = axiosErr.response?.data?.error?.message || axiosErr.message;
        throw new Error('Anthropic API call (planning) failed: ' + apiMsg);
    }
    const planBlock = (planResponse.data.content || []).find(b => b.type === 'tool_use' && b.name === 'plan_blog_series');
    let planChapters = planBlock?.input?.chapters;
    if (typeof planChapters === 'string') {
        // Occasionally comes back as a JSON-encoded string instead of a
        // native array (sometimes double-wrapped as {"chapters":[...]}
        // inside that string) — unwrap defensively instead of failing.
        try {
            const parsed = JSON.parse(planChapters);
            planChapters = Array.isArray(parsed) ? parsed : parsed.chapters;
        } catch (e) {
            planChapters = null;
        }
    }
    if (!planBlock || !Array.isArray(planChapters) || !planChapters.length) {
        throw new Error('Claude did not return a series plan. stop_reason=' + planResponse.data.stop_reason + ' — raw content: ' + JSON.stringify(planResponse.data.content).slice(0, 800));
    }
    const plan = planChapters;
    const total = plan.length;

    const CHAPTER_TOOL = {
        name: 'save_blog_chapter',
        description: 'Save this one chapter of the series as a complete English post.',
        input_schema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'URL-friendly slug in English' },
                excerpt_en: { type: 'string', description: 'One sentence, under 25 words' },
                meta_description_en: { type: 'string', description: 'Under 155 characters' },
                body_en: { type: 'string', description: 'HTML: h2/h3/p/ul/ol only, never h1' },
                category: { type: 'string', description: 'Same category label for every chapter in this series' }
            },
            required: ['slug', 'excerpt_en', 'meta_description_en', 'body_en']
        }
    };

    const inserted = [];
    const priorChaptersText = [];
    for (let i = 0; i < plan.length; i++) {
        const ch = plan[i];
        const priorBlock = priorChaptersText.length
            ? `PREVIOUSLY PUBLISHED CHAPTERS IN THIS SERIES (for continuity — reference them where natural, don't repeat what they already covered):\n\n${priorChaptersText.join('\n\n===\n\n')}\n\n`
            : '';
        const outlineBlock = plan.map((c, idx) => `${idx + 1}. ${c.title_en} — ${c.angle}`).join('\n');
        const chapterPrompt = `You are writing chapter ${i + 1} of ${total} in a blog series for Trusted Panama Stays (trustedpanamastays.com), a directory of legally ATP/MiCI-registered short-term rentals in Panama. Audience: international tourists researching where to stay in Panama, plus Panama property owners considering registering their rental legally.
${knowledgeBlock ? `REFERENCE MATERIAL — ground every legal/factual claim in this, don't invent specifics it doesn't support:\n\n"""${knowledgeBlock}"""\n\n` : ''}FULL SERIES OUTLINE (for context — you are only writing chapter ${i + 1} now):
${outlineBlock}

${priorBlock}THIS CHAPTER'S TITLE AND ANGLE:
Title: ${ch.title_en}
Angle: ${ch.angle}

Requirements:
- Write ONLY this chapter, in ENGLISH ONLY — Spanish is translated separately later, after review
- Use the title given above EXACTLY as title_en
- Structure: <h2>/<h3> for section headings (NEVER <h1>), <p> paragraphs, <ul>/<ol> only where genuinely clearer than prose
- Where natural, include ONE internal link back to the directory: <a href="/index.php">our directory</a> — don't force it if it doesn't fit
- No inline styling — plain semantic HTML only
- Tone: helpful, credible, narrative and engaging — intrigue readers into the next part, never invent facts
- Be conservative with legal specifics not covered by the reference material — general guidance and "consult a professional" framing is safer than an unverified legal claim
- Length: 500-900 words
- If earlier chapters were shown above, connect to them naturally — don't re-explain what they already covered
Call the save_blog_chapter tool with this chapter.`;

        let response;
        try {
            response = await axios.post('https://api.anthropic.com/v1/messages', {
                model: 'claude-sonnet-5',
                max_tokens: 8000,
                thinking: { type: 'disabled' },
                tools: [CHAPTER_TOOL],
                tool_choice: { type: 'tool', name: 'save_blog_chapter' },
                messages: [{ role: 'user', content: [{ type: 'text', text: chapterPrompt }] }]
            }, {
                headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
                timeout: 60000
            });
        } catch (axiosErr) {
            const apiMsg = axiosErr.response?.data?.error?.message || axiosErr.message;
            throw new Error(`Anthropic API call for chapter ${i + 1} failed: ${apiMsg} (${inserted.length} chapter(s) already saved)`);
        }
        if (response.data.stop_reason === 'max_tokens') {
            throw new Error(`Chapter ${i + 1} was cut off before finishing (hit the token limit) (${inserted.length} chapter(s) already saved)`);
        }
        const toolBlock = (response.data.content || []).find(b => b.type === 'tool_use' && b.name === 'save_blog_chapter');
        if (!toolBlock || !toolBlock.input) {
            throw new Error(`Chapter ${i + 1}: Claude did not return the expected content (${inserted.length} chapter(s) already saved)`);
        }
        const draft = toolBlock.input;

        const baseSlug = (draft.slug || ch.title_en).toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const { data: conflict } = await supabaseAdmin.from('blog_posts').select('id').eq('slug', baseSlug).maybeSingle();
        const finalSlug = conflict ? `${baseSlug}-${Date.now()}-${i}` : baseSlug;
        const { data: row, error } = await supabaseAdmin.from('blog_posts').insert({
            slug: finalSlug,
            title_en: ch.title_en,
            excerpt_en: draft.excerpt_en,
            meta_description_en: draft.meta_description_en,
            body_en: draft.body_en,
            category: draft.category || null,
            status: 'pending_review',
            ai_generated: true
        }).select().single();
        if (error) throw new Error(`Chapter ${i + 1} ("${ch.title_en}") failed to save: ${error.message} (${inserted.length} chapter(s) saved before this one)`);
        inserted.push(row);
        priorChaptersText.push(`[${ch.title_en}]\n${draft.body_en}`);

        if (jobId) await supabaseAdmin.from('blog_series_jobs').update({ chapter_count: inserted.length }).eq('id', jobId);
    }

    await logEvent('blog_series_generated', {
        ids: inserted.map(r => r.id),
        count: inserted.length,
        knowledge_entries_used: knowledgeRows?.length || 0
    });
    return inserted;
}

// ── POST /api/admin/blog/:id/translate — translates the CURRENT English ──────
// fields into Spanish and saves them. Fetches fresh from the DB (not the
// request body) so it always reflects the latest saved English edits, not
// whatever was originally generated. Overwrites any existing Spanish fields
// — the admin panel confirms before calling this if Spanish already exists.
app.post('/api/admin/blog/:id/translate', requireAdmin, async (req, res) => {
    const { data: post, error: fetchErr } = await supabaseAdmin.from('blog_posts')
        .select('title_en, excerpt_en, meta_description_en, body_en')
        .eq('id', req.params.id).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!post.title_en || !post.body_en) return res.status(400).json({ error: 'English version is incomplete — nothing to translate' });

    const TRANSLATE_TOOL = {
        name: 'save_translation',
        description: 'Save the Panama Spanish translation of this blog post.',
        input_schema: {
            type: 'object',
            properties: {
                title_es: { type: 'string' },
                excerpt_es: { type: 'string' },
                meta_description_es: { type: 'string' },
                body_es: { type: 'string', description: 'Same HTML structure/tags as the English body, translated' }
            },
            required: ['title_es', 'excerpt_es', 'meta_description_es', 'body_es']
        }
    };
    const prompt = `Translate the following blog post from English into natural Panama Spanish (the way a Panamanian reader would expect, not generic textbook Spanish) for Trusted Panama Stays (trustedpanamastays.com).
Preserve the HTML structure exactly — same tags, same paragraph breaks — only translate the text content, and change the internal directory link's href to "/index.php?lang=es" with natural Spanish link text ("nuestro directorio").
Do not include any quotation marks, delimiters, or labels in your translated output — the body_es field must start directly with the first HTML tag of the translated content, with nothing before it.
TITLE: ${post.title_en}
EXCERPT: ${post.excerpt_en}
META DESCRIPTION: ${post.meta_description_en}
BODY (translate only the content between the markers — do not include the markers themselves in your output):
===BODY_START===
${post.body_en}
===BODY_END===
Call the save_translation tool with the translated fields.`;

    let response;
    try {
        response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-5',
            max_tokens: 8000,
            thinking: { type: 'disabled' },
            tools: [TRANSLATE_TOOL],
            tool_choice: { type: 'tool', name: 'save_translation' },
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
        }, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            timeout: 60000
        });
    } catch (axiosErr) {
        const apiMsg = axiosErr.response?.data?.error?.message || axiosErr.message;
        return res.status(500).json({ error: 'Anthropic API call failed: ' + apiMsg });
    }
    if (response.data.stop_reason === 'max_tokens') {
        return res.status(500).json({ error: 'Translation was cut off before finishing (hit the token limit).' });
    }
    const toolBlock = (response.data.content || []).find(b => b.type === 'tool_use' && b.name === 'save_translation');
    if (!toolBlock || !toolBlock.input) {
        return res.status(500).json({ error: 'Claude did not return the expected translation.' });
    }
    const t = toolBlock.input;
    const { data: updated, error: updateErr } = await supabaseAdmin.from('blog_posts').update({
        title_es: t.title_es, excerpt_es: t.excerpt_es, meta_description_es: t.meta_description_es, body_es: t.body_es
    }).eq('id', req.params.id).select().single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    await logEvent('blog_post_translated', { id: updated.id });
    res.json({ success: true, post: updated });
});

// ── GET /api/admin/blog/comments — list all comments, with post context ─────
app.get('/api/admin/blog/comments', requireAdmin, async (req, res) => {
    const { data: comments, error } = await supabaseAdmin.from('blog_comments')
        .select('*, blog_posts(title_en, slug)')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const enriched = (comments || []).map(c => ({ ...c, post: c.blog_posts || null }));
    res.json({ comments: enriched });
});

// ── POST /api/admin/blog/comments/:id/approve ─────────────────────────────────
app.post('/api/admin/blog/comments/:id/approve', requireAdmin, async (req, res) => {
    const { error } = await supabaseAdmin.from('blog_comments').update({
        status: 'approved', approved_at: new Date().toISOString()
    }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── DELETE /api/admin/blog/comments/:id ────────────────────────────────────────
app.delete('/api/admin/blog/comments/:id', requireAdmin, async (req, res) => {
    const { error } = await supabaseAdmin.from('blog_comments').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});


//========== temporary endpoints ============================

//==========================================================

// ── Global JSON error handler — safety net so a request-level error (e.g.
// body too large, malformed JSON) always comes back as JSON instead of
// Express's default HTML error page. Frontend code across admin.html calls
// res.json() unconditionally without checking res.ok first, so an HTML
// error page there fails as "Unexpected token '<'", which is confusing and
// hides the real error. Must stay registered after every route/middleware.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('Unhandled request error:', err.message);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Server error' });
});

const server = require('http').createServer({ maxHeaderSize: 81920 }, app);
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Main page: http://localhost:${PORT}`);
    console.log(`📍 Health:    http://localhost:${PORT}/health`);
});
