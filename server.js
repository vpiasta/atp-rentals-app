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
                PDF_STATUS = `PDF processed successfully from: ${pdfUrl}`;
                LAST_PDF_UPDATE = new Date().toISOString();

                const parsedRentals = parsePDFText(data.text);
                console.log(`Parsed ${parsedRentals.length} rentals from PDF`);

                CURRENT_RENTALS = parsedRentals;
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

// NEW: Column-based parser that uses the actual PDF structure
function parsePDFText(text) {
    console.log('=== PARSING ATP PDF DATA ===');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ', 'PANAMÁ OESTE'
    ];

    const rentals = [];
    let currentProvince = '';

    // Process each province section separately
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip headers
        if (isHeaderLine(line)) continue;

        // Detect province
        const provinceMatch = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (provinceMatch) {
            currentProvince = provinceMatch;

            // Find the end of this province section
            const sectionEnd = findSectionEnd(lines, i);
            const sectionLines = lines.slice(i, sectionEnd);

            // Parse this province section
            const provinceRentals = parseProvinceColumns(sectionLines, currentProvince);
            rentals.push(...provinceRentals);

            // Skip to end of section
            i = sectionEnd - 1;
        }
    }

    console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
    return rentals;
}

// NEW: Parse province by extracting the four vertical columns
function parseProvinceColumns(sectionLines, province) {
    const rentals = [];

    // Extract the four columns
    const columns = extractVerticalColumns(sectionLines);

    // Combine columns into records
    if (columns.names.length > 0) {
        const maxRecords = Math.max(
            columns.names.length,
            columns.types.length,
            columns.emails.length,
            columns.phones.length
        );

        for (let i = 0; i < maxRecords; i++) {
            const name = columns.names[i] || '';
            const type = columns.types[i] || '';
            const email = columns.emails[i] || '';
            const phone = columns.phones[i] || '';

            // Only create record if we have a valid name
            if (name && name.length > 2 && !isEmailLine(name) && !isPhoneLine(name)) {
                const rental = createRentalObject(name, type, email, phone, province);
                if (rental) {
                    rentals.push(rental);
                }
            }
        }
    }

    console.log(`Province ${province}: ${rentals.length} rentals (Names: ${columns.names.length}, Types: ${columns.types.length}, Emails: ${columns.emails.length}, Phones: ${columns.phones.length})`);
    return rentals;
}

// NEW: Extract vertical columns by finding column boundaries
function extractVerticalColumns(sectionLines) {
    const columns = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    // Find the starting index for each column
    const columnStarts = findColumnStarts(sectionLines);

    // Extract data for each column
    if (columnStarts.names !== -1) {
        columns.names = extractColumnData(sectionLines, columnStarts.names, 'name');
    }
    if (columnStarts.types !== -1) {
        columns.types = extractColumnData(sectionLines, columnStarts.types, 'type');
    }
    if (columnStarts.emails !== -1) {
        columns.emails = extractColumnData(sectionLines, columnStarts.emails, 'email');
    }
    if (columnStarts.phones !== -1) {
        columns.phones = extractColumnData(sectionLines, columnStarts.phones, 'phone');
    }

    return columns;
}

// NEW: Find where each column starts
function findColumnStarts(sectionLines) {
    const starts = { names: -1, types: -1, emails: -1, phones: -1 };

    for (let i = 0; i < sectionLines.length; i++) {
        const line = sectionLines[i];

        // Skip headers and metadata
        if (line.includes('Provincia:') || line.includes('Total por provincia:')) {
            continue;
        }

        // Look for column headers
        if (line === 'Nombre' || (starts.names === -1 && isNameLine(line))) {
            starts.names = i;
        } else if (line === 'Modalidad' || (starts.types === -1 && isTypeLine(line))) {
            starts.types = i;
        } else if (line === 'Correo Principal' || (starts.emails === -1 && isEmailLine(line))) {
            starts.emails = i;
        } else if (line === 'Teléfono' || (starts.phones === -1 && isPhoneLine(line))) {
            starts.phones = i;
        }

        // If we found all columns, break early
        if (starts.names !== -1 && starts.types !== -1 && starts.emails !== -1 && starts.phones !== -1) {
            break;
        }
    }

    return starts;
}

