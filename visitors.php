<?php
// Visitor Counter for ATP Rentals with IP-based deduplication

// Configuration
$countFile = 'count.txt';
$ipFile = 'visitor_ips.txt';
$secretPass = 'VoVre2omd9w5!';  // https://aparthotel-boquete.com/atp-rentals/visitors.php?pass=VoVre2omd9w5!
$ipExpiry = 24 * 60 * 60; // 24 hours in seconds

// Function to safely read counter
function readCounter($countFile) {
    if (!file_exists($countFile)) return 0;

    $handle = fopen($countFile, 'r');
    if (!$handle) return 0;

    if (flock($handle, LOCK_SH)) {
        $count = (int)fread($handle, 100);
        flock($handle, LOCK_UN);
        fclose($handle);
        return $count;
    }

    fclose($handle);
    return 0;
}

// Function to get client IP
function getClientIP() {
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        return $_SERVER['HTTP_X_FORWARDED_FOR'];
    } elseif (!empty($_SERVER['HTTP_CLIENT_IP'])) {
        return $_SERVER['HTTP_CLIENT_IP'];
    } else {
        return $_SERVER['REMOTE_ADDR'];
    }
}

// Function to check if IP visited recently
function hasVisitedRecently($ip, $ipFile, $expiry) {
    if (!file_exists($ipFile)) return false;

    $handle = fopen($ipFile, 'r');
    if (!$handle) return false;

    if (flock($handle, LOCK_SH)) {
        $ips = [];
        while (($line = fgets($handle)) !== false) {
            $parts = explode('|', trim($line));
            if (count($parts) === 2) {
                $ips[$parts[0]] = (int)$parts[1];
            }
        }
        flock($handle, LOCK_UN);
        fclose($handle);

        // Check if IP exists and is within expiry
        if (isset($ips[$ip]) && (time() - $ips[$ip]) < $expiry) {
            return true;
        }
    } else {
        fclose($handle);
    }

    return false;
}

// Function to record IP and increment counter
function recordVisitAndIncrement($ip, $countFile, $ipFile, $expiry) {
    // First, handle IP recording
    $ips = [];
    if (file_exists($ipFile)) {
        $handle = fopen($ipFile, 'r');
        if ($handle && flock($handle, LOCK_SH)) {
            while (($line = fgets($handle)) !== false) {
                $parts = explode('|', trim($line));
                if (count($parts) === 2) {
                    // Only keep non-expired entries
                    if ((time() - (int)$parts[1]) < $expiry) {
                        $ips[$parts[0]] = (int)$parts[1];
                    }
                }
            }
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    // Add current IP
    $ips[$ip] = time();

    // Write updated IP list
    $handle = fopen($ipFile, 'w');
    if ($handle && flock($handle, LOCK_EX)) {
        foreach ($ips as $recordedIp => $timestamp) {
            fwrite($handle, $recordedIp . '|' . $timestamp . "\n");
        }
        flock($handle, LOCK_UN);
        fclose($handle);
    }

    // Now increment counter (only if IP is new)
    $shouldIncrement = true;
    $handle = fopen($countFile, 'c+');
    if ($handle && flock($handle, LOCK_EX)) {
        $count = (int)fread($handle, 100);

        if ($shouldIncrement) {
            $count++;
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, (string)$count);
        }

        flock($handle, LOCK_UN);
        fclose($handle);
        return $count;
    }

    return false;
}

// Initialize files if they don't exist
if (!file_exists($countFile)) {
    file_put_contents($countFile, '0', LOCK_EX);
}
if (!file_exists($ipFile)) {
    file_put_contents($ipFile, '', LOCK_EX);
}

// Check referer
$referer = $_SERVER['HTTP_REFERER'] ?? '';
$isFromYourSite = strpos($referer, 'https://aparthotel-boquete.com/atp-rentals/') !== false;

// CASE 1: Direct access without password AND not from your site = 404
if (!isset($_GET['pass']) && !$isFromYourSite) {
    header('HTTP/1.0 404 Not Found');
    exit('Page not found');
}

// CASE 2: Direct access with wrong password = 404
if (isset($_GET['pass']) && $_GET['pass'] !== $secretPass) {
    header('HTTP/1.0 404 Not Found');
    exit('Page not found');
}

// CASE 3: Admin access (with correct password) = show count without processing
if (isset($_GET['pass']) && $_GET['pass'] === $secretPass) {
    $count = readCounter($countFile);
    header('Content-Type: text/html');
    echo "<div style='font-size: 30px; border: 2px solid black; width: min-content; padding: 10px; white-space: nowrap;'> Visitors: " . str_pad($count, 6, '0', STR_PAD_LEFT)."</div>";
    exit;
}

// CASE 4: Normal visitor - check IP and process
$clientIP = getClientIP();
$hasRecentVisit = hasVisitedRecently($clientIP, $ipFile, $ipExpiry);

if (!$hasRecentVisit) {
    // New visitor - record IP and increment counter
    $count = recordVisitAndIncrement($clientIP, $countFile, $ipFile, $ipExpiry);
} else {
    // Returning visitor - just show current count
    $count = readCounter($countFile);
}

header('Content-Type: text/plain');
echo "Visitors: " . str_pad($count, 6, '0', STR_PAD_LEFT);

// Prevent caching
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');
?>
