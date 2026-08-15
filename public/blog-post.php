<?php
//ini_set('display_errors', '1');
//error_reporting(E_ALL);
$lang  = isset($_GET['lang']) && $_GET['lang'] === 'es' ? 'es' : 'en';
$is_en = $lang === 'en';
$slug  = isset($_GET['slug']) ? trim($_GET['slug']) : '';
require_once __DIR__ . '/includes/supabase-config.php';
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
    $key = $allowUnpublished ? SUPABASE_SERVICE_KEY : SUPABASE_KEY;
    $url = SUPABASE_URL . '/rest/v1/blog_posts?select=*&slug=eq.' . urlencode($slug) . $statusFilter . '&limit=1';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'apikey: ' . $key,
            'Authorization: Bearer ' . $key,
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
function ssr_blog_comments($postId) {
    $url = SUPABASE_URL . '/rest/v1/blog_comments?select=*&post_id=eq.' . urlencode($postId) . '&status=eq.approved&order=created_at.asc';
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
$post = ssr_blog_post($slug, $isPreview);
if (!$post) http_response_code(404);
$comments = $post ? ssr_blog_comments($post['id']) : [];
$topLevelComments = array_values(array_filter($comments, function($c) { return empty($c['parent_comment_id']); }));
$repliesByParent = [];
foreach ($comments as $c) {
    if (!empty($c['parent_comment_id'])) {
        $repliesByParent[$c['parent_comment_id']][] = $c;
    }
}
$replyTo    = $_GET['reply_to']    ?? '';
$replyToken = $_GET['reply_token'] ?? '';
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
        html { scroll-behavior: smooth; }
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
        .comments-section { background: white; padding: 1.4rem; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 1rem; }
        .comments-section h2 { color: #005ca9; font-size: 1.2rem; margin-bottom: 1rem; }
        .comment { border: 1px solid #ddd; border-radius: 10px; padding: 1rem; margin-bottom: 12px; }
        .comment .c-meta { margin-bottom: 0.4rem; }
        .comment .c-name { font-weight: 600; }
        .comment .c-date { font-size: 0.78rem; color: #999; }
        .comment .c-body { margin-bottom: 0.5rem; white-space: pre-wrap; }
        .comment-reply { margin-left: 1.5rem; padding: 0.8rem; background: #f0f6fb; border-radius: 8px; margin-top: 0.6rem; }
        .comment-reply .c-name { color: #005ca9; }
        .reply-toggle { background: none; border: none; color: #005ca9; font-size: 0.82rem; font-weight: 600; cursor: pointer; padding: 0; margin-top: 0.4rem; }
        .comment-form { margin-top: 0.6rem; }
        .comment-form input[type=text], .comment-form input[type=email], .comment-form textarea { width: 100%; padding: 8px; margin-bottom: 6px; border: 1px solid #ccc; border-radius: 6px; font-family: inherit; font-size: 0.92rem; }
        .comment-form textarea { min-height: 80px; resize: vertical; }
        .comment-form button { background: #005ca9; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; }
        .comment-form .c-result { margin: 6px 0; font-size: 0.85rem; }
        .hp-field { position: absolute; left: -9999px; top: -9999px; }
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
      $previewParam     = $isPreview ? '&preview=' . urlencode($_GET['preview']) : '';
      $lang_toggle_href = 'blog-post.php?slug=' . urlencode($slug) . ($is_en ? '&lang=es' : '&lang=en') . $previewParam;
      $show_atp_badge   = false;
      include __DIR__ . '/includes/header.php';
    ?>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <a class="back-link" style="margin-bottom:0;" href="blog.php?lang=<?= $lang ?>">&larr; <?= $is_en ? 'Back to Blog' : 'Volver al Blog' ?></a>
        <?php if ($post): ?>
            <a class="back-link" style="margin-bottom:0;" href="#comments-section"><?= $is_en ? 'Comments below' : 'Comentarios abajo' ?> &darr;</a>
        <?php endif; ?>
    </div>
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

        <div class="comments-section" id="comments-section">
            <h2><?= $is_en ? 'Comments' : 'Comentarios' ?></h2>
            <?php if (!count($topLevelComments)): ?>
                <p style="color:#888;font-size:0.9rem;"><?= $is_en ? 'No comments yet. Be the first to comment.' : 'Aún no hay comentarios. Sé el primero en comentar.' ?></p>
            <?php endif; ?>
            <?php foreach ($topLevelComments as $c): ?>
                <div class="comment" id="comment-<?= htmlspecialchars($c['id'], ENT_QUOTES, 'UTF-8') ?>">
                    <div class="c-meta"><span class="c-name"><?= htmlspecialchars($c['author_name'], ENT_QUOTES, 'UTF-8') ?></span> <span class="c-date">— <?= date('j M Y', strtotime($c['created_at'])) ?></span></div>
                    <div class="c-body"><?= htmlspecialchars($c['body'], ENT_QUOTES, 'UTF-8') ?></div>
                    <?php foreach (($repliesByParent[$c['id']] ?? []) as $r): ?>
                        <div class="comment-reply">
                            <div class="c-meta"><span class="c-name"><?= htmlspecialchars($r['author_name'], ENT_QUOTES, 'UTF-8') ?></span> <span class="c-date">— <?= date('j M Y', strtotime($r['created_at'])) ?></span></div>
                            <div class="c-body"><?= htmlspecialchars($r['body'], ENT_QUOTES, 'UTF-8') ?></div>
                        </div>
                    <?php endforeach; ?>
                    <button type="button" class="reply-toggle" onclick="toggleReplyForm('<?= htmlspecialchars($c['id'], ENT_QUOTES, 'UTF-8') ?>')"><?= $is_en ? 'Reply' : 'Responder' ?></button>
                    <div class="comment-form" id="reply-form-<?= htmlspecialchars($c['id'], ENT_QUOTES, 'UTF-8') ?>" style="display:<?= ($replyTo === $c['id']) ? 'block' : 'none' ?>;">
                        <input type="text" class="hp-field" tabindex="-1" autocomplete="off" name="website">
                        <input type="hidden" class="c-parent" value="<?= htmlspecialchars($c['id'], ENT_QUOTES, 'UTF-8') ?>">
                        <input type="hidden" class="c-reply-token" value="<?= ($replyTo === $c['id']) ? htmlspecialchars($replyToken, ENT_QUOTES, 'UTF-8') : '' ?>">
                        <input type="text" class="c-input-name" placeholder="<?= $is_en ? 'Your name' : 'Tu nombre' ?>">
                        <input type="email" class="c-input-email" placeholder="<?= $is_en ? 'Email (optional)' : 'Correo (opcional)' ?>">
                        <textarea class="c-input-body" placeholder="<?= $is_en ? 'Write your reply…' : 'Escribe tu respuesta…' ?>"></textarea>
                        <div class="c-result"></div>
                        <button type="button" onclick="submitCommentForm(this)"><?= $is_en ? 'Send' : 'Enviar' ?></button>
                    </div>
                </div>
            <?php endforeach; ?>

            <h3 style="margin-top:1.2rem;color:#005ca9;font-size:1.05rem;"><?= $is_en ? 'Leave a comment' : 'Deja un comentario' ?></h3>
            <div class="comment-form" id="new-comment-form">
                <input type="text" class="hp-field" tabindex="-1" autocomplete="off" name="website">
                <input type="hidden" class="c-parent" value="">
                <input type="hidden" class="c-reply-token" value="">
                <input type="text" class="c-input-name" placeholder="<?= $is_en ? 'Your name' : 'Tu nombre' ?>">
                <input type="email" class="c-input-email" placeholder="<?= $is_en ? 'Email (optional)' : 'Correo (opcional)' ?>">
                <textarea class="c-input-body" placeholder="<?= $is_en ? 'Write your comment…' : 'Escribe tu comentario…' ?>"></textarea>
                <div class="c-result"></div>
                <button type="button" onclick="submitCommentForm(this)"><?= $is_en ? 'Send' : 'Enviar' ?></button>
            </div>
        </div>
    <?php else: ?>
        <div class="not-found">
            <p><?= $is_en ? 'This post could not be found.' : 'No se encontró esta publicación.' ?></p>
        </div>
    <?php endif; ?>
    <?php include __DIR__ . '/includes/footer.php'; ?>
</div>
<script>
const POST_ID = <?= json_encode($post['id'] ?? null) ?>;
const IS_EN   = <?= json_encode($is_en) ?>;

function toggleReplyForm(commentId) {
    const box = document.getElementById('reply-form-' + commentId);
    if (!box) return;
    box.style.display = (box.style.display === 'none' || !box.style.display) ? 'block' : 'none';
}

async function submitCommentForm(btn) {
    const box    = btn.closest('.comment-form');
    const result = box.querySelector('.c-result');
    const website     = box.querySelector('input[name="website"]').value;
    const parentId    = box.querySelector('.c-parent').value || null;
    const replyToken  = box.querySelector('.c-reply-token').value || null;
    const name  = box.querySelector('.c-input-name').value.trim();
    const email = box.querySelector('.c-input-email').value.trim();
    const body  = box.querySelector('.c-input-body').value.trim();

    if (!name || !body) {
        result.textContent = IS_EN ? 'Please fill in your name and comment.' : 'Por favor completa tu nombre y el comentario.';
        result.style.color = '#cc3333';
        return;
    }

    btn.disabled = true;
    result.textContent = IS_EN ? 'Sending…' : 'Enviando…';
    result.style.color = '#888';

    try {
        const res = await fetch('/blog-comment-action.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                post_id: POST_ID,
                parent_comment_id: parentId,
                author_name: name,
                author_email: email,
                body: body,
                reply_token: replyToken,
                website: website
            })
        });
        const data = await res.json();
        if (!data.success) {
            result.textContent = data.error || (IS_EN ? 'Something went wrong.' : 'Algo salió mal.');
            result.style.color = '#cc3333';
            btn.disabled = false;
            return;
        }
        if (data.published) {
            window.location.reload();
        } else {
            box.innerHTML = '<div class="c-result" style="color:#00a859;">' + (IS_EN ? '✓ Thank you — your comment is awaiting review.' : '✓ Gracias — tu comentario está en revisión.') + '</div>';
        }
    } catch (err) {
        result.textContent = err.message;
        result.style.color = '#cc3333';
        btn.disabled = false;
    }
}

<?php if ($replyTo && $replyToken): ?>
document.addEventListener('DOMContentLoaded', function() {
    const el = document.getElementById('comment-' + <?= json_encode($replyTo) ?>);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
<?php endif; ?>
</script>
</body>
</html>
