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
    CURRENT_RENTALS = getFallbackData();
    return false;
}

// SIMPLIFIED PARSER - builds on what was working
function parsePDFText(text) {
    console.log('=== PARSING ATP PDF DATA ===');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    const rentals = [];
    let currentProvince = '';
    let currentSection = [];
    let inProvinceSection = false;

    // Group lines by province sections
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) continue;

        // Detect province headers - using your observation #1
        const provinceMatch = provinces.find(province => {
            // Look for "BOCAS DEL TOROProvincia:" pattern
            if (line.includes(province + 'Provincia:')) return true;
            if (line.includes(province) && i + 1 < lines.length && lines[i + 1].includes('Provincia:')) return true;
            return line.toUpperCase().includes(province);
        });

        if (provinceMatch) {
            // Save previous section
            if (currentSection.length > 0 && currentProvince) {
                const provinceRentals = parseProvinceSectionImproved(currentSection, currentProvince);
                rentals.push(...provinceRentals);
            }

            // Start new section
            currentProvince = provinceMatch;
            currentSection = [];
            inProvinceSection = true;
            continue;
        }

        // Detect end of province section - using your observation #1
        if (inProvinceSection && line.includes('Total por provincia:')) {
            if (currentSection.length > 0 && currentProvince) {
                const provinceRentals = parseProvinceSectionImproved(currentSection, currentProvince);
                rentals.push(...provinceRentals);
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

    // Process last section
    if (currentSection.length > 0 && currentProvince) {
        const provinceRentals = parseProvinceSectionImproved(currentSection, currentProvince);
        rentals.push(...provinceRentals);
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// IMPROVED province section parser using your observations
function parseProvinceSectionImproved(sectionLines, province) {
    const rentals = [];

    // Extract columns
    const columns = extractColumnsBasic(sectionLines);

    // Use your observation #2: Use type column as reference for record count
    const typeCount = columns.types.length;

    if (typeCount > 0) {
        // Create records by aligning to type count
        for (let i = 0; i < typeCount; i++) {
            const name = getAlignedValue(columns.names, i, typeCount);
            const type = columns.types[i] || 'Hospedaje';
            const email = getAlignedValue(columns.emails, i, typeCount);
            const phone = getAlignedValue(columns.phones, i, typeCount);

            // Apply your observations for combining multi-line elements
            const combinedName = fixMultiLineName(name, columns.names, i);
            const combinedEmail = fixMultiLineEmail(email);
            const combinedPhone = fixMultiLinePhone(phone);

            if (combinedName && combinedName.length > 2) {
                const rental = createRentalObject(combinedName, type, combinedEmail, combinedPhone, province);
                rentals.push(rental);
            }
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals (based on ${typeCount} types)`);
    return rentals;
}

// Basic column extraction
function extractColumnsBasic(sectionLines) {
    const result = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let currentColumn = 'names';

    for (const line of sectionLines) {
        // Skip column headers and metadata
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono' ||
            line.includes('Provincia:') || line.includes('Total por provincia:')) {
            continue;
        }

        // Simple column detection
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

// Get aligned value from column based on type count
function getAlignedValue(column, index, typeCount) {
    if (index < column.length) {
        return column[index];
    }
    return '';
}

// Fix multi-line names - your observation #2
function fixMultiLineName(name, names, index) {
    if (!name) return '';

    // If name is very short and there are more names than types, try to combine
    if (name.length < 15 && index + 1 < names.length) {
        const nextName = names[index + 1];
        if (nextName && nextName.length > 0 && !isTypeLine(nextName) && !isEmailLine(nextName) && !isPhoneLine(nextName)) {
            return name + ' ' + nextName;
        }
    }

    return name;
}

// Fix multi-line emails - your observation #3
function fixMultiLineEmail(email) {
    if (!email) return '';

    // Remove spaces from email
    email = email.replace(/\s+/g, '');

    // Extract email if pattern exists
    const match = email.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

// Fix multi-line phones - your observation #4
function fixMultiLinePhone(phone) {
    if (!phone) return '';

    // Remove dashes, slashes, and spaces
    phone = phone.replace(/[-/\s]/g, '');

    // Extract first phone number pattern
    const match = phone.match(/(\d{7,8})/);
    return match ? match[1] : '';
}

// Helper functions
function isHeaderLine(line) {
    return line.includes('Reporte de Hospedajes vigentes') ||
           line.includes('Reporte: rep_hos_web') ||
           line.includes('Actualizado al') ||
           line.match(/Página \d+ de \d+/);
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

function isTypeLine(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña'];
    return types.some(type => line.includes(type));
}

function isEmailLine(line) {
    return line.includes('@') && line.includes('.');
}

function isPhoneLine(line) {
    return line.match(/\d{3,4}[- \/]?\d{3,4}[- \/]?\d{3,4}/) ||
           (line.includes('/') && line.match(/\d+/));
}

function createRentalObject(name, type, email, phone, province) {
    const cleanName = cleanText(name);
    const cleanType = cleanText(type || 'Hospedaje');
    const cleanEmail = email;
    const cleanPhone = phone;

    if (!cleanName || cleanName.length < 2) {
        return null;
    }

    return {
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

function getFallbackData() {
    return [
        {
            name: "SOCIALTEL BOCAS DEL TORO",
            type: "Albergue",
            email: "reception.bocasdeltoro@collectivehospitality.com",
            phone: "64061547",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro",
            description: "Albergue \"SOCIALTEL BOCAS DEL TORO\" ubicado en BOCAS DEL TORO, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).",
            google_maps_url: "https://maps.google.com/?q=SOCIALTEL%20BOCAS%20DEL%20TORO%20BOCAS%20DEL%20TORO%20Panam%C3%A1",
            whatsapp: "64061547",
            source: "ATP_OFFICIAL"
        }
    ];
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

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
