<?php
/**
 * Small "free legal updates for owners" box, shown at the end of blog posts
 * and TPSipedia pages. Links to subscribe.php (double opt-in). Added 2026-11-12.
 * Requires $is_en / $lang from the including page.
 */
$__sb_en = !empty($is_en);
?>
<div style="background:#f0f7ff;border:1px solid #c0d8f0;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0;display:flex;gap:1rem;align-items:center;flex-wrap:wrap;">
    <div style="flex:1;min-width:220px;">
        <strong style="color:#005ca9;"><?= $__sb_en ? '📬 For accommodation owners' : '📬 Para propietarios de hospedajes' ?></strong><br>
        <span style="font-size:0.9rem;color:#333;"><?= $__sb_en
            ? 'Get our next update on legal requirements and law changes by email — free, no advertising, unsubscribe any time.'
            : 'Reciba por correo el próximo aviso sobre requisitos legales y cambios en las leyes — gratis, sin publicidad, puede darse de baja cuando quiera.' ?></span>
    </div>
    <a href="/subscribe.php?lang=<?= $__sb_en ? 'en' : 'es' ?>" style="background:#005ca9;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:700;white-space:nowrap;"><?= $__sb_en ? 'Subscribe →' : 'Suscribirme →' ?></a>
</div>
