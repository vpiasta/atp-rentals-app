<?php
// ── Link previews (Facebook, WhatsApp, X, LinkedIn, Telegram…) ───────────────
// 2026-11-27: pages had no og:image, so shared links showed no picture and
// only a short text. tps_og_meta() prints Open Graph + Twitter card tags.
// Default image: /images/og-default.jpg (1200×630, from "Traveler with tablet-1.png":
// a traveler browsing the directory on a tablet). One fixed image on purpose —
// Facebook/WhatsApp cache the first image they see, so rotating would not work.
if (!function_exists('tps_og_meta')) {
    function tps_og_meta(array $o) {
        $e = function ($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); };
        $lang  = ($o['lang'] ?? 'en') === 'es' ? 'es' : 'en';
        $img   = !empty($o['image']) ? $o['image'] : 'https://trustedpanamastays.com/images/og-default.jpg';
        $isDefaultImg = empty($o['image']);
        $alt   = $o['image_alt'] ?? ($lang === 'es'
            ? 'Viajera consultando en su tableta el directorio Trusted Panama Stays de hospedajes registrados en la ATP'
            : 'Traveler browsing the Trusted Panama Stays directory of ATP-registered lodging on a tablet');
        $out = [];
        $out[] = '<meta property="og:site_name" content="Trusted Panama Stays">';
        $out[] = '<meta property="og:type" content="' . $e($o['type'] ?? 'website') . '">';
        $out[] = '<meta property="og:title" content="' . $e($o['title'] ?? 'Trusted Panama Stays') . '">';
        $out[] = '<meta property="og:description" content="' . $e($o['description'] ?? '') . '">';
        if (!empty($o['url'])) $out[] = '<meta property="og:url" content="' . $e($o['url']) . '">';
        $out[] = '<meta property="og:locale" content="' . ($lang === 'es' ? 'es_PA' : 'en_US') . '">';
        $out[] = '<meta property="og:locale:alternate" content="' . ($lang === 'es' ? 'en_US' : 'es_PA') . '">';
        $out[] = '<meta property="og:image" content="' . $e($img) . '">';
        $out[] = '<meta property="og:image:secure_url" content="' . $e($img) . '">';
        if ($isDefaultImg) {
            $out[] = '<meta property="og:image:type" content="image/jpeg">';
            $out[] = '<meta property="og:image:width" content="1200">';
            $out[] = '<meta property="og:image:height" content="630">';
        }
        $out[] = '<meta property="og:image:alt" content="' . $e($alt) . '">';
        $out[] = '<meta name="twitter:card" content="summary_large_image">';
        $out[] = '<meta name="twitter:title" content="' . $e($o['title'] ?? 'Trusted Panama Stays') . '">';
        $out[] = '<meta name="twitter:description" content="' . $e($o['description'] ?? '') . '">';
        $out[] = '<meta name="twitter:image" content="' . $e($img) . '">';
        $out[] = '<meta name="twitter:image:alt" content="' . $e($alt) . '">';
        echo implode("\n    ", $out) . "\n";
    }
}
