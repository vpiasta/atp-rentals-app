const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static('public'));


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

//const PDF_URL = 'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf';
PDF_URL = getLatestPdfUrl()

let PDF_STATUS = "Not loaded";
let PDF_RENTALS = [];


// Column boundaries from our previous work
const COLUMN_BOUNDARIES = {
    NOMBRE: { start: 0, end: 184 },
    MODALIDAD: { start: 184, end: 265 },
    CORREO: { start: 265, end: 481 },
    TELEFONO: { start: 481, end: 600 }
};

// Function to get the latest PDF URL from ATP website
async function getLatestPdfUrl() {
    try {
        const atpUrl = 'https://www.atp.gob.pa/industrias/hoteleros/';
        const response = await axios.get(atpUrl);
        const $ = cheerio.load(response.data);

        // Look for the button with "Descargar PDF" text
        const pdfLink = $('a.qubely-block-btn-anchor:contains("Descargar PDF")').attr('href');
        
        if (!pdfLink) {
            throw new Error('PDF link not found on the page');
        }

        console.log('Found latest PDF URL:', pdfLink);
        return pdfLink;

    } catch (error) {
        console.error('Error fetching PDF URL:', error.message);
        // Fallback to a default URL or handle error as needed
        throw error;
    }
}

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
}       // end of groupIntoRows

//============================================================

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

// Check if a row is a continuation of the previous row
function isContinuationRow(rowData, previousRowData) {
    // 1. Check for specific multi-word type patterns
    if (previousRowData.type === 'Hostal' && rowData.type === 'Familiar') {
        return true;
    }
    if (previousRowData.type === 'Sitio de' && rowData.type === 'acampar') {
        return true;
    }
    if (!rowData.type) {
        return true;
    }

    // 2. Check for email continuation
    if (previousRowData.email && rowData.email && !rowData.type ) {
        // Check if previous email is incomplete (doesn't look like a complete email)
        const isPreviousEmailComplete = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(previousRowData.email);

        if (!isPreviousEmailComplete) {
            return true;
        }
    }

    // 3. Check for phone continuation
    if (previousRowData.phone && rowData.phone && !rowData.name && !rowData.type && !rowData.email) {
        // Phone continues if previous ends with hyphen (number interrupted)
        if (previousRowData.phone.endsWith('-')) {
            return true;
        }
        // OR if previous ends with slash AND current doesn't end with slash (second number)
        if (previousRowData.phone.endsWith('/') && !rowData.phone.endsWith('/')) {
            return true;
        }
    }

    console.log(`Not a continuation: row has type "${rowData.type}"`);
    return false;
}

// Merge two rows that belong to the same rental
function mergeRentalRows(previousRental, continuationRow) {
    const merged = { ...previousRental };

    // Merge name with space
    if (continuationRow.name) {
        merged.name = (previousRental.name + ' ' + continuationRow.name).trim();
    }

    // Merge type - handle special cases
    if (continuationRow.type) {
        if (previousRental.type === 'Hostal' && continuationRow.type === 'Familiar') {
            merged.type = 'Hostal Familiar';
        } else if (previousRental.type === 'Sitio de' && continuationRow.type === 'acampar') {
            merged.type = 'Sitio de acampar';
        }
    }

    // Merge email without space
    if (continuationRow.email) {
        merged.email = (previousRental.email + continuationRow.email).trim();
    }

    // Merge phone with proper formatting
    if (continuationRow.phone) {
        if (previousRental.phone.endsWith('/')) {
            merged.phone = (previousRental.phone + ' ' + continuationRow.phone).trim();
        } else if (previousRental.phone.endsWith('-')) {
            merged.phone = (previousRental.phone.slice(0, -1) + continuationRow.phone).trim();
        } else {
            merged.phone = (previousRental.phone + ' ' + continuationRow.phone).trim();
        }
    }

    return merged;
}

