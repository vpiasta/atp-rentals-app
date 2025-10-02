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

function parsePDFText(text) {
    try {
        console.log('=== PARSING ATP PDF DATA ===');
        const rentals = [];
        const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

        let currentProvince = '';
        let currentSection = [];
        let inProvinceSection = false;

        const provinces = [
            'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
            'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
            'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
        ];

        // Group lines by province sections
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Skip headers
            if (isHeaderLine(line)) continue;

            // Detect province headers
            const provinceMatch = provinces.find(province =>
                line.toUpperCase().includes(province)
            );

            if (provinceMatch) {
                // Save previous section
                if (currentSection.length > 0 && currentProvince) {
                    const provinceRentals = parseProvinceSection(currentSection, currentProvince);
                    rentals.push(...provinceRentals);
                }

                // Start new section
                currentProvince = provinceMatch;
                currentSection = [];
                inProvinceSection = true;

                // FIX: Skip the province header line itself to avoid including it as data
                continue;
            }

            // Detect end of province section
            if (line.includes('Total por provincia:') && inProvinceSection) {
                if (currentSection.length > 0 && currentProvince) {
                    const provinceRentals = parseProvinceSection(currentSection, currentProvince);
                    rentals.push(...provinceRentals);
                }
                currentSection = [];
                inProvinceSection = false;
                continue;
            }

            // Add to current section (EXCLUDE province headers)
            if (inProvinceSection && line.length > 2 && !line.includes('Provincia:')) {
                currentSection.push(line);
            }
        }

        // Process last section
        if (currentSection.length > 0 && currentProvince) {
            const provinceRentals = parseProvinceSection(currentSection, currentProvince);
            rentals.push(...provinceRentals);
        }

        console.log(`=== PARSING COMPLETE: Found ${rentals.length} rentals ===`);
        return rentals;
    } catch (error) {
        console.error('Error in parsePDFText:', error);
        return getFallbackData();
    }
}

function parseProvinceSection(sectionLines, province) {
    try {
        const rentals = [];

        // FIX: Use improved column grouping that handles multi-line elements
        const columnGroups = groupIntoColumnsImproved(sectionLines);

        // FIX: Align columns properly
        const alignedColumns = alignColumnsProperly(columnGroups);

        if (alignedColumns.names.length > 0) {
            // Create rentals from aligned columns
            for (let i = 0; i < alignedColumns.names.length; i++) {
                const name = alignedColumns.names[i] || '';
                const type = alignedColumns.types[i] || '';
                const email = alignedColumns.emails[i] || '';
                const phone = alignedColumns.phones[i] || '';

                if (name && name.length > 2) {
                    const cleanName = cleanText(name);
                    // FIX: Only use "Hospedaje" as fallback if no type is found
                    const cleanType = cleanText(type) || 'Hospedaje';
                    const cleanEmail = extractEmail(email);
                    const cleanPhone = extractFirstPhone(phone);

                    const rental = {
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

                    rentals.push(rental);
                }
            }
        }

        console.log(`Province ${province}: ${rentals.length} rentals`);
        console.log(`Sample: ${alignedColumns.names[0]} - ${alignedColumns.types[0]} - ${alignedColumns.emails[0]} - ${alignedColumns.phones[0]}`);
        return rentals;
    } catch (error) {
        console.error(`Error parsing province ${province}:`, error);
        return [];
    }
}

// FIXED: Improved column grouping
function groupIntoColumnsImproved(lines) {
    try {
        const result = {
            names: [],
            types: [],
            emails: [],
            phones: []
        };

        let currentColumn = 'names';
        let foundHeaders = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Skip column headers but note that we found them
            if (line === 'Nombre' || line === 'Modalidad' || line === 'Correo Principal' || line === 'Teléfono') {
                foundHeaders = true;
                if (line === 'Nombre') currentColumn = 'names';
                else if (line === 'Modalidad') currentColumn = 'types';
                else if (line === 'Correo Principal') currentColumn = 'emails';
                else if (line === 'Teléfono') currentColumn = 'phones';
                continue;
            }

            // Skip other metadata
            if (line.includes('Provincia:') || line.includes('Total por provincia:')) {
                continue;
            }

            // FIX: Don't switch columns based on content - this was causing the problem
            // Only switch when we find clear column headers
            if (!foundHeaders) {
                // Simple content-based detection before headers
                if (isEmailLine(line)) {
                    currentColumn = 'emails';
                } else if (isPhoneLine(line)) {
                    currentColumn = 'phones';
                } else if (isTypeLine(line)) {
                    currentColumn = 'types';
                } else if (isNameLine(line)) {
                    currentColumn = 'names';
                }
            }

            // Add to appropriate column
            if (currentColumn === 'names' && isNameLine(line)) {
                result.names.push(line);
            } else if (currentColumn === 'types' && isTypeLine(line)) {
                result.types.push(line);
            } else if (currentColumn === 'emails' && isEmailLine(line)) {
                result.emails.push(line);
            } else if (currentColumn === 'phones' && isPhoneLine(line)) {
                result.phones.push(line);
            }
        }

        return result;
    } catch (error) {
        console.error('Error in groupIntoColumns:', error);
        return { names: [], types: [], emails: [], phones: [] };
    }
}

