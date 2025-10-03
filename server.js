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
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';

// PDF parsing with table detection
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
                const tablesData = await parsePDFTables(response.data);
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                console.log(`Found ${tablesData.length} tables`);
                CURRENT_RENTALS = []; // We're just analyzing for now
                return true;
            }
        } catch (error) {
            console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
        }
    }

    PDF_STATUS = 'No PDF available';
    CURRENT_RENTALS = [];
    return false;
}

async function parsePDFTables(pdfBuffer) {
    try {
        const data = new Uint8Array(pdfBuffer);
        const pdf = await pdfjsLib.getDocument(data).promise;
        const numPages = pdf.numPages;
        const allTables = [];

        console.log(`Processing ${numPages} pages for table analysis...`);

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            console.log(`Analyzing page ${pageNum}...`);
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();

            // Extract text with precise positioning
            const textItems = textContent.items.map(item => ({
                text: item.str,
                x: Math.round(item.transform[4] * 100) / 100, // 2 decimal precision
                y: Math.round(item.transform[5] * 100) / 100,
                width: item.width,
                height: item.height,
                page: pageNum
            }));

            const pageTables = analyzePageStructure(textItems, pageNum);
            allTables.push(...pageTables);
        }

        return allTables;
    } catch (error) {
        console.error('Error in parsePDFTables:', error);
        return [];
    }
}

function analyzePageStructure(textItems, pageNum) {
    const tables = [];

    // Group into rows
    const rows = groupIntoRows(textItems);

    console.log(`Page ${pageNum}: Found ${rows.length} rows`);

    // Look for table patterns
    let currentTable = null;
    let currentProvince = '';

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowText = row.items.map(item => item.text).join(' | ');

        // Detect province
        if (rowText.includes('Provincia:')) {
            currentProvince = rowText.replace('Provincia:', '').trim();
            console.log(`Found province: ${currentProvince}`);
            continue;
        }

        // Detect table header
        if (rowText.includes('Nombre') && rowText.includes('Modalidad')) {
            if (currentTable) {
                tables.push(currentTable);
            }
            currentTable = {
                province: currentProvince,
                page: pageNum,
                headers: row,
                dataRows: [],
                columnBoundaries: detectColumnBoundaries(row)
            };
            console.log(`Table header found at row ${i}`);
            continue;
        }

        // Detect table end
        if (rowText.includes('Total por provincia:')) {
            if (currentTable) {
                tables.push(currentTable);
                currentTable = null;
            }
            continue;
        }

        // Add data row to current table
        if (currentTable && isDataRow(row)) {
            currentTable.dataRows.push(row);
        }
    }

    // Don't forget the last table
    if (currentTable) {
        tables.push(currentTable);
    }

    return tables;
}

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

function detectColumnBoundaries(headerRow) {
    const boundaries = [];
    const headers = ['Nombre', 'Modalidad', 'Correo Principal', 'Cel/Teléfono', 'Teléfono'];

    headers.forEach(header => {
        const headerItem = headerRow.items.find(item =>
            item.text.includes(header)
        );
        if (headerItem) {
            boundaries.push({
                name: header,
                x: headerItem.x,
                width: headerItem.width
            });
        }
    });

    return boundaries;
}

function isDataRow(row) {
    const rowText = row.items.map(item => item.text).join(' ');
    return rowText.trim().length > 0 &&
           !rowText.includes('Provincia:') &&
           !rowText.includes('Total por provincia:') &&
           !rowText.includes('Reporte de Hospedajes');
}

// DEBUG ENDPOINT - Shows raw table structure
app.get('/api/debug-tables', async (req, res) => {
    try {
        let tablesData = [];

        for (const pdfUrl of PDF_URLS) {
            try {
                const response = await axios.get(pdfUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000
                });

                if (response.status === 200) {
                    tablesData = await parsePDFTables(response.data);
                    break;
                }
            } catch (error) {
                console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
            }
        }

        // Format for HTML display
        const htmlResponse = `
<!DOCTYPE html>
<html>
<head>
    <title>PDF Table Structure Analysis</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { background: white; padding: 20px; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .table { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 5px; }
        .table-header { background: #e8f4fd; padding: 10px; margin: -15px -15px 15px -15px; border-radius: 5px 5px 0 0; }
        .row { margin: 5px 0; padding: 5px; border-bottom: 1px solid #eee; }
        .row:hover { background: #f9f9f9; }
        .item { display: inline-block; margin: 0 10px; padding: 2px 5px; background: #f0f0f0; border-radius: 3px; }
        .coordinates { color: #666; font-size: 0.8em; }
        .header-row { background: #d4edda; font-weight: bold; }
        .stats { background: #fff3cd; padding: 10px; border-radius: 5px; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>PDF Table Structure Analysis</h1>
        <div class="stats">
            <strong>Total Tables Found:</strong> ${tablesData.length}<br>
            <strong>Total Data Rows:</strong> ${tablesData.reduce((sum, table) => sum + table.dataRows.length, 0)}<br>
            <strong>PDF Status:</strong> ${PDF_STATUS}
        </div>

        ${tablesData.map((table, tableIndex) => `
            <div class="table">
                <div class="table-header">
                    <strong>Table ${tableIndex + 1}</strong> |
                    Page: ${table.page} |
                    Province: ${table.province || 'Unknown'} |
                    Data Rows: ${table.dataRows.length} |
                    Column Boundaries: ${table.columnBoundaries.map(c => `${c.name} (x:${c.x})`).join(', ')}
                </div>

                <!-- Header Row -->
                <div class="row header-row">
                    ${table.headers.items.map(item =>
                        `<span class="item">${item.text} <span class="coordinates">(x:${item.x}, y:${item.y})</span></span>`
                    ).join('')}
                </div>

                <!-- Data Rows (show first 10) -->
                ${table.dataRows.slice(0, 10).map((row, rowIndex) => `
                    <div class="row">
                        <strong>Row ${rowIndex + 1}:</strong>
                        ${row.items.map(item =>
                            `<span class="item">${item.text} <span class="coordinates">(x:${item.x})</span></span>`
                        ).join('')}
                    </div>
                `).join('')}

                ${table.dataRows.length > 10 ? `<div><em>... and ${table.dataRows.length - 10} more rows</em></div>` : ''}
            </div>
        `).join('')}

        ${tablesData.length === 0 ? '<div style="color: red; padding: 20px; text-align: center;">No tables detected in PDF</div>' : ''}
    </div>
</body>
</html>
        `;

        res.send(htmlResponse);
    } catch (error) {
        console.error('Error in /api/debug-tables:', error);
        res.status(500).send('Error analyzing PDF tables');
    }
});

// Keep your existing API routes but they'll return empty for now
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals Table Analysis API is working!',
        status: 'success',
        timestamp: new Date().toISOString(),
        tables_analyzed: CURRENT_RENTALS.length,
        pdf_status: PDF_STATUS
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        pdf_status: PDF_STATUS,
        note: 'Table analysis mode - use /api/debug-tables to see PDF structure'
    });
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Table Analysis API running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Table debug: http://localhost:${PORT}/api/debug-tables`);

    // Load PDF data on startup
    setTimeout(async () => {
        try {
            await fetchAndParsePDF();
            console.log('✅ PDF table analysis complete');
        } catch (error) {
            console.error('Error during startup:', error);
        }
    }, 2000);
});
