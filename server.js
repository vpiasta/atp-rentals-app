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

                const parsedRentals = parsePDFVerticalColumns(data.text);
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

// NEW: Parse PDF with vertical column structure
function parsePDFVerticalColumns(text) {
    console.log('=== PARSING VERTICAL COLUMNS ===');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    const rentals = [];
    let currentProvince = '';
    let columnData = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let inDataSection = false;
    let currentColumn = 'names';
    let columnStartIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers and metadata
        if (isHeaderLine(line)) continue;

        // Detect province headers
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch) {
            // Process previous province data
            if (columnData.names.length > 0 && currentProvince) {
                const provinceRentals = combineColumnsIntoRentals(columnData, currentProvince);
                rentals.push(...provinceRentals);
            }

            // Reset for new province
            currentProvince = provinceMatch;
            columnData = { names: [], types: [], emails: [], phones: [] };
            inDataSection = true;
            currentColumn = 'names';
            columnStartIndex = -1;
            continue;
        }

        // Detect end of province section
        if (inDataSection && (line.includes('Total por provincia:') || line.includes('Total Provincial:'))) {
            if (columnData.names.length > 0 && currentProvince) {
                const provinceRentals = combineColumnsIntoRentals(columnData, currentProvince);
                rentals.push(...provinceRentals);
            }
            inDataSection = false;
            continue;
        }

        // Process data lines - detect column changes
        if (inDataSection) {
            // Look for column headers to detect column boundaries
            if (line === 'Nombre' || line === 'Modalidad' ||
                line === 'Correo Principal' || line === 'Teléfono' ||
                line.includes('@') && line.includes('.') ||
                isPhoneLine(line)) {

                // This indicates we're moving to a new column
                if (line === 'Nombre' || (isNameLine(line) && currentColumn !== 'names')) {
                    currentColumn = 'names';
                } else if (line === 'Modalidad' || isTypeLine(line)) {
                    currentColumn = 'types';
                } else if (line === 'Correo Principal' || (line.includes('@') && line.includes('.'))) {
                    currentColumn = 'emails';
                } else if (line === 'Teléfono' || isPhoneLine(line)) {
                    currentColumn = 'phones';
                }
            }

            // Add line to appropriate column based on current detection
            if (currentColumn === 'names' && isNameLine(line)) {
                columnData.names.push(line);
            } else if (currentColumn === 'types' && isTypeLine(line)) {
                columnData.types.push(line);
            } else if (currentColumn === 'emails' && isEmailLine(line)) {
                columnData.emails.push(line);
            } else if (currentColumn === 'phones' && isPhoneLine(line)) {
                columnData.phones.push(line);
            }
        }
    }

    // Process the last province
    if (columnData.names.length > 0 && currentProvince) {
        const provinceRentals = combineColumnsIntoRentals(columnData, currentProvince);
        rentals.push(...provinceRentals);
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// NEW: Alternative approach - parse by finding column boundaries
function parsePDFByColumnDetection(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const rentals = [];

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    let currentProvince = '';
    let inDataSection = false;

    // First, identify all the column data for each province
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (isHeaderLine(line)) continue;

        // Detect province
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch) {
            currentProvince = provinceMatch;
            inDataSection = true;

            // Find the data section for this province
            const provinceData = extractProvinceData(lines, i, currentProvince);
            if (provinceData) {
                rentals.push(...provinceData);
            }

            // Skip ahead to avoid reprocessing
            const nextProvinceIndex = findNextProvinceIndex(lines, i + 1, provinces);
            if (nextProvinceIndex !== -1) {
                i = nextProvinceIndex - 1;
            }
        }
    }

    return rentals;
}

// NEW: Extract data for a specific province by finding column boundaries
function extractProvinceData(lines, startIndex, province) {
    const rentals = [];

    // Find the section boundaries for this province
    let sectionEnd = findSectionEnd(lines, startIndex);
    const sectionLines = lines.slice(startIndex, sectionEnd);

    // Extract the four columns
    const columns = extractColumnsFromSection(sectionLines);

    // Combine columns into rentals
    if (columns.names.length > 0) {
        const maxRecords = Math.max(
            columns.names.length,
            columns.types.length,
            columns.emails.length,
            columns.phones.length
        );

        for (let i = 0; i < maxRecords; i++) {
            const name = columns.names[i] || '';
            const type = columns.types[i] || '';
            const email = columns.emails[i] || '';
            const phone = columns.phones[i] || '';

            if (name && name.length > 2) {
                const rental = createRentalObject(name, type, email, phone, province);
                rentals.push(rental);
            }
        }
    }

    return rentals;
}

