<?php
//ini_set('display_errors', '1');
//error_reporting(E_ALL);
require_once __DIR__ . '/includes/supabase-config.php';
require_once __DIR__ . '/includes/mailer.php';

function json_out($arr, $code = 200) {
    header('Content-Type: application/json');
    http_response_code($code);
    echo json_encode($arr);
    exit;
}

function random_token() {
    return bin2hex(random_bytes(24));
}

function fetch_comment_by_id($id) {
    list($code, $data) = supabase_request('GET', '/rest/v1/blog_comments?select=*&id=eq.' . urlencode($id) . '&limit=1', SUPABASE_SERVICE_KEY);
    return (is_array($data) && count($data)) ? $data[0] : null;
}

function fetch_post_slug($postId) {
    list($code, $data) = supabase_request('GET', '/rest/v1/blog_posts?select=slug&id=eq.' . urlencode($postId) . '&limit=1', SUPABASE_SERVICE_KEY);
    return (is_array($data) && count($data)) ? $data[0]['slug'] : null;
}

function approve_comment($commentId) {
    supabase_request('PATCH', '/rest/v1/blog_comments?id=eq.' . urlencode($commentId), SUPABASE_SERVICE_KEY, [
        'status' => 'approved',
        'approved_at' => date('c'),
    ]);
}

function find_token_row($token, $action) {
    list($code, $data) = supabase_request('GET', '/rest/v1/blog_comment_tokens?select=*&token=eq.' . urlencode($token) . '&action=eq.' . urlencode($action) . '&expires_at=gt.' . urlencode(date('c')) . '&limit=1', SUPABASE_SERVICE_KEY);
    return (is_array($data) && count($data)) ? $data[0] : null;
}

function mark_token_used($tokenRowId) {
    supabase_request('PATCH', '/rest/v1/blog_comment_tokens?id=eq.' . urlencode($tokenRowId), SUPABASE_SERVICE_KEY, [
        'used_at' => date('c'),
    ]);
}

function html_page($msg) {
    header('Content-Type: text/html; charset=UTF-8');
    echo '<!DOCTYPE html><html lang="es"><meta charset="UTF-8"><body style="font-family:sans-serif;text-align:center;padding:3rem;">' . $msg . '</body></html>';
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];

// ── GET: ACEPTAR / CONTESTAR links from the moderation email ─────────────────
if ($method === 'GET') {
    $token  = $_GET['token']  ?? '';
    $action = $_GET['action'] ?? '';

    if ($action === 'approve') {
        $row = find_token_row($token, 'approve');
        if (!$row) html_page('<p>Enlace inválido o vencido.</p>');
        approve_comment($row['comment_id']);
        mark_token_used($row['id']);
        html_page('<h2>&#10003; Comentario aprobado</h2><p>Ya es visible en el blog.</p>');
    }

    if ($action === 'reply') {
        $row = find_token_row($token, 'reply');
        if (!$row) html_page('<p>Enlace inválido o vencido.</p>');
        approve_comment($row['comment_id']);
        $comment = fetch_comment_by_id($row['comment_id']);
        $slug = $comment ? fetch_post_slug($comment['post_id']) : null;
        if (!$slug) html_page('<p>No se encontró la publicación.</p>');
        header('Location: /blog-post.php?slug=' . urlencode($slug) . '&reply_to=' . urlencode($row['comment_id']) . '&reply_token=' . urlencode($token) . '#comment-' . urlencode($row['comment_id']));
        exit;
    }

    json_out(['error' => 'Missing or invalid action'], 400);
}

