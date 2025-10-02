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

// Keep your existing fetchAndParsePDF function, but let's modify the parser

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

                const parsedRentals = parsePDFWithColumnDetection(data.text);
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

// NEW: Column-based parser that analyzes the actual PDF structure
function parsePDFWithColumnDetection(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    // First, let's understand the structure by finding patterns
    const structureAnalysis = analyzePDFStructure(lines);

    if (structureAnalysis.hasClearColumns) {
        return parseWithColumnAlignment(lines, structureAnalysis);
    } else {
        return parseWithLineGrouping(lines);
    }
}

// NEW: Analyze PDF structure to understand the layout
function analyzePDFStructure(lines) {
    const analysis = {
        totalLines: lines.length,
        hasClearColumns: false,
        columnPatterns: [],
        sampleSections: [],
        provincesFound: []
    };

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    // Find provinces and sample their sections
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for province headers
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch && !analysis.provincesFound.includes(provinceMatch)) {
            analysis.provincesFound.push(provinceMatch);

            // Take a sample of the next 20 lines after province header
            const sectionStart = i + 1;
            const sectionEnd = Math.min(i + 21, lines.length);
            const sectionSample = lines.slice(sectionStart, sectionEnd);

            analysis.sampleSections.push({
                province: provinceMatch,
                lines: sectionSample
            });
        }
    }

    // Analyze column structure from samples
    analysis.sampleSections.forEach(sample => {
        const columnAnalysis = analyzeSectionColumns(sample.lines);
        analysis.columnPatterns.push(columnAnalysis);

        if (columnAnalysis.hasConsistentColumns) {
            analysis.hasClearColumns = true;
        }
    });

    return analysis;
}

// NEW: Analyze a section for column patterns
function analyzeSectionColumns(sectionLines) {
    const analysis = {
        totalLines: sectionLines.length,
        nameLines: 0,
        typeLines: 0,
        emailLines: 0,
        phoneLines: 0,
        mixedLines: 0,
        hasConsistentColumns: false
    };

    sectionLines.forEach(line => {
        if (isNameLine(line)) analysis.nameLines++;
        if (isTypeLine(line)) analysis.typeLines++;
        if (isEmailLine(line)) analysis.emailLines++;
        if (isPhoneLine(line)) analysis.phoneLines++;

        // Count how many types this line matches
        const matches = [isNameLine(line), isTypeLine(line), isEmailLine(line), isPhoneLine(line)].filter(Boolean).length;
        if (matches > 1) analysis.mixedLines++;
    });

    // If we have roughly equal numbers of each type, we likely have columns
    const minCount = Math.min(analysis.nameLines, analysis.typeLines, analysis.emailLines, analysis.phoneLines);
    const maxCount = Math.max(analysis.nameLines, analysis.typeLines, analysis.emailLines, analysis.phoneLines);

    analysis.hasConsistentColumns = (minCount > 0 && (maxCount - minCount) <= 2);

    return analysis;
}

// NEW: Parse using column alignment approach
function parseWithColumnAlignment(lines, structureAnalysis) {
    const rentals = [];
    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    let currentProvince = '';
    let currentSection = [];
    let inSection = false;

    // Group by provinces first
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) continue;

        // Detect province
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch) {
            if (currentSection.length > 0 && currentProvince) {
                const provinceRentals = extractRentalsFromColumns(currentSection, currentProvince);
                rentals.push(...provinceRentals);
            }
            currentProvince = provinceMatch;
            currentSection = [];
            inSection = true;
            continue;
        }

        // Detect end of section
        if (inSection && (line.includes('Total por provincia:') || line.includes('Total Provincial:'))) {
            if (currentSection.length > 0 && currentProvince) {
                const provinceRentals = extractRentalsFromColumns(currentSection, currentProvince);
                rentals.push(...provinceRentals);
            }
            currentSection = [];
            inSection = false;
            continue;
        }

        // Add to current section
        if (inSection && line.length > 2) {
            currentSection.push(line);
        }
    }

    // Process last section
    if (currentSection.length > 0 && currentProvince) {
        const provinceRentals = extractRentalsFromColumns(currentSection, currentProvince);
        rentals.push(...provinceRentals);
    }

    return rentals;
}

// NEW: Extract rentals by aligning columns
function extractRentalsFromColumns(sectionLines, province) {
    const rentals = [];

    // Separate lines into columns based on content type
    const names = [];
    const types = [];
    const emails = [];
    const phones = [];

    sectionLines.forEach(line => {
        if (isNameLine(line)) {
            names.push(line);
        } else if (isTypeLine(line)) {
            types.push(line);
        } else if (isEmailLine(line)) {
            emails.push(line);
        } else if (isPhoneLine(line)) {
            phones.push(line);
        }
    });

    // Align the columns - assume they're in order
    const maxLength = Math.max(names.length, types.length, emails.length, phones.length);

    for (let i = 0; i < maxLength; i++) {
        const name = names[i] || '';
        const type = types[i] || (names[i] ? 'Hospedaje' : '');
        const email = emails[i] || '';
        const phone = phones[i] || '';

        if (name && name.length > 2) {
            const rental = createRentalObject(name, type, email, phone, province);
            rentals.push(rental);
        }
    }

    return rentals;
}

