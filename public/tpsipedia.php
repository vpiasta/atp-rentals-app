<?php
/**
 * TPSipedia — short, authoritative Q&A pages on Panama's short-term rental law.
 *
 *   /tpsipedia.php                      → index of all questions (EN)
 *   /tpsipedia.php?lang=es              → index (ES)
 *   /tpsipedia.php?slug=<slug_en>       → one question (EN)
 *   /tpsipedia.php?slug=<slug_es>&lang=es → one question (ES)
 *
 * Content lives in the Supabase table tpsipedia_pages (anon can read published rows only).
 * Placeholders like {{REG_TOTAL}} in the stored text are filled live from the ATP registry
 * that TPS imports daily (RPC tpsipedia_registry_stats), so the numbers never go stale.
 */
require_once __DIR__ . '/includes/supabase-config.php';

$lang  = isset($_GET['lang']) && $_GET['lang'] === 'es' ? 'es' : 'en';
$is_en = $lang === 'en';
$slug  = isset($_GET['slug']) ? trim($_GET['slug']) : '';
$SITE  = 'https://trustedpanamastays.com';

// ── Dates: day first, month written out ("26 October 2026" / "26 de octubre de 2026") ──
function tpsi_date($iso, $lang) {
    $ts = $iso ? strtotime($iso) : false;
    if (!$ts) return '';
    $en = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    $es = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    $d = (int)date('j', $ts); $m = (int)date('n', $ts) - 1; $y = date('Y', $ts);
    return $lang === 'es' ? "$d de {$es[$m]} de $y" : "$d {$en[$m]} $y";
}

function tpsi_get($path) {
    [$code, $data] = supabase_request('GET', $path, SUPABASE_KEY);
    return ($code >= 200 && $code < 300 && is_array($data)) ? $data : [];
}

// ── Live registry numbers (aggregates only) ──
function tpsi_stats() {
    [$code, $data] = supabase_request('POST', '/rest/v1/rpc/tpsipedia_registry_stats', SUPABASE_KEY, new stdClass());
    if ($code >= 200 && $code < 300 && is_array($data) && !empty($data['total'])) return $data;
    // Fallback: last known values (ATP report of 2 Oct 2026, synced 25 Oct 2026) if the RPC is unreachable.
    return ['total' => 1243, 'synced_at' => '2026-10-25',
            'by_type' => ['Hotel' => 333, 'Hostal Familiar' => 427, 'Residencial' => 143, 'Cabaña' => 106, 'Bungalow' => 56],
            'report_url' => 'https://www.atp.gob.pa/wp-content/uploads/2026/10/3.REPORTE-HOSPEDAJES-VIGENTE-2-10-2026.pdf',
            'report_date' => '2-10-2026'];
}

// ATP report date comes as "2-10-2026" (day-month-year) → "2026-10-02"
function tpsi_report_iso($stats) {
    $d = DateTime::createFromFormat('!j-n-Y', (string)($stats['report_date'] ?? ''));
    return $d ? $d->format('Y-m-d') : null;
}

// The ATP PDF the live numbers come from, as a source entry (title in the page language)
function tpsi_report_source($stats, $lang) {
    $url = $stats['report_url'] ?? '';
    if ($url === '') return null;
    $date = tpsi_date(tpsi_report_iso($stats), $lang);
    return [
        'title'     => $lang === 'es'
            ? 'ATP, Reporte de hospedajes vigentes' . ($date ? ", edición del $date" : '') . ' (PDF)'
            : 'ATP, Reporte de hospedajes vigentes (registry of licensed lodgings)' . ($date ? ", edition of $date" : '') . ' (PDF)',
        'publisher' => 'Autoridad de Turismo de Panamá',
        'url'       => $url,
        'primary'   => true,
    ];
}

