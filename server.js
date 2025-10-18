const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const app = express();
const PORT = process.env.PORT || 3000;
const https = require('https');

app.use(cors());
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static('public'));


// Simple data
let CURRENT_RENTALS = [
    {
        name: "APARTHOTEL BOQUETE",
        type: "Aparta-Hotel",
        email: "info@aparthotel-boquete.com",
        phone: "68916669 / 68916660",
        province: "CHIRIQUÍ",
        district: "Boquete",
        source: "SAMPLE_DATA"
    }
];

let PDF_URL = 'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf';  // Fallback URL if we cannot get it from the ATP website
let PDF_HEADING = 'Hospedajes Registrados - ATP'; // Default heading

let PDF_STATUS = "Not loaded";
let PDF_RENTALS = [];


// Column boundaries from our previous work
const COLUMN_BOUNDARIES = {
    NOMBRE: { start: 0, end: 184 },
    MODALIDAD: { start: 184, end: 265 },
    CORREO: { start: 265, end: 481 },
    TELEFONO: { start: 481, end: 600 }
};


// Function to get the latest PDF URL from ATP website using proxy Service
async function getLatestPdfUrl() {
    const atpUrl = 'https://www.atp.gob.pa/industrias/hoteleros/';

    // Use the working proxy service
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(atpUrl)}`;

    try {
        console.log('🔍 Fetching ATP page via proxy...');

        const response = await axios.get(proxyUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = response.data;
        console.log('✅ Proxy successful, HTML length:', html.length);

        // Extract both the PDF URL and the heading text
        const result = extractPdfAndHeading(html, atpUrl);

        if (result.pdfUrl) {
            console.log('✅ Found PDF URL:', result.pdfUrl);
            console.log('✅ Is this ATP URL?', result.pdfUrl.includes('atp.gob.pa'));
            if (result.headingText) {
                console.log('✅ Found heading text:', result.headingText);
            }
            return result;
        }

        throw new Error('PDF link not found in Hospedajes section');

    } catch (error) {
        console.error('❌ Error fetching PDF URL:', error.message);
        // Return fallback instead of throwing
        return {
            pdfUrl: 'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf',
            headingText: 'Hospedajes Registrados - ATP'
        };
    }
}

function extractPdfAndHeading(html, baseUrl) {
    console.log('🔍 Extracting PDF and heading from Hospedajes section...');

    // Method 1: Look for the entire Hospedajes section block
    const hospedajesRegex = /<div[^>]*class="wp-block-group[^>]*>[\s\S]*?<div[^>]*id="hospedaje"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<a[^>]*class="[^"]*qubely-block-btn-anchor[^"]*"[^>]*href="([^"]*\.pdf)"[^>]*>/i;

    const hospedajesMatch = html.match(hospedajesRegex);
    if (hospedajesMatch) {
        console.log('✅ Found Hospedajes section with specific structure');

        const headingHtml = hospedajesMatch[1];
        const pdfUrl = new URL(hospedajesMatch[2], baseUrl).href;

        // Extract clean heading text from the HTML
        const headingText = extractHeadingText(headingHtml);

        return {
            pdfUrl: pdfUrl,
            headingText: headingText,
            fullMatch: true
        };
    }

    // Method 2: Alternative - look for the heading by text content
    const hospedajesTextIndex = html.indexOf('Hospedajes');
    if (hospedajesTextIndex !== -1) {
        console.log('✅ Found Hospedajes text, extracting context...');

        // Get a larger context around "Hospedajes"
        const contextStart = Math.max(0, hospedajesTextIndex - 100);
        const contextEnd = hospedajesTextIndex + 2000;
        const context = html.substring(contextStart, contextEnd);

        // Look for PDF URL in this context
        const pdfRegex = /href="([^"]*\.pdf)"/i;
        const pdfMatch = context.match(pdfRegex);

        if (pdfMatch) {
            const pdfUrl = new URL(pdfMatch[1], baseUrl).href;

            // Try to extract the full heading from context
            const headingText = extractHeadingTextFromContext(context);

            return {
                pdfUrl: pdfUrl,
                headingText: headingText,
                fullMatch: false
            };
        }
    }

    return { pdfUrl: null, headingText: null };
}

function extractHeadingTextFromContext(context) {
    // Look for h3 and h4 tags in the context
    const h3Match = context.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const h4Match = context.match(/<h4[^>]*>([^<]+)<\/h4>/);

    let headingParts = [];

    if (h4Match && h4Match[1]) {
        headingParts.push(h4Match[1].trim());
    }

    if (h3Match && h3Match[1]) {
        headingParts.push(h3Match[1].trim());
    }

    if (headingParts.length > 0) {
        const fullHeading = headingParts.join(' - ');
        console.log('📝 Extracted full heading from context:', fullHeading);
        return fullHeading;
    }

    // Fallback: if we can't extract specific headings, return a descriptive text
    return "Hospedajes Registrados por la Autoridad de Turismo de Panamá (ATP)";
}

function extractHeadingText(html) {
    // Try to extract both h4 and h3 text
    const h4Match = html.match(/<h4[^>]*>([^<]+)<\/h4>/i);
    const h3Match = html.match(/<h3[^>]*>([^<]+)<\/h3>/i);

    let headingText = 'Hospedajes';

    if (h4Match && h3Match) {
        headingText = `${h4Match[1].trim()} - ${h3Match[1].trim()}`;
    } else if (h3Match) {
        headingText = `Hospedajes - ${h3Match[1].trim()}`;
    } else if (h4Match) {
        headingText = h4Match[1].trim();
    }

    console.log('📝 Extracted heading text:', headingText);
    return headingText;
}

// Function to extract and format the date from heading text
function extractFormattedDate(headingText) {
    try {
        console.log('📅 Extracting date from heading:', headingText);

        // If no date found in heading, use current date as fallback
        if (!headingText || headingText === 'Hospedajes') {
            console.log('📅 No date in heading, using current date');
            const currentDate = new Date();
            return currentDate.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric'
            });
        }

        // Rest of your existing date extraction logic...

    } catch (error) {
        console.error('❌ Error extracting date:', error);
        const currentDate = new Date();
        return currentDate.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });
    }
}

// Function to convert Spanish date to US format
function convertSpanishDateToUS(spanishDate) {
    const months = {
        'enero': 'January', 'febrero': 'February', 'marzo': 'March', 'abril': 'April',
        'mayo': 'May', 'junio': 'June', 'julio': 'July', 'agosto': 'August',
        'septiembre': 'September', 'octubre': 'October', 'noviembre': 'November', 'diciembre': 'December'
    };

    // Handle "5 de septiembre de 2025" format
    const deMatch = spanishDate.match(/(\d+) de ([a-z]+) de (\d{4})/i);
    if (deMatch) {
        const [, day, monthEs, year] = deMatch;
        const monthEn = months[monthEs.toLowerCase()];
        if (monthEn) {
            return `${monthEn} ${parseInt(day)}, ${year}`;
        }
    }

    // Handle "05/09/2025" format
    const slashMatch = spanishDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
        const [, day, month, year] = slashMatch;
        const date = new Date(year, month - 1, day);
        return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }

    // If no pattern matches, return original
    console.log('❌ Unknown date format:', spanishDate);
    return spanishDate;
}

function extractHeadingTextFromContext(context) {
    // Look for the h4 and h3 text in the context
    const h4Match = context.match(/<h4[^>]*>([^<]*)<\/h4>/i);
    const h3Match = context.match(/<h3[^>]*>([^<]*)<\/h3>/i);

    let headingText = '';

    if (h4Match && h4Match[1]) {
        headingText += h4Match[1].trim();
    }

    if (h3Match && h3Match[1]) {
        if (headingText) headingText += ' - ';
        headingText += h3Match[1].trim();
    }

    // If no specific headings found, return generic text
    if (!headingText) {
        headingText = "Hospedajes Registrados por la Autoridad de Turismo de Panamá (ATP)";
    }

    console.log('📝 Context extracted heading:', headingText);
    return headingText;
}


// Group text items into rows based on Y coordinates
function groupIntoRows(textItems) {
    const rows = {};
    const Y_TOLERANCE = 1.5;

    textItems.forEach(item => {
        if (!item.text.trim()) return;

        const existingKey = Object.keys(rows).find(y =>
            Math.abs(parseFloat(y) - item.y) <= Y_TOLERANCE
        );

        const rowY = existingKey || item.y.toString();
        if (!rows[rowY]) rows[rowY] = [];
        rows[rowY].push(item);
    });

    // Convert to array and sort by Y (top to bottom)
    return Object.entries(rows)
        .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
        .map(([y, items]) => ({
            y: parseFloat(y),
            items: items.sort((a, b) => a.x - b.x)
        }));
}       // end of groupIntoRows

//============================================================

// Parse row data into columns
function parseRowData(row) {
    const rental = {
        name: '',
        type: '',
        email: '',
        phone: ''
    };

    // Assign items to columns based on X position
    row.items.forEach(item => {
        if (item.x >= COLUMN_BOUNDARIES.NOMBRE.start && item.x < COLUMN_BOUNDARIES.NOMBRE.end) {
            rental.name += (rental.name ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.MODALIDAD.start && item.x < COLUMN_BOUNDARIES.MODALIDAD.end) {
            rental.type += (rental.type ? ' ' : '') + item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.CORREO.start && item.x < COLUMN_BOUNDARIES.CORREO.end) {
            rental.email += item.text;
        } else if (item.x >= COLUMN_BOUNDARIES.TELEFONO.start && item.x < COLUMN_BOUNDARIES.TELEFONO.end) {
            rental.phone += (rental.phone ? ' ' : '') + item.text;
        }
    });

    // Clean the data
    rental.name = rental.name.trim();
    rental.type = rental.type.trim();
    rental.email = rental.email.trim();
    rental.phone = rental.phone.trim();

    return rental;
}

// Check if a row is a continuation of the previous row
function isContinuationRow(rowData, previousRowData) {
    // 1. Check for specific multi-word type patterns
    if (previousRowData.type === 'Hostal' && rowData.type === 'Familiar') {
        return true;
    }
    if (previousRowData.type === 'Sitio de' && rowData.type === 'acampar') {
        return true;
    }
    if (!rowData.type) {
        return true;
    }

    // 2. Check for email continuation
    if (previousRowData.email && rowData.email && !rowData.type ) {
        // Check if previous email is incomplete (doesn't look like a complete email)
        const isPreviousEmailComplete = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(previousRowData.email);

        if (!isPreviousEmailComplete) {
            return true;
        }
    }

    // 3. Check for phone continuation
    if (previousRowData.phone && rowData.phone && !rowData.type) {
        // Phone continues if previous ends with hyphen (number interrupted)
        if (previousRowData.phone.endsWith('-')) {
            return true;
        }
        // OR if previous ends with slash AND current doesn't end with slash (second number)
        if (previousRowData.phone.endsWith('/') && !rowData.phone.endsWith('/')) {
            return true;
        }
    }

    console.log(`Not a continuation: row has type "${rowData.type}"`);
    return false;
}

// Merge two rows that belong to the same rental
function mergeRentalRows(previousRental, continuationRow) {
    const merged = { ...previousRental };

    // Merge name with space
    if (continuationRow.name) {
        merged.name = (previousRental.name + ' ' + continuationRow.name).trim();
    }

    // Merge type - handle special cases
    if (continuationRow.type) {
        if (previousRental.type === 'Hostal' && continuationRow.type === 'Familiar') {
            merged.type = 'Hostal Familiar';
        } else if (previousRental.type === 'Sitio de' && continuationRow.type === 'acampar') {
            merged.type = 'Sitio de acampar';
        }
    }

    // Merge email without space
    if (continuationRow.email) {
        merged.email = (previousRental.email + continuationRow.email).trim();
    }

    // Merge phone with proper formatting
    if (continuationRow.phone) {
        if (previousRental.phone.endsWith('/')) {
            merged.phone = (previousRental.phone + ' ' + continuationRow.phone).trim();
        } else if (previousRental.phone.endsWith('-')) {
            merged.phone = (previousRental.phone.slice(0, -1) + continuationRow.phone).trim();
        } else {
            merged.phone = (previousRental.phone + ' ' + continuationRow.phone).trim();
        }
    }

    return merged;
}

// Function to detect if a row is a page header or table header
function isHeaderRow(rowText) {
    // Page headers
    if (rowText.includes('Reporte de Hospedajes vigentes') ||
        rowText.includes('Página') ||
        rowText.includes('Total por provincia') ||
        rowText.includes('rep_hos_web')) {
        console.log(`Header detected: ${rowText}`);
        return true;
    }

    // Table headers
    if (rowText.includes('Nombre') &&
          (rowText.includes('Modalidad') || rowText.includes('Correo'))) {
          console.log(`Table header detected: ${rowText}`);
        return true;
    }

    return false;
}

// Coordinate-based PDF parsing
async function parsePDFWithCoordinates() {
    try {
        console.log('🔄 Starting PDF processing, current PDF_URL:', PDF_URL);
        PDF_STATUS = "Loading PDF...";

        // Get the latest PDF URL dynamically
        // Instead of just getting the PDF URL, get both URL and heading
        const result = await getLatestPdfUrl();
        PDF_URL = result.pdfUrl;  // Update the GLOBAL PDF_URL
        console.log('📝 Updated PDF_URL to:', PDF_URL);
        console.log('📝 Is ATP URL?', PDF_URL.includes('atp.gob.pa'));
        const headingText = result.headingText;

        console.log('📄 Using PDF URL:', PDF_URL);
        console.log('🏷️ Using heading:', headingText);

        // Store the heading text for use in your frontend
        PDF_HEADING = headingText;

        // Use proxy for PDF download too  (latest change 20251017 19:56)
        const proxyPdfUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(PDF_URL)}`;

        const response = await axios.get(proxyPdfUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/pdf, */*'
            }
        });

        console.log('PDF downloaded, response length:', response.data.length);

        // Check if it's actually a PDF
        const data = new Uint8Array(response.data);

        // Validate PDF header
        if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
            console.log('✅ Valid PDF header found (%PDF)');
        } else {
            // Check if it's HTML error page
            const textStart = new TextDecoder().decode(data.slice(0, 100));
            if (textStart.includes('<html') || textStart.includes('<!DOCTYPE')) {
                throw new Error('Server returned HTML instead of PDF');
            } else {
                throw new Error('Invalid PDF format');
            }
        }

        console.log('Processing PDF...');
        const pdf = await pdfjsLib.getDocument(data).promise;
        const numPages = pdf.numPages;

        console.log(`PDF loaded with ${numPages} pages...`);
        const allRentals = [];
        let currentProvince = '';
        let currentRental = null;

        // Process all pages
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            console.log(`Processing page ${pageNum}...`);
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();

            // Extract text with precise positioning
            const textItems = textContent.items.map(item => ({
                text: item.str,
                x: Math.round(item.transform[4] * 100) / 100,
                y: Math.round(item.transform[5] * 100) / 100,
                page: pageNum
            }));

            // Group into rows
            const rows = groupIntoRows(textItems);
            console.log(`Page ${pageNum}: ${rows.length} rows found`);

            // Process each row in this page
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowText = row.items.map(item => item.text).join(' ');

                // Detect province
                if (rowText.includes('Provincia:')) {
                    currentProvince = rowText.replace('Provincia:', '').replace(/Total.*/, '').trim();
                    console.log(`Found province: ${currentProvince}`);
                    continue;
                }

                // Skip header rows
                if (isHeaderRow(rowText) || !currentProvince) {
                    console.log(`Skipping header row: ${rowText}`);
                    continue;
                }

                // Skip summary rows
                if (rowText.includes('Total por')) {
                    console.log(`Skipping summary row: ${rowText}`);
                    continue;
                }

                // Parse row data
                const rowData = parseRowData(row);
                console.log(`Processing row ${i}:`, rowData);
                console.log(`Current rental:`, currentRental);

                // ALWAYS check for continuation first - using the "no type" criterion
                if (currentRental && isContinuationRow(rowData, currentRental)) {
                    console.log(`🔄 Stitching row ${i} to previous rental`);
                    console.log(`Before stitch - currentRental:`, currentRental);
                    console.log(`Row to stitch:`, rowData);
                    currentRental = mergeRentalRows(currentRental, rowData);
                    console.log(`After stitch - currentRental:`, currentRental);
                    continue; // Skip the rest of the logic for this row
                }

                // If we have a current rental and this row is NOT a continuation, save it
                // BUT only if this row looks like a legitimate new rental start
                if (currentRental && rowData.name && rowData.name.trim() &&
                    (rowData.type || rowData.email || rowData.phone)) {
                    console.log(`💾 Saving current rental and starting new one:`, currentRental);
                    allRentals.push(currentRental);
                    currentRental = { ...rowData, province: currentProvince };
                }
                // If no current rental, start a new one if we have substantial data
                else if (!currentRental && rowData.name && rowData.name.trim() &&
                         (rowData.type || rowData.email || rowData.phone)) {
                    console.log(`🆕 Starting new rental:`, rowData);
                    currentRental = { ...rowData, province: currentProvince };
                }
                // If we have minimal data but no current rental, start one cautiously
                else if (!currentRental && rowData.name && rowData.name.trim()) {
                    console.log(`⚠️ Starting cautious rental:`, rowData);
                    currentRental = { ...rowData, province: currentProvince };
                }
                // If we have a current rental but this row doesn't look like a new rental,
                // just continue (don't save yet - it might be garbage data)
                else if (currentRental) {
                    console.log(`❓ Row doesn't look like continuation or new rental, keeping current rental`);
                }
            }
        }

        // Only save the final rental AFTER processing ALL pages
        if (currentRental) {
            allRentals.push(currentRental);
        }

        PDF_RENTALS = allRentals;
        PDF_STATUS = `PDF parsed: ${allRentals.length} rentals found from ${numPages} pages`;
        console.log(`✅ ${PDF_STATUS}`);
        console.log(`✅ PDF processing complete: ${allRentals.length} rentals extracted`);
        return { success: true, rentals: allRentals.length };

    } catch (error) {
        console.error('PDF processing error:', error.message);

        // If the ATP PDF fails and we weren't already using the fallback, try the fallback
        if (pdfUrl && !pdfUrl.includes('aparthotel-boquete.com')) {
            console.log('🔄 ATP PDF failed, trying fallback URL...');
            try {
                const fallbackUrl = 'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf';
                console.log('Trying fallback URL:', fallbackUrl);

                const fallbackResponse = await axios.get(fallbackUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000
                });

                console.log('Fallback PDF downloaded, processing...');
                const fallbackData = new Uint8Array(fallbackResponse.data);
                const pdf = await pdfjsLib.getDocument(fallbackData).promise;
                const numPages = pdf.numPages;
                console.log(`Fallback PDF loaded with ${numPages} pages`);

                // Now run your existing processing logic with the fallback data
                // You'll need to copy the processing logic from above here
                // Or extract it into a separate function to avoid duplication

                const allRentals = [];
                let currentProvince = '';
                let currentRental = null;

                // Process all pages (same logic as above)
                for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                    console.log(`Processing page ${pageNum}...`);
                    const page = await pdf.getPage(pageNum);
                    const textContent = await page.getTextContent();

                    // Extract text with precise positioning
                    const textItems = textContent.items.map(item => ({
                        text: item.str,
                        x: Math.round(item.transform[4] * 100) / 100,
                        y: Math.round(item.transform[5] * 100) / 100,
                        page: pageNum
                    }));

                    // Group into rows
                    const rows = groupIntoRows(textItems);
                    console.log(`Page ${pageNum}: ${rows.length} rows found`);

                    // Process each row (same logic as above)
                    for (let i = 0; i < rows.length; i++) {
                        const row = rows[i];
                        const rowText = row.items.map(item => item.text).join(' ');

                        // Detect province
                        if (rowText.includes('Provincia:')) {
                            currentProvince = rowText.replace('Provincia:', '').replace(/Total.*/, '').trim();
                            console.log(`Found province: ${currentProvince}`);
                            continue;
                        }

                        // Skip header rows
                        if (isHeaderRow(rowText) || !currentProvince) {
                            console.log(`Skipping header row: ${rowText}`);
                            continue;
                        }

                        // Skip summary rows
                        if (rowText.includes('Total por')) {
                            console.log(`Skipping summary row: ${rowText}`);
                            continue;
                        }

                        // Parse row data
                        const rowData = parseRowData(row);
                        console.log(`Processing row ${i}:`, rowData);
                        console.log(`Current rental:`, currentRental);

                        // ALWAYS check for continuation first
                        if (currentRental && isContinuationRow(rowData, currentRental)) {
                            console.log(`🔄 Stitching row ${i} to previous rental`);
                            currentRental = mergeRentalRows(currentRental, rowData);
                            continue;
                        }

                        // If we have a current rental and this row is NOT a continuation, save it
                        if (currentRental && rowData.name && rowData.name.trim() &&
                            (rowData.type || rowData.email || rowData.phone)) {
                            console.log(`💾 Saving current rental and starting new one:`, currentRental);
                            allRentals.push(currentRental);
                            currentRental = { ...rowData, province: currentProvince };
                        }
                        else if (!currentRental && rowData.name && rowData.name.trim() &&
                                 (rowData.type || rowData.email || rowData.phone)) {
                            console.log(`🆕 Starting new rental:`, rowData);
                            currentRental = { ...rowData, province: currentProvince };
                        }
                        else if (!currentRental && rowData.name && rowData.name.trim()) {
                            console.log(`⚠️ Starting cautious rental:`, rowData);
                            currentRental = { ...rowData, province: currentProvince };
                        }
                        else if (currentRental) {
                            console.log(`❓ Row doesn't look like continuation or new rental, keeping current rental`);
                        }
                    }
                }

                // Only save the final rental AFTER processing ALL pages
                if (currentRental) {
                    allRentals.push(currentRental);
                }

                PDF_RENTALS = allRentals;
                PDF_STATUS = `PDF parsed (fallback): ${allRentals.length} rentals found from ${numPages} pages`;
                console.log(`✅ ${PDF_STATUS}`);

                return { success: true, rentals: allRentals.length };

            } catch (fallbackError) {
                console.error('Fallback PDF also failed:', fallbackError.message);
                PDF_STATUS = `PDF parsing failed: ${fallbackError.message}`;
                throw fallbackError;
            }
        } else {
            PDF_STATUS = `PDF parsing failed: ${error.message}`;
            console.error('PDF error:', error);
            throw error;
        }
    }
}

