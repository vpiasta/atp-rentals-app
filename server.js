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

// COMPLETELY NEW APPROACH: State machine that tracks column positions
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
                const provinceRentals = parseProvinceSectionAdvanced(currentSection, currentProvince);
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
                const provinceRentals = parseProvinceSectionAdvanced(currentSection, currentProvince);
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
        const provinceRentals = parseProvinceSectionAdvanced(currentSection, currentProvince);
        rentals.push(...provinceRentals);
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// NEW: Advanced province parsing using state machine
function parseProvinceSectionAdvanced(sectionLines, province) {
    const rentals = [];

    // Find the column structure
    const columnStructure = analyzeColumnStructure(sectionLines);

    if (columnStructure.hasColumns) {
        // Use column-based parsing
        const columnRentals = parseUsingColumns(sectionLines, columnStructure, province);
        rentals.push(...columnRentals);
    } else {
        // Fallback to line grouping
        const groupedRentals = parseUsingLineGrouping(sectionLines, province);
        rentals.push(...groupedRentals);
    }

    console.log(`Province ${province}: ${rentals.length} rentals`);
    return rentals;
}

// NEW: Analyze the column structure of the section
function analyzeColumnStructure(sectionLines) {
    const analysis = {
        hasColumns: false,
        nameColumn: [],
        typeColumn: [],
        emailColumn: [],
        phoneColumn: [],
        columnStarts: { names: -1, types: -1, emails: -1, phones: -1 }
    };

    // Look for column headers to identify column starts
    for (let i = 0; i < sectionLines.length; i++) {
        const line = sectionLines[i];

        if (line === 'Nombre' && analysis.columnStarts.names === -1) {
            analysis.columnStarts.names = i;
        } else if (line === 'Modalidad' && analysis.columnStarts.types === -1) {
            analysis.columnStarts.types = i;
        } else if (line === 'Correo Principal' && analysis.columnStarts.emails === -1) {
            analysis.columnStarts.emails = i;
        } else if (line === 'Teléfono' && analysis.columnStarts.phones === -1) {
            analysis.columnStarts.phones = i;
        }
    }

    // If we found column headers, extract the columns
    if (analysis.columnStarts.names !== -1) {
        analysis.hasColumns = true;

        // Extract each column
        analysis.nameColumn = extractColumn(sectionLines, analysis.columnStarts.names + 1, 'name');
        analysis.typeColumn = extractColumn(sectionLines, analysis.columnStarts.types + 1, 'type');
        analysis.emailColumn = extractColumn(sectionLines, analysis.columnStarts.emails + 1, 'email');
        analysis.phoneColumn = extractColumn(sectionLines, analysis.columnStarts.phones + 1, 'phone');
    }

    return analysis;
}

// NEW: Extract a single column
function extractColumn(sectionLines, startIndex, columnType) {
    const columnData = [];
    let i = startIndex;

    while (i < sectionLines.length) {
        const line = sectionLines[i];

        // Stop if we hit the next column header or end of data
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono' ||
            line.includes('Total por provincia:') || line.includes('Provincia:')) {
            break;
        }

        // Add valid data based on column type
        if (columnType === 'name' && isNameLine(line)) {
            columnData.push(line);
        } else if (columnType === 'type' && isTypeLine(line)) {
            columnData.push(line);
        } else if (columnType === 'email' && isEmailLine(line)) {
            columnData.push(line);
        } else if (columnType === 'phone' && isPhoneLine(line)) {
            columnData.push(line);
        } else if (line.length > 0) {
            // For ambiguous lines, try to categorize
            if (columnType === 'name' && !isEmailLine(line) && !isPhoneLine(line) && !isTypeLine(line)) {
                columnData.push(line);
            }
        }

        i++;
    }

    return columnData;
}

// NEW: Parse using the identified columns
function parseUsingColumns(sectionLines, columnStructure, province) {
    const rentals = [];

    const names = columnStructure.nameColumn;
    const types = columnStructure.typeColumn;
    const emails = columnStructure.emailColumn;
    const phones = columnStructure.phoneColumn;

    // Align the columns - they should have the same number of records
    const maxRecords = Math.max(names.length, types.length, emails.length, phones.length);

    for (let i = 0; i < maxRecords; i++) {
        const name = names[i] || '';
        const type = types[i] || '';
        const email = emails[i] || '';
        const phone = phones[i] || '';

        // Only create record if we have a valid name
        if (name && name.length > 2) {
            const rental = createRentalObject(name, type, email, phone, province);
            if (rental) {
                rentals.push(rental);
            }
        }
    }

    return rentals;
}

