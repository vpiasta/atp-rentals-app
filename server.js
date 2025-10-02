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

// COMPLETELY NEW PARSER: Handles tabular column structure
function parsePDFText(text) {
    console.log('=== PARSING ATP PDF DATA ===');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ', 'PANAMÁ OESTE'
    ];

    const rentals = [];
    let currentProvince = '';

    // Process each province section
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) continue;

        // Detect province
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch) {
            currentProvince = provinceMatch;

            // Extract the data section for this province
            const sectionEnd = findSectionEnd(lines, i);
            const sectionLines = lines.slice(i, sectionEnd);

            // Parse this province section
            const provinceRentals = parseProvinceSection(sectionLines, currentProvince);
            rentals.push(...provinceRentals);

            // Skip to end of section
            i = sectionEnd - 1;
        }
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// NEW: Parse province section by extracting the 4 columns
function parseProvinceSection(sectionLines, province) {
    const rentals = [];

    // Extract the four columns from the section
    const columns = extractColumns(sectionLines);

    // Combine columns into records
    if (columns.names.length > 0) {
        const recordCount = columns.names.length;

        for (let i = 0; i < recordCount; i++) {
            const name = columns.names[i] || '';
            const type = columns.types[i] || '';
            const email = columns.emails[i] || '';
            const phone = columns.phones[i] || '';

            // Validate and create rental
            if (name && name.length > 2 && !isEmailLine(name) && !isPhoneLine(name)) {
                const rental = createRentalObject(name, type, email, phone, province);
                if (rental) {
                    rentals.push(rental);
                }
            }
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals`);
    return rentals;
}

// NEW: Extract the four columns from a province section
function extractColumns(sectionLines) {
    const columns = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    // Find where each column starts
    let nameStart = -1, typeStart = -1, emailStart = -1, phoneStart = -1;

    for (let i = 0; i < sectionLines.length; i++) {
        const line = sectionLines[i];

        // Look for column headers
        if (line === 'Nombre' || (isNameLine(line) && nameStart === -1)) {
            nameStart = i;
        } else if (line === 'Modalidad' || (isTypeLine(line) && typeStart === -1)) {
            typeStart = i;
        } else if (line === 'Correo Principal' || (isEmailLine(line) && emailStart === -1)) {
            emailStart = i;
        } else if (line === 'Teléfono' || (isPhoneLine(line) && phoneStart === -1)) {
            phoneStart = i;
        }
    }

    // If we couldn't find headers, use content-based detection
    if (nameStart === -1) {
        for (let i = 0; i < sectionLines.length; i++) {
            const line = sectionLines[i];
            if (isNameLine(line) && !line.includes('Provincia:') && !line.includes('Total')) {
                nameStart = i;
                break;
            }
        }
    }

    if (typeStart === -1) {
        for (let i = 0; i < sectionLines.length; i++) {
            const line = sectionLines[i];
            if (isTypeLine(line) && line !== 'Modalidad') {
                typeStart = i;
                break;
            }
        }
    }

    if (emailStart === -1) {
        for (let i = 0; i < sectionLines.length; i++) {
            const line = sectionLines[i];
            if (isEmailLine(line) && line !== 'Correo Principal') {
                emailStart = i;
                break;
            }
        }
    }

    if (phoneStart === -1) {
        for (let i = 0; i < sectionLines.length; i++) {
            const line = sectionLines[i];
            if (isPhoneLine(line) && line !== 'Teléfono') {
                phoneStart = i;
                break;
            }
        }
    }

    // Extract data from each column
    if (nameStart !== -1) {
        columns.names = extractColumnData(sectionLines, nameStart, 'name');
    }
    if (typeStart !== -1) {
        columns.types = extractColumnData(sectionLines, typeStart, 'type');
    }
    if (emailStart !== -1) {
        columns.emails = extractColumnData(sectionLines, emailStart, 'email');
    }
    if (phoneStart !== -1) {
        columns.phones = extractColumnData(sectionLines, phoneStart, 'phone');
    }

    return columns;
}

// NEW: Extract data from a specific column
function extractColumnData(sectionLines, startIndex, columnType) {
    const data = [];
    let i = startIndex;

    while (i < sectionLines.length) {
        const line = sectionLines[i];

        // Skip headers and metadata
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono' ||
            line.includes('Provincia:') || line.includes('Total por provincia:') ||
            isHeaderLine(line)) {
            i++;
            continue;
        }

        // Check if we've reached the next column or end of section
        if ((columnType === 'name' && (isTypeLine(line) || isEmailLine(line) || isPhoneLine(line))) ||
            (columnType === 'type' && (isEmailLine(line) || isPhoneLine(line))) ||
            (columnType === 'email' && isPhoneLine(line)) ||
            i - startIndex > 200) { // Safety limit
            break;
        }

        // Add valid data
        if (columnType === 'name' && isNameLine(line)) {
            data.push(line);
        } else if (columnType === 'type' && isTypeLine(line)) {
            data.push(line);
        } else if (columnType === 'email' && isEmailLine(line)) {
            data.push(line);
        } else if (columnType === 'phone' && isPhoneLine(line)) {
            data.push(line);
        }

        i++;
    }

    return data;
}

// NEW: Find the end of a province section
function findSectionEnd(lines, startIndex) {
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('Total por provincia:') ||
            line.includes('Total Provincial:') ||
            line.match(/Página \d+ de \d+/)) {
            return i + 1;
        }
    }
    return lines.length;
}

// NEW: Create rental object with proper validation
function createRentalObject(name, type, email, phone, province) {
    // Clean and validate data
    const cleanName = cleanText(name);
    const cleanType = cleanText(type || 'Hospedaje');
    const cleanEmail = extractEmail(email);
    const cleanPhone = extractFirstPhone(phone);

    // Validate that name is not actually an email or phone
    if (cleanEmail && cleanName.includes('@')) {
        return null;
    }
    if (cleanPhone && isPhoneLine(cleanName)) {
        return null;
    }
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

// IMPROVED: Better helper functions
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
           line !== 'Teléfono' &&
           !line.match(/^-+$/) &&
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:');
}

function isTypeLine(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña', 'Glamping', 'Camping'];
    return types.some(type => line.toUpperCase().includes(type.toUpperCase()));
}

function isEmailLine(line) {
    return line.includes('@') &&
           (line.includes('.com') || line.includes('.net') || line.includes('.org') ||
            line.includes('.edu') || line.includes('.gob') || line.includes('.pa'));
}

function isPhoneLine(line) {
    // More specific phone patterns
    const phonePatterns = [
        /^\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}$/,
        /^\d{7,8}$/,
        /^\d{3,4}[- ]?\d{3,4}$/,
        /^\d{4}[- ]?\d{4}$/
    ];
    const cleanLine = line.replace(/\//g, '').trim();
    return phonePatterns.some(pattern => pattern.test(cleanLine));
}

function extractEmail(text) {
    if (!text) return '';
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    if (!text) return '';
    // Extract the first complete phone number
    const match = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    if (match) return match[1].replace(/[- ]/g, '');

    // Try for shorter numbers
    const shortMatch = text.match(/(\d{7,8})/);
    return shortMatch ? shortMatch[1] : '';
}

function cleanText(text) {
    if (!text) return '';
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
        'NGÄBE-BUGLÉ': 'Ngäbe-Buglé',
        'PANAMÁ OESTE': 'Arraiján'
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
        // Add more fallback records as needed
    ];
}

// Keep all your existing API routes (they remain the same)
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
