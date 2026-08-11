<?php
/**
 * Shared site header/nav. Include right after opening <body><div class="container">.
 *
 * Required variables (set by the including page before include):
 *   $lang              'en' | 'es'
 *   $is_en             bool
 *   $heading           string — H1 text shown in the header
 *   $subheading        string — tagline shown under H1
 *   $lang_toggle_href  string — link to THIS SAME PAGE in the other language
 *
 * Optional:
 *   $show_atp_badge    bool (default true)
 *   $atp_badge_extra   string — extra HTML appended after the ATP link (e.g. "Updated:" date span)
 */
if (!isset($show_atp_badge))  $show_atp_badge  = true;
if (!isset($atp_badge_extra)) $atp_badge_extra = '';
?>
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
                <h1><?= htmlspecialchars($heading, ENT_QUOTES, 'UTF-8') ?></h1>
                <p><?= htmlspecialchars($subheading, ENT_QUOTES, 'UTF-8') ?></p>
            </div>
            <div class="header-right">
              <a href="/about.html?lang=<?= $lang ?>" class="lang-toggle"><?= $is_en ? 'About us' : 'Quiénes somos' ?></a>
              <a href="/faq.php?lang=<?= $lang ?>" class="lang-toggle"><?= $is_en ? 'FAQ' : 'Preguntas' ?></a>
              <a href="/blog.php?lang=<?= $lang ?>" class="lang-toggle">Blog</a>
                <a href="<?= htmlspecialchars($lang_toggle_href, ENT_QUOTES, 'UTF-8') ?>" class="lang-toggle">
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
                    <?= $is_en ? 'Español' : 'English' ?>
                </a>
                <?php if ($show_atp_badge): ?>
                <div class="atp-badge">
                    <?= $is_en ? 'Based on public data from' : 'Basado en datos públicos de' ?> <a href="https://www.atp.gob.pa/industrias/hoteleros/" target="_blank">ATP</a>
                    <?= $atp_badge_extra ?>
                </div>
                <?php endif; ?>
            </div>
        </div>
    </header>
