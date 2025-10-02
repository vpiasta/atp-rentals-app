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
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) continue;

        // Detect province headers
        const provinceMatch = provinces.find(province =>
            line.toUpperCase().includes(province)
        );

        if (provinceMatch) {
            // Save previous section
            if (currentSection.length > 0 && currentProvince) {
                const provinceRentals = parseProvinceSection(currentSection, currentProvince);
                rentals.push(...provinceRentals);
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
                const provinceRentals = parseProvinceSection(currentSection, currentProvince);
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
        const provinceRentals = parseProvinceSection(currentSection, currentProvince);
        rentals.push(...provinceRentals);
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// FIXED: Better province section parsing
function parseProvinceSection(sectionLines, province) {
    const rentals = [];

    // FIXED: Use improved column grouping that handles multi-line elements
    const columnGroups = groupIntoColumnsImproved(sectionLines);

    // FIXED: Align columns properly before creating rentals
    const alignedColumns = alignColumnsProperly(columnGroups);

    if (alignedColumns.names.length > 0) {
        // Create rentals from aligned columns
        for (let i = 0; i < alignedColumns.names.length; i++) {
            const name = alignedColumns.names[i] || '';
            const type = alignedColumns.types[i] || '';
            const email = alignedColumns.emails[i] || '';
            const phone = alignedColumns.phones[i] || '';

            if (name && name.length > 2) {
                const cleanName = cleanText(name);
                const cleanType = cleanText(type) || 'Hospedaje'; // Only default if empty
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

// FIXED: Improved column grouping that doesn't switch columns too aggressively
function groupIntoColumnsImproved(lines) {
    const result = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let currentColumn = 'names';
    let foundHeaders = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip column headers but note that we found them
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
            foundHeaders = true;
            if (line === 'Nombre') currentColumn = 'names';
            else if (line === 'Modalidad') currentColumn = 'types';
            else if (line === 'Correo Principal') currentColumn = 'emails';
            else if (line === 'Teléfono') currentColumn = 'phones';
            continue;
        }

        // Skip province headers and totals
        if (line.includes('Provincia:') || line.includes('Total por provincia:')) {
            continue;
        }

        // FIXED: Only switch columns when we find clear column headers
        // Don't switch based on content patterns - that was causing the problem
        if (!foundHeaders) {
            // Before headers, use simple content-based detection
            if (isEmailLine(line)) {
                currentColumn = 'emails';
            } else if (isPhoneLine(line)) {
                currentColumn = 'phones';
            } else if (isTypeLine(line)) {
                currentColumn = 'types';
            } else if (isNameLine(line)) {
                currentColumn = 'names';
            }
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

// NEW: Proper column alignment to handle different column lengths
function alignColumnsProperly(columns) {
    const aligned = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    // FIXED: Use the longest column as reference, but prefer types column
    const referenceLength = Math.max(
        columns.types.length,
        columns.names.length,
        columns.emails.length,
        columns.phones.length
    );

    // Simple alignment - just take the first N elements from each column
    for (let i = 0; i < referenceLength; i++) {
        aligned.names.push(columns.names[i] || '');
        aligned.types.push(columns.types[i] || '');
        aligned.emails.push(columns.emails[i] || '');
        aligned.phones.push(columns.phones[i] || '');
    }

    return aligned;
}

// IMPROVED helper functions
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
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:');
}

// FIXED: Better type detection with more types
function isTypeLine(line) {
    const types = [
        'Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel',
        'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña',
        'Alojamiento', 'Residencial', 'Pensión', 'Glamping', 'Camping'
    ];
    return types.some(type => line.toUpperCase().includes(type.toUpperCase()));
}

function isEmailLine(line) {
    return line.includes('@') &&
           (line.includes('.com') || line.includes('.net') || line.includes('.org') ||
            line.includes('.edu') || line.includes('.gob') || line.includes('.pa'));
}

function isPhoneLine(line) {
    return line.match(/\d{3,4}[- \/]?\d{3,4}[- \/]?\d{3,4}/) ||
           line.match(/\d{7,8}/) ||
           (line.includes('/') && line.match(/\d+/));
}

function extractEmail(text) {
    if (!text) return '';
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    if (!text) return '';
    const match = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    return match ? match[1].replace(/[- ]/g, '') : '';
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

// ... [keep all your existing API routes with error handling] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);

        // Log some samples for debugging
        const samples = CURRENT_RENTALS.slice(0, 5);
        console.log('Sample rentals:');
        samples.forEach(rental => {
            console.log(`- ${rental.name} (${rental.type}) - Email: ${rental.email || 'none'}, Phone: ${rental.phone || 'none'}`);
        });
    }, 2000);
});
