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

let PDF_RENTALS = [];
const PDF_URL = 'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf';

// Simple PDF text extraction using an external service
async function extractPDFText() {
    try {
        console.log('Attempting PDF text extraction...');
        PDF_STATUS = "Extracting text...";

        // Method 1: Try to get PDF as text directly
        const response = await axios.get(PDF_URL, {
            timeout: 15000,
            headers: {
                'Accept': 'text/plain,application/pdf'
            }
        });

        console.log('PDF response received, length:', response.data.length);
        PDF_STATUS = "PDF content received";

        // If we get here, we have the PDF content
        // For now, just count how many rental-like patterns we can find
        const content = response.data.toString();
        const rentalCount = (content.match(/[A-Z][A-Z\s]{10,50}(Albergue|Aparta-Hotel|Hotel|Hostal|Motel)/g) || []).length;

        PDF_STATUS = `PDF processed: Found ${rentalCount} potential rentals`;
        console.log(PDF_STATUS);

        return { success: true, rentalCount, contentLength: content.length };

    } catch (error) {
        PDF_STATUS = `PDF extraction failed: ${error.message}`;
        console.log(PDF_STATUS);
        return { success: false, error: error.message };
    }
}

// PDF extraction endpoint
app.post('/api/extract-pdf', async (req, res) => {
    try {
        const result = await extractPDFText();
        res.json({
            success: result.success,
            message: PDF_STATUS,
            rental_count: result.rentalCount || 0,
            content_length: result.contentLength || 0
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'PDF extraction error',
            error: error.message
        });
    }
});

// Update package.json to only add axios

let PDF_STATUS = "Not loaded";

// Basic endpoints

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
