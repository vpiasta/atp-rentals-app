<?php
// ── Config ────────────────────────────────────────────────────────────────────
define('SUPABASE_URL', 'https://caqdkxukezpckqphogwl.supabase.co');
define('SUPABASE_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhcWRreHVrZXpwY2txcGhvZ3dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDc2MDIsImV4cCI6MjA5NjAyMzYwMn0.xqNuCWm_ALivBRpl3pSTDDJeoBN1WfX4-G_OJq2Sd8g');
define('SITE_URL',     'https://trustedpanamastays.com');

// ── Get slug or id from URL ───────────────────────────────────────────────────
$slug = isset($_GET['slug']) ? preg_replace('/[^a-z0-9\-]/', '', strtolower($_GET['slug'])) : '';
$id   = isset($_GET['id'])   ? intval($_GET['id']) : 0;
$lang = isset($_GET['lang']) && $_GET['lang'] === 'es' ? 'es' : 'en';

if (!$slug && !$id) {
    http_response_code(404);
    exit('Listing not found');
}

// ── Fetch from Supabase ───────────────────────────────────────────────────────
function supabase_get($path) {
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
    return is_array($data) && isset($data[0]) ? $data[0] : null;
}

$select = 'id,name,phone,email,province,rental_type,address,description_en,description_es,photos,website_url,booking_url,is_member,membership_paid_until,phone_member,email_member,custom_links,slug,registry_source,apatel_member';

if ($slug) {
    $listing = supabase_get('listings?select=' . $select . '&slug=eq.' . urlencode($slug) . '&limit=1');
} else {
    $listing = supabase_get('listings?select=' . $select . '&id=eq.' . $id . '&limit=1');
}

