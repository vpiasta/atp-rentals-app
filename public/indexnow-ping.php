<?php
/**
 * IndexNow ping for trustedpanamastays.com (Bing / Copilot, Yandex, Seznam, Naver…).
 *
 * Collects the site's content URLs with their last-modified date (TPSipedia pages + index,
 * published blog posts), compares them with what was last submitted (table indexnow_log),
 * and submits only new or changed URLs to api.indexnow.org. Safe to call any time and by
 * anyone: a call with nothing changed submits nothing.
 *
 * Called daily by .github/workflows/indexnow.yml, and can be opened by hand right after
 * publishing or editing a page:  https://trustedpanamastays.com/indexnow-ping.php
 *
 * Key file: /5151ae9aecae8400a7a0de59ba83c63b.txt (must stay in the web root).
 */
require_once __DIR__ . '/includes/supabase-config.php';
header('Content-Type: application/json; charset=utf-8');
header('X-Robots-Tag: noindex');

const INDEXNOW_KEY  = '5151ae9aecae8400a7a0de59ba83c63b';
const INDEXNOW_HOST = 'trustedpanamastays.com';
const SITE          = 'https://trustedpanamastays.com';

if (SUPABASE_SERVICE_KEY === '') {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Service key not available']);
    exit;
}

// ── 1. Current URLs with last-modified timestamps ──
$urls = []; // url => ISO timestamp

[$c, $tp] = supabase_request('GET', '/rest/v1/tpsipedia_pages?select=slug_en,slug_es,updated_at&status=eq.published', SUPABASE_KEY);
$tpLatest = null;
foreach (is_array($tp) ? $tp : [] as $p) {
    $urls[SITE . '/tpsipedia.php?slug=' . urlencode($p['slug_en'])]                = $p['updated_at'];
    $urls[SITE . '/tpsipedia.php?slug=' . urlencode($p['slug_es']) . '&lang=es']   = $p['updated_at'];
    if ($tpLatest === null || strtotime($p['updated_at']) > strtotime($tpLatest)) $tpLatest = $p['updated_at'];
}
if ($tpLatest) {
    $urls[SITE . '/tpsipedia.php']         = $tpLatest;
    $urls[SITE . '/tpsipedia.php?lang=es'] = $tpLatest;
}

[$c, $bp] = supabase_request('GET', '/rest/v1/blog_posts?select=slug,published_at,updated_at&status=eq.published', SUPABASE_KEY);
foreach (is_array($bp) ? $bp : [] as $b) {
    $stamp = $b['updated_at'] ?? $b['published_at'];
    if (!$stamp) continue;
    $urls[SITE . '/blog-post.php?slug=' . urlencode($b['slug'])]              = $stamp;
    $urls[SITE . '/blog-post.php?slug=' . urlencode($b['slug']) . '&lang=es'] = $stamp;
}

// ── 2. Compare with what was already submitted ──
[$c, $log] = supabase_request('GET', '/rest/v1/indexnow_log?select=url,last_modified', SUPABASE_SERVICE_KEY);
$done = [];
foreach (is_array($log) ? $log : [] as $r) $done[$r['url']] = $r['last_modified'];

$changed = [];
foreach ($urls as $u => $ts) {
    if (!isset($done[$u]) || strtotime($ts) > strtotime($done[$u])) $changed[] = $u;
}

if (!$changed) {
    echo json_encode(['ok' => true, 'submitted' => 0, 'checked' => count($urls)]);
    exit;
}

// ── 3. Submit (IndexNow accepts up to 10,000 URLs per request) ──
$payload = json_encode([
    'host'        => INDEXNOW_HOST,
    'key'         => INDEXNOW_KEY,
    'keyLocation' => SITE . '/' . INDEXNOW_KEY . '.txt',
    'urlList'     => array_values($changed),
], JSON_UNESCAPED_SLASHES);
$ch = curl_init('https://api.indexnow.org/indexnow');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json; charset=utf-8'],
    CURLOPT_TIMEOUT        => 15,
]);
$resp = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// 200 = accepted, 202 = accepted (key validation pending). Anything else: don't log, retry next run.
if ($code !== 200 && $code !== 202) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'indexnow_status' => $code, 'response' => $resp, 'pending' => count($changed)]);
    exit;
}

// ── 4. Remember what was submitted ──
$rows = [];
foreach ($changed as $u) $rows[] = ['url' => $u, 'last_modified' => $urls[$u], 'submitted_at' => date('c')];
supabase_request('POST', '/rest/v1/indexnow_log', SUPABASE_SERVICE_KEY, $rows,
    ['Prefer: resolution=merge-duplicates,return=minimal']);

echo json_encode(['ok' => true, 'indexnow_status' => $code, 'submitted' => count($changed), 'urls' => $changed], JSON_UNESCAPED_SLASHES);
