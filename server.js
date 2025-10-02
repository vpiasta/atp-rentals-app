const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();
const PORT = process.env.PPORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PDF_URLS = [
    'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf'
];

let CURRENT_RENTALS = [];
let LAST_PDF_UPDATE = null;
let PDF_STATUS = 'No PDF processed yet';
let LAST_ERROR = null;
let PDF_RAW_CONTENT = '';

async function fetchAndParsePDF() {
    for (const pdfUrl of PDF_URLS) {
        try {
            console.log(`Fetching PDF from: ${pdfUrl}`);
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                console.log('PDF fetched, parsing...');
                const data = await pdf(response.data);
                PDF_RAW_CONTENT = data.text;
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();
                LAST_ERROR = null;

                console.log('PDF text length:', PDF_RAW_CONTENT.length);
                console.log('First 1000 chars:', PDF_RAW_CONTENT.substring(0, 1000));

                // Run diagnostics first
                const diagnostics = runPDFDiagnostics(PDF_RAW_CONTENT);
                console.log('Diagnostics:', diagnostics);

                // Then try to extract rentals
                const parsedRentals = extractAllRentals(PDF_RAW_CONTENT);
                console.log(`Extracted ${parsedRentals.length} rentals from PDF`);

                if (parsedRentals.length === 0) {
                    LAST_ERROR = `PDF parsing found 0 rentals. Diagnostics: ${JSON.stringify(diagnostics)}`;
                    PDF_STATUS = 'ERROR: No rentals found in PDF';
                }

                CURRENT_RENTALS = parsedRentals;
                return parsedRentals.length > 0;
            }
        } catch (error) {
            const errorMsg = `Failed to fetch PDF: ${error.message}`;
            console.log(errorMsg);
            LAST_ERROR = errorMsg;
            PDF_STATUS = 'ERROR: Failed to fetch PDF';
        }
    }

    PDF_STATUS = 'ERROR: No PDF available or accessible';
    CURRENT_RENTALS = [];
    return false;
}

// DIAGNOSTIC FUNCTION - Shows exactly what's in the PDF
function runPDFDiagnostics(text) {
    console.log('=== RUNNING PDF DIAGNOSTICS ===');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const diagnostics = {
        total_lines: lines.length,
        lines_sample: lines.slice(0, 50), // First 50 lines
        has_province_headers: false,
        provinces_found: [],
        potential_rental_lines: [],
        email_lines: [],
        phone_lines: [],
        structure_analysis: {}
    };

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    // Analyze each line
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for province headers
        const provinceMatch = provinces.find(p => line.includes(p));
        if (provinceMatch && line.includes('Provincia:')) {
            diagnostics.has_province_headers = true;
            diagnostics.provinces_found.push({
                province: provinceMatch,
                line_number: i,
                full_line: line
            });
        }

        // Check for potential rental names (long text without @ or numbers)
        if (line.length > 10 && !line.includes('@') && !line.match(/\d{3,4}[- ]?\d{3,4}/)) {
            diagnostics.potential_rental_lines.push({
                line_number: i,
                content: line
            });
        }

        // Check for email lines
        if (line.includes('@')) {
            diagnostics.email_lines.push({
                line_number: i,
                content: line
            });
        }

        // Check for phone lines
        if (line.match(/\d{3,4}[- ]?\d{3,4}/)) {
            diagnostics.phone_lines.push({
                line_number: i,
                content: line
            });
        }
    }

    // Structure analysis
    diagnostics.structure_analysis = {
        likely_table_structure: diagnostics.potential_rental_lines.length > 0 &&
                               diagnostics.email_lines.length > 0 &&
                               diagnostics.phone_lines.length > 0,
        rental_to_email_ratio: diagnostics.potential_rental_lines.length / Math.max(1, diagnostics.email_lines.length),
        rental_to_phone_ratio: diagnostics.potential_rental_lines.length / Math.max(1, diagnostics.phone_lines.length),
        estimated_total_rentals: Math.min(
            diagnostics.potential_rental_lines.length,
            diagnostics.email_lines.length,
            diagnostics.phone_lines.length
        )
    };

    console.log('Diagnostics completed');
    return diagnostics;
}

