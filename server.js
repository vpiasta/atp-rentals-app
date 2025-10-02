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

// NEW: Implement your step-by-step procedure
function parsePDFText(text) {
    console.log('=== PARSING ATP PDF DATA USING NEW PROCEDURE ===');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const rentals = [];

    let currentProvince = '';
    let currentRentalCount = 0;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) {
            i++;
            continue;
        }

        // STEP 1: Find province
        if (line.endsWith('Provincia:')) {
            currentProvince = line.replace('Provincia:', '').trim();
            console.log(`Found province: ${currentProvince}`);
            i++;
            continue;
        }

        // STEP 2: Find rental count
        if (line.includes('Total por provincia:')) {
            const countMatch = line.match(/(\d+)Total por provincia:/);
            if (countMatch) {
                currentRentalCount = parseInt(countMatch[1]);
                console.log(`Expected ${currentRentalCount} rentals for ${currentProvince}`);
            }
            i++;
            continue;
        }

        // If we have a province and rental count, parse the columns
        if (currentProvince && currentRentalCount > 0) {
            const result = parseProvinceColumns(lines, i, currentProvince, currentRentalCount);
            if (result.rentals.length > 0) {
                rentals.push(...result.rentals);
                i = result.nextIndex;

                // Reset for next province
                currentProvince = '';
                currentRentalCount = 0;
                continue;
            }
        }

        i++;
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// Parse columns for a province
function parseProvinceColumns(lines, startIndex, province, expectedCount) {
    console.log(`Parsing columns for ${province} starting at line ${startIndex}`);

    const columns = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let i = startIndex;
    let currentColumn = 'names';

    // STEP 3-6: Parse the four columns
    while (i < lines.length) {
        const line = lines[i];

        // Stop if we find next province or end of data
        if (isHeaderLine(line) || line.includes('Provincia:') || line.includes('Total por provincia:')) {
            break;
        }

        // STEP 3: Name column (ends with "Nombre")
        if (currentColumn === 'names') {
            if (line === 'Nombre') {
                currentColumn = 'types';
                i++;
                continue;
            }
            if (isNameLine(line)) {
                columns.names.push(line);
            }
        }
        // STEP 4: Type column (ends with "Modalidad")
        else if (currentColumn === 'types') {
            if (line === 'Modalidad') {
                currentColumn = 'emails';
                i++;
                continue;
            }
            // Handle "Hostal Familiar" case
            if (line === 'Hostal' && i + 1 < lines.length && lines[i + 1] === 'Familiar') {
                columns.types.push('Hostal Familiar');
                i += 2;
                continue;
            }
            if (isTypeLine(line)) {
                columns.types.push(line);
            }
        }
        // STEP 5: Email column (ends with "Correo Principal")
        else if (currentColumn === 'emails') {
            if (line === 'Correo Principal') {
                currentColumn = 'phones';
                i++;
                continue;
            }
            // Combine multi-line emails
            if (isEmailLine(line) || isPotentialEmailPart(line)) {
                let email = line;
                // Check if email continues on next line
                if (i + 1 < lines.length && isEmailContinuation(line, lines[i + 1])) {
                    email += lines[i + 1];
                    i++; // Skip next line since we combined it
                }
                columns.emails.push(email.replace(/\s+/g, '')); // Remove spaces
            }
        }
        // STEP 6: Phone column (ends with "Cel/Teléfono")
        else if (currentColumn === 'phones') {
            if (line === 'Teléfono' || line === 'Cel/Teléfono') {
                break; // End of this province section
            }
            // Combine multi-line phones
            if (isPhoneLine(line) || isPotentialPhonePart(line)) {
                let phone = line;
                // Check if phone continues on next line
                if (i + 1 < lines.length && isPhoneContinuation(line, lines[i + 1])) {
                    phone += ' ' + lines[i + 1];
                    i++; // Skip next line since we combined it
                }
                columns.phones.push(phone);
            }
        }

        i++;
    }

    // Align columns and create rentals
    const alignedColumns = alignColumns(columns, expectedCount);
    const rentals = createRentalsFromColumns(alignedColumns, province);

    return {
        rentals: rentals,
        nextIndex: i
    };
}

// Align columns to have same count as types
function alignColumns(columns, expectedCount) {
    const aligned = {
        names: [...columns.names],
        types: [...columns.types],
        emails: [...columns.emails],
        phones: [...columns.phones]
    };

    // STEP: Ensure all columns have same count as types
    const typeCount = aligned.types.length;

    // Fix names: combine split names if name count > type count
    if (aligned.names.length > typeCount) {
        aligned.names = fixSplitNames(aligned.names, typeCount);
    }

    // Pad arrays to expected count
    while (aligned.names.length < expectedCount) aligned.names.push('');
    while (aligned.types.length < expectedCount) aligned.types.push('');
    while (aligned.emails.length < expectedCount) aligned.emails.push('');
    while (aligned.phones.length < expectedCount) aligned.phones.push('');

    // Fix emails: insert empty elements where emails don't match names
    aligned.emails = fixEmailAlignment(aligned.names, aligned.emails);

    return aligned;
}

