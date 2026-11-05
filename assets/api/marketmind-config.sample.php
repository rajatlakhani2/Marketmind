<?php
// MarketMind AI — server settings (database and first-time setup).
//
// 1. In cPanel > MySQL Databases, create a database and a user, and add the user
//    to the database with ALL PRIVILEGES. cPanel prefixes both names with your
//    account name, e.g. myacct_marketmind and myacct_mmuser.
// 2. Copy this file to marketmind-config.php — best in the folder ABOVE
//    public_html so it can never be downloaded (next to breeze-config.php).
// 3. Fill in the four db values and choose a setup_key.
// 4. Open the app. It creates the tables itself and asks you to create the
//    admin account; you will need the setup_key once, for that step only.
//
// Never commit marketmind-config.php or share it.

return [
    'db' => [
        'host' => 'localhost',
        'port' => 3306,
        'name' => 'PASTE_DATABASE_NAME',   // e.g. myacct_marketmind
        'user' => 'PASTE_DATABASE_USER',   // e.g. myacct_mmuser
        'pass' => 'PASTE_DATABASE_PASSWORD',
    ],

    // Needed once, to create the first admin account. Use any long phrase.
    'setup_key' => 'PASTE_A_LONG_SECRET_PHRASE',

    // How long "Keep me signed in" lasts, in days.
    'session_days' => 30,
];
