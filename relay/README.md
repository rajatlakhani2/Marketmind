# MarketMind order relay (VPS)

SEBI requires orders placed through a broker API to come from a **static IP registered with the
broker**, and a shared-hosting IP (used by other customers too) doesn't qualify. MarketMind
itself stays on shared hosting; only this one small file runs on a VPS with its own IP, and
MarketMind sends it each order **after you approve it**.

```
MarketMind (SpidyHost)  --signed HTTPS-->  relay.php (your VPS, static IP)  -->  ICICI Breeze
```

Until the relay is set up, MarketMind's Trading page runs in **test mode**: approved orders are
simulated against live prices and nothing reaches ICICI.

## 1. Get a small VPS

Any Linux VPS in India with a dedicated IPv4 address works. The smallest plan is plenty
(1 vCPU, 1 GB RAM). Good options: AWS Lightsail (Mumbai), DigitalOcean (Bangalore),
Oracle Cloud (Mumbai/Hyderabad, has an always-free tier). Choose **Ubuntu 24.04**.

Note the VPS's public IP, for example `203.0.113.10`.

## 2. Point a name at it

In cPanel → **Zone Editor** for `kuhu.org.in`, add an **A record**:
`relay.kuhu.org.in` → your VPS IP. (A DNS record is not a cPanel subdomain, so it doesn't use
one of your subdomain slots.)

## 3. Install the relay (on the VPS, as root)

```bash
apt update && apt install -y caddy php8.3-fpm php8.3-curl
mkdir -p /srv/relay && cd /srv/relay
curl -fsSLO https://raw.githubusercontent.com/rajatlakhani2/Marketmind/main/relay/relay.php
curl -fsSLo relay-config.php https://raw.githubusercontent.com/rajatlakhani2/Marketmind/main/relay/relay-config.sample.php
chown -R www-data:www-data /srv/relay && chmod 600 relay-config.php
```

Fill in `/srv/relay/relay-config.php` (`nano relay-config.php`):
- `secret`: a long random string; create one with `openssl rand -hex 32`
- `api_key`, `secret_key`: your ICICI Breeze keys
- `allowed_ips`: `['190.92.174.87']` (MarketMind's server)

Caddy config, `/etc/caddy/Caddyfile` (gets the HTTPS certificate by itself):

```
relay.kuhu.org.in {
    root * /srv/relay
    @blocked not path /relay.php
    respond @blocked 404
    php_fastcgi unix//run/php/php8.3-fpm.sock
}
```

```bash
systemctl reload caddy
ufw allow 22,80,443/tcp && ufw --force enable
```

## 4. Register the VPS IP with ICICI

api.icicidirect.com → **View Apps** → your MarketMind app → set the **static IP** to the
VPS IP (not 190.92.174.87, which is SpidyHost's shared IP).

## 5. Tell MarketMind about the relay

Add to `marketmind-config.php` (above `public_html` on SpidyHost), inside the `return [ ... ]`:

```php
'relay' => [
    'url'    => 'https://relay.kuhu.org.in/relay.php',
    'secret' => 'the same secret as on the VPS',
],
```

The Trading page then shows **LIVE** instead of TEST. Place one small test order (1 share of a
cheap stock) and confirm it appears in your ICICI order book before trading normally.

## What the relay refuses

- calls from any IP not in `allowed_ips`, unsigned or tampered requests, requests older than 60 s
- anything other than place / order status / cancel
- market orders (only limit and stop-loss limit orders), and any order above `max_order_value`

Every request it forwards is logged to `/srv/relay/relay.log` (not reachable from the web).
