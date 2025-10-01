const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database(':memory:'); // Using in-memory DB for Railway

// Initialize database
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS rentals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT,
        email TEXT,
        phone TEXT,
        province TEXT,
        district TEXT,
        address TEXT,
        whatsapp TEXT,
        description TEXT,
        google_maps_url TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Utility function to extract current PDF URL from ATP website
async function getCurrentPDFUrl() {
    try {
        console.log('Fetching ATP website for PDF link...');
        const response = await axios.get('https://www.atp.gob.pa/industrias/hoteleros/', {
            timeout: 10000
        });
        const $ = cheerio.load(response.data);

        // Look for PDF download links
        const pdfLinks = [];
        $('a[href*=".pdf"]').each((i, element) => {
            const href = $(element).attr('href');
            const text = $(element).text().toLowerCase();
            if (text.includes('descargar') || text.includes('hospedaje') || text.includes('reporte')) {
                pdfLinks.push(href);
            }
        });

        let pdfUrl = pdfLinks[0];

        if (!pdfUrl) {
            // Fallback: look for any PDF link
            pdfUrl = $('a[href*=".pdf"]').first().attr('href');
        }

        if (!pdfUrl) {
            throw new Error('No PDF link found on ATP website');
        }

        // Handle relative URLs
        if (!pdfUrl.startsWith('http')) {
            pdfUrl = `https://www.atp.gob.pa${pdfUrl.startsWith('/') ? '' : '/'}${pdfUrl}`;
        }

        console.log('Found PDF URL:', pdfUrl);
        return pdfUrl;
    } catch (error) {
        console.error('Error fetching PDF URL:', error.message);
        return null;
    }
}

// Download and parse PDF
async function downloadAndParsePDF(pdfUrl) {
    try {
        console.log('Downloading PDF from:', pdfUrl);
        const response = await axios.get(pdfUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
        });

        console.log('PDF downloaded, parsing...');
        const data = await pdf(response.data);
        console.log('PDF parsed successfully');
        return data.text;
    } catch (error) {
        console.error('Error downloading or parsing PDF:', error.message);
        return null;
    }
}

// Parse PDF text into structured data
function parsePDFText(text) {
    console.log('Parsing PDF text...');
    const rentals = [];
    const lines = text.split('\n');

    let currentProvince = '';

    // Common Panama provinces for detection
    const provinces = [
        'BOCAS DEL TORO', 'CHIRIQUÍ', 'COCLÉ', 'COLÓN', 'DARIÉN',
        'HERRERA', 'LOS SANTOS', 'PANAMÁ', 'VERAGUAS', 'COMARCA',
        'GUNAS', 'EMBERÁ', 'NGÄBE-BUGLÉ'
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip empty lines and obvious headers
        if (!line || line.length < 5) continue;
        if (line.includes('REPORTE DE HOSPEDAJES') || line.includes('Página')) continue;

        // Detect province headers
        const provinceMatch = provinces.find(province =>
            line.toUpperCase().includes(province)
        );
        if (provinceMatch) {
            currentProvince = provinceMatch;
            console.log('Found province:', currentProvince);
            continue;
        }

        // Try to parse rental lines - look for lines with contact info
        if (line.includes('@') || line.match(/\+507[\s\d-]+/) || line.match(/\d{3}[- ]?\d{3}[- ]?\d{3}/)) {
            const rentalData = parseRentalLine(line, currentProvince);
            if (rentalData && rentalData.name && rentalData.name.length > 2) {
                rentals.push(rentalData);
            }
        }
    }

    console.log(`Parsed ${rentals.length} rentals from PDF`);
    return rentals;
}

// Parse individual rental line
function parseRentalLine(line, province) {
    // Remove extra spaces
    line = line.replace(/\s+/g, ' ').trim();

    // Try to extract email
    const emailMatch = line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const email = emailMatch ? emailMatch[1] : '';

    // Try to extract phone (Panama format)
    const phoneMatch = line.match(/(\+507[\s\d-]+|\d{3}[- ]?\d{3}[- ]?\d{3})/);
    const phone = phoneMatch ? phoneMatch[0] : '';

    // Remove email and phone from line to get name and type
    let remainingLine = line
        .replace(email, '')
        .replace(phone, '')
        .replace(/\s+/g, ' ')
        .trim();

    // Try to split remaining text into name and type
    const parts = remainingLine.split(' ').filter(part => part.length > 0);

    if (parts.length >= 2) {
        // Assume last word is type, rest is name
        const type = parts.pop();
        const name = parts.join(' ');

        return {
            name: name.trim(),
            type: type.trim(),
            email: email.trim(),
            phone: phone.trim(),
            province: province
        };
    }

    return null;
}

