const express = require('express');
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PDF_URLS = [
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf'
];

let CURRENT_RENTALS = [];
let PROVINCE_STATS = {};
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';

// Column boundaries based on your analysis
const COLUMN_BOUNDARIES = {
    NOMBRE: { start: 0, end: 184 },
    MODALIDAD: { start: 184, end: 265 },
    CORREO: { start: 265, end: 481 },
    TELEFONO: { start: 481, end: 600 }
};

// PDF parsing with table detection and row stitching
async function fetchAndParsePDF() {
    for (const pdfUrl of PDF_URLS) {
        try {
            console.log(`Fetching PDF from: ${pdfUrl}`);
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                console.log('PDF fetched, parsing with table detection...');
                const result = await parsePDFTables(response.data);
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                console.log(`Parsed ${result.rentals.length} rentals from PDF (Expected: ${result.totalExpected})`);
                console.log('Province statistics:', result.provinceStats);

                CURRENT_RENTALS = result.rentals;
                PROVINCE_STATS = result.provinceStats;
                return true;
            }
        } catch (error) {
            console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
        }
    }

    PDF_STATUS = 'No PDF available';
    CURRENT_RENTALS = getFallbackData();
    PROVINCE_STATS = {};
    return false;
}

async function parsePDFTables(pdfBuffer) {
    try {
        const data = new Uint8Array(pdfBuffer);
        const pdf = await pdfjsLib.getDocument(data).promise;
        const numPages = pdf.numPages;
        const allRentals = [];
        const provinceStats = {};
        let totalExpected = 0;

        console.log(`Processing ${numPages} pages for table analysis...`);

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            console.log(`Analyzing page ${pageNum}...`);
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();

            // Extract text with precise positioning
            const textItems = textContent.items.map(item => ({
                text: item.str,
                x: Math.round(item.transform[4] * 100) / 100,
                y: Math.round(item.transform[5] * 100) / 100,
                width: item.width,
                height: item.height,
                page: pageNum
            }));

            const pageResult = parsePageRentals(textItems, pageNum);
            allRentals.push(...pageResult.rentals);

            // Merge province stats
            Object.keys(pageResult.provinceStats).forEach(province => {
                if (!provinceStats[province]) {
                    provinceStats[province] = 0;
                }
                provinceStats[province] += pageResult.provinceStats[province];
            });

            totalExpected += pageResult.expectedCount;
        }

        return {
            rentals: allRentals,
            provinceStats: provinceStats,
            totalExpected: totalExpected
        };
    } catch (error) {
        console.error('Error in parsePDFTables:', error);
        const fallback = getFallbackData();
        return {
            rentals: fallback,
            provinceStats: {},
            totalExpected: fallback.length
        };
    }
}

function parsePageRentals(textItems, pageNum) {
    const rentals = [];
    const provinceStats = {};
    let expectedCount = 0;

    // Group into rows
    const rows = groupIntoRows(textItems);

    // Look for table patterns and process data rows
    let currentProvince = '';
    let inTable = false;
    let currentRental = null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowText = row.items.map(item => item.text).join(' ');

        // Detect province and expected count
        if (rowText.includes('Provincia:')) {
            currentProvince = rowText.replace('Provincia:', '').trim();
            continue;
        }

        // Detect expected count for province
        const countMatch = rowText.match(/(\d+)Total por provincia:/);
        if (countMatch && currentProvince) {
            expectedCount = parseInt(countMatch[1]);
            provinceStats[currentProvince] = expectedCount;
            continue;
        }

        // Detect table header
        if (rowText.includes('Nombre') && rowText.includes('Modalidad')) {
            inTable = true;
            continue;
        }

        // Detect table end
        if (rowText.includes('Total por provincia:')) {
            inTable = false;
            // Process any pending rental
            if (currentRental) {
                rentals.push(createCompleteRental(currentRental, currentProvince));
                currentRental = null;
            }
            continue;
        }

        if (inTable && currentProvince) {
            const rowData = parseRowData(row);

            if (isNewRentalRow(rowData)) {
                // Save previous rental if exists
                if (currentRental) {
                    rentals.push(createCompleteRental(currentRental, currentProvince));
                }

                // Start new rental
                currentRental = rowData;
                currentRental.province = currentProvince;
            } else if (currentRental && isContinuationRow(rowData, currentRental)) {
                // This is a continuation row - merge with current rental
                currentRental = mergeRentalRows(currentRental, rowData);
            }
        }
    }

    // Don't forget the last rental
    if (currentRental) {
        rentals.push(createCompleteRental(currentRental, currentProvince));
    }

    return {
        rentals: rentals,
        provinceStats: provinceStats,
        expectedCount: expectedCount
    };
}

