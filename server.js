const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
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

// NEW: PDF parsing with pdfjs-dist (positional data)
async function fetchAndParsePDF() {
    for (const pdfUrl of PDF_URLS) {
        try {
            console.log(`Fetching PDF from: ${pdfUrl}`);
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200) {
                console.log('PDF fetched, parsing with pdfjs-dist...');
                const rentals = await parsePDFWithPositionalData(response.data);
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                console.log(`Parsed ${rentals.length} rentals from PDF`);
                CURRENT_RENTALS = rentals;
                return true;
            }
        } catch (error) {
            console.log(`Failed to fetch from ${pdfUrl}: ${error.message}`);
        }
    }

    PDF_STATUS = 'No PDF available';
    CURRENT_RENTALS = getFallbackData();
    return false;
}

// NEW: Parse PDF with positional data
async function parsePDFWithPositionalData(pdfBuffer) {
    try {
        const data = new Uint8Array(pdfBuffer);
        const pdf = await pdfjsLib.getDocument(data).promise;
        const numPages = pdf.numPages;
        const allRentals = [];
        let currentProvince = '';

        console.log(`Processing ${numPages} pages...`);

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            console.log(`Processing page ${pageNum}...`);
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();

            // Extract text with positioning
            const textItems = textContent.items.map(item => ({
                text: item.str,
                x: item.transform[4],
                y: item.transform[5],
                width: item.width,
                height: item.height,
                page: pageNum
            }));

            // Group by rows and process table structure
            const pageRentals = processPageItems(textItems, currentProvince);
            allRentals.push(...pageRentals);

            // Update current province for next page
            const provinceItem = textItems.find(item =>
                item.text.includes('Provincia:') && item.text.trim().length > 10
            );
            if (provinceItem) {
                currentProvince = provinceItem.text.replace('Provincia:', '').trim();
                console.log(`Found province: ${currentProvince}`);
            }
        }

        console.log(`Total rentals found: ${allRentals.length}`);
        return allRentals;
    } catch (error) {
        console.error('Error in parsePDFWithPositionalData:', error);
        return getFallbackData();
    }
}

// NEW: Process page items with positional grouping
function processPageItems(textItems, currentProvince) {
    // Group items into rows based on Y-coordinate (with tolerance)
    const rows = {};
    const Y_TOLERANCE = 2; // Points tolerance for same row

    textItems.forEach(item => {
        if (!item.text.trim()) return;

        // Find existing row key within tolerance
        const existingKey = Object.keys(rows).find(key =>
            Math.abs(parseFloat(key) - item.y) <= Y_TOLERANCE
        );

        const rowKey = existingKey || item.y.toString();
        if (!rows[rowKey]) rows[rowKey] = [];
        rows[rowKey].push(item);
    });

    // Sort rows from top to bottom (higher Y first in PDF coordinates)
    const sortedRowKeys = Object.keys(rows).sort((a, b) => parseFloat(b) - parseFloat(a));

    const rentals = [];
    let inRentalTable = false;
    let currentRental = null;

    sortedRowKeys.forEach(key => {
        const rowItems = rows[key].sort((a, b) => a.x - b.x); // Sort left to right
        const rowText = rowItems.map(item => item.text).join(' ').trim();

        // Skip header lines
        if (isHeaderLine(rowText) || rowText.includes('Reporte de Hospedajes')) {
            return;
        }

        // Detect province
        if (rowText.includes('Provincia:')) {
            currentProvince = rowText.replace('Provincia:', '').trim();
            console.log(`Processing province: ${currentProvince}`);
            return;
        }

        // Detect table start (column headers)
        if (rowText.includes('Nombre') && rowText.includes('Modalidad')) {
            inRentalTable = true;
            console.log('Entering rental table section');
            return;
        }

        // Detect table end
        if (rowText.includes('Total por provincia:')) {
            inRentalTable = false;
            // Save current rental if exists
            if (currentRental && currentRental.name) {
                rentals.push(createRentalObject(currentRental, currentProvince));
                currentRental = null;
            }
            console.log('Exiting rental table section');
            return;
        }

        if (inRentalTable && currentProvince) {
            // Check if this looks like a new rental property row
            const looksLikePropertyName = isPotentialPropertyName(rowText);
            const hasMultipleColumns = rowItems.length >= 2;

            if (looksLikePropertyName && hasMultipleColumns) {
                // Save previous rental if exists
                if (currentRental && currentRental.name) {
                    rentals.push(createRentalObject(currentRental, currentProvince));
                }

                // Start new rental
                currentRental = parseRentalRow(rowItems, currentProvince);
                console.log(`Found rental: ${currentRental.name}`);
            } else if (currentRental && !currentRental.type && isTypeLine(rowText)) {
                // This might be the type for the current rental (on next row)
                currentRental.type = rowText;
            } else if (currentRental && !currentRental.email && isEmailLine(rowText)) {
                currentRental.email = rowText;
            } else if (currentRental && !currentRental.phone && isPhoneLine(rowText)) {
                currentRental.phone = rowText;
            }
        }
    });

    // Don't forget the last rental
    if (currentRental && currentRental.name) {
        rentals.push(createRentalObject(currentRental, currentProvince));
    }

    return rentals;
}

