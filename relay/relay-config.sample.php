<?php
// Copy to relay-config.php on the VPS (same folder as relay.php) and fill in.
return [
    // Same long random string as 'relay' => ['secret' => ...] in MarketMind's marketmind-config.php
    'secret' => 'PASTE_A_LONG_RANDOM_SECRET',

    // ICICI Breeze app keys (the app whose static IP is this VPS)
    'api_key'    => 'PASTE_YOUR_API_KEY_HERE',
    'secret_key' => 'PASTE_YOUR_SECRET_KEY_HERE',

    // Only MarketMind's server may call the relay
    'allowed_ips' => ['190.92.174.87'],

    // Extra safety net: refuse any single order above this value (₹). 0 = no limit.
    'max_order_value' => 100000,
];
