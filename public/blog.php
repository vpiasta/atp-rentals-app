<?php
$lang  = isset($_GET['lang']) && $_GET['lang'] === 'es' ? 'es' : 'en';
$is_en = $lang === 'en';

$t = [
    'title'       => 'Blog - Trusted Panama Stays',
    'description' => $is_en ? 'Guides and news on legal short-term rentals and travel in Panama.' : 'Guías y noticias sobre hospedajes legalmente registrados y turismo en Panamá.',
    'canonical'   => $is_en ? 'https://trustedpanamastays.com/blog.php' : 'https://trustedpanamastays.com/blog.php?lang=es',
    'heading'     => 'Trusted Panama Stays',
    'subheading'  => $is_en ? 'Registered and verified hotels, apartments and vacation rentals in Panama' : 'Hoteles, apartamentos y alquileres vacacionales registrados y verificados en Panamá',
    'lang_href'   => $is_en ? 'blog.php?lang=es' : 'blog.php?lang=en',
    'page_h1'     => 'Blog',
    'page_intro'  => $is_en ? 'Guides on legal short-term rentals and travel in Panama.' : 'Guías sobre hospedajes legalmente registrados y turismo en Panamá.',
    'read_more'   => $is_en ? 'Read more →' : 'Leer más →',
    'no_posts'    => $is_en ? 'No posts published yet — check back soon.' : 'Aún no hay publicaciones — vuelva pronto.',
];

// Formats a publish date in the reader's language — e.g. "August 26, 2026"
// / "26 de agosto de 2026" — without relying on the server having the
// relevant locale installed (setlocale/strftime can silently no-op on
// shared hosting), so this is done by hand instead.
function format_blog_date($isoDate, $lang) {
    if (empty($isoDate)) return '';
    $ts = strtotime($isoDate);
    if (!$ts) return '';
    $monthsEn = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    $monthsEs = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    $day   = (int)date('j', $ts);
    $year  = date('Y', $ts);
    $month = (int)date('n', $ts) - 1;
    return $lang === 'es'
        ? "$day de {$monthsEs[$month]} de $year"
        : "{$monthsEn[$month]} $day, $year";
}

// ── Server-render the post list (SEO/crawler-safe, same pattern as index.php) ──
define('SUPABASE_URL', 'https://caqdkxukezpckqphogwl.supabase.co');
define('SUPABASE_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhcWRreHVrZXpwY2txcGhvZ3dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDc2MDIsImV4cCI6MjA5NjAyMzYwMn0.xqNuCWm_ALivBRpl3pSTDDJeoBN1WfX4-G_OJq2Sd8g');