//
async function initializePDFData() {
    try {
        console.log('🔄 Auto-loading PDF data on startup...');
        console.log('📝 Current PDF_URL before processing:', PDF_URL);

        const result = await parsePDFWithCoordinates();
        if (result.success) {
            CURRENT_RENTALS = PDF_RENTALS;
            DATA_SOURCE = 'atp-pdf';
            console.log(`✅ Auto-loaded ${CURRENT_RENTALS.length} rentals from ATP PDF`);
            console.log('📝 Final PDF_URL:', PDF_URL);
        }
    } catch (error) {
        console.error('Auto-load error:', error);
        DATA_SOURCE = 'fallback';
    }
}

// Call this when server starts
initializePDFData();

// Basic endpoints

// Add this endpoint for testing
app.get('/api/debug-pdf-url', async (req, res) => {
    try {
        // If we already have ATP data, return current state
        if (DATA_SOURCE === 'atp-pdf') {
            return res.json({
                success: true,
                pdfUrl: PDF_URL,
                heading: PDF_HEADING,
                dataSource: DATA_SOURCE,
                rentalsCount: CURRENT_RENTALS.length,
                message: 'Using ATP PDF data (already loaded)'
            });
        }

        // Otherwise, try to get the latest PDF URL
        const result = await getLatestPdfUrl();
        res.json({
            success: true,
            pdfUrl: result.pdfUrl,
            heading: result.headingText,
            dataSource: 'atp-pdf (not yet loaded)',
            message: 'ATP PDF URL found, but data not loaded yet. Call /api/extract-pdf to load it.'
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            pdfUrl: 'https://aparthotel-boquete.com/hospedajes/REPORTE-HOSPEDAJES-VIGENTE.pdf',
            dataSource: 'fallback',
            rentalsCount: CURRENT_RENTALS.length
        });
    }
});