// Fix split names by combining single words with previous names
function fixSplitNames(names, targetCount) {
    if (names.length <= targetCount) return names.slice(0, targetCount);

    const fixedNames = [];
    let i = 0;

    while (i < names.length && fixedNames.length < targetCount) {
        let currentName = names[i];

        // If this is likely a split name (single word) and we have more names than needed
        if (currentName.split(' ').length === 1 &&
            i + 1 < names.length &&
            fixedNames.length < targetCount - (names.length - i - 1)) {
            // Combine with next name
            currentName += ' ' + names[i + 1];
            i++; // Skip next name since we combined it
        }

        fixedNames.push(currentName);
        i++;
    }

    return fixedNames.slice(0, targetCount);
}

// Fix email alignment by checking name-email similarity
function fixEmailAlignment(names, emails) {
    const fixedEmails = [];
    let emailIndex = 0;

    for (let i = 0; i < names.length; i++) {
        const name = names[i];

        if (emailIndex < emails.length) {
            const currentEmail = emails[emailIndex];

            // Check if email matches current name
            if (emailMatchesName(currentEmail, name)) {
                fixedEmails.push(currentEmail);
                emailIndex++;
            } else {
                // Check if email matches next names
                let foundMatch = false;
                for (let j = i + 1; j < Math.min(i + 3, names.length); j++) {
                    if (emailIndex < emails.length && emailMatchesName(emails[emailIndex], names[j])) {
                        // Insert empty emails until we reach the matching one
                        while (fixedEmails.length < j) {
                            fixedEmails.push('');
                        }
                        fixedEmails.push(emails[emailIndex]);
                        emailIndex++;
                        foundMatch = true;
                        i = j; // Skip to the matched index
                        break;
                    }
                }

                if (!foundMatch) {
                    fixedEmails.push('');
                }
            }
        } else {
            fixedEmails.push('');
        }
    }

    return fixedEmails;
}

// Check if email matches name (simple similarity check)
function emailMatchesName(email, name) {
    if (!email || !name) return false;

    // Extract name part from email (before @)
    const emailNamePart = email.split('@')[0].toLowerCase();
    const cleanName = name.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Check if name appears in email or vice versa
    return emailNamePart.includes(cleanName) || cleanName.includes(emailNamePart) ||
           emailNamePart.includes(cleanName.substring(0, 5)) ||
           cleanName.includes(emailNamePart.substring(0, 5));
}

// Create rental objects from aligned columns
function createRentalsFromColumns(columns, province) {
    const rentals = [];

    for (let i = 0; i < columns.names.length; i++) {
        const name = columns.names[i];
        const type = columns.types[i];
        const email = columns.emails[i];
        const phone = columns.phones[i];

        if (name && name.length > 2) {
            const cleanName = cleanText(name);
            const cleanType = cleanText(type) || 'Hospedaje';
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

    console.log(`Created ${rentals.length} rentals for ${province}`);
    return rentals;
}

// Helper functions
function isHeaderLine(line) {
    return line.includes('Reporte de Hospedajes vigentes') ||
           line.includes('Reporte: rep_hos_web') ||
           line.includes('Actualizado al') ||
           line.match(/Página \d+ de \d+/);
}

function isNameLine(line) {
    return line && line.length > 3 &&
           !line.includes('@') &&
           !isPhoneLine(line) &&
           !isTypeLine(line) &&
           line !== 'Nombre' &&
           line !== 'Modalidad' &&
           line !== 'Correo Principal' &&
           line !== 'Teléfono';
}

function isTypeLine(line) {
    if (!line) return false;
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña'];
    return types.some(type => line.includes(type));
}

function isEmailLine(line) {
    return line && line.includes('@');
}

function isPotentialEmailPart(line) {
    return line && (line.includes('.com') || line.includes('.net') || line.includes('.org'));
}

function isEmailContinuation(currentLine, nextLine) {
    return currentLine.includes('@') && !currentLine.includes('.') &&
           nextLine && (nextLine.includes('.com') || nextLine.includes('.net'));
}

function isPhoneLine(line) {
    return line && line.match(/\d{7,8}/);
}

function isPotentialPhonePart(line) {
    return line && line.match(/\d{3,4}/);
}

function isPhoneContinuation(currentLine, nextLine) {
    return (currentLine.endsWith('/') || currentLine.includes('-')) &&
           nextLine && nextLine.match(/\d+/);
}

function extractEmail(text) {
    if (!text) return '';
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    if (!text) return '';
    // Remove slashes and hyphens, take first 8 digits
    const cleanText = text.replace(/[-\/\s]/g, '');
    const match = cleanText.match(/(\d{7,8})/);
    return match ? match[1] : '';
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

// ... [keep all your existing API routes] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
