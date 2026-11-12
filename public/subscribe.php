<?php
require_once __DIR__ . '/includes/supabase-config.php'; // canonical-host redirect (www → bare domain)
$lang  = isset($_GET['lang']) && $_GET['lang'] === 'en' ? 'en' : 'es';
$is_en = $lang === 'en';

$action = $_GET['action'] ?? '';
$status = $_GET['status'] ?? '';
$token  = preg_match('/^[0-9a-f-]{36}$/i', $_GET['token'] ?? '') ? $_GET['token'] : '';
$pre_listing = ctype_digit((string)($_GET['listing_id'] ?? '')) ? (int)$_GET['listing_id'] : 0;
$pre_name    = mb_substr(trim((string)($_GET['name'] ?? '')), 0, 200);

$heading          = 'Trusted Panama Stays';
$subheading       = $is_en ? 'Directory of legally registered accommodations in Panama' : 'Directorio de hospedajes legalmente registrados en Panamá';
$qs               = $_GET; $qs['lang'] = $is_en ? 'es' : 'en';
$lang_toggle_href = 'subscribe.php?' . http_build_query($qs);
$show_atp_badge   = false;

$t = $is_en ? [
    'title'      => 'Legal updates for accommodations — Trusted Panama Stays',
    'h2'         => 'Free legal updates for accommodations',
    'intro'      => 'We send occasional, free information about legal requirements and law changes that affect short-term rentals, hostels and hotels in Panama. No advertising. You can unsubscribe at any time.',
    'email'      => 'Email address',
    'name'       => 'Name of your accommodation (optional)',
    'consent'    => 'I agree to receive emails from Trusted Panama Stays with information about legal requirements and law changes for accommodations. I can unsubscribe at any time.',
    'submit'     => 'Subscribe',
    'sent'       => 'Almost done: we sent you an email. Please click the confirmation link in it. (Check your spam folder if you don\'t see it.)',
    'recent'     => 'We already sent you a confirmation email a few minutes ago. Please check your inbox and spam folder.',
    'already'    => 'This address is already subscribed. Thank you!',
    'err_email'  => 'Please enter a valid email address.',
    'err_consent'=> 'Please tick the consent box.',
    'err'        => 'Something went wrong. Please try again later or write to info@trustedpanamastays.com.',
    'confirmed'  => '✅ Thank you — your subscription is confirmed.',
    'invalid'    => 'This confirmation link is invalid or has expired. You can subscribe again below.',
    'unsub_q'    => 'Do you want to stop receiving our emails?',
    'unsub_btn'  => 'Yes, unsubscribe me',
    'unsub_ok'   => 'You have been unsubscribed. You will not receive any more information emails from us.',
    'privacy'    => 'We use your address only for these emails and never share it.',
] : [
    'title'      => 'Avisos legales para hospedajes — Trusted Panama Stays',
    'h2'         => 'Avisos legales gratuitos para hospedajes',
    'intro'      => 'Enviamos ocasionalmente información gratuita sobre requisitos legales y cambios en las leyes que afectan a hospedajes de corta estancia, hostales y hoteles en Panamá. Sin publicidad. Puede darse de baja en cualquier momento.',
    'email'      => 'Correo electrónico',
    'name'       => 'Nombre de su hospedaje (opcional)',
    'consent'    => 'Acepto recibir por correo información de Trusted Panama Stays sobre requisitos legales y cambios en las leyes para hospedajes. Puedo darme de baja en cualquier momento.',
    'submit'     => 'Suscribirme',
    'sent'       => 'Casi listo: le enviamos un correo. Por favor haga clic en el enlace de confirmación. (Revise la carpeta de spam si no lo ve.)',
    'recent'     => 'Ya le enviamos un correo de confirmación hace unos minutos. Revise su bandeja de entrada y la carpeta de spam.',
    'already'    => 'Esta dirección ya está suscrita. ¡Gracias!',
    'err_email'  => 'Por favor ingrese un correo electrónico válido.',
    'err_consent'=> 'Por favor marque la casilla de consentimiento.',
    'err'        => 'Ocurrió un error. Intente más tarde o escriba a info@trustedpanamastays.com.',
    'confirmed'  => '✅ Gracias — su suscripción está confirmada.',
    'invalid'    => 'Este enlace de confirmación no es válido o ha expirado. Puede suscribirse de nuevo abajo.',
    'unsub_q'    => '¿Desea dejar de recibir nuestros correos?',
    'unsub_btn'  => 'Sí, darme de baja',
    'unsub_ok'   => 'Se ha dado de baja. No recibirá más correos informativos de nuestra parte.',
    'privacy'    => 'Usamos su dirección solo para estos correos y nunca la compartimos.',
];
?>
<!DOCTYPE html>
<html lang="<?= $lang ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars($t['title']) ?></title>
    <meta name="description" content="<?= htmlspecialchars($t['intro']) ?>">
    <link rel="canonical" href="https://trustedpanamastays.com/subscribe.php?lang=<?= $lang ?>">
    <?php if ($action || $status): ?><meta name="robots" content="noindex,follow"><?php endif; ?>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="stylesheet" href="/css/site-header-footer.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8f9fa; color: #111; line-height: 1.6; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .content { background: white; border-radius: 12px; padding: 2rem 2.5rem; box-shadow: 0 2px 20px rgba(0,0,0,0.08); margin-bottom: 1.5rem; }
        h2 { color: #005ca9; font-size: 1.4rem; margin-bottom: 0.8rem; }
        p { margin-bottom: 1rem; }
        label.field { display: block; font-weight: 600; font-size: 0.9rem; margin: 1rem 0 0.3rem; color: #333; }
        input[type=email], input[type=text] { width: 100%; padding: 0.65rem 0.8rem; border: 1px solid #ccd; border-radius: 8px; font-size: 1rem; }
        .consent { display: flex; gap: 10px; align-items: flex-start; margin: 1.2rem 0; font-size: 0.9rem; }
        .consent input { width: 18px; height: 18px; margin-top: 3px; flex-shrink: 0; }
        .hp { position: absolute; left: -9999px; }
        button { background: #005ca9; color: white; border: none; padding: 0.75rem 1.8rem; border-radius: 8px; font-size: 1rem; font-weight: 700; cursor: pointer; }
        button:disabled { opacity: 0.6; cursor: default; }
        .msg { padding: 0.9rem 1rem; border-radius: 8px; margin: 1rem 0; display: none; }
        .msg.ok  { display: block; background: #e8f6ee; border: 1px solid #9fd5b5; color: #145a32; }
        .msg.err { display: block; background: #fdecea; border: 1px solid #f5b7b1; color: #922b21; }
        .small { font-size: 0.8rem; color: #666; margin-top: 1rem; }
        footer { background: #2c3e50; color: #ccc; border-radius: 10px; padding: 1.2rem 1.5rem; margin-top: 1.5rem; text-align: center; font-size: 0.85rem; line-height: 1.8; }
        footer a { color: #7ec8e3; text-decoration: none; }
    </style>
</head>
<body>
<div class="container">
<?php include __DIR__ . '/includes/header.php'; ?>

    <div class="content">
    <?php if ($action === 'unsubscribe' && $token): ?>
        <h2><?= $t['unsub_q'] ?></h2>
        <div id="msg" class="msg"></div>
        <button id="unsub-btn" type="button"><?= $t['unsub_btn'] ?></button>
        <script>
        document.getElementById('unsub-btn').addEventListener('click', async function () {
            const btn = this, msg = document.getElementById('msg');
            btn.disabled = true;
            try {
                const r = await fetch('/api/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: <?= json_encode($token) ?> }) });
                if (!r.ok) throw new Error();
                msg.className = 'msg ok'; msg.textContent = <?= json_encode($t['unsub_ok']) ?>;
                btn.style.display = 'none';
            } catch (e) {
                msg.className = 'msg err'; msg.textContent = <?= json_encode($t['err']) ?>;
                btn.disabled = false;
            }
        });
        </script>
    <?php elseif ($status === 'confirmed'): ?>
        <h2><?= $t['h2'] ?></h2>
        <div class="msg ok"><?= $t['confirmed'] ?></div>
    <?php else: ?>
        <h2><?= $t['h2'] ?></h2>
        <?php if ($status === 'invalid'): ?><div class="msg err"><?= $t['invalid'] ?></div><?php endif; ?>
        <p><?= $t['intro'] ?></p>
        <form id="sub-form" novalidate>
            <label class="field" for="sub-email"><?= $t['email'] ?> *</label>
            <input type="email" id="sub-email" autocomplete="email" required>
            <label class="field" for="sub-name"><?= $t['name'] ?></label>
            <input type="text" id="sub-name" maxlength="200" value="<?= htmlspecialchars($pre_name, ENT_QUOTES, 'UTF-8') ?>">
            <input type="text" id="sub-website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
            <div class="consent">
                <input type="checkbox" id="sub-consent">
                <label for="sub-consent"><?= $t['consent'] ?></label>
            </div>
            <button type="submit" id="sub-btn"><?= $t['submit'] ?></button>
            <div id="msg" class="msg"></div>
            <p class="small"><?= $t['privacy'] ?></p>
        </form>
        <script>
        const T = <?= json_encode($t, JSON_UNESCAPED_UNICODE) ?>;
        document.getElementById('sub-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            const msg = document.getElementById('msg'), btn = document.getElementById('sub-btn');
            const email = document.getElementById('sub-email').value.trim();
            const show = (cls, text) => { msg.className = 'msg ' + cls; msg.textContent = text; };
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return show('err', T.err_email);
            if (!document.getElementById('sub-consent').checked) return show('err', T.err_consent);
            btn.disabled = true;
            try {
                const r = await fetch('/api/subscribe', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email, name: document.getElementById('sub-name').value.trim(),
                        lang: <?= json_encode($lang) ?>, consent: true,
                        listing_id: <?= $pre_listing ?: 'null' ?>,
                        website: document.getElementById('sub-website').value
                    })
                });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) { btn.disabled = false; return show('err', d.error === 'invalid_email' ? T.err_email : T.err); }
                show('ok', d.result === 'already' ? T.already : d.result === 'recently_sent' ? T.recent : T.sent);
                document.getElementById('sub-form').querySelectorAll('input, button').forEach(el => el.disabled = true);
            } catch (err) {
                btn.disabled = false; show('err', T.err);
            }
        });
        </script>
    <?php endif; ?>
    </div>

    <footer>
        <p>Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
        <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a></p>
    </footer>
</div>
</body>
</html>
