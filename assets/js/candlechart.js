// MarketMind AI — interactive candlestick chart (SVG, no library).
//   const ch = CandleChart.create(el, { height });  ch.set({ candles, zones, lines, ema, tf });  ch.destroy();
// Drag to pan, wheel / pinch / +− buttons to zoom, hover or touch for the candle's OHLC.
// Demand zones are shaded green, supply zones red; the last price has a tag on the axis.
(function (root) {
  'use strict';

  const IST = 5.5 * 3600e3;
  const fmt = v => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const vol = v => (v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : v >= 1e5 ? (v / 1e5).toFixed(2) + ' L' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v || 0)));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const intraday = tf => /m$|h$/.test(tf) && tf !== '1mo';
  function tlabel(t, tf, full) {
    const d = new Date(t + IST);
    const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const day = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
    if (intraday(tf)) return full ? `${day}, ${hm}` : hm;
    if (tf === '1mo') return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (tf === '1w') return full ? `${day} ${d.getUTCFullYear()}` : `${day} ${String(d.getUTCFullYear()).slice(2)}`;
    return full ? `${day} ${d.getUTCFullYear()}` : day;
  }
  function niceTicks(lo, hi, n) {
    const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    const st = (m >= 5 ? 10 : m >= 2 ? 5 : m >= 1 ? 2 : 1) * p, out = [];
    for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) out.push(v);
    return out;
  }

  function create(el, opts = {}) {
    const S = { candles: [], zones: [], lines: [], ema: null, tf: '1d', n: 90, off: 0, hover: null };
    el.classList.add('cc');
    el.innerHTML = `<div class="cc-legend"></div>
      <div class="cc-zoom"><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">−</button><button type="button" data-z="reset" aria-label="Back to latest">⟲</button></div>
      <svg class="cc-svg" role="img" aria-label="Candlestick chart"></svg>`;
    const svg = el.querySelector('svg'), legend = el.querySelector('.cc-legend');
    let W = 0, H = opts.height || 320, geo = null;

    function visible() {
      const N = S.candles.length;
      const n = Math.max(10, Math.min(S.n, N));
      const end = Math.max(n, N - S.off);
      return { list: S.candles.slice(end - n, end), start: end - n, n };
    }

    function draw() {
      W = el.clientWidth || 600;
      H = opts.height || (W < 560 ? 280 : 340);
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      const { list, start } = visible();
      if (!list.length) { svg.innerHTML = ''; legend.innerHTML = '<span class="muted">No candles</span>'; return; }
      const R = W < 560 ? 56 : 66, T = 8, B = 22, volH = (H - T - B) * 0.16;
      const plotH = H - T - B - volH - 6, plotW = W - R;
      const cw = plotW / list.length;
      const last = S.candles[S.candles.length - 1];
      let lo = Math.min(...list.map(c => c.low)), hi = Math.max(...list.map(c => c.high));
      // keep near zones / lines in view
      for (const z of S.zones) { const a = Math.min(z.proximal, z.distal), b = Math.max(z.proximal, z.distal); if (b > lo - (hi - lo) * 0.35 && a < hi + (hi - lo) * 0.35) { lo = Math.min(lo, a); hi = Math.max(hi, b); } }
      const pad = (hi - lo) * 0.06 || hi * 0.01; lo -= pad; hi += pad;
      const Y = v => T + (hi - v) / (hi - lo) * plotH;
      const X = i => (i + 0.5) * cw;
      const vMax = Math.max(...list.map(c => c.volume || 0), 1);
      const vY0 = T + plotH + 6 + volH;
      const parts = [];
      // grid + price axis
      for (const v of niceTicks(lo, hi, 5)) parts.push(`<line class="cc-grid" x1="0" x2="${plotW}" y1="${Y(v)}" y2="${Y(v)}"/><text class="cc-ax" x="${plotW + 6}" y="${Y(v) + 4}">${fmt(v)}</text>`);
      // time axis
      const every = Math.max(1, Math.ceil(list.length / (W < 560 ? 4 : 7)));
      list.forEach((c, i) => { if (i % every === Math.floor(every / 2)) parts.push(`<text class="cc-ax" x="${X(i)}" y="${H - 6}" text-anchor="middle">${tlabel(c.time, S.tf)}</text>`); });
      // zones
      for (const z of S.zones) {
        const a = Math.max(z.proximal, z.distal), b = Math.min(z.proximal, z.distal);
        if (b > hi || a < lo) continue;
        const zi = z.time != null ? list.findIndex(c => c.time >= z.time) : 0;
        const x0 = zi < 0 ? plotW : Math.max(0, zi * cw);
        if (x0 >= plotW) continue;
        parts.push(`<rect class="cc-zone ${z.side}" x="${x0}" y="${Y(a)}" width="${plotW - x0}" height="${Math.max(2, Y(b) - Y(a))}"/>`);
        if (z.label) parts.push(`<text class="cc-zlabel ${z.side}" x="${plotW - 4}" y="${z.side === 'demand' ? Y(b) + 11 : Y(a) - 3}" text-anchor="end">${z.label}</text>`);
      }
      // extra lines (entry / stop / target)
      for (const l of S.lines) if (l.price > lo && l.price < hi) parts.push(`<line class="cc-line ${l.kind || ''}" x1="0" x2="${plotW}" y1="${Y(l.price)}" y2="${Y(l.price)}"/><text class="cc-llabel ${l.kind || ''}" x="4" y="${Y(l.price) - 3}">${l.label} ${fmt(l.price)}</text>`);
      // volume + candles
      const bw = Math.max(1, Math.min(14, cw * 0.68));
      list.forEach((c, i) => {
        const up = c.close >= c.open, x = X(i);
        if (c.volume) parts.push(`<rect class="cc-vol ${up ? 'up' : 'dn'}" x="${x - bw / 2}" y="${vY0 - (c.volume / vMax) * volH}" width="${bw}" height="${(c.volume / vMax) * volH}"/>`);
        parts.push(`<line class="cc-wick ${up ? 'up' : 'dn'}" x1="${x}" x2="${x}" y1="${Y(c.high)}" y2="${Y(c.low)}"/>`);
        const y1 = Y(Math.max(c.open, c.close)), y2 = Y(Math.min(c.open, c.close));
        parts.push(`<rect class="cc-body ${up ? 'up' : 'dn'}" x="${x - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(1, y2 - y1)}" rx="${bw > 5 ? 1 : 0}"/>`);
      });
      // EMA
      if (S.ema) {
        const pts = list.map((c, i) => [X(i), S.ema[start + i]]).filter(p => p[1] != null && p[1] > lo && p[1] < hi);
        if (pts.length > 1) parts.push(`<path class="cc-ema" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}"/>`);
      }
      // last price tag
      if (last.close > lo && last.close < hi) {
        const up = last.close >= (S.candles[S.candles.length - 2] || last).close;
        parts.push(`<line class="cc-last" x1="0" x2="${plotW}" y1="${Y(last.close)}" y2="${Y(last.close)}"/><rect class="cc-tag ${up ? 'up' : 'dn'}" x="${plotW + 1}" y="${Y(last.close) - 9}" width="${R - 2}" height="18" rx="3"/><text class="cc-tagt" x="${plotW + 6}" y="${Y(last.close) + 4}">${fmt(last.close)}</text>`);
      }
      // crosshair layer
      parts.push(`<g class="cc-cross" style="display:none"><line class="cc-cx" y1="${T}" y2="${vY0}"/><line class="cc-cy" x1="0" x2="${plotW}"/><rect class="cc-ytag" x="${plotW + 1}" width="${R - 2}" height="18" rx="3"/><text class="cc-ytagt" x="${plotW + 6}"></text></g>`);
      parts.push(`<rect class="cc-hit" x="0" y="0" width="${plotW}" height="${H - B}" fill="transparent"/>`);
      svg.innerHTML = parts.join('');
      geo = { list, start, cw, plotW, Y, lo, hi, T, plotH, X };
      showLegend(S.hover != null && list[S.hover] ? list[S.hover] : last, S.hover != null && list[S.hover] ? S.hover + start : S.candles.length - 1);
    }

    function showLegend(c, idx) {
      const prev = S.candles[idx - 1];
      const ch = prev ? (c.close / prev.close - 1) * 100 : null;
      const cls = c.close >= c.open ? 'up' : 'down';
      legend.innerHTML = `<b>${tlabel(c.time, S.tf, true)}</b> <span>O <i>${fmt(c.open)}</i></span> <span>H <i>${fmt(c.high)}</i></span> <span>L <i>${fmt(c.low)}</i></span> <span>C <i class="${cls}">${fmt(c.close)}</i></span>${ch != null ? ` <span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span>` : ''}${c.volume ? ` <span>Vol <i>${vol(c.volume)}</i></span>` : ''}${S.ema && S.ema[idx] ? ` <span class="cc-ema-l">EMA20 <i>${fmt(S.ema[idx])}</i></span>` : ''}`;
    }

    function cross(px, py) {
      if (!geo) return;
      const i = Math.max(0, Math.min(geo.list.length - 1, Math.floor(px / geo.cw)));
      S.hover = i;
      const g = svg.querySelector('.cc-cross'); if (!g) return;
      g.style.display = '';
      const x = geo.X(i), price = geo.hi - (py - geo.T) / geo.plotH * (geo.hi - geo.lo);
      g.querySelector('.cc-cx').setAttribute('x1', x); g.querySelector('.cc-cx').setAttribute('x2', x);
      const inPlot = py >= geo.T && py <= geo.T + geo.plotH;
      for (const s of ['.cc-cy', '.cc-ytag', '.cc-ytagt']) g.querySelector(s).style.display = inPlot ? '' : 'none';
      g.querySelector('.cc-cy').setAttribute('y1', py); g.querySelector('.cc-cy').setAttribute('y2', py);
      g.querySelector('.cc-ytag').setAttribute('y', py - 9);
      g.querySelector('.cc-ytagt').setAttribute('y', py + 4); g.querySelector('.cc-ytagt').textContent = fmt(price);
      showLegend(geo.list[i], i + geo.start);
    }
    function uncross() { S.hover = null; const g = svg.querySelector('.cc-cross'); if (g) g.style.display = 'none'; if (geo) showLegend(S.candles[S.candles.length - 1], S.candles.length - 1); }

    function zoom(f, anchorFrac = 1) {
      const N = S.candles.length, old = Math.min(S.n, N);
      const n = Math.round(Math.max(15, Math.min(N, old * f)));
      // keep the candle under the anchor in place
      S.off = Math.max(0, Math.min(N - n, Math.round(S.off + (old - n) * (1 - anchorFrac))));
      S.n = n; draw();
    }
    function pan(dCandles) {
      const N = S.candles.length, n = Math.min(S.n, N);
      S.off = Math.max(0, Math.min(N - n, S.off + dCandles)); draw();
    }

    // pointer interactions
    const pts = new Map(); let drag = null, pinch = null;
    const local = e => { const b = svg.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    svg.addEventListener('pointerdown', e => {
      svg.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e));
      if (pts.size === 1) drag = { x: local(e)[0], off: S.off, moved: false };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.abs(a[0] - b[0]) || 1, n: S.n }; drag = null; }
      if (e.pointerType !== 'mouse') cross(...local(e));
    });
    svg.addEventListener('pointermove', e => {
      const p = local(e);
      if (pts.has(e.pointerId)) pts.set(e.pointerId, p);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()]; const d = Math.abs(a[0] - b[0]) || 1;
        const N = S.candles.length; S.n = Math.round(Math.max(15, Math.min(N, pinch.n * pinch.d / d))); S.off = Math.max(0, Math.min(N - S.n, S.off)); draw(); return;
      }
      if (drag && geo) {
        const dx = p[0] - drag.x;
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) { const N = S.candles.length, n = Math.min(S.n, N); S.off = Math.max(0, Math.min(N - n, Math.round(drag.off + dx / geo.cw))); draw(); }
        if (e.pointerType !== 'mouse' && !drag.moved) cross(...p);
        if (e.pointerType === 'mouse') cross(...p);
        return;
      }
      cross(...p);
    });
    const end = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) drag = null; };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') uncross(); });
    svg.addEventListener('wheel', e => {
      if (!geo) return;
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { pan(Math.round(e.deltaX / geo.cw)); return; }
      const frac = Math.max(0, Math.min(1, local(e)[0] / geo.plotW));
      zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, frac);
    }, { passive: false });
    el.querySelector('.cc-zoom').addEventListener('click', e => {
      const z = e.target.closest('[data-z]'); if (!z) return;
      if (z.dataset.z === 'in') zoom(1 / 1.4); else if (z.dataset.z === 'out') zoom(1.4); else { S.off = 0; S.n = opts.n || 90; draw(); }
    });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (Math.abs((el.clientWidth || 0) - W) > 2) draw(); }) : null;
    if (ro) ro.observe(el);

    return {
      set(d) {
        const tfChanged = d.tf && d.tf !== S.tf;
        Object.assign(S, { candles: d.candles || [], zones: d.zones || [], lines: d.lines || [], ema: d.ema || null, tf: d.tf || S.tf });
        if (tfChanged || d.reset) { S.off = 0; S.n = opts.n || (W && W < 560 ? 60 : 90); }
        draw();
      },
      destroy() { if (ro) ro.disconnect(); el.innerHTML = ''; },
    };
  }

  root.CandleChart = { create };
})(window);
