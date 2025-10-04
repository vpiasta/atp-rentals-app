const express = require('express');
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PDF_URLS = [
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf'
];

let CURRENT_RENTALS = [];
let PROVINCE_STATS = {};
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';
let DEBUG_DATA = {}; // Store debug information

// Column boundaries based on your analysis
const COLUMN_BOUNDARIES = {
    NOMBRE: { start: 0, end: 184 },
    MODALIDAD: { start: 184, end: 265 },
    CORREO: { start: 265, end: 481 },
    TELEFONO: { start: 481, end: 600 }
};

// PDF parsing with table detection and row stitching
async function fetchAndParsePDF() {
    for (const pdfUrl of PDF_URLS) {
        try {
            console.log(`Fetching PDF from: ${pdfUrl}`);
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                console.log('PDF fetched, parsing with table detection...');
                const result = await parsePDFTables(response.data);
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                console.log(`Parsed ${result.rentals.length} rentals from PDF (Expected: ${result.totalExpected})`);
                console.log('Province statistics:', result.provinceStats);

                CURRENT_RENTALS = result.rentals;
                PROVINCE_STATS = result.provinceStats;
                DEBUG_DATA = result.debugData || {};
                return true;
            }
        } catch (error) {
            console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
        }
    }

    PDF_STATUS = 'No PDF available';
    CURRENT_RENTALS = getFallbackData();
    PROVINCE_STATS = {};
    return false;
}

async function parsePDFTables(pdfBuffer) {
    try {
        const data = new Uint8Array(pdfBuffer);
        const pdf = await pdfjsLib.getDocument(data).promise;
        const numPages = pdf.numPages;
        const allRentals = [];
        const provinceStats = {};
        let totalExpected = 0;
        const debugData = {
            pages: [],
            stitchingEvents: []
        };

        console.log(`Processing ${numPages} pages for table analysis...`);

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            console.log(`Analyzing page ${pageNum}...`);
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();

            // Extract text with precise positioning
            const textItems = textContent.items.map(item => ({
                text: item.str,
                x: Math.round(item.transform[4] * 100) / 100,
                y: Math.round(item.transform[5] * 100) / 100,
                width: item.width,
                height: item.height,
                page: pageNum
            }));

            const pageResult = parsePageRentals(textItems, pageNum, debugData);
            allRentals.push(...pageResult.rentals);

            // Merge province stats
            Object.keys(pageResult.provinceStats).forEach(province => {
                if (!provinceStats[province]) {
                    provinceStats[province] = 0;
                }
                provinceStats[province] += pageResult.provinceStats[province];
            });

            totalExpected += pageResult.expectedCount;

            debugData.pages.push({
                pageNum,
                rows: pageResult.rawRows,
                rentalsFound: pageResult.rentals.length,
                expected: pageResult.expectedCount,
                province: pageResult.currentProvince
            });
        }

        // Validate counts per province
        const validationResults = validateProvinceCounts(allRentals, provinceStats, debugData);

        return {
            rentals: allRentals,
            provinceStats: provinceStats,
            totalExpected: totalExpected,
            debugData: debugData,
            validation: validationResults
        };
    } catch (error) {
        console.error('Error in parsePDFTables:', error);
        const fallback = getFallbackData();
        return {
            rentals: fallback,
            provinceStats: {},
            totalExpected: fallback.length,
            debugData: { error: error.message }
        };
    }
}

