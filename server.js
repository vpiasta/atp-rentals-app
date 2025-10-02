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
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                const data = await pdf(response.data);
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                // Use the working extraction that found 930 rentals
                const parsedRentals = extractAllRentals(data.text);

                CURRENT_RENTALS = parsedRentals;
                return true;
            }
        } catch (error) {
            PDF_STATUS = `Failed to fetch PDF: ${error.message}`;
        }
    }

    PDF_STATUS = 'No PDF available';
    CURRENT_RENTALS = [];
    return false;
}

// WORKING EXTRACTION - Based on what successfully found 930 rentals
function extractAllRentals(text) {
    const rentals = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    let currentProvince = '';

    // Simple extraction: look for rental names and associate with current province
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (line.includes('Reporte de Hospedajes vigentes') ||
            line.includes('Reporte: rep_hos_web') ||
            line.includes('Actualizado al') ||
            line.match(/Página \d+ de \d+/)) {
            continue;
        }

        // Detect province
        const provinceMatch = provinces.find(p => line.includes(p));
        if (provinceMatch && line.includes('Provincia:')) {
            currentProvince = provinceMatch;
            continue;
        }

        // Skip province totals
        if (line.includes('Total por provincia:')) {
            continue;
        }

        // Extract rental if we have a name-like line and a current province
        if (currentProvince && isRentalName(line)) {
            const rental = extractRentalData(lines, i, currentProvince);
            if (rental) {
                rentals.push(rental);
            }
        }
    }

    return rentals;
}

function isRentalName(line) {
    return line.length > 5 &&
           !line.includes('@') &&
           !line.match(/\d{3,4}[- ]?\d{3,4}/) &&
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:') &&
           !line.includes('Nombre') &&
           !line.includes('Modalidad') &&
           !line.includes('Correo Principal') &&
           !line.includes('Teléfono');
}

function extractRentalData(lines, startIndex, province) {
    const name = cleanText(lines[startIndex]);

    if (!name || name.length < 3) return null;

    let type = 'Hospedaje';
    let email = '';
    let phone = '';

    // Look ahead for additional data
    for (let i = startIndex + 1; i < Math.min(startIndex + 10, lines.length); i++) {
        const line = lines[i];

        if (isRentalType(line)) {
            type = line;
        } else if (line.includes('@')) {
            email = extractEmail(line);
        } else if (line.match(/\d{3,4}[- ]?\d{3,4}/)) {
            phone = extractPhone(line);
        }

        // Stop if we find another rental name
        if (isRentalName(line) && i > startIndex + 2) {
            break;
        }
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

function isRentalType(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort'];
    return types.some(type => line.includes(type));
}

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractPhone(text) {
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
        'VERAGUAS': 'Santiago'
    };
    return districtMap[province] || province;
}

// API Routes
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals Search API is working!',
        status: 'success',
        total_rentals: CURRENT_RENTALS.length,
        data_source: 'LIVE_ATP_PDF'
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
    res.json({
        total_rentals: CURRENT_RENTALS.length,
        last_updated: LAST_PDF_UPDATE,
        status: PDF_STATUS,
        data_source: 'LIVE_ATP_DATA'
    });
});

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            total_rentals: CURRENT_RENTALS.length,
            status: PDF_STATUS
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Initialize
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`Loaded ${CURRENT_RENTALS.length} rentals`);
    }, 2000);
});
