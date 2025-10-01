const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PDF URL - will be fetched from your United Domains hosting
const PDF_URLS = [
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf'
];

let CURRENT_RENTALS = [];
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';
let PDF_RAW_TEXT = '';

// Enhanced sample data as fallback
const ENHANCED_SAMPLE_RENTALS = [
    {
        id: 1,
        name: "Hotel Boquete Mountain Resort",
        type: "Hotel",
        province: "Chiriquí",
        district: "Boquete",
        phone: "+507 720-1234",
        email: "info@boquetemountain.com",
        description: "Luxury resort in the highlands of Boquete with mountain views and coffee plantation tours.",
        google_maps_url: "https://maps.google.com/?q=Boquete,Chiriquí,Panama",
        whatsapp: "+50761234567"
    },
    {
        id: 2,
        name: "Posada Boquete Valley",
        type: "Posada Turística",
        province: "Chiriquí",
        district: "Boquete",
        phone: "+507 720-5678",
        email: "reservas@boquetevalley.com",
        description: "Charming family-run posada in Boquete valley, known for its garden and homemade meals.",
        google_maps_url: "https://maps.google.com/?q=Boquete,Chiriquí,Panama",
        whatsapp: "+50767654321"
    }
];

// Try to fetch and parse PDF from your hosting
async function fetchAndParsePDF() {
    for (const pdfUrl of PDF_URLS) {
        try {
            console.log(`Trying to fetch PDF from: ${pdfUrl}`);
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                console.log('PDF fetched successfully, parsing...');
                const data = await pdf(response.data);
                PDF_RAW_TEXT = data.text;
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                console.log('PDF text length:', PDF_RAW_TEXT.length);
                console.log('First 500 chars of PDF:', PDF_RAW_TEXT.substring(0, 500));

                const parsedRentals = parsePDFText(PDF_RAW_TEXT);
                console.log(`Parsed ${parsedRentals.length} rentals from PDF`);

                if (parsedRentals.length > 0) {
                    CURRENT_RENTALS = parsedRentals;
                    return true;
                } else {
                    // Fallback to sample data
                    CURRENT_RENTALS = [...ENHANCED_SAMPLE_RENTALS];
                    return false;
                }
            }
        } catch (error) {
            console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
        }
    }

    PDF_STATUS = 'No PDF available, using enhanced sample data';
    CURRENT_RENTALS = [...ENHANCED_SAMPLE_RENTALS];
    return false;
}