function ssr_blog_posts($lang) {
    $select = "id,slug,title_$lang,excerpt_$lang,featured_image_url,category,published_at";
    $url = SUPABASE_URL . '/rest/v1/blog_posts?select=' . $select
         . '&status=eq.published&order=published_at.desc';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'apikey: ' . SUPABASE_KEY,
            'Authorization: Bearer ' . SUPABASE_KEY,
            'Accept: application/json',
        ],
        CURLOPT_TIMEOUT => 5,
        CURLOPT_SSL_VERIFYPEER => false,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    $data = json_decode($body, true);
    return is_array($data) ? $data : [];
}
$posts = ssr_blog_posts($lang);
?>
<!DOCTYPE html>
<html lang="<?= $lang ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars($t['title'], ENT_QUOTES, 'UTF-8') ?></title>
    <meta name="description" content="<?= htmlspecialchars($t['description'], ENT_QUOTES, 'UTF-8') ?>">
    <link rel="canonical" href="<?= $t['canonical'] ?>">
    <link rel="alternate" hreflang="en" href="https://trustedpanamastays.com/blog.php">
    <link rel="alternate" hreflang="es" href="https://trustedpanamastays.com/blog.php?lang=es">
    <link rel="alternate" hreflang="x-default" href="https://trustedpanamastays.com/blog.php">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="stylesheet" href="/css/site-header-footer.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #111; background: #f8f9fa; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .page-intro { background: white; padding: 1rem 1.2rem; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 1rem; }
        .page-intro h2 { color: #005ca9; margin-bottom: 0.4rem; }
        .blog-list { display: grid; gap: 16px; }
        .blog-card { background: white; border-radius: 10px; padding: 1.2rem; box-shadow: 0 2px 10px rgba(0,0,0,0.08); display: flex; gap: 1rem; align-items: flex-start; }
        .blog-card img { width: 160px; height: 110px; object-fit: cover; border-radius: 8px; flex-shrink: 0; }
        .blog-card-body { flex: 1; min-width: 0; }
        .blog-card h3 { font-size: 1.1rem; color: #005ca9; margin-bottom: 0.3rem; }
        .blog-card h3 a { color: inherit; text-decoration: none; }
        .blog-card h3 a:hover { text-decoration: underline; }
        .blog-card .cat { display: inline-block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #00a859; margin-bottom: 0.3rem; }
        .blog-card .date { display: inline-block; font-size: 0.72rem; color: #888; margin-bottom: 0.3rem; margin-left: 0.6rem; }
        .blog-card p { font-size: 0.9rem; color: #444; margin-bottom: 0.5rem; }
        .blog-card a.read-more { font-size: 0.85rem; font-weight: 600; color: #005ca9; text-decoration: none; }
        .no-results { text-align: center; padding: 2rem; background: white; border-radius: 10px; color: #666; }
        @media (max-width: 600px) {
            .blog-card { flex-direction: column; }
            .blog-card img { width: 100%; height: 160px; }
        }
    </style>
</head>
<body>
<div class="container">
    <?php
      $heading          = $t['heading'];
      $subheading       = $t['subheading'];
      $lang_toggle_href = $t['lang_href'];
      $show_atp_badge   = false;
      include __DIR__ . '/includes/header.php';
    ?>

    <div class="page-intro">
        <h2><?= htmlspecialchars($t['page_h1'], ENT_QUOTES, 'UTF-8') ?></h2>
        <p><?= htmlspecialchars($t['page_intro'], ENT_QUOTES, 'UTF-8') ?></p>
    </div>

    <section class="blog-list">
        <?php if (!empty($posts)): ?>
            <?php foreach ($posts as $p):
                $title   = $p["title_$lang"]  ?? '';
                $excerpt = $p["excerpt_$lang"] ?? '';
                $url     = 'blog-post.php?slug=' . urlencode($p['slug']) . '&lang=' . $lang;
                $dateStr = format_blog_date($p['published_at'] ?? null, $lang);
            ?>
            <article class="blog-card">
                <?php if (!empty($p['featured_image_url'])): ?>
                    <img src="<?= htmlspecialchars($p['featured_image_url'], ENT_QUOTES, 'UTF-8') ?>" alt="<?= htmlspecialchars($title, ENT_QUOTES, 'UTF-8') ?>" loading="lazy">
                <?php endif; ?>
                <div class="blog-card-body">
                    <?php if (!empty($p['category'])): ?><span class="cat"><?= htmlspecialchars($p['category'], ENT_QUOTES, 'UTF-8') ?></span><?php endif; ?>
                    <?php if ($dateStr): ?><span class="date"><?= htmlspecialchars($dateStr, ENT_QUOTES, 'UTF-8') ?></span><?php endif; ?>
                    <h3><a href="<?= $url ?>"><?= htmlspecialchars($title, ENT_QUOTES, 'UTF-8') ?></a></h3>
                    <p><?= htmlspecialchars($excerpt, ENT_QUOTES, 'UTF-8') ?></p>
                    <a class="read-more" href="<?= $url ?>"><?= $t['read_more'] ?></a>
                </div>
            </article>
            <?php endforeach; ?>
        <?php else: ?>
            <div class="no-results"><p><?= htmlspecialchars($t['no_posts'], ENT_QUOTES, 'UTF-8') ?></p></div>
        <?php endif; ?>
    </section>

    <?php include __DIR__ . '/includes/footer.php'; ?>
</div>
</body>
</html>
