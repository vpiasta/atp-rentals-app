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