function parseRowData(row) {
    const rental = {
        name: '',
        type: '',
        email: '',
        phone: ''
    };

    // Assign items to columns based on X position
    row.items.forEach(item => {
        if (item.x >= COLUMN_BOUNDARIES.NOMBRE.start && item.x < COLUMN_BOUNDARIES.NOMBRE.end) {
            rental.name += (rental.name ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.MODALIDAD.start && item.x < COLUMN_BOUNDARIES.MODALIDAD.end) {
            rental.type += (rental.type ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.CORREO.start && item.x < COLUMN_BOUNDARIES.CORREO.end) {
            rental.email += item.text; // No space for emails
        } else if (item.x >= COLUMN_BOUNDARIES.TELEFONO.start && item.x < COLUMN_BOUNDARIES.TELEFONO.end) {
            rental.phone += (rental.phone ? ' ' : '') + item.text;
        }
    });

    // Clean the data
    rental.name = rental.name.trim();
    rental.type = rental.type.trim();
    rental.email = rental.email.trim();
    rental.phone = rental.phone.trim();

    return rental;
}

function isNewRentalRow(rowData) {
    // A row is considered a new rental if:
    // 1. It has a substantial name (more than 2 characters)
    // 2. AND it has a type OR the name looks complete
    return rowData.name.length > 2 &&
           (rowData.type.length > 0 || rowData.name.split(' ').length >= 2);
}

function isContinuationRow(rowData, currentRental) {
    // This is a continuation row if:
    // 1. The current rental has no type AND this row has "Familiar" in type
    // 2. OR the current rental's email is incomplete (no @ or no .com)
    // 3. OR the current rental's phone ends with "/" or "-"
    // 4. OR this row has no type but has content in other columns

    const hasFamiliarType = rowData.type.includes('Familiar') && currentRental.type === 'Hostal';
    const hasIncompleteEmail = currentRental.email &&
                              (!currentRental.email.includes('@') ||
                               !currentRental.email.includes('.'));
    const hasIncompletePhone = currentRental.phone &&
                              (currentRental.phone.endsWith('/') ||
                               currentRental.phone.endsWith('-'));
    const hasNoTypeButContent = !rowData.type && (rowData.name || rowData.email || rowData.phone);

    return hasFamiliarType || hasIncompleteEmail || hasIncompletePhone || hasNoTypeButContent;
}

function mergeRentalRows(currentRental, continuationRow) {
    const merged = { ...currentRental };

    // Merge name with space
    if (continuationRow.name) {
        merged.name = (currentRental.name + ' ' + continuationRow.name).trim();
    }

    // Merge type (usually "Familiar" to complete "Hostal Familiar")
    if (continuationRow.type) {
        merged.type = (currentRental.type + ' ' + continuationRow.type).trim();
    }

    // Merge email without space
    if (continuationRow.email) {
        merged.email = (currentRental.email + continuationRow.email).trim();
    }

    // Merge phone with special handling - keep ALL phone numbers
    if (continuationRow.phone) {
        if (currentRental.phone.endsWith('/')) {
            merged.phone = (currentRental.phone + ' ' + continuationRow.phone).trim();
        } else if (currentRental.phone.endsWith('-')) {
            merged.phone = (currentRental.phone.slice(0, -1) + continuationRow.phone).trim();
        } else {
            // If we already have a phone and get another one, combine them
            merged.phone = (currentRental.phone + ' / ' + continuationRow.phone).trim();
        }
    }

    return merged;
}

function createCompleteRental(rentalData, province) {
    const cleanName = cleanText(rentalData.name);
    const cleanType = cleanText(rentalData.type) || 'Hospedaje';
    const cleanEmail = extractEmail(rentalData.email);
    const cleanPhone = extractAllPhones(rentalData.phone); // Changed to extract ALL phones
    const whatsappPhone = formatWhatsAppNumber(extractFirstPhone(rentalData.phone));

    return {
        name: cleanName,
        type: cleanType,
        email: cleanEmail,
        phone: cleanPhone, // Now contains all phone numbers
        province: province,
        district: guessDistrict(cleanName, province),
        description: generateDescription(cleanName, cleanType, province),
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(cleanName + ' ' + province + ' Panamá')}`,
        whatsapp: whatsappPhone,
        whatsapp_url: whatsappPhone ? `https://wa.me/${whatsappPhone}` : '',
        source: 'ATP_OFFICIAL'
    };
}

// Extract ALL phone numbers (not just first)
function extractAllPhones(text) {
    if (!text) return '';
    try {
        // Remove extra spaces but keep the separators
        return text.replace(/\s+/g, ' ').trim();
    } catch (error) {
        return '';
    }
}

// WhatsApp number formatting
function formatWhatsAppNumber(phone) {
    if (!phone) return '';

    // Remove all non-digit characters
    let cleanPhone = phone.replace(/\D/g, '');

    // Ensure it's 8 digits and starts with 6
    if (cleanPhone.length === 8 && cleanPhone.startsWith('6')) {
        return '507' + cleanPhone;
    }

    // If it's already 11 digits with 507 prefix
    if (cleanPhone.length === 11 && cleanPhone.startsWith('507')) {
        return cleanPhone;
    }

    return ''; // Invalid format for WhatsApp
}

// Helper functions
function groupIntoRows(textItems) {
    const rows = {};
    const Y_TOLERANCE = 1.5;

    textItems.forEach(item => {
        if (!item.text.trim()) return;

        const existingKey = Object.keys(rows).find(y =>
            Math.abs(parseFloat(y) - item.y) <= Y_TOLERANCE
        );

        const rowY = existingKey || item.y.toString();
        if (!rows[rowY]) rows[rowY] = [];
        rows[rowY].push(item);
    });

    // Convert to array and sort by Y (top to bottom)
    return Object.entries(rows)
        .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
        .map(([y, items]) => ({
            y: parseFloat(y),
            items: items.sort((a, b) => a.x - b.x)
        }));
}

function cleanText(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

function extractEmail(text) {
    if (!text) return '';
    try {
        const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        return match ? match[1] : '';
    } catch (error) {
        return '';
    }
}

function extractFirstPhone(text) {
    if (!text) return '';
    try {
        // Remove slashes and hyphens, take first 8 digits
        const cleanText = text.replace(/[-\/\s]/g, '');
        const match = cleanText.match(/(\d{7,8})/);
        return match ? match[1] : '';
    } catch (error) {
        return '';
    }
}

function guessDistrict(name, province) {
    const districtMap = {
        'BOCAS DEL TORO': 'Bocas del Toro',
        'CHIRIQUÍ': 'David',
        'COCLÉ': 'Penonomé',
        'COLÓN': 'Colón',
        'DARIÉN': 'La Palma',
        'HERRERA': 'Chitré',
        'LOS SANTOS': 'Las Tablas',
        'PANAMÁ': 'Ciudad de Panamá',
        'PANAMÁ OESTE': 'La Chorrera',
        'VERAGUAS': 'Santiago',
        'GUNAS': 'Guna Yala',
        'EMBERÁ': 'Emberá',
        'NGÄBE-BUGLÉ': 'Ngäbe-Buglé'
    };
    return districtMap[province] || province;
}

function generateDescription(name, type, province) {
    return `${type} "${name}" ubicado en ${province}, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).`;
}

function getFallbackData() {
    return [
        {
            name: "APARTHOTEL BOQUETE",
            type: "Aparta-Hotel",
            email: "info@aparthotel-boquete.com",
            phone: "68916669 / 68916660",
            province: "CHIRIQUÍ",
            district: "Boquete",
            description: "Aparta-Hotel \"APARTHOTEL BOQUETE\" ubicado en CHIRIQUÍ, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).",
            google_maps_url: "https://maps.google.com/?q=APARTHOTEL%20BOQUETE%20BOQUETE%20Panam%C3%A1",
            whatsapp: "50768916669",
            whatsapp_url: "https://wa.me/50768916669",
            source: "ATP_OFFICIAL"
        }
    ];
}

// API ROUTES
app.get('/api/test', (req, res) => {
    try {
        res.json({
            message: 'ATP Rentals Search API is working!',
            status: 'success',
            timestamp: new Date().toISOString(),
            data_source: 'LIVE_ATP_PDF',
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            total_expected: PROVINCE_STATS ? Object.values(PROVINCE_STATS).reduce((a, b) => a + b, 0) : 0
        });
    } catch (error) {
        console.error('Error in /api/test:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/rentals', (req, res) => {
    try {
        const { search, province, type } = req.query;
        let filtered = CURRENT_RENTALS || [];

        // If no filters applied, return empty array with message
        if (!search && !province && !type) {
            return res.json([]);
        }

        if (search) {
            const searchLower = search.toLowerCase();
            filtered = filtered.filter(rental =>
                rental && rental.name && rental.name.toLowerCase().includes(searchLower) ||
                (rental.district && rental.district.toLowerCase().includes(searchLower)) ||
                (rental.description && rental.description.toLowerCase().includes(searchLower)) ||
                (rental.province && rental.province.toLowerCase().includes(searchLower)) ||
                (rental.type && rental.type.toLowerCase().includes(searchLower))
            );
        }

        if (province && province !== '') {
            filtered = filtered.filter(rental =>
                rental && rental.province && rental.province.toLowerCase() === province.toLowerCase()
            );
        }

        if (type && type !== '') {
            filtered = filtered.filter(rental =>
                rental && rental.type && rental.type.toLowerCase() === type.toLowerCase()
            );
        }

        res.json(filtered);
    } catch (error) {
        console.error('Error in /api/rentals:', error);
        res.status(500).json({ error: 'Error al buscar hospedajes' });
    }
});

app.get('/api/provinces', (req, res) => {
    try {
        const provinces = CURRENT_RENTALS ?
            [...new Set(CURRENT_RENTALS.map(r => r?.province).filter(Boolean))].sort() : [];

        // Add counts to province names
        const provincesWithCounts = provinces.map(province => ({
            name: province,
            count: PROVINCE_STATS[province] || 0,
            displayName: `${province} (${PROVINCE_STATS[province] || 0})`
        }));

        res.json(provincesWithCounts);
    } catch (error) {
        console.error('Error in /api/provinces:', error);
        res.status(500).json({ error: 'Error cargando provincias' });
    }
});

app.get('/api/types', (req, res) => {
    try {
        const types = CURRENT_RENTALS ?
            [...new Set(CURRENT_RENTALS.map(r => r?.type).filter(Boolean))].sort() : [];
        res.json(types);
    } catch (error) {
        console.error('Error in /api/types:', error);
        res.status(500).json({ error: 'Error cargando tipos' });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        const totalExpected = PROVINCE_STATS ? Object.values(PROVINCE_STATS).reduce((a, b) => a + b, 0) : 0;

        res.json({
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            total_expected: totalExpected,
            last_updated: LAST_PDF_UPDATE || new Date().toISOString(),
            data_source: 'LIVE_ATP_DATA',
            status: PDF_STATUS,
            province_stats: PROVINCE_STATS,
            note: 'Datos oficiales de la Autoridad de Turismo de Panamá'
        });
    } catch (error) {
        console.error('Error in /api/stats:', error);
        res.status(500).json({ error: 'Error cargando estadísticas' });
    }
});

app.get('/api/debug-pdf', (req, res) => {
    try {
        const sampleWithContacts = CURRENT_RENTALS ?
            CURRENT_RENTALS.filter(rental => rental && (rental.email || rental.phone)).slice(0, 5) : [];

        res.json({
            pdf_status: PDF_STATUS,
            total_rentals_found: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            total_expected: PROVINCE_STATS ? Object.values(PROVINCE_STATS).reduce((a, b) => a + b, 0) : 0,
            last_update: LAST_PDF_UPDATE,
            sample_with_contacts: sampleWithContacts,
            all_provinces: PROVINCE_STATS || {},
            all_types: CURRENT_RENTALS ?
                [...new Set(CURRENT_RENTALS.map(r => r?.type).filter(Boolean))] : []
        });
    } catch (error) {
        console.error('Error in /api/debug-pdf:', error);
        res.status(500).json({ error: 'Error en debug' });
    }
});

// Keep other endpoints the same (debug-tables, refresh-pdf, health)

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            message: success ? 'PDF data refreshed successfully' : 'Failed to refresh PDF data',
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            total_expected: PROVINCE_STATS ? Object.values(PROVINCE_STATS).reduce((a, b) => a + b, 0) : 0,
            status: PDF_STATUS,
            last_update: LAST_PDF_UPDATE
        });
    } catch (error) {
        console.error('Error in /api/refresh-pdf:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    const totalExpected = PROVINCE_STATS ? Object.values(PROVINCE_STATS).reduce((a, b) => a + b, 0) : 0;

    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        rentals_loaded: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
        total_expected: totalExpected,
        pdf_status: PDF_STATUS
    });
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);

    setTimeout(async () => {
        try {
            await fetchAndParsePDF();
            const totalExpected = PROVINCE_STATS ? Object.values(PROVINCE_STATS).reduce((a, b) => a + b, 0) : 0;
            console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded (Expected: ${totalExpected})`);
        } catch (error) {
            console.error('Error during startup:', error);
            CURRENT_RENTALS = getFallbackData();
        }
    }, 2000);
});
