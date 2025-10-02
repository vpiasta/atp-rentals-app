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

// ... [keep all your existing working functions] ...

// NEW: Shows decoded text but preserves ALL formatting characters
app.get('/debug-pdf-formatted', async (req, res) => {
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
                    // Get raw lines without trimming to preserve spaces
                    rawLines = data.text.split('\n');
                    break;
                }
            } catch (error) {
                console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
            }
        }

        if (!pdfText) {
            return res.status(500).send('Could not fetch PDF');
        }

        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>PDF Formatted Text with Visual Structure</title>
    <style>
        body { font-family: 'Courier New', monospace; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
        .line { margin: 1px 0; white-space: pre; }
        .line-number {
            color: #666;
            display: inline-block;
            width: 60px;
            text-align: right;
            margin-right: 10px;
            background: #f8f9fa;
            padding: 2px 5px;
        }
        .highlight-space { background-color: #e3f2fd; color: #1565c0; }
        .highlight-pipe { background-color: #ffebee; color: #c62828; font-weight: bold; }
        .highlight-dash { background-color: #fff3e0; color: #ef6c00; }
        .highlight-column { background-color: #e8f5e8; padding: 1px 3px; border-radius: 2px; }
        .section { margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 5px; }
        .controls { margin: 15px 0; padding: 10px; background: #e8f4fd; border-radius: 5px; }
        button { margin: 5px; padding: 5px 10px; border: 1px solid #ccc; background: white; cursor: pointer; }
        button:hover { background: #f0f0f0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📋 PDF Text with Visual Structure</h1>

        <div class="section">
            <h3>🔍 What to look for:</h3>
            <ul>
                <li><strong>Spaces</strong> <span class="highlight-space">[shown in blue]</span> - indicate column separation</li>
                <li><strong>Pipes "|"</strong> <span class="highlight-pipe">[shown in red]</span> - column delimiters</li>
                <li><strong>Dashes "-"</strong> <span class="highlight-dash">[shown in orange]</span> - table lines</li>
                <li><strong>Column patterns</strong> - look for aligned text</li>
            </ul>
        </div>

        <div class="controls">
            <button onclick="toggleSpaces()">Toggle Spaces</button>
            <button onclick="togglePipes()">Toggle Pipes</button>
            <button onclick="toggleDashes()">Toggle Dashes</button>
            <button onclick="findColumnHeaders()">Find Column Headers</button>
        </div>

        <div id="content">
            ${formatLinesWithStructure(rawLines)}
        </div>
    </div>

    <script>
        function toggleSpaces() {
            const spaces = document.querySelectorAll('.highlight-space');
            spaces.forEach(el => {
                el.style.display = el.style.display === 'none' ? 'inline' : 'none';
            });
        }

        function togglePipes() {
            const pipes = document.querySelectorAll('.highlight-pipe');
            pipes.forEach(el => {
                el.style.display = el.style.display === 'none' ? 'inline' : 'none';
            });
        }

        function toggleDashes() {
            const dashes = document.querySelectorAll('.highlight-dash');
            dashes.forEach(el => {
                el.style.display = el.style.display === 'none' ? 'inline' : 'none';
            });
        }

        function findColumnHeaders() {
            const content = document.getElementById('content');
            const text = content.textContent;

            // Look for common column header patterns
            const patterns = [
                'Nombre', 'Modalidad', 'Correo Principal', 'Teléfono',
                'NOMBRE', 'MODALIDAD', 'CORREO', 'TELÉFONO'
            ];

            let found = [];
            patterns.forEach(pattern => {
                if (text.includes(pattern)) {
                    found.push(pattern);
                }
            });

            alert('Found column headers: ' + (found.length > 0 ? found.join(', ') : 'None'));
        }
    </script>
</body>
</html>`;

        res.send(html);

    } catch (error) {
        console.error('Error in formatted debug endpoint:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// Format lines to highlight structural elements
function formatLinesWithStructure(lines) {
    let html = '';

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (!line && line !== '') continue; // Keep empty lines that might be structural

        // Highlight structural characters but preserve the original text
        let formattedLine = '';
        for (let j = 0; j < line.length; j++) {
            const char = line[j];

            if (char === ' ') {
                formattedLine += `<span class="highlight-space" title="Space - column separator">&middot;</span>`;
            } else if (char === '|') {
                formattedLine += `<span class="highlight-pipe" title="Pipe - column delimiter">|</span>`;
            } else if (char === '-' && isLineOfDashes(line)) {
                formattedLine += `<span class="highlight-dash" title="Table line">-</span>`;
            } else if (char === '+' || char === '=') {
                formattedLine += `<span class="highlight-dash" title="Table border">${char}</span>`;
            } else {
                formattedLine += escapeHtml(char);
            }
        }

        // Highlight potential column headers
        if (isColumnHeader(line)) {
            formattedLine = `<span class="highlight-column">${formattedLine}</span>`;
        }

        html += `<div class="line"><span class="line-number">${i}</span>${formattedLine}</div>`;
    }

    return html;
}

// Check if a line is mostly dashes (indicating a table line)
function isLineOfDashes(line) {
    const dashCount = (line.match(/-/g) || []).length;
    return dashCount > 10 && dashCount / line.length > 0.7;
}

// Check if a line contains column headers
function isColumnHeader(line) {
    const headers = ['Nombre', 'Modalidad', 'Correo Principal', 'Teléfono', 'NOMBRE', 'MODALIDAD'];
    return headers.some(header => line.includes(header));
}

// HTML escaping
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
    console.log(`📍 Formatted Debug URL: http://localhost:${PORT}/debug-pdf-formatted`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
