const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
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
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';
let LAST_ERROR = null;

async function fetchAndParsePDF() {
    for (const pdfUrl of PDF_URLS) {
        try {
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                const data = await pdf(response.data);
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();
                LAST_ERROR = null;

                const parsedRentals = extractAllRentals(data.text);

                if (parsedRentals.length === 0) {
                    LAST_ERROR = 'PDF parsing found 0 rentals';
                    PDF_STATUS = 'ERROR: No rentals found in PDF';
                }

                CURRENT_RENTALS = parsedRentals;
                return parsedRentals.length > 0;
            }
        } catch (error) {
            LAST_ERROR = `Failed to fetch PDF: ${error.message}`;
            PDF_STATUS = 'ERROR: Failed to fetch PDF';
        }
    }

    PDF_STATUS = 'ERROR: No PDF available or accessible';
    CURRENT_RENTALS = [];
    return false;
}

// EFFICIENT EXTRACTION - Minimal logging
function extractAllRentals(text) {
    const rentals = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    let currentProvince = '';
    let currentSection = [];
    let inProvinceSection = false;

    // First pass: group by provinces
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (line.includes('Reporte de Hospedajes vigentes') ||
            line.includes('Reporte: rep_hos_web') ||
            line.includes('Actualizado al') ||
            line.match(/Página \d+ de \d+/)) {
            continue;
        }

        // Detect province start
        const provinceMatch = provinces.find(p => line.includes(p));
        if (provinceMatch && line.includes('Provincia:')) {
            // Process previous section
            if (currentProvince && currentSection.length > 0) {
                const provinceRentals = processProvinceSection(currentSection, currentProvince);
                rentals.push(...provinceRentals);
            }

            // Start new province
            currentProvince = provinceMatch;
            currentSection = [];
            inProvinceSection = true;
            continue;
        }

        // Detect end of province data
        if (inProvinceSection && line.includes('Total por provincia:')) {
            if (currentSection.length > 0) {
                const provinceRentals = processProvinceSection(currentSection, currentProvince);
                rentals.push(...provinceRentals);
            }
            currentSection = [];
            inProvinceSection = false;
            continue;
        }

        // Collect data lines
        if (inProvinceSection && line.length > 2) {
            currentSection.push(line);
        }
    }

    // Process the last province
    if (currentProvince && currentSection.length > 0) {
        const provinceRentals = processProvinceSection(currentSection, currentProvince);
        rentals.push(...provinceRentals);
    }

    return rentals;
}