if (!$listing) {
    http_response_code(404);
    exit('Listing not found');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function h($s) { return htmlspecialchars($s ?? '', ENT_QUOTES, 'UTF-8'); }

function is_active($listing) {
    if (empty($listing['is_member'])) return false;
    if (empty($listing['membership_paid_until'])) return false;
    return strtotime($listing['membership_paid_until']) >= time();
}

$active      = is_active($listing);
$phone       = $active ? ($listing['phone_member'] ?: $listing['phone']) : $listing['phone'];
$email       = $active ? ($listing['email_member'] ?: $listing['email']) : $listing['email'];
$address     = $active ? ($listing['address'] ?? '') : '';
$description = $lang === 'es'
    ? ($listing['description_es'] ?: $listing['description_en'] ?: '')
    : ($listing['description_en'] ?: $listing['description_es'] ?: '');

$photos      = is_array($listing['photos']) ? $listing['photos'] : json_decode($listing['photos'] ?? '[]', true) ?? [];
$first_photo = !empty($photos) ? $photos[0] : '';

$name        = $listing['name'] ?? '';
$province    = $listing['province'] ?? '';
$type        = $listing['rental_type'] ?? '';
$slug_val    = $listing['slug'] ?? '';
$listing_url = $slug_val ? SITE_URL . '/listing.html?slug=' . urlencode($slug_val) . '&lang=' . $lang : SITE_URL . '/listing.html?id=' . $listing['id'] . '&lang=' . $lang;
$canonical   = SITE_URL . '/l.php?slug=' . urlencode($slug_val) . '&lang=' . $lang;

$title_en    = $name . ' — Trusted Panama Stays';
$title_es    = $name . ' — Trusted Panama Stays';
$desc_en     = 'Verified tourist accommodation in ' . $province . ', Panama. ' . strip_tags(mb_substr($description, 0, 150));
$desc_es     = 'Hospedaje turístico verificado en ' . $province . ', Panamá. ' . strip_tags(mb_substr($description, 0, 150));
$page_title  = $lang === 'es' ? $title_es : $title_en;
$page_desc   = $lang === 'es' ? $desc_es  : $desc_en;

$mici_label  = $listing['registry_source'] === 'mici' ? '✅ MiCI' : '✅ ATP';
$apatel      = !empty($listing['apatel_member']);

// ── Phone helpers ─────────────────────────────────────────────────────────────
function clean_phone($phone) {
    // Extract first 8-digit Panamanian number
    preg_match('/6\d{7}/', preg_replace('/[^\d]/', '', $phone ?? ''), $m);
    return $m[0] ?? preg_replace('/[^\d]/', '', explode('/', $phone ?? '')[0]);
}
$phone_call = clean_phone($phone);
$phone_wa   = preg_match('/^6/', $phone_call) ? $phone_call : '';
$maps_url   = 'https://www.google.com/maps/search/?api=1&query=' . urlencode($name . ' ' . $province . ' Panama');

?><!DOCTYPE html>
<html lang="<?= $lang ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= h($page_title) ?></title>
    <meta name="description" content="<?= h($page_desc) ?>">
    <link rel="canonical" href="<?= h($canonical) ?>">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <!-- Open Graph -->
    <meta property="og:title"       content="<?= h($page_title) ?>">
    <meta property="og:description" content="<?= h($page_desc) ?>">
    <meta property="og:url"         content="<?= h($canonical) ?>">
    <meta property="og:type"        content="business.business">
    <?php if ($first_photo): ?>
    <meta property="og:image"       content="<?= h($first_photo) ?>">
    <?php endif; ?>
    <!-- JSON-LD structured data -->
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "LodgingBusiness",
        "name": <?= json_encode($name) ?>,
        "description": <?= json_encode(strip_tags($description)) ?>,
        "address": {
            "@type": "PostalAddress",
            "addressRegion": <?= json_encode($province) ?>,
            "addressCountry": "PA"
            <?php if ($address): ?>, "streetAddress": <?= json_encode($address) ?><?php endif; ?>
        },
        "url": <?= json_encode($listing_url) ?>
        <?php if ($phone): ?>, "telephone": <?= json_encode($phone) ?><?php endif; ?>
        <?php if ($email): ?>, "email": <?= json_encode($email) ?><?php endif; ?>
        <?php if ($first_photo): ?>, "image": <?= json_encode($first_photo) ?><?php endif; ?>
    }
    </script>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Segoe UI',sans-serif; background:#f8f9fa; color:#111; line-height:1.6; }
        .container { max-width:900px; margin:0 auto; padding:20px; }
        header { background:linear-gradient(135deg,#005ca9,#00a859); color:white; padding:1rem 1.5rem; border-radius:10px; margin-bottom:1.5rem; display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; }
        header h1 { font-size:1.2rem; font-weight:700; }
        .back-link { color:white; text-decoration:none; background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.4); border-radius:20px; padding:5px 14px; font-size:0.82rem; font-weight:600; }
        .card { background:white; border-radius:12px; box-shadow:0 2px 20px rgba(0,0,0,0.1); overflow:hidden; margin-bottom:1.5rem; }
        .name-row { padding:1.5rem 1.5rem 0; }
        .listing-name { font-size:1.8rem; color:#005ca9; font-weight:700; margin-bottom:0.6rem; }
        .badges { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:1.2rem; }
        .badge { padding:3px 12px; border-radius:20px; font-size:0.78rem; font-weight:600; color:white; }
        .badge-type { background:#00a859; } .badge-province { background:#005ca9; }
        .badge-member { background:#a07800; } .badge-atp { background:#1a7a1a; }
        .badge-apatel { background:#1a3a6b; color:#7ec8e3; border:1px solid #3a5a8b; }
        .section { padding:1.2rem 1.5rem; border-bottom:1px solid #e1e5e9; }
        .section-title { font-size:0.78rem; text-transform:uppercase; letter-spacing:0.08em; color:#888; margin-bottom:0.8rem; font-weight:700; }
        .info-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,auto)); gap:0.8rem; }
        .info-item { display:flex; gap:9px; align-items:flex-start; }
        .info-icon { font-size:1.1rem; flex-shrink:0; }
        .info-label { font-size:0.75rem; color:#888; }
        .info-value { font-weight:600; color:#111; }
        /* ── Gallery ── */
        .gallery-wrap { padding:12px 12px 0; }
        .gallery-main { position:relative; display:flex; align-items:center; justify-content:center; background:#f8f9fa; border-radius:10px; overflow:hidden; padding:8px; }
        .gallery-main img { max-width:80%; max-height:420px; object-fit:contain; display:block; border:1px solid #ccc; border-radius:6px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
        .gallery-nav { position:absolute; top:50%; transform:translateY(-50%); background:rgba(0,0,0,0.55); color:white; border:none; border-radius:50%; width:36px; height:36px; font-size:1.2rem; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background 0.2s; }
        .gallery-nav:hover { background:rgba(0,0,0,0.8); }
        .gallery-nav.prev { left:8px; }
        .gallery-nav.next { right:8px; }
        .gallery-count { position:absolute; bottom:8px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.55); color:white; padding:2px 10px; border-radius:12px; font-size:0.78rem; }
        .gallery-thumbs { display:flex; gap:6px; padding:8px 0 12px; overflow-x:auto; scrollbar-width:thin; }
        .gallery-thumbs img { width:72px; height:54px; object-fit:cover; border-radius:6px; cursor:pointer; flex-shrink:0; opacity:0.65; transition:opacity 0.2s, outline 0.2s; outline:2px solid transparent; }
        .gallery-thumbs img.active { opacity:1; outline:2px solid #b8860b; }
        .gallery-thumbs img:hover { opacity:1; }
        .description { color:#444; line-height:1.8; font-size:0.95rem; }
        .description a { color:#005ca9; }
        .buttons { display:flex; gap:8px; flex-wrap:wrap; padding:1rem 1.5rem; border-bottom:1px solid #e1e5e9; }
        .btn { padding:7px 14px; border:2px solid #005ca9; border-radius:7px; text-decoration:none; color:#005ca9; font-weight:600; font-size:0.85rem; display:inline-flex; align-items:center; gap:5px; }
        .btn:hover { background:#005ca9; color:white; }
        .btn.wa { border-color:#25D366; color:#25D366; }
        .btn.wa:hover { background:#25D366; color:white; }
        footer { background:#2c3e50; color:#ccc; border-radius:10px; padding:1.2rem 1.5rem; text-align:center; font-size:0.85rem; line-height:1.8; }
        footer a { color:#7ec8e3; text-decoration:none; }
        footer p { color:#ccc; }


    </style>
</head>
<body>
<div class="container">

<header>
    <div>
        <h1>Trusted Panama Stays</h1>
        <p style="font-size:0.8rem;opacity:0.85;"><?= $lang === 'es' ? 'Hospedajes verificados en Panamá' : 'Verified accommodations in Panama' ?></p>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
        <a href="<?= $lang === 'es' ? 'index_es.html' : 'index.html' ?>" class="back-link">← <?= $lang === 'es' ? 'Volver' : 'Back' ?></a>
        <?php
        $other_lang = $lang === 'es' ? 'en' : 'es';
        $lang_url   = $slug_val
            ? 'listing.php?slug=' . urlencode($slug_val) . '&lang=' . $other_lang
            : 'listing.php?id=' . $listing['id'] . '&lang=' . $other_lang;
        ?>
        <a href="<?= h($lang_url) ?>" class="back-link">
            <?= $lang === 'es'
                ? '<svg width="18" height="13" viewBox="0 0 20 14" style="vertical-align:middle;margin-right:3px;"><rect x="0" y="0" width="20" height="14" fill="#B22234"/><rect x="0" y="2" width="20" height="2" fill="white"/><rect x="0" y="6" width="20" height="2" fill="white"/><rect x="0" y="10" width="20" height="2" fill="white"/><rect x="0" y="0" width="8" height="8" fill="#3C3B6E"/></svg> English'
                : '<svg width="18" height="13" viewBox="0 0 20 14" style="vertical-align:middle;margin-right:3px;border:1px solid rgba(255,255,255,0.4);"><rect x="0" y="0" width="10" height="7" fill="white"/><rect x="10" y="0" width="10" height="7" fill="#cc0000"/><rect x="0" y="7" width="10" height="7" fill="#1a3a6b"/><rect x="10" y="7" width="10" height="7" fill="white"/></svg> Español'
            ?>
        </a>
    </div>
</header>



<div class="card">
    <div class="name-row">
        <h2 class="listing-name"><?= h($name) ?></h2>
        <div class="badges">
            <?php if ($type): ?><span class="badge badge-type"><?= h($type) ?></span><?php endif; ?>
            <?php if ($province): ?><span class="badge badge-province">📍 <?= h($province) ?></span><?php endif; ?>
            <span class="badge badge-atp"><?= h($mici_label) ?></span>
            <?php if ($active): ?><span class="badge badge-member">⭐ <?= $lang === 'es' ? 'Miembro' : 'Member' ?></span><?php endif; ?>
            <?php if ($apatel): ?><span class="badge badge-apatel">🏨 APATEL</span><?php endif; ?>
        </div>
    </div>

    <div class="buttons">
        <?php if ($phone_call): ?><a href="tel:+507<?= h($phone_call) ?>" class="btn">📞 <?= $lang === 'es' ? 'Llamar' : 'Call' ?></a><?php endif; ?>
        <?php if ($email): ?><a href="mailto:<?= h($email) ?>" class="btn">✉️ <?= $lang === 'es' ? 'Correo' : 'Email' ?></a><?php endif; ?>
        <?php if ($phone_wa): ?><a href="https://wa.me/507<?= h($phone_wa) ?>" target="_blank" class="btn wa">💬 WhatsApp</a><?php endif; ?>
        <a href="<?= h($maps_url) ?>" target="_blank" class="btn">📍 Maps</a>
        <a href="<?= h($listing_url) ?>" class="btn" style="border-color:#a07800;color:#a07800;background:#fffbe6;margin-left:auto;">🔐 <?= $lang === 'es' ? 'Acceso' : 'Login' ?></a>
    </div>

    <div class="section">
        <div class="section-title"><?= $lang === 'es' ? 'Contacto' : 'Contact' ?></div>
        <div class="info-grid">
            <?php if ($phone): ?>
            <div class="info-item">
                <span class="info-icon">📞</span>
                <div><div class="info-label"><?= $lang === 'es' ? 'Teléfono' : 'Phone' ?></div>
                <div class="info-value"><?= h($phone) ?></div></div>
            </div>
            <?php endif; ?>
            <?php if ($email): ?>
            <div class="info-item">
                <span class="info-icon">✉️</span>
                <div><div class="info-label"><?= $lang === 'es' ? 'Correo' : 'Email' ?></div>
                <div class="info-value"><?= h($email) ?></div></div>
            </div>
            <?php endif; ?>
            <?php if ($address): ?>
            <div class="info-item">
                <span class="info-icon">🗺️</span>
                <div><div class="info-label"><?= $lang === 'es' ? 'Dirección' : 'Address' ?></div>
                <div class="info-value"><?= h($address) ?></div></div>
            </div>
            <?php endif; ?>
        </div>
    </div>

    <?php if (!empty($photos)): ?>
    <div class="gallery-wrap">
        <div class="gallery-main">
            <img id="gallery-img" src="<?= h($photos[0]) ?>" alt="<?= h($name) ?>">
            <?php if (count($photos) > 1): ?>
            <button class="gallery-nav prev" onclick="galleryMove(-1)">‹</button>
            <button class="gallery-nav next" onclick="galleryMove(1)">›</button>
            <div class="gallery-count"><span id="gallery-cur">1</span> / <?= count($photos) ?></div>
            <?php endif; ?>
        </div>
        <?php if (count($photos) > 1): ?>
        <div class="gallery-thumbs" id="gallery-thumbs">
            <?php foreach ($photos as $i => $photo): ?>
            <img src="<?= h($photo) ?>" alt="<?= h($name) ?> <?= $i+1 ?>"
                 class="<?= $i === 0 ? 'active' : '' ?>"
                 onclick="galleryGo(<?= $i ?>)" loading="<?= $i < 4 ? 'eager' : 'lazy' ?>">
            <?php endforeach; ?>
        </div>
        <?php endif; ?>
    </div>
    <script>
    var galleryPhotos = <?= json_encode($photos) ?>;
    var galleryCur = 0;
    function galleryGo(i) {
        galleryCur = (i + galleryPhotos.length) % galleryPhotos.length;
        var img = document.getElementById('gallery-img');
        img.src = galleryPhotos[galleryCur];
        document.getElementById('gallery-cur').textContent = galleryCur + 1;
        var thumbs = document.querySelectorAll('#gallery-thumbs img');
        thumbs.forEach(function(t, idx) { t.classList.toggle('active', idx === galleryCur); });
        // Scroll only the thumb strip horizontally, not the page
        if (thumbs[galleryCur]) {
            thumbs[galleryCur].scrollIntoView({inline:'center', behavior:'smooth', block:'nearest'});
        }
        // Scroll page only if main image is not visible
        var rect = img.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
            img.scrollIntoView({behavior:'smooth', block:'nearest'});
        }
    }
    function galleryMove(dir) { galleryGo(galleryCur + dir); }
    // Keyboard navigation
    document.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowLeft')  galleryMove(-1);
        if (e.key === 'ArrowRight') galleryMove(1);
    });
    </script>
    <?php endif; ?>

    <?php if ($description): ?>
    <div class="section">
        <div class="section-title"><?= $lang === 'es' ? 'Descripción' : 'Description' ?></div>
        <div class="description"><?= $description ?></div>
    </div>
    <?php endif; ?>

</div>

<?php
$custom = is_array($listing['custom_links']) ? $listing['custom_links'] : json_decode($listing['custom_links'] ?? '[]', true) ?? [];
$has_links = !empty($listing['website_url']) || !empty($listing['booking_url']) || !empty($custom);
if ($has_links): ?>
<div class="card">
    <div class="section" style="border:none;">
        <div class="section-title"><?= $lang === 'es' ? 'Enlaces' : 'Links' ?></div>
        <div class="buttons" style="padding:0;border:none;">
            <?php if (!empty($listing['website_url'])): ?>
            <a href="<?= h($listing['website_url']) ?>" target="_blank" class="btn">🌐 <?= $lang === 'es' ? 'Sitio Web' : 'Website' ?></a>
            <?php endif; ?>
            <?php if (!empty($listing['booking_url'])): ?>
            <a href="<?= h($listing['booking_url']) ?>" target="_blank" class="btn">🔗 <?= $lang === 'es' ? 'Reservar' : 'Book Now' ?></a>
            <?php endif; ?>
            <?php foreach ($custom as $link): if (empty($link['url'])) continue; ?>
            <a href="<?= h($link['url']) ?>" target="_blank" class="btn" style="border-color:#666;color:#444;">
                <?= h(($link['emoji'] ?? '') . ' ' . ($link['label'] ?? '')) ?>
            </a>
            <?php endforeach; ?>
        </div>
    </div>
</div>
<?php endif; ?>

<footer>
    <p style="font-size:0.8rem;">
        <?= $lang === 'es'
            ? 'Datos proporcionados por la <a href="https://www.atp.gob.pa/industrias/hoteleros/" target="_blank">Autoridad de Turismo de Panamá (ATP)</a><br>con datos adicionales proporcionados por nuestros miembros'
            : 'Data provided by the <a href="https://www.atp.gob.pa/industrias/hoteleros/" target="_blank">Autoridad de Turismo de Panamá (ATP)</a><br>with additional data provided by our members' ?>
    </p>
    <p style="margin-top:0.8rem;color:#ccc;">
        Trusted Panama Stays is owned and copyrighted by Tuscany Real Estates SA<br>
        RUC 1401220-1-627960 DV21<br>
        <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a>
    </p>
</footer>

</div>
</body>
</html>