// NEW: Fallback parsing using line grouping
function parseUsingLineGrouping(sectionLines, province) {
    const rentals = [];
    const recordGroups = [];

    // Group lines into potential records
    let currentGroup = [];
    let inRecord = false;

    for (const line of sectionLines) {
        // Skip headers and metadata
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono' ||
            line.includes('Provincia:') || line.includes('Total por provincia:')) {
            continue;
        }

        // If we find a clear name line, start a new group
        if (isClearNameLine(line)) {
            if (currentGroup.length >= 3) {
                recordGroups.push([...currentGroup]);
            }
            currentGroup = [line];
            inRecord = true;
        } else if (inRecord && currentGroup.length < 6) {
            // Add to current group if we're in a record
            currentGroup.push(line);
        }
    }

    // Don't forget the last group
    if (currentGroup.length >= 3) {
        recordGroups.push(currentGroup);
    }

    // Parse each group
    for (const group of recordGroups) {
        const rental = parseRecordGroup(group, province);
        if (rental) {
            rentals.push(rental);
        }
    }

    return rentals;
}

// NEW: Parse a group of lines as a single record
function parseRecordGroup(groupLines, province) {
    let name = '', type = '', email = '', phone = '';

    // Assign lines based on content
    for (const line of groupLines) {
        if (!name && isClearNameLine(line)) {
            name = line;
        } else if (!type && isTypeLine(line)) {
            type = line;
        } else if (!email && isEmailLine(line)) {
            email = line;
        } else if (!phone && isPhoneLine(line)) {
            phone = line;
        }
    }

    // If we have a name but no type, try to find one
    if (name && !type) {
        for (const line of groupLines) {
            if (line !== name && line !== email && line !== phone && isPossibleType(line)) {
                type = line;
                break;
            }
        }
    }

    if (name && name.length > 2) {
        return createRentalObject(name, type, email, phone, province);
    }

    return null;
}

// NEW: More strict name detection
function isClearNameLine(line) {
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
           !line.includes('Total por provincia:') &&
           !line.match(/^\d/) &&
           // Names typically don't contain slashes or special patterns
           !line.includes('/') &&
           !line.match(/^\d/) &&
           // Real names are usually proper case or all caps, not lowercase
           (line === line.toUpperCase() || /[A-Z]/.test(line.charAt(0)));
}

function isPossibleType(line) {
    return isTypeLine(line) ||
           line.length < 20 &&
           !line.includes('@') &&
           !isPhoneLine(line) &&
           !isClearNameLine(line);
}

// Keep the existing helper functions but use the improved ones
function isHeaderLine(line) {
    return line.includes('Reporte de Hospedajes vigentes') ||
           line.includes('Reporte: rep_hos_web') ||
           line.includes('Actualizado al') ||
           line.match(/Página \d+ de \d+/);
}

function isNameLine(line) {
    return isClearNameLine(line);
}

function isTypeLine(line) {
    const types = [
        'Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel',
        'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña',
        'Glamping', 'Camping', 'Residencial', 'Pensión'
    ];
    return types.some(type => line.toUpperCase().includes(type.toUpperCase()));
}

function isEmailLine(line) {
    return line.includes('@') &&
           (line.includes('.com') || line.includes('.net') || line.includes('.org') ||
            line.includes('.edu') || line.includes('.gob') || line.includes('.pa'));
}

function isPhoneLine(line) {
    const cleanLine = line.replace(/\s+/g, '').replace(/\//g, '');
    const phonePatterns = [
        /^\d{7,8}$/,
        /^\d{3,4}[-]?\d{3,4}$/,
        /^\d{4}[-]?\d{4}$/
    ];
    return phonePatterns.some(pattern => pattern.test(cleanLine));
}

function extractEmail(text) {
    if (!text) return '';
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    if (!text) return '';
    const patterns = [
        /(\d{4}[- ]?\d{4})/,
        /(\d{3}[- ]?\d{4})/,
        /(\d{7,8})/
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return match[1].replace(/[- ]/g, '');
        }
    }
    return '';
}

function createRentalObject(name, type, email, phone, province) {
    const cleanName = cleanText(name);
    const cleanType = cleanText(type || 'Hospedaje');
    const cleanEmail = extractEmail(email);
    const cleanPhone = extractFirstPhone(phone);

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
    ];
}

// Keep all your existing API routes (they remain the same)
// ... [all API routes] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
