<?php
/**
 * notify.php - Email notification handler for TrustedPanamaStays
 * Place in: /home/u945180857/domains/trustedpanamastays.com/nodejs/public/notify.php
 * Called by Node.js via execFile('php', ['/path/to/notify.php', subject, message])
 * Uses same PHPMailer + SMTP config as aparthotel-boquete.com
 */

// ── Security: only allow calls from localhost (Node.js) ──────────────────────
$allowedIPs = ['127.0.0.1', '::1', 'localhost'];
$callerIP = $_SERVER['REMOTE_ADDR'] ?? '';
// When called via CLI (execFile), REMOTE_ADDR is not set — that's fine
$isCLI = (php_sapi_name() === 'cli');

if (!$isCLI && !in_array($callerIP, $allowedIPs)) {
    http_response_code(403);
    echo json_encode(['error' => 'Access denied']);
    exit;
}

// ── Load arguments ────────────────────────────────────────────────────────────
// When called from Node.js via execFile:
// php notify.php "subject" "html_message" "recipient_email"
$subject  = $argv[1] ?? 'Notificación - Trusted Panama Stays';
$message  = $argv[2] ?? '(sin mensaje)';
$to       = $argv[3] ?? 'info@trustedpanamastays.com';

// ── Load environment variables (shared with aparthotel-boquete.com) ──────────
require_once '/home/u945180857/secure_beds24_tokens/env_loader.php';
loadEnv('/home/u945180857/secure_beds24_tokens/.env');

// ── Load PHPMailer (from aparthotel-boquete.com shared path) ─────────────────
require '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/Exception.php';
require '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/PHPMailer.php';
require '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/SMTP.php';

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

$mail = new PHPMailer(true);

try {
    $mail->CharSet  = 'UTF-8';
    $mail->Encoding = 'base64';
    $mail->isSMTP();
    $mail->Host       = env('SMTP_TPS_HOST');
    $mail->SMTPAuth   = true;
    $mail->Username   = env('SMTP_TPS_USERNAME');
    $mail->Password   = env('SMTP_TPS_PASSWORD');
    $mail->SMTPSecure = 'ssl';
    $mail->Port       = env('SMTP_TPS_PORT');
    $mail->SMTPDebug  = 0;

    $mail->setFrom('info@trustedpanamastays.com', 'Trusted Panama Stays');
    $mail->addAddress($to);
    $mail->addCC('info@trustedpanamastays.com');
    $mail->Subject = $subject;
    $mail->Body    = $message;
    $mail->isHTML(true);

    $mail->send();
    echo json_encode(['success' => true]);

} catch (Exception $e) {
    echo json_encode(['error' => $mail->ErrorInfo]);
    // Log error
    error_log('[TPS notify.php] Email error: ' . $e->getMessage());
}
?>
