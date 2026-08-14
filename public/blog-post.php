<?php
$lang  = isset($_GET['lang']) && $_GET['lang'] === 'es' ? 'es' : 'en';
$is_en = $lang === 'en';
$slug  = isset($_GET['slug']) ? trim($_GET['slug']) : '';

define('SUPABASE_URL', 'https://caqdkxukezpckqphogwl.supabase.co');
define('SUPABASE_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhcWRreHVrZXpwY2txcGhvZ3dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDc2MDIsImV4cCI6MjA5NjAyMzYwMn0.xqNuCWm_ALivBRpl3pSTDDJeoBN1WfX4-G_OJq2Sd8g');

// ── Preview mode: a random one-time token, minted by ──
// /api/admin/blog/:id/preview-link and stored in the blog_preview_tokens
// table. Checked here by querying Supabase directly (same pattern this
// file already uses to fetch the post itself) — no call back into the
// Node app.
function is_valid_preview_token($token) {
    if (!$token) return false;
    $url = SUPABASE_URL . '/rest/v1/blog_preview_tokens?select=id&token=eq.' . urlencode($token) . '&expires_at=gt.' . urlencode(date('c')) . '&limit=1';
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
    return is_array($data) && count($data) > 0;
}


$isPreview = is_valid_preview_token($_GET['preview'] ?? null);


function ssr_blog_post($slug, $allowUnpublished) {
    if ($slug === '') return null;
    $statusFilter = $allowUnpublished ? '' : '&status=eq.published';
    $url = SUPABASE_URL . '/rest/v1/blog_posts?select=*&slug=eq.' . urlencode($slug) . $statusFilter . '&limit=1';
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
    return (is_array($data) && count($data)) ? $data[0] : null;
}
$post = ssr_blog_post($slug, $isPreview);
if (!$post) http_response_code(404);

$title     = $post ? ($post["title_$lang"] ?? '')            : ($is_en ? 'Post not found' : 'Publicación no encontrada');
$excerpt   = $post ? ($post["excerpt_$lang"] ?? '')           : '';
$metaDesc  = $post ? ($post["meta_description_$lang"] ?? $excerpt) : ($is_en ? 'This blog post could not be found.' : 'No se encontró esta publicación.');
$bodyHtml  = $post ? ($post["body_$lang"] ?? '')               : '';
$category  = $post['category']            ?? null;
$published = $post['published_at']        ?? null;
$image     = $post['featured_image_url']  ?? null;

