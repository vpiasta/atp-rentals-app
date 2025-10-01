const express = require('express');
const axios = require('axios');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create a custom axios instance that ignores header size limits
const axiosCustom = axios.create({
    httpsAgent: new https.Agent({
        maxHeaderSize: 16384, // 16KB instead of default 8KB
        rejectUnauthorized: false
    }),
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    }
});

// Alternative: Use node-fetch instead of axios
const fetch = require('node-fetch');

async function debugATPPage() {
    try {
        console.log('Fetching ATP website with node-fetch...');

        // Try with node-fetch first (better header handling)
        const response = await fetch('https://www.atp.gob.pa/industrias/hoteleros/', {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();

        // Simple regex to find PDF links
        const pdfLinks = [];
        const pdfRegex = /href="([^"]*\.pdf)"/gi;
        let match;

        while ((match = pdfRegex.exec(html)) !== null) {
            pdfLinks.push(match[1]);
        }

        // Also look for "Descargar" text near PDF links
        const descargarLinks = [];
        const descargarRegex = /Descargar[^>]*href="([^"]*\.pdf)"/gi;
        while ((match = descargarRegex.exec(html)) !== null) {
            descargarLinks.push(match[1]);
        }

        return {
            success: true,
            pdfLinks: [...new Set([...pdfLinks, ...descargarLinks])], // Remove duplicates
            totalPDFLinks: pdfLinks.length + descargarLinks.length,
            htmlSample: html.substring(0, 500) // First 500 chars of HTML
        };
    } catch (error) {
        console.error('Fetch error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// Try multiple PDF URL patterns
async function findPDFUrl() {
    const possibleUrls = [
        'https://www.atp.gob.pa/wp-content/uploads/2025/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf',
        'https://www.atp.gob.pa/wp-content/uploads/2024/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2024.pdf',
        'https://www.atp.gob.pa/wp-content/uploads/2023/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2023.pdf',
        'https://www.atp.gob.pa/wp-content/uploads/2025/08/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf',
        'https://www.atp.gob.pa/wp-content/uploads/2025/07/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf',
        'https://www.atp.gob.pa/wp-content/uploads/2025/06/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf',
        'https://www.atp.gob.pa/wp-content/uploads/2025/05/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf'
    ];

    for (const url of possibleUrls) {
        try {
            console.log(`Testing PDF URL: ${url}`);
            const response = await fetch(url, { method: 'HEAD' });
            if (response.ok) {
                console.log(`Found working PDF: ${url}`);
                return url;
            }
        } catch (error) {
            console.log(`PDF not found: ${url}`);
        }
    }
    return null;
}

// Direct PDF test
async function testDirectPDF() {
    const directUrl = 'https://www.atp.gob.pa/wp-content/uploads/2025/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf';
    try {
        const response = await fetch(directUrl, { method: 'HEAD' });
        return {
            url: directUrl,
            exists: response.ok,
            status: response.status
        };
    } catch (error) {
        return {
            url: directUrl,
            exists: false,
            error: error.message
        };
    }
}

// API Routes
app.get('/api/test', (req, res) => {
    res.json({
        message: 'Server is working!',
        status: 'success',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/debug-atp', async (req, res) => {
    try {
        const debugInfo = await debugATPPage();
        const pdfUrl = await findPDFUrl();
        const directTest = await testDirectPDF();

        res.json({
            debugInfo,
            foundPDF: pdfUrl,
            directPDFTest: directTest,
            manualPDF: 'https://www.atp.gob.pa/wp-content/uploads/2025/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf',
            status: pdfUrl ? 'PDF_FOUND' : 'PDF_NOT_FOUND'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Sample data endpoints (same as before)
app.get('/api/rentals', (req, res) => {
    const sampleRentals = [
        {
            id: 1,
            name: "Hotel Boquete Mountain Resort",
            type: "Hotel",
            province: "Chiriquí",
            district: "Boquete",
            phone: "+507 720-1234",
            email: "info@boquetemountain.com",
            description: "Luxury resort in the highlands of Boquete with mountain views",
            google_maps_url: "https://maps.google.com/?q=Boquete,Chiriquí,Panama"
        },
        {
            id: 2,
            name: "Posada Boquete Valley",
            type: "Posada",
            province: "Chiriquí",
            district: "Boquete",
            phone: "+507 720-5678",
            email: "reservas@boquetevalley.com",
            description: "Charming posada in Boquete valley near coffee plantations",
            google_maps_url: "https://maps.google.com/?q=Boquete,Chiriquí,Panama"
        },
        {
            id: 3,
            name: "Bocas del Toro Beach Hotel",
            type: "Hotel",
            province: "Bocas del Toro",
            district: "Bocas del Toro",
            phone: "+507 123-4567",
            email: "stay@bocasbeach.com",
            description: "Beachfront hotel with Caribbean views in Bocas del Toro",
            google_maps_url: "https://maps.google.com/?q=Bocas+del+Toro,Panama"
        }
    ];

    const { search, province } = req.query;
    let filtered = sampleRentals;

    if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            rental.district.toLowerCase().includes(searchLower) ||
            rental.description.toLowerCase().includes(searchLower) ||
            rental.province.toLowerCase().includes(searchLower)
        );
    }

    if (province) {
        filtered = filtered.filter(rental =>
            rental.province.toLowerCase() === province.toLowerCase()
        );
    }

    res.json(filtered);
});

app.get('/api/provinces', (req, res) => {
    res.json(["Bocas del Toro", "Chiriquí", "Coclé", "Colón", "Panamá", "Veraguas", "Los Santos", "Herrera", "Darién"]);
});

app.get('/api/types', (req, res) => {
    res.json(["Hotel", "Posada", "Hostal", "Resort", "Albergue", "Apartotel"]);
});

app.get('/api/stats', (req, res) => {
    res.json({
        total_rentals: 3,
        last_updated: new Date().toISOString(),
        status: "Using sample data - PDF debugging in progress"
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Debug URL: https://atp-rentals-app-production.up.railway.app/api/debug-atp`);
});
