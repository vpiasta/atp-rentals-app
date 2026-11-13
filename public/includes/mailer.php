<?php
/**
 * Shared TPS email-sending function — extracted from notify.php so any PHP
 * script (not just Node via CLI) can send mail directly, in-process, with
 * no subprocess or HTTP call involved. Uses the same PHPMailer + SMTP
 * config as aparthotel-boquete.com.
 *
 * Returns true on success, or an error message string on failure.
 *
 * Two hardening measures added 2026-11-04, after a review found every single
 * admin-facing notification (ATP report changes, new applications, payment
 * proofs, trial submissions, the daily pending-check...) went through this
 * one function, over one provider (Brevo), to one inbox (info@), with no
 * fallback at all — a Brevo hiccup or an unread inbox meant total silence:
 *   1. Any email addressed to info@trustedpanamastays.com is automatically
 *      CC'd to Volker's personal inbox too, so a second person always sees
 *      it — fixed here, once, instead of touching every call site.
 *   2. If the primary SMTP send (Brevo) throws, this retries once via PHP's
 *      built-in mail() — a transport that doesn't depend on Brevo being up
 *      at all. mail() has weaker deliverability (no DKIM alignment through
 *      Brevo), so it's a last-resort fallback, not a replacement for
 *      finishing the DMARC/branded-subdomain setup in email-deliverability
 *      notes — just insurance against total silence in the meantime.
 *
 * 2026-11-13: Brevo closed sending on the TPS account for good (contacts from
 * the ATP report had no opt-in). The primary transport is now the Hostinger
 * mailbox's own SMTP server — set in the .env, not here:
 *   SMTP_TPS_HOST=smtp.hostinger.com   SMTP_TPS_PORT=465
 *   SMTP_TPS_USERNAME=info@trustedpanamastays.com   SMTP_TPS_PASSWORD=<mailbox password>
 * Port 465 uses implicit SSL, any other port STARTTLS. A mailbox SMTP server
 * only lets you send as the mailbox you log in with, so if the caller asks
 * for another From (e.g. members@), the e-mail goes out From the login
 * mailbox and the requested address becomes the Reply-To.
 */
function send_tps_email($subject, $htmlBody, $to, $fromEmail = 'info@trustedpanamastays.com', $fromName = 'Trusted Panama Stays', $cc = null) {
    require_once '/home/u945180857/secure_beds24_tokens/env_loader.php';
    loadEnv('/home/u945180857/secure_beds24_tokens/.env');

    require_once '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/Exception.php';
    require_once '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/PHPMailer.php';
    require_once '/home/u945180857/domains/aparthotel-boquete.com/public_html/PHPMailer-master/src/SMTP.php';

    $ccList = [];
    if ($cc) { $ccList[] = $cc; }
    if (strcasecmp($to, 'info@trustedpanamastays.com') === 0 && strcasecmp((string)$cc, 'v.piasta@gmail.com') !== 0) {
        $ccList[] = 'v.piasta@gmail.com';
    }

    $mail = new \PHPMailer\PHPMailer\PHPMailer(true);

    try {
        $mail->CharSet  = 'UTF-8';
        $mail->Encoding = 'base64';
        $mail->isSMTP();
        $mail->Host       = env('SMTP_TPS_HOST');
        $mail->SMTPAuth   = true;
        $mail->Username   = env('SMTP_TPS_USERNAME');
        $mail->Password   = env('SMTP_TPS_PASSWORD');
        $mail->Port       = (int) env('SMTP_TPS_PORT');
        $mail->SMTPSecure = ($mail->Port === 465) ? 'ssl' : 'tls';
        $mail->SMTPDebug  = 0;

        $smtpUser = (string) env('SMTP_TPS_USERNAME');
        if (strpos($smtpUser, '@') !== false && strcasecmp($fromEmail, $smtpUser) !== 0) {
            $mail->setFrom($smtpUser, $fromName);
            $mail->addReplyTo($fromEmail, $fromName);
        } else {
            $mail->setFrom($fromEmail, $fromName);
        }
        $mail->addAddress($to);
        foreach ($ccList as $ccAddr) { $mail->addCC($ccAddr); }
        $mail->Subject = $subject;
        $mail->Body    = $htmlBody;
        $mail->isHTML(true);

        $mail->send();
        return true;
    } catch (\PHPMailer\PHPMailer\Exception $e) {
        $primaryError = $mail->ErrorInfo ?: $e->getMessage();
        error_log('[TPS send_tps_email] Primary SMTP failed: ' . $primaryError . ' — trying mail() fallback');

        // Last-resort fallback: PHP mail(), independent of the SMTP login.
        $headers  = "MIME-Version: 1.0\r\n";
        $headers .= "Content-Type: text/html; charset=UTF-8\r\n";
        $headers .= "From: {$fromName} <{$fromEmail}>\r\n";
        if ($ccList) { $headers .= "Cc: " . implode(', ', $ccList) . "\r\n"; }

        $fallbackOk = @mail($to, $subject, $htmlBody, $headers);
        if ($fallbackOk) {
            error_log('[TPS send_tps_email] mail() fallback succeeded for: ' . $subject);
            return true;
        }
        error_log('[TPS send_tps_email] mail() fallback ALSO failed for: ' . $subject);
        return $primaryError;
    }
}
