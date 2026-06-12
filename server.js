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
//  API ENDPOINTS  (unchanged, still serve from CURRENT_RENTALS in memory)
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

app.get('/api/rentals', (req, res) => {
    const { search, province, type } = req.query;
    let filteredRentals = [...CURRENT_RENTALS];
    if (search) {
        const searchLower = search.toLowerCase();
        filteredRentals = filteredRentals.filter(r =>
            r.name.toLowerCase().includes(searchLower) ||
            (r.email && r.email.toLowerCase().includes(searchLower)) ||
            (r.phone && r.phone.toLowerCase().includes(searchLower)) ||
            (r.province && r.province.toLowerCase().includes(searchLower)) ||
            (r.type && r.type.toLowerCase().includes(searchLower))
        );
    }
    if (province) filteredRentals = filteredRentals.filter(r => r.province === province);
    if (type) filteredRentals = filteredRentals.filter(r => r.rental_type === type);
    res.json(filteredRentals);
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
//  Add this to server.js before the server.listen() line
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

    // Basic validation
    if (!property_name || !contact_name || !contact_email || !contact_phone) {
        return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
             || req.socket.remoteAddress;

    try {
        // ── 1. Upload documents to Supabase Storage ───────────────────────────
        const documents = [];
        const fileFields = [
            { key: 'file_aviso',  type: 'aviso_operacion' },
            { key: 'file_cedula', type: 'cedula' },
            { key: 'file_pago',   type: 'comprobante_pago' }
        ];

        for (const { key, type } of fileFields) {
            const file = req.files?.[key]?.[0];
            if (!file) continue;

            // Sanitize filename
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
                // Continue — don't fail the whole application for one file
            } else {
                documents.push({
                    type,
                    path:     fileName,
                    uploaded: new Date().toISOString(),
                    mime:     file.mimetype,
                    size:     file.size
                });
            }
        }

        // ── 2. Try to find matching listing in database ───────────────────────
        let listingId = null;
        const { data: matchingListings } = await supabase
            .from('listings')
            .select('id, name')
            .ilike('name', `%${property_name.trim()}%`)
            .eq('province', province)
            .limit(1);

        if (matchingListings && matchingListings.length > 0) {
            listingId = matchingListings[0].id;
        }

        // ── 3. Save application to database ──────────────────────────────────
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

        // ── 4. Log the event ──────────────────────────────────────────────────
        await logEvent('membership_application_received', {
            application_id: application.id,
            property_name,
            membership_type,
            listing_id: listingId
        });

        // ── 5. Send email notification via notify.php ─────────────────────────
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
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">Documentos:</td><td style="padding:6px;">${documents.length} archivo(s) recibido(s)</td></tr>
    <tr><td style="padding:6px;font-weight:bold;color:#555;">Listado ATP:</td><td style="padding:6px;">${listingId ? 'Encontrado (ID: '+listingId+')' : 'No encontrado automáticamente'}</td></tr>
    <tr style="background:#f5f5f5;"><td style="padding:6px;font-weight:bold;color:#555;">ID Solicitud:</td><td style="padding:6px;">${application.id}</td></tr>
</table>
<p style="margin-top:1rem;">
    <a href="https://trustedpanamastays.com/admin.html" style="background:#005ca9;color:white;padding:8px 16px;text-decoration:none;border-radius:5px;">
        Ver en Panel de Admin
    </a>
</p>
<p style="color:#888;font-size:12px;margin-top:1rem;">
    Trusted Panama Stays · info@trustedpanamastays.com
</p>
</body></html>`;

        // Call notify.php via execFile
        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        try {
            await execFileAsync('php', [notifyPath, subject, message, 'info@trustedpanamastays.com'], {
                timeout: 15000
            });
            console.log(`✅ Notification email sent for application ${application.id}`);
        } catch (emailErr) {
            // Don't fail the application if email fails
            console.error('❌ Email notification failed:', emailErr.message);
            await logEvent('notification_email_failed', {
                application_id: application.id,
                error: emailErr.message
            });
        }

        // ── 6. Return success ─────────────────────────────────────────────────
        res.json({
            success:        true,
            application_id: application.id,
            listing_found:  !!listingId
        });

    } catch (err) {
        console.error('❌ Membership application error:', err.message);
        await logEvent('membership_application_error', { error: err.message, property_name });
        res.status(500).json({ error: 'Error al procesar la solicitud: ' + err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  APPLICATIONS ENDPOINTS — add to server.js before server.listen()
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

// ── AI verify documents ───────────────────────────────────────────────────────
app.post('/api/admin/verify-documents', requireAdmin, async (req, res) => {
    const { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'Missing application_id' });

    // Get application
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

        // Download each document from Supabase Storage
        for (const doc of app.documents) {
            const { data: fileData, error: dlError } = await supabase.storage
                .from('member-documents')
                .download(doc.path);
            if (dlError) continue;

            const arrayBuffer = await fileData.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');

            // Only send images to vision (skip PDFs for now — Claude Vision handles jpg/png/webp/gif)
            const isPdf = doc.mime === 'application/pdf';
            if (!isPdf) {
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
            return res.status(400).json({ error: 'No image documents available for AI verification. PDF documents must be reviewed manually.' });
        }

        // Build verification prompt
        const prompt = `You are verifying membership application documents for a Panama tourism rental directory.

Application details:
- Property name: ${app.property_name}
- Contact/representative name: ${app.contact_name}
- Province: ${app.province}
- Plan: ${app.membership_type === 'trial' ? 'Free trial' : app.duration_months + ' months paid'}
- Payment method: ${app.payment_method || 'none'}
- Amount expected: ${app.duration_months === 24 ? '$45' : app.duration_months === 12 ? '$24' : 'none (trial)'}

Please verify the documents and return ONLY a JSON object with this structure:
{
  "aviso_operacion": {
    "found": true/false,
    "business_name": "name as shown on document",
    "ruc": "RUC number",
    "ruc_dv": "DV digit",
    "legal_rep": "legal representative name",
    "license_number": "license number",
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

        // Call Claude API
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

        // Save extracted RUC data to listing if found
        if (result.aviso_operacion?.ruc && app.listing_id) {
            await supabase.from('listings').update({
                ruc:            result.aviso_operacion.ruc,
                ruc_dv:         result.aviso_operacion.ruc_dv,
                legal_name:     result.aviso_operacion.business_name,
                license_number: result.aviso_operacion.license_number,
                verified_at:    new Date().toISOString(),
                verified_by:    'ai'
            }).eq('id', app.listing_id);
        }

        await logEvent('ai_verification_completed', {
            application_id,
            result: result.verification.overall_result
        });

        res.json({ success: true, verification: result });

    } catch (err) {
        console.error('AI verification error:', err.message);
        res.status(500).json({ error: 'AI verification failed: ' + err.message });
    }
});

// ── Approve application ───────────────────────────────────────────────────────
app.post('/api/admin/approve-application', requireAdmin, async (req, res) => {
    const bcrypt = require('bcrypt');
    const { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'Missing application_id' });

    const { data: app, error: appError } = await supabase
        .from('membership_applications')
        .select('*')
        .eq('id', application_id)
        .single();
    if (appError || !app) return res.status(404).json({ error: 'Application not found' });

    try {
        // Generate random password
        const chars    = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        const password = Array.from({ length: 10 }, () =>
            chars[Math.floor(Math.random() * chars.length)]).join('');
        const hash = await bcrypt.hash(password, 10);

        // Calculate membership dates
        const isTrial    = app.membership_type === 'trial';
        const daysToAdd  = isTrial ? 30 : 0;
        const yearsToAdd = !isTrial ? (app.duration_months === 24 ? 2 : 1) : 0;
        const paidUntil  = new Date();
        if (daysToAdd)  paidUntil.setDate(paidUntil.getDate() + daysToAdd);
        if (yearsToAdd) paidUntil.setFullYear(paidUntil.getFullYear() + yearsToAdd);
        const paidUntilStr = paidUntil.toISOString().split('T')[0];

        // Generate slug from property name
        const slug = app.property_name
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        // Find or create listing
        let listingId = app.listing_id;
        if (listingId) {
            // Update existing listing
            await supabase.from('listings').update({
                is_member:             true,
                is_trial:              isTrial,
                trial_started_at:      isTrial ? new Date().toISOString() : null,
                membership_paid_until: paidUntilStr,
                member_password:       hash,
                contact_name:          app.contact_name,
                email_member:          app.contact_email,
                phone_member:          app.contact_phone,
                slug:                  slug,
                invitation_status:     'member',
                verified_at:           new Date().toISOString(),
                verified_by:           'admin'
            }).eq('id', listingId);
        }

        // Log invoice data
        if (!isTrial) {
            const amount    = app.duration_months === 24 ? 45 : 24;
            const itbms     = parseFloat((amount * 0.07).toFixed(2));
            const total     = parseFloat((amount + itbms).toFixed(2));
            await supabase.from('event_log').insert({
                event_type: 'invoice_pending',
                event_data: {
                    application_id,
                    listing_id:   listingId,
                    property_name: app.property_name,
                    contact_name:  app.contact_name,
                    contact_email: app.contact_email,
                    ruc:           null,
                    amount,
                    itbms,
                    total,
                    plan:          app.duration_months + ' months',
                    payment_method: app.payment_method,
                    date:          new Date().toISOString()
                },
                created_at: new Date().toISOString()
            });
        }

        // Update application status
        await supabase.from('membership_applications').update({
            status:       'approved',
            reviewed_at:  new Date().toISOString(),
            reviewed_by:  'admin'
        }).eq('id', application_id);

        // Send welcome email
        const listingUrl = listingId
            ? `https://trustedpanamastays.com/listing.html?id=${listingId}&lang=es`
            : `https://trustedpanamastays.com`;

        const planText = isTrial
            ? 'prueba gratuita de 30 días'
            : (app.duration_months === 24 ? 'membresía de 2 años' : 'membresía de 1 año');

        const welcomeMsg = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">¡Bienvenido a Trusted Panama Stays!</h1>
</div>
<p>Estimado/a <strong>${app.contact_name}</strong>,</p>
<p>Su solicitud de membresía ha sido <strong style="color:#00a859;">aprobada</strong>. Su ${planText} para <strong>${app.property_name}</strong> está activa hasta el <strong>${paidUntilStr}</strong>.</p>
<h3 style="color:#005ca9;">Sus datos de acceso:</h3>
<table style="border:1px solid #e1e5e9;border-radius:8px;padding:1rem;background:#f8f9fa;width:100%;">
    <tr><td style="padding:6px;font-weight:bold;">URL de su listado:</td><td style="padding:6px;"><a href="${listingUrl}">${listingUrl}</a></td></tr>
    <tr><td style="padding:6px;font-weight:bold;">Contraseña inicial:</td><td style="padding:6px;font-family:monospace;font-size:1.1rem;"><strong>${password}</strong></td></tr>
</table>
<p style="margin-top:1rem;color:#666;font-size:0.88rem;">Por seguridad, le recomendamos cambiar su contraseña después de su primer acceso.</p>
${isTrial ? `<p style="background:#fffbe6;padding:1rem;border-radius:6px;border:1px solid #FFD700;"><strong>⚠️ Recordatorio:</strong> Su período de prueba vence el <strong>${paidUntilStr}</strong>. Recibirá un recordatorio 5 días antes para continuar con su membresía.</p>` : ''}
<p>Para acceder a su listado y editarlo, visite el enlace arriba y haga clic en <strong>🔐 Acceso</strong>.</p>
<p>¿Preguntas? Escríbanos a <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>
</body></html>`;

        const notifyPath = path.join(__dirname, 'public', 'notify.php');
        await execFileAsync('php', [
            notifyPath,
            `Membresía aprobada - ${app.property_name}`,
            welcomeMsg,
            app.contact_email
        ], { timeout: 15000 }).catch(err =>
            console.error('Welcome email failed:', err.message)
        );

        await logEvent('application_approved', {
            application_id,
            listing_id: listingId,
            membership_type: app.membership_type,
            paid_until: paidUntilStr
        });

        res.json({ success: true, password, paid_until: paidUntilStr, listing_id: listingId });

    } catch (err) {
        console.error('Approve error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Reject application ────────────────────────────────────────────────────────
app.post('/api/admin/reject-application', requireAdmin, async (req, res) => {
    const { application_id, reason, custom_note } = req.body;
    if (!application_id || !reason) return res.status(400).json({ error: 'Missing fields' });

    const { data: app, error: appError } = await supabase
        .from('membership_applications')
        .select('*')
        .eq('id', application_id)
        .single();
    if (appError || !app) return res.status(404).json({ error: 'Not found' });

    await supabase.from('membership_applications').update({
        status:      'rejected',
        notes:       `Razón: ${reason}${custom_note ? '. '+custom_note : ''}`,
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'admin'
    }).eq('id', application_id);

    // Send rejection email
    const rejectionMsg = `
<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:600px;">
<div style="background:linear-gradient(135deg,#005ca9,#00a859);padding:1.5rem;border-radius:10px;margin-bottom:1.5rem;">
    <h1 style="color:white;margin:0;font-size:1.4rem;">Trusted Panama Stays — Su solicitud</h1>
</div>
<p>Estimado/a <strong>${app.contact_name}</strong>,</p>
<p>Hemos revisado su solicitud de membresía para <strong>${app.property_name}</strong>.</p>
<p>Lamentablemente no podemos aprobarla en este momento por la siguiente razón:</p>
<div style="background:#fde8e8;border:1px solid #ffcccc;border-radius:8px;padding:1rem;margin:1rem 0;">
    <strong>${reason}</strong>
    ${custom_note ? `<br><br>${custom_note}` : ''}
</div>
<p>Si desea corregir la situación y volver a aplicar, puede hacerlo en:</p>
<p><a href="https://trustedpanamastays.com/join.html" style="background:#005ca9;color:white;padding:8px 16px;text-decoration:none;border-radius:5px;">Nueva solicitud</a></p>
<p>¿Preguntas? Escríbanos a <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>
<hr style="border:none;border-top:1px solid #e1e5e9;margin:1.5rem 0;">
<p style="color:#888;font-size:0.78rem;">Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21</p>
</body></html>`;

    const notifyPath = path.join(__dirname, 'public', 'notify.php');
    await execFileAsync('php', [
        notifyPath,
        `Solicitud de membresía - ${app.property_name}`,
        rejectionMsg,
        app.contact_email
    ], { timeout: 15000 }).catch(err =>
        console.error('Rejection email failed:', err.message)
    );

    await logEvent('application_rejected', { application_id, reason });
    res.json({ success: true });
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


const server = require('http').createServer({ maxHeaderSize: 81920 }, app);
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Main page: http://localhost:${PORT}`);
    console.log(`📍 Health:    http://localhost:${PORT}/health`);
});

