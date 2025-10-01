const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Debug function to see what's on the ATP page
async function debugATPPage() {
    try {
        console.log('Fetching ATP website...');
        const response = await axios.get('https://www.atp.gob.pa/industrias/hoteleros/', {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);

        // Find ALL links on the page
        const allLinks = [];
        $('a').each((i, element) => {
            const href = $(element).attr('href');
            const text = $(element).text().trim();
            if (href) {
                allLinks.push({
                    text: text.substring(0, 100), // First 100 chars
                    href: href,
                    isPDF: href.includes('.pdf')
                });
            }
        });

        // Find PDF links specifically
        const pdfLinks = allLinks.filter(link => link.isPDF);

        return {
            success: true,
            totalLinks: allLinks.length,
            pdfLinks: pdfLinks,
            allLinksSample: allLinks.slice(0, 20), // First 20 links
            pageTitle: $('title').text(),
            hasDescargarButton: $('a:contains("Descargar")').length > 0,
            hasDescargarPDF: $('a:contains("Descargar PDF")').length > 0
        };
    } catch (error) {
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
        'https://www.atp.gob.pa/wp-content/uploads/2025/07/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf'
    ];

    for (const url of possibleUrls) {
        try {
            console.log(`Testing PDF URL: ${url}`);
            const response = await axios.head(url, { timeout: 10000 });
            if (response.status === 200) {
                console.log(`Found working PDF: ${url}`);
                return url;
            }
        } catch (error) {
            console.log(`PDF not found: ${url}`);
        }
    }
    return null;
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

        res.json({
            debugInfo,
            foundPDF: pdfUrl,
            manualPDF: 'https://www.atp.gob.pa/wp-content/uploads/2025/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf',
            status: pdfUrl ? 'PDF_FOUND' : 'PDF_NOT_FOUND'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/rentals', (req, res) => {
    // Sample data for testing
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
        },
        {
            id: 4,
            name: "Panama City Business Hotel",
            type: "Hotel",
            province: "Panamá",
            district: "Ciudad de Panamá",
            phone: "+507 234-5678",
            email: "book@panamabusiness.com",
            description: "Modern hotel in downtown Panama City for business travelers",
            google_maps_url: "https://maps.google.com/?q=Panama+City,Panama"
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
        total_rentals: 4,
        last_updated: new Date().toISOString(),
        status: "Using sample data - PDF debugging in progress"
    });
});

// Test direct PDF access
app.get('/api/test-pdf', async (req, res) => {
    try {
        const pdfUrl = 'https://www.atp.gob.pa/wp-content/uploads/2025/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf';
        const response = await axios.head(pdfUrl);

        res.json({
            pdfUrl: pdfUrl,
            exists: response.status === 200,
            status: 'PDF is accessible'
        });
    } catch (error) {
        res.json({
            pdfUrl: 'https://www.atp.gob.pa/wp-content/uploads/2025/09/REPORTE-HOSPEDAJES-VIGENTE-5-9-2025.pdf',
            exists: false,
            error: error.message,
            status: 'PDF not accessible'
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Debug URL: https://atp-rentals-app-production.up.railway.app/api/debug-atp`);
});