// Self-canonical, synchronous — computed purely from URL params, before the
// curl call above even resolves, so crawlers never race a JS-timed tag.
$canonical = 'https://trustedpanamastays.com/blog-post.php?slug=' . urlencode($slug) . ($is_en ? '' : '&lang=es');
?>
<!DOCTYPE html>
<html lang="<?= $lang ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars($title, ENT_QUOTES, 'UTF-8') ?> - Trusted Panama Stays</title>
    <meta name="description" content="<?= htmlspecialchars($metaDesc, ENT_QUOTES, 'UTF-8') ?>">
    <link rel="canonical" href="<?= htmlspecialchars($canonical, ENT_QUOTES, 'UTF-8') ?>">
    <?php if ($post && !$isPreview): ?>
    <link rel="alternate" hreflang="en" href="https://trustedpanamastays.com/blog-post.php?slug=<?= urlencode($slug) ?>">
    <link rel="alternate" hreflang="es" href="https://trustedpanamastays.com/blog-post.php?slug=<?= urlencode($slug) ?>&lang=es">
    <link rel="alternate" hreflang="x-default" href="https://trustedpanamastays.com/blog-post.php?slug=<?= urlencode($slug) ?>">
    <?php else: ?>
    <meta name="robots" content="noindex">
    <?php endif; ?>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="stylesheet" href="/css/site-header-footer.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #111; background: #f8f9fa; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .post-header { background: white; padding: 1.4rem; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 1rem; }
        .post-header .cat { display: inline-block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #00a859; margin-bottom: 0.4rem; }
        .post-header h1 { font-size: 1.6rem; color: #111; margin-bottom: 0.4rem; }
        .post-header .meta { font-size: 0.82rem; color: #888; }
        .post-image { width: 100%; max-height: 360px; object-fit: cover; border-radius: 10px; margin-bottom: 1rem; }
        .post-body { background: white; padding: 1.4rem; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 1rem; font-size: 1rem; }
        .post-body h2 { color: #005ca9; margin: 1.4rem 0 0.6rem; font-size: 1.25rem; }
        .post-body h3 { color: #005ca9; margin: 1.1rem 0 0.5rem; font-size: 1.05rem; }
        .post-body p { margin-bottom: 0.9rem; }
        .post-body ul, .post-body ol { margin: 0 0 0.9rem 1.4rem; }
        .post-body a { color: #005ca9; }
        .back-link { display: inline-block; margin-bottom: 1rem; color: #005ca9; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
        .not-found { background: white; padding: 2rem; border-radius: 10px; text-align: center; }
    </style>
    <?php if ($post && !$isPreview): ?>
    <script type="application/ld+json">
    <?= json_encode([
        "@context" => "https://schema.org",
        "@type" => "BlogPosting",
        "headline" => $title,
        "description" => $metaDesc,
        "datePublished" => $published,
        "image" => $image ?: null,
        "author" => ["@type" => "Organization", "name" => "Trusted Panama Stays"],
        "publisher" => ["@type" => "Organization", "name" => "Trusted Panama Stays"],
        "mainEntityOfPage" => $canonical
    ], JSON_UNESCAPED_SLASHES) ?>
    </script>
    <?php endif; ?>
</head>
<body>
<div class="container">
    <?php
      $heading          = 'Trusted Panama Stays';
      $subheading       = $is_en ? 'Registered and verified hotels, apartments and vacation rentals in Panama' : 'Hoteles, apartamentos y alquileres vacacionales registrados y verificados en Panamá';
      $lang_toggle_href = 'blog-post.php?slug=' . urlencode($slug) . ($is_en ? '&lang=es' : '&lang=en');
      $show_atp_badge   = false;
      include __DIR__ . '/includes/header.php';
    ?>

    <a class="back-link" href="blog.php?lang=<?= $lang ?>">&larr; <?= $is_en ? 'Back to Blog' : 'Volver al Blog' ?></a>

    <?php if ($post && $isPreview): ?>
        <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:0.8rem 1rem;margin-bottom:1rem;font-size:0.9rem;color:#856404;">
            👁️ <strong><?= $is_en ? 'PREVIEW MODE' : 'MODO VISTA PREVIA' ?></strong> — <?= $is_en ? 'status:' : 'estado:' ?> <?= htmlspecialchars($post['status'], ENT_QUOTES, 'UTF-8') ?>.
            <?php if ($post['status'] === 'published'): ?>
                <?= $is_en ? 'This post is already live and public at the normal URL — you\'re just viewing it via a preview link right now.' : 'Esta publicación ya está en vivo y es pública en la URL normal — solo la está viendo mediante un enlace de vista previa.' ?>
            <?php else: ?>
                <?= $is_en ? 'Not visible to the public yet.' : 'Aún no es visible al público.' ?>
            <?php endif; ?>
        </div>
    <?php endif; ?>

    <?php if ($post): ?>
        <div class="post-header">
            <?php if ($category): ?><span class="cat"><?= htmlspecialchars($category, ENT_QUOTES, 'UTF-8') ?></span><?php endif; ?>
            <h1><?= htmlspecialchars($title, ENT_QUOTES, 'UTF-8') ?></h1>
            <?php if ($published): ?><div class="meta"><?= date('F j, Y', strtotime($published)) ?></div><?php endif; ?>
        </div>
        <?php if ($image): ?><img class="post-image" src="<?= htmlspecialchars($image, ENT_QUOTES, 'UTF-8') ?>" alt="<?= htmlspecialchars($title, ENT_QUOTES, 'UTF-8') ?>"><?php endif; ?>
        <div class="post-body"><?= $bodyHtml ?></div>
    <?php else: ?>
        <div class="not-found">
            <p><?= $is_en ? 'This post could not be found.' : 'No se encontró esta publicación.' ?></p>
        </div>
    <?php endif; ?>

    <?php include __DIR__ . '/includes/footer.php'; ?>
</div>
</body>
</html>
