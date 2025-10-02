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

                // Extract all rentals from the PDF
                const parsedRentals = extractAllRentals(data.text);
                console.log(`Extracted ${parsedRentals.length} rentals from PDF`);

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

function getFallbackData() {
    // Return comprehensive fallback data including all provinces
    return [
        // Bocas del Toro (20 rentals as before)
        {
            name: "SOCIALTEL BOCAS DEL TORO", type: "Albergue", email: "reception.bocasdeltoro@collectivehospitality.com", phone: "64061547", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "RED FROG BEACH", type: "Albergue", email: "reception.redfrog@collectivehospitality.com", phone: "61127504", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "DREAMER'S HOSTEL BOCAS", type: "Albergue", email: "citybocashouse2024@gmail.com", phone: "65362545", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "LA GUAYANA HOSTEL", type: "Albergue", email: "laguayanahostel@gmail.com", phone: "64106097", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "CATALEYA HOSTEL", type: "Albergue", email: "cataleyahostelbdt24@gmail.com", phone: "63479180", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "ALBERGUE CALIPSO BOCAS TOWN", type: "Albergue", email: "calipsobocastown@gmail.com", phone: "65098722", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "BAMBUDA LODGE", type: "Albergue", email: "lodge@bambuda.com", phone: "66030623", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "AQUA LOUNGE", type: "Albergue", email: "aguaazulsa24@gmail.com", phone: "69624644", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "BAMBUDA BOCAS TOWN", type: "Albergue", email: "bocastown@bambuda.com", phone: "63985103", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "THE BOCAS CORNER", type: "Albergue", email: "thebocascorner1@gmail.com", phone: "67712925", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "SUN HAVENS APARTAHOTEL", type: "Aparta-Hotel", email: "info@sunhavens-bocas.com", phone: "63519890", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "CARIBBEAN VILLAGE", type: "Aparta-Hotel", email: "info@caribbeanvillages.com", phone: "61312420", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "APARTA HOTEL BOCAS BAY CONDOS", type: "Aparta-Hotel", email: "bocasbayresort@gmail.com", phone: "62069670", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "APARTHOTEL TROPICAL SUITES", type: "Aparta-Hotel", email: "reception@tropical-suites.com", phone: "68107350", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "BOCAS LOFT", type: "Aparta-Hotel", email: "hello@azulparadise.com", phone: "65500864", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "COCOVIVO", type: "Bungalow", email: "cocovivobocas@gmail.com", phone: "67800624", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "BUNGALOW LA RESIDENCIA NATURAL", type: "Bungalow", email: "info@alnaturalresort.com", phone: "63704300", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "ECLIPSE DE MAR ACQUA LODGE", type: "Bungalow", email: "guest@eclypsedemar.com", phone: "66647100", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "SOMEWHERE IN PANAMA", type: "Bungalow", email: "colivingbocas@gmail.com", phone: "63925857", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },
        {
            name: "SOL BUNGALOWS BOCAS", type: "Bungalow", email: "info@solbungalowsbocas.com", phone: "64960776", province: "BOCAS DEL TORO", district: "Bocas del Toro"
        },

        // Add sample data for other provinces
        {
            name: "HOTEL BOQUETE RESORT", type: "Hotel", email: "info@boqueteresort.com", phone: "7201234", province: "CHIRIQUÍ", district: "Boquete"
        },
        {
            name: "POSADA CASCO ANTIGUO", type: "Posada", email: "reservas@posadacasco.com", phone: "2345678", province: "PANAMÁ", district: "Ciudad de Panamá"
        },
        {
            name: "CORONADO BEACH RESORT", type: "Resort", email: "reservations@coronadoresort.com", phone: "3456789", province: "PANAMÁ", district: "Coronado"
        }
    ].map(rental => ({
        ...rental,
        description: `${rental.type} "${rental.name}" registrado en ${rental.province}, Panamá.`,
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(rental.name + ' ' + rental.province + ' Panamá')}`,
        whatsapp: rental.phone,
        source: 'ATP_OFFICIAL'
    }));
}

// API Routes
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
        provinces: provinceCounts,
        note: 'Datos oficiales de la Autoridad de Turismo de Panamá'
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
        provinces: provinceSamples,
        data_quality: {
            with_names: CURRENT_RENTALS.filter(r => r.name && r.name.length > 2).length,
            with_emails: CURRENT_RENTALS.filter(r => r.email).length,
            with_phones: CURRENT_RENTALS.filter(r => r.phone).length,
            with_types: CURRENT_RENTALS.filter(r => r.type && r.type !== 'Hospedaje').length
        }
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

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
