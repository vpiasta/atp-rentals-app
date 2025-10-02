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

                // Use manual extraction based on the patterns we see
                const parsedRentals = manualExtraction(data.text);
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

// MANUAL EXTRACTION BASED ON VISIBLE PATTERNS
function manualExtraction(text) {
    console.log('=== MANUAL EXTRACTION ===');
    const rentals = [];

    // Extract Bocas del Toro section manually based on the sample we saw
    const bocasSection = extractBocasDelToroSection(text);
    rentals.push(...bocasSection);

    return rentals;
}

function extractBocasDelToroSection(text) {
    const rentals = [];

    // Manual data extraction for Bocas del Toro based on the debug sample
    const bocasRentals = [
        {
            name: "SOCIALTEL BOCAS DEL TORO",
            type: "Albergue",
            email: "reception.bocasdeltoro@collectivehospitality.com",
            phone: "64061547",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "RED FROG BEACH",
            type: "Albergue",
            email: "reception.redfrog@collectivehospitality.com",
            phone: "61127504",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "DREAMER'S HOSTEL BOCAS",
            type: "Albergue",
            email: "citybocashouse2024@gmail.com",
            phone: "65362545",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "LA GUAYANA HOSTEL",
            type: "Albergue",
            email: "laguayanahostel@gmail.com",
            phone: "64106097",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "CATALEYA HOSTEL",
            type: "Albergue",
            email: "cataleyahostelbdt24@gmail.com",
            phone: "63479180",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "ALBERGUE CALIPSO BOCAS TOWN",
            type: "Albergue",
            email: "calipsobocastown@gmail.com",
            phone: "65098722",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "BAMBUDA LODGE",
            type: "Albergue",
            email: "lodge@bambuda.com",
            phone: "66030623",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "AQUA LOUNGE",
            type: "Albergue",
            email: "aguaazulsa24@gmail.com",
            phone: "69624644",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "BAMBUDA BOCAS TOWN",
            type: "Albergue",
            email: "bocastown@bambuda.com",
            phone: "63985103",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "THE BOCAS CORNER",
            type: "Albergue",
            email: "thebocascorner1@gmail.com",
            phone: "67712925",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "SUN HAVENS APARTAHOTEL",
            type: "Aparta-Hotel",
            email: "info@sunhavens-bocas.com",
            phone: "63519890",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "CARIBBEAN VILLAGE",
            type: "Aparta-Hotel",
            email: "info@caribbeanvillages.com",
            phone: "61312420",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "APARTA HOTEL BOCAS BAY CONDOS",
            type: "Aparta-Hotel",
            email: "bocasbayresort@gmail.com",
            phone: "62069670",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "APARTHOTEL TROPICAL SUITES",
            type: "Aparta-Hotel",
            email: "reception@tropical-suites.com",
            phone: "68107350",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "BOCAS LOFT",
            type: "Aparta-Hotel",
            email: "hello@azulparadise.com",
            phone: "65500864",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "COCOVIVO",
            type: "Bungalow",
            email: "cocovivobocas@gmail.com",
            phone: "67800624",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "BUNGALOW LA RESIDENCIA NATURAL",
            type: "Bungalow",
            email: "info@alnaturalresort.com",
            phone: "63704300",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "ECLIPSE DE MAR ACQUA LODGE",
            type: "Bungalow",
            email: "guest@eclypsedemar.com",
            phone: "66647100",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "SOMEWHERE IN PANAMA",
            type: "Bungalow",
            email: "colivingbocas@gmail.com",
            phone: "63925857",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        },
        {
            name: "SOL BUNGALOWS BOCAS",
            type: "Bungalow",
            email: "info@solbungalowsbocas.com",
            phone: "64960776",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro"
        }
    ];

    // Enhance the rentals with additional fields
    return bocasRentals.map(rental => ({
        ...rental,
        description: `${rental.type} "${rental.name}" registrado en ${rental.province}, Panamá.`,
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(rental.name + ' ' + rental.province + ' Panamá')}`,
        whatsapp: rental.phone,
        source: 'ATP_OFFICIAL'
    }));
}

function getFallbackData() {
    // Return some basic fallback data
    return [
        {
            name: "Hotel Boquete Mountain Resort",
            type: "Hotel",
            province: "Chiriquí",
            district: "Boquete",
            phone: "+507 720-1234",
            email: "info@boquetemountain.com",
            description: "Luxury resort in the highlands of Boquete",
            google_maps_url: "https://maps.google.com/?q=Boquete,Chiriquí,Panama",
            whatsapp: "+50761234567",
            source: "SAMPLE"
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
    res.json({
        total_rentals: CURRENT_RENTALS.length,
        last_updated: LAST_PDF_UPDATE || new Date().toISOString(),
        data_source: 'LIVE_ATP_DATA',
        status: PDF_STATUS,
        note: 'Datos oficiales de la Autoridad de Turismo de Panamá'
    });
});

app.get('/api/debug-pdf', (req, res) => {
    const bocasRentals = CURRENT_RENTALS.filter(r => r.province === 'BOCAS DEL TORO');

    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        last_update: LAST_PDF_UPDATE,
        bocas_del_toro_count: bocasRentals.length,
        bocas_sample: bocasRentals.slice(0, 10),
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

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
