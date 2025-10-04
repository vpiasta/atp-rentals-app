const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Simple in-memory data
let CURRENT_RENTALS = [
    {
        name: "APARTHOTEL BOQUETE",
        type: "Aparta-Hotel",
        email: "info@aparthotel-boquete.com",
        phone: "68916669 / 68916660",
        province: "CHIRIQUÍ",
        district: "Boquete",
        description: 'Aparta-Hotel "APARTHOTEL BOQUETE" ubicado en CHIRIQUÍ, Panamá.',
        google_maps_url: "https://maps.google.com/?q=APARTHOTEL%20BOQUETE%20BOQUETE%20Panamá",
        whatsapp: "50768916669",
        whatsapp_url: "https://wa.me/50768916669",
        call_url: "tel:+50768916669",
        source: "ATP_OFFICIAL"
    },
    {
        name: "HOTEL EXAMPLE",
        type: "Hotel",
        email: "info@example.com",
        phone: "6123-4567",
        province: "PANAMÁ",
        district: "Ciudad de Panamá",
        description: 'Hotel "EXAMPLE" ubicado en PANAMÁ, Panamá.',
        google_maps_url: "https://maps.google.com/?q=HOTEL%20EXAMPLE%20Panamá",
        whatsapp: "50761234567",
        whatsapp_url: "https://wa.me/50761234567",
        call_url: "tel:+50761234567",
        source: "ATP_OFFICIAL"
    }
];

// Basic endpoints
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals API is working!',
        status: 'success',
        total_rentals: CURRENT_RENTALS.length
    });
});

app.get('/api/rentals', (req, res) => {
    const { search } = req.query;

    if (search) {
        const searchLower = search.toLowerCase();
        const filtered = CURRENT_RENTALS.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            (rental.province && rental.province.toLowerCase().includes(searchLower)) ||
            (rental.type && rental.type.toLowerCase().includes(searchLower))
        );
        res.json(filtered);
    } else {
        res.json(CURRENT_RENTALS);
    }
});

app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals API is working!',
        status: 'success', 
        total_rentals: CURRENT_RENTALS.length,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/provinces', (req, res) => {
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province).filter(Boolean))];
    res.json(provinces);
});

app.get('/api/types', (req, res) => {
    const types = [
        "Albergue",
        "Aparta-Hotel",
        "Bungalow",
        "Cabaña",
        "Hostal Familiar",
        "Hotel",
        "Motel",
        "Pensión",
        "Residencial",
        "Sitio de acampar"
    ];
    res.json(types);
});

app.get('/api/stats', (req, res) => {
    res.json({
        total_rentals: CURRENT_RENTALS.length,
        last_updated: new Date().toISOString(),
        data_source: 'ATP_OFFICIAL',
        status: 'Using sample data'
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        rentals_loaded: CURRENT_RENTALS.length,
        version: '1.0.0'
    });
});

// Simple debug endpoint
app.get('/api/debug', (req, res) => {
    res.json({
        totalRentals: CURRENT_RENTALS.length,
        sampleRentals: CURRENT_RENTALS.slice(0, 2),
        allProvinces: [...new Set(CURRENT_RENTALS.map(r => r.province))],
        allTypes: [...new Set(CURRENT_RENTALS.map(r => r.type).filter(Boolean))]
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 ATP Rentals API running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Test endpoint: http://localhost:${PORT}/api/test`);
    console.log(`📍 Rentals endpoint: http://localhost:${PORT}/api/rentals`);
    console.log('✅ Server started successfully with sample data');
});