// FIXED: Proper column alignment
function alignColumnsProperly(columns) {
    const aligned = {
        names: [],
        types: [],
        emails: [],
        phones: []
    };

    // Use the longest column as reference
    const maxLength = Math.max(
        columns.names.length,
        columns.types.length,
        columns.emails.length,
        columns.phones.length
    );

    // Simple alignment - take first N elements from each column
    for (let i = 0; i < maxLength; i++) {
        aligned.names.push(columns.names[i] || '');
        aligned.types.push(columns.types[i] || '');
        aligned.emails.push(columns.emails[i] || '');
        aligned.phones.push(columns.phones[i] || '');
    }

    return aligned;
}

// IMPROVED helper functions
function isHeaderLine(line) {
    return line.includes('Reporte de Hospedajes vigentes') ||
           line.includes('Reporte: rep_hos_web') ||
           line.includes('Actualizado al') ||
           line.match(/Página \d+ de \d+/);
}

function isNameLine(line) {
    return line && line.length > 3 &&
           !line.includes('@') &&
           !isPhoneLine(line) &&
           !isTypeLine(line) &&
           line !== 'Nombre' &&
           line !== 'Modalidad' &&
           line !== 'Correo Principal' &&
           line !== 'Teléfono' &&
           !line.includes('Provincia:') &&
           !line.includes('Total por provincia:');
}

// FIXED: Better type detection
function isTypeLine(line) {
    if (!line) return false;
    const types = [
        'Albergue', 'Aparta-Hotel', 'Bungalow', 'Hostal', 'Hotel',
        'Posada', 'Resort', 'Ecolodge', 'Hospedaje', 'Cabaña',
        'Alojamiento', 'Residencial', 'Pensión'
    ];
    return types.some(type => line.toUpperCase().includes(type.toUpperCase()));
}

function isEmailLine(line) {
    return line && line.includes('@') &&
           (line.includes('.com') || line.includes('.net') || line.includes('.org') ||
            line.includes('.edu') || line.includes('.gob') || line.includes('.pa'));
}

function isPhoneLine(line) {
    return line && (line.match(/\d{3,4}[- \/]?\d{3,4}[- \/]?\d{3,4}/) ||
           line.match(/\d{7,8}/) ||
           (line.includes('/') && line.match(/\d+/)));
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
        // Try different phone patterns
        const patterns = [
            /(\d{3,4}[- ]?\d{3,4}[- ]?\d{3,4})/, // 123-456-7890
            /(\d{7,8})/, // 1234567 or 12345678
            /(\d{4}[- ]?\d{4})/ // 1234-5678
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                return match[1].replace(/[- ]/g, '');
            }
        }
        return '';
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
        }
    ];
}

// API Routes (keep your existing ones with error handling)
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

// FIXED: Health check endpoint (correct route)
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        rentals_loaded: CURRENT_RENTALS ? CURRENT_RENTALS.length : 0,
        pdf_status: PDF_STATUS
    });
});

// Initialize
app.listen(PORT, async () => {
    console.log(`🚀 ATP Rentals Search API running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);

    // Load PDF data on startup
    setTimeout(async () => {
        try {
            await fetchAndParsePDF();
            console.log(`✅ Ready! ${CURRENT_RENTALS ? CURRENT_RENTALS.length : 0} ATP rentals loaded`);

            // Log first few records for debugging
            if (CURRENT_RENTALS && CURRENT_RENTALS.length > 0) {
                console.log('First 3 rentals:');
                CURRENT_RENTALS.slice(0, 3).forEach((rental, i) => {
                    console.log(`${i + 1}. ${rental.name} - ${rental.type} - Email: ${rental.email || 'none'} - Phone: ${rental.phone || 'none'}`);
                });
            }
        } catch (error) {
            console.error('Error during startup:', error);
            CURRENT_RENTALS = getFallbackData();
        }
    }, 2000);
});
