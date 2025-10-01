const express = require('express');
const axios = require('axios');
const pdf = require('pdf-parse');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./atp_rentals.db');

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
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS data_sync (
        id INTEGER PRIMARY KEY,
        last_pdf_url TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        file_hash TEXT
    )`);
});

// Utility function to extract current PDF URL from ATP website
async function getCurrentPDFUrl() {
    try {
        const response = await axios.get('https://www.atp.gob.pa/industrias/hoteleros/');
        const $ = cheerio.load(response.data);

        // Find the PDF download button - this selector might need adjustment
        const pdfLink = $('a[href*=".pdf"]').filter(function() {
            return $(this).text().toLowerCase().includes('descargar');
        }).first().attr('href');

        if (!pdfLink) {
            throw new Error('PDF link not found on ATP website');
        }

        // Handle relative URLs
        return pdfLink.startsWith('http') ? pdfLink : `https://www.atp.gob.pa${pdfLink}`;
    } catch (error) {
        console.error('Error fetching PDF URL:', error);
        return null;
    }
}

// Download and parse PDF
async function downloadAndParsePDF(pdfUrl) {
    try {
        console.log('Downloading PDF from:', pdfUrl);
        const response = await axios.get(pdfUrl, {
            responseType: 'arraybuffer'
        });

        const data = await pdf(response.data);
        return data.text;
    } catch (error) {
        console.error('Error downloading or parsing PDF:', error);
        return null;
    }
}

// Parse PDF text into structured data
function parsePDFText(text) {
    const rentals = [];
    const lines = text.split('\n');

    let currentProvince = '';
    let currentRental = {};

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip empty lines and headers
        if (!line || line.includes('REPORTE DE HOSPEDAJES') || line.includes('Página')) {
            continue;
        }

        // Detect province headers (usually in uppercase or have specific patterns)
        if (line.match(/^(BOCAS DEL TORO|CHIRIQUÍ|COCLÉ|COLÓN|DARIÉN|HERRERA|LOS SANTOS|PANAMÁ|VERAGUAS|COMARCA|GUNAS|EMBERÁ)/i)) {
            currentProvince = line.trim();
            continue;
        }

        // Try to parse rental lines - this will need adjustment based on actual PDF format
        if (line.length > 10 && !line.match(/^\d/)) { // Basic filter for rental lines
            const rentalData = parseRentalLine(line, currentProvince);
            if (rentalData) {
                rentals.push(rentalData);
            }
        }
    }

    return rentals;
}

// Parse individual rental line - THIS IS THE KEY FUNCTION THAT NEEDS ADJUSTMENT
function parseRentalLine(line, province) {
    // This regex needs to be adjusted based on the actual PDF format
    // Example format: "Hotel Name | Hotel Type | email@example.com | +507 123-4567"
    const patterns = [
        // Try different patterns based on observed data
        /^([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)$/,
        /^([^-]+)-([^-]+)-([^-]+)-(.+)$/,
        /^(.+?)\s+(\w+)\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s+([+\d\s-]+)$/
    ];

    for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
            return {
                name: match[1].trim(),
                type: match[2].trim(),
                email: match[3].trim(),
                phone: match[4].trim(),
                province: province
            };
        }
    }

    // Fallback: simple split and guess
    const parts = line.split(/\s{2,}/); // Split by multiple spaces
    if (parts.length >= 4) {
        return {
            name: parts[0],
            type: parts[1],
            email: parts[2],
            phone: parts[3],
            province: province
        };
    }

    console.log('Could not parse line:', line);
    return null;
}

// Enhance rental data with search engine information
async function enhanceRentalData(rental) {
    try {
        // Search for additional information
        const searchTerms = `${rental.name} ${rental.province} Panamá turismo`;

        // Note: For production, you'd use a proper search API
        // This is a simplified version
        const enhancedData = {
            ...rental,
            description: `Hospedaje ${rental.type} ubicado en ${rental.province}, Panamá. ${rental.name} ofrece servicios de hospedaje registrado ante la ATP.`,
            district: await guessDistrict(rental.name, rental.province),
            address: await guessAddress(rental.name, rental.province),
            whatsapp: rental.phone, // Assume same as phone for now
            google_maps_url: await generateGoogleMapsUrl(rental.name, rental.province)
        };

        return enhancedData;
    } catch (error) {
        console.error('Error enhancing rental data:', error);
        return rental;
    }
}

