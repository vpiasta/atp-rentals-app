// TrustedPanamaStays.com - server.js
// Updated to use Supabase database:
//   - On startup: serve from DB immediately, check PDF URL in background
//   - Only re-parse PDF when ATP publishes a new one (URL changes)
// env refresh June 2026

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
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
app.use(express.json());
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

// Save all rentals to Supabase (replaces entire table content)
// This function was deleted because it erases all previous records

// Get the saved PDF URL from pdf_meta table
async function getSavedPdfUrl() {
    const { data, error } = await supabase
        .from('pdf_meta')
        .select('*')
        .limit(1)
        .single();
    if (error) return null;
    return data;   // { id, pdf_url, pdf_heading, last_updated }
}

// Update pdf_meta with the new URL
async function savePdfMeta(pdfUrl, pdfHeading) {
    // Try update first, then insert if no row exists
    const existing = await getSavedPdfUrl();
    if (existing) {
        const { error } = await supabase
            .from('pdf_meta')
            .update({ pdf_url: pdfUrl, pdf_heading: pdfHeading, last_updated: new Date().toISOString() })
            .eq('id', existing.id);
        if (error) throw error;
    } else {
        const { error } = await supabase
            .from('pdf_meta')
            .insert({ pdf_url: pdfUrl, pdf_heading: pdfHeading, last_updated: new Date().toISOString() });
        if (error) throw error;
    }
    console.log('✅ pdf_meta updated in Supabase');
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

// Background check: only re-parses PDF when the URL has changed
async function checkForPdfUpdate() {
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

        // URL has changed (or DB was empty) — re-parse the PDF
        console.log(`🆕 STEP 2: New PDF detected!`);
        console.log(`   Old: ${savedUrl}`);
        console.log(`   New: ${newUrl}`);

        // Temporarily set URL so parsePDFWithCoordinates picks it up
        PDF_URL = newUrl;
        PDF_HEADING = atpResult.headingText || PDF_HEADING;

        const result = await parsePDFWithCoordinates();
        if (result.success && PDF_RENTALS.length > 0) {
            // Save to database
            await saveListingsToDB(PDF_RENTALS);
            await savePdfMeta(newUrl, PDF_HEADING);

            // Update in-memory state
            CURRENT_RENTALS = PDF_RENTALS;
            DATA_SOURCE = 'atp-pdf';
            console.log(`✅ STEP 2: Database updated with ${PDF_RENTALS.length} listings from new PDF`);
            await checkPendingAtpApplications();
        }
    } catch (err) {
        console.error('❌ STEP 2: PDF update check failed:', err.message);
        // If we already have data from STEP 1, keep serving it — no problem
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
            const cleanName = normalize(app.property_name);
            // Get candidates from province, then filter by normalized name
            const { data: candidates } = await supabaseAdmin
                .from('listings')
                .select('id, name, province, is_member')
                .eq('province', app.province)
                .limit(100);
            const matches = (candidates || []).filter(l =>
                normalize(l.name).includes(cleanName.split(' ')[0]) ||
                cleanName.includes(normalize(l.name).split(' ')[0])
            ).slice(0, 3);

            if (!matches || matches.length === 0) {
                console.log(`⏳ No ATP match yet for: ${app.property_name}`);
                continue;
            }

            // Use best match (first result)
            const listing = matches[0];

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
<p>Su hospedaje <strong>${listing.name}</strong> acaba de aparecer en el registro oficial de la ATP, y hemos activado automáticamente su membresía de prueba gratuita.</p>
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
        const pdf = await pdfjsLib.getDocument(data).promise;
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
    const { search, province, type, keyword} = req.query;

    // Start from in-memory ATP data
    let filtered = [...CURRENT_RENTALS];

    // Apply filters to ATP listings
    if (search) {
        const s = search.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const words = s.split(/\s+/).filter(w => w.length >= 3);
        const normalize = str => (str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        // Score each listing
        const tokenize = str => (str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[\s@._\-\/]+/).filter(t => t.length > 0);
        const scored = filtered.map(r => {
            const n = normalize(r.name);
            const e = normalize(r.email||'');
            const p = normalize(r.phone||'');
            const v = normalize(r.province||'');
            const allTokens = [...tokenize(r.name), ...tokenize(r.email||''), ...tokenize(r.phone||''), ...tokenize(r.province||''), ...tokenize(r.address||'')];
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
    }
    if (province) filtered = filtered.filter(r => r.province === province);
    if (type)     filtered = filtered.filter(r => r.rental_type === type);

    // Enrich ATP listings with member data from database
    try {
        const ids = filtered.map(r => r.id).filter(Boolean);
        if (ids.length > 0) {
            const { data: memberData } = await supabase
                .from('listings')
                .select('id, phone_member, email_member, address, photos, is_member, membership_paid_until, slug, rental_type, apatel_member, feature_rank, listing_keywords')
                .in('id', ids);

            if (memberData && memberData.length > 0) {
                const memberMap = {};
                memberData.forEach(m => { memberMap[m.id] = m; });
                filtered = filtered.map(r => {
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
        }
    } catch (err) {
        console.error('Error enriching rentals with member data:', err.message);
    }

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
                  const e = normalize(r.email||'');
                  const p = normalize(r.phone||'');
                  const v = normalize(r.province||'');
                  const allTokens = [...tokenizeMici(r.name), ...tokenizeMici(r.email||''), ...tokenizeMici(r.phone||''), ...tokenizeMici(r.province||'')];
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

// Manual trigger to force a PDF re-check (useful for admin/testing)
app.post('/api/reload-pdf', async (req, res) => {
    try {
        console.log('🔄 Manual PDF reload triggered...');
        // Force re-check by temporarily clearing saved URL
        await supabase.from('pdf_meta').update({ pdf_url: 'force-reload' }).neq('id', 0);
        await checkForPdfUpdate();
        res.json({
            success: true,
            dataSource: DATA_SOURCE,
            rentalsCount: CURRENT_RENTALS.length,
            pdfUrl: PDF_URL,
            heading: PDF_HEADING
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
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).send('Denied');
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
             || req.socket.remoteAddress;
    const { error } = await supabase
        .from('settings')
        .upsert({ key: 'admin_ip', value: ip, updated_at: new Date().toISOString() });
    if (error) return res.status(500).send('Error: ' + error.message);
    console.log(`✅ Admin IP updated to: ${ip}`);
    res.send(`✅ Admin IP updated: ${ip}`);
});

app.post('/api/admin/update-ip', requireAdmin, async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
             || req.socket.remoteAddress;
    const { error } = await supabase
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
app.post('/api/admin-login', async (req, res) => {
    const { password } = req.body;
    const visitorIP = req.headers['x-forwarded-for']?.split(',')[0].trim()
                    || req.socket.remoteAddress;
    const adminIP = await getAdminIP();

    if (visitorIP !== adminIP) {
        console.log(`❌ Admin login blocked: IP ${visitorIP} !== ${adminIP}`);
        return res.status(403).json({ error: 'Access denied: wrong IP address' });
    }
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Wrong password' });
    }

    // Generate admin session token
    const token = Buffer.from(`admin:${Date.now()}:${process.env.ADMIN_SECRET}`).toString('base64');
    console.log(`✅ Admin login from ${visitorIP}`);
    res.json({ token });
});

// ── Admin auth middleware ──────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });

    // Verify token structure
    try {
        const decoded = Buffer.from(token, 'base64').toString();
        const [role, timestamp] = decoded.split(':');
        if (role !== 'admin') return res.status(403).json({ error: 'Not admin' });

        // Token expires after 4 hours
        if (Date.now() - parseInt(timestamp) > 4 * 60 * 60 * 1000) {
            return res.status(401).json({ error: 'Session expired' });
        }

        // Also verify current IP
        const visitorIP = req.headers['x-forwarded-for']?.split(',')[0].trim()
                        || req.socket.remoteAddress;
        const adminIP = await getAdminIP();
        if (visitorIP !== adminIP) return res.status(403).json({ error: 'IP changed' });

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
            .select('id, name, email, phone, province, rental_type, is_member, membership_paid_until, invitation_sent_at, invitation_status, atp_active, slug, contact_name, notes, password_changed, apatel_member, feature_rank')
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
        await supabase.from('event_log').insert({
            event_type: type,
            event_data: data,
            created_at: new Date().toISOString()
        });
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
    const { data, error } = await supabase
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
        registration_type, listing_phone, listing_email
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
            const { data: matchingListings } = await supabase
                .from('listings')
                .select('id, name, is_trial, trial_started_at, is_member')
                .ilike('name', `%${property_name.trim()}%`)
                .eq('province', province)
                .limit(1);

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
    res.json(data);
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

                const paidUntil = new Date();
                if (isTrial) paidUntil.setDate(paidUntil.getDate() + 30);
                else paidUntil.setFullYear(paidUntil.getFullYear() + (app.duration_months === 24 ? 2 : 1));
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
                    const amount = app.duration_months === 24 ? 45 : 24;
                    const itbms  = parseFloat((amount * 0.07).toFixed(2));
                    await supabase.from('event_log').insert({
                        event_type: 'invoice_pending',
                        event_data: { application_id, listing_id: listingId, property_name: app.property_name, contact_name: app.contact_name, contact_email: app.contact_email, ruc: null, amount, itbms, total: parseFloat((amount+itbms).toFixed(2)), plan: app.duration_months+' months', payment_method: app.payment_method, date: new Date().toISOString() },
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
        const paidUntil = new Date();
        if (isTrial) paidUntil.setDate(paidUntil.getDate() + 30);
        else paidUntil.setFullYear(paidUntil.getFullYear() + (app.duration_months === 24 ? 2 : 1));
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
            const amount = app.duration_months === 24 ? 45 : 24;
            const itbms  = parseFloat((amount * 0.07).toFixed(2));
            await supabase.from('event_log').insert({
                event_type: 'invoice_pending',
                event_data: { application_id, listing_id: listingId, property_name: app.property_name, contact_name: app.contact_name, contact_email: app.contact_email, ruc: null, amount, itbms, total: parseFloat((amount+itbms).toFixed(2)), plan: app.duration_months+' months', payment_method: app.payment_method, date: new Date().toISOString() },
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
    const { application_id, reason, custom_note, is_payment_issue } = req.body;
    if (!application_id || !reason) return res.status(400).json({ error: 'Missing fields' });
    const { data: app, error: appError } = await supabaseAdmin.from('membership_applications').select('*').eq('id', application_id).single();
    if (appError || !app) return res.status(404).json({ error: 'Not found' });

    const fullReason = reason + (custom_note ? '. ' + custom_note : '');
    await supabaseAdmin.from('membership_applications').update({ status: 'rejected', notes: 'Razón: ' + fullReason, reviewed_at: new Date().toISOString(), reviewed_by: 'admin' }).eq('id', application_id);
    await logEvent('application_rejected', { application_id, reason, is_payment_issue });

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
    const { data, error } = await supabase
        .from('event_log')
        .select('*')
        .eq('event_type', 'invoice_pending')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});


app.post('/api/submit-payment',
    uploadDocs.fields([{ name: 'file_pago', maxCount: 1 }]),
    async (req, res) => {
    const { listing_id, duration_months, payment_method, contact_email, token } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'Missing listing_id' });
    if (token) {
        try {
            const decoded = Buffer.from(token, 'base64').toString();
            const [tokenId] = decoded.split(':');
            if (tokenId !== String(listing_id)) return res.status(403).json({ error: 'Invalid token' });
        } catch { return res.status(403).json({ error: 'Invalid token' }); }
    }
    try {
        const { data: listing, error: listingError } = await supabase
            .from('listings')
            .select('id, name, province, email, email_member, phone, contact_name')
            .eq('id', listing_id).single();
        if (listingError || !listing) return res.status(404).json({ error: 'Listing not found' });

        let documentPath = null;
        const file = req.files?.file_pago?.[0];
        if (file) {
            const safeName = file.originalname.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').toLowerCase();
            const fileName = 'payments/' + listing_id + '/' + Date.now() + '-' + safeName;
            const { error: uploadError } = await supabaseAdmin.storage.from('member-documents').upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });
            if (!uploadError) documentPath = fileName;
        }

        const months = parseInt(duration_months) || 12;
        const { data: submission } = await supabaseAdmin.from('membership_applications').insert({
            listing_id:      parseInt(listing_id),
            property_name:   listing.name,
            province:        listing.province,
            contact_name:    listing.contact_name || '',
            contact_email:   contact_email || listing.email_member || listing.email || '',
            contact_phone:   listing.phone || '',
            membership_type: 'paid',
            duration_months: months,
            payment_method:  payment_method || 'transfer',
            documents:       documentPath ? [{ type: 'comprobante_pago', path: documentPath, uploaded: new Date().toISOString(), mime: file?.mimetype, size: file?.size }] : null,
            notes:           'Payment renewal submission',
            status:          'pending'
        }).select().single();

        await logEvent('payment_submitted', { listing_id: parseInt(listing_id), duration_months: months, has_proof: !!documentPath });

        const amount  = months === 24 ? 45 : 24;
        const subject = 'Comprobante de pago recibido: ' + listing.name;
        const message = '<html><body style="font-family:Arial,sans-serif;font-size:14px;"><h2 style="color:#005ca9;">Comprobante de Pago Recibido</h2><p><strong>Hospedaje:</strong> ' + listing.name + '<br><strong>ID:</strong> ' + listing_id + '<br><strong>Plan:</strong> ' + (months===24?'2 años ($45)':'1 año ($24)') + '<br><strong>Comprobante:</strong> ' + (documentPath?'Recibido':'No adjuntado') + '</p><p><a href="https://trustedpanamastays.com/admin.html" style="background:#005ca9;color:white;padding:8px 16px;text-decoration:none;border-radius:5px;">Ver en Admin</a></p></body></html>';
        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        await execFileAsync('php', [notifyPath, subject, message, 'info@trustedpanamastays.com'], { timeout: 15000 }).catch(err => console.error('Payment notify failed:', err.message));

        res.json({ success: true, submission_id: submission?.id });
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
        const { data: listings, error } = await supabase
            .from('listings')
            .select('id, name, phone, email, province, rental_type, phone_member, email_member, address, photos, is_member, membership_paid_until, slug, website_url, booking_url, registry_source, atp_active, apatel_member, is_trial, feature_rank')
            .gt('feature_rank', 0)
            .order('feature_rank', { ascending: false });

        if (error) throw new Error(error.message);
        if (!listings || listings.length === 0)
            return res.status(404).json({ error: 'No featured listings' });

        res.json(listings);  // returns array
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── GET /api/send-trial-reminders (called by GitHub Action daily) ─────────────
app.get('/api/send-trial-reminders', async (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).send('Denied');

    try {
        // Find trials expiring in 5 days (between 4 and 6 days from now)
        const today   = new Date();
        const in4days = new Date(today); in4days.setDate(today.getDate() + 4);
        const in6days = new Date(today); in6days.setDate(today.getDate() + 6);

        const { data: expiring, error } = await supabase
            .from('listings')
            .select('id, name, email_member, email, phone, membership_paid_until, slug')
            .eq('is_member', true)
            .eq('is_trial', true)
            .gte('membership_paid_until', in4days.toISOString().split('T')[0])
            .lte('membership_paid_until', in6days.toISOString().split('T')[0]);

        if (error) throw new Error(error.message);
        if (!expiring || expiring.length === 0) {
            return res.json({ success: true, sent: 0, message: 'No trials expiring in 5 days' });
        }

        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        let sent = 0;

        for (const listing of expiring) {
            const memberEmail = listing.email_member || listing.email;
            if (!memberEmail || !memberEmail.includes('@')) {
                await logEvent('trial_reminder_skipped', { listing_id: listing.id, reason: 'no_email' });
                continue;
            }

            const listingUrl = listing.slug
                ? `https://trustedpanamastays.com/listing.html?slug=${listing.slug}&lang=es`
                : `https://trustedpanamastays.com/listing.html?id=${listing.id}&lang=es`;
            const payUrl = `https://trustedpanamastays.com/pay.html`;

            const subject = `Su prueba gratuita vence en 5 días — ${listing.name}`;
            const message = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
</div>
<p>Estimado/a propietario/a de <strong>${listing.name}</strong>,</p>
<p>Su período de prueba gratuita vence el <strong>${listing.membership_paid_until}</strong> — en 5 días.</p>
<p>Para continuar con acceso completo a su listado (fotos, descripción, enlaces de reserva),
   renueve su membresía ahora:</p>
<table style="border:1px solid #e1e5e9;border-radius:8px;background:#f8f9fa;width:100%;margin:1rem 0;">
    <tr><td style="padding:8px;font-weight:bold;">1 año:</td><td style="padding:8px;"><strong>$24</strong> + ITBMS ($25.68 inclusive)</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">2 años:</td><td style="padding:8px;"><strong>$45</strong> + ITBMS ($48.15 inclusive) · Ahorre $3</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">N° membresía:</td><td style="padding:8px;font-family:monospace;"><strong>${listing.id}</strong></td></tr>
</table>
<p style="text-align:center;margin:1.5rem 0;">
    <a href="${payUrl}" style="background:#005ca9;color:white;padding:11px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;">
        Renovar membresía →
    </a>
</p>
<p style="font-size:0.85rem;color:#666;">
    También puede renovar iniciando sesión en su listado:<br>
    <a href="${listingUrl}" style="color:#005ca9;">${listingUrl}</a>
</p>
<p style="font-size:0.82rem;color:#888;margin-top:1rem;">
    Si decide no renovar, su perfil se desactivará automáticamente al vencer el período de prueba.
    Sus documentos e información quedarán guardados — puede reactivar su membresía en cualquier momento.
</p>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">
    Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
    <a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a>
</p>
</body></html>`;

            try {
                await execFileAsync('php', [notifyPath, subject, message, memberEmail], { timeout: 15000 });
                await logEvent('trial_reminder_sent', { listing_id: listing.id, email: memberEmail, expires: listing.membership_paid_until });
                sent++;
            } catch (emailErr) {
                await logEvent('trial_reminder_failed', { listing_id: listing.id, error: emailErr.message });
            }
        }

        res.json({ success: true, sent, total: expiring.length });

    } catch (err) {
        console.error('Trial reminder error:', err.message);
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
        if (filter === 'no-email') query = query.is('email', null);
        else query = query.not('email', 'is', null); // has email

        const { data: listings, error } = await query;
        if (error) throw new Error(error.message);

        if (!listings || listings.length === 0)
            return res.json({ success: true, sent: 0, skipped: 0, message: 'No eligible listings found' });

        if (dry_run)
            return res.json({ success: true, dry_run: true, count: listings.length,
                has_email: listings.filter(l => l.email).length,
                no_email: listings.filter(l => !l.email).length,
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
            const greeting = isApatel
                ? `Como miembro de APATEL, le escribimos con una invitación especial.`
                : `Le contactamos porque su hospedaje aparece en el registro oficial de la ATP.`;

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
        // Total counts by event type
        const { data: totals } = await supabaseAdmin
            .from('listing_events')
            .select('event_type')
            .gte('created_at', since);

        const counts = {};
        (totals || []).forEach(e => {
            counts[e.event_type] = (counts[e.event_type] || 0) + 1;
        });

        // Top listings by views
        const { data: views } = await supabaseAdmin
            .from('listing_events')
            .select('listing_id')
            .eq('event_type', 'listing_view')
            .gte('created_at', since)
            .not('listing_id', 'is', null);

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
        const { data: events } = await supabaseAdmin
            .from('listing_events')
            .select('event_type, created_at')
            .eq('listing_id', listingId)
            .gte('created_at', since)
            .order('created_at', { ascending: false });

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

app.post('/api/admin/send-apatel-campaign', requireAdmin, async (req, res) => {
    const { dry_run, start_from } = req.body;
    const startIndex = parseInt(start_from) || 0;

    try {
        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        let sent = 0, skipped = 0, errors = 0;
        const results = [];

        for (let i = startIndex; i < APATEL_ROSTER.length; i++) {
            const member = APATEL_ROSTER[i];
            if (!member.email || !member.email.includes('@')) {
                skipped++;
                continue;
            }

            // Find their listing in DB to get the listing URL
            const { data: listings } = await supabase
                .from('listings')
                .select('id, name, slug, apatel_member')
                .eq('apatel_member', true)
                .ilike('name', `%${member.hotel.substring(0, 15)}%`)
                .limit(1);

            const listing   = listings?.[0];
            const listingUrl = listing?.slug
                ? `https://trustedpanamastays.com/listing.php?slug=${listing.slug}&lang=es`
                : listing
                ? `https://trustedpanamastays.com/listing.php?id=${listing.id}&lang=es`
                : 'https://trustedpanamastays.com/index_es.html';

            const joinUrl = 'https://trustedpanamastays.com/join.html';

            // Manager first name
            const firstName = member.manager.split(' ')[0];
            const greeting  = firstName && firstName.length > 2
                ? `Estimado/a <strong>${firstName}</strong>`
                : `Estimado/a propietario/a`;

            const subject = `${member.hotel} ya aparece en Trusted Panama Stays`;
            const message = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.3rem 0 0;font-size:0.88rem;">Directorio de hospedajes legalmente registrados en Panamá</p>
</div>

<p>${greeting},</p>
<p>Como miembro de <strong>APATEL</strong>, le escribimos con una invitación especial.</p>
<p>Hemos creado <strong>Trusted Panama Stays</strong>, un directorio en línea para turistas internacionales que buscan hospedajes legalmente registrados en Panamá — sin las comisiones de Booking.com o Airbnb (15–20%).</p>

<div style="background:#f0f7ff;border:1px solid #c0d8f0;border-radius:8px;padding:1rem;margin:1rem 0;">
    <p style="margin:0 0 0.5rem;font-weight:bold;color:#005ca9;">Su hospedaje ya aparece en nuestro directorio:</p>
    <p style="margin:0;"><a href="${listingUrl}" style="color:#005ca9;font-size:0.95rem;">${listingUrl}</a></p>
</div>

<p>Con una <strong>membresía de prueba gratuita</strong> (sin costo, sin obligación) puede agregar:</p>
<ul style="margin:0.5rem 0 1rem 1.5rem;line-height:2;">
    <li>Hasta <strong>20 fotos</strong> de su hospedaje</li>
    <li>Descripción en <strong>inglés y español</strong></li>
    <li>Dirección completa y enlaces a su sitio web</li>
    <li>Botones de contacto directo (WhatsApp, correo, reservas)</li>
</ul>

<p style="text-align:center;margin:1.5rem 0;">
    <a href="${joinUrl}" style="background:#005ca9;color:white;padding:12px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem;display:inline-block;">
        Solicitar membresía gratuita →
    </a>
</p>

<p style="font-size:0.85rem;color:#666;">
    Creado por Volker Piasta, propietario del <strong>Aparthotel Boquete</strong> y miembro de APATEL.<br>
    El costo después de la prueba es solo <strong>$24/año + ITBMS</strong> — menos de $2 al mes.
</p>

<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">
    Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
    <a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a><br>
    Para cancelar estas comunicaciones responda con "No gracias".
</p>
</body></html>`;

            if (dry_run) {
                results.push({ index: i, hotel: member.hotel, email: member.email, listing_found: !!listing });
                sent++;
                continue;
            }

            try {
                await execFileAsync('php', [notifyPath, subject, message, member.email], { timeout: 15000 });

                // Mark as invited in DB if listing found
                if (listing) {
                    await supabase.from('listings').update({
                        invitation_status:  'invited',
                        invitation_sent_at: new Date().toISOString()
                    }).eq('id', listing.id);
                }

                await logEvent('apatel_campaign_sent', {
                    hotel:      member.hotel,
                    email:      member.email,
                    listing_id: listing?.id || null,
                    index:      i
                });

                sent++;
                results.push({ index: i, hotel: member.hotel, email: member.email, status: 'sent' });

                // Throttle — 1 email per 500ms
                await new Promise(r => setTimeout(r, 500));

            } catch (err) {
                console.error(`Campaign email failed for ${member.hotel}:`, err.message);
                errors++;
                results.push({ index: i, hotel: member.hotel, email: member.email, status: 'error', error: err.message });
            }
        }

        res.json({
            success: true, dry_run: !!dry_run,
            sent, skipped, errors,
            total: APATEL_ROSTER.length,
            results: dry_run ? results : results.slice(-5) // return last 5 if live
        });

    } catch (err) {
        console.error('APATEL campaign error:', err.message);
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

// ── POST /api/admin/send-followup-test ───────────────────────────────────────
// Send test email to info@ only
app.post('/api/admin/send-followup-test', requireAdmin, async (req, res) => {
    const { subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Missing subject or body' });

    const fullHtml = buildFollowupHtml('HOTEL EJEMPLO', 'Juan García', body);
    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    try {
        await execFileAsync('php', [
            notifyPath,
            '[TEST] ' + subject,
            fullHtml,
            'info@trustedpanamastays.com'
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

    // Send in background, return immediately
    res.json({ success: true, message: 'Campaign started', total: APATEL_ROSTER.length });

    for (const member of APATEL_ROSTER) {
        if (!member.email || !member.email.includes('@')) continue;
        try {
            const html = buildFollowupHtml(member.hotel, member.manager, body);
            await execFileAsync('php', [notifyPath, subject, html, member.email], { timeout: 15000 });
            await logEvent('followup_sent', { hotel: member.hotel, email: member.email });
            sent++;
            await new Promise(r => setTimeout(r, 600));
        } catch (err) {
            errors++;
            console.error(`Follow-up failed for ${member.hotel}:`, err.message);
        }
    }

    // Send completion report to admin
    const report = `<p>Follow-up campaign complete: <strong>${sent}</strong> sent, ${errors} errors out of ${APATEL_ROSTER.length} total.</p>`;
    execFileAsync('php', [notifyPath, 'Follow-up campaign complete — Trusted Panama Stays', report, 'info@trustedpanamastays.com'], { timeout: 15000 }).catch(console.error);
    console.log(`Follow-up done: ${sent} sent, ${errors} errors`);
});


// ── Helper: wrap body content in full email template ─────────────────────────
function buildFollowupHtml(hotel, manager, bodyContent) {
    const firstName = (manager || '').split(' ')[0];
    const greeting  = firstName && firstName.length > 2 ? firstName : 'propietario/a';
    return `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;margin:0 auto;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.3rem 0 0;font-size:0.88rem;">Directorio de hospedajes legalmente registrados en Panamá</p>
</div>
<p>Estimado/a <strong>${greeting}</strong>,</p>
${bodyContent}
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">
    Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
    <a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a><br>
    Para cancelar estas comunicaciones responda con "No gracias".
</p>
</body></html>`;
}

const TEMPLATES_DIR = path.join(__dirname, 'public', 'templates');

// Ensure templates directory exists
if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
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
    await sendToRosterList(targets, subject, body);
});

// ── POST /api/admin/send-followup-specific ────────────────────────────────────
// Send to a specific list of emails
app.post('/api/admin/send-followup-specific', requireAdmin, async (req, res) => {
    const { subject, body, emails } = req.body;
    if (!subject || !body || !emails?.length) return res.status(400).json({ error: 'Missing fields' });

    // Build targets from roster where possible, otherwise use email only
    const roster = require('./apatel_emails.json');
    const rosterMap = {};
    roster.forEach(m => { if (m.email) rosterMap[m.email.toLowerCase()] = m; });

    const targets = emails.map(email => {
        const match = rosterMap[email.toLowerCase()];
        return match || { hotel: email, email, manager: '' };
    });

    res.json({ success: true, message: `Sending to ${targets.length} specific recipients`, total: targets.length });
    await sendToRosterList(targets, subject, body);
});

// ── Helper: send to a list of roster-format members ───────────────────────────
async function sendToRosterList(targets, subject, body) {
    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    let sent = 0, errors = 0;

    for (const member of targets) {
        if (!member.email || !member.email.includes('@')) continue;
        try {
            const html = buildFollowupHtml(member.hotel || member.email, member.manager || '', body);
            await execFileAsync('php', [notifyPath, subject, html, member.email], { timeout: 15000 });

            // Mark as contacted in DB
            await supabase.from('listings')
                .update({ apatel_contacted_at: new Date().toISOString() })
                .or(`email.ilike.%${member.email}%,email_member.ilike.%${member.email}%`)
                .eq('apatel_member', true);

            await logEvent('followup_sent', { hotel: member.hotel, email: member.email });
            sent++;
            await new Promise(r => setTimeout(r, 600));
        } catch (err) {
            errors++;
            console.error(`Failed for ${member.hotel||member.email}:`, err.message);
        }
    }

    // Completion report to admin
    const report = `<p>Campaign complete: <strong>${sent}</strong> sent, ${errors} errors out of ${targets.length} total.</p>`;
    execFileAsync('php', [path.join(__dirname, 'public', 'notify.php'),
        'Campaign complete — Trusted Panama Stays', report, 'info@trustedpanamastays.com'],
        { timeout: 15000 }).catch(console.error);
    console.log(`Campaign done: ${sent} sent, ${errors} errors`);
}

// ── Recalculate feature ranks for all featured listings ───────────────────────
async function recalculateFeatureRanks() {
    try {
        const { data: featured } = await supabaseAdmin
            .from('listings')
            .select('id, is_trial, membership_paid_until')
            .gt('feature_rank', 0)
            .order('is_trial', { ascending: true })      // paid first
            .order('membership_paid_until', { ascending: true }); // earliest first

        if (!featured || !featured.length) return;

        for (let i = 0; i < featured.length; i++) {
            await supabaseAdmin
                .from('listings')
                .update({ feature_rank: i + 1 })
                .eq('id', featured[i].id);
        }
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

            // Claude Vision handles jpg/png/webp/gif — skip PDFs
            if (doc.mime !== 'application/pdf') {
                imageContents.push({
                    type: 'image',
                    source: { type: 'base64', media_type: doc.mime, data: base64 }
                });
                imageContents.push({
                    type: 'text',
                    text: `The above image is the: ${doc.type.replace(/_/g,' ').toUpperCase()}`
                });
            }
        }

        if (!imageContents.length) {
            return res.status(400).json({
                error: 'No image documents available for AI verification. PDF documents must be reviewed manually.'
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

// ── Trial expiry reminder — runs daily ───────────────────────────────────────
async function sendTrialExpiryReminders() {
    try {
        const in7days = new Date();
        in7days.setDate(in7days.getDate() + 7);
        const dateStr = in7days.toISOString().split('T')[0];

        const { data: expiring } = await supabaseAdmin
            .from('listings')
            .select('id, name, contact_name, email_member, email, membership_paid_until, photos')
            .eq('is_trial', true)
            .eq('is_member', true)
            .eq('membership_paid_until', dateStr);

        if (!expiring || !expiring.length) return;

        const reminderPath = path.join(__dirname, 'public', 'templates', 'trial_expiry_reminder.html');
        let reminderBody = '';
        try { reminderBody = fs.readFileSync(reminderPath, 'utf8'); } catch(e) {
            console.error('Could not load trial reminder template'); return;
        }

        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        for (const listing of expiring) {
            const toEmail = listing.email_member || listing.email;
            if (!toEmail || !toEmail.includes('@')) continue;
            const name = listing.contact_name || 'propietario/a';
            const html = `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;margin:0 auto;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays</h1>
    <p style="color:rgba(255,255,255,0.85);margin:0.3rem 0 0;font-size:0.88rem;">Directorio de hospedajes legalmente registrados en Panamá</p>
</div>
<p>Estimado/a <strong>${name}</strong>,</p>
${reminderBody}
${(!listing.photos || !listing.photos.length) ? `
<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:1rem;margin:1rem 0;">
    <p style="margin:0;color:#856404;"><strong>💡 Notamos que su listado aún no tiene fotos.</strong> Con solo una foto, su hospedaje aparecerá destacado en la página principal de Trusted Panama Stays — visible para todos los turistas que buscan hospedaje en Panamá.</p>
</div>` : ''}
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
<a href="mailto:info@trustedpanamastays.com" style="color:#7ec8e3;">info@trustedpanamastays.com</a></p>
</body></html>`;

            try {
                await execFileAsync('php', [notifyPath,
                    'Su membresía de prueba vence pronto — ' + listing.name,
                    html, toEmail], { timeout: 15000 });
                await logEvent('trial_reminder_sent', { listing_id: listing.id, email: toEmail });
                console.log(`Trial reminder sent to ${listing.name}`);
            } catch(err) {
                console.error(`Trial reminder failed for ${listing.name}:`, err.message);
            }
        }
    } catch(err) {
        console.error('sendTrialExpiryReminders error:', err.message);
    }
}

// Run daily at 9am Panama time (UTC-5 = 14:00 UTC)
const now = new Date();
const msUntil9am = (() => {
    const next = new Date();
    next.setUTCHours(14, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
})();
setTimeout(() => {
    sendTrialExpiryReminders();
    setInterval(sendTrialExpiryReminders, 24 * 60 * 60 * 1000);
}, msUntil9am);
console.log(`Trial reminder scheduler set — first run in ${Math.round(msUntil9am/3600000)}h`);

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
        .select('contact_name, ruc, ruc_dv, listing_id')
        .eq('listing_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json({
        name:   data.business_name || null,
        ruc:    data.ruc || null,
        ruc_dv: data.ruc_dv || null
    });
});


//========== temporary endpoints ============================

//==========================================================

const server = require('http').createServer({ maxHeaderSize: 81920 }, app);
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Main page: http://localhost:${PORT}`);
    console.log(`📍 Health:    http://localhost:${PORT}/health`);
});
