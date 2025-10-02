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
    console.log('=== PARSING ATP PDF DATA - TABLE BY TABLE ===');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const allRentals = [];

    let i = 0;
    let currentProvince = '';
    let currentRentalCount = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) {
            i++;
            continue;
        }

        // Look for province pattern: "BOCAS DEL TOROProvincia:"
        const provinceMatch = line.match(/(.*)Provincia:/);
        if (provinceMatch) {
            currentProvince = provinceMatch[1].trim();
            console.log(`\n=== PROCESSING PROVINCE: ${currentProvince} ===`);
            i++;
            continue;
        }

        // Look for rental count pattern: "151Total por provincia:"
        const countMatch = line.match(/(\d+)Total por provincia:/);
        if (countMatch && currentProvince) {
            currentRentalCount = parseInt(countMatch[1]);
            console.log(`Expected rental count: ${currentRentalCount}`);

            // Process this table
            const tableResult = processTable(lines, i + 1, currentProvince, currentRentalCount);
            if (tableResult.rentals.length > 0) {
                allRentals.push(...tableResult.rentals);
                console.log(`Added ${tableResult.rentals.length} rentals for ${currentProvince}`);
            }

            i = tableResult.nextIndex;
            currentProvince = '';
            currentRentalCount = 0;
            continue;
        }

        i++;
    }

    console.log(`\n=== PARSING COMPLETE: Found ${allRentals.length} rentals ===`);
    return allRentals;
}

// Process one table at a time
function processTable(lines, startIndex, province, expectedCount) {
    console.log(`Processing table starting at line ${startIndex}`);

    const columns = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let i = startIndex;
    let currentColumn = 'names';
    let tableEnded = false;

    while (i < lines.length && !tableEnded) {
        const line = lines[i];

        // Stop conditions for this table
        if (isHeaderLine(line) ||
            line.includes('Provincia:') ||
            line.includes('Total por provincia:')) {
            tableEnded = true;
            break;
        }

        // COLUMN 1: Names (ends with "Nombre")
        if (currentColumn === 'names') {
            if (line === 'Nombre') {
                console.log(`Name column ended with ${columns.names.length} entries`);
                currentColumn = 'types';
                i++;
                continue;
            }
            if (isNameLine(line)) {
                columns.names.push(line);
            }
        }
        // COLUMN 2: Types (ends with "Modalidad")
        else if (currentColumn === 'types') {
            if (line === 'Modalidad') {
                console.log(`Type column ended with ${columns.types.length} entries`);
                currentColumn = 'emails';
                i++;
                continue;
            }
            // Handle "Hostal Familiar" special case
            if (line === 'Hostal' && i + 1 < lines.length && lines[i + 1] === 'Familiar') {
                columns.types.push('Hostal Familiar');
                i += 2;
                continue;
            }
            if (isTypeLine(line)) {
                columns.types.push(line);
            }
        }
        // COLUMN 3: Emails (ends with "Correo Principal")
        else if (currentColumn === 'emails') {
            if (line === 'Correo Principal') {
                console.log(`Email column ended with ${columns.emails.length} entries`);
                currentColumn = 'phones';
                i++;
                continue;
            }
            // Process email line
            if (isEmailLine(line) || isPotentialEmailPart(line)) {
                let email = processEmailLine(line, lines, i);
                columns.emails.push(email);
            }
        }
        // COLUMN 4: Phones (ends with "Teléfono" or "Cel/Teléfono")
        else if (currentColumn === 'phones') {
            if (line === 'Teléfono' || line === 'Cel/Teléfono') {
                console.log(`Phone column ended with ${columns.phones.length} entries`);
                tableEnded = true;
                break;
            }
            // Process phone line
            if (isPhoneLine(line) || isPotentialPhonePart(line)) {
                let phone = processPhoneLine(line, lines, i);
                columns.phones.push(phone);
            }
        }

        i++;
    }

    // OPTIMIZE and create rentals for this table
    const optimizedColumns = optimizeColumnsForTable(columns, expectedCount);
    const rentals = createRentalsFromTable(optimizedColumns, province);

    return {
        rentals: rentals,
        nextIndex: i
    };
}