function parsePageRentals(textItems, pageNum, debugData) {
    const rentals = [];
    const provinceStats = {};
    let expectedCount = 0;
    let currentProvince = '';

    // Group into rows
    const rows = groupIntoRows(textItems);
    const rawRows = rows.map(row => ({
        y: row.y,
        items: row.items.map(item => ({ text: item.text, x: item.x })),
        joinedText: row.items.map(item => item.text).join(' ')
    }));

    // Process rows to detect province and rentals
    let currentRental = null;
    let stitchingInProgress = false;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowText = row.items.map(item => item.text).join(' ');

        // Detect province header
        const provinceMatch = detectProvinceAndCount(rowText);
        if (provinceMatch) {
            currentProvince = provinceMatch.province;
            expectedCount = provinceMatch.count;
            provinceStats[currentProvince] = expectedCount;
            console.log(`📍 Province: "${currentProvince}", Expected: ${expectedCount}`);
            continue;
        }

        // Skip header rows and other non-data rows
        if (isHeaderRow(rowText) || !currentProvince) {
            continue;
        }

        // Parse row data
        const rowData = parseRowData(row);

        // Check if this is a valid rental row
        if (isValidRentalRow(rowData)) {
            // If we have a current rental being stitched, check if this continues it
            if (currentRental && isContinuationRow(rowData, currentRental)) {
                debugData.stitchingEvents.push({
                    type: 'CONTINUATION_DETECTED',
                    page: pageNum,
                    rowIndex: i,
                    currentRental: { ...currentRental },
                    continuationRow: { ...rowData },
                    reason: getContinuationReason(rowData, currentRental)
                });

                currentRental = mergeRentalRows(currentRental, rowData);
                stitchingInProgress = true;
            } else {
                // If we have a current rental, complete it before starting new one
                if (currentRental) {
                    const completeRental = createCompleteRental(currentRental, currentProvince);
                    rentals.push(completeRental);

                    debugData.stitchingEvents.push({
                        type: 'RENTAL_COMPLETED',
                        page: pageNum,
                        rental: { ...completeRental },
                        wasStitched: stitchingInProgress
                    });

                    stitchingInProgress = false;
                }

                // Start new rental
                currentRental = { ...rowData };

                debugData.stitchingEvents.push({
                    type: 'NEW_RENTAL_STARTED',
                    page: pageNum,
                    rowIndex: i,
                    rentalData: { ...rowData }
                });
            }
        } else if (currentRental && isContinuationRow(rowData, currentRental)) {
            // This row only contains continuation data
            debugData.stitchingEvents.push({
                type: 'CONTINUATION_ONLY',
                page: pageNum,
                rowIndex: i,
                currentRental: { ...currentRental },
                continuationRow: { ...rowData },
                reason: getContinuationReason(rowData, currentRental)
            });

            currentRental = mergeRentalRows(currentRental, rowData);
            stitchingInProgress = true;
        }
    }

    // Don't forget the last rental
    if (currentRental) {
        const completeRental = createCompleteRental(currentRental, currentProvince);
        rentals.push(completeRental);

        debugData.stitchingEvents.push({
            type: 'FINAL_RENTAL_COMPLETED',
            page: pageNum,
            rental: { ...completeRental },
            wasStitched: stitchingInProgress
        });
    }

    return {
        rentals: rentals,
        provinceStats: provinceStats,
        expectedCount: expectedCount,
        currentProvince: currentProvince,
        rawRows: rawRows
    };
}

function detectProvinceAndCount(rowText) {
    // Multiple patterns to detect province and count
    const patterns = [
        /Provincia:\s*([A-ZÁÉÍÓÚÑ\s]+)\s*(\d+)\s*Total por provincia:/i,
        /Provincia:\s*([A-ZÁÉÍÓÚÑ\s]+)\s*(\d+)\s*Total/i,
        /([A-ZÁÉÍÓÚÑ\s]+)\s*(\d+)\s*Total por provincia:/i,
        /Provincia:\s*([A-ZÁÉÍÓÚÑ\s]+).*?(\d+)\s*Total/i
    ];

    for (const pattern of patterns) {
        const match = rowText.match(pattern);
        if (match) {
            return {
                province: match[1].trim().toUpperCase(),
                count: parseInt(match[2])
            };
        }
    }
    return null;
}

function isHeaderRow(rowText) {
    const headerPatterns = [
        /Nombre/i,
        /Modalidad/i,
        /Correo/i,
        /Teléfono/i,
        /Principal/i,
        /REPORTE.*HOSPEDAJES/i,
        /ATP/i
    ];

    return headerPatterns.some(pattern => pattern.test(rowText));
}

function isValidRentalRow(rowData) {
    // A row is valid if it has substantial content in name and at least one other field
    const hasValidName = rowData.name && rowData.name.trim().length > 2;
    const hasType = rowData.type && rowData.type.trim().length > 0;
    const hasEmail = rowData.email && rowData.email.trim().length > 0;
    const hasPhone = rowData.phone && rowData.phone.trim().length > 0;

    return hasValidName && (hasType || hasEmail || hasPhone);
}

function isContinuationRow(rowData, currentRental) {
    // Check for specific multi-word type patterns
    if (currentRental.type === 'Hostal' && rowData.type === 'Familiar') {
        return true;
    }
    if (currentRental.type === 'Sitio de' && rowData.type === 'acampar') {
        return true;
    }

    // Check for email continuation (incomplete email)
    if (rowData.email && currentRental.email &&
        !isCompleteEmail(currentRental.email) &&
        !rowData.name && !rowData.type && !rowData.phone) {
        return true;
    }

    // Check for phone continuation (ends with hyphen or slash)
    if (rowData.phone && currentRental.phone &&
        (currentRental.phone.endsWith('-') || currentRental.phone.endsWith('/')) &&
        !rowData.name && !rowData.type && !rowData.email) {
        return true;
    }

    // Check for name continuation (minimal content in other fields)
    if (rowData.name &&
        (!rowData.type || rowData.type.length < 3) &&
        (!rowData.email || rowData.email.length < 3) &&
        (!rowData.phone || rowData.phone.length < 3)) {
        return true;
    }

    return false;
}

