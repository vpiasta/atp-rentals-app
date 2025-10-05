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

let PDF_STATUS = "Not loaded";

const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const PDF_URLS = [
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf'
];

let PDF_STATUS = "Not loaded";
let PDF_RENTALS = [];

// Step 1: Simple PDF test function
async function testPDFConnection() {
    try {
        console.log('Testing PDF connection...');
        const response = await axios.get(PDF_URLS[0], {
            responseType: 'arraybuffer',
            timeout: 10000
        });

        console.log('✅ PDF fetched successfully');
        return true;
    } catch (error) {
        console.log('❌ PDF fetch failed:', error.message);
        return false;
    }
}

// Step 2: Simple PDF loading (no parsing yet)
async function loadPDF() {
    try {
        console.log('Loading PDF document...');
        const response = await axios.get(PDF_URLS[0], {
            responseType: 'arraybuffer',
            timeout: 15000
        });

        const data = new Uint8Array(response.data);
        const pdf = await pdfjsLib.getDocument(data).promise;
        const numPages = pdf.numPages;

        PDF_STATUS = `PDF loaded: ${numPages} pages`;
        console.log(`✅ ${PDF_STATUS}`);

        return { success: true, pdf, numPages };
    } catch (error) {
        PDF_STATUS = `PDF loading failed: ${error.message}`;
        console.log(`❌ ${PDF_STATUS}`);
        return { success: false, error: error.message };
    }
}

// Step 3: Safe PDF parsing endpoint
app.post('/api/load-pdf', async (req, res) => {
    try {
        console.log('Loading PDF...');
        const result = await loadPDF();

        if (result.success) {
            res.json({
                success: true,
                message: PDF_STATUS,
                pages: result.numPages
            });
        } else {
            res.json({
                success: false,
                message: PDF_STATUS,
                error: result.error
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'PDF loading error',
            error: error.message
        });
    }
});

// Update the root endpoint to show PDF status
app.get('/', (req, res) => {
    res.json({
        message: 'ATP Rentals API',
        status: 'running',
        pdf_status: PDF_STATUS,
        endpoints: {
            health: '/health',
            rentals: '/api/rentals',
            ping: '/api/ping',
            load_pdf: 'POST /api/load-pdf'
        }
    });
});

// Basic endpoints
app.get('/', (req, res) => {
    res.json({
        message: 'ATP Rentals API',
        status: 'running',
        pdf_status: PDF_STATUS
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        rentals: CURRENT_RENTALS.length
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
