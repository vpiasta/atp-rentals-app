<?php
/**
 * Shared TPS email-sending function — extracted from notify.php so any PHP
 * script (not just Node via CLI) can send mail directly, in-process, with
 * no subprocess or HTTP call involved. Uses the same PHPMailer + SMTP
 * config as aparthotel-boquete.com.
 *
 * Returns true on success, or an error message string on failure.
 */
function send_tps_email($subject, $htmlBody, $to, $fromEmail = 'info@trustedpanamastays.com', $fromName = 'Trusted Panama Stays', $cc = null) {
    require_once '/home/u945180857/secure_beds24_tokens/env_loader.php';
    loadEnv('/home/u945180857/secure_beds24_tokens/.env');

    require_once '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/Exception.php';
    require_once '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/PHPMailer.php';
    require_once '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/SMTP.php';

    $mail = new \PHPMailer\PHPMailer\PHPMailer(true);

    try {
        $mail->CharSet  = 'UTF-8';
        $mail->Encoding = 'base64';
        $mail->isSMTP();
        $mail->Host       = env('SMTP_TPS_HOST');
        $mail->SMTPAuth   = true;
        $mail->Username   = env('SMTP_TPS_USERNAME');
        $mail->Password   = env('SMTP_TPS_PASSWORD');
        $mail->SMTPSecure = 'tls';
        $mail->Port       = env('SMTP_TPS_PORT');
        $mail->SMTPDebug  = 0;

        $mail->setFrom($fromEmail, $fromName);
        $mail->addAddress($to);
        if ($cc) { $mail->addCC($cc); }
        $mail->Subject = $subject;
        $mail->Body    = $htmlBody;
        $mail->isHTML(true);

        $mail->send();
        return true;
    } catch (\PHPMailer\PHPMailer\Exception $e) {
        error_log('[TPS send_tps_email] Email error: ' . $mail->ErrorInfo);
        return $mail->ErrorInfo ?: $e->getMessage();
    }
}
