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

// NEW: Content-based parser that handles multi-line elements
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
    let currentSection = [];
    let inDataSection = false;

    // First pass: group by provinces
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) continue;

        // Detect province
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
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

        // Detect end of section
        if (inDataSection && (line.includes('Total por provincia:') || line.includes('Total Provincial:'))) {
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

// NEW: Parse province section using content-based element identification
function parseProvinceSection(sectionLines, province) {
    const rentals = [];

    // Reconstruct records by identifying elements based on content
    const records = reconstructRecords(sectionLines);

    // Create rental objects from reconstructed records
    for (const record of records) {
        if (record.name && record.name.length > 2) {
            const rental = createRentalObject(record.name, record.type, record.email, record.phone, province);
            rentals.push(rental);
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals`);
    return rentals;
}

// NEW: Reconstruct records by identifying elements based on content characteristics
function reconstructRecords(sectionLines) {
    const records = [];
    let currentRecord = { name: '', type: '', email: '', phone: '' };
    let pendingLines = [];

    // Process all lines to reconstruct records
    for (let i = 0; i < sectionLines.length; i++) {
        const line = sectionLines[i];

        // Skip headers and metadata
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono' ||
            line.includes('Provincia:') || line.includes('Total por provincia:')) {
            continue;
        }

        // Check what type of element this line is
        const elementType = identifyElementType(line);

        // If we find a new name and we already have a record, save it
        if (elementType === 'name' && currentRecord.name && !isContinuationLine(line, pendingLines)) {
            if (currentRecord.name.length > 2) {
                records.push({ ...currentRecord });
            }
            currentRecord = { name: '', type: '', email: '', phone: '' };
            pendingLines = [];
        }

        // Handle multi-line elements
        if (isContinuationLine(line, pendingLines)) {
            // This is a continuation of the previous element
            const lastElement = getLastElementType(currentRecord, pendingLines);
            if (lastElement === 'name') {
                currentRecord.name += ' ' + line;
            } else if (lastElement === 'email') {
                // Email continuations should be concatenated without space
                currentRecord.email = (currentRecord.email + line).replace(/\s+/g, '');
            } else if (lastElement === 'phone') {
                currentRecord.phone += ' ' + line;
            }
            pendingLines.push(line);
        } else {
            // New element
            if (elementType === 'name') {
                currentRecord.name = line;
            } else if (elementType === 'type') {
                currentRecord.type = line;
            } else if (elementType === 'email') {
                currentRecord.email = line;
            } else if (elementType === 'phone') {
                currentRecord.phone = line;
            }
            pendingLines = [line];
        }
    }

    // Don't forget the last record
    if (currentRecord.name && currentRecord.name.length > 2) {
        records.push(currentRecord);
    }

    return records;
}

// NEW: Identify element type based on content characteristics
function identifyElementType(line) {
    // Check for email first (most specific)
    if (isEmailLine(line)) {
        return 'email';
    }

    // Check for phone (very specific pattern)
    if (isPhoneLine(line)) {
        return 'phone';
    }

    // Check for type (limited set of known values)
    if (isTypeLine(line)) {
        return 'type';
    }

    // Check for name (text that's not email, phone, or type)
    if (isNameLine(line)) {
        return 'name';
    }

    // Default to name for unrecognized text
    return 'name';
}

// NEW: Check if a line is a continuation of the previous element
function isContinuationLine(line, pendingLines) {
    if (pendingLines.length === 0) return false;

    const lastLine = pendingLines[pendingLines.length - 1];

    // If last line was clearly an incomplete element, this is likely a continuation
    if (isEmailLine(lastLine) && !lastLine.includes('.com') && !lastLine.includes('.net') && !lastLine.includes('.org')) {
        return true;
    }

    // If last line was a name and this line doesn't look like a new element type
    if (isNameLine(lastLine) && !isTypeLine(line) && !isEmailLine(line) && !isPhoneLine(line)) {
        return true;
    }

    // If last line was a phone number with slash, this might be continuation
    if (isPhoneLine(lastLine) && lastLine.includes('/') && !lastLine.match(/\d{8}/)) {
        return true;
    }

    return false;
}

// NEW: Get the type of the last element being processed
function getLastElementType(currentRecord, pendingLines) {
    if (pendingLines.length === 0) return '';

    const lastLine = pendingLines[pendingLines.length - 1];
    return identifyElementType(lastLine);
}

// IMPROVED: Better helper functions with content-based detection
function isHeaderLine(line) {
    return line.includes('Reporte de Hospedajes vigentes') ||
           line.includes('Reporte: rep_hos_web') ||
           line.includes('Actualizado al') ||
           line.match(/Página \d+ de \d+/);
}

function isNameLine(line) {
    // Name is text that doesn't match other patterns
    return line.length > 2 &&
           !isEmailLine(line) &&
           !isPhoneLine(line) &&
           !isTypeLine(line) &&
           line !== 'Nombre' &&
           line !== 'Modalidad' &&
           line !== 'Correo Principal' &&
           line !== 'Teléfono' &&
           !line.match(/^-+$/) &&
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:') &&
           // Names typically don't start with numbers or special characters
           !line.match(/^\d/) &&
           !line.match(/^[\/\-]/);
}

function isTypeLine(line) {
    const types = [
        'Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel',
        'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña',
        'Glamping', 'Camping', 'Residencial', 'Pensión', 'Alojamiento'
    ];
    return types.some(type =>
        line.toUpperCase() === type.toUpperCase() ||
        line.toUpperCase().includes(type.toUpperCase())
    );
}

function isEmailLine(line) {
    // More robust email detection
    return line.includes('@') &&
           (line.includes('.com') || line.includes('.net') || line.includes('.org') ||
            line.includes('.edu') || line.includes('.gob') || line.includes('.pa') ||
            line.includes('.io') || line.includes('.co'));
}

function isPhoneLine(line) {
    // Clean the line for phone detection
    const cleanLine = line.replace(/\s+/g, '').replace(/\//g, '');

    // Panama phone number patterns:
    // - 8-digit numbers (mobile: 6xxx-xxxx, 7xxx-xxxx)
    // - 7-digit numbers (landlines)
    // - Numbers with separators: 123-4567, 1234-5678, 123-45-67
    const phonePatterns = [
        /^\d{7,8}$/, // 7 or 8 digit numbers
        /^\d{3,4}[-]?\d{3,4}$/, // 123-4567 or 1234-5678
        /^\d{3}[-]?\d{2}[-]?\d{2}$/, // 123-45-67
        /^\d{4}[-]?\d{4}$/, // 1234-5678 (most common mobile format)
        /^\d{3}[-]?\d{4}$/ // 123-4567 (landline format)
    ];

    return phonePatterns.some(pattern => pattern.test(cleanLine));
}

function extractEmail(text) {
    if (!text) return '';
    // Extract complete email address
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    if (!text) return '';

    // Clean the text
    const cleanText = text.replace(/\s+/g, ' ').trim();

    // Extract the first complete phone number pattern
    const patterns = [
        /(\d{4}[- ]?\d{4})/, // 1234-5678 (mobile)
        /(\d{3}[- ]?\d{4})/, // 123-4567 (landline)
        /(\d{7,8})/, // 1234567 or 12345678
        /(\d{3}[- ]?\d{2}[- ]?\d{2})/ // 123-45-67
    ];

    for (const pattern of patterns) {
        const match = cleanText.match(pattern);
        if (match) {
            // Clean the phone number: remove spaces and dashes
            let phone = match[1].replace(/[- ]/g, '');

            // Ensure we have a complete number
            if (phone.length >= 7) {
                // Format as 8-digit for consistency (add leading 6 if missing for mobile)
                if (phone.length === 7) {
                    // Landline number, keep as is
                    return phone;
                } else if (phone.length === 8) {
                    // Mobile number, ensure it starts with 6 or 7
                    if (phone.startsWith('6') || phone.startsWith('7')) {
                        return phone;
                    }
                }
                return phone;
            }
        }
    }

    return '';
}

function isWhatsAppNumber(phone) {
    if (!phone) return false;
    const cleanPhone = phone.replace(/[- ]/g, '');
    // WhatsApp numbers in Panama are typically 8-digit mobile numbers starting with 6 or 7
    return cleanPhone.length === 8 && (cleanPhone.startsWith('6') || cleanPhone.startsWith('7'));
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

function createRentalObject(name, type, email, phone, province) {
    // Clean and validate data
    const cleanName = cleanText(name);
    const cleanType = cleanText(type || 'Hospedaje');
    const cleanEmail = extractEmail(email);
    const cleanPhone = extractFirstPhone(phone);

    // Final validation - ensure name is not actually an email or phone
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
        whatsapp: isWhatsAppNumber(cleanPhone) ? cleanPhone : '',
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
        // Add more fallback records as needed
    ];
}

// Keep all your existing API routes (they remain the same)
// ... [all your API routes] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
