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
let LAST_ERROR = null;

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
                LAST_ERROR = null;

                // Extract all rentals from the PDF
                const parsedRentals = extractAllRentals(data.text);
                console.log(`Extracted ${parsedRentals.length} rentals from PDF`);

                if (parsedRentals.length === 0) {
                    LAST_ERROR = 'PDF parsing completed but found 0 rentals. The PDF structure may be different than expected.';
                    PDF_STATUS = 'ERROR: No rentals found in PDF';
                }

                CURRENT_RENTALS = parsedRentals;
                return parsedRentals.length > 0;
            }
        } catch (error) {
            const errorMsg = `Failed to fetch PDF: ${error.message}`;
            console.log(errorMsg);
            LAST_ERROR = errorMsg;
            PDF_STATUS = 'ERROR: Failed to fetch PDF';
        }
    }

    PDF_STATUS = 'ERROR: No PDF available or accessible';
    CURRENT_RENTALS = [];
    return false;
}

// COMPREHENSIVE EXTRACTION OF ALL RENTALS
function extractAllRentals(text) {
    console.log('=== EXTRACTING ALL RENTALS ===');
    const rentals = [];

    // Extract all provinces and their rentals
    const provincesData = extractAllProvinces(text);

    for (const provinceData of provincesData) {
        const provinceRentals = extractRentalsFromProvince(provinceData.lines, provinceData.province);
        rentals.push(...provinceRentals);
    }

    console.log(`Total rentals extracted: ${rentals.length}`);
    return rentals;
}

function extractAllProvinces(text) {
    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const provinceSections = [];
    let currentProvince = '';
    let currentSection = [];
    let inProvinceSection = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (line.includes('Reporte de Hospedajes vigentes') ||
            line.includes('Reporte: rep_hos_web') ||
            line.includes('Actualizado al') ||
            line.match(/Página \d+ de \d+/)) {
            continue;
        }

        // Detect province start
        const provinceMatch = provinces.find(p => line.includes(p));
        if (provinceMatch && line.includes('Provincia:')) {
            // Save previous section
            if (currentProvince && currentSection.length > 0) {
                provinceSections.push({
                    province: currentProvince,
                    lines: [...currentSection]
                });
            }

            // Start new province
            currentProvince = provinceMatch;
            currentSection = [];
            inProvinceSection = true;
            console.log(`Processing province: ${currentProvince}`);
            continue;
        }

        // Detect end of province data
        if (inProvinceSection && line.includes('Total por provincia:')) {
            if (currentSection.length > 0) {
                provinceSections.push({
                    province: currentProvince,
                    lines: [...currentSection]
                });
            }
            currentSection = [];
            inProvinceSection = false;
            continue;
        }

        // Collect data lines
        if (inProvinceSection && line.length > 2) {
            currentSection.push(line);
        }
    }

    // Add the last province
    if (currentProvince && currentSection.length > 0) {
        provinceSections.push({
            province: currentProvince,
            lines: [...currentSection]
        });
    }

    return provinceSections;
}

function extractRentalsFromProvince(lines, province) {
    const rentals = [];

    // Group lines into rental blocks (name, type, email, phone)
    const rentalBlocks = groupIntoRentalBlocks(lines);

    for (const block of rentalBlocks) {
        const rental = createRentalFromBlock(block, province);
        if (rental && rental.name && rental.name.length > 2) {
            rentals.push(rental);
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals`);
    return rentals;
}

function groupIntoRentalBlocks(lines) {
    const blocks = [];
    let currentBlock = [];

    for (const line of lines) {
        // Skip column headers
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
            continue;
        }

        currentBlock.push(line);

        // Try to detect when we have a complete rental block
        if (currentBlock.length >= 4) {
            // Check if this looks like a complete rental
            if (isCompleteRentalBlock(currentBlock)) {
                blocks.push([...currentBlock]);
                currentBlock = [];
            } else if (currentBlock.length >= 8) {
                // If we have too many lines, take first 4 and continue
                blocks.push(currentBlock.slice(0, 4));
                currentBlock = currentBlock.slice(4);
            }
        }
    }

    // Add any remaining block
    if (currentBlock.length >= 2) {
        blocks.push([...currentBlock]);
    }

    return blocks;
}

function isCompleteRentalBlock(block) {
    // A block is likely complete if it has a name line and some contact info
    if (block.length < 2) return false;

    const hasName = block.some(line => isRentalName(line));
    const hasContact = block.some(line => isEmailLine(line) || isPhoneLine(line));

    return hasName && hasContact;
}

function createRentalFromBlock(block, province) {
    // Extract data from the block
    let name = '';
    let type = 'Hospedaje';
    let email = '';
    let phone = '';

    for (const line of block) {
        if (isRentalName(line) && !name) {
            name = cleanText(line);
        } else if (isRentalType(line) && type === 'Hospedaje') {
            type = line;
        } else if (isEmailLine(line) && !email) {
            email = extractEmail(line);
        } else if (isPhoneLine(line) && !phone) {
            phone = extractPhone(line);
        }
    }

    // If we didn't find a name, try the first line
    if (!name && block.length > 0) {
        name = cleanText(block[0]);
    }

    if (!name || name.length < 2) {
        return null;
    }

    return {
        name: name,
        type: type,
        email: email,
        phone: phone,
        province: province,
        district: guessDistrict(name, province),
        description: `${type} "${name}" registrado en ${province}, Panamá.`,
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(name + ' ' + province + ' Panamá')}`,
        whatsapp: phone,
        source: 'ATP_OFFICIAL'
    };
}

// Enhanced helper functions
function isRentalName(line) {
    return line.length > 3 &&
           !line.includes('@') &&
           !isPhoneLine(line) &&
           !isRentalType(line) &&
           !isColumnHeader(line);
}

function isRentalType(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge'];
    return types.some(type => line.includes(type));
}

function isEmailLine(line) {
    return line.includes('@') && line.includes('.');
}

function isPhoneLine(line) {
    return /\d{3,4}[- \/]?\d{3,4}[- \/]?\d{3,4}/.test(line) ||
           (line.includes('/') && /\d+/.test(line));
}

function isColumnHeader(line) {
    const headers = ['Nombre', 'Modalidad', 'Correo Principal', 'Teléfono', 'Provincia:', 'Total por provincia:'];
    return headers.some(header => line.includes(header));
}

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractPhone(text) {
    // Extract the first complete phone number
    const match = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    return match ? match[1] : '';
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

// API Routes
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals Search API is working!',
        status: 'success',
        timestamp: new Date().toISOString(),
        data_source: 'LIVE_ATP_PDF',
        total_rentals: CURRENT_RENTALS.length,
        has_data: CURRENT_RENTALS.length > 0,
        last_error: LAST_ERROR
    });
});