// NEW: Parse rental row from positioned items
function parseRentalRow(rowItems, province) {
    const rental = { province };

    // Filter out obvious non-name items first
    const potentialNames = rowItems.filter(item =>
        item.text.trim().length > 2 &&
        !isTypeLine(item.text) &&
        !isEmailLine(item.text) &&
        !isPhoneLine(item.text) &&
        !isHeaderText(item.text) &&
        item.text !== 'Nombre' &&
        item.text !== 'Modalidad' &&
        item.text !== 'Correo Principal' &&
        item.text !== 'Cel/Teléfono' &&
        !item.text.match(/^\d+$/) && // Not just numbers
        !item.text.match(/^\d+-\d+$/) // Not phone-like patterns
    );

    // Use the first substantial text as name, or combine if multiple
    if (potentialNames.length > 0) {
        rental.name = potentialNames.map(item => item.text.trim()).join(' ');
    } else if (rowItems.length > 0) {
        // Fallback: use first item that's not a obvious field
        const fallbackName = rowItems.find(item =>
            item.text.trim().length > 2 &&
            !isTypeLine(item.text) &&
            !isEmailLine(item.text)
        );
        if (fallbackName) {
            rental.name = fallbackName.text.trim();
        }
    }

    // Look for type in the same row (more strict matching)
    const typeItem = rowItems.find(item => isTypeLine(item.text));
    if (typeItem) {
        rental.type = typeItem.text.trim();
    }

    // Look for email in the same row
    const emailItem = rowItems.find(item => isEmailLine(item.text));
    if (emailItem) {
        rental.email = emailItem.text.trim();
    }

    // Look for phone in the same row (more strict matching)
    const phoneItem = rowItems.find(item => isPhoneLine(item.text) && item.text.length >= 7);
    if (phoneItem) {
        rental.phone = phoneItem.text.trim();
    }

    return rental;
}

// Add this helper function
function isHeaderText(text) {
    const headers = ['Nombre', 'Modalidad', 'Correo Principal', 'Cel/Teléfono', 'Teléfono', 'Provincia:', 'Total por provincia:'];
    return headers.includes(text.trim());
}

