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
    try {
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
    } catch (error) {
        console.error('Error in parsePDFText:', error);
        return getFallbackData();
    }
}

function processTable(lines, startIndex, province, expectedCount) {
    try {
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
    } catch (error) {
        console.error(`Error processing table for ${province}:`, error);
        return { rentals: [], nextIndex: startIndex };
    }
}

function processEmailLine(currentLine, lines, currentIndex) {
    let email = currentLine;

    // Check if email continues on next line
    if (currentIndex + 1 < lines.length) {
        const nextLine = lines[currentIndex + 1];
        if (isEmailContinuation(currentLine, nextLine)) {
            email += nextLine;
        }
    }

    return email.replace(/\s+/g, ''); // Remove all spaces
}

// New processPhoneLine function with this improved version:
function processPhoneLine(currentLine, lines, currentIndex) {
    let phone = currentLine;

    // Check if phone continues on next line (YOUR LOGIC: if ends with slash, combine with next)
    if (currentIndex + 1 < lines.length) {
        const nextLine = lines[currentIndex + 1];

        // YOUR LOGIC: If current line ends with "/", combine with next line
        if (currentLine.trim().endsWith('/')) {
            phone += ' ' + nextLine;
            // Mark the next line as processed
            lines[currentIndex + 1] = 'PROCESSED';
        }
        // Also combine if next line looks like a phone continuation
        else if (isPhoneContinuation(currentLine, nextLine)) {
            phone += ' ' + nextLine;
            lines[currentIndex + 1] = 'PROCESSED';
        }
    }

    return phone;
}

// isPhoneContinuation function:
function isPhoneContinuation(currentLine, nextLine) {
    // If current line ends with slash, definitely combine
    if (currentLine.trim().endsWith('/')) return true;

    // If current line has incomplete phone and next line has digits, combine
    const currentDigits = (currentLine.match(/\d/g) || []).length;
    const nextDigits = (nextLine.match(/\d/g) || []).length;

    return (currentDigits < 8 && nextDigits > 0) ||
           (currentLine.includes('-') && !currentLine.match(/\d{8}/));
}

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

function extractEmail(text) {
    if (!text) return '';
    try {
        const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        return match ? match[1] : '';
    } catch (error) {
        return '';
    }
}

function extractFirstPhone(text) {
    if (!text) return '';
    try {
        // Remove slashes and hyphens, take first 8 digits
        const cleanText = text.replace(/[-\/\s]/g, '');
        const match = cleanText.match(/(\d{7,8})/);
        return match ? match[1] : '';
    } catch (error) {
        return '';
    }
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

// API ROUTES WITH ERROR HANDLING
app.get('/api/test', (req, res) => {
    try {
        res.json({
            message: 'ATP Rentals Search API is working!',
            status: 'success',
            timestamp: new Date().toISOString(),
            data_source: 'LIVE_ATP_PDF',
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0
        });
    } catch (error) {
        console.error('Error in /api/test:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/rentals', (req, res) => {
    try {
        const { search, province, type } = req.query;
        let filtered = CURRENT_RENTALS || [];

        if (search) {
            const searchLower = search.toLowerCase();
            filtered = filtered.filter(rental =>
                rental && rental.name && rental.name.toLowerCase().includes(searchLower) ||
                (rental.district && rental.district.toLowerCase().includes(searchLower)) ||
                (rental.description && rental.description.toLowerCase().includes(searchLower)) ||
                (rental.province && rental.province.toLowerCase().includes(searchLower)) ||
                (rental.type && rental.type.toLowerCase().includes(searchLower))
            );
        }

        if (province && province !== '') {
            filtered = filtered.filter(rental =>
                rental && rental.province && rental.province.toLowerCase() === province.toLowerCase()
            );
        }

        if (type && type !== '') {
            filtered = filtered.filter(rental =>
                rental && rental.type && rental.type.toLowerCase() === type.toLowerCase()
            );
        }

        res.json(filtered);
    } catch (error) {
        console.error('Error in /api/rentals:', error);
        res.status(500).json({ error: 'Error al buscar hospedajes' });
    }
});

app.get('/api/provinces', (req, res) => {
    try {
        const provinces = CURRENT_RENTALS ?
            [...new Set(CURRENT_RENTALS.map(r => r?.province).filter(Boolean))].sort() : [];
        res.json(provinces);
    } catch (error) {
        console.error('Error in /api/provinces:', error);
        res.status(500).json({ error: 'Error cargando provincias' });
    }
});

app.get('/api/types', (req, res) => {
    try {
        const types = CURRENT_RENTALS ?
            [...new Set(CURRENT_RENTALS.map(r => r?.type).filter(Boolean))].sort() : [];
        res.json(types);
    } catch (error) {
        console.error('Error in /api/types:', error);
        res.status(500).json({ error: 'Error cargando tipos' });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        res.json({
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            last_updated: LAST_PDF_UPDATE || new Date().toISOString(),
            data_source: 'LIVE_ATP_DATA',
            status: PDF_STATUS,
            note: 'Datos oficiales de la Autoridad de Turismo de Panamá'
        });
    } catch (error) {
        console.error('Error in /api/stats:', error);
        res.status(500).json({ error: 'Error cargando estadísticas' });
    }
});

app.get('/api/debug-pdf', (req, res) => {
    try {
        const sampleWithContacts = CURRENT_RENTALS ?
            CURRENT_RENTALS.filter(rental => rental && (rental.email || rental.phone)).slice(0, 10) : [];

        res.json({
            pdf_status: PDF_STATUS,
            total_rentals_found: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            last_update: LAST_PDF_UPDATE,
            sample_with_contacts: sampleWithContacts,
            all_provinces: CURRENT_RENTALS ?
                [...new Set(CURRENT_RENTALS.map(r => r?.province).filter(Boolean))] : [],
            all_types: CURRENT_RENTALS ?
                [...new Set(CURRENT_RENTALS.map(r => r?.type).filter(Boolean))] : []
        });
    } catch (error) {
        console.error('Error in /api/debug-pdf:', error);
        res.status(500).json({ error: 'Error en debug' });
    }
});

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            message: success ? 'PDF data refreshed successfully' : 'Failed to refresh PDF data',
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            status: PDF_STATUS,
            last_update: LAST_PDF_UPDATE
        });
    } catch (error) {
        console.error('Error in /api/refresh-pdf:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        rentals_loaded: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
        pdf_status: PDF_STATUS
    });
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);

    // Load PDF data on startup
    setTimeout(async () => {
        try {
            await fetchAndParsePDF();
            console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
        } catch (error) {
            console.error('Error during startup:', error);
            CURRENT_RENTALS = getFallbackData();
        }
    }, 2000);
});