// SIMPLE EXTRACTION - Focus on what we can clearly identify
function extractAllRentals(text) {
    console.log('=== SIMPLE EXTRACTION ===');
    const rentals = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    let currentProvince = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (line.includes('Reporte de Hospedajes vigentes') ||
            line.includes('Reporte: rep_hos_web') ||
            line.includes('Actualizado al') ||
            line.match(/Página \d+ de \d+/)) {
            continue;
        }

        // Detect province
        const provinceMatch = provinces.find(p => line.includes(p));
        if (provinceMatch) {
            currentProvince = provinceMatch;
            console.log(`Found province: ${currentProvince}`);
            continue;
        }

        // Simple extraction: if line looks like a rental name and we have a province
        if (currentProvince && isLikelyRentalName(line)) {
            const rental = extractRentalSimple(lines, i, currentProvince);
            if (rental) {
                rentals.push(rental);
                console.log(`Found rental: ${rental.name}`);
            }
        }
    }

    return rentals;
}

function isLikelyRentalName(line) {
    // Basic heuristics for rental names
    return line.length > 5 &&
           !line.includes('@') &&
           !line.match(/\d{3,4}[- ]?\d{3,4}/) &&
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:') &&
           !line.includes('Nombre') &&
           !line.includes('Modalidad') &&
           !line.includes('Correo Principal') &&
           !line.includes('Teléfono');
}

