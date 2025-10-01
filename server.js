const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PDF URL - will be fetched from your United Domains hosting
const PDF_URLS = [
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf'
];

let CURRENT_RENTALS = [];
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';
let PDF_RAW_TEXT = '';

// Enhanced sample data as fallback
const ENHANCED_SAMPLE_RENTALS = [
    {
        id: 1,
        name: "Hotel Boquete Mountain Resort",
        type: "Hotel",
        province: "Chiriquí",
        district: "Boquete",
        phone: "+507 720-1234",
        email: "info@boquetemountain.com",
        description: "Luxury resort in the highlands of Boquete with mountain views and coffee plantation tours.",
        google_maps_url: "https://maps.google.com/?q=Boquete,Chiriquí,Panama",
        whatsapp: "+50761234567"
    },
    {
        id: 2,
        name: "Posada Boquete Valley",
        type: "Posada Turística",
        province: "Chiriquí",
        district: "Boquete",
        phone: "+507 720-5678",
        email: "reservas@boquetevalley.com",
        description: "Charming family-run posada in Boquete valley, known for its garden and homemade meals.",
        google_maps_url: "https://maps.google.com/?q=Boquete,Chiriquí,Panama",
        whatsapp: "+50767654321"
    }
];

// Try to fetch and parse PDF from your hosting
async function fetchAndParsePDF() {
    for (const pdfUrl of PDF_URLS) {
        try {
            console.log(`Trying to fetch PDF from: ${pdfUrl}`);
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                console.log('PDF fetched successfully, parsing...');
                const data = await pdf(response.data);
                PDF_RAW_TEXT = data.text;
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                console.log('PDF text length:', PDF_RAW_TEXT.length);

                const parsedRentals = parsePDFText(PDF_RAW_TEXT);
                console.log(`Parsed ${parsedRentals.length} rentals from PDF`);

                if (parsedRentals.length > 0) {
                    CURRENT_RENTALS = parsedRentals;
                    return true;
                } else {
                    // Fallback to sample data
                    CURRENT_RENTALS = [...ENHANCED_SAMPLE_RENTALS];
                    return false;
                }
            }
        } catch (error) {
            console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
        }
    }

    PDF_STATUS = 'No PDF available, using enhanced sample data';
    CURRENT_RENTALS = [...ENHANCED_SAMPLE_RENTALS];
    return false;
}

// NEW: Parse tabular PDF data correctly
function parsePDFText(text) {
    console.log('=== STARTING TABULAR PDF PARSING ===');
    const rentals = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    let currentProvince = '';
    let currentRentals = [];
    let inProvinceSection = false;

    // Common Panama provinces
    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    console.log(`Total lines in PDF: ${lines.length}`);

    // First, let's understand the structure by grouping related lines
    const sections = [];
    let currentSection = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers and page numbers
        if (line.includes('Reporte de Hospedajes vigentes') ||
            line.includes('Reporte: rep_hos_web') ||
            line.includes('Actualizado al') ||
            line.match(/Página \d+ de \d+/)) {
            continue;
        }

        // Detect province headers
        const provinceMatch = provinces.find(province =>
            line.toUpperCase().includes(province)
        );

        if (provinceMatch) {
            // Save previous section if it exists
            if (currentSection.length > 0) {
                sections.push({
                    province: currentProvince,
                    lines: [...currentSection]
                });
            }

            // Start new section
            currentProvince = provinceMatch;
            currentSection = [];
            inProvinceSection = true;
            console.log(`Found province: ${currentProvince}`);
            continue;
        }

        // Detect end of province section (when we see "Total por provincia:")
        if (line.includes('Total por provincia:') && inProvinceSection) {
            // Save current section
            if (currentSection.length > 0) {
                sections.push({
                    province: currentProvince,
                    lines: [...currentSection]
                });
            }
            currentSection = [];
            inProvinceSection = false;
            continue;
        }

        // Add line to current section if we're in a province section
        if (inProvinceSection && line.length > 2) {
            currentSection.push(line);
        }
    }

    // Parse each province section
    for (const section of sections) {
        const provinceRentals = parseProvinceSection(section.lines, section.province);
        rentals.push(...provinceRentals);
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// Parse a single province section
function parseProvinceSection(lines, province) {
    const rentals = [];

    // The PDF has data in columns across multiple lines
    // We need to group lines that belong together

    let names = [];
    let types = [];
    let emails = [];
    let phones = [];

    // First pass: categorize lines
    for (const line of lines) {
        if (isEmailLine(line)) {
            emails.push(line);
        } else if (isPhoneLine(line)) {
            phones.push(line);
        } else if (isTypeLine(line)) {
            types.push(line);
        } else if (isNameLine(line)) {
            names.push(line);
        }
    }

    console.log(`Province ${province}: Names: ${names.length}, Types: ${types.length}, Emails: ${emails.length}, Phones: ${phones.length}`);

    // Try to match data - this is complex because of the columnar format
    // For now, let's use a simpler approach: look for patterns

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Look for lines that contain both name-like patterns and contact info
        if (line.length > 10 && !isTypeLine(line)) {
            const rentalData = extractRentalFromLine(line, province);
            if (rentalData && rentalData.name) {
                rentals.push(rentalData);
            }
        }
    }

    // If we didn't find enough rentals, try a different approach
    if (rentals.length < names.length && names.length > 0) {
        console.log('Trying alternative parsing for:', province);
        const altRentals = parseColumnarData(names, types, emails, phones, province);
        if (altRentals.length > rentals.length) {
            return altRentals;
        }
    }

    return rentals;
}