// Process a single email line, handling multi-line cases
function processEmailLine(currentLine, lines, currentIndex) {
    let email = currentLine;

    // Check if email continues on next line
    if (currentIndex + 1 < lines.length) {
        const nextLine = lines[currentIndex + 1];
        if (isEmailContinuation(currentLine, nextLine)) {
            email += nextLine;
            // Remove the processed line from further consideration
            lines[currentIndex + 1] = '';
        }
    }

    return email.replace(/\s+/g, ''); // Remove all spaces
}

// Process a single phone line, handling multi-line cases
function processPhoneLine(currentLine, lines, currentIndex) {
    let phone = currentLine;

    // Check if phone continues on next line
    if (currentIndex + 1 < lines.length) {
        const nextLine = lines[currentIndex + 1];
        if (isPhoneContinuation(currentLine, nextLine)) {
            phone += ' ' + nextLine;
            // Remove the processed line from further consideration
            lines[currentIndex + 1] = '';
        }
    }

    return phone;
}

// Optimize columns for one table
function optimizeColumnsForTable(columns, expectedCount) {
    console.log(`Optimizing columns: Names=${columns.names.length}, Types=${columns.types.length}, Emails=${columns.emails.length}, Phones=${columns.phones.length}`);

    const optimized = {
        names: [...columns.names],
        types: [...columns.types],
        emails: [...columns.emails],
        phones: [...columns.phones]
    };

    // Use type count as the reference
    const typeCount = optimized.types.length;

    // FIX NAMES: Combine split names if we have more names than types
    if (optimized.names.length > typeCount) {
        optimized.names = fixSplitNames(optimized.names, typeCount);
    }

    // FIX EMAILS: Align emails with names/types
    optimized.emails = alignEmailsWithNames(optimized.names, optimized.emails, typeCount);

    // FIX PHONES: Simple alignment
    if (optimized.phones.length > typeCount) {
        optimized.phones = optimized.phones.slice(0, typeCount);
    }

    // Ensure all arrays have exactly expectedCount elements
    while (optimized.names.length < expectedCount) optimized.names.push('');
    while (optimized.types.length < expectedCount) optimized.types.push('');
    while (optimized.emails.length < expectedCount) optimized.emails.push('');
    while (optimized.phones.length < expectedCount) optimized.phones.push('');

    console.log(`After optimization: Names=${optimized.names.length}, Types=${optimized.types.length}, Emails=${optimized.emails.length}, Phones=${optimized.phones.length}`);

    return optimized;
}

// Fix split names by combining single words
function fixSplitNames(names, targetCount) {
    if (names.length <= targetCount) return names.slice(0, targetCount);

    const fixedNames = [];
    let i = 0;

    while (i < names.length && fixedNames.length < targetCount) {
        let currentName = names[i];

        // If this looks like a split name (single word) and we need to reduce count
        const isSingleWord = currentName.split(' ').length === 1;
        const remainingNames = names.length - i - 1;
        const neededNames = targetCount - fixedNames.length;

        if (isSingleWord && remainingNames >= neededNames) {
            // This might be a split name - combine with next
            if (i + 1 < names.length) {
                currentName += ' ' + names[i + 1];
                i++; // Skip the next name
            }
        }

        fixedNames.push(currentName);
        i++;
    }

    return fixedNames;
}

// Align emails with names by checking similarity
function alignEmailsWithNames(names, emails, targetCount) {
    const alignedEmails = new Array(targetCount).fill('');
    let emailIndex = 0;

    for (let nameIndex = 0; nameIndex < targetCount && emailIndex < emails.length; nameIndex++) {
        const currentEmail = emails[emailIndex];

        if (emailMatchesName(currentEmail, names[nameIndex])) {
            alignedEmails[nameIndex] = currentEmail;
            emailIndex++;
        } else {
            // Check if this email belongs to a future name
            let foundMatch = false;
            for (let futureIndex = nameIndex + 1; futureIndex < Math.min(nameIndex + 3, targetCount); futureIndex++) {
                if (emailMatchesName(currentEmail, names[futureIndex])) {
                    // Leave current position empty, the email will be placed later
                    foundMatch = true;
                    break;
                }
            }

            if (!foundMatch) {
                // Email doesn't match any nearby name, use it here
                alignedEmails[nameIndex] = currentEmail;
                emailIndex++;
            }
        }
    }

    return alignedEmails;
}

// Create rentals from optimized table columns
function createRentalsFromTable(columns, province) {
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

    return rentals;
}

// [Keep all your existing helper functions: isHeaderLine, isNameLine, isTypeLine, isEmailLine, etc.]
// [Keep all your existing API routes]

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
