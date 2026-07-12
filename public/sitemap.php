<?php
define('SUPABASE_URL', 'https://caqdkxukezpckqphogwl.supabase.co');
define('SUPABASE_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhcWRreHVrZXpwY2txcGhvZ3dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDc2MDIsImV4cCI6MjA5NjAyMzYwMn0.xqNuCWm_ALivBRpl3pSTDDJeoBN1WfX4-G_OJq2Sd8g'); // same anon key as listing.php
define('SITE_URL',     'https://trustedpanamastays.com');

header('Content-Type: application/xml; charset=utf-8');

function supabase_get_all($path) {
    $url = SUPABASE_URL . '/rest/v1/' . $path;
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => [
            'apikey: '        . SUPABASE_KEY,
            'Authorization: Bearer ' . SUPABASE_KEY,
            'Accept: application/json',
        ],
        CURLOPT_TIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => false,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    $data = json_decode($body, true);
    return is_array($data) ? $data : [];
}

$today  = date('Y-m-d');
$select = 'slug,created_at'; // swap created_at -> updated_at once the migration lands
$filter = 'listings?select=' . $select
        . '&is_member=eq.true'
        . '&membership_paid_until=gte.' . $today
        . '&slug=not.is.null';

$listings = supabase_get_all($filter);

echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";

$staticPages = [
    ['loc' => '/', 'priority' => '1.00'],
    ['loc' => '/about.html', 'priority' => '0.80'],
    ['loc' => '/join.html', 'priority' => '0.60'],
];
foreach ($staticPages as $p) {
    echo "  <url><loc>" . SITE_URL . $p['loc'] . "</loc><priority>{$p['priority']}</priority></url>\n";
}

foreach ($listings as $l) {
    $slug = urlencode($l['slug']);
    $loc  = SITE_URL . '/listing.php?slug=' . $slug;
    $lastmod = !empty($l['created_at']) ? date('Y-m-d', strtotime($l['created_at'])) : $today;
    echo "  <url><loc>{$loc}</loc><lastmod>{$lastmod}</lastmod><priority>0.90</priority></url>\n";
}

echo '</urlset>';