function tpsi_fill($text, $stats, $page, $lang) {
    $t = $stats['by_type'] ?? [];
    $n = function ($v) { return number_format((int)$v); };
    $map = [
        '{{REG_TOTAL}}'           => $n($stats['total'] ?? 0),
        '{{REG_HOTEL}}'           => $n($t['Hotel'] ?? 0),
        '{{REG_HOSTAL_FAMILIAR}}' => $n($t['Hostal Familiar'] ?? 0),
        '{{REG_RESIDENCIAL}}'     => $n($t['Residencial'] ?? 0),
        '{{REG_CABANA}}'          => $n($t['Cabaña'] ?? 0),
        '{{REG_BUNGALOW}}'        => $n($t['Bungalow'] ?? 0),
        '{{REG_DATE}}'            => tpsi_date($stats['synced_at'] ?? null, $lang),
        '{{STATUS_DATE}}'         => tpsi_date($page['status_date'] ?? $page['updated_at'] ?? null, $lang),
        '{{REG_REPORT_URL}}'      => htmlspecialchars($stats['report_url'] ?? '', ENT_QUOTES, 'UTF-8'),
        '{{REG_REPORT_DATE}}'     => tpsi_date(tpsi_report_iso($stats), $lang),
        '{{REG_REPORT_LINK}}'     => empty($stats['report_url']) ? '' :
            '<a href="' . htmlspecialchars($stats['report_url'], ENT_QUOTES, 'UTF-8') . '" target="_blank" rel="noopener">'
            . ($lang === 'es' ? 'Reporte de hospedajes vigentes de la ATP' : 'ATP report of licensed lodgings')
            . ' (' . tpsi_date(tpsi_report_iso($stats), $lang) . ', PDF)</a>',
    ];
    return strtr($text, $map);
}

function tpsi_url($slug, $lang) {
    return 'https://trustedpanamastays.com/tpsipedia.php' . ($slug !== '' ? '?slug=' . urlencode($slug) . ($lang === 'es' ? '&lang=es' : '') : ($lang === 'es' ? '?lang=es' : ''));
}

function tpsi_plain($html) {
    return trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8')));
}

$L = $is_en ? [
    'section'     => 'TPSipedia',
    'tagline'     => 'Short, sourced answers about the law on tourist rentals in Panama',
    'index_intro' => 'Each page answers one question about short-term and tourist rentals in Panama in a few sentences, then gives the legal basis, the exact articles and the primary sources. Pages are checked against the official texts and updated when the law or a bill changes.',
    'search_ph'   => 'Search questions…',
    'no_match'    => 'No question matches your search.',
    'read_full'   => 'Read the full answer →',
    'short'       => 'Short answer',
    'updated'     => 'Updated',
    'checked'     => 'Checked against the primary legal texts cited below.',
    'faq'         => 'Frequently asked questions',
    'sources'     => 'Sources',
    'primary'     => 'Primary legal texts',
    'press'       => 'Press and other sources',
    'related'     => 'Read more on our blog',
    'cta'         => 'Search the directory of ATP-registered lodgings →',
    'disclaimer'  => 'This page explains the law in general terms. We are not lawyers; for your specific case, consult a lawyer or certified public accountant familiar with Panama\'s tourism and tax rules.',
    'not_found'   => 'This question could not be found.',
    'all'         => 'All questions',
    'back'        => '← All TPSipedia questions',
] : [
    'section'     => 'TPSipedia',
    'tagline'     => 'Respuestas breves y con fuentes sobre la ley de alquileres turísticos en Panamá',
    'index_intro' => 'Cada página responde una pregunta sobre los alquileres turísticos y de corta estancia en Panamá en pocas frases, y luego da la base legal, los artículos exactos y las fuentes primarias. Las páginas se verifican contra los textos oficiales y se actualizan cuando cambia la ley o un proyecto de ley.',
    'search_ph'   => 'Buscar preguntas…',
    'no_match'    => 'Ninguna pregunta coincide con su búsqueda.',
    'read_full'   => 'Leer la respuesta completa →',
    'short'       => 'Respuesta corta',
    'updated'     => 'Actualizado',
    'checked'     => 'Verificado contra los textos legales primarios citados abajo.',
    'faq'         => 'Preguntas frecuentes',
    'sources'     => 'Fuentes',
    'primary'     => 'Textos legales primarios',
    'press'       => 'Prensa y otras fuentes',
    'related'     => 'Para profundizar en nuestro blog',
    'cta'         => 'Buscar en el directorio de hospedajes registrados ante la ATP →',
    'disclaimer'  => 'Esta página explica la ley en términos generales. No somos abogados; para su caso particular, consulte a un abogado o contador público autorizado con experiencia en las normas turísticas y fiscales de Panamá.',
    'not_found'   => 'No se encontró esta pregunta.',
    'all'         => 'Todas las preguntas',
    'back'        => '← Todas las preguntas de TPSipedia',
];

