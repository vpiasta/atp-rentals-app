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

// NEW PARSER USING YOUR OBSERVATIONS
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
    let inDataSection = false;

    // First pass: group by provinces using your observation #1
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) continue;

        // Detect province using your observation #1: "BOCAS DEL TOROProvincia:"
        const provinceMatch = provinces.find(p => {
            // Look for pattern: "PROVINCE NAMEProvincia:"
            return line.includes(p + 'Provincia:') ||
                   (line.includes(p) && lines[i + 1] && lines[i + 1].includes('Provincia:'));
        });

        if (provinceMatch) {
            // Process previous section
            if (currentSection.length > 0 && currentProvince) {
                const provinceRentals = parseProvinceSection(currentSection, currentProvince);
                rentals.push(...provinceRentals);
            }

            // Start new section
            currentProvince = provinceMatch;
            currentSection = [];
            inDataSection = true;
            continue;
        }

        // Detect end of section using your observation #1: "151Total por provincia:"
        if (inDataSection && line.includes('Total por provincia:')) {
            if (currentSection.length > 0 && currentProvince) {
                const provinceRentals = parseProvinceSection(currentSection, currentProvince);
                rentals.push(...provinceRentals);
            }
            currentSection = [];
            inDataSection = false;
            continue;
        }

        // Add to current section
        if (inDataSection && line.length > 2) {
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

// NEW: Parse province section using your observations
function parseProvinceSection(sectionLines, province) {
    const rentals = [];

    // Extract columns using your observations
    const columns = extractColumnsIntelligently(sectionLines);

    // Use your observation #2: Use type column to determine record count
    const recordCount = columns.types.length;

    if (recordCount > 0) {
        // Align all columns to have the same number of records
        const alignedColumns = alignColumnsToTypeCount(columns, recordCount);

        // Create records
        for (let i = 0; i < recordCount; i++) {
            const name = combineMultiLineNames(alignedColumns.names, i);
            const type = alignedColumns.types[i] || 'Hospedaje';
            const email = combineMultiLineEmails(alignedColumns.emails, i);
            const phone = combineMultiLinePhones(alignedColumns.phones, i);

            if (name && name.length > 2) {
                const rental = createRentalObject(name, type, email, phone, province);
                rentals.push(rental);
            }
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals (based on ${recordCount} type records)`);
    return rentals;
}

// NEW: Intelligent column extraction
function extractColumnsIntelligently(sectionLines) {
    const columns = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let currentColumn = 'unknown';
    let foundColumnHeaders = false;

    for (let i = 0; i < sectionLines.length; i++) {
        const line = sectionLines[i];

        // Skip province headers and totals
        if (line.includes('Provincia:') || line.includes('Total por provincia:')) {
            continue;
        }

        // Detect column headers (your observation #1: headers appear at column ends)
        if (line === 'Nombre' || line === 'Modalidad' ||
            line === 'Correo Principal' || line === 'Teléfono') {
            foundColumnHeaders = true;

            if (line === 'Nombre') currentColumn = 'names';
            else if (line === 'Modalidad') currentColumn = 'types';
            else if (line === 'Correo Principal') currentColumn = 'emails';
            else if (line === 'Teléfono') currentColumn = 'phones';
            continue;
        }

        // If we found headers, assign to columns based on current column
        if (foundColumnHeaders) {
            if (currentColumn === 'names' && isNameLine(line)) {
                columns.names.push(line);
            } else if (currentColumn === 'types' && isTypeLine(line)) {
                // Your observation #2: Handle "Hostal Familiar" and other multi-word types
                columns.types.push(handleMultiLineType(line, sectionLines, i));
            } else if (currentColumn === 'emails' && (isEmailLine(line) || isPotentialEmailPart(line))) {
                columns.emails.push(line);
            } else if (currentColumn === 'phones' && (isPhoneLine(line) || isPotentialPhonePart(line))) {
                columns.phones.push(line);
            }
        } else {
            // Before headers, try to categorize
            if (isNameLine(line)) {
                columns.names.push(line);
            } else if (isTypeLine(line)) {
                columns.types.push(handleMultiLineType(line, sectionLines, i));
            } else if (isEmailLine(line) || isPotentialEmailPart(line)) {
                columns.emails.push(line);
            } else if (isPhoneLine(line) || isPotentialPhonePart(line)) {
                columns.phones.push(line);
            }
        }
    }

    return columns;
}

// NEW: Align columns based on type count (your observation #2)
function alignColumnsToTypeCount(columns, targetCount) {
    const aligned = {
        names: [],
        types: [...columns.types],
        emails: [],
        phones: []
    };

    // Start with types as the reference
    aligned.types = columns.types.slice(0, targetCount);

    // Align other columns
    aligned.names = alignColumn(columns.names, targetCount, 'name');
    aligned.emails = alignColumn(columns.emails, targetCount, 'email');
    aligned.phones = alignColumn(columns.phones, targetCount, 'phone');

    return aligned;
}

// NEW: Align a single column to target count
function alignColumn(column, targetCount, columnType) {
    const result = [];
    let sourceIndex = 0;

    for (let i = 0; i < targetCount; i++) {
        if (sourceIndex < column.length) {
            result.push(column[sourceIndex]);
            sourceIndex++;
        } else {
            result.push(''); // Fill with empty if we run out
        }
    }

    return result;
}

// NEW: Handle multi-line names (your observation #2)
function combineMultiLineNames(names, index) {
    if (index >= names.length) return '';

    let name = names[index];

    // If this looks like an incomplete name and there are more names than types,
    // try to combine with next name
    if (name.length < 20 && index + 1 < names.length &&
        !isTypeLine(names[index + 1]) && !isEmailLine(names[index + 1]) && !isPhoneLine(names[index + 1])) {
        name += ' ' + names[index + 1];
        // Remove the combined name from the array to avoid reuse
        names[index + 1] = '';
    }

    return cleanText(name);
}

// NEW: Handle multi-line emails (your observation #3)
function combineMultiLineEmails(emails, index) {
    if (index >= emails.length) return '';

    let email = emails[index];

    // Your observation #3: Combine email parts
    if (email.includes('@') && !email.includes('.') && index + 1 < emails.length) {
        // Email has @ but no domain, likely continues on next line
        const nextPart = emails[index + 1];
        if (nextPart && nextPart.includes('.')) {
            email += nextPart;
            emails[index + 1] = ''; // Mark as used
        }
    }

    // Remove spaces from email (your observation #3)
    email = email.replace(/\s+/g, '');

    return extractEmail(email);
}

// NEW: Handle multi-line phones (your observation #4)
function combineMultiLinePhones(phones, index) {
    if (index >= phones.length) return '';

    let phone = phones[index];

    // Your observation #4: Handle phone number splits
    if (phone.endsWith('/') && index + 1 < phones.length) {
        const nextPart = phones[index + 1];
        if (nextPart && isPhoneLine(nextPart)) {
            phone += ' ' + nextPart;
            phones[index + 1] = ''; // Mark as used
        }
    }

    // Remove dashes and slashes (your observation #4)
    phone = phone.replace(/[-/]/g, '');

    return extractFirstPhone(phone);
}

// NEW: Handle multi-line types (your observation #2)
function handleMultiLineType(line, sectionLines, currentIndex) {
    // Your observation #2: Handle "Hostal Familiar" and similar
    if (line === 'Hostal' && currentIndex + 1 < sectionLines.length) {
        const nextLine = sectionLines[currentIndex + 1];
        if (nextLine === 'Familiar') {
            return 'Hostal Familiar';
        }
    }
    return line;
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

function isTypeLine(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña', 'Hostal Familiar'];
    return types.some(type => line.toUpperCase().includes(type.toUpperCase()));
}

function isEmailLine(line) {
    return line.includes('@') && (line.includes('.com') || line.includes('.net') || line.includes('.org') || line.includes('.pa'));
}

function isPotentialEmailPart(line) {
    return line.includes('@') || (line.includes('.com') || line.includes('.net'));
}

function isPhoneLine(line) {
    return line.match(/\d{3,4}[- \/]?\d{3,4}[- \/]?\d{3,4}/) ||
           line.match(/\d{7,8}/) ||
           (line.includes('/') && line.match(/\d+/));
}

function isPotentialPhonePart(line) {
    return line.match(/\d{3,4}/) && line.length < 10;
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

// Keep all your existing API routes
// ... [your existing API routes] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
