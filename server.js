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
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf',
    'https://aparthotel-boquete.com/hospedajes/atp-rentals.pdf',
    'https://aparthotel-boquete.com/hospedajes/latest.pdf'
];

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
    },
    {
        id: 3,
        name: "Bocas del Toro Beach Hotel",
        type: "Hotel",
        province: "Bocas del Toro",
        district: "Bocas del Toro",
        phone: "+507 123-4567",
        email: "stay@bocasbeach.com",
        description: "Beachfront hotel with Caribbean views, perfect for diving and island hopping.",
        google_maps_url: "https://maps.google.com/?q=Bocas+del+Toro,Panama",
        whatsapp: "+50761234568"
    },
    {
        id: 4,
        name: "Panama City Business Hotel",
        type: "Hotel",
        province: "Panamá",
        district: "San Francisco",
        phone: "+507 234-5678",
        email: "book@panamabusiness.com",
        description: "Modern hotel in downtown Panama City with business center and conference facilities.",
        google_maps_url: "https://maps.google.com/?q=Panama+City,Panama",
        whatsapp: "+50761234569"
    },
    {
        id: 5,
        name: "Coronado Beach Resort",
        type: "Resort",
        province: "Panamá",
        district: "Coronado",
        phone: "+507 345-6789",
        email: "reservations@coronadoresort.com",
        description: "All-inclusive beach resort with golf course and spa facilities.",
        google_maps_url: "https://maps.google.com/?q=Coronado,Panama",
        whatsapp: "+50761234570"
    }
];

let CURRENT_RENTALS = [...ENHANCED_SAMPLE_RENTALS];
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';

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
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                const parsedRentals = parsePDFText(data.text);
                if (parsedRentals.length > 0) {
                    CURRENT_RENTALS = parsedRentals;
                    console.log(`Successfully parsed ${parsedRentals.length} rentals from PDF`);
                    return true;
                }
            }
        } catch (error) {
            console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
        }
    }

    PDF_STATUS = 'No PDF available, using enhanced sample data';
    return false;
}

// Parse PDF text into rental data
function parsePDFText(text) {
    console.log('Parsing PDF text...');
    const rentals = [];
    const lines = text.split('\n');

    let currentProvince = '';

    // Common Panama provinces
    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip empty lines and headers
        if (!line || line.length < 5) continue;
        if (line.includes('REPORTE DE HOSPEDAJES') || line.includes('Página')) continue;

        // Detect province headers
        const provinceMatch = provinces.find(province =>
            line.toUpperCase().includes(province)
        );
        if (provinceMatch) {
            currentProvince = provinceMatch;
            console.log('Found province:', currentProvince);
            continue;
        }

        // Try to parse rental lines (look for contact info)
        if (line.includes('@') || line.match(/\+507[\s\d-]+/) || line.match(/\d{3}[- ]?\d{3}[- ]?\d{3}/)) {
            const rentalData = parseRentalLine(line, currentProvince);
            if (rentalData && rentalData.name && rentalData.name.length > 2) {
                // Enhance with additional data
                const enhancedRental = {
                    ...rentalData,
                    district: guessDistrict(rentalData.name, rentalData.province),
                    description: `Hospedaje ${rentalData.type} registrado en ${rentalData.province}, Panamá. ${rentalData.name} ofrece servicios de hospedaje autorizados por la ATP.`,
                    google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(rentalData.name + ' ' + rentalData.province + ' Panamá')}`,
                    whatsapp: rentalData.phone
                };
                rentals.push(enhancedRental);
            }
        }
    }

    console.log(`Parsed ${rentals.length} rentals from PDF`);
    return rentals.length > 0 ? rentals : ENHANCED_SAMPLE_RENTALS;
}

function parseRentalLine(line, province) {
    line = line.replace(/\s+/g, ' ').trim();

    // Extract email
    const emailMatch = line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const email = emailMatch ? emailMatch[1] : '';

    // Extract phone
    const phoneMatch = line.match(/(\+507[\s\d-]+|\d{3}[- ]?\d{3}[- ]?\d{3})/);
    const phone = phoneMatch ? phoneMatch[0] : '';

    // Remove email and phone to get name and type
    let remainingLine = line
        .replace(email, '')
        .replace(phone, '')
        .replace(/\s+/g, ' ')
        .trim();

    const parts = remainingLine.split(' ').filter(part => part.length > 0);

    if (parts.length >= 2) {
        const type = parts.pop();
        const name = parts.join(' ');

        return {
            name: name.trim(),
            type: type.trim(),
            email: email.trim(),
            phone: phone.trim(),
            province: province
        };
    }

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

    // Try to load PDF data on startup
    setTimeout(async () => {
        console.log('Attempting to load PDF data from hosted location...');
        await fetchAndParsePDF();
        console.log(`Initial data load complete. Using ${CURRENT_RENTALS.length} rentals.`);
    }, 2000);
});