// Function to detect if a row is a page header or table header
function isHeaderRow(rowText) {
    // Page headers
    if (rowText.includes('Reporte de Hospedajes vigentes') ||
        rowText.includes('Página') ||
        rowText.includes('Total por provincia') ||
        rowText.includes('rep_hos_web')) {
        console.log(`Header detected: ${rowText}`);
        return true;
    }

    // Table headers
    if (rowText.includes('Nombre') &&
          (rowText.includes('Modalidad') || rowText.includes('Correo'))) {
          console.log(`Table header detected: ${rowText}`);
        return true;
    }

    return false;
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
        let currentRental = null;

        // Process all pages
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
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

            // Process each row in this page
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
                if (isHeaderRow(rowText) || !currentProvince) {
                    console.log(`Skipping header row: ${rowText}`);
                    continue;
                }

                // Skip summary rows
                if (rowText.includes('Total por')) {
                    console.log(`Skipping summary row: ${rowText}`);
                    continue;
                }

                // Parse row data
                const rowData = parseRowData(row);
                console.log(`Processing row ${i}:`, rowData);
                console.log(`Current rental:`, currentRental);

                // ALWAYS check for continuation first - using the "no type" criterion
                if (currentRental && isContinuationRow(rowData, currentRental)) {
                    console.log(`🔄 Stitching row ${i} to previous rental`);
                    console.log(`Before stitch - currentRental:`, currentRental);
                    console.log(`Row to stitch:`, rowData);
                    currentRental = mergeRentalRows(currentRental, rowData);
                    console.log(`After stitch - currentRental:`, currentRental);
                    continue; // Skip the rest of the logic for this row
                }

                // If we have a current rental and this row is NOT a continuation, save it
                // BUT only if this row looks like a legitimate new rental start
                if (currentRental && rowData.name && rowData.name.trim() &&
                    (rowData.type || rowData.email || rowData.phone)) {
                    console.log(`💾 Saving current rental and starting new one:`, currentRental);
                    allRentals.push(currentRental);
                    currentRental = { ...rowData, province: currentProvince };
                }
                // If no current rental, start a new one if we have substantial data
                else if (!currentRental && rowData.name && rowData.name.trim() &&
                         (rowData.type || rowData.email || rowData.phone)) {
                    console.log(`🆕 Starting new rental:`, rowData);
                    currentRental = { ...rowData, province: currentProvince };
                }
                // If we have minimal data but no current rental, start one cautiously
                else if (!currentRental && rowData.name && rowData.name.trim()) {
                    console.log(`⚠️ Starting cautious rental:`, rowData);
                    currentRental = { ...rowData, province: currentProvince };
                }
                // If we have a current rental but this row doesn't look like a new rental,
                // just continue (don't save yet - it might be garbage data)
                else if (currentRental) {
                    console.log(`❓ Row doesn't look like continuation or new rental, keeping current rental`);
                }
            }
        }

        // Only save the final rental AFTER processing ALL pages
        if (currentRental) {
            allRentals.push(currentRental);
        }

        PDF_RENTALS = allRentals;
        PDF_STATUS = `PDF parsed: ${allRentals.length} rentals found from ${numPages} pages`;
        console.log(`✅ ${PDF_STATUS}`);

        return { success: true, rentals: allRentals.length };

    } catch (error) {
        PDF_STATUS = `PDF parsing failed: ${error.message}`;
        console.error('PDF error:', error);
        return { success: false, error: error.message };
    }
}

//
async function initializePDFData() {
    try {
        console.log('🔄 Auto-loading PDF data on startup...');
        const result = await parsePDFWithCoordinates();
        if (result.success) {
            CURRENT_RENTALS = PDF_RENTALS;
            console.log(`✅ Auto-loaded ${CURRENT_RENTALS.length} rentals from PDF`);
        }
    } catch (error) {
        console.error('Auto-load error:', error);
    }
}

// Call this when server starts
initializePDFData();

// Basic endpoints

// Debug endpoint to see stitching results
app.get('/api/pdf-debug-stitching', (req, res) => {
    const stitchedExamples = PDF_RENTALS.filter(rental =>
        rental.name.includes(' ') && rental.name.split(' ').length > 2
    ).slice(0, 5);

    res.json({
        total_stitched_rentals: PDF_RENTALS.filter(r => r.name.includes(' ') && r.name.split(' ').length > 2).length,
        examples: stitchedExamples,
        total_rentals: PDF_RENTALS.length
    });
});

// PDF extraction endpoint
app.post('/api/extract-pdf', async (req, res) => {
    try {
        const result = await parsePDFWithCoordinates();
        res.json({
            success: result.success,
            message: PDF_STATUS,
            rentals_found: PDF_RENTALS.length,
            rentals: PDF_RENTALS,
            current_province_stats: Object.entries(PDF_RENTALS.reduce((acc, r) => {
              acc[r.province] = (acc[r.province] || 0) + 1;
              return acc;
            }, {})).map(([province, count]) => `${province}: ${count}`),
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

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/ping', (req, res) => {
    res.json({
        message: 'pong',
        timestamp: new Date().toISOString()
    });
});

// API endpoint for statistics
app.get('/api/stats', (req, res) => {
    const stats = {
        total_rentals: CURRENT_RENTALS.length,
        last_updated: new Date().toISOString(),
        status: "PDF Data Loaded",
        features: "Search by name, type, province"
    };
    res.json(stats);
});

// API endpoint for provinces with counts
app.get('/api/provinces', (req, res) => {
    const provinceCounts = CURRENT_RENTALS.reduce((acc, rental) => {
        if (rental.province) {
            acc[rental.province] = (acc[rental.province] || 0) + 1;
        }
        return acc;
    }, {});

    const provinces = Object.entries(provinceCounts)
        .map(([province, count]) => ({ province, count }))
        .sort((a, b) => a.province.localeCompare(b.province));

    res.json(provinces);
});

// API endpoint for rental types
app.get('/api/types', (req, res) => {
    const types = [...new Set(CURRENT_RENTALS.map(rental => rental.type))].filter(Boolean).sort();
    res.json(types);
});

// Enhanced rentals endpoint with search and filtering
app.get('/api/rentals', (req, res) => {
    const { search, province, type } = req.query;

    let filteredRentals = [...CURRENT_RENTALS];

    // Apply search filter
    if (search) {
        const searchLower = search.toLowerCase();
        filteredRentals = filteredRentals.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            (rental.email && rental.email.toLowerCase().includes(searchLower)) ||
            (rental.phone && rental.phone.toLowerCase().includes(searchLower)) ||
            (rental.province && rental.province.toLowerCase().includes(searchLower)) ||
            (rental.type && rental.type.toLowerCase().includes(searchLower))
        );
    }

    // Apply province filter
    if (province) {
        filteredRentals = filteredRentals.filter(rental =>
            rental.province === province
        );
    }

    // Apply type filter
    if (type) {
        filteredRentals = filteredRentals.filter(rental =>
            rental.type === type
        );
    }

    res.json(filteredRentals);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        pdf_status: PDF_STATUS,
        total_rentals: CURRENT_RENTALS.length
    });
});


app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Main page: http://localhost:${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 PDF Test: http://localhost:${PORT}/test-pdf`);
});