function extractRentalSimple(lines, startIndex, province) {
    const nameLine = lines[startIndex];
    const name = cleanText(nameLine);

    if (!name || name.length < 3) return null;

    let type = 'Hospedaje';
    let email = '';
    let phone = '';

    // Look ahead a few lines for type, email, phone
    for (let i = startIndex + 1; i < Math.min(startIndex + 10, lines.length); i++) {
        const line = lines[i];

        if (isRentalType(line)) {
            type = line;
        } else if (line.includes('@')) {
            email = extractEmail(line);
        } else if (line.match(/\d{3,4}[- ]?\d{3,4}/)) {
            phone = extractPhone(line);
        }

        // Stop if we find another rental name
        if (isLikelyRentalName(line) && i > startIndex + 2) {
            break;
        }
    }

    return {
        name: name,
        type: type,
        email: email,
        phone: phone,
        province: province,
        district: guessDistrict(name, province),
        description: `${type} "${name}" registrado en ${province}, Panamá.`,
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(name + ' ' + province + ' Panamá')}`,
        whatsapp: phone,
        source: 'ATP_OFFICIAL'
    };
}

// Helper functions (same as before)
function isRentalType(line) {
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge'];
    return types.some(type => line.includes(type));
}

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractPhone(text) {
    const match = text.match(/(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/);
    return match ? match[1] : '';
}

function cleanText(text) {
    return text.replace(/\s+/g, ' ').trim();
}

function guessDistrict(name, province) {
    const districtMap = {
        'BOCAS DEL TORO': 'Bocas del Toro',
        'CHIRIQUÍ': 'David',
        'COCLÉ': 'Penonomé',
        'COLÓN': 'Colón',
        'DARIÉN': 'La Palma',
        'HERRERA': 'Chitré',
        'LOS SANTOS': 'Las Tablas',
        'PANAMÁ': 'Ciudad de Panamá',
        'VERAGUAS': 'Santiago'
    };
    return districtMap[province] || province;
}

// API Routes with enhanced diagnostics
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals Search API is working!',
        status: 'success',
        timestamp: new Date().toISOString(),
        data_source: 'LIVE_ATP_PDF',
        total_rentals: CURRENT_RENTALS.length,
        has_data: CURRENT_RENTALS.length > 0,
        last_error: LAST_ERROR
    });
});

app.get('/api/rentals', (req, res) => {
    if (CURRENT_RENTALS.length === 0) {
        return res.status(503).json({
            error: 'No rental data available',
            message: LAST_ERROR || 'The PDF parsing failed.',
            suggestion: 'Check /api/diagnostics for detailed analysis'
        });
    }

    const { search, province, type } = req.query;
    let filtered = CURRENT_RENTALS;

    if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            rental.district.toLowerCase().includes(searchLower) ||
            rental.province.toLowerCase().includes(searchLower) ||
            rental.type.toLowerCase().includes(searchLower)
        );
    }

    if (province && province !== '') {
        filtered = filtered.filter(rental =>
            rental.province.toLowerCase() === province.toLowerCase()
        );
    }

    if (type && type !== '') {
        filtered = filtered.filter(rental =>
            rental.type.toLowerCase() === type.toLowerCase()
        );
    }

    res.json(filtered);
});

// NEW: Comprehensive diagnostics endpoint
app.get('/api/diagnostics', (req, res) => {
    const diagnostics = runPDFDiagnostics(PDF_RAW_CONTENT || '');

    res.json({
        pdf_status: PDF_STATUS,
        total_rentals_found: CURRENT_RENTALS.length,
        last_update: LAST_PDF_UPDATE,
        last_error: LAST_ERROR,
        has_data: CURRENT_RENTALS.length > 0,

        // Raw content sample (first 2000 chars)
        pdf_sample: PDF_RAW_CONTENT ? PDF_RAW_CONTENT.substring(0, 2000) : 'No PDF content',
        pdf_total_length: PDF_RAW_CONTENT ? PDF_RAW_CONTENT.length : 0,

        // Diagnostic results
        diagnostics: diagnostics,

        // Current rentals sample
        current_rentals_sample: CURRENT_RENTALS.slice(0, 10),

        // Recommendations
        recommendations: generateRecommendations(diagnostics, CURRENT_RENTALS.length)
    });
});

function generateRecommendations(diagnostics, rentalCount) {
    const recommendations = [];

    if (rentalCount === 0) {
        if (diagnostics.provinces_found.length === 0) {
            recommendations.push("No provinces detected. The PDF format may be completely different than expected.");
        }
        if (diagnostics.potential_rental_lines.length === 0) {
            recommendations.push("No potential rental names found. The data might be in a different format.");
        }
        if (diagnostics.email_lines.length > 0 && diagnostics.potential_rental_lines.length > 0) {
            recommendations.push("Emails and potential rentals found but not linked. Need better parsing logic.");
        }
    }

    if (diagnostics.provinces_found.length > 0) {
        recommendations.push(`Found ${diagnostics.provinces_found.length} provinces: ${diagnostics.provinces_found.map(p => p.province).join(', ')}`);
    }

    if (diagnostics.potential_rental_lines.length > 0) {
        recommendations.push(`Found ${diagnostics.potential_rental_lines.length} potential rental names`);
    }

    return recommendations;
}

// Other API endpoints remain the same...
app.get('/api/provinces', (req, res) => {
    if (CURRENT_RENTALS.length === 0) return res.json([]);
    const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province))].sort();
    res.json(provinces);
});

app.get('/api/types', (req, res) => {
    if (CURRENT_RENTALS.length === 0) return res.json([]);
    const types = [...new Set(CURRENT_RENTALS.map(r => r.type))].sort();
    res.json(types);
});

app.get('/api/stats', (req, res) => {
    res.json({
        total_rentals: CURRENT_RENTALS.length,
        last_updated: LAST_PDF_UPDATE,
        status: PDF_STATUS,
        last_error: LAST_ERROR,
        has_data: CURRENT_RENTALS.length > 0,
        note: 'Check /api/diagnostics for detailed analysis'
    });
});

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            message: success ?
                `PDF data refreshed. Found ${CURRENT_RENTALS.length} rentals.` :
                `Failed: ${LAST_ERROR}`,
            total_rentals: CURRENT_RENTALS.length,
            status: PDF_STATUS,
            last_error: LAST_ERROR
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    setTimeout(async () => {
        console.log('Loading PDF data...');
        await fetchAndParsePDF();
        console.log(`Startup complete. Rentals: ${CURRENT_RENTALS.length}`);
    }, 2000);
});
