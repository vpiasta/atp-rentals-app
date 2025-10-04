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

const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const PDF_URLS = [
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf'
];

let PDF_STATUS = 'Not attempted';
let LAST_PDF_UPDATE = null;
let PDF_RENTALS = [];

// Column boundaries from our previous work
const COLUMN_BOUNDARIES = {
    NOMBRE: { start: 0, end: 184 },
    MODALIDAD: { start: 184, end: 265 },
    CORREO: { start: 265, end: 481 },
    TELEFONO: { start: 481, end: 600 }
};

// Group text items into rows based on Y coordinates
function groupIntoRows(textItems) {
    const rows = {};
    const Y_TOLERANCE = 1.5;

    textItems.forEach(item => {
        if (!item.text.trim()) return;

        const existingKey = Object.keys(rows).find(y =>
            Math.abs(parseFloat(y) - item.y) <= Y_TOLERANCE
        );

        const rowY = existingKey || item.y.toString();
        if (!rows[rowY]) rows[rowY] = [];
        rows[rowY].push(item);
    });

    // Convert to array and sort by Y (top to bottom)
    return Object.entries(rows)
        .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
        .map(([y, items]) => ({
            y: parseFloat(y),
            items: items.sort((a, b) => a.x - b.x)
        }));
}

// Parse row data into columns
function parseRowData(row) {
    const rental = {
        name: '',
        type: '',
        email: '',
        phone: ''
    };

    // Assign items to columns based on X position
    row.items.forEach(item => {
        if (item.x >= COLUMN_BOUNDARIES.NOMBRE.start && item.x < COLUMN_BOUNDARIES.NOMBRE.end) {
            rental.name += (rental.name ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.MODALIDAD.start && item.x < COLUMN_BOUNDARIES.MODALIDAD.end) {
            rental.type += (rental.type ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.CORREO.start && item.x < COLUMN_BOUNDARIES.CORREO.end) {
            rental.email += item.text; // No space for emails
        } else if (item.x >= COLUMN_BOUNDARIES.TELEFONO.start && item.x < COLUMN_BOUNDARIES.TELEFONO.end) {
            rental.phone += (rental.phone ? ' ' : '') + item.text;
        }
    });

    // Clean the data
    rental.name = rental.name.trim();
    rental.type = rental.type.trim();
    rental.email = rental.email.trim();
    rental.phone = rental.phone.trim();

    return rental;
}

// Enhanced PDF parsing with coordinate-based approach
async function tryParsePDF() {
    try {
        console.log('Attempting coordinate-based PDF parsing...');
        const response = await axios.get(PDF_URLS[0], {
            responseType: 'arraybuffer',
            timeout: 15000
        });

        if (response.status === 200) {
            console.log('PDF fetched, starting coordinate parsing...');
            const data = new Uint8Array(response.data);
            const pdf = await pdfjsLib.getDocument(data).promise;
            const numPages = pdf.numPages;

            const allRentals = [];
            let totalRowsProcessed = 0;

            // Process first 5 pages to test
            for (let pageNum = 1; pageNum <= Math.min(5, numPages); pageNum++) {
                console.log(`Processing page ${pageNum}...`);
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();

                // Extract text with precise positioning
                const textItems = textContent.items.map(item => ({
                    text: item.str,
                    x: Math.round(item.transform[4] * 100) / 100,
                    y: Math.round(item.transform[5] * 100) / 100,
                    page: pageNum
                }));

                // Group into rows
                const rows = groupIntoRows(textItems);
                totalRowsProcessed += rows.length;

                // Process each row
                for (let i = 0; i < rows.length; i++) {
                    const rowData = parseRowData(rows[i]);

                    // Only include rows that look like actual rentals
                    if (rowData.name && rowData.name.length > 3 &&
                        (rowData.type || rowData.email || rowData.phone)) {

                        const rental = {
                            name: rowData.name,
                            type: rowData.type,
                            email: rowData.email,
                            phone: rowData.phone,
                            province: 'EXTRACTING...', // Will be determined later
                            district: 'EXTRACTING...',
                            description: `${rowData.type} "${rowData.name}" ubicado en Panamá.`,
                            google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(rowData.name + ' Panamá')}`,
                            source: 'ATP_PDF_EXTRACTED'
                        };

                        allRentals.push(rental);
                    }
                }
            }

            PDF_RENTALS = allRentals;
            PDF_STATUS = `PDF parsed: ${numPages} pages, ${allRentals.length} rentals found, ${totalRowsProcessed} rows processed`;
            LAST_PDF_UPDATE = new Date().toISOString();

            console.log(`✅ ${PDF_STATUS}`);
            return true;
        }
    } catch (error) {
        PDF_STATUS = `PDF parsing failed: ${error.message}`;
        console.log(`❌ ${PDF_STATUS}`);
    }
    return false;
}

// Automatic PDF parsing on startup
async function initializePDFParsing() {
    console.log('🚀 Initializing PDF parsing...');
    const success = await tryParsePDF();
    if (success) {
        console.log(`✅ PDF parsing successful: ${PDF_RENTALS.length} rentals extracted`);
        // Optionally switch to PDF data automatically
        if (PDF_RENTALS.length > 0) {
            CURRENT_RENTALS = PDF_RENTALS;
            console.log(`🔄 Auto-switched to PDF data: ${PDF_RENTALS.length} rentals`);
        }
    } else {
        console.log('❌ PDF parsing failed, using sample data');
    }
}

// Start PDF parsing after a short delay (non-blocking)
setTimeout(() => {
    initializePDFParsing();
}, 3000);


// Basic endpoints

// Manual PDF parsing trigger
app.post('/api/parse-pdf', async (req, res) => {
    try {
        console.log('Manual PDF parsing triggered...');
        const success = await tryParsePDF();

        if (success) {
            res.json({
                success: true,
                message: `PDF parsing successful: ${PDF_RENTALS.length} rentals extracted`,
                total_rentals: PDF_RENTALS.length,
                pdf_status: PDF_STATUS,
                rentals_preview: PDF_RENTALS.slice(0, 5)
            });
        } else {
            res.json({
                success: false,
                message: 'PDF parsing failed',
                pdf_status: PDF_STATUS
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'PDF parsing error',
            error: error.message
        });
    }
});

// Debug endpoint for PDF extracted data
app.get('/api/pdf-rentals', (req, res) => {
    res.json({
        status: PDF_STATUS,
        total_rentals: PDF_RENTALS.length,
        last_update: LAST_PDF_UPDATE,
        rentals: PDF_RENTALS.slice(0, 10), // First 10 rentals
        note: 'Coordinate-based extraction from PDF'
    });
});

// Switch between sample data and PDF data
app.get('/api/use-pdf-data', (req, res) => {
    if (PDF_RENTALS.length > 0) {
        CURRENT_RENTALS = PDF_RENTALS;
        res.json({
            success: true,
            message: `Switched to PDF data: ${PDF_RENTALS.length} rentals`,
            total_rentals: PDF_RENTALS.length
        });
    } else {
        res.json({
            success: false,
            message: 'No PDF data available yet',
            pdf_status: PDF_STATUS
        });
    }
});

app.get('/api/use-sample-data', (req, res) => {
    CURRENT_RENTALS = [
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
        }
    ];
    res.json({
        success: true,
        message: 'Switched to sample data',
        total_rentals: CURRENT_RENTALS.length
    });
});

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
        pdf_rentals_available: PDF_RENTALS.length,
        last_updated: new Date().toISOString(),
        pdf_status: PDF_STATUS,
        last_pdf_update: LAST_PDF_UPDATE,
        data_source: CURRENT_RENTALS[0]?.source || 'unknown',
        note: 'Coordinate-based PDF parsing active'
    });
});

app.get('/api/pdf-status', (req, res) => {
    res.json({
        pdf_status: PDF_STATUS,
        last_attempt: LAST_PDF_UPDATE,
        pdf_url: PDF_URLS[0],
        current_data_source: 'sample',
        note: 'PDF parsing is being implemented gradually'
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
        status: 'Using sample data',
        provinces_count: [...new Set(CURRENT_RENTALS.map(r => r.province))].length,
        note: 'Currently using sample data. PDF parsing to be added.'
    });
});

// Search functionality for rentals
app.get('/api/rentals/search', (req, res) => {
    const { q, province, type } = req.query;
    let filtered = CURRENT_RENTALS;

    if (q) {
        const searchLower = q.toLowerCase();
        filtered = filtered.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            (rental.province && rental.province.toLowerCase().includes(searchLower)) ||
            (rental.type && rental.type.toLowerCase().includes(searchLower))
        );
    }

    if (province) {
        filtered = filtered.filter(rental =>
            rental.province && rental.province.toLowerCase() === province.toLowerCase()
        );
    }

    if (type) {
        filtered = filtered.filter(rental =>
            rental.type && rental.type.toLowerCase() === type.toLowerCase()
        );
    }

    res.json(filtered);
});

// Root endpoint with testing interface
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>ATP Rentals PDF Parser</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; }
                button { padding: 10px 20px; margin: 10px; font-size: 16px; }
                .result { background: #f5f5f5; padding: 20px; margin: 20px 0; border-radius: 5px; }
                .success { background: #d4edda; }
                .error { background: #f8d7da; }
            </style>
        </head>
        <body>
            <h1>ATP Rentals PDF Parser</h1>

            <div>
                <button onclick="parsePDF()">📄 Parse PDF Now</button>
                <button onclick="checkPDFRentals()">🔍 Check PDF Rentals</button>
                <button onclick="usePDFData()">🔄 Use PDF Data</button>
                <button onclick="useSampleData()">📋 Use Sample Data</button>
                <button onclick="checkStats()">📊 Check Stats</button>
            </div>

            <div id="result"></div>

            <script>
                async function parsePDF() {
                    showResult('Parsing PDF...', '');
                    try {
                        const response = await fetch('/api/parse-pdf', { method: 'POST' });
                        const data = await response.json();
                        showResult('PDF Parsing Result', data, data.success ? 'success' : 'error');
                    } catch (error) {
                        showResult('Error', error.toString(), 'error');
                    }
                }

                async function checkPDFRentals() {
                    showResult('Checking PDF rentals...', '');
                    try {
                        const response = await fetch('/api/pdf-rentals');
                        const data = await response.json();
                        showResult('PDF Rentals Status', data);
                    } catch (error) {
                        showResult('Error', error.toString(), 'error');
                    }
                }

                async function usePDFData() {
                    showResult('Switching to PDF data...', '');
                    try {
                        const response = await fetch('/api/use-pdf-data');
                        const data = await response.json();
                        showResult('Data Switch Result', data, data.success ? 'success' : 'error');
                    } catch (error) {
                        showResult('Error', error.toString(), 'error');
                    }
                }

                async function useSampleData() {
                    showResult('Switching to sample data...', '');
                    try {
                        const response = await fetch('/api/use-sample-data');
                        const data = await response.json();
                        showResult('Data Switch Result', data, data.success ? 'success' : 'error');
                    } catch (error) {
                        showResult('Error', error.toString(), 'error');
                    }
                }

                async function checkStats() {
                    showResult('Checking stats...', '');
                    try {
                        const response = await fetch('/api/stats');
                        const data = await response.json();
                        showResult('Current Stats', data);
                    } catch (error) {
                        showResult('Error', error.toString(), 'error');
                    }
                }

                function showResult(title, data, type = '') {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = `
                        <div class="result ${type}">
                            <h3>${title}</h3>
                            <pre>${JSON.stringify(data, null, 2)}</pre>
                        </div>
                    `;
                }

                // Load initial stats on page load
                checkStats();
            </script>
        </body>
        </html>
    `);
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 ATP Rentals API running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Test endpoint: http://localhost:${PORT}/api/test`);
    console.log(`📍 Rentals endpoint: http://localhost:${PORT}/api/rentals`);
    console.log('✅ Server started successfully with sample data');
});
