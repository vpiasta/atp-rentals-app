// scripts/update-listings.js
// Runs as a GitHub Action — fetches ATP page, parses PDF, updates Supabase
// Smart merge: only updates changed fields, preserves member data

const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
}

const supabaseHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
};

// ═════════════════════════════════════════════════════════════════════════════
//  NORMALIZATION
// ═════════════════════════════════════════════════════════════════════════════
function normalize(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')  // remove accents
        .replace(/[^a-z0-9\s]/g, '')       // remove special chars
        .replace(/\s+/g, ' ');             // collapse spaces
}

// ═════════════════════════════════════════════════════════════════════════════
//  SUPABASE REST HELPERS
// ═════════════════════════════════════════════════════════════════════════════
async function getAllListings() {
    // Fetch all existing listings in batches of 1000
    let allData = [];
    let from = 0;
    const BATCH = 1000;
    while (true) {
        const res = await axios.get(
            `${SUPABASE_URL}/rest/v1/listings?select=*&offset=${from}&limit=${BATCH}`,
            { headers: supabaseHeaders }
        );
        allData = allData.concat(res.data);
        if (res.data.length < BATCH) break;
        from += BATCH;
    }
    console.log(`📋 Loaded ${allData.length} existing listings from Supabase`);
    return allData;
}

async function insertListing(listing) {
    const res = await axios.post(
        `${SUPABASE_URL}/rest/v1/listings`,
        listing,
        { headers: supabaseHeaders }
    );
    return res.data[0];
}

async function updateListing(id, fields) {
    await axios.patch(
        `${SUPABASE_URL}/rest/v1/listings?id=eq.${id}`,
        fields,
        { headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' } }
    );
}

async function getSavedPdfMeta() {
    const res = await axios.get(
        `${SUPABASE_URL}/rest/v1/pdf_meta?limit=1`,
        { headers: supabaseHeaders }
    );
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
            { headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' } }
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

// ═════════════════════════════════════════════════════════════════════════════
//  SMART MERGE LOGIC
// ═════════════════════════════════════════════════════════════════════════════
function findMatch(pdfRental, existingListings) {
    const normName     = normalize(pdfRental.name);
    const normProvince = normalize(pdfRental.province);
    const normEmail    = normalize(pdfRental.email);
    const normPhone    = normalize(pdfRental.phone);

    // Step 1: Match by normalized name + province (strongest signal)
    const byNameProvince = existingListings.find(e =>
        normalize(e.name) === normName &&
        normalize(e.province) === normProvince
    );
    if (byNameProvince) return { match: byNameProvince, method: 'name+province' };

    // Step 2: Match by email (catches name changes)
    if (normEmail) {
        const byEmail = existingListings.find(e =>
            e.email && normalize(e.email) === normEmail
        );
        if (byEmail) return { match: byEmail, method: 'email' };
    }

    // Step 3: Match by phone (catches name + email changes)
    if (normPhone) {
        const byPhone = existingListings.find(e =>
            e.phone && normalize(e.phone) === normPhone
        );
        if (byPhone) return { match: byPhone, method: 'phone' };
    }

    return null;
}

async function smartMerge(pdfRentals, existingListings) {
    const today = new Date().toISOString().split('T')[0];
    const stats = {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deactivated: 0
    };

    // Track which existing IDs were matched
    const matchedIds = new Set();

    for (const pdfRental of pdfRentals) {
        const result = findMatch(pdfRental, existingListings);

        if (result) {
            // Existing listing found
            const existing = result.match;
            matchedIds.add(existing.id);

            // Compare ATP fields — only update what changed
            const changes = {};
            const changedFieldNames = [];

            if (existing.name !== pdfRental.name) {
                changes.name = pdfRental.name;
                changedFieldNames.push(`name: "${existing.name}" → "${pdfRental.name}"`);
            }
            if (existing.rental_type !== pdfRental.rental_type) {
                changes.rental_type = pdfRental.rental_type;
                changedFieldNames.push(`rental_type: "${existing.rental_type}" → "${pdfRental.rental_type}"`);
            }
            if (existing.email !== pdfRental.email) {
                changes.email = pdfRental.email;
                changedFieldNames.push(`email: "${existing.email}" → "${pdfRental.email}"`);
            }
            if (existing.phone !== pdfRental.phone) {
                changes.phone = pdfRental.phone;
                changedFieldNames.push(`phone: "${existing.phone}" → "${pdfRental.phone}"`);
            }
            if (existing.province !== pdfRental.province) {
                changes.province = pdfRental.province;
                changedFieldNames.push(`province: "${existing.province}" → "${pdfRental.province}"`);
            }

            // Always update atp_last_seen and ensure atp_active = true
            changes.atp_last_seen = today;
            changes.atp_active = true;

            if (changedFieldNames.length > 0) {
                changes.changed_fields = changedFieldNames.join('; ');
                console.log(`  ✏️  Updated [${result.method}]: ${existing.name} — ${changes.changed_fields}`);
                stats.updated++;
            } else {
                stats.unchanged++;
            }

            await updateListing(existing.id, changes);

        } else {
            // New listing — insert it
            const newListing = {
                name: pdfRental.name,
                rental_type: pdfRental.rental_type,
                email: pdfRental.email,
                phone: pdfRental.phone,
                province: pdfRental.province,
                atp_active: true,
                atp_first_seen: today,
                atp_last_seen: today,
                changed_fields: null,
                invitation_sent_at: null
            };
            await insertListing(newListing);
            console.log(`  ➕ New listing: ${pdfRental.name} (${pdfRental.province})`);
            stats.inserted++;
        }
    }

    // Deactivate listings no longer in ATP list
    const deactivated = existingListings.filter(e =>
        e.atp_active && !matchedIds.has(e.id)
    );

    for (const gone of deactivated) {
        await updateListing(gone.id, {
            atp_active: false,
            changed_fields: 'Removed from ATP list'
        });
        console.log(`  ❌ Deactivated: ${gone.name} (${gone.province})`);
        stats.deactivated++;
        // TODO: send "what happened?" email when email system is ready
    }

    return stats;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ATP PAGE & PDF FUNCTIONS
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

    const pdfLinkRegex = /<a[^>]+href="([^"]*\.pdf)"[^>]*>\s*Descargar\s*PDF\s*<\/a>/i;
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

    const fallbackRegex = /href="(https?:\/\/www\.atp\.gob\.pa\/[^"]*\.pdf)"/i;
    const fallbackMatch = html.match(fallbackRegex);
    if (fallbackMatch) {
        console.log('⚠️  Fallback PDF URL:', fallbackMatch[1]);
        return { pdfUrl: fallbackMatch[1], headingText: null };
    }

    throw new Error('Could not find PDF URL on ATP page');
}

