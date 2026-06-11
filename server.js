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

const server = require('http').createServer({ maxHeaderSize: 81920 }, app);
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Main page: http://localhost:${PORT}`);
    console.log(`📍 Health:    http://localhost:${PORT}/health`);
});