// Enhance rental data
async function enhanceRentalData(rental) {
    try {
        const enhancedData = {
            ...rental,
            description: `Hospedaje ${rental.type} ubicado en ${rental.province}, Panamá. ${rental.name} ofrece servicios de hospedaje registrado ante la ATP.`,
            district: await guessDistrict(rental.name, rental.province),
            address: `Ubicado en ${rental.province}, Panamá`,
            whatsapp: rental.phone,
            google_maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(rental.name + ' ' + rental.province + ' Panamá')}`
        };

        return enhancedData;
    } catch (error) {
        console.error('Error enhancing rental data:', error);
        return rental;
    }
}

async function guessDistrict(name, province) {
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

// Update database with new rentals
async function updateRentalsDatabase(rentals) {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM rentals', async (err) => {
            if (err) {
                reject(err);
                return;
            }

            let inserted = 0;
            const total = rentals.length;

            for (const rental of rentals) {
                try {
                    const enhancedRental = await enhanceRentalData(rental);

                    db.run(`INSERT INTO rentals (name, type, email, phone, province, district, address, whatsapp, description, google_maps_url)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            enhancedRental.name,
                            enhancedRental.type,
                            enhancedRental.email,
                            enhancedRental.phone,
                            enhancedRental.province,
                            enhancedRental.district,
                            enhancedRental.address,
                            enhancedRental.whatsapp,
                            enhancedRental.description,
                            enhancedRental.google_maps_url
                        ],
                        (err) => {
                            if (err) {
                                console.error('Error inserting rental:', err);
                            } else {
                                inserted++;
                            }
                        });
                } catch (error) {
                    console.error('Error enhancing rental:', error);
                }
            }

            // Wait a bit for all inserts to complete
            setTimeout(() => {
                console.log(`Updated ${inserted} out of ${total} rentals`);
                resolve(inserted);
            }, 1000);
        });
    });
}

// Main data sync function
async function syncATPRentalsData() {
    try {
        console.log('Starting ATP data sync...');

        const pdfUrl = await getCurrentPDFUrl();
        if (!pdfUrl) {
            throw new Error('Could not get PDF URL from ATP website');
        }

        const pdfText = await downloadAndParsePDF(pdfUrl);
        if (!pdfText) {
            throw new Error('Could not download or parse PDF');
        }

        const rentals = parsePDFText(pdfText);
        if (rentals.length === 0) {
            throw new Error('No rentals found in PDF');
        }

        const insertedCount = await updateRentalsDatabase(rentals);

        console.log(`Data sync completed: ${insertedCount} rentals processed`);
        return { updated: true, count: insertedCount, pdfUrl };

    } catch (error) {
        console.error('Data sync error:', error.message);
        return { updated: false, error: error.message };
    }
}

// API Routes
app.get('/api/rentals', (req, res) => {
    const { search, province, type } = req.query;

    let query = 'SELECT * FROM rentals WHERE 1=1';
    const params = [];

    if (search) {
        query += ' AND (name LIKE ? OR description LIKE ? OR province LIKE ? OR district LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (province) {
        query += ' AND province = ?';
        params.push(province);
    }

    if (type) {
        query += ' AND type = ?';
        params.push(type);
    }

    query += ' ORDER BY name';

    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.get('/api/provinces', (req, res) => {
    db.all('SELECT DISTINCT province FROM rentals ORDER BY province', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => row.province));
    });
});

app.get('/api/types', (req, res) => {
    db.all('SELECT DISTINCT type FROM rentals ORDER BY type', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => row.type));
    });
});

app.get('/api/stats', (req, res) => {
    db.get('SELECT COUNT(*) as total FROM rentals', (err, countRow) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        res.json({
            total_rentals: countRow.total,
            last_updated: new Date().toISOString()
        });
    });
});

app.post('/api/sync', async (req, res) => {
    try {
        const result = await syncATPRentalsData();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/debug-pdf', async (req, res) => {
    try {
        const pdfUrl = await getCurrentPDFUrl();
        const pdfText = await downloadAndParsePDF(pdfUrl);

        res.json({
            pdfUrl,
            textSample: pdfText ? pdfText.substring(0, 1000) : 'No text extracted',
            success: !!pdfText
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Schedule automatic data sync (every 6 hours)
cron.schedule('0 */6 * * *', () => {
    console.log('Running scheduled data sync...');
    syncATPRentalsData();
});

// Start server and initial sync
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend: https://atp-rentals-app-production.up.railway.app`);
    console.log(`API: https://atp-rentals-app-production.up.railway.app/api`);

    // Initial data sync
    setTimeout(async () => {
        console.log('Starting initial data sync...');
        const result = await syncATPRentalsData();
        console.log('Initial sync result:', result);
    }, 3000);
});
