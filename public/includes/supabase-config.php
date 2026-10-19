<?php
/**
 * Shared Supabase connection constants + a small REST helper, used by every
 * PHP script that talks to Supabase directly (index.php, listing.php,
 * blog.php, sitemap.php, blog-post.php, blog-comment-action.php).
 *
 * SUPABASE_KEY  = publishable key. Public by design; what it may read/write
 *                 is limited by the database's Row Level Security rules.
 * SUPABASE_SERVICE_KEY = secret key. NEVER put it in this file or anywhere
 *                 in the git repo. It is read from the private .env file in
 *                 /home/u945180857/secure_beds24_tokens/ (outside the web
 *                 root), line:  SUPABASE_SECRET_KEY=sb_secret_...
 */
if (!defined('SUPABASE_URL')) {
    define('SUPABASE_URL', 'https://caqdkxukezpckqphogwl.supabase.co');
}
if (!defined('SUPABASE_KEY')) {
    define('SUPABASE_KEY', 'sb_publishable_YNeI_nRW0naGllAlN2OIRQ_uZCjM9Aw');
}
if (!defined('SUPABASE_SERVICE_KEY')) {
    $tpsSecret = '';
    $tpsEnvFile = '/home/u945180857/secure_beds24_tokens/.env';
    if (is_readable($tpsEnvFile)) {
        foreach (file($tpsEnvFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $tpsLine) {
            if (preg_match('/^\s*SUPABASE_SECRET_KEY\s*=\s*["\']?([^"\'\s]+)["\']?\s*$/', $tpsLine, $m)) {
                $tpsSecret = $m[1];
                break;
            }
        }
    }
    define('SUPABASE_SERVICE_KEY', $tpsSecret);
    unset($tpsSecret, $tpsEnvFile, $tpsLine, $m);
}

/**
 * Minimal Supabase REST helper.
 * $method: GET, POST, PATCH
 * $path:   e.g. '/rest/v1/blog_comments?select=*&id=eq.123'
 * $key:    SUPABASE_KEY or SUPABASE_SERVICE_KEY
 * $body:   array to JSON-encode as the request body (POST/PATCH only)
 * Returns [httpCode, decodedJsonBodyOrNull]
 */
function supabase_request($method, $path, $key, $body = null, $extraHeaders = []) {
    $url = SUPABASE_URL . $path;
    $ch = curl_init($url);
    $headers = array_merge([
        'apikey: ' . $key,
        'Authorization: Bearer ' . $key,
        'Content-Type: application/json',
        'Accept: application/json',
    ], $extraHeaders);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_SSL_VERIFYPEER => false,
    ];
    if ($body !== null) {
        $opts[CURLOPT_POSTFIELDS] = json_encode($body);
    }
    curl_setopt_array($ch, $opts);
    $responseBody = curl_exec($ch);
    $info = curl_getinfo($ch);
    curl_close($ch);
    return [$info['http_code'] ?? 0, json_decode($responseBody, true)];
}
