// MarketMind AI — search-as-you-type picker for every NSE and BSE stock.
//   StockPicker.attach(input, { popular: [{ symbol, name }], onPick(stock) })
// Searches api/stocks.php; without the server (local dev) it searches the popular list.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let serverOk = true;
  let totalListed = null;

  async function search(q, popular) {
    if (serverOk) {
      try {
        const r = await fetch(`api/stocks.php?action=search&limit=25&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (r.ok) {
          totalListed = j.total;
          if (j.results.length || j.total > 0) {
            if (j.results.length) return j.results;
            return localMatches(q, popular); // not in the list: offer the popular ones that match, if any
          }
        }
        else if (r.status !== 401 && r.status !== 403) serverOk = false;
      } catch { serverOk = false; }
    }
    return localMatches(q, popular);
  }

  function localMatches(q, popular) {
    const t = q.toUpperCase();
    return popular.filter((s) => s.symbol.includes(t) || s.name.toUpperCase().includes(t)).slice(0, 25)
      .map((s) => ({ ...s, exchange: 'NSE', nse: s.symbol, bse: null }));
  }

  function attach(input, { popular = [], onPick } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'stock-picker';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const list = document.createElement('div');
    list.className = 'stock-picker-list hidden';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'characters');
    input.setAttribute('spellcheck', 'false');

    let items = [], active = -1, timer = null, seq = 0;

    function render(q) {
      if (!items.length) {
        list.innerHTML = `<div class="stock-picker-empty">${q ? `No stock matches "${esc(q)}"` : 'Type a symbol or company name'}${totalListed === 0 ? '<br><small>The full stock list hasn\'t been loaded yet. An admin can load it from Users → Stock list.</small>' : ''}</div>`;
      } else {
        list.innerHTML = (q ? '' : '<div class="stock-picker-head">Popular</div>') + items.map((s, i) => `
          <div class="stock-picker-item${i === active ? ' active' : ''}" role="option" data-i="${i}">
            <span class="sp-symbol">${esc(s.symbol)}</span>
            <span class="sp-name">${esc(s.name)}</span>
            <span class="sp-exch">${s.nse ? '<b>NSE</b>' : ''}${s.bse ? `<b>BSE</b>` : ''}</span>
          </div>`).join('');
      }
      list.classList.remove('hidden');
    }

    async function update() {
      const q = input.value.trim();
      const my = ++seq;
      items = q ? await search(q, popular) : popular.slice(0, 50).map((s) => ({ ...s, exchange: 'NSE', nse: s.symbol, bse: null }));
      if (my !== seq) return; // a newer search finished first
      active = items.length ? 0 : -1;
      render(q);
    }

    function pick(i) {
      const s = items[i];
      if (!s) return;
      input.value = s.symbol;
      input.dataset.name = s.name || '';
      close();
      if (onPick) onPick(s);
    }

    function close() { list.classList.add('hidden'); }

    input.addEventListener('focus', () => { input.select(); update(); });
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 180); });
    input.addEventListener('keydown', (e) => {
      if (list.classList.contains('hidden') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { update(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(input.value.trim()); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(input.value.trim()); }
      else if (e.key === 'Enter') { if (!list.classList.contains('hidden') && active >= 0) { e.preventDefault(); pick(active); } }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => {
      const el = e.target.closest('.stock-picker-item');
      if (el) { e.preventDefault(); pick(Number(el.dataset.i)); }
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  }

  window.StockPicker = { attach };
})();
