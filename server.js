const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Simple data
let CURRENT_RENTALS = [
    {
        name: "APARTHOTEL BOQUETE",
        type: "Aparta-Hotel",
        email: "info@aparthotel-boquete.com",
        phone: "68916669 / 68916660",
        province: "CHIRIQUÍ",
        district: "Boquete",
        source: "SAMPLE_DATA"
    }
];

const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const PDF_URL = 'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf';

let PDF_STATUS = "Not loaded";
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
            rental.email += item.text;
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

// Coordinate-based PDF parsing
async function parsePDFWithCoordinates() {
    try {
        console.log('Starting coordinate-based PDF parsing...');
        PDF_STATUS = "Loading PDF...";

        const response = await axios.get(PDF_URL, {
            responseType: 'arraybuffer',
            timeout: 30000
        });

        console.log('PDF downloaded, processing...');
        const data = new Uint8Array(response.data);
        const pdf = await pdfjsLib.getDocument(data).promise;
        const numPages = pdf.numPages;

        console.log(`Processing ${numPages} pages...`);
        const allRentals = [];
        let currentProvince = '';

        // Process just first 3 pages to test
        for (let pageNum = 1; pageNum <= Math.min(3, numPages); pageNum++) {
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
            console.log(`Page ${pageNum}: ${rows.length} rows found`);

            // Process each row
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowText = row.items.map(item => item.text).join(' ');

                // Detect province
                if (rowText.includes('Provincia:')) {
                    currentProvince = rowText.replace('Provincia:', '').replace(/Total.*/, '').trim();
                    console.log(`Found province: ${currentProvince}`);
                    continue;
                }

                // Skip header rows
                if (rowText.includes('Nombre') || rowText.includes('Modalidad') ||
                    rowText.includes('Correo') || !currentProvince) {
                    continue;
                }

                // Parse row data
                const rowData = parseRowData(row);

                // Only include valid rental rows
                if (rowData.name && rowData.name.length > 3) {
                    const rental = {
                        name: rowData.name,
                        type: rowData.type,
                        email: rowData.email,
                        phone: rowData.phone,
                        province: currentProvince,
                        district: 'Extracted',
                        source: 'ATP_PDF_COORDINATES'
                    };
                    allRentals.push(rental);
                }
            }
        }

        PDF_RENTALS = allRentals;
        PDF_STATUS = `PDF parsed: ${allRentals.length} rentals found from first 3 pages`;
        console.log(`✅ ${PDF_STATUS}`);

        return { success: true, rentals: allRentals.length };

    } catch (error) {
        PDF_STATUS = `PDF parsing failed: ${error.message}`;
        console.error('PDF error:', error);
        return { success: false, error: error.message };
    }
}



// Basic endpoints

// PDF extraction endpoint
app.post('/api/extract-pdf', async (req, res) => {
    try {
        const result = await parsePDFWithCoordinates();
        res.json({
            success: result.success,
            message: PDF_STATUS,
            rentals_found: PDF_RENTALS.length,
            sample_rentals: PDF_RENTALS.slice(0, 5),
            current_province_stats: Object.keys(PDF_RENTALS.reduce((acc, r) => {
                acc[r.province] = true;
                return acc;
            }, {})),
            note: 'Coordinate-based extraction'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'PDF extraction error',
            error: error.message
        });
    }
});


// Add endpoint to use PDF data
app.post('/api/use-pdf-data', (req, res) => {
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
            message: 'No PDF data available'
        });
    }
});

// Web interface for testing PDF extraction
app.get('/test-pdf', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PDF Test</title>
            <style>
                body { font-family: Arial; margin: 40px; }
                button { padding: 10px 20px; font-size: 16px; margin: 10px; }
                .result { background: #f5f5f5; padding: 20px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <h1>PDF Extraction Test</h1>
            <button onclick="testPDF()">Test PDF Extraction</button>
            <div id="result"></div>

            <script>
                async function testPDF() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = 'Testing PDF extraction...';

                    try {
                        const response = await fetch('/api/extract-pdf', {
                            method: 'POST'
                        });
                        const data = await response.json();
                        resultDiv.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
                    } catch (error) {
                        resultDiv.innerHTML = 'Error: ' + error;
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/', (req, res) => {
    res.json({
        message: 'ATP Rentals API',
        status: 'running',
        pdf_status: PDF_STATUS,
        endpoints: {
            health: '/health',
            rentals: '/api/rentals',
            ping: '/api/ping',
            test_pdf: '/test-pdf',
            extract_pdf: 'POST /api/extract-pdf'
        }
    });
});

app.get('/api/ping', (req, res) => {
    res.json({
        message: 'pong',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/rentals', (req, res) => {
    res.json(CURRENT_RENTALS);
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
});
