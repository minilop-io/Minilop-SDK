// Minilop SDK: sign-in and a database for apps hosted on Minilop. https://github.com/minilop-io/Minilop-SDK
//
//   <script src="/_minilop/sdk.js"></script>        (served by every Minilop app)
//
//   const me = await Minilop.user();                 // { id, username, name, avatar, isOwner } or null
//   Minilop.login();                                 // sends the visitor to sign in, then back here
//   Minilop.signInButton('#signin');                 // the official "Sign in with Minilop" button
//
//   const lunches = Minilop.db.from('lunches');      // a table declared in minilop.json
//   await lunches.insert({ dish: 'falafel', price: 6.5 });
//   await lunches.select().order('created_at', { ascending: false }).limit(20);
//   await lunches.update({ price: 7 }).eq('id', id);
//   await lunches.delete().eq('id', id);
//
// The app's pages talk to its tables directly (Supabase's Data API, the app's own Postgres
// schema), with the rules Minilop wrote for each table: no server in between. Opened anywhere
// else (localhost, a file), the SDK keeps everything in this browser instead, signed in as a
// pretend user, so an app can be built and tried before it's on Minilop.
(function () {
  if (typeof window === 'undefined' || window.Minilop) return;

  const VERSION = '1.0.0';
  const enc = encodeURIComponent;
  const here = () => location.pathname + location.search + location.hash;

  class MinilopError extends Error {
    constructor(message, { status = 0, code = null } = {}) { super(message); this.name = 'MinilopError'; this.status = status; this.code = code; }
  }

  // ---------------------------------------------------------------- where we are

  // On Minilop, /_minilop/client says who's here and how to reach the app's tables. Anywhere
  // else it's missing (or a dev server answers with its index.html): local mode.
  let client;
  const config = () => (client ??= fetch('/_minilop/client', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(r => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : null))
    .catch(() => null)
    .then(c => {
      if (!c) console.info('[minilop] Not on Minilop: data is kept in this browser, signed in as a pretend user.');
      return c;
    }));

  async function call(method, path, body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) throw new MinilopError((out && out.error) || res.statusText, { status: res.status, code: res.status === 401 ? 'not_signed_in' : null });
    return out;
  }

  // ---------------------------------------------------------------- local mode

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem('minilop:' + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('minilop:' + k, JSON.stringify(v)); } catch {} },
  };
  const LOCAL_USER = { id: '00000000-0000-4000-8000-000000000001', username: 'you', name: 'You (local)', avatar: null, isOwner: true };
  const localUser = () => (store.get('signed-out', false) ? null : LOCAL_USER);
  const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ---------------------------------------------------------------- the database

  const OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  const like = (pattern, flags) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', flags);
  const matches = (row, [col, op, val]) => {
    const v = row[col];
    switch (op) {
      case 'eq': return v === val || (v != null && val != null && String(v) === String(val));
      case 'neq': return !(v === val || (v != null && String(v) === String(val)));
      case 'gt': return v > val;
      case 'gte': return v >= val;
      case 'lt': return v < val;
      case 'lte': return v <= val;
      case 'like': return like(val).test(String(v ?? ''));
      case 'ilike': return like(val, 'i').test(String(v ?? ''));
      case 'in': return val.some(x => String(x) === String(v));
      case 'is': return v === val || (val === null && v === undefined);
    }
    return false;
  };
  // PostgREST's syntax for one filter value.
  const pgValue = (op, val) => (op === 'in' ? `(${val.map(x => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')})` : op === 'is' ? String(val) : String(val));

  // Every step returns a new query, so `const notes = Minilop.db.from('notes')` can be reused.
  class Query {
    constructor(table, state) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) throw new MinilopError(`No table "${table}": table names are lowercase, as in minilop.json`);
      Object.assign(this, { table, action: 'select', columns: '*', returning: null, filters: [], sort: [], max: null, skip: 0, body: undefined, one: false }, state);
    }
    with(changes) { return new Query(this.table, { ...this, ...changes }); }
    // Reading: select('dish, price') picks columns; filters, order and limit narrow it down.
    select(columns = '*') { return this.with(this.action === 'select' ? { columns } : { returning: columns }); }
    insert(rows) { return this.with({ action: 'insert', body: rows }); }
    update(patch) { return this.with({ action: 'update', body: patch }); }
    delete() { return this.with({ action: 'delete' }); }
    order(column, { ascending = true } = {}) { return this.with({ sort: [...this.sort, [column, ascending]] }); }
    limit(n) { return this.with({ max: n }); }
    offset(n) { return this.with({ skip: n }); }
    // The first row, or null.
    single() { return this.with({ one: true, max: this.max ?? 1 }); }
    then(resolve, reject) { return this.run().then(resolve, reject); }
    catch(reject) { return this.run().catch(reject); }

    async run() {
      if (['update', 'delete'].includes(this.action) && !this.filters.length) {
        throw new MinilopError(`${this.action}() needs a filter, such as .eq('id', id), so it never changes every row by accident`);
      }
      const c = await config();
      const rows = c ? await this.remote(c) : this.local();
      return this.one ? rows[0] ?? null : rows;
    }

    async remote(c) {
      if (!c.db) throw new MinilopError(`No table "${this.table}": declare it under "tables" in minilop.json and deploy again`);
      const q = new URLSearchParams();
      if (this.action === 'select') q.set('select', this.columns);
      else if (this.returning) q.set('select', this.returning);
      for (const [col, op, val] of this.filters) q.append(col, `${op}.${pgValue(op, val)}`);
      if (this.sort.length) q.set('order', this.sort.map(([col, asc]) => `${col}.${asc ? 'asc' : 'desc'}`).join(','));
      if (this.max != null) q.set('limit', String(this.max));
      if (this.skip) q.set('offset', String(this.skip));
      const read = this.action === 'select';
      const res = await fetch(`${c.db.url}/rest/v1/${this.table}?${q}`, {
        method: { select: 'GET', insert: 'POST', update: 'PATCH', delete: 'DELETE' }[this.action],
        headers: {
          apikey: c.db.key, Authorization: `Bearer ${c.db.key}`,
          [read ? 'Accept-Profile' : 'Content-Profile']: c.db.schema,
          ...(c.session ? { 'x-minilop-session': c.session } : {}),
          ...(read ? {} : { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        },
        body: this.body === undefined ? undefined : JSON.stringify(this.body),
      });
      const out = await res.json().catch(() => null);
      if (res.ok) return out || [];
      let message = out?.message || res.statusText;
      let code = out?.code || null;
      if (/row-level security/.test(message)) {
        code = c.user ? 'not_allowed' : 'not_signed_in';
        message = c.user ? `You can't change that row of "${this.table}"` : `Sign in to change "${this.table}"`;
      } else if (code === 'PGRST205' || code === 'PGRST106' || code === '42P01') {
        message = `No table "${this.table}": declare it under "tables" in minilop.json and deploy again`;
      }
      throw new MinilopError(message, { status: res.status, code });
    }

    local() {
      const all = store.get(`table:${this.table}`, []);
      const hit = r => this.filters.every(f => matches(r, f));
      const now = new Date().toISOString();
      if (this.action === 'insert') {
        if (!localUser()) throw new MinilopError(`Sign in to change "${this.table}"`, { code: 'not_signed_in' });
        const added = [].concat(this.body).map(r => ({ id: uuid(), user_id: LOCAL_USER.id, created_at: now, updated_at: now, ...r }));
        store.set(`table:${this.table}`, all.concat(added));
        return added;
      }
      if (this.action === 'update') {
        const changed = [];
        store.set(`table:${this.table}`, all.map(r => (hit(r) ? (changed.push(r = { ...r, ...this.body, id: r.id, user_id: r.user_id, updated_at: now }), r) : r)));
        return changed;
      }
      if (this.action === 'delete') {
        store.set(`table:${this.table}`, all.filter(r => !hit(r)));
        return all.filter(hit);
      }
      let rows = all.filter(hit);
      for (const [col, asc] of [...this.sort].reverse()) rows = rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      rows = rows.slice(this.skip, this.max == null ? undefined : this.skip + this.max);
      if (this.columns !== '*') {
        const cols = this.columns.split(',').map(s => s.trim()).filter(Boolean);
        rows = rows.map(r => Object.fromEntries(cols.map(k => [k, r[k]])));
      }
      return rows;
    }
  }
  for (const op of [...Object.keys(OPS), 'like', 'ilike', 'in', 'is']) {
    Query.prototype[op] = function (column, value) {
      if (op === 'in' && !Array.isArray(value)) throw new MinilopError('in() takes an array of values');
      return this.with({ filters: [...this.filters, [column, op, value]] });
    };
  }

  // ---------------------------------------------------------------- the sign-in button

  const MARK = 'M405.29,277.39c-17.45,37.47-54.4,59.55-93.68,68.29-18.29,4.07-36.65,5.81-55.42,5.4-28.2-.61-54.93-5.23-80.56-17.02s-47.78-31.05-59.62-57.14c-10.96,20.11-23.11,38.61-40.71,53.41-11.91,9.81-26.88,17.06-42.35,13.77-18.43-3.92-27.41-23.05-30.62-40.45-1.97-10.66-2.59-21.09-2.25-32.03.5-16.37,2.33-32.35,5.57-48.43,4.69-23.29,11.42-45.83,19.99-67.95,5.76-14.88,12.49-29.01,20.2-42.94,16.38-29.63,34.7-57.78,58.86-81.64,6.25-6.17,12.73-11.55,19.92-16.36,24.34-16.28,54.83-18.89,81.55-6.72,22.54,10.01,40.89,29.59,54.56,49.85,8.79-12.86,18.64-24.29,30.35-34.21,11.18-9.48,23.83-16.7,37.99-20.43,22.43-5.91,45.76-2.4,65.37,9.89,6.36,3.99,12.16,8.32,17.71,13.5,14.35,13.39,26.79,28.35,37.74,44.65l15.74,24.57c18.22,31.82,30.19,58.34,41.03,93.51,8.94,28.99,15.26,63.49,14.61,93.69-.34,15.95-3.11,33.82-12.15,46.98-10.63,15.49-27.63,18.79-44.81,11.86-25.69-10.37-45.27-39.91-58.36-63.62l-.66-.44ZM392.73,254.74l-8.01-21.67c-7.86-25.75-14.6-55.28-16.03-82.13l.27-4.74c.02-.41.74-1.17,1.1-1.19s1.23.54,1.36.89l4.82,12.91c6.82,19.56,13.85,38.74,21.64,57.98,11.66,28.77,26.23,57.63,45.49,81.97,6.95,8.79,18.14,21.06,28.61,23.84,8.77,2.32,14.6-1.57,18.07-9.69,4.17-9.76,6-19.93,6.54-30.62.74-14.71-.16-28.93-2.32-43.47-1.82-12.27-4.16-23.95-7.57-35.91-5.06-17.75-10.61-35.08-17.64-52.18-12.33-29.98-28.94-59.79-48.61-85.52-6.3-8.25-13.26-15.56-20.8-22.62s-15.56-12.52-24.85-16.56c-12.79-5.56-26.68-6.45-40.06-2.55-19.54,5.7-36.93,20.7-49.65,36.36-7.46,9.18-13.88,18.76-20.12,28.77-1.07,1.72-2.71,3.09-4.82,2.94s-4.13-1.74-5.27-3.76c-12.21-21.72-28.28-43.18-49.86-56.19-18.96-11.43-39.62-14.37-59.97-4.81-8.29,3.89-15.66,8.83-22.42,15.07-15.98,14.75-26.84,28.47-38.27,46.96-6.08,9.84-11.88,19.42-17.28,29.69-7.01,13.36-13.17,26.9-18.47,41.07-7.07,18.89-12.95,37.9-17.36,57.59-3.35,14.93-5.34,29.75-6.41,45.01s.6,29.75,3.81,44.3c.8,3.63,2.14,6.84,3.95,9.91,5.22,8.84,16.03,8.29,24.52,2.88,28.24-18.03,57.51-76.93,69.19-108.8l18.81-51.34,5-13.17c.16-.43,1.25-1.15,1.63-.94,2.12,1.15.53,15.03-.18,20.92-2.47,20.54-6.8,40.46-12.56,60.33-2.89,9.97-6.24,19.3-10.18,28.92,3.59,17.02,14.36,33.8,27.32,45.46,18.32,16.18,41.83,25.25,65.78,29.79,30.76,5.83,62.42,4.68,92.64-3.51,13.64-3.7,26.45-9.05,38.27-16.62,13.52-8.66,24.46-20.16,32.03-34.29,3.63-6.78,6.52-13.65,7.87-21.29Z';
  const BUTTON_CSS = `
:host { display: inline-block; }
button { all: initial; box-sizing: border-box; display: inline-flex; align-items: center; gap: 12px; height: 48px; padding: 0 24px 0 20px;
  border-radius: 24px; cursor: pointer; font: 600 16px/1 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  background: #2F2924; color: #EFE8DB; -webkit-font-smoothing: antialiased; transition: transform .12s, box-shadow .12s; }
button:hover { box-shadow: 0 4px 14px rgba(0,0,0,.18); }
button:active { transform: scale(.98); }
button:focus-visible { outline: 2px solid #2F2924; outline-offset: 2px; }
:host([theme="light"]) button { background: #EFE8DB; color: #2F2924; }
svg { width: 33px; height: 22px; display: block; }`;

  // ---------------------------------------------------------------- Minilop

  let me;
  window.Minilop = {
    version: VERSION,
    Error: MinilopError,
    // True on Minilop, false in local mode.
    online: () => config().then(c => !!c),

    async user() {
      if (me !== undefined) return me;
      const c = await config();
      return (me = c ? c.user : localUser());
    },
    async login(returnTo) {
      if (!(await config())) { store.set('signed-out', false); me = undefined; location.reload(); return; }
      location.assign('/_minilop/login?return=' + enc(returnTo || here()));
    },
    async logout(returnTo) {
      if (await config()) await call('POST', '/_minilop/logout', {});
      else store.set('signed-out', true);
      me = null;
      if (returnTo !== false) location.href = returnTo || '/';
    },
    // Puts the official button in `el` (an element or a CSS selector). theme: 'dark' or 'light'.
    signInButton(el, { returnTo, theme = 'dark' } = {}) {
      const target = typeof el === 'string' ? document.querySelector(el) : el;
      if (!target) throw new MinilopError('Minilop.signInButton: no such element');
      const host = document.createElement('minilop-sign-in');
      host.setAttribute('theme', theme);
      const root = host.attachShadow({ mode: 'closed' });
      try { const sheet = new CSSStyleSheet(); sheet.replaceSync(BUTTON_CSS); root.adoptedStyleSheets = [sheet]; }
      catch { const st = document.createElement('style'); st.textContent = BUTTON_CSS; root.append(st); }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 521.32 351.14'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', MARK); path.setAttribute('fill', 'currentColor'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
      svg.append(path);
      const button = document.createElement('button');
      button.type = 'button';
      button.append(svg, document.createTextNode('Sign in with Minilop'));
      button.addEventListener('click', () => Minilop.login(returnTo));
      root.append(button);
      target.append(host);
      return host;
    },

    db: { from: table => new Query(table) },

    files: {
      // Upload a File/Blob for the signed-in visitor, in this app only. Returns { path }.
      async upload(file, path) {
        const p = path || file.name || `file-${Date.now()}`;
        if (!(await config())) throw new MinilopError('Files work once the app is on Minilop');
        const { signedUrl } = await call('POST', '/_minilop/files/upload', { path: p });
        const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' } });
        if (!res.ok) throw new MinilopError('Upload failed', { status: res.status });
        return { path: p };
      },
      // A short-lived link to download or show a file.
      url: path => call('GET', '/_minilop/files/url?path=' + enc(path)).then(r => r.signedUrl),
      list: (prefix = '') => call('GET', '/_minilop/files?prefix=' + enc(prefix)),
      delete: path => call('DELETE', '/_minilop/files', { path }),
    },

    // The app's name and addresses: { slug, name, url, shareUrl }, or null in local mode.
    app: () => config().then(c => c?.app || null),

    async share() {
      const info = await Minilop.app();
      const url = info?.shareUrl || location.href;
      if (navigator.share) {
        try { await navigator.share({ title: info?.name || document.title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      await navigator.clipboard.writeText(url);
      return url;
    },
  };
})();
