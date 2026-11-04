<?php
// ICICI Direct Breeze settings for MarketMind AI.
//
// 1. Copy this file to breeze-config.php (same folder), or — safer — to the
//    folder ABOVE your public_html so it can never be served.
// 2. Paste the API Key and Secret Key from https://api.icicidirect.com
// 3. In the ICICI app settings, set the Redirect URL to:
//      https://YOUR-DOMAIN/PATH-TO-MARKETMIND/api/breeze.php
//
// Never commit breeze-config.php or share the secret key.

return [
    'api_key'    => 'PASTE_YOUR_API_KEY_HERE',
    'secret_key' => 'PASTE_YOUR_SECRET_KEY_HERE',

    // Where to send you after logging in (relative to this api/ folder)
    'app_url'    => '../index.html',
];
