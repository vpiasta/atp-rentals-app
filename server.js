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

// FINAL IMPROVED PARSER - Properly aligns columnar data
function parsePDFText(text) {
    console.log('=== PARSING ATP PDF DATA ===');
    const rentals = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    let currentProvince = '';
    let currentSection = [];
    let inProvinceSection = false;

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    // Group lines by province sections
    const provinceSections = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (line.includes('Reporte de Hospedajes vigentes') ||
            line.includes('Reporte: rep_hos_web') ||
            line.includes('Actualizado al') ||
            line.match(/Página \d+ de \d+/)) {
            continue;
        }

        // Detect province headers
        const provinceMatch = provinces.find(province =>
            line.toUpperCase().includes(province)
        );

        if (provinceMatch) {
            // Save previous section
            if (currentSection.length > 0 && currentProvince) {
                provinceSections.push({
                    province: currentProvince,
                    lines: [...currentSection]
                });
            }

            // Start new section
            currentProvince = provinceMatch;
            currentSection = [];
            inProvinceSection = true;
            continue;
        }

        // Detect end of province section
        if (line.includes('Total por provincia:') && inProvinceSection) {
            if (currentSection.length > 0 && currentProvince) {
                provinceSections.push({
                    province: currentProvince,
                    lines: [...currentSection]
                });
            }
            currentSection = [];
            inProvinceSection = false;
            continue;
        }

        // Add to current section
        if (inProvinceSection && line.length > 2) {
            currentSection.push(line);
        }
    }

    // Parse each province section with improved column alignment
    for (const section of provinceSections) {
        const provinceRentals = parseProvinceWithColumns(section.lines, section.province);
        rentals.push(...provinceRentals);
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// NEW: Parse province data with proper column alignment
function parseProvinceWithColumns(lines, province) {
    const rentals = [];

    // The data is in columns: Names, Types, Emails, Phones
    // We need to group them properly

    const columnGroups = groupIntoColumns(lines);

    if (columnGroups.names.length > 0) {
        // Create rentals by aligning the columns
        for (let i = 0; i < columnGroups.names.length; i++) {
            const name = columnGroups.names[i] || '';
            const type = columnGroups.types[i] || 'Hospedaje';
            const email = columnGroups.emails[i] || '';
            const phone = columnGroups.phones[i] || '';

            if (name && name.length > 2) {
                const cleanName = cleanText(name);
                const cleanType = cleanText(type);
                const cleanEmail = extractEmail(email);
                const cleanPhone = extractFirstPhone(phone);

                const rental = {
                    name: cleanName,
                    type: cleanType,
                    email: cleanEmail,
                    phone: cleanPhone,
                    province: province,
                    district: guessDistrict(cleanName, province),
                    description: generateDescription(cleanName, cleanType, province),
                    google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(cleanName + ' ' + province + ' Panamá')}`,
                    whatsapp: cleanPhone,
                    source: 'ATP_OFFICIAL'
                };

                rentals.push(rental);
            }
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals`);
    return rentals;
}

// Group lines into the four columns
function groupIntoColumns(lines) {
    const result = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let currentColumn = 'names';

    for (const line of lines) {
        // Skip column headers
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
            continue;
        }

        // Detect column changes based on content patterns
        if (isEmailLine(line)) {
            currentColumn = 'emails';
        } else if (isPhoneLine(line)) {
            currentColumn = 'phones';
        } else if (isTypeLine(line)) {
            currentColumn = 'types';
        } else if (isNameLine(line)) {
            currentColumn = 'names';
        }

        // Add to appropriate column
        if (currentColumn === 'names' && isNameLine(line)) {
            result.names.push(line);
        } else if (currentColumn === 'types' && isTypeLine(line)) {
            result.types.push(line);
        } else if (currentColumn === 'emails' && isEmailLine(line)) {
            result.emails.push(line);
        } else if (currentColumn === 'phones' && isPhoneLine(line)) {
            result.phones.push(line);
        }
    }

    return result;
}

// Helper functions
function isEmailLine(line) {
    return line.includes('@') && line.includes('.');
}

function isPhoneLine(line) {
    return line.match(/\d{3,4}[- \/]?\d{3,4}[- \/]?\d{3,4}/) ||
           (line.includes('/') && line.match(/\d+/));
}

function isTypeLine(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge'];
    return types.some(type => line.includes(type));
}

function isNameLine(line) {
    return line.length > 3 &&
           !line.includes('@') &&
           !isPhoneLine(line) &&
           !isTypeLine(line) &&
           line !== 'Nombre' &&
           line !== 'Modalidad' &&
           line !== 'Correo Principal' &&
           line !== 'Teléfono';
}

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    // Extract the first phone number pattern
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

// API Routes (same as before)
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
        data_source: 'LIVE_ATP_DATA',
        status: PDF_STATUS,
        note: 'Datos oficiales de la Autoridad de Turismo de Panamá'
    });
});

app.get('/api/debug-pdf', (req, res) => {
    const sampleWithContacts = CURRENT_RENTALS
        .filter(rental => rental.email || rental.phone)
        .slice(0, 10);

    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        last_update: LAST_PDF_UPDATE,
        sample_with_contacts: sampleWithContacts,
        all_provinces: [...new Set(CURRENT_RENTALS.map(r => r.province))],
        all_types: [...new Set(CURRENT_RENTALS.map(r => r.type))]
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
    console.log(`📍 Frontend: https://atp-rentals-app-production.up.railway.app`);
    console.log(`📊 Live Data: ${CURRENT_RENTALS.length} rentals from ATP PDF`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