$page = null;
$pages = [];

// ── Preview of a draft: ?preview=<token> minted by /api/admin/tpsipedia/:id/preview-link ──
// Checked with the server-side secret key (tokens are not readable with the public key).
$previewToken = isset($_GET['preview']) ? preg_replace('/[^a-f0-9]/', '', $_GET['preview']) : '';
$isPreview = false;
if ($previewToken !== '' && SUPABASE_SERVICE_KEY) {
    [$c, $tok] = supabase_request('GET', '/rest/v1/tpsipedia_preview_tokens?select=page_id&token=eq.' . $previewToken
        . '&expires_at=gt.' . urlencode(date('c')) . '&limit=1', SUPABASE_SERVICE_KEY);
    if ($c === 200 && !empty($tok[0]['page_id'])) {
        [$c, $rows] = supabase_request('GET', '/rest/v1/tpsipedia_pages?select=*&id=eq.' . (int)$tok[0]['page_id'] . '&limit=1', SUPABASE_SERVICE_KEY);
        if ($c === 200 && !empty($rows[0])) { $page = $rows[0]; $isPreview = true; }
    }
}

if ($isPreview) {
    // page already loaded above
} elseif ($slug !== '') {
    $col  = $is_en ? 'slug_en' : 'slug_es';
    $rows = tpsi_get('/rest/v1/tpsipedia_pages?select=*&status=eq.published&' . $col . '=eq.' . urlencode($slug) . '&limit=1');
    if (!$rows) {
        // Slug from the other language: redirect to this language's own slug.
        $other = $is_en ? 'slug_es' : 'slug_en';
        $alt = tpsi_get('/rest/v1/tpsipedia_pages?select=slug_en,slug_es&status=eq.published&' . $other . '=eq.' . urlencode($slug) . '&limit=1');
        if ($alt) { header('Location: ' . tpsi_url($alt[0][$col], $lang), true, 301); exit; }
        http_response_code(404);
    } else {
        $page = $rows[0];
    }
} else {
    $pages = tpsi_get('/rest/v1/tpsipedia_pages?select=slug_en,slug_es,category_en,category_es,question_en,question_es,short_answer_en,short_answer_es,sort_order,updated_at&status=eq.published&order=sort_order.asc,id.asc');
}
$stats = tpsi_stats();

// ── Per-mode values ──
if ($page) {
    $q         = $page["question_$lang"];
    $short     = tpsi_fill($page["short_answer_$lang"], $stats, $page, $lang);
    $body      = tpsi_fill($page["body_$lang"] ?? '', $stats, $page, $lang);
    $faq       = array_map(function ($f) use ($stats, $page, $lang) {
                    return ['q' => $f['q'], 'a' => tpsi_fill($f['a'], $stats, $page, $lang)];
                 }, $page["faq_$lang"] ?? []);
    $related   = $page["related_$lang"] ?? [];
    $sources   = array_map(function ($s) use ($stats, $page, $lang) {      // placeholders allowed in sources too
                    $s['url']   = html_entity_decode(tpsi_fill($s['url'] ?? '', $stats, $page, $lang), ENT_QUOTES, 'UTF-8');
                    $s['title'] = tpsi_plain(tpsi_fill($s['title'] ?? '', $stats, $page, $lang));
                    return $s;
                 }, $page['sources'] ?? []);
    // A page that shows live registry numbers always cites the ATP PDF they come from
    $repSrc = tpsi_report_source($stats, $lang);
    if ($repSrc && strpos(json_encode($page, JSON_UNESCAPED_UNICODE), '{{REG_') !== false
        && !in_array($repSrc['url'], array_column($sources, 'url'), true)) {
        $sources[] = $repSrc;
    }
    $category  = $page["category_$lang"] ?? '';
    $title     = $q . ' (' . date('Y', strtotime($page['updated_at'])) . ') | TPSipedia';
    $metaDesc  = $page["meta_description_$lang"] ?: tpsi_plain($short);
    $canonical = tpsi_url($page["slug_$lang"], $lang);
    $altEn     = tpsi_url($page['slug_en'], 'en');
    $altEs     = tpsi_url($page['slug_es'], 'es');
    $toggle    = ($is_en ? $altEs : $altEn) . ($isPreview ? '&preview=' . $previewToken : '');
} elseif ($slug === '') {
    // Bing limits: title ≤ 70 characters, meta description 25–160 characters.
    $title     = $is_en ? 'TPSipedia: Panama tourist rental law, answered'
                        : 'TPSipedia: ley de alquileres turísticos en Panamá';
    $metaDesc  = $is_en ? 'Short, sourced answers on Airbnb-style and tourist rentals in Panama: ATP registration, the 45-day rule, ITBMS and pending bills.'
                        : 'Respuestas breves y con fuentes sobre alquileres turísticos tipo Airbnb en Panamá: registro ATP, regla de 45 días, ITBMS y proyectos de ley.';
    $canonical = tpsi_url('', $lang);
    $altEn     = tpsi_url('', 'en');
    $altEs     = tpsi_url('', 'es');
    $toggle    = $is_en ? $altEs : $altEn;
} else {
    $title     = $L['not_found'] . ' | TPSipedia';
    $metaDesc  = $L['not_found'];
    $canonical = tpsi_url('', $lang);
    $toggle    = tpsi_url('', $is_en ? 'es' : 'en');
}