app.get('/api/rentals', (req, res) => {
    if (CURRENT_RENTALS.length === 0) {
        return res.status(503).json({
            error: 'No rental data available',
            message: LAST_ERROR || 'The PDF parsing failed. Please check the /api/debug-pdf endpoint for details.',
            suggestion: 'Try refreshing the data using POST /api/refresh-pdf'
        });
    }

    const { search, province, type } = req.query;
    let filtered = CURRENT_RENTALS;

    if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            rental.district.toLowerCase().includes(searchLower) ||
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
    if (CURRENT_RENTALS.length === 0) {
        return res.json([]);
    }
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))].sort();
    res.json(provinces);
});

app.get('/api/types', (req, res) => {
    if (CURRENT_RENTALS.length === 0) {
        return res.json([]);
    }
    const types = [...new Set(CURRENT_RENTALS.map(r => r.type))].sort();
    res.json(types);
});

app.get('/api/stats', (req, res) => {
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))];
    const provinceCounts = {};
    provinces.forEach(province => {
        provinceCounts[province] = CURRENT_RENTALS.filter(r => r.province === province).length;
    });

    res.json({
        total_rentals: CURRENT_RENTALS.length,
        last_updated: LAST_PDF_UPDATE || new Date().toISOString(),
        data_source: 'LIVE_ATP_DATA',
        status: PDF_STATUS,
        last_error: LAST_ERROR,
        has_data: CURRENT_RENTALS.length > 0,
        provinces: provinceCounts,
        note: CURRENT_RENTALS.length === 0 ? 'ERROR: No data extracted from PDF' : 'Datos oficiales de la Autoridad de Turismo de Panamá'
    });
});

app.get('/api/debug-pdf', (req, res) => {
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))];
    const provinceSamples = {};

    provinces.forEach(province => {
        const provinceRentals = CURRENT_RENTALS.filter(r => r.province === province);
        provinceSamples[province] = {
            count: provinceRentals.length,
            sample: provinceRentals.slice(0, 3)
        };
    });

    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        last_update: LAST_PDF_UPDATE,
        last_error: LAST_ERROR,
        has_data: CURRENT_RENTALS.length > 0,
        provinces_found: provinces.length,
        provinces: provinceSamples,
        data_quality: {
            with_names: CURRENT_RENTALS.filter(r => r.name && r.name.length > 2).length,
            with_emails: CURRENT_RENTALS.filter(r => r.email).length,
            with_phones: CURRENT_RENTALS.filter(r => r.phone).length,
            with_types: CURRENT_RENTALS.filter(r => r.type && r.type !== 'Hospedaje').length
        },
        diagnosis: CURRENT_RENTALS.length === 0 ?
            'CRITICAL: No rentals extracted. The PDF structure may be incompatible.' :
            'OK: Data extracted successfully'
    });
});

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            message: success ?
                `PDF data refreshed successfully. Found ${CURRENT_RENTALS.length} rentals.` :
                `Failed to refresh PDF data. Error: ${LAST_ERROR}`,
            total_rentals: CURRENT_RENTALS.length,
            status: PDF_STATUS,
            last_error: LAST_ERROR,
            last_update: LAST_PDF_UPDATE
        });
    } catch (error) {
        res.status(500).json({
            error: error.message,
            message: 'Failed to refresh PDF data'
        });
    }
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        console.log('Attempting to load PDF data on startup...');
        const success = await fetchAndParsePDF();
        if (success) {
            console.log(`✅ Success! ${CURRENT_RENTALS.length} ATP rentals loaded`);
        } else {
            console.log(`❌ Failed to load PDF data: ${LAST_ERROR}`);
        }
    }, 2000);
});