app.get('/api/test-pdf-fetch', async (req, res) => {
    try {
        console.log('🧪 Testing PDF URL fetch directly...');
        const result = await getLatestPdfUrl();

        res.json({
            directResult: result,
            currentGlobalPDF_URL: PDF_URL,
            areTheySame: result.pdfUrl === PDF_URL,
            isATP: result.pdfUrl.includes('atp.gob.pa')
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Force reload of PDF data
app.post('/api/reload-pdf', async (req, res) => {
    try {
        console.log('🔄 Manually reloading PDF data...');
        await initializePDFData();

        res.json({
            success: true,
            dataSource: DATA_SOURCE,
            rentalsCount: CURRENT_RENTALS.length,
            pdfUrl: PDF_URL,
            heading: PDF_HEADING,
            message: DATA_SOURCE === 'atp-pdf'
                ? `PDF data reloaded: ${CURRENT_RENTALS.length} rentals`
                : 'Using fallback data'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            dataSource: DATA_SOURCE
        });
    }
});

// Debug endpoint to see stitching results
app.get('/api/pdf-debug-stitching', (req, res) => {
    const stitchedExamples = PDF_RENTALS.filter(rental =>
        rental.name.includes(' ') && rental.name.split(' ').length > 2
    ).slice(0, 5);

    res.json({
        total_stitched_rentals: PDF_RENTALS.filter(r => r.name.includes(' ') && r.name.split(' ').length > 2).length,
        examples: stitchedExamples,
        total_rentals: PDF_RENTALS.length
    });
});

// PDF extraction endpoint
app.post('/api/extract-pdf', async (req, res) => {
    try {
        const result = await parsePDFWithCoordinates();
        res.json({
            success: result.success,
            message: PDF_STATUS,
            rentals_found: PDF_RENTALS.length,
            rentals: PDF_RENTALS,
            current_province_stats: Object.entries(PDF_RENTALS.reduce((acc, r) => {
              acc[r.province] = (acc[r.province] || 0) + 1;
              return acc;
            }, {})).map(([province, count]) => `${province}: ${count}`),
            note: 'Coordinate-based extraction'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'PDF extraction error',
            error: error.message
        });
    }
});


// Add endpoint to use PDF data
app.post('/api/use-pdf-data', (req, res) => {
    if (PDF_RENTALS.length > 0) {
        CURRENT_RENTALS = PDF_RENTALS;
        res.json({
            success: true,
            message: `Switched to PDF data: ${PDF_RENTALS.length} rentals`,
            total_rentals: PDF_RENTALS.length
        });
    } else {
        res.json({
            success: false,
            message: 'No PDF data available'
        });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: PDF_STATUS,
        lastUpdated: new Date().toISOString(),
        rentalsCount: CURRENT_RENTALS.length,
        pdfUrl: PDF_URL,
        pdfHeading: PDF_HEADING,
        dataSource: DATA_SOURCE,
        isFallback: DATA_SOURCE === 'fallback'
    });
});

app.get('/api/pdf-source', (req, res) => {
    res.json({
        pdfUrl: PDF_URL
    });
});

// Web interface for testing PDF extraction
app.get('/test-pdf', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PDF Test</title>
            <style>
                body { font-family: Arial; margin: 40px; }
                button { padding: 10px 20px; font-size: 16px; margin: 10px; }
                .result { background: #f5f5f5; padding: 20px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <h1>PDF Extraction Test</h1>
            <button onclick="testPDF()">Test PDF Extraction</button>
            <div id="result"></div>

            <script>
                async function testPDF() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = 'Testing PDF extraction...';

                    try {
                        const response = await fetch('/api/extract-pdf', {
                            method: 'POST'
                        });
                        const data = await response.json();
                        resultDiv.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
                    } catch (error) {
                        resultDiv.innerHTML = 'Error: ' + error;
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/pdf-info', (req, res) => {
    const formattedDate = extractFormattedDate(PDF_HEADING);

    res.json({
        pdfUrl: PDF_URL,
        heading: PDF_HEADING,
        formattedDate: formattedDate,
        lastUpdated: new Date().toISOString()
    });
});

app.get('/api/ping', (req, res) => {
    res.json({
        message: 'pong',
        timestamp: new Date().toISOString()
    });
});

// API endpoint for statistics
app.get('/api/stats', (req, res) => {
    const stats = {
        total_rentals: CURRENT_RENTALS.length,
        last_updated: new Date().toISOString(),
        status: "PDF Data Loaded",
        features: "Search by name, type, province"
    };
    res.json(stats);
});

// API endpoint for provinces with counts
app.get('/api/provinces', (req, res) => {
    const provinceCounts = CURRENT_RENTALS.reduce((acc, rental) => {
        if (rental.province) {
            acc[rental.province] = (acc[rental.province] || 0) + 1;
        }
        return acc;
    }, {});

    const provinces = Object.entries(provinceCounts)
        .map(([province, count]) => ({ province, count }))
        .sort((a, b) => a.province.localeCompare(b.province));

    res.json(provinces);
});

// API endpoint for rental types
app.get('/api/types', (req, res) => {
    const types = [...new Set(CURRENT_RENTALS.map(rental => rental.type))].filter(Boolean).sort();
    res.json(types);
});

// Enhanced rentals endpoint with search and filtering
app.get('/api/rentals', (req, res) => {
    const { search, province, type } = req.query;

    let filteredRentals = [...CURRENT_RENTALS];   // creates a copy

    // Apply search filter
    if (search) {
        const searchLower = search.toLowerCase();
        filteredRentals = filteredRentals.filter(rental =>
            rental.name.toLowerCase().includes(searchLower) ||
            (rental.email && rental.email.toLowerCase().includes(searchLower)) ||
            (rental.phone && rental.phone.toLowerCase().includes(searchLower)) ||
            (rental.province && rental.province.toLowerCase().includes(searchLower)) ||
            (rental.type && rental.type.toLowerCase().includes(searchLower))
        );
    }

    // Apply province filter
    if (province) {
        filteredRentals = filteredRentals.filter(rental =>
            rental.province === province
        );
    }

    // Apply type filter
    if (type) {
        filteredRentals = filteredRentals.filter(rental =>
            rental.type === type
        );
    }

    res.json(filteredRentals);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        pdf_status: PDF_STATUS,
        total_rentals: CURRENT_RENTALS.length
    });
});


app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Main page: http://localhost:${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 PDF Test: http://localhost:${PORT}/test-pdf`);
});
