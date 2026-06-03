<?php
header('Content-Type: application/json');

$url = 'https://www.atp.gob.pa/industrias/hoteleros/';

// Initialize cURL
$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_SSL_VERIFYPEER => false,  // Only if SSL issues; remove in production if possible
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
]);

$html = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($curlError) {
    echo json_encode(['error' => "cURL error: $curlError"]);
    exit;
}

if ($httpCode !== 200) {
    echo json_encode(['error' => "HTTP $httpCode received from target page"]);
    exit;
}

// Load HTML into DOMDocument and DOMXPath
$dom = new DOMDocument();
libxml_use_internal_errors(true); // Suppress HTML5 warnings
$dom->loadHTML($html);
libxml_clear_errors();

$xpath = new DOMXPath($dom);

// Look for buttons or links that contain "Descargar PDF" (case-insensitive)
// First try: <a> or <button> with exact text
$nodes = $xpath->query("//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'descargar pdf')]/ancestor-or-self::a | //*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'descargar pdf')]/ancestor-or-self::button");

// If not found, also look for elements where 'Descargar PDF' appears in any child text
if ($nodes->length === 0) {
    $nodes = $xpath->query("//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'descargar pdf')] | //button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'descargar pdf')]");
}

$pdfUrl = null;
$linkText = null;

foreach ($nodes as $node) {
    $href = null;
    if ($node->nodeName === 'a') {
        $href = $node->getAttribute('href');
    } elseif ($node->nodeName === 'button' && $node->hasAttribute('onclick')) {
        // Sometimes buttons trigger JS: onclick="window.location='file.pdf'"
        $onclick = $node->getAttribute('onclick');
        if (preg_match('/location\s*=\s*[\'"]([^\'"]+)[\'"]/', $onclick, $matches)) {
            $href = $matches[1];
        }
    }

    if ($href) {
        // Resolve relative URLs
        if (strpos($href, 'http') !== 0) {
            $base = 'https://www.atp.gob.pa';
            if ($href[0] !== '/') {
                // Relative path: get directory of current URL
                $dir = dirname($url);
                $href = rtrim($dir, '/') . '/' . ltrim($href, '/');
            } else {
                $href = $base . $href;
            }
        }
        $pdfUrl = $href;
        $linkText = trim($node->textContent);
        break;
    }
}

// Fallback: search for any link that ends with .pdf if the above fails
if (!$pdfUrl) {
    $allLinks = $xpath->query("//a[@href]");
    foreach ($allLinks as $link) {
        $href = $link->getAttribute('href');
        if (preg_match('/\.pdf$/i', $href)) {
            // resolve URL
            if (strpos($href, 'http') !== 0) {
                $base = 'https://www.atp.gob.pa';
                if ($href[0] !== '/') {
                    $dir = dirname($url);
                    $href = rtrim($dir, '/') . '/' . ltrim($href, '/');
                } else {
                    $href = $base . $href;
                }
            }
            $pdfUrl = $href;
            $linkText = trim($link->textContent);
            break;
        }
    }
}

if ($pdfUrl) {
    echo json_encode(['pdfUrl' => $pdfUrl, 'linkText' => $linkText]);
} else {
    echo json_encode(['error' => 'No "Descargar PDF" link or .pdf link found on the page']);
}
?>