// Alternative parsing for columnar data
function parseColumnarData(names, types, emails, phones, province) {
    const rentals = [];
    const maxItems = Math.max(names.length, types.length, emails.length, phones.length);

    for (let i = 0; i < maxItems; i++) {
        const name = names[i] || '';
        const type = types[i] || '';
        const email = extractEmail(emails[i] || '');
        const phone = extractPhone(phones[i] || '');

        if (name && name.length > 2) {
            const rental = {
                name: cleanName(name),
                type: type || 'Hospedaje',
                email: email,
                phone: phone,
                province: province,
                district: guessDistrict(name, province),
                description: `Hospedaje ${type || 'registrado'} en ${province}, Panamá. ${cleanName(name)} ofrece servicios autorizados por la ATP.`,
                google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(cleanName(name) + ' ' + province + ' Panamá')}`,
                whatsapp: phone,
                source: 'ATP_OFFICIAL'
            };
            rentals.push(rental);
        }
    }

    return rentals;
}

// Helper functions
function isEmailLine(line) {
    return line.includes('@') && line.includes('.');
}

function isPhoneLine(line) {
    return line.match(/\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}/) || line.includes('/');
}

function isTypeLine(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort'];
    return types.some(type => line.includes(type));
}

function isNameLine(line) {
    // Names are typically longer and don't contain @ or lots of numbers
    return line.length > 5 &&
           !line.includes('@') &&
           !line.match(/\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4}/) &&
           !isTypeLine(line);
}

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractPhone(text) {
    // Extract first phone number pattern
    const match = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    return match ? match[1] : '';
}

function cleanName(name) {
    // Remove extra spaces and clean up the name
    return name.replace(/\s+/g, ' ').trim();
}

function extractRentalFromLine(line, province) {
    const email = extractEmail(line);
    const phone = extractPhone(line);

    // Remove email and phone to get the main content
    let mainContent = line.replace(email, '').replace(phone, '').replace(/\s+/g, ' ').trim();

    // Try to extract name and type
    const words = mainContent.split(' ').filter(w => w.length > 0);
    if (words.length >= 2) {
        // Simple approach: assume last word might be type, rest is name
        const possibleType = words[words.length - 1];
        const name = words.slice(0, -1).join(' ');

        if (name.length > 2) {
            return {
                name: name,
                type: isTypeLine(possibleType) ? possibleType : 'Hospedaje',
                email: email,
                phone: phone,
                province: province
            };
        }
    }

    // If we can't split, use the whole line as name
    if (mainContent.length > 2) {
        return {
            name: mainContent,
            type: 'Hospedaje',
            email: email,
            phone: phone,
            province: province
        };
    }

    return null;
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
        'VERAGUAS': 'Santiago'
    };
    return districtMap[province] || province;
}

// API Routes (keep the same as before)
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals Search API is working!',
        status: 'success',
        timestamp: new Date().toISOString(),
        data_source: PDF_STATUS.includes('PDF processed') ? 'LIVE_ATP_PDF' : 'ENHANCED_SAMPLE_DATA'
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
        data_source: PDF_STATUS.includes('PDF processed') ? 'LIVE_ATP_DATA' : 'ENHANCED_SAMPLE_DATA',
        status: PDF_STATUS,
        pdf_urls_tested: PDF_URLS
    });
});

app.get('/api/debug-pdf', (req, res) => {
    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        pdf_text_sample: PDF_RAW_TEXT ? PDF_RAW_TEXT.substring(0, 2000) : 'No PDF text available',
        pdf_total_length: PDF_RAW_TEXT ? PDF_RAW_TEXT.length : 0,
        last_update: LAST_PDF_UPDATE,
        rentals_sample: CURRENT_RENTALS.slice(0, 10) // First 10 rentals
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

// Initialize - try to fetch PDF on startup
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Frontend: https://atp-rentals-app-production.up.railway.app`);
    console.log(`📊 API Status: https://atp-rentals-app-production.up.railway.app/api/stats`);
    console.log(`🐛 Debug: https://atp-rentals-app-production.up.railway.app/api/debug-pdf`);

    // Try to load PDF data on startup
    setTimeout(async () => {
        console.log('Attempting to load PDF data from hosted location...');
        await fetchAndParsePDF();
        console.log(`Initial data load complete. Using ${CURRENT_RENTALS.length} rentals.`);
    }, 2000);
});
