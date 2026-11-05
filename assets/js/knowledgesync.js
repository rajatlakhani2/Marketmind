// MarketMind AI — keeps each user's knowledge library (books, concepts, strategies,
// feedback) in MySQL, with the browser's IndexedDB as a fast local copy.
//
//   await KnowledgeSync.start(Storage)   // after sign-in, before the engine loads
//
// * Each user gets their own browser database, so people sharing a device never see
//   each other's material.
// * On start: downloads whatever changed on the server since the last visit and
//   removes items deleted on another device.
// * Every save or delete is sent to the server in batches shortly after.
// * The first time the admin signs in, material saved in this browser before sign-in
//   existed is copied into their account.
(function () {
  const API = 'api/knowledge.php';
  const STORES = ['documents', 'concepts', 'strategies', 'chunks', 'feedback'];
  const LEGACY_DB = 'MarketMindDB';
  const BATCH_BYTES = 3 * 1024 * 1024;

  let storage = null, user = null, rawPut = null, rawDelete = null;
  const queue = { puts: new Map(), deletes: new Map() };
  let timer = null, flushing = false, failures = 0;

  async function api(action, body, query = '') {
    const opts = { headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Requested-With'] = 'MarketMind';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${API}?action=${action}${query}`, opts);
    let j;
    try { j = await r.json(); } catch { throw new Error(r.status === 413 ? 'Upload too large for the server' : `Server error ${r.status}`); }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  const sinceKey = () => `mm_knowledge_since_${user.id}`;
  const toast = (m, t) => { if (window.app && app.ui) app.ui._toast(m, t); };

  // ---------- server -> browser ----------
  async function pull() {
    let since = '';
    try { since = localStorage.getItem(sinceKey()) || ''; } catch { /* ignore */ }
    const r = await api('pull', undefined, since ? `&since=${encodeURIComponent(since)}` : '');
    for (const it of r.items) {
      if (STORES.includes(it.store) && it.data) await rawPut.call(storage, it.store, it.data);
    }
    // Remove what was deleted elsewhere (but keep anything still waiting to upload)
    for (const store of STORES) {
      const keep = new Set(r.ids[store] || []);
      const local = await storage.getAll(store);
      for (const item of local) {
        if (!keep.has(item.id) && !queue.puts.has(`${store}|${item.id}`)) await rawDelete.call(storage, store, item.id);
      }
    }
    try { localStorage.setItem(sinceKey(), r.now); } catch { /* ignore */ }
    return r;
  }

  // ---------- browser -> server ----------
  function schedule(delay = 600) {
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  async function flush() {
    if (flushing || (!queue.puts.size && !queue.deletes.size)) return;
    flushing = true;
    try {
      while (queue.puts.size || queue.deletes.size) {
        const deletes = [...queue.deletes.values()];
        const puts = [];
        let bytes = 0;
        for (const [key, p] of queue.puts) {
          const size = JSON.stringify(p.data).length;
          if (puts.length && bytes + size > BATCH_BYTES) break;
          puts.push([key, p]);
          bytes += size;
        }
        await api('sync', { puts: puts.map(([, p]) => p), deletes });
        deletes.forEach((d) => queue.deletes.delete(`${d.store}|${d.id}`));
        puts.forEach(([key, p]) => { if (queue.puts.get(key) === p) queue.puts.delete(key); });
      }
      failures = 0;
    } catch (e) {
      failures++;
      console.warn('Knowledge sync failed:', e.message);
      if (failures === 1) toast(`Couldn't save to your account yet (${e.message}). Will retry.`, 'warning');
      schedule(Math.min(60000, 5000 * failures));
    } finally {
      flushing = false;
    }
  }

  function enqueuePut(store, data) {
    if (!STORES.includes(store) || !data || data.id == null) return;
    const id = String(data.id);
    queue.deletes.delete(`${store}|${id}`);
    queue.puts.set(`${store}|${id}`, { store, id, data });
    schedule();
  }

  function enqueueDelete(store, id) {
    if (!STORES.includes(store)) return;
    queue.puts.delete(`${store}|${id}`);
    queue.deletes.set(`${store}|${id}`, { store, id: String(id) });
    schedule();
  }

  // ---------- one-time import of pre-sign-in material ----------
  function openLegacy() {
    return new Promise((resolve) => {
      if (!window.indexedDB || !indexedDB.databases) { resolve(null); return; }
      indexedDB.databases().then((list) => {
        if (!list.some((d) => d.name === LEGACY_DB)) { resolve(null); return; }
        const req = indexedDB.open(LEGACY_DB);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      }).catch(() => resolve(null));
    });
  }

  async function importLegacy() {
    const db = await openLegacy();
    if (!db) return 0;
    let count = 0;
    for (const store of STORES) {
      if (!db.objectStoreNames.contains(store)) continue;
      const items = await new Promise((resolve) => {
        const r = db.transaction(store, 'readonly').objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result || []); r.onerror = () => resolve([]);
      });
      for (const it of items) {
        if (it.isBuiltIn) continue;
        await rawPut.call(storage, store, it);
        enqueuePut(store, it);
        count++;
      }
    }
    db.close();
    return count;
  }

  // ---------- start ----------
  async function start(st) {
    storage = st;
    const acc = window.Account;
    if (!acc || acc.devMode || !acc.user) return; // local dev: browser-only, as before
    user = acc.user;
    storage.DB_NAME = `MarketMindDB_u${user.id}`;
    await storage.open();
    rawPut = storage.put; rawDelete = storage.delete;
    storage.put = async function (store, data) { const r = await rawPut.call(storage, store, data); enqueuePut(store, data); return r; };
    storage.delete = async function (store, id) { await rawDelete.call(storage, store, id); enqueueDelete(store, id); };

    let r = null;
    try { r = await pull(); } catch (e) {
      console.warn('Knowledge download failed, using this device\'s copy:', e.message);
      toast('Working from this device\'s copy of your library (server not reachable)', 'warning');
      return;
    }
    const serverEmpty = STORES.every((s) => !(r.ids[s] || []).length);
    let flag = '';
    try { flag = localStorage.getItem('mm_legacy_imported') || ''; } catch { /* ignore */ }
    if (serverEmpty && acc.isAdmin && !flag) {
      const n = await importLegacy();
      try { localStorage.setItem('mm_legacy_imported', String(user.id)); } catch { /* ignore */ }
      if (n) {
        await flush();
        toast(`Moved ${n} items from this browser into your account`, 'success');
      }
    }
  }

  window.addEventListener('beforeunload', (e) => {
    if (queue.puts.size || queue.deletes.size) { flush(); e.preventDefault(); e.returnValue = ''; }
  });

  window.KnowledgeSync = { start, flush, pull, get pending() { return queue.puts.size + queue.deletes.size; } };
})();
