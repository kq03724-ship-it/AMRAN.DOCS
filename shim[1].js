/* Replaces Claude's runtime (claude.use) with Supabase. The app code stays unchanged. */
(function () {
  var cfg = window.AMRAN_CONFIG;
  if (!cfg || /PASTE/.test(cfg.url || '')) {
    document.addEventListener('DOMContentLoaded', function () { document.body.insertAdjacentHTML('afterbegin', '<div style="position:fixed;inset:0;z-index:99999;background:#fff;color:#000;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font:16px system-ui">ضع رابط Supabase والمفتاح في ملف config.js</div>'); });
    return;
  }
  var sb = supabase.createClient(cfg.url, cfg.anon, { auth: { persistSession: true, autoRefreshToken: true } });
  var BUCKET = 'files';
  var sha = async function (s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(function (x) { return x.toString(16).padStart(2, '0'); }).join(''); };
  var mail = async function (n) { return 'u' + (await sha(n.toLowerCase().trim())).slice(0, 32) + '@amran.app'; };
  var meta = function (u) { var m = (u && u.app_metadata) || {}; return { id: u && u.id, name: m.name || '', role: m.role || 'user' }; };
  var cur = null, ch = null, listeners = new Set();

  async function fetchRows(q) {
    var r = sb.from('kv').select('id,data,updated_at').eq('coll', q.c).order('updated_at', { ascending: false }).limit(3000);
    var res = await r; if (res.error) throw res.error;
    var rows = res.data || [];
    if (q.o) { var f = q.o[0], d = q.o[1] === 'desc' ? -1 : 1; rows.sort(function (a, b) { var x = a.data[f], y = b.data[f]; return (x > y ? 1 : x < y ? -1 : 0) * d; }); }
    if (q.l) rows = rows.slice(0, q.l);
    return rows;
  }
  function snap(rows, prev) {
    var docs = rows.map(function (r) { return { id: r.id, exists: true, data: function () { return r.data; } }; });
    return {
      docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); },
      docChanges: function () {
        var ch = [], seen = new Set();
        docs.forEach(function (d) { seen.add(d.id); var p = prev.get(d.id); if (p === undefined) ch.push({ type: 'added', doc: d }); else if (p !== JSON.stringify(d.data())) ch.push({ type: 'modified', doc: d }); });
        prev.forEach(function (v, k) { if (!seen.has(k)) ch.push({ type: 'removed', doc: { id: k, data: function () { return JSON.parse(v); } } }); });
        return ch;
      }
    };
  }
  async function run(L) {
    try {
      var rows = await fetchRows(L.q), s = snap(rows, L.prev);
      L.cb(s);
      L.prev = new Map(rows.map(function (r) { return [r.id, JSON.stringify(r.data)]; }));
    } catch (e) { if (L.err) L.err(e); }
  }
  function Q(c) { this.c = c; this.o = null; this.l = null; }
  Q.prototype.orderBy = function (f, d) { this.o = [f, d || 'asc']; return this; };
  Q.prototype.limit = function (n) { this.l = n; return this; };
  Q.prototype.get = async function () { return snap(await fetchRows(this), new Map()); };
  Q.prototype.onSnapshot = function (cb, err) { var L = { q: this, cb: cb, err: err, prev: new Map() }; listeners.add(L); run(L); return function () { listeners.delete(L); }; };

  function D(p) { var i = p.indexOf('/'); this.c = p.slice(0, i); this.id = p.slice(i + 1); }
  D.prototype.get = async function () {
    var r = await sb.from('kv').select('data').eq('coll', this.c).eq('id', this.id).maybeSingle();
    if (r.error) throw r.error;
    var d = r.data && r.data.data;
    return { exists: !!r.data, id: this.id, data: function () { return d; } };
  };
  D.prototype.set = async function (v) {
    if (this.c === 'users') throw new Error('use admin function');
    var r = await sb.from('kv').upsert({ coll: this.c, id: this.id, data: v, updated_at: new Date().toISOString() });
    if (r.error) throw r.error;
  };
  D.prototype.update = async function (p) { var g = await this.get(); return this.set(Object.assign({}, g.exists ? g.data() : {}, p)); };
  D.prototype.delete = async function () {
    if (this.c === 'users') return window.__admin('delete', { id: this.id });
    var r = await sb.from('kv').delete().eq('coll', this.c).eq('id', this.id); if (r.error) throw r.error;
  };

  function start() {
    if (ch) sb.removeChannel(ch);
    ch = sb.channel('kv-' + Date.now()).on('postgres_changes', { event: '*', schema: 'public', table: 'kv' }, function (p) {
      var c = (p.new && p.new.coll) || (p.old && p.old.coll);
      listeners.forEach(function (L) { if (!c || L.q.c === c) { clearTimeout(L.t); L.t = setTimeout(function () { run(L); }, 150); } });
    }).subscribe();
    listeners.forEach(run);
  }

  var assets = {
    upload: async function (blob) { var id = crypto.randomUUID(); var r = await sb.storage.from(BUCKET).upload(id, blob, { contentType: 'text/plain' }); if (r.error) throw r.error; return { id: id }; },
    delete: async function (id) { await sb.storage.from(BUCKET).remove([id]); }
  };
  var user = { id: async function () { return cur && cur.id; }, isOwner: function () { return false; }, profiles: function () { return {}; } };
  var downloads = { save: async function (o) { var b = o.data instanceof Blob ? o.data : new Blob([o.data]); var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = o.filename; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500); } };
  var db = { collection: function (c) { return new Q(c); }, doc: function (p) { return new D(p); } };

  window.claude = { use: async function (n) { return { db: db, assets: assets, user: user, downloads: downloads }[n] || null; } };
  window.__assetText = async function (id) { var r = await sb.storage.from(BUCKET).download(id); if (r.error) throw r.error; return r.data.text(); };
  window.__login = async function (n, c) { var r = await sb.auth.signInWithPassword({ email: await mail(n), password: c }); if (r.error) throw r.error; cur = meta(r.data.user); start(); return cur; };
  window.__session = async function () { var r = await sb.auth.getSession(); if (!r.data.session) return null; cur = meta(r.data.session.user); start(); return cur; };
  window.__logout = function () { try { sb.auth.signOut(); } catch (e) {} Object.keys(localStorage).filter(function (k) { return k.indexOf('sb-') === 0; }).forEach(function (k) { localStorage.removeItem(k); }); };
  window.__admin = async function (action, body) { var r = await sb.functions.invoke('admin-users', { body: Object.assign({ action: action }, body) }); if (r.error) throw r.error; if (r.data && r.data.error) throw new Error(r.data.error); return r.data; };
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#lo')) window.__logout(); }, true);
})();
