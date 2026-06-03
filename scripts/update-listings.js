// scripts/update-listings.js
// Runs as a GitHub Action — fetches ATP page, parses PDF, updates Supabase
// Uses direct REST API calls — no Supabase JS client, no WebSocket needed

const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
}

// Direct REST calls — no Supabase JS client, no WebSocket issue
const supabaseHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
};

async function getSavedPdfMeta() {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/pdf_meta?limit=1`, {
        headers: { ...supabaseHeaders, 'Prefer': 'return=representation' }
    });
    return res.data.length > 0 ? res.data[0] : null;
}

async function savePdfMeta(pdfUrl, pdfHeading) {
    const existing = await getSavedPdfMeta();
    const payload = {
        pdf_url: pdfUrl,
        pdf_heading: pdfHeading,
        last_updated: new Date().toISOString()
    };
    if (existing) {
        await axios.patch(
            `${SUPABASE_URL}/rest/v1/pdf_meta?id=eq.${existing.id}`,
            payload,
            { headers: supabaseHeaders }
        );
    } else {
        await axios.post(
            `${SUPABASE_URL}/rest/v1/pdf_meta`,
            payload,
            { headers: supabaseHeaders }
        );
    }
    console.log('✅ pdf_meta saved');
}

async function saveListingsToDB(rentals) {
    console.log(`💾 Saving ${rentals.length} listings...`);
    // Delete all existing rows
    await axios.delete(
        `${SUPABASE_URL}/rest/v1/listings?id=neq.0`,
        { headers: supabaseHeaders }
    );
    // Insert in batches of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < rentals.length; i += BATCH_SIZE) {
        const batch = rentals.slice(i, i + BATCH_SIZE);
        await axios.post(
            `${SUPABASE_URL}/rest/v1/listings`,
            batch,
            { headers: supabaseHeaders }
        );
        console.log(`  ✅ Batch ${Math.floor(i/BATCH_SIZE)+1}: rows ${i+1}–${Math.min(i+BATCH_SIZE, rentals.length)}`);
    }
    console.log(`✅ All ${rentals.length} listings saved`);
}

// ─── Column boundaries (same as server.js) ───────────────────────────────────
const COLUMN_BOUNDARIES = {
    NOMBRE:    { start: 0,   end: 184 },
    MODALIDAD: { start: 184, end: 265 },
    CORREO:    { start: 265, end: 481 },
    TELEFONO:  { start: 481, end: 600 }
};

// ═════════════════════════════════════════════════════════════════════════════
//  STEP 1 — Get the latest PDF URL from the ATP website
// ═════════════════════════════════════════════════════════════════════════════
async function getLatestPdfUrl() {
    const atpUrl = 'https://www.atp.gob.pa/industrias/hoteleros/';
    console.log('🔄 Fetching ATP page:', atpUrl);

    const response = await axios.get(atpUrl, {
        timeout: 20000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-PA,es;q=0.9,en;q=0.8',
        }
    });

    const html = response.data;
    console.log(`✅ ATP page fetched (${html.length} bytes)`);

    // Match the "Descargar PDF" button link
    const pdfLinkRegex = /<a[^>]+href="([^"]*\.pdf)"[^>]*>\s*Descargar PDF\s*<\/a>/i;
    const match = html.match(pdfLinkRegex);
    if (match) {
        const pdfUrl = new URL(match[1], atpUrl).href;
        console.log('✅ PDF URL found:', pdfUrl);
        const h3Match = html.match(/<h3[^>]*>([^<]*Actualizado[^<]*)<\/h3>/i);
        const headingText = h3Match
            ? `Hospedajes - ${h3Match[1].trim()}`
            : 'Hospedajes - Registrados por la Autoridad de Turismo de Panamá (ATP)';
        return { pdfUrl, headingText };
    }

    // Fallback: any PDF link from atp.gob.pa
    const fallbackRegex = /href="(https:\/\/www\.atp\.gob\.pa\/[^"]*\.pdf)"/i;
    const fallbackMatch = html.match(fallbackRegex);
    if (fallbackMatch) {
        console.log('⚠️  Using fallback PDF URL:', fallbackMatch[1]);
        return { pdfUrl: fallbackMatch[1], headingText: null };
    }

    throw new Error('Could not find PDF URL on ATP page');
}

// ═════════════════════════════════════════════════════════════════════════════
//  STEP 2 — Download and parse the PDF
// ═════════════════════════════════════════════════════════════════════════════
async function downloadAndParsePdf(pdfUrl) {
    console.log('📥 Downloading PDF:', pdfUrl);
    const response = await axios.get(pdfUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/pdf, */*',
            'Referer': 'https://www.atp.gob.pa/'
        }
    });

    const data = new Uint8Array(response.data);
    if (!(data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)) {
        throw new Error('Downloaded file is not a valid PDF');
    }
    console.log(`✅ PDF downloaded (${data.length} bytes)`);

    const pdf = await pdfjsLib.getDocument(data).promise;
    const numPages = pdf.numPages;
    console.log(`📄 PDF has ${numPages} pages`);

    const allRentals = [];
    let currentProvince = '';
    let currentRental = null;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        process.stdout.write(`  Processing page ${pageNum}/${numPages}...\r`);
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        const textItems = textContent.items.map(item => ({
            text: item.str,
            x: Math.round(item.transform[4] * 100) / 100,
            y: Math.round(item.transform[5] * 100) / 100,
        }));

        const rows = groupIntoRows(textItems);

        for (const row of rows) {
            const rowText = row.items.map(i => i.text).join(' ');

            if (rowText.includes('Provincia:')) {
                currentProvince = rowText.replace('Provincia:', '').replace(/Total.*/, '').trim();
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
    console.log(`\n✅ Parsed ${allRentals.length} listings from ${numPages} pages`);
    return allRentals;
}

// ═════════════════════════════════════════════════════════════════════════════
//  PDF PARSING HELPERS (identical to server.js)
// ═════════════════════════════════════════════════════════════════════════════
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
    const rental = { name: '', type: '', email: '', phone: '' };
    row.items.forEach(item => {
        if (item.x >= COLUMN_BOUNDARIES.NOMBRE.start && item.x < COLUMN_BOUNDARIES.NOMBRE.end) {
            rental.name += (rental.name ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.MODALIDAD.start && item.x < COLUMN_BOUNDARIES.MODALIDAD.end) {
            rental.type += (rental.type ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.CORREO.start && item.x < COLUMN_BOUNDARIES.CORREO.end) {
            rental.email += item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.TELEFONO.start && item.x < COLUMN_BOUNDARIES.TELEFONO.end) {
            rental.phone += (rental.phone ? ' ' : '') + item.text;
        }
    });
    rental.name = rental.name.trim();
    rental.type = rental.type.trim();
    rental.email = rental.email.trim();
    rental.phone = rental.phone.trim();
    return rental;
}

function isHeaderRow(rowText) {
    return rowText.includes('Reporte de Hospedajes vigentes') ||
           rowText.includes('Página') ||
           rowText.includes('Total por provincia') ||
           rowText.includes('rep_hos_web') ||
           (rowText.includes('Nombre') && (rowText.includes('Modalidad') || rowText.includes('Correo')));
}

function isContinuationRow(rowData, previousRowData) {
    if (previousRowData.type === 'Hostal' && rowData.type === 'Familiar') return true;
    if (previousRowData.type === 'Sitio de' && rowData.type === 'acampar') return true;
    if (!rowData.type) return true;
    if (previousRowData.email && rowData.email && !rowData.type) {
        const complete = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(previousRowData.email);
        if (!complete) return true;
    }
    if (previousRowData.phone && rowData.phone && !rowData.type) {
        if (previousRowData.phone.endsWith('-')) return true;
        if (previousRowData.phone.endsWith('/') && !rowData.phone.endsWith('/')) return true;
    }
    return false;
}

function mergeRentalRows(prev, cont) {
    const merged = { ...prev };
    if (cont.name) merged.name = (prev.name + ' ' + cont.name).trim();
    if (cont.type) {
        if (prev.type === 'Hostal' && cont.type === 'Familiar') merged.type = 'Hostal Familiar';
        else if (prev.type === 'Sitio de' && cont.type === 'acampar') merged.type = 'Sitio de acampar';
    }
    if (cont.email) merged.email = (prev.email + cont.email).trim();
    if (cont.phone) {
        if (prev.phone.endsWith('/')) merged.phone = (prev.phone + ' ' + cont.phone).trim();
        else if (prev.phone.endsWith('-')) merged.phone = (prev.phone.slice(0, -1) + cont.phone).trim();
        else merged.phone = (prev.phone + ' ' + cont.phone).trim();
    }
    return merged;
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
    console.log('═══════════════════════════════════════');
    console.log('  TrustedPanamaStays — Listing Updater');
    console.log('  ' + new Date().toISOString());
    console.log('═══════════════════════════════════════');

    try {
        const { pdfUrl, headingText } = await getLatestPdfUrl();

        const savedMeta = await getSavedPdfMeta();
        const savedUrl = savedMeta ? savedMeta.pdf_url : null;

        if (pdfUrl === savedUrl) {
            console.log('✅ PDF URL unchanged — database is already up to date');
            process.exit(0);
        }

        console.log('🆕 New PDF detected!');
        console.log('   Old:', savedUrl || '(none)');
        console.log('   New:', pdfUrl);

        const rentals = await downloadAndParsePdf(pdfUrl);

        if (rentals.length === 0) {
            throw new Error('PDF parsed but returned 0 listings — aborting to protect existing data');
        }

        await saveListingsToDB(rentals);
        await savePdfMeta(pdfUrl, headingText);

        console.log('═══════════════════════════════════════');
        console.log(`✅ SUCCESS: ${rentals.length} listings updated`);
        console.log('═══════════════════════════════════════');
        process.exit(0);

    } catch (err) {
        console.error('❌ FAILED:', err.message);
        process.exit(1);
    }
}

main();
