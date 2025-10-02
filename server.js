const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
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

// NEW: Debug endpoint to show raw PDF text in HTML
app.get('/debug-pdf-text', async (req, res) => {
    try {
        let pdfText = '';
        let rawLines = [];

        // Fetch PDF
        for (const pdfUrl of PDF_URLS) {
            try {
                const response = await axios.get(pdfUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000
                });

                if (response.status === 200) {
                    const data = await pdf(response.data);
                    pdfText = data.text;
                    rawLines = data.text.split('\n').map(line => line.trim());
                    break;
                }
            } catch (error) {
                console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
            }
        }

        if (!pdfText) {
            return res.status(500).send('Could not fetch PDF');
        }

        // Create HTML page with the raw text
        const html = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Debug - PDF Raw Text</title>
    <style>
        body {
            font-family: 'Courier New', monospace;
            margin: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            border-bottom: 2px solid #333;
            padding-bottom: 10px;
        }
        .stats {
            background: #e8f4fd;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
            border-left: 4px solid #2196F3;
        }
        .line-number {
            color: #666;
            display: inline-block;
            width: 60px;
            text-align: right;
            margin-right: 10px;
            user-select: none;
        }
        .line-content {
            font-family: 'Courier New', monospace;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .province-header {
            background-color: #4CAF50;
            color: white;
            padding: 5px 10px;
            margin: 10px 0;
            border-radius: 3px;
            font-weight: bold;
        }
        .column-name { color: #2196F3; font-weight: bold; }
        .column-type { color: #FF9800; font-weight: bold; }
        .column-email { color: #9C27B0; font-weight: bold; }
        .column-phone { color: #F44336; font-weight: bold; }
        .section-divider {
            border-top: 2px dashed #ccc;
            margin: 20px 0;
            padding-top: 10px;
        }
        .highlight {
            background-color: #fff9c4;
            padding: 2px 4px;
            border-radius: 2px;
        }
        .controls {
            margin-bottom: 20px;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 5px;
        }
        button {
            background: #2196F3;
            color: white;
            border: none;
            padding: 8px 15px;
            border-radius: 4px;
            cursor: pointer;
            margin-right: 10px;
        }
        button:hover {
            background: #1976D2;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 PDF Raw Text Debug View</h1>

        <div class="stats">
            <strong>Total lines:</strong> ${rawLines.length} |
            <strong>PDF Status:</strong> ${PDF_STATUS} |
            <strong>Last Update:</strong> ${LAST_PDF_UPDATE || 'Never'}
        </div>

        <div class="controls">
            <button onclick="toggleLineNumbers()">Toggle Line Numbers</button>
            <button onclick="toggleHighlighting()">Toggle Highlighting</button>
            <button onclick="scrollToSection('BOCAS DEL TORO')">Jump to Bocas del Toro</button>
            <button onclick="scrollToSection('CHIRIQUÍ')">Jump to Chiriquí</button>
            <button onclick="scrollToSection('PANAMÁ')">Jump to Panamá</button>
        </div>

        <div id="content">
            ${generateFormattedContent(rawLines)}
        </div>
    </div>

    <script>
        function toggleLineNumbers() {
            const lineNumbers = document.querySelectorAll('.line-number');
            lineNumbers.forEach(el => {
                el.style.display = el.style.display === 'none' ? 'inline-block' : 'none';
            });
        }

        function toggleHighlighting() {
            const content = document.getElementById('content');
            content.classList.toggle('no-highlight');
        }

        function scrollToSection(province) {
            const headers = document.querySelectorAll('.province-header');
            for (let header of headers) {
                if (header.textContent.includes(province)) {
                    header.scrollIntoView({ behavior: 'smooth' });
                    break;
                }
            }
        }

        // Auto-highlight based on content type
        function highlightLine(line) {
            if (line.includes('@') && (line.includes('.com') || line.includes('.net'))) {
                return '<span class="column-email">' + line + '</span>';
            }
            if (line.match(/\\d{3,4}[- ]?\\d{3,4}[- ]?\\d{3,4}/) || line.match(/\\d{7,8}/)) {
                return '<span class="column-phone">' + line + '</span>';
            }
            if (line.match(/(Albergue|Aparta-Hotel|Bungalow|Hostal|Hotel|Posada|Resort|Ecolodge|Hospedaje|Cabaña)/i)) {
                return '<span class="column-type">' + line + '</span>';
            }
            if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
                return '<span class="column-name">' + line + '</span>';
            }
            return line;
        }

        // Apply highlighting on page load
        document.addEventListener('DOMContentLoaded', function() {
            const lines = document.querySelectorAll('.line-content');
            lines.forEach(lineEl => {
                const original = lineEl.innerHTML;
                lineEl.innerHTML = highlightLine(original);
            });
        });
    </script>
</body>
</html>
        `;

        res.send(html);

    } catch (error) {
        console.error('Error in debug endpoint:', error);
        res.status(500).send('Error generating debug view: ' + error.message);
    }
});

// Helper function to generate formatted content
function generateFormattedContent(rawLines) {
    let html = '';
    const provinces = ['BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN', 'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS'];

    let inProvinceSection = false;
    let currentProvince = '';
    let lineCount = 0;

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (!line) continue;

        // Check for province headers
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch) {
            if (currentProvince) {
                html += `<div class="section-divider"></div>`;
            }
            currentProvince = provinceMatch;
            html += `<div class="province-header" id="province-${currentProvince.replace(/\s+/g, '-')}">`;
            html += `📍 ${currentProvince} (starts at line ${i})`;
            html += `</div>`;
            inProvinceSection = true;
        }

        // Check for end of province section
        if (inProvinceSection && (line.includes('Total por provincia:') || line.includes('Total Provincial:'))) {
            html += `<div style="background: #ffebee; padding: 5px; margin: 5px 0; border-left: 4px solid #f44336;">`;
            html += `<strong>END OF ${currentProvince} SECTION</strong>`;
            html += `</div>`;
            inProvinceSection = false;
            currentProvince = '';
        }

        // Format the line
        html += `<div class="line">`;
        html += `<span class="line-number">${i}</span>`;
        html += `<span class="line-content">${escapeHtml(line)}</span>`;
        html += `</div>`;

        lineCount++;

        // Add visual separators for column headers
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
            html += `<div style="border-bottom: 1px solid #ddd; margin: 5px 0;"></div>`;
        }
    }

    return html;
}

// Helper to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ... [keep all your existing API routes and initialization] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Debug URL: http://localhost:${PORT}/debug-pdf-text`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
