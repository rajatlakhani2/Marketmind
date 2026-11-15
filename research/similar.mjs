// "Days like today": find the past NIFTY days that looked most like the latest one and report what followed.
// Features (z-scored): 5-, 20- and 60-day return, distance from the 200-day average, 20-day volatility.
// Matches must be 10+ trading days apart and at least 60 days old. The baseline (all days) is reported beside it,
// so it is plain when "similar days" say nothing different from an ordinary day.
export function similarDays(bars, k = 15) {
  const c = bars.map(x => x.c), n = c.length; if (n < 600) return null;
  const sma = (i, m) => { let s = 0; for (let j = i - m + 1; j <= i; j++) s += c[j]; return s / m; };
  const feat = i => { let v = 0; for (let j = i - 19; j <= i; j++) v += (c[j] / c[j - 1] - 1) ** 2; return [c[i] / c[i - 5] - 1, c[i] / c[i - 20] - 1, c[i] / c[i - 60] - 1, c[i] / sma(i, 200) - 1, Math.sqrt(v / 20)]; };
  const idx = []; for (let i = 200; i < n; i++) idx.push(i);
  const F = new Map(idx.map(i => [i, feat(i)]));
  const mu = [0, 1, 2, 3, 4].map(d => idx.reduce((a, i) => a + F.get(i)[d], 0) / idx.length), sd = [0, 1, 2, 3, 4].map(d => Math.sqrt(idx.reduce((a, i) => a + (F.get(i)[d] - mu[d]) ** 2, 0) / idx.length) || 1);
  const z = i => F.get(i).map((v, d) => (v - mu[d]) / sd[d]), t = z(n - 1);
  const cand = idx.filter(i => i <= n - 61).map(i => [i, Math.hypot(...z(i).map((v, d) => v - t[d]))]).sort((a, b) => a[1] - b[1]), pick = [];
  for (const [i] of cand) { if (pick.length >= k) break; if (pick.every(p => Math.abs(p - i) >= 10)) pick.push(i); }
  const fwd = (i, m) => (i + m < n ? (c[i + m] / c[i] - 1) * 100 : null);
  const sum = (list, m) => { const v = list.map(i => fwd(i, m)).filter(x => x != null).sort((a, b) => a - b); if (!v.length) return null; return { med: +v[Math.floor(v.length / 2)].toFixed(2), pos: Math.round(v.filter(x => x > 0).length / v.length * 100), min: +v[0].toFixed(1), max: +v[v.length - 1].toFixed(1), n: v.length }; };
  return { n: pick.length, d5: sum(pick, 5), d20: sum(pick, 20), base5: sum(idx, 5), base20: sum(idx, 20), dates: pick.sort((a, b) => b - a).slice(0, 15).map(i => [bars[i].d, fwd(i, 20) == null ? null : +fwd(i, 20).toFixed(1)]), years: +(n / 250).toFixed(1) };
}
