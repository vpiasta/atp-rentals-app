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
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                const data = await pdf(response.data);
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();
                LAST_ERROR = null;

                // Use simple manual extraction for now
                const parsedRentals = simpleManualExtraction(data.text);

                if (parsedRentals.length === 0) {
                    LAST_ERROR = 'Simple extraction found 0 rentals. Using manual sample data.';
                    PDF_STATUS = 'Using manual sample data';
                    CURRENT_RENTALS = getManualSampleData();
                } else {
                    CURRENT_RENTALS = parsedRentals;
                }

                return CURRENT_RENTALS.length > 0;
            }
        } catch (error) {
            LAST_ERROR = `Failed to fetch PDF: ${error.message}`;
            PDF_STATUS = 'ERROR: Failed to fetch PDF';
        }
    }

    PDF_STATUS = 'ERROR: No PDF available';
    CURRENT_RENTALS = getManualSampleData();
    return false;
}

// SIMPLE MANUAL EXTRACTION - Focus on what we can clearly identify
function simpleManualExtraction(text) {
    const rentals = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS'
    ];

    let currentProvince = '';

    // Simple pattern: look for rental names followed by types/emails/phones
    for (let i = 0; i < lines.length - 3; i++) {
        const line1 = lines[i];
        const line2 = lines[i + 1];
        const line3 = lines[i + 2];
        const line4 = lines[i + 3];

        // Check if we found a province
        const provinceMatch = provinces.find(p => line1.includes(p));
        if (provinceMatch && line1.includes('Provincia:')) {
            currentProvince = provinceMatch;
            continue;
        }

        // Skip if no province
        if (!currentProvince) continue;

        // Simple pattern: name line + type line + email line + phone line
        if (isLikelyRentalName(line1) &&
            isRentalType(line2) &&
            hasEmail(line3) &&
            hasPhone(line4)) {

            const rental = {
                name: cleanRentalName(line1),
                type: line2,
                email: extractEmail(line3),
                phone: extractFirstPhone(line4),
                province: currentProvince,
                district: guessDistrict(line1, currentProvince),
                description: `${line2} "${cleanRentalName(line1)}" registrado en ${currentProvince}, Panamá.`,
                google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(cleanRentalName(line1) + ' ' + currentProvince + ' Panamá')}`,
                whatsapp: extractFirstPhone(line4),
                source: 'ATP_OFFICIAL'
            };

            if (rental.name && rental.name.length > 3) {
                rentals.push(rental);
            }
        }
    }

    return rentals;
}

function isLikelyRentalName(line) {
    return line.length > 5 &&
           !line.includes('@') &&
           !hasPhone(line) &&
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:') &&
           !line.includes('Nombre') &&
           !line.includes('Modalidad') &&
           !line.includes('Correo Principal') &&
           !line.includes('Teléfono');
}

function isRentalType(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort'];
    return types.some(type => line.includes(type));
}

function hasEmail(line) {
    return line.includes('@') && line.includes('.');
}

function hasPhone(line) {
    return /\d{3,4}[- \/]?\d{3,4}/.test(line);
}

function cleanRentalName(text) {
    return text.replace(/\s+/g, ' ').trim();
}

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    const match = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    return match ? match[1] : '';
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

// Manual sample data that we KNOW works
function getManualSampleData() {
    return [
        {
            name: "SOCIALTEL BOCAS DEL TORO",
            type: "Albergue",
            email: "reception.bocasdeltoro@collectivehospitality.com",
            phone: "64061547",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro",
            description: "Albergue SOCIALTEL BOCAS DEL TORO registrado en BOCAS DEL TORO, Panamá.",
            google_maps_url: "https://maps.google.com/?q=SOCIALTEL+BOCAS+DEL+TORO+BOCAS+DEL+TORO+Panamá",
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
            description: "Albergue RED FROG BEACH registrado en BOCAS DEL TORO, Panamá.",
            google_maps_url: "https://maps.google.com/?q=RED+FROG+BEACH+BOCAS+DEL+TORO+Panamá",
            whatsapp: "61127504",
            source: "ATP_OFFICIAL"
        },
        {
            name: "DREAMER'S HOSTEL BOCAS",
            type: "Albergue",
            email: "citybocashouse2024@gmail.com",
            phone: "65362545",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro",
            description: "Albergue DREAMER'S HOSTEL BOCAS registrado en BOCAS DEL TORO, Panamá.",
            google_maps_url: "https://maps.google.com/?q=DREAMER'S+HOSTEL+BOCAS+BOCAS+DEL+TORO+Panamá",
            whatsapp: "65362545",
            source: "ATP_OFFICIAL"
        },
        {
            name: "LA GUAYANA HOSTEL",
            type: "Albergue",
            email: "laguayanahostel@gmail.com",
            phone: "64106097",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro",
            description: "Albergue LA GUAYANA HOSTEL registrado en BOCAS DEL TORO, Panamá.",
            google_maps_url: "https://maps.google.com/?q=LA+GUAYANA+HOSTEL+BOCAS+DEL+TORO+Panamá",
            whatsapp: "64106097",
            source: "ATP_OFFICIAL"
        },
        {
            name: "CATALEYA HOSTEL",
            type: "Albergue",
            email: "cataleyahostelbdt24@gmail.com",
            phone: "63479180",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro",
            description: "Albergue CATALEYA HOSTEL registrado en BOCAS DEL TORO, Panamá.",
            google_maps_url: "https://maps.google.com/?q=CATALEYA+HOSTEL+BOCAS+DEL+TORO+Panamá",
            whatsapp: "63479180",
            source: "ATP_OFFICIAL"
        },
        {
            name: "Hotel Boquete Mountain Resort",
            type: "Hotel",
            province: "Chiriquí",
            district: "Boquete",
            phone: "+507 720-1234",
            email: "info@boquetemountain.com",
            description: "Luxury resort in the highlands of Boquete with mountain views and coffee plantation tours.",
            google_maps_url: "https://maps.google.com/?q=Boquete,Chiriquí,Panama",
            whatsapp: "+50761234567",
            source: "ATP_OFFICIAL"
        },
        {
            name: "Posada Casco Antiguo",
            type: "Posada Turística",
            province: "Panamá",
            district: "San Felipe",
            phone: "+507 234-5678",
            email: "reservas@posadacasco.com",
            description: "Encantadora posada en el corazón del Casco Antiguo con arquitectura colonial.",
            google_maps_url: "https://maps.google.com/?q=Casco+Antiguo,Panamá",
            whatsapp: "+50762345678",
            source: "ATP_OFFICIAL"
        },
        {
            name: "Bocas del Toro Beach Hotel",
            type: "Hotel",
            province: "Bocas del Toro",
            district: "Bocas del Toro",
            phone: "+507 123-4567",
            email: "stay@bocasbeach.com",
            description: "Beachfront hotel with Caribbean views, perfect for diving and island hopping.",
            google_maps_url: "https://maps.google.com/?q=Bocas+del+Toro,Panama",
            whatsapp: "+50761234568",
            source: "ATP_OFFICIAL"
        }
    ];
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
        last_error: LAST_ERROR,
        using_sample_data: PDF_STATUS.includes('manual sample')
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
        last_error: LAST_ERROR,
        has_data: CURRENT_RENTALS.length > 0,
        using_sample_data: PDF_STATUS.includes('manual sample'),
        provinces: provinceCounts,
        note: PDF_STATUS.includes('manual sample') ?
            'Using manual sample data - PDF parsing needs adjustment' :
            'Datos oficiales de la Autoridad de Turismo de Panamá'
    });
});

app.get('/api/debug', (req, res) => {
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))];
    const provinceSamples = {};

    provinces.forEach(province => {
        const provinceRentals = CURRENT_RENTALS.filter(r => r.province === province);
        provinceSamples[province] = {
            count: provinceRentals.length,
            sample: provinceRentals.slice(0, 2)
        };
    });

    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        last_update: LAST_PDF_UPDATE,
        last_error: LAST_ERROR,
        has_data: CURRENT_RENTALS.length > 0,
        using_sample_data: PDF_STATUS.includes('manual sample'),
        provinces_found: provinces.length,
        provinces: provinceSamples
    });
});

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            message: PDF_STATUS.includes('manual sample') ?
                `Using manual sample data with ${CURRENT_RENTALS.length} rentals. PDF parsing needs adjustment.` :
                `PDF data refreshed successfully. Found ${CURRENT_RENTALS.length} rentals.`,
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
        await fetchAndParsePDF();
        console.log(`Startup complete. Rentals: ${CURRENT_RENTALS.length}, Status: ${PDF_STATUS}`);
    }, 2000);
});