// ─── Column boundaries ────────────────────────────────────────────────────────
const COLUMN_BOUNDARIES = {
    NOMBRE:    { start: 0,   end: 184 },
    MODALIDAD: { start: 184, end: 265 },
    CORREO:    { start: 265, end: 481 },
    TELEFONO:  { start: 481, end: 600 }
};

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
                (rowData.rental_type || rowData.email || rowData.phone)) {
                allRentals.push(currentRental);
                currentRental = { ...rowData, province: currentProvince };
            } else if (!currentRental && rowData.name && rowData.name.trim() &&
                       (rowData.rental_type || rowData.email || rowData.phone)) {
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

// ─── PDF parsing helpers ──────────────────────────────────────────────────────
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

function isHeaderRow(rowText) {
    return rowText.includes('Reporte de Hospedajes vigentes') ||
           rowText.includes('Página') ||
           rowText.includes('Total por provincia') ||
           rowText.includes('rep_hos_web') ||
           (rowText.includes('Nombre') && (rowText.includes('Modalidad') || rowText.includes('Correo')));
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

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
    console.log('═══════════════════════════════════════════════');
    console.log('  TrustedPanamaStays — Smart Listing Updater');
    console.log('  ' + new Date().toISOString());
    console.log('═══════════════════════════════════════════════');

    try {
        // Step 1: Get current PDF URL from ATP
        const { pdfUrl, headingText } = await getLatestPdfUrl();

        // Step 2: Compare with saved URL
        const savedMeta = await getSavedPdfMeta();
        const savedUrl = savedMeta ? savedMeta.pdf_url : null;

        if (pdfUrl === savedUrl) {
            console.log('✅ PDF URL unchanged — no update needed');
            process.exit(0);
        }

        console.log('🆕 New PDF detected!');
        console.log('   Old:', savedUrl || '(none)');
        console.log('   New:', pdfUrl);

        // Step 3: Parse the PDF
        const pdfRentals = await downloadAndParsePdf(pdfUrl);
        if (pdfRentals.length === 0) {
            throw new Error('PDF parsed but returned 0 listings — aborting');
        }

        // Step 4: Load existing listings from Supabase
        const existingListings = await getAllListings();

        // Step 5: Smart merge
        console.log('🔄 Running smart merge...');
        const stats = await smartMerge(pdfRentals, existingListings);

        // Step 6: Save PDF meta
        await savePdfMeta(pdfUrl, headingText);

        console.log('═══════════════════════════════════════════════');
        console.log(`✅ SUCCESS`);
        console.log(`   ➕ Inserted:    ${stats.inserted}`);
        console.log(`   ✏️  Updated:     ${stats.updated}`);
        console.log(`   ✓  Unchanged:   ${stats.unchanged}`);
        console.log(`   ❌ Deactivated: ${stats.deactivated}`);
        console.log('═══════════════════════════════════════════════');
        process.exit(0);

    } catch (err) {
        console.error('❌ FAILED:', err.message);
        process.exit(1);
    }
}

main();