// NEW: Extract data from a specific column
function extractColumnData(sectionLines, startIndex, columnType) {
    const data = [];
    let i = startIndex;
    let count = 0;

    while (i < sectionLines.length && count < 200) { // Safety limit
        const line = sectionLines[i];

        // Skip headers and metadata
        if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono' ||
            line.includes('Provincia:') || line.includes('Total por provincia:') ||
            isHeaderLine(line)) {
            i++;
            continue;
        }

        // Check if we've moved to the next column
        if (isNextColumn(line, columnType)) {
            break;
        }

        // Add valid data based on column type
        if (columnType === 'name' && isNameLine(line)) {
            data.push(line);
            count++;
        } else if (columnType === 'type' && isTypeLine(line)) {
            data.push(line);
            count++;
        } else if (columnType === 'email' && isEmailLine(line)) {
            data.push(line);
            count++;
        } else if (columnType === 'phone' && isPhoneLine(line)) {
            data.push(line);
            count++;
        }

        i++;
    }

    return data;
}

// NEW: Check if we've moved to the next column
function isNextColumn(line, currentColumn) {
    if (currentColumn === 'name' && (isTypeLine(line) || isEmailLine(line) || isPhoneLine(line))) {
        return true;
    }
    if (currentColumn === 'type' && (isEmailLine(line) || isPhoneLine(line))) {
        return true;
    }
    if (currentColumn === 'email' && isPhoneLine(line)) {
        return true;
    }
    return false;
}

// NEW: Find the end of a province section
function findSectionEnd(lines, startIndex) {
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('Total por provincia:') ||
            line.includes('Total Provincial:') ||
            line.match(/Página \d+ de \d+/)) {
            return i;
        }

        // Also stop if we find the next province
        const provinces = ['BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN', 'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS'];
        const nextProvince = provinces.find(p => line.toUpperCase().includes(p.toUpperCase()));
        if (nextProvince && i > startIndex + 10) {
            return i;
        }
    }
    return lines.length;
}

// IMPROVED: Better helper functions
function isHeaderLine(line) {
    return line.includes('Reporte de Hospedajes vigentes') ||
           line.includes('Reporte: rep_hos_web') ||
           line.includes('Actualizado al') ||
           line.match(/Página \d+ de \d+/);
}

function isNameLine(line) {
    return line.length > 2 &&
           !line.includes('@') &&
           !isPhoneLine(line) &&
           !isTypeLine(line) &&
           line !== 'Nombre' &&
           line !== 'Modalidad' &&
           line !== 'Correo Principal' &&
           line !== 'Teléfono' &&
           !line.match(/^-+$/) &&
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:') &&
           !line.match(/^\d/);
}

function isTypeLine(line) {
    const types = [
        'Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel',
        'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña',
        'Glamping', 'Camping', 'Residencial', 'Pensión'
    ];
    return types.some(type => line.toUpperCase().includes(type.toUpperCase()));
}

function isEmailLine(line) {
    return line.includes('@') &&
           (line.includes('.com') || line.includes('.net') || line.includes('.org') ||
            line.includes('.edu') || line.includes('.gob') || line.includes('.pa'));
}

function isPhoneLine(line) {
    // More specific phone patterns for Panama
    const cleanLine = line.replace(/\s+/g, '').replace(/\//g, '');

    const phonePatterns = [
        /^\d{7,8}$/, // 7 or 8 digit numbers
        /^\d{3,4}[-]?\d{3,4}$/, // 123-4567 or 1234-5678
        /^\d{4}[-]?\d{4}$/ // 1234-5678 (mobile format)
    ];

    return phonePatterns.some(pattern => pattern.test(cleanLine));
}

function extractEmail(text) {
    if (!text) return '';
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : '';
}

function extractFirstPhone(text) {
    if (!text) return '';

    const patterns = [
        /(\d{4}[- ]?\d{4})/, // 1234-5678
        /(\d{3}[- ]?\d{4})/, // 123-4567
        /(\d{7,8})/ // 1234567 or 12345678
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return match[1].replace(/[- ]/g, '');
        }
    }

    return '';
}

