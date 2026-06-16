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
const supabase = require('./db');   // <-- Supabase client
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;
const https = require('https');
const http = require('http');

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
        }
    } catch (err) {
        console.error('❌ STEP 2: PDF update check failed:', err.message);
        // If we already have data from STEP 1, keep serving it — no problem
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

app.get('/api/provinces', (req, res) => {
    const provinceCounts = CURRENT_RENTALS.reduce((acc, rental) => {
        if (rental.province) acc[rental.province] = (acc[rental.province] || 0) + 1;
        return acc;
    }, {});
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
    const { search, province, type } = req.query;

    // Start from in-memory ATP data
    let filtered = [...CURRENT_RENTALS];

    // Apply filters
    if (search) {
        const s = search.toLowerCase();
        filtered = filtered.filter(r =>
            r.name.toLowerCase().includes(s) ||
            (r.email    && r.email.toLowerCase().includes(s)) ||
            (r.phone    && r.phone.toLowerCase().includes(s)) ||
            (r.province && r.province.toLowerCase().includes(s))
        );
    }
    if (province) filtered = filtered.filter(r => r.province === province);
    if (type)     filtered = filtered.filter(r => r.rental_type === type);

    // Enrich with member data from database in batches
    // Only fetch member fields for matched results
    try {
        const ids = filtered.map(r => r.id).filter(Boolean);
        if (ids.length > 0) {
            // Fetch member data for all matching listings
            const { data: memberData } = await supabase
                .from('listings')
                .select('id, phone_member, email_member, address, photos, is_member, membership_paid_until, slug')
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
                        slug:                  m.slug || null
                    };
                });
            }
        }
    } catch (err) {
        console.error('Error enriching rentals with member data:', err.message);
        // Return ATP data without member enrichment rather than failing
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
        .select('id, name, phone, email, province, rental_type, atp_active, atp_first_seen, atp_last_seen, address, description_en, description_es, photos, website_url, booking_url, is_member, membership_paid_until, contact_name, slug, phone_member, email_member, custom_links')
        .eq('slug', slug)
        .single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
});