// NEW: Create rental object from parsed data
function createRentalObject(rentalData, province) {
    return {
        name: cleanText(rentalData.name),
        type: cleanText(rentalData.type) || 'Hospedaje',
        email: extractEmail(rentalData.email || ''),
        phone: extractFirstPhone(rentalData.phone || ''),
        province: province,
        district: guessDistrict(rentalData.name, province),
        description: generateDescription(rentalData.name, rentalData.type, province),
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(rentalData.name + ' ' + province + ' Panamá')}`,
        whatsapp: extractFirstPhone(rentalData.phone || ''),
        source: 'ATP_OFFICIAL'
    };
}

// KEEP ALL EXISTING HELPER FUNCTIONS (unchanged)
function isHeaderLine(line) {
    return line.includes('Reporte de Hospedajes vigentes') ||
           line.includes('Reporte: rep_hos_web') ||
           line.includes('Actualizado al') ||
           line.match(/Página \d+ de \d+/);
}

function isPotentialPropertyName(line) {
    return line && line.length > 3 &&
           !line.includes('@') &&
           !isPhoneLine(line) &&
           !isTypeLine(line) &&
           line !== 'Nombre' &&
           line !== 'Modalidad' &&
           line !== 'Correo Principal' &&
           line !== 'Cel/Teléfono' &&
           line !== 'Teléfono';
}

function isTypeLine(line) {
    if (!line) return false;
    const types = ['Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel', 'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña'];
    return types.some(type => line.includes(type));
}

function isEmailLine(line) {
    return line && line.includes('@');
}

function isPhoneLine(line) {
    return line && line.match(/\d{7,8}/);
}

function extractEmail(text) {
    if (!text) return '';
    try {
        const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        return match ? match[1] : '';
    } catch (error) {
        return '';
    }
}

function extractFirstPhone(text) {
    if (!text) return '';
    try {
        // Remove slashes and hyphens, take first 8 digits
        const cleanText = text.replace(/[-\/\s]/g, '');
        const match = cleanText.match(/(\d{7,8})/);
        return match ? match[1] : '';
    } catch (error) {
        return '';
    }
}

function cleanText(text) {
    if (!text) return '';
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
        'PANAMÁ OESTE': 'La Chorrera',
        'VERAGUAS': 'Santiago',
        'GUNAS': 'Guna Yala',
        'EMBERÁ': 'Emberá',
        'NGÄBE-BUGLÉ': 'Ngäbe-Buglé'
    };
    return districtMap[province] || province;
}

function generateDescription(name, type, province) {
    return `${type} "${name}" ubicado en ${province}, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).`;
}

function getFallbackData() {
    return [
        {
            name: "APARTHOTEL BOQUETE",
            type: "Aparta-Hotel",
            email: "info@aparthotel-boquete.com",
            phone: "68916669 / 68916660",
            province: "CHIRIQUÍ",
            district: "Boquete",
            description: "Aparta-Hotel \"APARTHOTEL BOQUETE\" ubicado en CHIRIQUÍ, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).",
            google_maps_url: "https://maps.google.com/?q=APARTHOTEL%20BOQUETE%20BOQUETE%20Panam%C3%A1",
            whatsapp: "50768916669",
            source: "ATP_OFFICIAL"
        }
    ];
}

// KEEP ALL EXISTING API ROUTES (unchanged)
app.get('/api/test', (req, res) => {
    try {
        res.json({
            message: 'ATP Rentals Search API is working!',
            status: 'success',
            timestamp: new Date().toISOString(),
            data_source: 'LIVE_ATP_PDF',
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0
        });
    } catch (error) {
        console.error('Error in /api/test:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/rentals', (req, res) => {
    try {
        const { search, province, type } = req.query;
        let filtered = CURRENT_RENTALS || [];

        if (search) {
            const searchLower = search.toLowerCase();
            filtered = filtered.filter(rental =>
                rental && rental.name && rental.name.toLowerCase().includes(searchLower) ||
                (rental.district && rental.district.toLowerCase().includes(searchLower)) ||
                (rental.description && rental.description.toLowerCase().includes(searchLower)) ||
                (rental.province && rental.province.toLowerCase().includes(searchLower)) ||
                (rental.type && rental.type.toLowerCase().includes(searchLower))
            );
        }

        if (province && province !== '') {
            filtered = filtered.filter(rental =>
                rental && rental.province && rental.province.toLowerCase() === province.toLowerCase()
            );
        }

        if (type && type !== '') {
            filtered = filtered.filter(rental =>
                rental && rental.type && rental.type.toLowerCase() === type.toLowerCase()
            );
        }

        res.json(filtered);
    } catch (error) {
        console.error('Error in /api/rentals:', error);
        res.status(500).json({ error: 'Error al buscar hospedajes' });
    }
});

app.get('/api/provinces', (req, res) => {
    try {
        const provinces = CURRENT_RENTALS ?
            [...new Set(CURRENT_RENTALS.map(r => r?.province).filter(Boolean))].sort() : [];
        res.json(provinces);
    } catch (error) {
        console.error('Error in /api/provinces:', error);
        res.status(500).json({ error: 'Error cargando provincias' });
    }
});

app.get('/api/types', (req, res) => {
    try {
        const types = CURRENT_RENTALS ?
            [...new Set(CURRENT_RENTALS.map(r => r?.type).filter(Boolean))].sort() : [];
        res.json(types);
    } catch (error) {
        console.error('Error in /api/types:', error);
        res.status(500).json({ error: 'Error cargando tipos' });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        res.json({
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            last_updated: LAST_PDF_UPDATE || new Date().toISOString(),
            data_source: 'LIVE_ATP_DATA',
            status: PDF_STATUS,
            note: 'Datos oficiales de la Autoridad de Turismo de Panamá'
        });
    } catch (error) {
        console.error('Error in /api/stats:', error);
        res.status(500).json({ error: 'Error cargando estadísticas' });
    }
});

app.get('/api/debug-pdf', (req, res) => {
    try {
        const sampleWithContacts = CURRENT_RENTALS ?
            CURRENT_RENTALS.filter(rental => rental && (rental.email || rental.phone)).slice(0, 10) : [];

        res.json({
            pdf_status: PDF_STATUS,
            total_rentals_found: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            last_update: LAST_PDF_UPDATE,
            sample_with_contacts: sampleWithContacts,
            all_provinces: CURRENT_RENTALS ?
                [...new Set(CURRENT_RENTALS.map(r => r?.province).filter(Boolean))] : [],
            all_types: CURRENT_RENTALS ?
                [...new Set(CURRENT_RENTALS.map(r => r?.type).filter(Boolean))] : []
        });
    } catch (error) {
        console.error('Error in /api/debug-pdf:', error);
        res.status(500).json({ error: 'Error en debug' });
    }
});

app.post('/api/refresh-pdf', async (req, res) => {
    try {
        const success = await fetchAndParsePDF();
        res.json({
            success: success,
            message: success ? 'PDF data refreshed successfully' : 'Failed to refresh PDF data',
            total_rentals: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
            status: PDF_STATUS,
            last_update: LAST_PDF_UPDATE
        });
    } catch (error) {
        console.error('Error in /api/refresh-pdf:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        rentals_loaded: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
        pdf_status: PDF_STATUS
    });
});

// NEW: Improved server startup with error handling
const SERVER_PORT = process.env.PORT || 3000;

app.listen(SERVER_PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${SERVER_PORT}`);
    console.log(`📍 Health check: http://localhost:${SERVER_PORT}/health`);

    try {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    } catch (error) {
        console.error('Error during startup:', error);
        CURRENT_RENTALS = getFallbackData();
        console.log('✅ Using fallback data');
    }
}).on('error', (err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
});