function createRentalObject(name, type, email, phone, province) {
    const cleanName = cleanText(name);
    const cleanType = cleanText(type || 'Hospedaje');
    const cleanEmail = extractEmail(email);
    const cleanPhone = extractFirstPhone(phone);

    if (!cleanName || cleanName.length < 2) {
        return null;
    }

    return {
        name: cleanName,
        type: cleanType,
        email: cleanEmail,
        phone: cleanPhone,
        province: province,
        district: guessDistrict(cleanName, province),
        description: generateDescription(cleanName, cleanType, province),
        google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(cleanName + ' ' + province + ' Panamá')}`,
        whatsapp: cleanPhone,
        source: 'ATP_OFFICIAL'
    };
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
        'VERAGUAS': 'Santiago',
        'GUNAS': 'Guna Yala',
        'EMBERÁ': 'Emberá',
        'NGÄBE-BUGLÉ': 'Ngäbe-Buglé',
        'PANAMÁ OESTE': 'Arraiján'
    };
    return districtMap[province] || province;
}

function generateDescription(name, type, province) {
    return `${type} "${name}" ubicado en ${province}, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).`;
}

function getFallbackData() {
    return [
        {
            name: "SOCIALTEL BOCAS DEL TORO",
            type: "Albergue",
            email: "reception.bocasdeltoro@collectivehospitality.com",
            phone: "64061547",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro",
            description: "Albergue \"SOCIALTEL BOCAS DEL TORO\" ubicado en BOCAS DEL TORO, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).",
            google_maps_url: "https://maps.google.com/?q=SOCIALTEL%20BOCAS%20DEL%20TORO%20BOCAS%20DEL%20TORO%20Panam%C3%A1",
            whatsapp: "64061547",
            source: "ATP_OFFICIAL"
        },
        {
            name: "RED FROG BEACH",
            type: "Albergue",
            email: "reception.redfrog@collectivehospitality.com",
            phone: "61127504",
            province: "BOCAS DEL TORO",
            district: "Bocas del Toro",
            description: "Albergue \"RED FROG BEACH\" ubicado en BOCAS DEL TORO, Panamá. Registrado oficialmente ante la Autoridad de Turismo de Panamá (ATP).",
            google_maps_url: "https://maps.google.com/?q=RED%20FROG%20BEACH%20BOCAS%20DEL%20TORO%20Panam%C3%A1",
            whatsapp: "61127504",
            source: "ATP_OFFICIAL"
        }
    ];
}

// Keep all your existing API routes (they remain the same)
app.get('/api/test', (req, res) => {
    res.json({
        message: 'ATP Rentals Search API is working!',
        status: 'success',
        timestamp: new Date().toISOString(),
        data_source: 'LIVE_ATP_PDF',
        total_rentals: CURRENT_RENTALS.length
    });
});

app.get('/api/rentals', (req, res) => {
    try {
        const { search, province, type } = req.query;
        let filtered = [...CURRENT_RENTALS];

        if (search) {
            const searchLower = search.toLowerCase();
            filtered = filtered.filter(rental =>
                rental.name.toLowerCase().includes(searchLower) ||
                (rental.district && rental.district.toLowerCase().includes(searchLower)) ||
                (rental.description && rental.description.toLowerCase().includes(searchLower)) ||
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
    } catch (error) {
        console.error('Error in /api/rentals:', error);
        res.status(500).json({ error: 'Error al buscar hospedajes' });
    }
});

app.get('/api/provinces', (req, res) => {
    try {
        const provinces = [...new Set(CURRENT_RENTALS.map(r => r.province).filter(Boolean))].sort();
        res.json(provinces);
    } catch (error) {
        console.error('Error in /api/provinces:', error);
        res.status(500).json({ error: 'Error cargando provincias' });
    }
});

app.get('/api/types', (req, res) => {
    try {
        const types = [...new Set(CURRENT_RENTALS.map(r => r.type).filter(Boolean))].sort();
        res.json(types);
    } catch (error) {
        console.error('Error in /api/types:', error);
        res.status(500).json({ error: 'Error cargando tipos' });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        res.json({
            total_rentals: CURRENT_RENTALS.length,
            last_updated: LAST_PDF_UPDATE || new Date().toISOString(),
            data_source: 'LIVE_ATP_DATA',
            status: PDF_STATUS,
            note: 'Datos oficiales de la Autoridad de Turismo de Panamá (ATP)'
        });
    } catch (error) {
        console.error('Error in /api/stats:', error);
        res.status(500).json({ error: 'Error cargando estadísticas' });
    }
});

app.get('/api/debug-pdf', (req, res) => {
    try {
        const sampleWithContacts = CURRENT_RENTALS
            .filter(rental => rental.email || rental.phone)
            .slice(0, 10);

        res.json({
            pdf_status: PDF_STATUS,
            total_rentals_found: CURRENT_RENTALS.length,
            last_update: LAST_PDF_UPDATE,
            sample_with_contacts: sampleWithContacts,
            all_provinces: [...new Set(CURRENT_RENTALS.map(r => r.province).filter(Boolean))],
            all_types: [...new Set(CURRENT_RENTALS.map(r => r.type).filter(Boolean))]
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
            total_rentals: CURRENT_RENTALS.length,
            status: PDF_STATUS,
            last_update: LAST_PDF_UPDATE
        });
    } catch (error) {
        console.error('Error in /api/refresh-pdf:', error);
        res.status(500).json({ error: error.message });
    }
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);

    // Load PDF data on startup
    setTimeout(async () => {
        await fetchAndParsePDF();
        console.log(`✅ Ready! ${CURRENT_RENTALS.length} ATP rentals loaded`);
    }, 2000);
});