function processProvinceSection(lines, province) {
    const rentals = [];
    const rentalTypes = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort'];

    let currentRental = { province: province };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip column headers
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
            continue;
        }

        // If line looks like a rental name and we don't have one yet
        if (!currentRental.name && isRentalName(line)) {
            currentRental.name = cleanText(line);
        }
        // If line is a rental type
        else if (!currentRental.type && rentalTypes.some(type => line.includes(type))) {
            currentRental.type = line;
        }
        // If line contains email
        else if (!currentRental.email && line.includes('@')) {
            currentRental.email = extractEmail(line);
        }
        // If line contains phone
        else if (!currentRental.phone && hasPhoneNumbers(line)) {
            currentRental.phone = extractPhone(line);
        }

        // If we have enough data to create a rental, save it and reset
        if (currentRental.name && (currentRental.email || currentRental.phone || i > 10)) {
            // Enhance the rental with additional fields
            const enhancedRental = {
                name: currentRental.name,
                type: currentRental.type || 'Hospedaje',
                email: currentRental.email || '',
                phone: currentRental.phone || '',
                province: province,
                district: guessDistrict(currentRental.name, province),
                description: `${currentRental.type || 'Hospedaje'} "${currentRental.name}" registrado en ${province}, Panamá.`,
                google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(currentRental.name + ' ' + province + ' Panamá')}`,
                whatsapp: currentRental.phone || '',
                source: 'ATP_OFFICIAL'
            };

            rentals.push(enhancedRental);
            currentRental = { province: province };
        }

        // If we've been processing too long without finding a rental, reset
        if (i > 0 && !currentRental.name && lines[i].length < 3) {
            currentRental = { province: province };
        }
    }

    return rentals;
}

// Helper functions
function isRentalName(line) {
    return line.length > 5 &&
           !line.includes('@') &&
           !hasPhoneNumbers(line) &&
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:') &&
           !line.includes('Nombre') &&
           !line.includes('Modalidad') &&
           !line.includes('Correo Principal') &&
           !line.includes('Teléfono');
}

function hasPhoneNumbers(line) {
    return /\d{3,4}[- \/]?\d{3,4}[- \/]?\d{3,4}/.test(line);
}

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractPhone(text) {
    const match = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    return match ? match[1] : '';
}

function cleanText(text) {
    return text.replace(/\s+/g, ' ').trim();
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
        data_source: 'LIVE_ATP_PDF',
        total_rentals: CURRENT_RENTALS.length,
        has_data: CURRENT_RENTALS.length > 0,
        last_error: LAST_ERROR
    });
});

app.get('/api/rentals', (req, res) => {
    if (CURRENT_RENTALS.length === 0) {
        return res.status(503).json({
            error: 'No rental data available',
            message: LAST_ERROR || 'The PDF parsing failed.',
            suggestion: 'Try refreshing the data using POST /api/refresh-pdf'
        });
    }

    const { search, province, type } = req.query;
    let filtered = CURRENT_RENTALS;

    if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            rental.district.toLowerCase().includes(searchLower) ||
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
    if (CURRENT_RENTALS.length === 0) return res.json([]);
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))].sort();
    res.json(provinces);
});

app.get('/api/types', (req, res) => {
    if (CURRENT_RENTALS.length === 0) return res.json([]);
    const types = [...new Set(CURRENT_RENTALS.map(r => r.type))].sort();
    res.json(types);
});

app.get('/api/stats', (req, res) => {
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))];
    const provinceCounts = {};
    provinces.forEach(province => {
        provinceCounts[province] = CURRENT_RENTALS.filter(r => r.province === province).length;
    });

    res.json({
        total_rentals: CURRENT_RENTALS.length,
        last_updated: LAST_PDF_UPDATE || new Date().toISOString(),
        data_source: 'LIVE_ATP_DATA',
        status: PDF_STATUS,
        last_error: LAST_ERROR,
        has_data: CURRENT_RENTALS.length > 0,
        provinces: provinceCounts,
        note: CURRENT_RENTALS.length === 0 ? 'ERROR: No data extracted from PDF' : 'Datos oficiales de la Autoridad de Turismo de Panamá'
    });
});

app.get('/api/debug', (req, res) => {
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))];
    const provinceSamples = {};

    provinces.forEach(province => {
        const provinceRentals = CURRENT_RENTALS.filter(r => r.province === province);
        provinceSamples[province] = {
            count: provinceRentals.length,
            sample: provinceRentals.slice(0, 3)
        };
    });

    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        last_update: LAST_PDF_UPDATE,
        last_error: LAST_ERROR,
        has_data: CURRENT_RENTALS.length > 0,
        provinces_found: provinces.length,
        provinces: provinceSamples,
        data_quality: {
            with_names: CURRENT_RENTALS.filter(r => r.name && r.name.length > 2).length,
            with_emails: CURRENT_RENTALS.filter(r => r.email).length,
            with_phones: CURRENT_RENTALS.filter(r => r.phone).length,
            with_types: CURRENT_RENTALS.filter(r => r.type && r.type !== 'Hospedaje').length
        }
    });
});

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            message: success ?
                `PDF data refreshed successfully. Found ${CURRENT_RENTALS.length} rentals.` :
                `Failed to refresh PDF data. Error: ${LAST_ERROR}`,
            total_rentals: CURRENT_RENTALS.length,
            status: PDF_STATUS,
            last_error: LAST_ERROR,
            last_update: LAST_PDF_UPDATE
        });
    } catch (error) {
        res.status(500).json({
            error: error.message,
            message: 'Failed to refresh PDF data'
        });
    }
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        console.log('Loading PDF data...');
        const success = await fetchAndParsePDF();
        if (success) {
            console.log(`✅ Success! ${CURRENT_RENTALS.length} ATP rentals loaded`);
        } else {
            console.log(`❌ Failed to load PDF data: ${LAST_ERROR}`);
        }
    }, 2000);
});