app.get('/api/listing/:id', async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
        .from('listings')
        .select('id, name, phone, email, province, rental_type, atp_active, atp_first_seen, atp_last_seen, address, description_en, description_es, photos, website_url, booking_url, is_member, membership_paid_until, contact_name, phone_member, email_member, custom_links, slug')
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
        description_es, website_url, booking_url, photos, custom_links } = req.body;

    // Verify token
    try {
        const decoded = Buffer.from(token, 'base64').toString();
        const [tokenId] = decoded.split(':');
        if (tokenId !== String(id)) return res.status(403).json({ error: 'Invalid token' });
    } catch {
        return res.status(403).json({ error: 'Invalid token' });
    }

    // Only allow member-owned fields — never ATP fields
    const { error } = await supabase
        .from('listings')
        .update({ address, phone_member, email_member, description_en, description_es, website_url, booking_url, photos, custom_links })
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
            .select('id, name, email, phone, province, rental_type, is_member, membership_paid_until, invitation_sent_at, atp_active, slug, contact_name, notes, password_changed')
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
    const { id, is_member, membership_paid_until, contact_name, slug, notes } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const { error } = await supabase
        .from('listings')
        .update({ is_member, membership_paid_until, contact_name, slug, notes })
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    // Log the action
    await logEvent('admin_update_member', { id, is_member, membership_paid_until, contact_name });
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
    const { error } = await supabase
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
            '</table>' + trialNote +
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
        duration_months, payment_method
    } = req.body;

    if (!property_name || !contact_name || !contact_email || !contact_phone) {
        return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
             || req.socket.remoteAddress;

    try {
        // ── Try to find matching listing in database ───────────────────────
        let listingId = null;
        const { data: matchingListings } = await supabase
            .from('listings')
            .select('id, name, is_trial, trial_started_at, is_member')
            .ilike('name', `%${property_name.trim()}%`)
            .eq('province', province)
            .limit(1);

        if (matchingListings && matchingListings.length > 0) {
            listingId = matchingListings[0].id;
            const existing = matchingListings[0];

            // ── Block trial if listing already had trial or membership ────
            if (membership_type === 'trial') {
                if (existing.trial_started_at || existing.is_member) {
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
            const { error: uploadError } = await supabase.storage
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

        // ── Save application to database ──────────────────────────────────
        const { data: application, error: insertError } = await supabase
            .from('membership_applications')
            .insert({
                listing_id:      listingId,
                property_name:   property_name.trim(),
                province,
                contact_name:    contact_name.trim(),
                contact_email:   contact_email.trim().toLowerCase(),
                contact_phone:   contact_phone.trim(),
                membership_type,
                duration_months: parseInt(duration_months) || 0,
                payment_method,
                documents:       documents.length ? documents : null,
                notes:           how_found ? `Cómo nos conoció: ${how_found}` : null,
                ip_address:      ip,
                status:          'pending'
            })
            .select()
            .single();

        if (insertError) throw new Error(insertError.message);

        await logEvent('membership_application_received', {
            application_id: application.id,
            property_name, membership_type, listing_id: listingId
        });

        // ── Send notification email ───────────────────────────────────────
        const planText = membership_type === 'trial'
            ? 'Prueba gratuita 30 días'
            : (duration_months == 24 ? '2 años ($45)' : '1 año ($24)');

        const subject = `Nueva solicitud de membresía: ${property_name}`;
        const message = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;">
<h2 style="color:#005ca9;">Nueva Solicitud de Membresía</h2>
<table style="border-collapse:collapse;width:100%;max-width:500px;">
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Hospedaje:</td><td style="padding:6px;">${property_name}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Provincia:</td><td style="padding:6px;">${province}</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Contacto:</td><td style="padding:6px;">${contact_name}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Correo:</td><td style="padding:6px;">${contact_email}</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Teléfono:</td><td style="padding:6px;">${contact_phone}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Plan:</td><td style="padding:6px;">${planText}</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Pago:</td><td style="padding:6px;">${payment_method || 'N/A'}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Documentos:</td><td style="padding:6px;">${documents.length} archivo(s)</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">ATP match:</td><td style="padding:6px;">${listingId ? 'Sí (ID: '+listingId+')' : 'No encontrado'}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">ID Solicitud:</td><td style="padding:6px;">${application.id}</td></tr>
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

        res.json({ success: true, application_id: application.id, listing_found: !!listingId });

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
    const { data, error } = await supabase
        .from('membership_applications')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── Get single application ────────────────────────────────────────────────────
app.get('/api/admin/application/:id', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
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
    const { error } = await supabase
        .from('membership_applications')
        .update({ status, notes, reviewed_at: new Date().toISOString(), reviewed_by: 'admin' })
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logEvent('application_status_changed', { id, status });
    res.json({ success: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// ── AI verify documents ───────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/admin/verify-documents', requireAdmin, async (req, res) => {
    const { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'Missing application_id' });

    const { data: app, error: appError } = await supabase
        .from('membership_applications')
        .select('*')
        .eq('id', application_id)
        .single();
    if (appError || !app) return res.status(404).json({ error: 'Application not found' });
    if (!app.documents || !app.documents.length)
        return res.status(400).json({ error: 'No documents to verify' });

    try {
        const imageContents = [];
        const docLabels     = [];

        // ── Download and prepare each document ───────────────────────────
        for (const doc of app.documents) {
            const { data: fileData, error: dlError } = await supabase.storage
                .from('member-documents')
                .download(doc.path);
            if (dlError) {
                console.error(`Download error for ${doc.type}:`, dlError.message);
                continue;
            }

            const arrayBuffer = await fileData.arrayBuffer();
            const buffer      = Buffer.from(arrayBuffer);
            const isPdf       = doc.mime === 'application/pdf';
            let   base64, mediaType;

            if (isPdf) {
                // Convert PDF to image using sharp if available, otherwise send as-is
                // Claude can read PDFs directly via the document type
                base64    = buffer.toString('base64');
                mediaType = 'application/pdf';

                // Use Claude's document type for PDFs
                imageContents.push({
                    type: 'document',
                    source: {
                        type:       'base64',
                        media_type: 'application/pdf',
                        data:       base64
                    }
                });
            } else {
                // Image file — send directly
                base64    = buffer.toString('base64');
                mediaType = doc.mime;
                imageContents.push({
                    type: 'image',
                    source: {
                        type:       'base64',
                        media_type: mediaType,
                        data:       base64
                    }
                });
            }

            imageContents.push({
                type: 'text',
                text: `The above document is: ${doc.type.replace(/_/g,' ').toUpperCase()}`
            });
            docLabels.push(doc.type);
        }

        if (!imageContents.length) {
            return res.status(400).json({ error: 'Could not load any documents for verification' });
        }

        // ── Build extraction + verification prompt ────────────────────────
        const prompt = `You are verifying membership application documents for a Panama tourism rental directory called Trusted Panama Stays.

Application details submitted by the applicant:
- Property/establishment name: ${app.property_name}
- Contact/representative name: ${app.contact_name}
- Province: ${app.province}
- Plan: ${app.membership_type === 'trial' ? 'Free 30-day trial' : app.duration_months + ' months paid'}
- Payment method: ${app.payment_method || 'none'}
- Amount expected: ${app.duration_months === 24 ? '$45' : app.duration_months === 12 ? '$24' : 'none (trial)'}

Documents provided: ${docLabels.join(', ')}

Please carefully read ALL documents provided and return ONLY a JSON object with this exact structure:

{
  "aviso_operacion": {
    "found": true,
    "aviso_number": "the aviso de operación number",
    "issue_date": "date in YYYY-MM-DD format if possible",
    "establishment_name": "name of the establishment/business as shown",
    "establishment_location": "address or location of the establishment",
    "company_name": "legal company name (razón social)",
    "ruc": "RUC number (digits only, no DV)",
    "ruc_dv": "DV digit(s)",
    "rep_name": "full name of legal representative",
    "rep_cedula": "cédula number of representative",
    "activity": "business activity description",
    "valid": true,
    "notes": "any issues or observations about this document"
  },
  "cedula": {
    "found": true,
    "id_holder_name": "full name as shown on ID",
    "id_number": "cédula or passport number",
    "id_type": "cédula or passport",
    "notes": "any issues"
  },
"payment": {
    "found": true,
    "amount": "amount shown including currency symbol",
    "date": "payment date in YYYY-MM-DD format, remembering Panama uses dd-mm-yyyy",
    "reference": "transaction reference or confirmation number",
    "method": "transfer/yappy/other",
    "payment_message": "content of MENSAJE/note/concept field, or 'empty' if blank",
    "notes": "any issues"
  },
  "verification": {
    "names_match": true,
    "names_match_detail": "Does rep_name on aviso match cedula holder name? Explain any differences.",
    "establishment_matches": true,
    "establishment_match_detail": "Does establishment name on aviso match application property name?",
    "payment_matches": true,
    "payment_match_detail": "Does payment amount match expected amount? Is date recent?",
    "overall_result": "PASS",
    "overall_notes": "Summary recommendation for admin"
  }
}

Important notes:
- overall_result must be exactly: PASS, FAIL, or REVIEW
- Use PASS when all documents are valid and match
- Use FAIL when there are clear mismatches or invalid documents
- Use REVIEW when documents are valid but have minor issues needing human judgment
- When evaluating payment: check if payment_message contains the property name or province. If message is empty, flag it as missing but do not FAIL — just note it in payment_match_detail.
- A payment predating the application by days or weeks is normal and acceptable.
- If a document type is not provided, set found: false and all other fields to null
- Extract ALL visible text carefully — Panamanian government documents have standardized layouts
- RUC format in Panama: digits-digit-digits (e.g. 8-123-456789 or 1401220-1-627960)
- Today's date is ${new Date().toISOString().split('T')[0]}. Do not flag past dates as future dates.
- Panama uses dd-mm-yyyy date format. A date like 28-05-2026 means May 28, 2026 which is in the past relative to today.
- For payment receipts, look carefully for any message, note, concept, referencia, or MENSAJE field — even if empty. Extract its content or note that it is empty. Members are instructed to include their property name and province in this field.
- Return ONLY the JSON, no other text, no markdown code blocks`;

        // ── Call Claude API ───────────────────────────────────────────────
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model:      'claude-opus-4-5',
            max_tokens: 2000,
            messages:   [{
                role:    'user',
                content: [...imageContents, { type: 'text', text: prompt }]
            }]
        }, {
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            timeout: 60000
        });

        const content = response.data.content[0].text;
        const clean   = content.replace(/```json\n?|\n?```/g, '').trim();
        let result;
        try {
            result = JSON.parse(clean);
        } catch (parseErr) {
            console.error('JSON parse error:', clean.substring(0, 200));
            return res.status(500).json({ error: 'Could not parse AI response', raw: clean.substring(0, 500) });
        }

        // ── Auto-save extracted data to listing ───────────────────────────
        if (app.listing_id && result.aviso_operacion?.found) {
            const ao = result.aviso_operacion;
            const updateData = {};
            if (ao.ruc)                    updateData.ruc                    = ao.ruc;
            if (ao.ruc_dv)                 updateData.ruc_dv                 = ao.ruc_dv;
            if (ao.company_name)           updateData.legal_name             = ao.company_name;
            if (ao.aviso_number)           updateData.license_number         = ao.aviso_number;
            if (ao.issue_date)             updateData.license_date           = ao.issue_date;
            if (ao.rep_name)               updateData.rep_name               = ao.rep_name;
            if (ao.rep_cedula)             updateData.rep_cedula             = ao.rep_cedula;
            if (ao.establishment_name)     updateData.establishment_name     = ao.establishment_name;
            if (ao.establishment_location) updateData.establishment_location = ao.establishment_location;
            updateData.verified_at = new Date().toISOString();
            updateData.verified_by = 'ai';

            const { error: updateError } = await supabase
                .from('listings')
                .update(updateData)
                .eq('id', app.listing_id);

            if (updateError) {
                console.error('Failed to save extracted data:', updateError.message);
            } else {
                console.log(`✅ Extracted data saved to listing ${app.listing_id}`);
            }
        }

        await logEvent('ai_verification_completed', {
            application_id,
            result:     result.verification?.overall_result,
            listing_id: app.listing_id,
            data_saved: !!app.listing_id
        });

        res.json({ success: true, verification: result });

    } catch (err) {
        console.error('AI verification error:', err.message);
        if (err.response?.data) console.error('API error:', JSON.stringify(err.response.data));
        res.status(500).json({ error: 'AI verification failed: ' + err.message });
    }
});

// ── Approve application ───────────────────────────────────────────────────────

app.post('/api/admin/approve-application', requireAdmin, async (req, res) => {
    const bcrypt = require('bcrypt');
    const { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'Missing application_id' });
    const { data: app, error: appError } = await supabase.from('membership_applications').select('*').eq('id', application_id).single();
    if (appError || !app) return res.status(404).json({ error: 'Application not found' });
    try {
        const isTrial  = app.membership_type === 'trial';
        let listingId  = app.listing_id;

        if (isTrial && listingId) {
            const { data: existing } = await supabase.from('listings').select('is_trial, trial_started_at, is_member').eq('id', listingId).single();
            if (existing?.trial_started_at || existing?.is_member) {
                await supabase.from('membership_applications').update({ status: 'rejected', notes: 'Rechazado automáticamente: ya tuvo prueba o membresía.', reviewed_at: new Date().toISOString(), reviewed_by: 'system' }).eq('id', application_id);
                await logEvent('application_auto_rejected', { application_id, reason: 'existing_trial_or_membership', listing_id: listingId });
                return res.status(400).json({ error: 'Este hospedaje ya tuvo una prueba gratuita o membresía. Solicitud rechazada automáticamente.' });
            }
        }

        const chars    = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        const password = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const hash     = await bcrypt.hash(password, 10);

        const paidUntil = new Date();
        if (isTrial) paidUntil.setDate(paidUntil.getDate() + 30);
        else paidUntil.setFullYear(paidUntil.getFullYear() + (app.duration_months === 24 ? 2 : 1));
        const paidUntilStr = paidUntil.toISOString().split('T')[0];
        const slug = app.property_name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        if (listingId) {
            await supabase.from('listings').update({
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
        }

        if (!isTrial) {
            const amount = app.duration_months === 24 ? 45 : 24;
            const itbms  = parseFloat((amount * 0.07).toFixed(2));
            await supabase.from('event_log').insert({ event_type: 'invoice_pending', event_data: { application_id, listing_id: listingId, property_name: app.property_name, contact_name: app.contact_name, contact_email: app.contact_email, ruc: null, amount, itbms, total: parseFloat((amount+itbms).toFixed(2)), plan: app.duration_months+' months', payment_method: app.payment_method, date: new Date().toISOString() }, created_at: new Date().toISOString() });
        }

        await supabase.from('membership_applications').update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: 'admin' }).eq('id', application_id);

        const msgType   = isTrial ? 'approved_trial' : 'approved_paid';
        const emailHtml = generateEmailHtml({ ...app, listing_id: listingId }, msgType, password, paidUntilStr);
        const waMsg     = generateWaText({ ...app, listing_id: listingId }, msgType, password, paidUntilStr);
        const hasEmail  = !!(app.contact_email && app.contact_email.includes('@'));
        let emailSent   = false;
        let waText      = null;

        if (hasEmail) {
            const notifyPath = path.join(__dirname, 'public', 'notify.php');
            try { await execFileAsync('php', [notifyPath, 'Membresía aprobada - ' + app.property_name, emailHtml, app.contact_email], { timeout: 15000 }); emailSent = true; }
            catch (err) { console.error('Welcome email failed:', err.message); waText = waMsg; }
        } else { waText = waMsg; }

        const phone = app.contact_phone?.replace(/[^\d]/g,'').substring(0,8) || null;
        await logEvent('application_approved', { application_id, listing_id: listingId, membership_type: app.membership_type, paid_until: paidUntilStr });
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
    const { data: app, error: appError } = await supabase.from('membership_applications').select('*').eq('id', application_id).single();
    if (appError || !app) return res.status(404).json({ error: 'Not found' });

    const fullReason = reason + (custom_note ? '. ' + custom_note : '');
    await supabase.from('membership_applications').update({ status: 'rejected', notes: 'Razón: ' + fullReason, reviewed_at: new Date().toISOString(), reviewed_by: 'admin' }).eq('id', application_id);
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
            const { error: uploadError } = await supabase.storage.from('member-documents').upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });
            if (!uploadError) documentPath = fileName;
        }

        const months = parseInt(duration_months) || 12;
        const { data: submission } = await supabase.from('membership_applications').insert({
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
    const { data, error } = await supabase.storage
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
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/featured-listing', async (req, res) => {
    try {
        const { data: setting } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'featured_listing_id')
            .single();
        if (!setting) return res.status(404).json({ error: 'No featured listing configured' });

        const { data: listing, error } = await supabase
            .from('listings')
            .select('id, name, phone, email, province, rental_type, phone_member, email_member, address, photos, is_member, membership_paid_until, slug, website_url, booking_url')
            .eq('id', parseInt(setting.value))
            .single();
        if (error || !listing) return res.status(404).json({ error: 'Featured listing not found' });

        res.json(listing);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  featured listing
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/featured-listing', async (req, res) => {
    try {
        const { data: setting } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'featured_listing_id')
            .single();
        if (!setting) return res.status(404).json({ error: 'No featured listing configured' });

        const { data: listing, error } = await supabase
            .from('listings')
            .select('id, name, phone, email, province, rental_type, phone_member, email_member, address, photos, is_member, membership_paid_until, slug, website_url, booking_url')
            .eq('id', parseInt(setting.value))
            .single();
        if (error || !listing) return res.status(404).json({ error: 'Featured listing not found' });

        res.json(listing);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const server = require('http').createServer({ maxHeaderSize: 81920 }, app);
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Main page: http://localhost:${PORT}`);
    console.log(`📍 Health:    http://localhost:${PORT}/health`);
});
