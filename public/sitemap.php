<?php
require_once __DIR__ . '/includes/supabase-config.php';
require_once __DIR__ . '/includes/tpsipedia-about.php';
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

$blogFilter = 'blog_posts?select=slug,published_at,updated_at&status=eq.published';
$blogPosts  = supabase_get_all($blogFilter);

$tpsiPages  = supabase_get_all('tpsipedia_pages?select=slug_en,slug_es,updated_at&status=eq.published&order=sort_order.asc');

echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";

$staticPages = [
    ['loc' => '/index.php',           'priority' => '1.00'],
    ['loc' => '/index.php?lang=es',   'priority' => '1.00'],
    ['loc' => '/about.html?lang=en',  'priority' => '0.80'],
    ['loc' => '/about.html?lang=es',  'priority' => '0.80'],
    ['loc' => '/faq.php?lang=en',     'priority' => '0.80'],
    ['loc' => '/faq.php?lang=es',     'priority' => '0.80'],
    ['loc' => '/blog.php?lang=en',    'priority' => '0.80'],
    ['loc' => '/blog.php?lang=es',    'priority' => '0.80'],
    ['loc' => '/join.html',           'priority' => '0.60'],
];

foreach ($staticPages as $p) {
    echo "  <url><loc>" . SITE_URL . $p['loc'] . "</loc><priority>{$p['priority']}</priority></url>\n";
}

foreach ($listings as $l) {
    $slug = urlencode($l['slug']);
    $loc  = SITE_URL . '/listing.php?slug=' . $slug;
    $lastmod = !empty($l['created_at']) ? date('Y-m-d', strtotime($l['created_at'])) : $today;
    echo "  <url><loc>{$loc}</loc><lastmod>{$lastmod}</lastmod><priority>0.90</priority></url>\n";
    echo "  <url><loc>{$loc}&amp;lang=es</loc><lastmod>{$lastmod}</lastmod><priority>0.90</priority></url>\n";
}

foreach ($blogPosts as $b) {
    $slug    = urlencode($b['slug']);
    $loc     = SITE_URL . '/blog-post.php?slug=' . $slug;
    $stamp   = $b['updated_at'] ?? $b['published_at'] ?? null;
    $lastmod = $stamp ? date('Y-m-d', strtotime($stamp)) : $today;
    echo "  <url><loc>{$loc}</loc><lastmod>{$lastmod}</lastmod><priority>0.70</priority></url>\n";
}

// TPSipedia: index (EN/ES) + each question page in both languages (each language has its own slug)
if (!empty($tpsiPages)) {
    $tpsiLatest = max(array_map(function ($p) { return strtotime($p['updated_at']); }, $tpsiPages));
    $tpsiIdxMod = date('Y-m-d', $tpsiLatest);
    echo "  <url><loc>" . SITE_URL . "/tpsipedia.php</loc><lastmod>{$tpsiIdxMod}</lastmod><priority>0.85</priority></url>\n";
    echo "  <url><loc>" . SITE_URL . "/tpsipedia.php?lang=es</loc><lastmod>{$tpsiIdxMod}</lastmod><priority>0.85</priority></url>\n";
    echo "  <url><loc>" . SITE_URL . "/tpsipedia.php?page=about</loc><lastmod>" . TPSI_ABOUT_UPDATED . "</lastmod><priority>0.60</priority></url>\n";
    echo "  <url><loc>" . SITE_URL . "/tpsipedia.php?page=about&amp;lang=es</loc><lastmod>" . TPSI_ABOUT_UPDATED . "</lastmod><priority>0.60</priority></url>\n";
    foreach ($tpsiPages as $p) {
        $lastmod = date('Y-m-d', strtotime($p['updated_at']));
        echo "  <url><loc>" . SITE_URL . '/tpsipedia.php?slug=' . urlencode($p['slug_en']) . "</loc><lastmod>{$lastmod}</lastmod><priority>0.90</priority></url>\n";
        echo "  <url><loc>" . SITE_URL . '/tpsipedia.php?slug=' . urlencode($p['slug_es']) . "&amp;lang=es</loc><lastmod>{$lastmod}</lastmod><priority>0.90</priority></url>\n";
    }
}

echo '</urlset>';
