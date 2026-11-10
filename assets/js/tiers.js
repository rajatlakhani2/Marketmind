// MarketMind AI — strategy tiers: Proven / Watch / Not proven.
// A tier says how far the back-test (and later, live MindGuru results) backs a strategy.
//   Proven     = full vote (weight 1)
//   Watch      = half vote (weight 0.5)
//   Not proven = shown, but its vote is not counted (weight 0)
// Short (sell) signals only count while NIFTY is below its 200-day average.
// Tiers come from api/tiers.php (auto-updated from the monthly back-test + live results, with a manual
// override). Until that loads, the seed below (back-test of 10 Nov 2026: 99 stocks, 5 years, 36,259 trades) is used.
(function (root) {
  'use strict';

  const TIERS = {
    proven: { label: 'Proven', weight: 1, cls: 'tier-proven', short: 'P' },
    watch: { label: 'Watch', weight: 0.5, cls: 'tier-watch', short: 'W' },
    unproven: { label: 'Not proven', weight: 0, cls: 'tier-unproven', short: '–' },
  };

  const SEED_NOTE = 'Back-test 10 Nov 2026 · 99 stocks · 5 years';
  const SEED = {
    lib_s_golden_cross: { tier: 'proven', bt: { avg: 0.19, yearsPos: 4, years: 6 } },
    lib_s_adx_ema_pullback: { tier: 'proven', bt: { avg: 0.14, yearsPos: 4, years: 6 } },
    lib_s_supertrend_flip: { tier: 'proven', bt: { avg: 0.12, yearsPos: 3, years: 6 } },
    lib_s_macd_cross_below_zero: { tier: 'watch' },
    lib_s_high52: { tier: 'watch' },
    lib_s_rsi_divergence: { tier: 'watch' },
    lib_s_morning_star_demand: { tier: 'watch' },
  };

  const S = { map: null, at: null, market: null, loading: null };

  function info(id) {
    const m = S.map || SEED;
    const t = m[id] || { tier: 'unproven' };
    const key = TIERS[t.tier] ? t.tier : 'unproven';
    return { id, ...t, tier: key, ...TIERS[key], note: t.why || (S.map ? '' : SEED_NOTE) };
  }
  const weight = id => info(id).weight;

  // Is a short signal allowed to count? Only when NIFTY is below its 200-day average.
  // Unknown (not loaded yet) = not allowed.
  const shortsAllowed = () => S.market != null && S.market.above200 === false;

  function badge(id, opts) {
    const t = info(id);
    const tip = [t.label, t.bt && t.bt.avg != null ? `back-test ${t.bt.avg >= 0 ? '+' : ''}${Number(t.bt.avg).toFixed(2)}R` : '',
      t.bt && t.bt.years ? `${t.bt.yearsPos}/${t.bt.years} years positive` : '',
      t.live && t.live.n ? `live ${t.live.avg >= 0 ? '+' : ''}${Number(t.live.avg).toFixed(2)}R over ${t.live.n}` : '',
      t.override ? 'set by hand' : ''].filter(Boolean).join(' · ');
    return `<span class="tier ${t.cls}" title="${tip.replace(/"/g, '&quot;')}">${opts && opts.compact ? t.short : t.label}</span>`;
  }

  // Badge for a call built from demand/supply zones alone
  const zoneBadge = () => '<span class="tier tier-unproven" title="Demand/supply zone buys were −0.15R per trade in the 5-year back-test">Zone only · not proven</span>';

  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  }

  async function loadMarket() {
    try {
      const j = await getJSON('api/chart.php?symbol=%5ENSEI&interval=1d&range=2y');
      const c = (root.MarketData ? MarketData.parseYahooChart(j).candles : []).filter(x => x && isFinite(x.close));
      if (c.length < 200) return;
      const last = c[c.length - 1].close;
      const ma = c.slice(-200).reduce((a, x) => a + x.close, 0) / 200;
      S.market = { nifty: last, ma200: ma, above200: last > ma, at: Date.now() };
    } catch (e) { console.warn('NIFTY 200-day check failed:', e.message); }
  }

  async function loadTiers() {
    try {
      const j = await getJSON('api/tiers.php?action=get');
      if (j.tiers && Object.keys(j.tiers).length) { S.map = j.tiers; S.at = j.backtestAt || null; S.server = j; }
      S.failed = false;
    } catch (e) { S.failed = true; console.warn('Tiers: using the built-in seed:', e.message); }
  }

  function ready(force) {
    if (!S.loading || force || S.failed || !S.market) S.loading = Promise.all([loadTiers(), loadMarket()]);
    return S.loading;
  }

  // Admin: send a finished swing back-test so tiers can update
  async function submitBacktest(res) {
    const stats = (res.stats || []).map(s => ({ id: s.id, name: s.name, n: s.n, avg: s.avg, years: Object.fromEntries(Object.entries(s.years || {}).map(([y, v]) => [y, { avg: v.avg, n: v.n }])) }));
    const r = await fetch('api/tiers.php?action=backtest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MarketMind', Accept: 'application/json' },
      body: JSON.stringify({ cfg: { ...res.cfg, cancelled: !!res.cancelled }, stats }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    await ready(true);
    return j;
  }

  async function setOverride(id, tier) {
    const r = await fetch('api/tiers.php?action=override', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MarketMind', Accept: 'application/json' },
      body: JSON.stringify({ id, tier: tier || '' }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    await ready(true);
    return j;
  }

  // Strong setup: counted vote of at least 1 (one Proven strategy, or two Watch). Older saved rows have no score: 2+ agree.
  const isStrong = c => !!c && (c.score != null ? c.score >= 1 : c.agree >= 2);

  const daysSinceBacktest = () => (S.at ? Math.floor((Date.now() - Date.parse(S.at.replace(' ', 'T') + 'Z')) / 864e5) : null);

  if (typeof window !== 'undefined' && typeof fetch !== 'undefined') setTimeout(() => ready(), 0);

  root.Tiers = { TIERS, SEED, info, weight, badge, zoneBadge, shortsAllowed, isStrong, ready, submitBacktest, setOverride, daysSinceBacktest,
    market: () => S.market, list: () => S.map || SEED, _setMarket: m => { S.market = m; } };
})(typeof window !== 'undefined' ? window : globalThis);
