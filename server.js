const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PDF URL
const PDF_URLS = [
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf'
];

let CURRENT_RENTALS = [];
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';

async function fetchAndParsePDF() {
    for (const pdfUrl of PDF_URLS) {
        try {
            console.log(`Fetching PDF from: ${pdfUrl}`);
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                console.log('PDF fetched, parsing...');
                const data = await pdf(response.data);
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                const parsedRentals = parsePDFText(data.text);
                console.log(`Parsed ${parsedRentals.length} rentals from PDF`);

                CURRENT_RENTALS = parsedRentals;
                return true;
            }
        } catch (error) {
            console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
        }
    }

    PDF_STATUS = 'No PDF available';
    CURRENT_RENTALS = [];
    return false;
}

// NEW: Advanced parser that understands the table structure
function parsePDFText(text) {
    console.log('=== ADVANCED PDF PARSING ===');
    const rentals = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    let currentProvince = '';
    let inDataSection = false;
    let dataLines = [];

    // First, identify and extract data sections for each province
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
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p));
        if (provinceMatch && line.includes('Provincia:')) {
            // Process previous province data if exists
            if (currentProvince && dataLines.length > 0) {
                const provinceRentals = parseProvinceData(dataLines, currentProvince);
                rentals.push(...provinceRentals);
            }

            // Start new province
            currentProvince = provinceMatch;
            dataLines = [];
            inDataSection = true;
            console.log(`Processing province: ${currentProvince}`);
            continue;
        }

        // Detect end of province data (when we see the total count)
        if (inDataSection && line.includes('Total por provincia:')) {
            inDataSection = false;
            continue;
        }

        // Collect data lines for current province
        if (inDataSection && line.length > 2) {
            dataLines.push(line);
        }
    }

    // Process the last province
    if (currentProvince && dataLines.length > 0) {
        const provinceRentals = parseProvinceData(dataLines, currentProvince);
        rentals.push(...provinceRentals);
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// Parse data for a single province
function parseProvinceData(lines, province) {
    const rentals = [];

    // The data is organized in blocks of 4 lines per rental:
    // Line 1: Name
    // Line 2: Type (Modalidad)
    // Line 3: Email
    // Line 4: Phone

    let currentBlock = [];
    const rentalBlocks = [];

    // Group lines into blocks of 4
    for (const line of lines) {
        // Skip column headers
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
            continue;
        }

        currentBlock.push(line);

        // When we have 4 lines, we have a complete rental block
        if (currentBlock.length === 4) {
            rentalBlocks.push([...currentBlock]);
            currentBlock = [];
        }
    }

    // Process each rental block
    for (const block of rentalBlocks) {
        if (block.length === 4) {
            const [nameLine, typeLine, emailLine, phoneLine] = block;

            const rental = createRentalFromBlock(nameLine, typeLine, emailLine, phoneLine, province);
            if (rental && rental.name && rental.name.length > 2) {
                rentals.push(rental);
            }
        }
    }

    // If block parsing didn't work well, try alternative parsing
    if (rentals.length === 0) {
        console.log(`Trying alternative parsing for ${province}`);
        const altRentals = parseAlternative(lines, province);
        rentals.push(...altRentals);
    }

    console.log(`Province ${province}: ${rentals.length} rentals`);
    return rentals;
}

// Create rental from a 4-line block
function createRentalFromBlock(nameLine, typeLine, emailLine, phoneLine, province) {
    const name = cleanName(nameLine);
    const type = cleanType(typeLine);
    const email = extractCompleteEmail(emailLine);
    const phone = extractBestPhone(phoneLine);

    if (!name || name.length < 2) {
        return null;
    }

    return {
        name: name,
        type: type,
        email: email,
        phone: phone,
        province: province,
        district: guessDistrict(name, province),
        description: `Hospedaje ${type} "${name}" registrado en ${province}, Panamá.`,
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(name + ' ' + province + ' Panamá')}`,
        whatsapp: phone,
        source: 'ATP_OFFICIAL'
    };
}

// Alternative parsing method for difficult cases
function parseAlternative(lines, province) {
    const rentals = [];
    const rentalTypes = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort'];

    let currentRental = {};

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
            continue;
        }

        // If line looks like a name (starts with capital, no @, no numbers)
        if (isLikelyName(line) && !currentRental.name) {
            currentRental.name = cleanName(line);
        }
        // If line is a known rental type
        else if (rentalTypes.some(type => line.includes(type)) && !currentRental.type) {
            currentRental.type = line;
        }
        // If line contains email
        else if (line.includes('@') && !currentRental.email) {
            currentRental.email = extractCompleteEmail(line);
        }
        // If line contains phone numbers
        else if (hasPhoneNumbers(line) && !currentRental.phone) {
            currentRental.phone = extractBestPhone(line);
        }

        // If we have a complete rental, save it
        if (currentRental.name && (currentRental.type || currentRental.email || currentRental.phone)) {
            const rental = {
                name: currentRental.name,
                type: currentRental.type || 'Hospedaje',
                email: currentRental.email || '',
                phone: currentRental.phone || '',
                province: province,
                district: guessDistrict(currentRental.name, province),
                description: `Hospedaje registrado en ${province}, Panamá.`,
                google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(currentRental.name + ' ' + province + ' Panamá')}`,
                whatsapp: currentRental.phone || '',
                source: 'ATP_OFFICIAL'
            };
            rentals.push(rental);
            currentRental = {};
        }
    }

    return rentals;
}

// Helper functions
function cleanName(text) {
    return text.replace(/\s+/g, ' ').trim();
}

function cleanType(text) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort'];
    const foundType = types.find(type => text.includes(type));
    return foundType || text || 'Hospedaje';
}

function extractCompleteEmail(text) {
    // Handle email addresses that might be split across lines
    const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return emailMatch ? emailMatch[1] : '';
}

function extractBestPhone(text) {
    // Extract the first complete phone number
    const phoneMatch = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    return phoneMatch ? phoneMatch[1] : '';
}

function isLikelyName(text) {
    return text.length > 3 &&
           !text.includes('@') &&
           !hasPhoneNumbers(text) &&
           text !== 'Nombre' &&
           text !== 'Modalidad' &&
           text !== 'Correo Principal' &&
           text !== 'Teléfono';
}

function hasPhoneNumbers(text) {
    return /\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}/.test(text) || text.includes('/');
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
        'VERAGUAS': 'Santiago',
        'GUNAS': 'Guna Yala',
        'EMBERÁ': 'Emberá',
        'NGÄBE-BUGLÉ': 'Ngäbe-Buglé'
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
        total_rentals: CURRENT_RENTALS.length
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
        data_source: 'LIVE_ATP_DATA',
        status: PDF_STATUS,
        note: 'Datos oficiales de la Autoridad de Turismo de Panamá'
    });
});

// Enhanced debug endpoint
app.get('/api/debug-pdf', (req, res) => {
    // Get first 20 rentals from Bocas del Toro to verify data quality
    const bocasRentals = CURRENT_RENTALS
        .filter(rental => rental.province === 'BOCAS DEL TORO')
        .slice(0, 20);

    const sampleRentals = CURRENT_RENTALS.slice(0, 10);

    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        last_update: LAST_PDF_UPDATE,
        bocas_del_toro_sample: bocasRentals,
        general_sample: sampleRentals,
        provinces_count: [...new Set(CURRENT_RENTALS.map(r => r.province))].length,
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
            message: success ? 'PDF data refreshed successfully' : 'Failed to refresh PDF data',
            total_rentals: CURRENT_RENTALS.length,
            status: PDF_STATUS,
            last_update: LAST_PDF_UPDATE
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
