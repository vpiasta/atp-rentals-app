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

// SUPER SIMPLE: Just show raw PDF content as text
app.get('/debug-pdf-raw', async (req, res) => {
    try {
        let pdfBuffer = null;

        console.log('Fetching PDF for raw analysis...');
        for (const pdfUrl of PDF_URLS) {
            try {
                const response = await axios.get(pdfUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000
                });

                if (response.status === 200) {
                    pdfBuffer = response.data;
                    console.log('PDF fetched successfully');
                    break;
                }
            } catch (error) {
                console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
            }
        }

        if (!pdfBuffer) {
            return res.status(500).send('Could not fetch PDF');
        }

        // Convert to string but keep ALL characters
        const rawText = pdfBuffer.toString('latin1'); // Use latin1 to preserve all bytes

        // Create simple HTML page
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>PDF Raw Content</title>
    <style>
        body { font-family: monospace; margin: 20px; background: #f0f0f0; }
        .container { background: white; padding: 20px; border-radius: 5px; }
        .raw-content {
            background: #000;
            color: #0f0;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            font-size: 10px;
            line-height: 1.2;
            max-height: 80vh;
            overflow-y: auto;
        }
        .info { background: #e3f2fd; padding: 10px; margin: 10px 0; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📄 PDF Raw Content Viewer</h1>

        <div class="info">
            <strong>PDF Size:</strong> ${pdfBuffer.length} bytes<br>
            <strong>Note:</strong> This shows the actual raw PDF content. Look for patterns like:<br>
            - Column headers: "Nombre", "Modalidad", etc.<br>
            - Text positioning commands<br>
            - Table structures and delimiters<br>
        </div>

        <div class="raw-content">
${escapeHtml(rawText.substring(0, 50000))}
        </div>

        <div style="margin-top: 20px; color: #666;">
            <em>Showing first 50,000 characters of ${rawText.length} total</em>
        </div>
    </div>
</body>
</html>`;

        res.send(html);

    } catch (error) {
        console.error('Error in raw debug endpoint:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// HTML escaping
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ... [keep all your existing API routes exactly as they were working] ...

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Raw Debug URL: http://localhost:${PORT}/debug-pdf-raw`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
