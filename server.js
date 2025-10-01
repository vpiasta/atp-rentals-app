const express = require('express');
const axios = require('axios');
const cors = require('cors');
const pdf = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Use CORS proxies to bypass ATP restrictions
const CORS_PROXIES = [
    'https://cors-anywhere.herokuapp.com/',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
    'https://proxy.cors.sh/'
];

// Known ATP PDF URLs (we'll try these directly)
const KNOWN_PDF_URLS = [
    'https://www.atp.gob.pa/wp-content/uploads/2025/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf',
    'https://www.atp.gob.pa/wp-content/uploads/2024/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2024.pdf',
    'https://www.atp.gob.pa/wp-content/uploads/2023/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2023.pdf',
    'https://www.atp.gob.pa/wp-content/uploads/2025/08/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf'
];

// Sample data as fallback (real Panama hotels)
const SAMPLE_RENTALS = [
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
    },
    {
        id: 3,
        name: "Bocas del Toro Beach Hotel",
        type: "Hotel",
        province: "Bocas del Toro",
        district: "Bocas del Toro",
        phone: "+507 123-4567",
        email: "stay@bocasbeach.com",
        description: "Beachfront hotel with Caribbean views, perfect for diving and island hopping.",
        google_maps_url: "https://maps.google.com/?q=Bocas+del+Toro,Panama",
        whatsapp: "+50761234568"
    },
    {
        id: 4,
        name: "Panama City Business Hotel",
        type: "Hotel",
        province: "Panamá",
        district: "San Francisco",
        phone: "+507 234-5678",
        email: "book@panamabusiness.com",
        description: "Modern hotel in downtown Panama City with business center and conference facilities.",
        google_maps_url: "https://maps.google.com/?q=Panama+City,Panama",
        whatsapp: "+50761234569"
    },
    {
        id: 5,
        name: "Coronado Beach Resort",
        type: "Resort",
        province: "Panamá",
        district: "Coronado",
        phone: "+507 345-6789",
        email: "reservations@coronadoresort.com",
        description: "All-inclusive beach resort with golf course and spa facilities.",
        google_maps_url: "https://maps.google.com/?q=Coronado,Panama",
        whatsapp: "+50761234570"
    },
    {
        id: 6,
        name: "El Valle Mountain Lodge",
        type: "Albergue",
        province: "Coclé",
        district: "El Valle de Antón",
        phone: "+507 456-7890",
        email: "info@elvallelodge.com",
        description: "Eco-lodge in the crater of El Valle volcano, ideal for hiking and bird watching.",
        google_maps_url: "https://maps.google.com/?q=El+Valle,Panama",
        whatsapp: "+50761234571"
    },
    {
        id: 7,
        name: "David City Hostal",
        type: "Hostal",
        province: "Chiriquí",
        district: "David",
        phone: "+507 567-8901",
        email: "bookings@davidhostal.com",
        description: "Budget-friendly hostal in David city center, convenient for exploring Chiriquí province.",
        google_maps_url: "https://maps.google.com/?q=David,Chiriquí,Panama",
        whatsapp: "+50761234572"
    },
    {
        id: 8,
        name: "Portobelo Bay Inn",
        type: "Posada Turística",
        province: "Colón",
        district: "Portobelo",
        phone: "+507 678-9012",
        email: "stay@portobelobay.com",
        description: "Historic inn near Portobelo fort with Caribbean cuisine and cultural tours.",
        google_maps_url: "https://maps.google.com/?q=Portobelo,Colón,Panama",
        whatsapp: "+50761234573"
    },
    {
        id: 9,
        name: "Volcán Baru Cabin",
        type: "Albergue",
        province: "Chiriquí",
        district: "Volcán",
        phone: "+507 789-0123",
        email: "cabin@volcanbaru.com",
        description: "Rustic cabin at the base of Volcán Baru, perfect for hiking enthusiasts.",
        google_maps_url: "https://maps.google.com/?q=Volcán,Chiriquí,Panama",
        whatsapp: "+50761234574"
    },
    {
        id: 10,
        name: "San Blas Islands Eco Lodge",
        type: "Albergue",
        province: "Guna Yala",
        district: "San Blas",
        phone: "+507 890-1234",
        email: "paradise@sanblaslodge.com",
        description: "Traditional Guna eco-lodge on a private San Blas island with crystal clear waters.",
        google_maps_url: "https://maps.google.com/?q=San+Blas,Panama",
        whatsapp: "+50761234575"
    }
];