// Parse PDF text into rental data - IMPROVED VERSION
function parsePDFText(text) {
    console.log('=== STARTING PDF PARSING ===');
    const rentals = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    let currentProvince = '';
    let rentalCount = 0;

    // Common Panama provinces
    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    console.log(`Total lines in PDF: ${lines.length}`);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip obvious headers and page numbers
        if (line.includes('REPORTE DE HOSPEDAJES') ||
            line.includes('Página') ||
            line.includes('Fecha:') ||
            line.match(/^\d+ de \d+$/)) {
            continue;
        }

        // Detect province headers
        const provinceMatch = provinces.find(province =>
            line.toUpperCase().includes(province)
        );
        if (provinceMatch) {
            currentProvince = provinceMatch;
            console.log(`Found province: ${currentProvince}`);
            continue;
        }

        // Look for potential rental lines (contain contact info or have typical patterns)
        if (isPotentialRentalLine(line)) {
            rentalCount++;
            console.log(`Potential rental line ${rentalCount}: "${line}"`);

            const rentalData = parseRentalLine(line, currentProvince);
            if (rentalData && rentalData.name && rentalData.name.length > 2) {
                console.log(`✓ Parsed rental: ${rentalData.name}`);

                // Enhance with additional data
                const enhancedRental = {
                    ...rentalData,
                    district: guessDistrict(rentalData.name, rentalData.province),
                    description: `Hospedaje ${rentalData.type} registrado en ${rentalData.province}, Panamá. ${rentalData.name} ofrece servicios de hospedaje autorizados por la ATP.`,
                    google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(rentalData.name + ' ' + rentalData.province + ' Panamá')}`,
                    whatsapp: rentalData.phone,
                    source: 'ATP_OFFICIAL'
                };
                rentals.push(enhancedRental);
            } else {
                console.log(`✗ Could not parse line: "${line}"`);
            }
        }
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

function isPotentialRentalLine(line) {
    // A line is potentially a rental if it has:
    // - Email address
    // - Phone number
    // - Multiple words (not just headers)
    // - Not too short
    return (line.includes('@') ||
           line.match(/\+507[\s\d-]+/) ||
           line.match(/\d{3}[- ]?\d{3}[- ]?\d{3}/)) &&
           line.length > 10 &&
           line.split(' ').length >= 3;
}

function parseRentalLine(line, province) {
    console.log(`Parsing line: "${line}"`);

    // Extract email
    const emailMatch = line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const email = emailMatch ? emailMatch[1] : '';

    // Extract phone
    const phoneMatch = line.match(/(\+507[\s\d-]+|\d{3}[- ]?\d{3}[- ]?\d{3,4})/);
    const phone = phoneMatch ? phoneMatch[0] : '';

    // Remove email and phone to get the main text
    let mainText = line
        .replace(email, '')
        .replace(phone, '')
        .replace(/\s+/g, ' ')
        .trim();

    console.log(`Main text after removing contact: "${mainText}"`);

    // Try different parsing strategies
    let name, type;

    // Strategy 1: Split by common separators
    const separators = [' - ', ' | ', '   ', '  '];
    for (const separator of separators) {
        if (mainText.includes(separator)) {
            const parts = mainText.split(separator).filter(p => p.trim().length > 0);
            if (parts.length >= 2) {
                name = parts[0].trim();
                type = parts[1].trim();
                break;
            }
        }
    }

    // Strategy 2: Split by last space (assume last word is type)
    if (!name || !type) {
        const words = mainText.split(' ').filter(w => w.length > 0);
        if (words.length >= 2) {
            type = words.pop();
            name = words.join(' ');
        }
    }

    // Strategy 3: If still no type, use default
    if (name && !type) {
        type = 'Hospedaje';
    }

    if (name && type) {
        console.log(`✓ Success: Name="${name}", Type="${type}", Email="${email}", Phone="${phone}"`);
        return {
            name: name,
            type: type,
            email: email,
            phone: phone,
            province: province
        };
    }

    console.log(`✗ Failed to parse: Name="${name}", Type="${type}"`);
    return null;
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
        'VERAGUAS': 'Santiago'
    };
    return districtMap[province] || province;
}

// API Routes
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals Search API is working!',
        status: 'success',
        timestamp: new Date().toISOString(),
        data_source: PDF_STATUS.includes('PDF processed') ? 'LIVE_ATP_PDF' : 'ENHANCED_SAMPLE_DATA'
    });
});

app.get('/api/rentals', (req, res) => {
    const { search, province, type } = req.query;
    let filtered = CURRENT_RENTALS;

    if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            rental.district.toLowerCase().includes(searchLower) ||
            rental.description.toLowerCase().includes(searchLower) ||
            rental.province.toLowerCase().includes(searchLower) ||
            rental.type.toLowerCase().includes(searchLower)
        );
    }

    if (province && province !== '') {
        filtered = filtered.filter(rental =>
            rental.province.toLowerCase() === province.toLowerCase()
        );
    }

    if (type && type !== '') {
        filtered = filtered.filter(rental =>
            rental.type.toLowerCase() === type.toLowerCase()
        );
    }

    res.json(filtered);
});

app.get('/api/provinces', (req, res) => {
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))].sort();
    res.json(provinces);
});

app.get('/api/types', (req, res) => {
    const types = [...new Set(CURRENT_RENTALS.map(r => r.type))].sort();
    res.json(types);
});

app.get('/api/stats', (req, res) => {
    res.json({
        total_rentals: CURRENT_RENTALS.length,
        last_updated: LAST_PDF_UPDATE || new Date().toISOString(),
        data_source: PDF_STATUS.includes('PDF processed') ? 'LIVE_ATP_DATA' : 'ENHANCED_SAMPLE_DATA',
        status: PDF_STATUS,
        pdf_urls_tested: PDF_URLS
    });
});

app.get('/api/debug-pdf', (req, res) => {
    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        pdf_text_sample: PDF_RAW_TEXT ? PDF_RAW_TEXT.substring(0, 2000) : 'No PDF text available',
        pdf_total_length: PDF_RAW_TEXT ? PDF_RAW_TEXT.length : 0,
        last_update: LAST_PDF_UPDATE,
        rentals_sample: CURRENT_RENTALS.slice(0, 5) // First 5 rentals
    });
});

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            message: success ? 'PDF data refreshed successfully' : 'Failed to refresh PDF data',
            total_rentals: CURRENT_RENTALS.length,
            status: PDF_STATUS,
            last_update: LAST_PDF_UPDATE
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/pdf-status', (req, res) => {
    res.json({
        status: PDF_STATUS,
        last_update: LAST_PDF_UPDATE,
        total_rentals: CURRENT_RENTALS.length,
        tested_urls: PDF_URLS,
        data_source: PDF_STATUS.includes('PDF processed') ? 'ATP_PDF' : 'SAMPLE_DATA'
    });
});

// Initialize - try to fetch PDF on startup
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Frontend: https://atp-rentals-app-production.up.railway.app`);
    console.log(`📊 API Status: https://atp-rentals-app-production.up.railway.app/api/stats`);
    console.log(`🐛 Debug: https://atp-rentals-app-production.up.railway.app/api/debug-pdf`);

    // Try to load PDF data on startup
    setTimeout(async () => {
        console.log('Attempting to load PDF data from hosted location...');
        await fetchAndParsePDF();
        console.log(`Initial data load complete. Using ${CURRENT_RENTALS.length} rentals.`);
    }, 2000);
});
