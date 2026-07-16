<?php
$lang = isset($_GET['lang']) && $_GET['lang'] === 'en' ? 'en' : 'es';
$is_en = $lang === 'en';

$t = [
    'title'        => $is_en ? 'Trusted Panama Stays - Verified Tourist Rentals' : 'Trusted Panama Stays - Hospedajes Verificados',
    'description'  => $is_en ? 'Find trusted, publicly registered hotels, apartments and vacation rentals in Panama' : 'Encuentra aquí únicamente hoteles, apartamentos y alquileres vacacionales de confianza, registrados legalmente en Panamá',
    'canonical'    => 'https://trustedpanamastays.com/index.php?lang=' . $lang,
    'html_lang'    => $lang,
    'heading'      => 'Trusted Panama Stays',
    'subheading'   => $is_en ? 'Registered and verified hotels, apartments and vacation rentals in Panama' : 'Hoteles, apartamentos y alquileres vacacionales registrados y verificados en Panamá',
    'about_link'   => $is_en ? 'About us' : 'Quiénes somos',
    'about_href'   => 'about.html?lang=' . $lang,
    'lang_switch'  => $is_en ? 'Español' : 'English',
    'lang_href'    => $is_en ? 'index.php?lang=es' : 'index.php?lang=en',
    'atp_label'    => $is_en ? 'Verified by' : 'Verificado por',
    'updated'      => $is_en ? 'Updated:' : 'Actualizado:',
    'loading'      => $is_en ? 'Loading...' : 'Cargando...',
    'search_ph'    => $is_en ? 'Search by name, location, type...' : 'Buscar por nombre, ubicación, tipo...',
    'search_btn'   => $is_en ? 'Search' : 'Buscar',
    'clear_btn'    => $is_en ? '✕ Clear' : '✕ Limpiar',
    'province_lbl' => $is_en ? 'Province' : 'Provincia',
    'province_all' => $is_en ? 'All Provinces' : 'Todas las Provincias',
    'type_lbl'     => $is_en ? 'Type' : 'Tipo',
    'type_all'     => $is_en ? 'All Types' : 'Todos los Tipos',
    'keyword_lbl'  => $is_en ? 'Features' : 'Características',
    'keyword_all'  => $is_en ? 'All Features' : 'Todas',
    'no_results'   => $is_en ? 'Use search or filters to find registered accommodations' : 'Use la búsqueda o los filtros para encontrar hospedajes registrados',
    'join_text'    => $is_en ? 'Do you own a property registered with ATP?' : '¿Es propietario de un hospedaje registrado ante la ATP?',
    'join_btn'     => $is_en ? 'Register your property →' : 'Registre su hospedaje →',
    'footer_data'  => $is_en ? 'Data provided by the' : 'Datos proporcionados por la',
    'footer_extra' => $is_en ? 'with additional data provided by our members' : 'con datos adicionales proporcionados por nuestros miembros',
    'footer_owned' => $is_en ? 'Trusted Panama Stays is owned by Tuscany Real Estates SA' : 'Trusted Panama Stays es propiedad de Tuscany Real Estates SA',
    'lang_js'      => $is_en ? 'en' : 'es',
];
?>
<!DOCTYPE html>
<html lang="<?= $t['html_lang'] ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= $t['title'] ?></title>
    <meta name="description" content="<?= $t['description'] ?>">
    <link rel="canonical" href="<?= $t['canonical'] ?>">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <style>

        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #111; background: #f8f9fa; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        /* ── Header ── */
        header { background: linear-gradient(135deg, #005ca9, #00a859); color: white; padding: 0.6rem 0.8rem; border-radius: 10px; margin-bottom: 0.6rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header-inner { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
        .header-logo  { flex-shrink: 0; width: 44px; height: 44px; }
        .header-text  { flex: 1 1 auto; min-width: 0; overflow: hidden; }
        .header-text h1 { font-size: 1.05rem; font-weight: 700; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .header-text p  { font-size: 0.72rem; opacity: 0.85; margin: 0; white-space: normal; line-height: 1.3; }
        .header-right { display: flex; flex-direction: row; align-items: center; gap: 5px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; max-width: 45%; }
        .lang-toggle { display: inline-flex; align-items: center; gap: 5px; background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.4); border-radius: 20px; padding: 4px 9px; text-decoration: none; color: white; font-size: 0.76rem; font-weight: 600; transition: background 0.3s; white-space: nowrap; }
        .lang-toggle:hover { background: rgba(255,255,255,0.28); }
        .atp-badge { font-size: 0.62rem; opacity: 0.85; flex-basis: 100%; text-align: right; line-height: 1.4; }
        .atp-badge a { color: white; }

        footer { background: #2c3e50; color: #ccc; border-radius: 10px; padding: 1.2rem 1.5rem; margin-top: 1.5rem; text-align: center; font-size: 0.85rem; line-height: 1.8; }
        footer a { color: #7ec8e3; text-decoration: none; }
        footer a:hover { text-decoration: underline; }


        /* Mobile: logo+title row 1, buttons+badge row 2 centered */
        @media (max-width: 600px) {
            .header-inner { flex-wrap: wrap; gap: 6px; }
            .header-logo  { width: 36px; height: 36px; }
            .header-text  { flex: 1; }
            .header-text h1 { font-size: 0.9rem; }
            .header-right { max-width: 100%; width: 100%; justify-content: center; flex-wrap: nowrap; }
            .atp-badge { display: block; text-align: right; flex-basis: 100%; }
        }

        /* ── Stats ── */
        .stats { background: white; padding: 0.3rem 0.8rem; border-radius: 8px; margin-bottom: 0.5rem; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.06); font-size: 0.85rem; }

        /* ── Search ── */
        .search-section { background: white; padding: 0.6rem; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 0.6rem; }
        .search-box { display: flex; gap: 6px; margin-bottom: 0.5rem; flex-wrap: nowrap; align-items: center; }
        #searchInput { flex: 1; min-width: 0; padding: 7px 10px; border: 2px solid #e1e5e9; border-radius: 8px; font-size: 14px; transition: border-color 0.3s; font-family: inherit; }
        #searchInput:focus { outline: none; border-color: #005ca9; }
        #searchButton { flex-shrink: 0; padding: 7px 12px; background: #005ca9; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: background 0.3s; white-space: nowrap; }
        #searchButton:hover { background: #004885; }
        .filters { display: flex; gap: 8px; flex-wrap: nowrap; }
        .filter-group { flex: 1; min-width: 0; }

        .filter-group label { display: block; margin-bottom: 4px; font-weight: 600; color: #555; font-size: 0.85rem; }
        .filter-group select { width: 100%; padding: 9px 10px; border: 2px solid #e1e5e9; border-radius: 8px; font-size: 14px; font-family: inherit; }
        .results-section { display: grid; gap: 16px; }
        .result-card { background: white; border-radius: 10px; padding: 1.4rem; box-shadow: 0 2px 10px rgba(0,0,0,0.08); transition: transform 0.2s, box-shadow 0.2s; }
        .result-card:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(0,0,0,0.13); }
        .result-card.is-member { border-left: 4px solid #b8860b; }
        .result-title { font-size: 1.2rem; color: #005ca9; margin-bottom: 0.4rem; font-weight: 700; }
        .result-badges { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 0.8rem; }
        .result-badge { padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; color: white; }
        .badge-type { background: #00a859; } .badge-province { background: #005ca9; } .badge-member { background: #b8860b; }
        .result-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.6rem; margin-bottom: 1rem; }
        .detail-item { display: flex; align-items: flex-start; gap: 7px; font-size: 0.9rem; }
        .contact-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
        .contact-button { padding: 7px 14px; border: 2px solid #005ca9; border-radius: 6px; text-decoration: none; color: #005ca9; font-weight: 600; font-size: 0.83rem; transition: all 0.25s; display: inline-flex; align-items: center; gap: 5px; }
        .contact-button:hover  { background: #005ca9; color: white; }
        .whatsapp-button       { border-color: #25D366; color: #25D366; }
        .whatsapp-button:hover { background: #25D366; color: white; }
        .seemore-button        { border-color: #b8860b; color: #7a5c00; background: #fffbe6; }
        .seemore-button:hover  { background: #b8860b; color: white; border-color: #b8860b; }
        /* ── Member thumbnail ── */
        .card-body {
            display: flex;
            flex-direction: row;
            gap: 1rem;
            align-items: flex-start;
        }
        .member-thumb {
            flex-shrink: 0;
            width: 240px;
            border: 2px solid #b8860b;
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
            text-decoration: none;
            display: flex;
            flex-direction: column;
            background: white;
        }
        .member-thumb:hover {
            border-color: #005ca9;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }
        .member-thumb-img {
            width: 100%;
            height: 240px;
            object-fit: cover;
            object-position: center;
            display: block;
        }
        .member-thumb-nophoto {
            width: 100%;
            height: 240px;
            background: #f0f7ff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2rem;
        }
        .member-thumb-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            width: 80px;
            padding: 8px 10px;
            background: #b8860b;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 0.82rem;
            font-weight: 700;
            border: 2px solid #a07000;
            cursor: pointer;
            flex-shrink: 0;
            white-space: nowrap;
        }
        .member-thumb-btn:hover { background: #a07000; }
        .member-thumb-label {
            display: block;
            background: white;
            color: #111;
            text-align: center;
            font-size: 0.82rem;
            font-weight: 700;
            padding: 5px 4px;
            border-top: 1px solid #ddd;
        }
        .card-info { flex: 1; min-width: 0; }
        /* Icon-only buttons on narrow screens */
        .contact-button .btn-text { display: inline; }
        .contact-button .btn-icon { display: none; }
        @media (max-width: 600px) {
            .search-box { flex-wrap: nowrap !important; }
            #searchButton, #clearButton { flex-shrink: 0; }
            .card-body { flex-direction: column; gap: 0.5rem; }
            .member-thumb { width: 100%; }
            .member-thumb-img { height: 150px; }
            .member-thumb-nophoto { height: 80px; }
            .member-thumb-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            width: 80px;
            padding: 8px 10px;
            background: #b8860b;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 0.82rem;
            font-weight: 700;
            border: 2px solid #a07000;
            cursor: pointer;
            flex-shrink: 0;
            white-space: nowrap;
        }
        .member-thumb-btn:hover { background: #a07000; }
        .member-thumb-label { font-size: 0.95rem; padding: 7px 4px; }
            .contact-button { padding: 7px 10px; font-size: 0.8rem; }
            .contact-button .btn-text { display: none; }
            .contact-button .btn-icon { display: inline; font-size: 1.1rem; }
            .contact-buttons { flex-wrap: nowrap; justify-content: center; }
        }
        /* ── UP button ── */
        .up-btn {
            position: fixed; bottom: 20px; right: 16px; z-index: 999;
            background: #005ca9; color: white; border: none; border-radius: 50%;
            width: 42px; height: 42px; font-size: 1.1rem; font-weight: 700;
            cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            display: none; align-items: center; justify-content: center;
            transition: background 0.2s;
        }
        .up-btn:hover { background: #004885; }
        .up-btn.visible { display: flex; }
        @media (max-width: 768px) {
            .header-inner { gap: 0.8rem; } .header-logo { width: 54px; height: 54px; }
            .header-text h1 { font-size: 1.2rem; }
            .header-right { margin-left: 0; flex-direction: row; align-items: center; width: 100%; justify-content: flex-end; }
        }

    </style>
</head>
<body>
<div class="container">
    <header>
        <div class="header-inner">
            <svg class="header-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 260" role="img" aria-label="Trusted Panama Stays logo">
                <rect x="30" y="130" width="100" height="62" fill="white"/>
                <rect x="130" y="130" width="100" height="62" fill="#cc0000"/>
                <rect x="30" y="192" width="100" height="62" fill="#1a3a6b"/>
                <rect x="130" y="192" width="100" height="62" fill="white"/>
                <rect x="30" y="130" width="200" height="124" fill="none" stroke="white" stroke-width="2"/>
                <polygon points="80,147 82.5,155 91,155 84,160 86.5,168 80,163 73.5,168 76,160 69,155 77.5,155" fill="#1a3a6b"/>
                <polygon points="180,209 182.5,217 191,217 184,222 186.5,230 180,225 173.5,230 176,222 169,217 177.5,217" fill="#cc0000"/>
                <polyline points="5,128 130,16 255,128" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M54,138 L98,246 L218,26" fill="none" stroke="#FFD700" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="header-text">
                <h1><?= $t['heading'] ?></h1>
                <p><?= $t['subheading'] ?></p>
            </div>
            <div class="header-right">
                <a href="<?= $t['about_href'] ?>" class="lang-toggle"><?= $t['about_link'] ?></a>
                <a href="<?= $t['lang_href'] ?>" class="lang-toggle">
                    <?php if ($is_en): ?>
                      <svg width="20" height="14" viewBox="0 0 20 14" style="flex-shrink:0;">
                        <rect x="0" y="0" width="10" height="7" fill="white"/>
                        <rect x="10" y="0" width="10" height="7" fill="#cc0000"/>
                        <rect x="0" y="7" width="10" height="7" fill="#003189"/>
                        <rect x="10" y="7" width="10" height="7" fill="white"/>
                        <polygon points="5,1.5 5.9,4.2 8.8,4.2 6.4,5.9 7.3,8.6 5,6.9 2.7,8.6 3.6,5.9 1.2,4.2 4.1,4.2" fill="#cc0000"/>
                        <polygon points="15,5.5 15.9,8.2 18.8,8.2 16.4,9.9 17.3,12.6 15,10.9 12.7,12.6 13.6,9.9 11.2,8.2 14.1,8.2" fill="#003189"/>
                    </svg>
                    <?php else: ?>
                    <svg width="20" height="14" viewBox="0 0 20 14" style="flex-shrink:0;">
                        <rect x="0" y="0" width="20" height="14" fill="#B22234"/>
                        <rect x="0" y="2" width="20" height="2" fill="white"/>
                        <rect x="0" y="6" width="20" height="2" fill="white"/>
                        <rect x="0" y="10" width="20" height="2" fill="white"/>
                        <rect x="0" y="0" width="8" height="8" fill="#3C3B6E"/>
                    </svg>
                    <?php endif; ?>
                    <?= $t['lang_switch'] ?>
                </a>
                <div class="atp-badge">
                    <?= $t['atp_label'] ?> <a href="https://www.atp.gob.pa/industrias/hoteleros/" target="_blank">ATP</a>
                    · <?= $t['updated'] ?> <span id="formatted-date"><?= $t['loading'] ?></span>
                </div>
            </div>
        </div>
    </header>

    <div class="stats" id="statsPanel"><div class="loading"><?= $t['loading'] ?></div></div>

    <section class="search-section">
        <div class="search-box">
            <input type="text" id="searchInput" style="flex:1;min-width:60px;width:0;" placeholder="<?= $t['search_ph'] ?>">
            <button id="searchButton"><?= $t['search_btn'] ?></button>
            <button id="clearButton" style="flex-shrink:0;padding:7px 8px;background:#e1e5e9;color:#555;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap;" onclick="clearSearch()"><?= $t['clear_btn'] ?></button>
        </div>
        <div class="filters">
            <div class="filter-group">
                <label for="provinceFilter"><?= $t['province_lbl'] ?></label>
                <select id="provinceFilter"><option value=""><?= $t['province_all'] ?></option></select>
            </div>
            <div class="filter-group">
                <label for="typeFilter"><?= $t['type_lbl'] ?></label>
                <select id="typeFilter"><option value=""><?= $t['type_all'] ?></option></select>
            </div>
            <div class="filter-group">
                <label for="keywordFilter"><?= $t['keyword_lbl'] ?></label>
                <div style="display:flex;gap:5px;align-items:center;">
                    <select id="keywordFilter" style="flex:1;"><option value=""><?= $t['keyword_all'] ?></option></select>
                    <button type="button" onclick="addKeywordTag()" style="padding:6px 10px;background:#005ca9;color:white;border:none;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:700;flex-shrink:0;">+</button>
                </div>
            </div>
        </div>
        <div id="keyword-active-tags" style="display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;"></div>
    </section>

    <section class="results-section" id="resultsContainer">
        <div class="no-results"><p><?= $t['no_results'] ?></p></div>
    </section>

    <div style="text-align:center;padding:1.2rem 1rem;background:white;border-radius:10px;margin-bottom:1rem;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <p style="font-size:0.88rem;color:#555;margin-bottom:0.6rem;"><?= $t['join_text'] ?></p>
        <a href="join.html" style="display:inline-block;padding:9px 24px;background:#005ca9;color:white;text-decoration:none;border-radius:7px;font-weight:700;font-size:0.92rem;"><?= $t['join_btn'] ?></a>
    </div>
    <footer>
        <p style="font-size:0.8rem;"><?= $t['footer_data'] ?> <a href="https://www.atp.gob.pa/industrias/hoteleros/" target="_blank">Autoridad de Turismo de Panamá (ATP)</a><br><?= $t['footer_extra'] ?></p>
        <p style="margin-top:0.8rem;">
            <?= $t['footer_owned'] ?><br>
            RUC 1401220-1-627960 DV21<br>
            <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a>
        </p>
    </footer>
</div>

<button class="up-btn" id="up-btn" onclick="scrollToTop()" title="<?= $is_en ? 'Back to top' : 'Volver arriba' ?>">↑</button>

<script>
const LANG = '<?= $t['lang_js'] ?>';

const API_BASE_URL = '';
const searchInput      = document.getElementById('searchInput');
const searchButton     = document.getElementById('searchButton');
const provinceFilter   = document.getElementById('provinceFilter');
const typeFilter       = document.getElementById('typeFilter');
const resultsContainer = document.getElementById('resultsContainer');
const statsPanel       = document.getElementById('statsPanel');

async function loadInitialData() {
    await loadStats();
    await loadFilters();
    const stats = await fetch(`${API_BASE_URL}/api/stats`).then(r=>r.json()).catch(()=>({total_rentals:0}));
    if (stats.total_rentals === 0) {
        resultsContainer.innerHTML = '<div class="no-results"><p>El servidor está iniciando. Intente de nuevo en unos segundos.</p></div>';
        setTimeout(async () => { await loadStats(); await loadFilters(); restoreOrDefault(); }, 3000);
    } else {
        restoreOrDefault();
    }
}

function restoreOrDefault() {
    const saved = sessionStorage.getItem('tps_search_state');
    if (saved) {
        try {
            const params = JSON.parse(saved);
            sessionStorage.removeItem('tps_search_state');
            if (params.search || params.province || params.type) {
                if (params.search)   searchInput.value    = params.search;
                if (params.province) provinceFilter.value  = params.province;
                if (params.type)     typeFilter.value      = params.type;
                const savedScrollY = params.scrollY || 0;
                performSearch().then(() => {
                    // Restore exact scroll position
                    setTimeout(() => window.scrollTo({ top: savedScrollY, behavior: 'instant' }), 50);
                });
                return;
            }
        } catch(e) {}
    }
    showDefaultView();
}

function updatePageDates() {
    fetch(`${API_BASE_URL}/api/pdf-info`).then(r=>r.json()).then(data => {
        if (data.formattedDate && data.formattedDate !== 'Date not available') {
            const el = document.getElementById('formatted-date');
            if (el) el.textContent = data.formattedDate;
        }
    }).catch(()=>{});
}
document.addEventListener('DOMContentLoaded', () => { updatePageDates(); setInterval(updatePageDates, 30000); });

async function showDefaultView() {
    resultsContainer.innerHTML = '<div class="loading">Cargando...</div>';
    try {
        const res      = await fetch(`${API_BASE_URL}/api/featured-listing`);
        if (!res.ok) throw new Error();
        const featured = await res.json();
        if (!Array.isArray(featured) || !featured.length) throw new Error();
        featured.sort((a, b) => (a.feature_rank || 0) - (b.feature_rank || 0));

        resultsContainer.innerHTML = '<div style="font-size:0.78rem;font-weight:700;color:#b8860b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.4rem;">⭐ Hospedaje Destacado</div>';

        featured.forEach(rental => {
            const active  = isMemberActive(rental);
            const phone   = active ? (rental.phone_member || rental.phone) : rental.phone;
            const email   = active ? (rental.email_member || rental.email) : rental.email;
            const address = active ? (rental.address || '') : '';
            const ph      = getPhoneNumbers(phone);
            const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(rental.name+' '+(rental.province||'')+' Panama')}`;
            const photos  = Array.isArray(rental.photos) ? rental.photos : [];
            const thumb   = active && photos.length ? photos[0] : null;
            const listUrl = rental.slug
                ? `listing.html?slug=${rental.slug}&lang=es`
                : `listing.html?id=${rental.id}&lang=es`;
            const thumbHtml = (active && thumb)
                ? `<a href="${listUrl}" class="member-thumb" onclick="saveSearchState()">
                    <img src="${thumb}" alt="${rental.name}" loading="lazy" class="member-thumb-img">
                    <span class="member-thumb-label">Ver Más</span>
                   </a>`
                : '';

            const card = document.createElement('div');
            card.className = 'result-card is-member' + ((rental.feature_rank > 0) ? ' is-featured' : '');
            card.innerHTML = `
                <div class="card-body">
                    ${thumbHtml}
                    <div class="card-info">
                        <h3 class="result-title">${rental.name} <span style="font-size:0.65rem;color:#bbb;font-weight:400;vertical-align:middle;">#${rental.id||''}</span></h3>
                        <div class="result-badges">
                            ${rental.rental_type ? `<span class="result-badge badge-type">${rental.rental_type}</span>` : ''}
                            ${rental.province    ? `<span class="result-badge badge-province">${rental.province}</span>` : ''}
                            ${active             ? `<span class="result-badge badge-member">⭐ Miembro</span>` : ''}

                            ${rental.registry_source === 'mici'
                                ? `<span class="result-badge" style="background:#4a1a6b;color:#d4adf5;">✅ MiCI</span>`
                                : `<span class="result-badge" style="background:#1a5c1a;color:#adf5ad;">✅ ATP</span>`}
                            ${rental.apatel_member ? `<span class="result-badge" style="background:#1a3a6b;color:#7ec8e3;border:1px solid #3a5a8b;">🏨 APATEL</span>` : ''}
                        </div>
                        <div class="result-details">
                            ${ph.display ? `<div class="detail-item"><span>📞</span><span>${ph.display}</span></div>` : ''}
                            ${email      ? `<div class="detail-item"><span>✉️</span><span>${email}</span></div>` : ''}
                            ${address    ? `<div class="detail-item"><span>📍</span><span>${address}</span></div>` : ''}
                        </div>
                        <div class="contact-buttons">
                            ${ph.call     ? `<a href="tel:+507${ph.call}" class="contact-button"><span class="btn-icon">📞</span><span class="btn-text"> Llamar</span></a>` : ''}
                            ${email       ? `<a href="mailto:${email}" class="contact-button"><span class="btn-icon">✉️</span><span class="btn-text"> Correo</span></a>` : ''}
                            ${ph.whatsapp ? `<a href="https://wa.me/507${ph.whatsapp}" target="_blank" class="contact-button whatsapp-button"><span class="btn-icon">💬</span><span class="btn-text"> WhatsApp</span></a>` : ''}
                            <a href="${mapsUrl}" target="_blank" class="contact-button"><span class="btn-icon">📍</span><span class="btn-text"> Maps</span></a>
                            ${active ? `<a href="${listUrl}" onclick="saveSearchState()" class="contact-button" style="background:#b8860b;color:white;border:none;">🏨 Acceso</a>` : ''}
                        </div>
                    </div>
                </div>`;
            resultsContainer.appendChild(card);
        });

        const hint = document.createElement('div');
        hint.className = 'no-results';
        hint.style.padding = '0.8rem';
        hint.innerHTML = '<p>Use la búsqueda o los filtros para encontrar hospedajes específicos</p>';
        resultsContainer.appendChild(hint);

    } catch {
        resultsContainer.innerHTML = '<div class="no-results"><p>Use la búsqueda o los filtros para encontrar hospedajes registrados</p></div>';
    }
}

async function loadStats() {
    try {
        const stats = await (await fetch(`${API_BASE_URL}/api/stats`)).json();
        const total = stats.total_rentals || 0;
        if (total === 0) { statsPanel.innerHTML = ''; return; }
        // Fetch featured count in parallel
        const featuredData = await fetch('/api/featured-listing').then(r=>r.ok?r.json():[]).catch(()=>[]);
        const featuredCount = Array.isArray(featuredData) ? featuredData.length : 0;
        const featuredText = featuredCount > 0 ? ` · <strong>${featuredCount}</strong> destacado${featuredCount>1?'s':''}` : '';
        statsPanel.innerHTML = `<div style="display:flex;justify-content:center;flex-wrap:wrap;gap:12px;font-size:0.85rem;padding:0.3rem 0;">
            <span>🏨 <strong>${total}</strong> hospedajes verificados${featuredText}</span>
            <span id="selectedCount"></span></div>`;
    } catch { statsPanel.innerHTML = '<div style="color:#cc0000;">Error al cargar estadísticas</div>'; }
}

async function loadFilters() {
    try {
        const [pRes, tRes] = await Promise.all([fetch(`${API_BASE_URL}/api/provinces`), fetch(`${API_BASE_URL}/api/types`)]);
        const provinces = await pRes.json(); const types = await tRes.json();
        provinces.forEach(({ province, count }) => {
            const o = document.createElement('option'); o.value = province; o.textContent = `${province} (${count})`; provinceFilter.appendChild(o);
        });
        types.forEach(type => { const o = document.createElement('option'); o.value = type; o.textContent = type; typeFilter.appendChild(o); });
    } catch {}
}

async function performSearch() { // returns promise for .then() chaining
    const searchTerm = searchInput.value; const province = provinceFilter.value; const type = typeFilter.value;
    if (!searchTerm && !province && !type) { showDefaultView(); updateSelectedCount(null); return; }
    // Special filters (= prefix)
    if (searchTerm.startsWith('=')) {
        const cmd = searchTerm.toLowerCase().trim();
        resultsContainer.innerHTML = LANG === 'en' ? '<div class="loading">Searching...</div>' : '<div class="loading">Buscando...</div>';
        try {
            const allRentals = await (await fetch(`${API_BASE_URL}/api/rentals?search=`)).json();
            let filtered = allRentals;
            if      (cmd === '=no-email')  filtered = allRentals.filter(r => !r.email || !r.email.includes('@'));
            else if (cmd === '=apatel')    filtered = allRentals.filter(r => r.apatel_member);
            else if (cmd === '=member')    filtered = allRentals.filter(r => isMemberActive(r));
            else if (cmd === '=trial')     filtered = allRentals.filter(r => r.is_trial && isMemberActive(r));
            else if (cmd === '=no-phone')  filtered = allRentals.filter(r => !r.phone || r.phone.replace(/[^\d]/g,'').length < 7);
            else                           filtered = [];
            if (!filtered.length) {
                resultsContainer.innerHTML = '<div class="no-results"><p>No se encontraron hospedajes con ese filtro.</p></div>';
            } else {
                displayResults(filtered);
                updateSelectedCount(filtered.length);
            }
        } catch(e) { resultsContainer.innerHTML = '<div class="no-results"><p>Error: ' + e.message + '</p></div>'; }
        return;
    }
    // End special filters

    const params = new URLSearchParams();
    if (searchTerm) params.append('search', searchTerm);
    selectedKeywords.forEach(kw => params.append('keyword', kw));
    if (province)   params.append('province', province);
    if (type)       params.append('type', type);
    try {
        resultsContainer.innerHTML = LANG === 'en' ? '<div class="loading">Searching...</div>' : '<div class="loading">Buscando...</div>';
        const rentals = await (await fetch(`${API_BASE_URL}/api/rentals?${params}`)).json();
        updateSelectedCount(rentals.length); displayResults(rentals);
    } catch { resultsContainer.innerHTML = '<div class="no-results"><p>Error al buscar. Intente de nuevo.</p></div>'; }
}

function getPhoneNumbers(phoneStr) {
    if (!phoneStr) return { display: '', call: null, whatsapp: null };
    const nums = phoneStr.split('/').map(p=>p.trim().replace(/\D/g,'')).filter(p=>p.length>=7);
    const mobile = nums.filter(n=>n.startsWith('6')); const fixed = nums.filter(n=>!n.startsWith('6'));
    const call = (fixed[0]||mobile[0]||nums[0]||'').substring(0,8)||null;
    const whatsapp = mobile[0]?mobile[0].substring(0,8):null;
    const display = phoneStr.replace(/^\/+|\/+$/g,'').trim().replace(/\s*\/\s*/g,' / ');
    return { display, call, whatsapp };
}

function isMemberActive(rental) {
    if (!rental.is_member) return false;
    if (!rental.membership_paid_until) return false;
    return new Date(rental.membership_paid_until) >= new Date();
}

function displayResults(rentals) {
    resultsContainer.innerHTML = '';
    if (!rentals.length) { resultsContainer.innerHTML = '<div class="no-results"><p>No se encontraron hospedajes. Intente otra búsqueda.</p></div>'; return; }
    // Sort: 1=paid ATP, 2=paid MiCI, 3=trial, 4=non-members — alphabetical within each
    if (!document.getElementById('searchInput').value.trim()) {
      rentals.sort((a, b) => {
          const rank = r => {
              const active = r.is_member && r.membership_paid_until && new Date(r.membership_paid_until) >= new Date();
              if (!active) return 4;
              if (r.is_trial) return 3;
              if (r.registry_source === 'mici') return 2;
              return 1;
          };
          const ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          return (a.name || '').localeCompare(b.name || '');
      });
    }
    rentals.forEach(rental => {
        const card = document.createElement('div');
        const active = isMemberActive(rental);
        card.className = 'result-card' + (active ? ' is-member' : '');
        const phone   = active ? (rental.phone_member || rental.phone) : rental.phone;
        const email   = active ? (rental.email_member || rental.email) : rental.email;
        const address = active ? (rental.address || '') : '';
        const ph      = getPhoneNumbers(phone);
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(rental.name+' '+(rental.province||'')+' Panama')}`;
        const photos  = Array.isArray(rental.photos) ? rental.photos : [];
        const thumb   = active && photos.length ? photos[0] : null;
        const searchState = new URLSearchParams(window.location.search).toString();
        const listUrl = (rental.slug
            ? `listing.html?slug=${rental.slug}&lang=es`
            : `listing.html?id=${rental.id}&lang=es`) + (searchState ? `&from=${encodeURIComponent(window.location.search)}` : '');
        const thumbHtml = (active && thumb)
                ? `<a href="${listUrl}" class="member-thumb" onclick="saveSearchState()">
                    <img src="${thumb}" alt="${rental.name}" loading="lazy" class="member-thumb-img">
                    <span class="member-thumb-label">Ver Más</span>
                   </a>`
                : '';
        card.innerHTML = `
            <h3 class="result-title">${rental.name} <span style="font-size:0.65rem;color:#bbb;font-weight:400;vertical-align:middle;">#${rental.id||''}</span></h3>
            <div class="result-badges">
                ${rental.rental_type ? `<span class="result-badge badge-type">${rental.rental_type}</span>` : ''}
                ${rental.province    ? `<span class="result-badge badge-province">${rental.province}</span>` : ''}
                ${active             ? `<span class="result-badge badge-member">⭐ Miembro</span>` : ''}
                ${rental.apatel_member ? `<span class="result-badge" style="background:#1a3a6b;color:#7ec8e3;border:1px solid #3a5a8b;">🏨 APATEL</span>` : ''}
                ${active && rental.registry_source === 'mici' ? `<span class="result-badge" style="background:#4a1a6b;color:#d4adf5;">✅ MiCI</span>` : (rental.atp_active !== false ? `<span class="result-badge" style="background:#1a5c1a;color:#adf5ad;">✅ ATP</span>` : '')}
            </div>
            <div class="card-body">
                ${thumbHtml}
                <div class="card-info">
                    <div class="result-details">
                        ${ph.display ? `<div class="detail-item"><span>📞</span><span>${ph.display}</span></div>` : ''}
                        ${email      ? `<div class="detail-item"><span>✉️</span><span>${email}</span></div>` : ''}
                        ${address    ? `<div class="detail-item"><span>📍</span><span>${address}</span></div>` : ''}
                    </div>
                    <div class="contact-buttons">
                        ${ph.call     ? `<a href="tel:+507${ph.call}" class="contact-button"><span class="btn-icon">📞</span><span class="btn-text"> Llamar</span></a>` : ''}
                        ${email       ? `<a href="mailto:${email}" class="contact-button"><span class="btn-icon">✉️</span><span class="btn-text"> Correo</span></a>` : ''}
                        ${ph.whatsapp ? `<a href="https://wa.me/507${ph.whatsapp}" target="_blank" class="contact-button whatsapp-button"><span class="btn-icon">💬</span><span class="btn-text"> WhatsApp</span></a>` : ''}
                        <a href="${mapsUrl}" target="_blank" class="contact-button"><span class="btn-icon">📍</span><span class="btn-text"> Maps</span></a>
                            ${active ? `<a href="${listUrl}" onclick="saveSearchState()" class="contact-button" style="background:#b8860b;color:white;border:none;">🏨 Acceso</a>` : ''}
                    </div>
                </div>
            </div>`;
        resultsContainer.appendChild(card);
    });
}

function updateSelectedCount(count) {
    const el = document.getElementById('selectedCount');
    if (!el) return;
    if (count === null) {
        // Restore featured count
        const fc = document.getElementById('featuredCount');
        el.innerHTML = '<span id="featuredCount">' + (fc ? fc.innerHTML : '') + '</span>';
    } else {
        el.innerHTML = `· <strong>${count} seleccionados</strong>`;
    }
}

searchButton.addEventListener('click', () => performSearch().then(scrollToResults));
searchInput.addEventListener('keypress', e => { if (e.key === 'Enter') performSearch().then(scrollToResults); });
provinceFilter.addEventListener('change', () => performSearch().then(scrollToResults));
typeFilter.addEventListener('change', () => performSearch().then(scrollToResults));
function clearSearch() {
    searchInput.value = '';
    provinceFilter.value = '';
    typeFilter.value = '';
    showDefaultView();
    updateSelectedCount(null);
}


// ── Scroll to results after search ───────────────────────────────────────────
function saveSearchState() {
    const params = {
        search:   searchInput?.value || '',
        province: provinceFilter?.value || '',
        type:     typeFilter?.value || '',
        scrollY:  window.scrollY
    };
    sessionStorage.setItem('tps_search_state', JSON.stringify(params));
}

function scrollToResults() {
    // Scroll to first result card, not the container top
    const firstCard = document.querySelector('.result-card');
    const target    = firstCard || document.getElementById('results-container');
    if (!target) return;
    const y = target.getBoundingClientRect().top + window.scrollY - 8;
    window.scrollTo({ top: y, behavior: 'smooth' });
}

function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Show/hide UP button based on scroll position
window.addEventListener('scroll', () => {
    const upBtn = document.getElementById('up-btn');
    if (!upBtn) return;
    if (window.scrollY > 200) upBtn.classList.add('visible');
    else upBtn.classList.remove('visible');
});

loadInitialData();

// ── Load keyword filter ───────────────────────────────────────────────────────
let selectedKeywords = new Set();
let keywordData = [];

async function loadKeywords() {
    try {
        keywordData = await (await fetch(API_BASE_URL + '/api/keywords')).json();
        const sel = document.getElementById('keywordFilter');
        if (!sel || !keywordData.length) return;
        const categories = {};
        keywordData.forEach(k => {
            const cat = LANG === 'en' ? k.category_en : k.category_es;
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(k);
        });
        Object.entries(categories).forEach(([cat, items]) => {
            const grp = document.createElement('optgroup');
            grp.label = cat;
            items.forEach(k => {
                const opt = document.createElement('option');
                opt.value = k.slug;
                opt.textContent = LANG === 'en' ? k.label_en : k.label_es;
                grp.appendChild(opt);
            });
            sel.appendChild(grp);
        });
    } catch(e) { console.error('Keywords load error:', e); }
}

function addKeywordTag() {
    const sel = document.getElementById('keywordFilter');
    const slug = sel.value;
    if (!slug || selectedKeywords.has(slug)) return;
    selectedKeywords.add(slug);
    const k = keywordData.find(x => x.slug === slug);
    const label = k ? (LANG === 'en' ? k.label_en : k.label_es) : slug;
    const tag = document.createElement('span');
    tag.dataset.slug = slug;
    tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 12px;background:#005ca9;color:white;border-radius:20px;font-size:0.8rem;cursor:pointer;';
    tag.innerHTML = label + ' ✕';
    tag.onclick = function() { removeKeywordTag(this); };
    document.getElementById('keyword-active-tags').appendChild(tag);
    sel.value = '';
    performSearch();
}


function removeKeywordTag(btn) {
    const tag = btn.parentElement;
    selectedKeywords.delete(tag.dataset.slug);
    tag.remove();
    performSearch();
}

loadKeywords();

// Track site visit
fetch('/api/track', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({event_type: 'site_visit'})
}).catch(function(){});

</script>
</body>
</html>