function getContinuationReason(rowData, currentRental) {
    if (currentRental.type === 'Hostal' && rowData.type === 'Familiar') {
        return 'Hostal Familiar pattern';
    }
    if (currentRental.type === 'Sitio de' && rowData.type === 'acampar') {
        return 'Sitio de acampar pattern';
    }
    if (rowData.email && !isCompleteEmail(currentRental.email)) {
        return 'Email continuation';
    }
    if (rowData.phone && (currentRental.phone.endsWith('-') || currentRental.phone.endsWith('/'))) {
        return 'Phone continuation';
    }
    if (rowData.name && (!rowData.type && !rowData.email && !rowData.phone)) {
        return 'Name continuation';
    }
    return 'Unknown reason';
}

function isCompleteEmail(email) {
    return email.includes('@') && (email.includes('.com') || email.includes('.net') || email.includes('.org') || email.includes('.gob'));
}

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

function mergeRentalRows(currentRental, continuationRow) {
    const merged = { ...currentRental };

    // Merge name with space
    if (continuationRow.name && continuationRow.name.trim().length > 0) {
        merged.name = (currentRental.name + ' ' + continuationRow.name).trim();
    }

    // Merge type - handle specific patterns
    if (continuationRow.type && continuationRow.type.trim().length > 0) {
        if (currentRental.type === 'Hostal' && continuationRow.type === 'Familiar') {
            merged.type = 'Hostal Familiar';
        } else if (currentRental.type === 'Sitio de' && continuationRow.type === 'acampar') {
            merged.type = 'Sitio de acampar';
        } else {
            merged.type = (currentRental.type + ' ' + continuationRow.type).trim();
        }
    }

    // Merge email without space
    if (continuationRow.email && continuationRow.email.trim().length > 0) {
        merged.email = (currentRental.email + continuationRow.email).trim();
    }

    // Merge phone with proper formatting
    if (continuationRow.phone && continuationRow.phone.trim().length > 0) {
        if (currentRental.phone.endsWith('/')) {
            merged.phone = (currentRental.phone + ' ' + continuationRow.phone).trim();
        } else if (currentRental.phone.endsWith('-')) {
            merged.phone = (currentRental.phone.slice(0, -1) + continuationRow.phone).trim();
        } else {
            merged.phone = (currentRental.phone + ' ' + continuationRow.phone).trim();
        }

        // Clean up phone format
        merged.phone = merged.phone.replace(/\s+/g, ' ').trim();
    }

    return merged;
}

function validateProvinceCounts(rentals, provinceStats, debugData) {
    const validation = {};
    let totalExpected = 0;
    let totalFound = 0;

    Object.keys(provinceStats).forEach(province => {
        const expected = provinceStats[province];
        const found = rentals.filter(r => r.province === province).length;
        totalExpected += expected;
        totalFound += found;

        validation[province] = {
            expected,
            found,
            difference: found - expected,
            status: found === expected ? 'OK' : found > expected ? 'OVER' : 'UNDER'
        };
    });

    debugData.validation = validation;
    debugData.totalValidation = {
        totalExpected,
        totalFound: rentals.length,
        difference: rentals.length - totalExpected
    };

    console.log('=== VALIDATION RESULTS ===');
    console.log(`Total Expected: ${totalExpected}, Total Found: ${rentals.length}`);
    Object.keys(validation).forEach(province => {
        const result = validation[province];
        console.log(`${province}: Expected ${result.expected}, Found ${result.found} (${result.status})`);
    });

    return validation;
}

// Keep the existing helper functions (groupIntoRows, cleanText, extractEmail, etc.)
// ... [all your existing helper functions remain the same] ...

// NEW DEBUG ENDPOINTS

app.get('/api/debug-parsing-analysis', (req, res) => {
    const analysis = {
        totalRentalsFound: CURRENT_RENTALS.length,
        totalExpected: Object.values(PROVINCE_STATS).reduce((a, b) => a + b, 0),
        provinceStats: PROVINCE_STATS,
        validation: DEBUG_DATA.validation || {},
        stitchingEvents: DEBUG_DATA.stitchingEvents ? DEBUG_DATA.stitchingEvents.length : 0,
        pdfStatus: PDF_STATUS
    };

    res.json(analysis);
});

app.get('/api/debug-stitching-events', (req, res) => {
    const events = DEBUG_DATA.stitchingEvents || [];
    const limitedEvents = events.slice(0, 50); // Limit to first 50 events

    res.json({
        totalEvents: events.length,
        events: limitedEvents
    });
});

