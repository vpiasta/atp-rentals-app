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

// NEW: Improved parser that handles the actual PDF structure
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

// NEW: Parse province section by finding column data
function parseProvinceSection(sectionLines, province) {
    const rentals = [];

    // Find the column data sections
    const columnSections = extractColumnSections(sectionLines);

    if (columnSections.names.length > 0) {
        // Align the columns - they should have the same number of records
        const maxRecords = Math.max(
            columnSections.names.length,
            columnSections.types.length,
            columnSections.emails.length,
            columnSections.phones.length
        );

        for (let i = 0; i < maxRecords; i++) {
            const name = columnSections.names[i] || '';
            const type = columnSections.types[i] || '';
            const email = columnSections.emails[i] || '';
            const phone = columnSections.phones[i] || '';

            if (name && name.length > 2 && !isEmailLine(name) && !isPhoneLine(name)) {
                const rental = createRentalObject(name, type, email, phone, province);
                rentals.push(rental);
            }
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals`);
    return rentals;
}

// NEW: Extract the four columns from section lines
function extractColumnSections(sectionLines) {
    const columns = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    let currentColumn = 'unknown';
    let foundHeaders = false;

    for (const line of sectionLines) {
        // Skip empty lines and headers
        if (!line || line.length < 2) continue;

        // Look for column headers to identify sections
        if (line === 'Nombre' || line === 'Modalidad' ||
            line === 'Correo Principal' || line === 'Teléfono') {
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

        // If we found headers, assign lines to columns based on content
        if (foundHeaders) {
            if (currentColumn === 'names' || isNameLine(line)) {
                if (isNameLine(line)) {
                    columns.names.push(line);
                    currentColumn = 'names';
                }
            } else if (currentColumn === 'types' || isTypeLine(line)) {
                if (isTypeLine(line)) {
                    columns.types.push(line);
                    currentColumn = 'types';
                }
            } else if (currentColumn === 'emails' || isEmailLine(line)) {
                if (isEmailLine(line)) {
                    columns.emails.push(line);
                    currentColumn = 'emails';
                }
            } else if (currentColumn === 'phones' || isPhoneLine(line)) {
                if (isPhoneLine(line)) {
                    columns.phones.push(line);
                    currentColumn = 'phones';
                }
            }
        } else {
            // Before headers are found, try to categorize based on content
            if (isNameLine(line)) {
                columns.names.push(line);
            } else if (isTypeLine(line)) {
                columns.types.push(line);
            } else if (isEmailLine(line)) {
                columns.emails.push(line);
            } else if (isPhoneLine(line)) {
                columns.phones.push(line);
            }
        }
    }

    return columns;
}

// NEW: Alternative approach - parse by fixed column positions
function parseProvinceSectionAlternative(sectionLines, province) {
    const rentals = [];

    // Group lines into potential records (4 lines per record)
    const recordGroups = [];
    let currentGroup = [];

    for (const line of sectionLines) {
        // Skip headers and metadata
        if (line === 'Nombre' || line === 'Modalidad' ||
            line === 'Correo Principal' || line === 'Teléfono' ||
            line.includes('Provincia:') || line.includes('Total por provincia:')) {
            continue;
        }

        currentGroup.push(line);

        // When we have 4 lines, try to form a record
        if (currentGroup.length >= 4) {
            // Check if this looks like a valid record (should have at least one name)
            const hasName = currentGroup.some(l => isNameLine(l));
            if (hasName) {
                recordGroups.push([...currentGroup]);
                currentGroup = [];
            } else {
                // Remove the oldest line and continue
                currentGroup.shift();
            }
        }
    }

    // Process any remaining group
    if (currentGroup.length >= 3) {
        recordGroups.push([...currentGroup]);
    }

    // Parse each group
    for (const group of recordGroups) {
        const rental = parseRentalGroup(group, province);
        if (rental) {
            rentals.push(rental);
        }
    }

    return rentals;
}

// NEW: Parse a group of lines as a rental record
function parseRentalGroup(lines, province) {
    let name = '', type = '', email = '', phone = '';

    // Assign lines based on content type
    for (const line of lines) {
        if (!name && isNameLine(line)) {
            name = line;
        } else if (!type && isTypeLine(line)) {
            type = line;
        } else if (!email && isEmailLine(line)) {
            email = line;
        } else if (!phone && isPhoneLine(line)) {
            phone = line;
        }
    }

    // If we couldn't identify all fields, make educated guesses
    if (!type) {
        // Look for any line that contains common type words
        for (const line of lines) {
            if (line !== name && line !== email && line !== phone) {
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

// NEW: Create rental object with proper cleaning
function createRentalObject(name, type, email, phone, province) {
    // Clean the data
    const cleanName = cleanText(name);
    const cleanType = cleanText(type || 'Hospedaje');
    const cleanEmail = extractEmail(email);
    const cleanPhone = extractFirstPhone(phone);

    // Validate name - it shouldn't be an email or phone number
    if (cleanEmail && cleanName.includes('@')) {
        return null;
    }
    if (cleanPhone && isPhoneLine(cleanName)) {
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
           line.match(/Página \d+ de \d+/) ||
           line.includes('Total por provincia:') ||
           line.includes('Provincia:');
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
    return phonePatterns.some(pattern => pattern.test(line.replace(/\//g, '').trim()));
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
        },
        {
            name: "RED FROG BEACH",
            type: "Albergue",
            email: "reception.redfrog@collectivehospitality.com",
            phone: "61127504",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro",
            description: "Albergue \"RED FROG BEACH\" ubicado en BOCAS DEL TORO, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).",
            google_maps_url: "https://maps.google.com/?q=RED%20FROG%20BEACH%20BOCAS%20DEL%20TORO%20Panam%C3%A1",
            whatsapp: "61127504",
            source: "ATP_OFFICIAL"
        }
        // Add more fallback records as needed
    ];
}

// NEW: Debug endpoint to analyze PDF structure
app.get('/api/debug-structure', async (req, res) => {
    try {
        let pdfText = '';
        let rawLines = [];

        // Fetch PDF
        for (const pdfUrl of PDF_URLS) {
            try {
                const response = await axios.get(pdfUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000
                });

                if (response.status === 200) {
                    const data = await pdf(response.data);
                    pdfText = data.text;
                    rawLines = data.text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                    break;
                }
            } catch (error) {
                console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
            }
        }

        if (!pdfText) {
            return res.status(500).json({ error: 'Could not fetch PDF' });
        }

        // Analyze Bocas del Toro section specifically
        const bocasIndex = rawLines.findIndex(line => line.includes('BOCAS DEL TORO'));
        const bocasSection = rawLines.slice(bocasIndex, bocasIndex + 50);

        // Parse with both methods for comparison
        const method1Results = parsePDFText(pdfText);
        const bocasRentals = method1Results.filter(r => r.province === 'BOCAS DEL TORO');

        res.json({
            pdf_info: {
                total_lines: rawLines.length,
                bocas_section_sample: bocasSection
            },
            parsing_results: {
                total_rentals: method1Results.length,
                bocas_del_toro_count: bocasRentals.length,
                bocas_sample: bocasRentals.slice(0, 10),
                sample_with_contacts: method1Results.filter(r => r.email || r.phone).slice(0, 5)
            },
            raw_structure: {
                lines_50_to_100: rawLines.slice(50, 100),
                lines_100_to_150: rawLines.slice(100, 150)
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Keep all your existing API routes
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
    console.log(`📍 Debug URL: http://localhost:${PORT}/api/debug-structure`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