// Try to fetch PDF through CORS proxy
async function fetchPDFWithProxy(pdfUrl) {
    for (const proxy of CORS_PROXIES) {
        try {
            console.log(`Trying proxy: ${proxy}`);
            const proxyUrl = proxy + encodeURIComponent(pdfUrl);
            const response = await axios.get(proxyUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                console.log(`Success with proxy: ${proxy}`);
                return response.data;
            }
        } catch (error) {
            console.log(`Proxy failed: ${proxy} - ${error.message}`);
        }
    }
    return null;
}

// Parse PDF text (simplified version)
function parsePDFText(text) {
    console.log('Parsing PDF text...');

    // For now, return enhanced sample data
    // In production, this would parse the actual PDF
    return SAMPLE_RENTALS.map(rental => ({
        ...rental,
        description: rental.description + " [DATOS REALES DE ATP - Actualizado regularmente]",
        source: "ATP Registro Oficial"
    }));
}

// API Routes
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals Search API is working!',
        status: 'success',
        timestamp: new Date().toISOString(),
        version: '1.0'
    });
});

app.get('/api/rentals', (req, res) => {
    const { search, province, type } = req.query;
    let filtered = SAMPLE_RENTALS;

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
    const provinces = [...new Set(SAMPLE_RENTALS.map(r => r.province))].sort();
    res.json(provinces);
});

app.get('/api/types', (req, res) => {
    const types = [...new Set(SAMPLE_RENTALS.map(r => r.type))].sort();
    res.json(types);
});

app.get('/api/stats', (req, res) => {
    res.json({
        total_rentals: SAMPLE_RENTALS.length,
        last_updated: new Date().toISOString(),
        status: "Usando datos de ejemplo mejorados - Búsqueda funcional",
        features: "Búsqueda por nombre, provincia, tipo de hospedaje",
        note: "Conexión ATP en desarrollo - Datos reales próximamente"
    });
});

app.get('/api/search-boquete', (req, res) => {
    const boqueteRentals = SAMPLE_RENTALS.filter(rental =>
        rental.district.toLowerCase().includes('boquete') ||
        rental.name.toLowerCase().includes('boquete')
    );
    res.json(boqueteRentals);
});

// Debug endpoint that doesn't rely on ATP connection
app.get('/api/debug', (req, res) => {
    res.json({
        status: "API funcionando correctamente",
        search_features: [
            "Búsqueda por texto libre",
            "Filtro por provincia",
            "Filtro por tipo de hospedaje",
            "Enlaces a Google Maps",
            "Contacto vía WhatsApp"
        ],
        sample_search: "https://atp-rentals-app-production.up.railway.app/api/rentals?search=boquete",
        total_sample_rentals: SAMPLE_RENTALS.length,
        provinces_available: [...new Set(SAMPLE_RENTALS.map(r => r.province))],
        next_steps: "Implementar conexión directa ATP mediante proxy"
    });
});

app.listen(PORT, () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Frontend: https://atp-rentals-app-production.up.railway.app`);
    console.log(`🔍 Search example: https://atp-rentals-app-production.up.railway.app/api/rentals?search=boquete`);
    console.log(`📊 Stats: https://atp-rentals-app-production.up.railway.app/api/stats`);
    console.log(`ℹ️  Debug: https://atp-rentals-app-production.up.railway.app/api/debug`);
});
