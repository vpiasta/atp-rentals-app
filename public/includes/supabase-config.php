<?php
/**
 * Shared Supabase connection constants + a small REST helper, used by any
 * PHP script that talks to Supabase directly (blog-post.php,
 * blog-comment-action.php, ...).
 */
if (!defined('SUPABASE_URL')) {
    define('SUPABASE_URL', 'https://caqdkxukezpckqphogwl.supabase.co');
}
if (!defined('SUPABASE_KEY')) {
    define('SUPABASE_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhcWRreHVrZXpwY2txcGhvZ3dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDc2MDIsImV4cCI6MjA5NjAyMzYwMn0.xqNuCWm_ALivBRpl3pSTDDJeoBN1WfX4-G_OJq2Sd8g');
}
if (!defined('SUPABASE_SERVICE_KEY')) {
    define('SUPABASE_SERVICE_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhcWRreHVrZXpwY2txcGhvZ3dsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDQ0NzYwMiwiZXhwIjoyMDk2MDIzNjAyfQ.8xv--2xlBWzIiKQergU69t-lOKLiFrfesd6LF9ZMkm0');
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
