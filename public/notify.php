<?php
/**
 * notify.php - CLI entry point, called by Node.js via
 * execFile('php', [notifyPath, subject, html, to, fromEmail, fromName]).
 * Actual sending logic lives in includes/mailer.php so other PHP scripts
 * (e.g. blog-post.php) can send mail directly, without shelling out to
 * this script or making any HTTP call.
 */

// ── Security: only allow calls from localhost (Node.js) ──────────────────────
$allowedIPs = ['127.0.0.1', '::1', 'localhost'];
$callerIP = $_SERVER['REMOTE_ADDR'] ?? '';
$isCLI = (php_sapi_name() === 'cli');

if (!$isCLI && !in_array($callerIP, $allowedIPs)) {
    http_response_code(403);
    echo json_encode(['error' => 'Access denied']);
    exit;
}

require_once __DIR__ . '/includes/mailer.php';

// php notify.php "subject" "html_message" "recipient_email" "from_email" "from_name" "cc_email"
$subject   = $argv[1] ?? 'Notificación - Trusted Panama Stays';
$message   = $argv[2] ?? '(sin mensaje)';
$to        = $argv[3] ?? 'info@trustedpanamastays.com';
$fromEmail = $argv[4] ?? 'info@trustedpanamastays.com';
$fromName  = $argv[5] ?? 'Trusted Panama Stays';
$cc        = $argv[6] ?? null;

$result = send_tps_email($subject, $message, $to, $fromEmail, $fromName, $cc);
echo json_encode($result === true ? ['success' => true] : ['error' => $result]);
