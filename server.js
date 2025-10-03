const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

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
            }
        }

        console.log(`Total rentals found: ${allRentals.length}`);
        return allRentals;
    } catch (error) {
        console.error('Error in parsePDFWithPositionalData:', error);
        return getFallbackData();
    }
}

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
            return;
        }

        // Detect table start (column headers)
        if (rowText.includes('Nombre') && rowText.includes('Modalidad')) {
            inRentalTable = true;
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
            return;
        }

        if (inRentalTable) {
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

function parseRentalRow(rowItems, province) {
    const rental = { province };

    // Simple heuristic: assume first substantial text is name
    const nameItem = rowItems.find(item =>
        item.text.trim().length > 2 &&
        !isTypeLine(item.text) &&
        !isEmailLine(item.text) &&
        !isPhoneLine(item.text)
    );

    if (nameItem) {
        rental.name = nameItem.text.trim();
    }

    // Look for type in the same row
    const typeItem = rowItems.find(item => isTypeLine(item.text));
    if (typeItem) {
        rental.type = typeItem.text.trim();
    }

    // Look for email in the same row
    const emailItem = rowItems.find(item => isEmailLine(item.text));
    if (emailItem) {
        rental.email = emailItem.text.trim();
    }

    // Look for phone in the same row
    const phoneItem = rowItems.find(item => isPhoneLine(item.text));
    if (phoneItem) {
        rental.phone = phoneItem.text.trim();
    }

    return rental;
}

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

// Keep all your existing helper functions (isHeaderLine, isTypeLine, etc.)