// NEW: Alternative parsing method using line grouping
function parseWithLineGrouping(lines) {
    const rentals = [];
    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    let currentProvince = '';
    let recordLines = [];
    let inDataSection = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (isHeaderLine(line)) continue;

        // Detect province
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch) {
            // Process previous record if any
            if (recordLines.length >= 3) {
                const rental = parseRentalFromLines(recordLines, currentProvince);
                if (rental) rentals.push(rental);
            }

            currentProvince = provinceMatch;
            recordLines = [];
            inDataSection = true;
            continue;
        }

        // End of section
        if (inDataSection && (line.includes('Total por provincia:') || line.includes('Total Provincial:'))) {
            if (recordLines.length >= 3) {
                const rental = parseRentalFromLines(recordLines, currentProvince);
                if (rental) rentals.push(rental);
            }
            recordLines = [];
            inDataSection = false;
            continue;
        }

        // Collect data lines
        if (inDataSection && line.length > 2) {
            recordLines.push(line);

            // Try to parse when we have 3-4 lines
            if (recordLines.length >= 4) {
                const rental = parseRentalFromLines(recordLines, currentProvince);
                if (rental) {
                    rentals.push(rental);
                    recordLines = []; // Reset for next record
                } else if (recordLines.length > 6) {
                    // If we can't parse after 6 lines, reset to avoid infinite growth
                    recordLines = recordLines.slice(1); // Remove oldest line
                }
            }
        }
    }

    // Process last record
    if (recordLines.length >= 3) {
        const rental = parseRentalFromLines(recordLines, currentProvince);
        if (rental) rentals.push(rental);
    }

    return rentals;
}

// NEW: Parse rental from a group of lines
function parseRentalFromLines(lines, province) {
    let name = '', type = '', email = '', phone = '';

    // Try different line assignments
    for (const line of lines) {
        if (!name && isNameLine(line)) {
            name = cleanText(line);
        } else if (!type && isTypeLine(line)) {
            type = cleanText(line);
        } else if (!email && isEmailLine(line)) {
            email = extractEmail(line);
        } else if (!phone && isPhoneLine(line)) {
            phone = extractFirstPhone(line);
        }
    }

    // Fallback: assign remaining lines
    if (!type) {
        for (const line of lines) {
            const cleanLine = cleanText(line);
            if (cleanLine !== name && cleanLine !== email && cleanLine !== phone && cleanLine.length > 0) {
                type = cleanLine;
                break;
            }
        }
    }

    if (!name || name.length < 2) {
        return null;
    }

    return createRentalObject(name, type || 'Hospedaje', email, phone, province);
}

// NEW: Create standardized rental object
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

// NEW: Debug endpoint to show PDF structure
app.get('/api/debug-structure', async (req, res) => {
    try {
        let pdfText = '';
        let rawLines = [];

        // Fetch and parse PDF
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

        // Analyze structure
        const structureAnalysis = analyzePDFStructure(rawLines);

        // Get sample of each province section
        const provinceSamples = [];
        const provinces = [
            'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
            'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
            'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
        ];

        provinces.forEach(province => {
            const provinceIndex = rawLines.findIndex(line =>
                line.toUpperCase().includes(province.toUpperCase())
            );

            if (provinceIndex !== -1) {
                const sampleStart = Math.max(0, provinceIndex - 2);
                const sampleEnd = Math.min(rawLines.length, provinceIndex + 25);
                const sample = rawLines.slice(sampleStart, sampleEnd);

                provinceSamples.push({
                    province: province,
                    startIndex: provinceIndex,
                    sample: sample
                });
            }
        });

        // Parse with both methods for comparison
        const columnResults = parseWithColumnAlignment(rawLines, structureAnalysis);
        const groupingResults = parseWithLineGrouping(rawLines);

        res.json({
            pdf_info: {
                total_lines: rawLines.length,
                first_10_lines: rawLines.slice(0, 10),
                last_10_lines: rawLines.slice(-10)
            },
            structure_analysis: structureAnalysis,
            province_samples: provinceSamples,
            parsing_results: {
                column_method: {
                    count: columnResults.length,
                    sample: columnResults.slice(0, 5)
                },
                grouping_method: {
                    count: groupingResults.length,
                    sample: groupingResults.slice(0, 5)
                }
            },
            raw_structure_sample: {
                lines_50_to_70: rawLines.slice(50, 70),
                lines_100_to_120: rawLines.slice(100, 120)
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Keep your existing helper functions (isNameLine, isTypeLine, isEmailLine, isPhoneLine, etc.)
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
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge', 'Hospedaje'];
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
    // Your 20 complete datasets from Script 2
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

// Keep your existing API routes (test, rentals, provinces, types, stats, debug-pdf, refresh-pdf)

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
