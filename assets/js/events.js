// ============================================================
// MarketMind AI — Events & News page
//   Market-wide: upcoming results / board meetings and corporate actions (NSE),
//                plus market headlines.
//   One stock:   its next results date, recent and upcoming events, dividends /
//                splits / bonus, and its latest news.
// Also adds an "event ahead" warning to the Analyze page's plain-words summary.
// ============================================================
(function (root) {
  'use strict';

  const API = 'api/events.php';
  const state = { symbol: '', tab: 'results', filter: '', resultsOnly: true };
  const cache = new Map();   // url -> { at, data }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = d => new Date(d + 'T00:00:00');
  const fmt = d => day(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const daysUntil = d => Math.round((day(d) - day(todayIST())) / 864e5);
  const when = d => { const n = daysUntil(d); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 1 ? `in ${n} days` : n === -1 ? 'yesterday' : `${-n} days ago`; };
  const ago = ts => {
    if (!ts) return '';
    const m = Math.round((Date.now() / 1000 - ts) / 60);
    return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };

  async function get(params, ttl = 5 * 60e3) {
    const url = `${API}?` + new URLSearchParams(params);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`);
    cache.set(url, { at: Date.now(), data: j });
    return j;
  }

  // ---------- rendering pieces ----------
  const kindTag = k => `<span class="tag ev-kind ev-${esc(k.toLowerCase())}">${esc(k)}</span>`;

  function meetingRows(list, showCompany) {
    if (!list.length) return '<p class="muted">Nothing scheduled.</p>';
    return `<div class="ev-list">${list.map(m => `
      <div class="ev-item${daysUntil(m.date) < 0 ? ' ev-past' : ''}">
        <div class="ev-date"><strong>${esc(fmt(m.date))}</strong><span class="muted">${when(m.date)}</span></div>
        <div class="ev-main">
          ${showCompany ? `<div><a href="#" class="ev-sym" data-sym="${esc(m.symbol)}">${esc(m.symbol)}</a> <span class="muted">${esc(m.company)}</span></div>` : ''}
          <div>${m.results ? '<span class="tag tag-orange">Results</span> ' : ''}${esc(m.purpose)}</div>
          ${m.details ? `<div class="ev-detail">${esc(m.details)}</div>` : ''}
        </div>
      </div>`).join('')}</div>`;
  }

  function actionRows(list, showCompany) {
    if (!list.length) return '<p class="muted">No corporate actions.</p>';
    return `<div class="ev-list">${list.map(a => `
      <div class="ev-item${daysUntil(a.exDate) < 0 ? ' ev-past' : ''}">
        <div class="ev-date"><strong>${esc(fmt(a.exDate))}</strong><span class="muted">ex-date · ${when(a.exDate)}</span></div>
        <div class="ev-main">
          ${showCompany ? `<div><a href="#" class="ev-sym" data-sym="${esc(a.symbol)}">${esc(a.symbol)}</a> <span class="muted">${esc(a.company)}</span></div>` : ''}
          <div>${kindTag(a.kind)} ${esc(a.subject)}</div>
          ${a.recordDate ? `<div class="ev-detail">Record date ${esc(fmt(a.recordDate))}. Buy before the ex-date to get it.</div>` : ''}
        </div>
      </div>`).join('')}</div>`;
  }

  function newsRows(items) {
    if (!items.length) return '<p class="muted">No recent news found.</p>';
    return `<div class="ev-list">${items.map(n => `
      <a class="ev-news" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
        <span class="ev-news-title">${esc(n.title)}</span>
        <span class="muted">${esc(n.source)}${n.at ? ' · ' + ago(n.at) : ''}</span>
      </a>`).join('')}</div>
      <p class="citation">Headlines from Google News; they open on the publisher's site.</p>`;
  }

  // ---------- page ----------
  async function renderPage(container) {
    if (!container) return;
    if (!container.dataset.ready) {
      container.dataset.ready = '1';
      container.innerHTML = `
        <div class="fno-controls">
          <label>Stock (leave empty for the whole market)<input type="text" id="ev-symbol" placeholder="e.g. TCS" autocomplete="off" /></label>
          <button type="button" class="btn-primary" id="ev-go">Show</button>
          <button type="button" class="btn-secondary" id="ev-market">Whole market</button>
        </div>
        <div id="ev-body"></div>`;
      const input = container.querySelector('#ev-symbol');
      if (root.StockPicker) root.StockPicker.attach(input, { popular: [] });
      const go = () => { state.symbol = (input.value || '').trim().toUpperCase().split(/\s|—/)[0] || ''; state.tab = state.symbol ? 'overview' : 'results'; load(container); };
      container.querySelector('#ev-go').onclick = go;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      container.querySelector('#ev-market').onclick = () => { input.value = ''; state.symbol = ''; state.tab = 'results'; load(container); };
    }
    await load(container);
  }

  async function load(container) {
    const body = container.querySelector('#ev-body');
    body.innerHTML = '<p class="muted" style="padding:16px;">Loading…</p>';
    try {
      if (state.symbol) {
        const [ev, news] = await Promise.all([get({ action: 'stock', symbol: state.symbol }), get({ action: 'news', symbol: state.symbol }).catch(e => ({ items: [], error: e.message }))]);
        renderStock(container, ev, news);
      } else {
        const [cal, news] = await Promise.all([get({ action: 'calendar' }), get({ action: 'news' }).catch(e => ({ items: [], error: e.message }))]);
        renderMarket(container, cal, news);
      }
    } catch (e) {
      body.innerHTML = `<div class="data-warning">Couldn't load events: ${esc(e.message)}</div>`;
    }
  }

  function tabsHtml(list) {
    return `<div class="fno-tabs" role="tablist">${list.map(([id, label]) => `<button type="button" class="fno-tab${state.tab === id ? ' active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>`;
  }

  function wire(container, rerender) {
    const body = container.querySelector('#ev-body');
    body.querySelectorAll('.fno-tab').forEach(b => { b.onclick = () => { state.tab = b.dataset.tab; rerender(); }; });
    body.querySelectorAll('.ev-sym').forEach(a => {
      a.onclick = e => { e.preventDefault(); container.querySelector('#ev-symbol').value = a.dataset.sym; state.symbol = a.dataset.sym; state.tab = 'overview'; load(container); };
    });
  }

  function renderMarket(container, cal, news) {
    const body = container.querySelector('#ev-body');
    const draw = () => {
      const f = state.filter.toLowerCase();
      const match = x => !f || (x.symbol + ' ' + x.company).toLowerCase().includes(f);
      const meetings = cal.meetings.filter(m => match(m) && (!state.resultsOnly || m.results));
      const actions = cal.actions.filter(match);
      let panel = '';
      if (state.tab === 'results') {
        panel = `<div class="ev-filters"><input type="search" id="ev-filter" placeholder="Filter by symbol or company" value="${esc(state.filter)}" />
          <label class="ev-check"><input type="checkbox" id="ev-resonly" ${state.resultsOnly ? 'checked' : ''}/> Results only</label></div>
          <p class="muted" style="margin-bottom:8px;">${meetings.length} upcoming ${state.resultsOnly ? 'results dates' : 'board meetings'}. Prices often move sharply on results day.</p>
          ${meetingRows(meetings.slice(0, 300), true)}`;
      } else if (state.tab === 'actions') {
        panel = `<div class="ev-filters"><input type="search" id="ev-filter" placeholder="Filter by symbol or company" value="${esc(state.filter)}" /></div>
          <p class="muted" style="margin-bottom:8px;">${actions.length} upcoming dividends, splits, bonus and rights issues.</p>
          ${actionRows(actions.slice(0, 300), true)}`;
      } else {
        panel = news.error ? `<div class="data-warning">News unavailable: ${esc(news.error)}</div>` : newsRows(news.items);
      }
      body.innerHTML = tabsHtml([['results', 'Results & meetings'], ['actions', 'Corporate actions'], ['news', 'Market news']]) + `<div class="fno-panel">${panel}</div>
        <p class="citation">Dates from NSE's event calendar and corporate-actions list; companies can reschedule. Updated hourly.</p>`;
      wire(container, draw);
      const fi = body.querySelector('#ev-filter');
      if (fi) fi.oninput = () => { state.filter = fi.value; const pos = fi.selectionStart; draw(); const n = body.querySelector('#ev-filter'); n.focus(); n.setSelectionRange(pos, pos); };
      const ro = body.querySelector('#ev-resonly');
      if (ro) ro.onchange = () => { state.resultsOnly = ro.checked; draw(); };
    };
    draw();
  }

  function renderStock(container, ev, news) {
    const body = container.querySelector('#ev-body');
    const draw = () => {
      const upcoming = ev.meetings.filter(m => daysUntil(m.date) >= 0).reverse();
      const lastResults = ev.meetings.find(m => m.results && daysUntil(m.date) < 0);
      let panel = '';
      if (state.tab === 'overview') {
        const cards = [];
        if (ev.next) cards.push(`<div class="v-tile"><div class="label">Next board meeting</div><div class="value">${esc(fmt(ev.next.date))}</div><div class="sub">${when(ev.next.date)} · ${esc(ev.next.purpose)}</div></div>`);
        else cards.push(`<div class="v-tile"><div class="label">Next board meeting</div><div class="value">Not announced</div><div class="sub">${lastResults ? `last results ${esc(fmt(lastResults.date))}` : ''}</div></div>`);
        if (ev.nextAction) cards.push(`<div class="v-tile"><div class="label">Next corporate action</div><div class="value">${esc(ev.nextAction.kind)}</div><div class="sub">ex-date ${esc(fmt(ev.nextAction.exDate))} · ${esc(ev.nextAction.subject)}</div></div>`);
        else if (ev.actions[0]) cards.push(`<div class="v-tile"><div class="label">Last corporate action</div><div class="value">${esc(ev.actions[0].kind)}</div><div class="sub">ex-date ${esc(fmt(ev.actions[0].exDate))} · ${esc(ev.actions[0].subject)}</div></div>`);
        panel = `<div class="fno-tiles" style="grid-template-columns:repeat(2,minmax(0,1fr));">${cards.join('')}</div>
          <h4 style="margin:16px 0 8px;">Latest news</h4>${news.error ? `<div class="data-warning">News unavailable: ${esc(news.error)}</div>` : newsRows(news.items.slice(0, 6))}`;
      } else if (state.tab === 'meetings') {
        panel = (upcoming.length ? '<h4 style="margin-bottom:8px;">Upcoming</h4>' + meetingRows(upcoming, false) : '') +
          '<h4 style="margin:14px 0 8px;">Recent</h4>' + meetingRows(ev.meetings.filter(m => daysUntil(m.date) < 0), false);
      } else if (state.tab === 'actions') {
        panel = actionRows(ev.actions, false);
      } else {
        panel = news.error ? `<div class="data-warning">News unavailable: ${esc(news.error)}</div>` : newsRows(news.items);
      }
      body.innerHTML = `<h3 style="font-size:1.15rem;margin-bottom:10px;">${esc(ev.symbol)}${ev.meetings[0] ? ' — ' + esc(ev.meetings[0].company) : ''}</h3>` +
        (ev.note ? `<div class="data-warning">${esc(ev.note)}</div>` : '') +
        tabsHtml([['overview', 'Overview'], ['meetings', 'Results & meetings'], ['actions', 'Corporate actions'], ['news', 'News']]) +
        `<div class="fno-panel">${panel}</div>`;
      wire(container, draw);
    };
    draw();
  }

  // ---------- Analyze page: warn about an event in the next 14 days ----------
  async function eventWarning(symbol) {
    try {
      const ev = await get({ action: 'stock', symbol }, 30 * 60e3);
      const out = [];
      if (ev.next && daysUntil(ev.next.date) <= 14) {
        out.push(`<strong>${ev.next.results ? 'Results' : 'Board meeting'} ${when(ev.next.date)}</strong> (${esc(fmt(ev.next.date))}): prices can jump or gap on the day, so levels may not hold. Consider waiting until after it.`);
      }
      if (ev.nextAction && daysUntil(ev.nextAction.exDate) <= 14) {
        const k = ev.nextAction.kind;
        const effect = k === 'Dividend' ? 'The price usually drops by about the dividend on the ex-date.'
          : k === 'Split' || k === 'Bonus' ? 'The share price and share count adjust on the ex-date; old levels need adjusting too.'
          : 'Expect the price to adjust on the ex-date.';
        out.push(`<strong>${esc(k)} ex-date ${when(ev.nextAction.exDate)}</strong> (${esc(fmt(ev.nextAction.exDate))}): ${esc(ev.nextAction.subject)}. ${effect}`);
      }
      return out;
    } catch { return []; }
  }

  root.EventsPage = { renderPage, eventWarning };
})(typeof window !== 'undefined' ? window : globalThis);