// Helper functions for data enhancement
async function guessDistrict(name, province) {
    // Simple district guessing - in production, use geocoding API
    const districtMap = {
        'PANAMÁ': 'Ciudad de Panamá',
        'BOCAS DEL TORO': 'Bocas del Toro',
        'CHIRIQUÍ': 'David',
        'COCLÉ': 'Penonomé',
        'COLÓN': 'Colón',
        'DARIÉN': 'La Palma',
        'HERRERA': 'Chitré',
        'LOS SANTOS': 'Las Tablas',
        'VERAGUAS': 'Santiago'
    };
    return districtMap[province.toUpperCase()] || province;
}

async function guessAddress(name, province) {
    return `Dirección en ${province}, Panamá`;
}

async function generateGoogleMapsUrl(name, province) {
    const query = encodeURIComponent(`${name} ${province} Panamá`);
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

// Check if PDF has changed
async function hasPDFChanged(currentPdfUrl) {
    return new Promise((resolve) => {
        db.get('SELECT last_pdf_url, file_hash FROM data_sync WHERE id = 1', (err, row) => {
            if (err || !row) {
                resolve(true); // No previous data, needs update
            } else {
                // Simple check - compare URLs
                resolve(row.last_pdf_url !== currentPdfUrl);
            }
        });
    });
}

// Update database with new rentals
async function updateRentalsDatabase(rentals, pdfUrl) {
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

            // Update sync info
            db.run('INSERT OR REPLACE INTO data_sync (id, last_pdf_url, last_updated) VALUES (1, ?, CURRENT_TIMESTAMP)',
                [pdfUrl], (err) => {
                    if (err) {
                        console.error('Error updating sync info:', err);
                    }
                    console.log(`Updated ${inserted} out of ${total} rentals`);
                    resolve(inserted);
                });
        });
    });
}

// Main data sync function
async function syncATPRentalsData() {
    try {
        console.log('Starting ATP data sync...');

        const pdfUrl = await getCurrentPDFUrl();
        if (!pdfUrl) {
            throw new Error('Could not get PDF URL');
        }

        const hasChanged = await hasPDFChanged(pdfUrl);
        if (!hasChanged) {
            console.log('PDF has not changed, skipping update');
            return { updated: false, message: 'Data is up to date' };
        }

        const pdfText = await downloadAndParsePDF(pdfUrl);
        if (!pdfText) {
            throw new Error('Could not download or parse PDF');
        }

        const rentals = parsePDFText(pdfText);
        if (rentals.length === 0) {
            throw new Error('No rentals found in PDF');
        }

        const insertedCount = await updateRentalsDatabase(rentals, pdfUrl);

        console.log(`Data sync completed: ${insertedCount} rentals processed`);
        return { updated: true, count: insertedCount };

    } catch (error) {
        console.error('Data sync error:', error);
        return { updated: false, error: error.message };
    }
}

// API Routes
app.get('/api/rentals', (req, res) => {
    const { search, province, type } = req.query;

    let query = 'SELECT * FROM rentals WHERE 1=1';
    const params = [];

    if (search) {
        query += ' AND (name LIKE ? OR description LIKE ? OR province LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm);
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

        db.get('SELECT last_updated FROM data_sync WHERE id = 1', (err, syncRow) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }

            res.json({
                total_rentals: countRow.total,
                last_updated: syncRow ? syncRow.last_updated : 'Never'
            });
        });
    });
});

// Schedule automatic data sync (daily at 2 AM)
cron.schedule('0 2 * * *', () => {
    console.log('Running scheduled data sync...');
    syncATPRentalsData();
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);

    // Initial data sync on startup
    setTimeout(() => {
        syncATPRentalsData();
    }, 2000);
});