// ── Structured data ──
$publisher = [
    '@type' => 'Organization',
    'name'  => 'Trusted Panama Stays',
    'url'   => $SITE . '/',
    'logo'  => $SITE . '/images/android-chrome-512x512.png',
];
$jsonld = null;
if ($page) {
    $faqEntities = [[
        '@type' => 'Question',
        'name'  => $q,
        'acceptedAnswer' => ['@type' => 'Answer', 'text' => $short],
    ]];
    foreach ($faq as $f) {
        $faqEntities[] = ['@type' => 'Question', 'name' => $f['q'], 'acceptedAnswer' => ['@type' => 'Answer', 'text' => $f['a']]];
    }
    $jsonld = [
        '@context' => 'https://schema.org',
        '@graph'   => [
            [
                '@type'            => 'Article',
                '@id'              => $canonical . '#article',
                'headline'         => $q,
                'description'      => $metaDesc,
                'abstract'         => tpsi_plain($short),
                'inLanguage'       => $is_en ? 'en' : 'es',
                'datePublished'    => $page['published_at'] ?: $page['created_at'],
                'dateModified'     => $page['updated_at'],
                'author'           => $publisher,
                'publisher'        => $publisher,
                'mainEntityOfPage' => $canonical,
                'isPartOf'         => ['@type' => 'CollectionPage', 'name' => 'TPSipedia', 'url' => tpsi_url('', $lang)],
                'about'            => ['@type' => 'Place', 'name' => 'Panama'],
                'citation'         => array_map(function ($s) {
                                          return ['@type' => 'CreativeWork', 'name' => $s['title'], 'url' => $s['url'], 'publisher' => $s['publisher'] ?? null];
                                      }, $sources),
            ],
            [
                '@type'      => 'FAQPage',
                '@id'        => $canonical . '#faq',
                'inLanguage' => $is_en ? 'en' : 'es',
                'mainEntity' => $faqEntities,
            ],
            [
                '@type' => 'BreadcrumbList',
                'itemListElement' => [
                    ['@type' => 'ListItem', 'position' => 1, 'name' => 'Trusted Panama Stays', 'item' => $SITE . '/' . ($is_en ? '' : 'index.php?lang=es')],
                    ['@type' => 'ListItem', 'position' => 2, 'name' => 'TPSipedia', 'item' => tpsi_url('', $lang)],
                    ['@type' => 'ListItem', 'position' => 3, 'name' => $q, 'item' => $canonical],
                ],
            ],
        ],
    ];
} elseif ($slug === '' && $pages) {
    $jsonld = [
        '@context'   => 'https://schema.org',
        '@type'      => 'CollectionPage',
        'name'       => 'TPSipedia',
        'description'=> $metaDesc,
        'url'        => $canonical,
        'inLanguage' => $is_en ? 'en' : 'es',
        'publisher'  => $publisher,
        'mainEntity' => [
            '@type' => 'ItemList',
            'itemListElement' => array_values(array_map(function ($p, $i) use ($lang) {
                return ['@type' => 'ListItem', 'position' => $i + 1, 'name' => $p["question_$lang"], 'url' => tpsi_url($p["slug_$lang"], $lang)];
            }, $pages, array_keys($pages))),
        ],
    ];
}
$e = function ($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); };
?>
<!DOCTYPE html>
<html lang="<?= $lang ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= $e($title) ?></title>
    <meta name="description" content="<?= $e($metaDesc) ?>">
    <link rel="canonical" href="<?= $e($canonical) ?>">
    <?php if ($isPreview): ?>
    <meta name="robots" content="noindex">
    <?php elseif ($page || $slug === ''): ?>
    <link rel="alternate" hreflang="en" href="<?= $e($altEn) ?>">
    <link rel="alternate" hreflang="es" href="<?= $e($altEs) ?>">
    <link rel="alternate" hreflang="x-default" href="<?= $e($altEn) ?>">
    <meta property="og:type" content="<?= $page ? 'article' : 'website' ?>">
    <meta property="og:title" content="<?= $e($page ? $q : 'TPSipedia') ?>">
    <meta property="og:description" content="<?= $e($metaDesc) ?>">
    <meta property="og:url" content="<?= $e($canonical) ?>">
    <meta property="og:site_name" content="Trusted Panama Stays">
    <?php if ($page): ?><meta property="article:modified_time" content="<?= $e($page['updated_at']) ?>"><?php endif; ?>
    <?php else: ?>
    <meta name="robots" content="noindex">
    <?php endif; ?>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="stylesheet" href="/css/site-header-footer.css">
    <?php if ($jsonld): ?>
    <script type="application/ld+json"><?= json_encode($jsonld, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?></script>
    <?php endif; ?>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.65; color: #111; background: #f8f9fa; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .card { background: #fff; padding: 1.4rem; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 1rem; }
        .crumbs { font-size: 0.82rem; color: #666; margin-bottom: 0.8rem; }
        .crumbs a { color: #005ca9; text-decoration: none; }
        .crumbs a:hover { text-decoration: underline; }
        .kicker { display: inline-block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #00a859; margin-bottom: 0.3rem; }
        h1.q { font-size: 1.65rem; line-height: 1.3; color: #111; margin-bottom: 0.9rem; }
        .answer-box { border-left: 5px solid #005ca9; background: #f0f6fb; padding: 1rem 1.1rem; border-radius: 0 8px 8px 0; font-size: 1.05rem; }
        .answer-box .label { display: block; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #005ca9; margin-bottom: 0.3rem; }
        .meta { font-size: 0.82rem; color: #777; margin-top: 0.8rem; }
        .content h2 { color: #005ca9; margin: 1.5rem 0 0.6rem; font-size: 1.25rem; }
        .content h2:first-child { margin-top: 0; }
        .content h3 { color: #005ca9; margin: 1.2rem 0 0.35rem; font-size: 1.05rem; }
        .content p { margin-bottom: 0.9rem; }
        .content ul, .content ol { margin: 0 0 0.9rem 1.4rem; }
        .content li { margin-bottom: 0.35rem; }
        .content a { color: #005ca9; }
        .table-wrap { overflow-x: auto; margin-bottom: 0.9rem; }
        .content table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
        .content th, .content td { border: 1px solid #dde3ea; padding: 0.5rem 0.6rem; text-align: left; vertical-align: top; }
        .content th { background: #f0f6fb; color: #005ca9; }
        .faq-item { padding: 0.2rem 0 0.4rem; border-bottom: 1px solid #eef1f4; }
        .faq-item:last-child { border-bottom: none; }
        .sources ol { margin-left: 1.4rem; font-size: 0.9rem; }
        .sources li { margin-bottom: 0.4rem; }
        .sources .pub { color: #777; }
        .related ul { margin-left: 1.2rem; }
        .cta { display: inline-block; background: #005ca9; color: #fff; text-decoration: none; padding: 0.6rem 1rem; border-radius: 8px; font-weight: 600; }
        .cta:hover { background: #004a88; }
        .disclaimer { font-size: 0.82rem; color: #666; font-style: italic; }
        .search { width: 100%; padding: 0.7rem 0.9rem; border: 1px solid #ccd5df; border-radius: 8px; font-size: 1rem; margin-top: 0.9rem; font-family: inherit; }
        .cat-title { color: #005ca9; font-size: 1.15rem; margin: 0.4rem 0 0.6rem; }
        .q-card { padding: 0.9rem 0; border-bottom: 1px solid #eef1f4; }
        .q-card:last-child { border-bottom: none; }
        .q-card h2 { font-size: 1.05rem; margin-bottom: 0.25rem; }
        .q-card h2 a { color: #111; text-decoration: none; }
        .q-card h2 a:hover { color: #005ca9; text-decoration: underline; }
        .q-card p { font-size: 0.92rem; color: #444; margin-bottom: 0.3rem; }
        .q-card .more { font-size: 0.85rem; font-weight: 600; color: #005ca9; text-decoration: none; }
        .no-match { display: none; color: #666; padding: 0.5rem 0; }
        @media (max-width: 600px) { h1.q { font-size: 1.35rem; } .card { padding: 1.1rem; } }
    </style>
</head>
<body>
<div class="container">
    <?php
      $heading          = 'Trusted Panama Stays';
      $subheading       = $is_en ? 'Registered and verified hotels, apartments and vacation rentals in Panama' : 'Hoteles, apartamentos y alquileres vacacionales registrados y verificados en Panamá';
      $lang_toggle_href = $toggle;
      $show_atp_badge   = false;
      $header_title_tag = 'div'; // this page has its own <h1>
      include __DIR__ . '/includes/header.php';
    ?>

<?php if ($page): ?>
    <?php if ($isPreview): ?>
    <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:0.8rem 1rem;margin-bottom:1rem;font-size:0.9rem;color:#856404;">
        👁️ <strong><?= $is_en ? 'PREVIEW' : 'VISTA PREVIA' ?></strong> — <?= $is_en ? 'status' : 'estado' ?>: <?= $e($page['status']) ?>.
        <?= $page['status'] === 'published'
            ? ($is_en ? 'This page is live; this view shows the saved version.' : 'Esta página está publicada; aquí se ve la versión guardada.')
            : ($is_en ? 'Not visible to the public yet.' : 'Aún no es visible al público.') ?>
    </div>
    <?php endif; ?>
    <nav class="crumbs" aria-label="Breadcrumb">
        <a href="<?= $is_en ? '/' : '/index.php?lang=es' ?>">Trusted Panama Stays</a> ›
        <a href="<?= $e(tpsi_url('', $lang)) ?>">TPSipedia</a> ›
        <span><?= $e($q) ?></span>
    </nav>

    <article>
        <div class="card">
            <?php if ($category): ?><span class="kicker"><?= $e($category) ?></span><?php endif; ?>
            <h1 class="q"><?= $e($q) ?></h1>
            <div class="answer-box">
                <span class="label"><?= $L['short'] ?></span>
                <p><?= $short ?></p>
            </div>
            <p class="meta">
                <?= $L['updated'] ?>: <time datetime="<?= $e(substr($page['updated_at'], 0, 10)) ?>"><?= tpsi_date($page['updated_at'], $lang) ?></time>
                · <?= $L['checked'] ?>
            </p>
        </div>

        <?php if (trim($body) !== ''): ?>
        <div class="card content"><?= $body ?></div>
        <?php endif; ?>

        <?php if ($faq): ?>
        <section class="card content" id="faq">
            <h2><?= $L['faq'] ?></h2>
            <?php foreach ($faq as $f): ?>
            <div class="faq-item">
                <h3><?= $e($f['q']) ?></h3>
                <p><?= $f['a'] ?></p>
            </div>
            <?php endforeach; ?>
        </section>
        <?php endif; ?>

        <div class="card">
            <p class="disclaimer"><?= $L['disclaimer'] ?></p>
            <p style="margin-top:0.9rem;"><a class="cta" href="<?= $is_en ? '/' : '/index.php?lang=es' ?>"><?= $L['cta'] ?></a></p>
        </div>

        <?php if ($sources): ?>
        <section class="card content sources" id="sources">
            <h2><?= $L['sources'] ?></h2>
            <?php foreach ([true, false] as $isPrimary):
                $group = array_values(array_filter($sources, function ($s) use ($isPrimary) { return !empty($s['primary']) === $isPrimary; }));
                if (!$group) continue; ?>
                <h3><?= $isPrimary ? $L['primary'] : $L['press'] ?></h3>
                <ol>
                <?php foreach ($group as $s): ?>
                    <li><a href="<?= $e($s['url']) ?>" target="_blank" rel="noopener"><?= $e($s['title']) ?></a><?php if (!empty($s['publisher'])): ?> <span class="pub">— <?= $e($s['publisher']) ?></span><?php endif; ?></li>
                <?php endforeach; ?>
                </ol>
            <?php endforeach; ?>
        </section>
        <?php endif; ?>

        <?php if ($related): ?>
        <section class="card content related">
            <h2><?= $L['related'] ?></h2>
            <ul>
            <?php foreach ($related as $r): ?>
                <li><a href="<?= $e($r['url']) ?>"><?= $e($r['title']) ?></a></li>
            <?php endforeach; ?>
            </ul>
        </section>
        <?php endif; ?>
    </article>

    <p><a class="crumbs" style="font-weight:600;color:#005ca9;text-decoration:none;" href="<?= $e(tpsi_url('', $lang)) ?>"><?= $L['back'] ?></a></p>

<?php elseif ($slug === ''): ?>
    <div class="card">
        <h1 class="q" style="margin-bottom:0.3rem;">TPSipedia</h1>
        <p style="color:#005ca9;font-weight:600;margin-bottom:0.6rem;"><?= $L['tagline'] ?></p>
        <p><?= $L['index_intro'] ?></p>
        <input type="search" class="search" id="tpsi-search" placeholder="<?= $L['search_ph'] ?>" aria-label="<?= $L['search_ph'] ?>">
    </div>

    <?php
      $byCat = [];
      foreach ($pages as $p) { $byCat[$p["category_$lang"] ?: $L['all']][] = $p; }
    ?>
    <?php foreach ($byCat as $cat => $items): ?>
    <section class="card tpsi-cat">
        <h2 class="cat-title"><?= $e($cat) ?></h2>
        <?php foreach ($items as $p):
            $url  = tpsi_url($p["slug_$lang"], $lang);
            $sa   = tpsi_plain(tpsi_fill($p["short_answer_$lang"], $stats, $p, $lang)); ?>
        <div class="q-card" data-text="<?= $e(mb_strtolower($p["question_$lang"] . ' ' . $sa)) ?>">
            <h2><a href="<?= $e($url) ?>"><?= $e($p["question_$lang"]) ?></a></h2>
            <p><?= $e($sa) ?></p>
            <a class="more" href="<?= $e($url) ?>"><?= $L['read_full'] ?></a>
        </div>
        <?php endforeach; ?>
    </section>
    <?php endforeach; ?>
    <p class="no-match card" id="tpsi-none"><?= $L['no_match'] ?></p>

    <div class="card"><p class="disclaimer"><?= $L['disclaimer'] ?></p></div>

    <script>
    (function () {
        var box = document.getElementById('tpsi-search');
        if (!box) return;
        box.addEventListener('input', function () {
            var words = box.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
            var shown = 0;
            document.querySelectorAll('.tpsi-cat').forEach(function (sec) {
                var any = 0;
                sec.querySelectorAll('.q-card').forEach(function (c) {
                    var t = c.getAttribute('data-text');
                    var ok = words.every(function (w) { return t.indexOf(w) !== -1; });
                    c.style.display = ok ? '' : 'none';
                    if (ok) any++;
                });
                sec.style.display = any ? '' : 'none';
                shown += any;
            });
            document.getElementById('tpsi-none').style.display = shown ? 'none' : 'block';
        });
    })();
    </script>

<?php else: ?>
    <div class="card"><p><?= $L['not_found'] ?></p><p style="margin-top:0.6rem;"><a href="<?= $e(tpsi_url('', $lang)) ?>"><?= $L['back'] ?></a></p></div>
<?php endif; ?>

    <?php include __DIR__ . '/includes/footer.php'; ?>
</div>
</body>
</html>