// ── POST: new comment, visitor reply, or admin reply (with reply_token) ──────
if ($method === 'POST') {
    $raw  = file_get_contents('php://input');
    $data = json_decode($raw, true) ?: $_POST;

    // Honeypot — bots tend to fill every field, humans never see this one.
    if (!empty($data['website'])) { json_out(['success' => true]); }

    $postId     = isset($data['post_id']) ? intval($data['post_id']) : 0;
    $parentId   = !empty($data['parent_comment_id']) ? $data['parent_comment_id'] : null;
    $name       = trim($data['author_name'] ?? '');
    $email      = trim($data['author_email'] ?? '');
    $body       = trim($data['body'] ?? '');
    $replyToken = $data['reply_token'] ?? null;

    if (!$postId || $name === '' || $body === '') json_out(['error' => 'Faltan campos requeridos'], 400);
    if (mb_strlen($body) > 5000) json_out(['error' => 'El comentario es demasiado largo'], 400);

    // ── Admin reply path: valid, unused reply_token tied to this exact parent ──
    if ($replyToken && $parentId) {
        $row = find_token_row($replyToken, 'reply');
        if ($row && $row['comment_id'] === $parentId && $row['used_at'] === null) {
            list($code, $inserted) = supabase_request('POST', '/rest/v1/blog_comments', SUPABASE_SERVICE_KEY, [
                'post_id'           => $postId,
                'parent_comment_id' => $parentId,
                'author_name'       => 'Trusted Panama Stays',
                'author_email'      => null,
                'body'              => $body,
                'status'            => 'approved',
                'is_admin_reply'    => true,
                'approved_at'       => date('c'),
            ], ['Prefer: return=representation']);
            mark_token_used($row['id']);
            json_out(['success' => true, 'published' => true]);
        }
        // Token missing/expired/already used/mismatched — fall through and
        // treat it as a normal moderated submission instead of failing.
    }

    // ── Normal visitor comment or reply — goes to moderation ─────────────────
    list($code, $inserted) = supabase_request('POST', '/rest/v1/blog_comments', SUPABASE_SERVICE_KEY, [
        'post_id'           => $postId,
        'parent_comment_id' => $parentId,
        'author_name'       => $name,
        'author_email'      => $email ?: null,
        'body'              => $body,
        'status'            => 'pending',
        'is_admin_reply'    => false,
    ], ['Prefer: return=representation']);

    if (!is_array($inserted) || !count($inserted)) json_out(['error' => 'No se pudo guardar el comentario'], 500);
    $comment = $inserted[0];

    $approveToken = random_token();
    $newReplyToken = random_token();
    $expires = date('c', strtotime('+30 days'));
    supabase_request('POST', '/rest/v1/blog_comment_tokens', SUPABASE_SERVICE_KEY, [
        'comment_id' => $comment['id'], 'action' => 'approve', 'token' => $approveToken, 'expires_at' => $expires,
    ]);
    supabase_request('POST', '/rest/v1/blog_comment_tokens', SUPABASE_SERVICE_KEY, [
        'comment_id' => $comment['id'], 'action' => 'reply', 'token' => $newReplyToken, 'expires_at' => $expires,
    ]);

    $slug = fetch_post_slug($postId);
    $approveUrl = 'https://trustedpanamastays.com/blog-comment-action.php?action=approve&token=' . urlencode($approveToken);
    $replyUrl   = 'https://trustedpanamastays.com/blog-comment-action.php?action=reply&token=' . urlencode($newReplyToken);
    $postUrl    = 'https://trustedpanamastays.com/blog-post.php?slug=' . urlencode($slug ?: '');

    $html = '<div style="font-family:sans-serif;max-width:600px;">'
          . '<p><strong>' . htmlspecialchars($name, ENT_QUOTES, 'UTF-8') . '</strong>'
          . ($email ? ' (' . htmlspecialchars($email, ENT_QUOTES, 'UTF-8') . ')' : '')
          . ' comentó en <a href="' . htmlspecialchars($postUrl, ENT_QUOTES, 'UTF-8') . '">el blog</a>:</p>'
          . '<blockquote style="border-left:3px solid #ccc;margin:0 0 1rem;padding:0.5rem 1rem;color:#333;">'
          . nl2br(htmlspecialchars($body, ENT_QUOTES, 'UTF-8'))
          . '</blockquote>'
          . '<p>'
          . '<a href="' . htmlspecialchars($approveUrl, ENT_QUOTES, 'UTF-8') . '" style="background:#005ca9;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">ACEPTAR</a>'
          . '&nbsp;&nbsp;&nbsp;&nbsp;'
          . '<a href="' . htmlspecialchars($replyUrl, ENT_QUOTES, 'UTF-8') . '" style="background:#1a5c1a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">CONTESTAR</a>'
          . '</p></div>';

    send_tps_email(
        'Nuevo comentario en el blog — ' . ($slug ?: ''),
        $html,
        'v.piasta@gmail.com',
        'info@trustedpanamastays.com',
        'Trusted Panama Stays',
        'info@trustedpanamastays.com'
    );

    json_out(['success' => true, 'published' => false]);
}

json_out(['error' => 'Método no soportado'], 405);
