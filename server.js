const express = require('express');
const axios = require('axios');
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

// ... [keep all your existing functions for the main app] ...

// NEW: Debug endpoint to show raw PDF structure with positioning
app.get('/debug-pdf-raw', async (req, res) => {
    try {
        let pdfBuffer = null;

        // Fetch PDF as raw buffer
        for (const pdfUrl of PDF_URLS) {
            try {
                const response = await axios.get(pdfUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000
                });

                if (response.status === 200) {
                    pdfBuffer = response.data;
                    break;
                }
            } catch (error) {
                console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
            }
        }

        if (!pdfBuffer) {
            return res.status(500).send('Could not fetch PDF');
        }

        // Convert buffer to hex and text for analysis
        const hexString = pdfBuffer.toString('hex');
        const textString = pdfBuffer.toString('binary');

        let html = `
<!DOCTYPE html>
<html>
<head>
    <title>PDF Raw Structure Analysis</title>
    <style>
        body { font-family: monospace; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1400px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
        .section { margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 5px; }
        .hex-view { background: #000; color: #0f0; padding: 15px; border-radius: 5px; overflow-x: auto; font-size: 12px; }
        .text-view { background: #fff; border: 1px solid #ddd; padding: 15px; border-radius: 5px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
        .analysis { background: #e8f4fd; padding: 15px; border-radius: 5px; }
        h2 { color: #333; border-bottom: 1px solid #ccc; padding-bottom: 10px; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 4px; margin: 10px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 PDF Raw Structure Analysis</h1>

        <div class="warning">
            <strong>Note:</strong> This shows the actual raw PDF data before any parsing.
            Look for patterns like column separators, table structures, and positioning commands.
        </div>

        <div class="section">
            <h2>📊 Basic PDF Info</h2>
            <div class="analysis">
                <strong>PDF Size:</strong> ${pdfBuffer.length} bytes<br>
                <strong>First 100 bytes (hex):</strong> ${hexString.substring(0, 200)}<br>
                <strong>PDF Header:</strong> ${textString.substring(0, 50)}<br>
            </div>
        </div>

        <div class="section">
            <h2>🔤 Extract Text Content with Positioning Hints</h2>
            <div class="text-view" id="textContent">
                ${extractTextWithPositioning(pdfBuffer)}
            </div>
        </div>

        <div class="section">
            <h2>📋 Search for Table/Column Patterns</h2>
            <div class="analysis">
                <h3>Common PDF Table Patterns to Look For:</h3>
                <ul>
                    <li><strong>Td/TD commands:</strong> Text positioning (look for sequences like "10 20 Td")</li>
                    <li><strong>Tj/TJ commands:</strong> Text showing (actual content display)</li>
                    <li><strong>BT/ET:</strong> Text block begin/end</li>
                    <li><strong>Tm:</strong> Text matrix transformations</li>
                    <li><strong>Re:</strong> Rectangle drawing (for table borders)</li>
                    <li><strong>Patterns like "Nombre"[space]"Modalidad":</strong> Column headers</li>
                </ul>
            </div>
        </div>

        <div class="section">
            <h2>🔍 Raw Text Snippets (First 5000 chars)</h2>
            <div class="text-view">
                ${escapeHtml(textString.substring(0, 5000))}
            </div>
        </div>

        <div class="section">
            <h2>⚡ Quick Analysis Results</h2>
            <div class="analysis" id="quickAnalysis">
                ${performQuickAnalysis(textString)}
            </div>
        </div>
    </div>

    <script>
        // Simple client-side search for patterns
        function searchPattern(pattern) {
            const content = document.getElementById('textContent');
            const text = content.textContent;
            const regex = new RegExp(pattern, 'gi');
            const matches = text.match(regex);
            alert('Found ' + (matches ? matches.length : 0) + ' matches for: ' + pattern);
        }
    </script>
</body>
</html>`;

        res.send(html);

    } catch (error) {
        console.error('Error in raw debug endpoint:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// Function to extract text with positioning hints
function extractTextWithPositioning(pdfBuffer) {
    try {
        const text = pdfBuffer.toString('binary');

        // Look for common PDF operators that indicate structure
        const patterns = [
            { name: 'Text Position (Td)', regex: /[\d\.-]+\s+[\d\.-]+\s+Td/g, color: '#ff6b6b' },
            { name: 'Show Text (Tj)', regex: /\([^)]*\)\s*Tj/g, color: '#4ecdc4' },
            { name: 'Text Block (BT/ET)', regex: /(BT|ET)/g, color: '#45b7d1' },
            { name: 'Text Matrix (Tm)', regex: /[\d\.-]+\s+[\d\.-]+\s+[\d\.-]+\s+[\d\.-]+\s+[\d\.-]+\s+[\d\.-]+\s+Tm/g, color: '#96ceb4' },
            { name: 'Rectangle (re)', regex: /[\d\.-]+\s+[\d\.-]+\s+[\d\.-]+\s+[\d\.-]+\s+re/g, color: '#feca57' }
        ];

        let highlightedText = escapeHtml(text.substring(0, 10000)); // First 10KB for performance

        patterns.forEach(pattern => {
            const matches = text.match(pattern.regex);
            if (matches) {
                matches.forEach(match => {
                    const escapedMatch = escapeHtml(match);
                    highlightedText = highlightedText.replace(
                        new RegExp(escapedMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
                        `<span style="background: ${pattern.color}; color: black; padding: 2px; margin: 1px; border-radius: 2px;" title="${pattern.name}">${escapedMatch}</span>`
                    );
                });
            }
        });

        return highlightedText;

    } catch (error) {
        return `Error analyzing PDF structure: ${error.message}`;
    }
}

// Function to perform quick analysis
function performQuickAnalysis(text) {
    const analysis = [];

    // Look for column headers
    const nombreCount = (text.match(/Nombre/g) || []).length;
    const modalidadCount = (text.match(/Modalidad/g) || []).length;
    const correoCount = (text.match(/Correo Principal/g) || []).length;
    const telefonoCount = (text.match(/Tel[ée]fono/g) || []).length;

    analysis.push(`<strong>Column Headers Found:</strong>`);
    analysis.push(`- "Nombre": ${nombreCount} occurrences`);
    analysis.push(`- "Modalidad": ${modalidadCount} occurrences`);
    analysis.push(`- "Correo Principal": ${correoCount} occurrences`);
    analysis.push(`- "Teléfono": ${telefonoCount} occurrences`);

    // Look for positioning commands
    const tdCount = (text.match(/\sTd\s/g) || []).length;
    const tjCount = (text.match(/\sTj\s/g) || []).length;
    const btCount = (text.match(/\sBT\s/g) || []).length;

    analysis.push(`<br><strong>PDF Positioning Commands:</strong>`);
    analysis.push(`- "Td" (position): ${tdCount} occurrences`);
    analysis.push(`- "Tj" (show text): ${tjCount} occurrences`);
    analysis.push(`- "BT" (begin text): ${btCount} occurrences`);

    // Look for potential table structures
    const reCount = (text.match(/\sre\s/g) || []).length;
    analysis.push(`- "re" (rectangle): ${reCount} occurrences (possible table borders)`);

    return analysis.join('<br>');
}

// HTML escaping function
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ... [keep all your existing API routes and initialization] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Raw Debug URL: http://localhost:${PORT}/debug-pdf-raw`);
    console.log(`📍 Text Debug URL: http://localhost:${PORT}/debug-pdf-text`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