// NEW: Extract the four columns from a province section
function extractColumnsFromSection(sectionLines) {
    const columns = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let currentColumn = 'unknown';

    for (const line of sectionLines) {
        // Skip headers and totals
        if (isHeaderLine(line) ||
            line.includes('Total por provincia:') ||
            line.includes('Provincia:')) {
            continue;
        }

        // Detect column changes
        if (line === 'Nombre' || (isNameLine(line) && currentColumn !== 'names')) {
            currentColumn = 'names';
        } else if (line === 'Modalidad' || isTypeLine(line)) {
            currentColumn = 'types';
        } else if (line === 'Correo Principal' || (isEmailLine(line) && currentColumn !== 'emails')) {
            currentColumn = 'emails';
        } else if (line === 'Teléfono' || (isPhoneLine(line) && currentColumn !== 'phones')) {
            currentColumn = 'phones';
        }

        // Add to appropriate column
        if (currentColumn === 'names' && isNameLine(line) && line !== 'Nombre') {
            columns.names.push(line);
        } else if (currentColumn === 'types' && isTypeLine(line) && line !== 'Modalidad') {
            columns.types.push(line);
        } else if (currentColumn === 'emails' && isEmailLine(line) && line !== 'Correo Principal') {
            columns.emails.push(line);
        } else if (currentColumn === 'phones' && isPhoneLine(line) && line !== 'Teléfono') {
            columns.phones.push(line);
        }
    }

    return columns;
}

// NEW: Find the end of a province section
function findSectionEnd(lines, startIndex) {
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('Total por provincia:') ||
            line.includes('Total Provincial:') ||
            line.match(/Página \d+ de \d+/)) {
            return i;
        }
    }
    return lines.length;
}

// NEW: Find the next province index
function findNextProvinceIndex(lines, startIndex, provinces) {
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch) {
            return i;
        }
    }
    return -1;
}

// NEW: Combine vertical columns into horizontal records
function combineColumnsIntoRentals(columnData, province) {
    const rentals = [];

    const maxRecords = Math.max(
        columnData.names.length,
        columnData.types.length,
        columnData.emails.length,
        columnData.phones.length
    );

    for (let i = 0; i < maxRecords; i++) {
        const name = columnData.names[i] || '';
        const type = columnData.types[i] || '';
        const email = columnData.emails[i] || '';
        const phone = columnData.phones[i] || '';

        if (name && name.length > 2) {
            const rental = createRentalObject(name, type, email, phone, province);
            rentals.push(rental);
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals (Names: ${columnData.names.length}, Types: ${columnData.types.length}, Emails: ${columnData.emails.length}, Phones: ${columnData.phones.length})`);
    return rentals;
}

// NEW: Create rental object
function createRentalObject(name, type, email, phone, province) {
    return {
        name: cleanText(name),
        type: cleanText(type || 'Hospedaje'),
        email: extractEmail(email),
        phone: extractFirstPhone(phone),
        province: province,
        district: guessDistrict(name, province),
        description: generateDescription(name, type, province),
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(name + ' ' + province + ' Panamá')}`,
        whatsapp: extractFirstPhone(phone),
        source: 'ATP_OFFICIAL'
    };
}

// Use the vertical column parser as main parser
function parsePDFText(text) {
    return parsePDFVerticalColumns(text);
}

// Keep your existing helper functions
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
           !isHeaderLine(line) &&
           line !== 'Nombre' &&
           line !== 'Modalidad' &&
           line !== 'Correo Principal' &&
           line !== 'Teléfono' &&
           !line.match(/^-+$/);
}

function isTypeLine(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña'];
    return types.some(type => line.toUpperCase().includes(type.toUpperCase()));
}

function isEmailLine(line) {
    return line.includes('@') && (line.includes('.com') || line.includes('.net') || line.includes('.org') || line.includes('.edu') || line.includes('.gob') || line.includes('.pa'));
}

function isPhoneLine(line) {
    const phonePatterns = [
        /\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}/,
        /\d{7,8}/,
        /\+\d{1,3}[- ]?\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}/,
        /\(\d{3,4}\)[- ]?\d{3,4}[- ]?\d{3,4}/
    ];
    return phonePatterns.some(pattern => pattern.test(line));
}

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    const match = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    return match ? match[1].replace(/[- ]/g, '') : '';
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
    // Your 20 complete datasets
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
        },
        // ... include all your 20 fallback records
    ];
}

// Keep all your existing API routes (they remain the same)
// ... [all your existing app.get and app.post routes] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