app.get('/api/debug-page-data/:pageNum?', (req, res) => {
    const pageNum = parseInt(req.params.pageNum) || 1;
    const pageData = DEBUG_DATA.pages ? DEBUG_DATA.pages[pageNum - 1] : null;

    if (!pageData) {
        return res.status(404).json({ error: `No data for page ${pageNum}` });
    }

    res.json({
        page: pageNum,
        province: pageData.province,
        expectedCount: pageData.expected,
        rentalsFound: pageData.rentalsFound,
        rawRows: pageData.rows.slice(0, 20) // First 20 rows
    });
});

app.get('/api/debug-visual', (req, res) => {
    const htmlResponse = `
<!DOCTYPE html>
<html>
<head>
    <title>PDF Parsing Debug Analysis</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { background: white; padding: 20px; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 5px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
        .stat-card { background: #e8f4fd; padding: 10px; border-radius: 5px; text-align: center; }
        .stat-card.good { background: #d4edda; }
        .stat-card.bad { background: #f8d7da; }
        .stat-card.warning { background: #fff3cd; }
        .validation-table { width: 100%; border-collapse: collapse; }
        .validation-table th, .validation-table td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
        .event { margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 3px; }
        .event.stitching { border-left: 4px solid #007bff; }
        .event.new-rental { border-left: 4px solid #28a745; }
        .raw-row { font-family: monospace; font-size: 0.9em; margin: 2px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>PDF Parsing Debug Analysis</h1>

        <div class="section">
            <h2>Overall Statistics</h2>
            <div class="stats-grid">
                <div class="stat-card ${CURRENT_RENTALS.length === DEBUG_DATA.totalValidation?.totalExpected ? 'good' : 'bad'}">
                    <h3>Total Rentals</h3>
                    <div>Found: ${CURRENT_RENTALS.length}</div>
                    <div>Expected: ${DEBUG_DATA.totalValidation?.totalExpected || 'N/A'}</div>
                </div>
                <div class="stat-card">
                    <h3>Stitching Events</h3>
                    <div>${DEBUG_DATA.stitchingEvents?.length || 0}</div>
                </div>
                <div class="stat-card">
                    <h3>Provinces</h3>
                    <div>${Object.keys(PROVINCE_STATS).length}</div>
                </div>
            </div>
        </div>

        <div class="section">
            <h2>Province Validation</h2>
            <table class="validation-table">
                <thead>
                    <tr>
                        <th>Province</th>
                        <th>Expected</th>
                        <th>Found</th>
                        <th>Difference</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.keys(DEBUG_DATA.validation || {}).map(province => {
                        const val = DEBUG_DATA.validation[province];
                        return `
                        <tr>
                            <td>${province}</td>
                            <td>${val.expected}</td>
                            <td>${val.found}</td>
                            <td>${val.difference}</td>
                            <td>${val.status}</td>
                        </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>

        <div class="section">
            <h2>Recent Stitching Events (First 10)</h2>
            ${(DEBUG_DATA.stitchingEvents || []).slice(0, 10).map(event => `
                <div class="event stitching">
                    <strong>${event.type}</strong> - Page ${event.page}
                    ${event.reason ? `<br><em>Reason: ${event.reason}</em>` : ''}
                    ${event.currentRental ? `<br>Current: ${JSON.stringify(event.currentRental)}` : ''}
                    ${event.continuationRow ? `<br>Continuation: ${JSON.stringify(event.continuationRow)}` : ''}
                </div>
            `).join('')}
        </div>

        <div class="section">
            <h2>Actions</h2>
            <button onclick="refreshData()">Refresh PDF Data</button>
            <button onclick="viewStitchingEvents()">View All Stitching Events</button>
        </div>
    </div>

    <script>
        function refreshData() {
            fetch('/api/refresh-pdf', { method: 'POST' })
                .then(response => response.json())
                .then(data => {
                    alert('Data refreshed! Total rentals: ' + data.total_rentals);
                    location.reload();
                });
        }

        function viewStitchingEvents() {
            window.open('/api/debug-stitching-events');
        }
    </script>
</body>
</html>
    `;

    res.send(htmlResponse);
});

// Keep all your existing API endpoints...
// ... [all your existing endpoints remain the same] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Debug visual: http://localhost:${PORT}/api/debug-visual`);

    setTimeout(async () => {
        try {
            await fetchAndParsePDF();
            const totalExpected = PROVINCE_STATS ? Object.values(PROVINCE_STATS).reduce((a, b) => a + b, 0) : 0;
            console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded (Expected: ${totalExpected})`);

            // Log validation results
            if (DEBUG_DATA.validation) {
                console.log('=== VALIDATION RESULTS ===');
                Object.keys(DEBUG_DATA.validation).forEach(province => {
                    const result = DEBUG_DATA.validation[province];
                    console.log(`${province}: Expected ${result.expected}, Found ${result.found} (${result.status})`);
                });
            }
        } catch (error) {
            console.error('Error during startup:', error);
            CURRENT_RENTALS = getFallbackData();
        }
    }, 2000);
});
