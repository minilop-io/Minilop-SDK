// The SDK in a pretend browser: on Minilop it calls the app's schema through the Data API with
// the visitor's session; anywhere else it keeps rows in localStorage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../minilop.js', import.meta.url), 'utf8');
let calls, onMinilop, apiReply;

function load() {
  const storage = new Map();
  globalThis.window = globalThis;
  delete globalThis.Minilop;
  globalThis.location = { pathname: '/', search: '', hash: '', href: 'http://localhost/', assign(u) { this.assigned = u; }, reload() { this.reloaded = true; } };
  globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
  globalThis.console.info = () => {};
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    if (url === '/_minilop/client') {
      if (!onMinilop) return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
      return Response.json({
        app: { slug: 'street-eats', name: 'Street Eats' }, user: { id: 'u1', name: 'Bob' }, session: 'sess-1',
        db: { url: 'https://proj.supabase.co', key: 'anon-key', schema: 'app_street_eats' },
      });
    }
    return apiReply();
  };
  new Function(source)();
  return globalThis.Minilop;
}

beforeEach(() => { calls = []; onMinilop = true; apiReply = () => Response.json([{ id: 'r1', dish: 'falafel' }]); });

test('on Minilop: reads go to the app\'s schema with the visitor\'s session', async () => {
  const M = load();
  assert.equal((await M.user()).id, 'u1');
  const rows = await M.db.from('lunches').select('dish, price').eq('dish', 'falafel').in('id', ['a', 'b,c']).order('created_at', { ascending: false }).limit(5);
  assert.deepEqual(rows, [{ id: 'r1', dish: 'falafel' }]);
  const c = calls.at(-1);
  const u = new URL(c.url);
  assert.equal(u.origin + u.pathname, 'https://proj.supabase.co/rest/v1/lunches');
  assert.equal(u.searchParams.get('select'), 'dish, price');
  assert.equal(u.searchParams.get('dish'), 'eq.falafel');
  assert.equal(u.searchParams.get('id'), 'in.("a","b,c")');
  assert.equal(u.searchParams.get('order'), 'created_at.desc');
  assert.equal(u.searchParams.get('limit'), '5');
  assert.equal(c.method, 'GET');
  assert.equal(c.headers['Accept-Profile'], 'app_street_eats');
  assert.equal(c.headers['x-minilop-session'], 'sess-1');
  assert.equal(c.headers.apikey, 'anon-key');
  assert.equal(calls.filter(x => x.url === '/_minilop/client').length, 1, 'asked once');
});

test('on Minilop: writes say which schema, ask for the rows back, and need a filter to change rows', async () => {
  const M = load();
  await M.db.from('lunches').insert({ dish: 'ramen' });
  const c = calls.at(-1);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Profile'], 'app_street_eats');
  assert.equal(c.headers.Prefer, 'return=representation');
  assert.equal(c.body, '{"dish":"ramen"}');
  assert.equal((await M.db.from('lunches').update({ price: 7 }).eq('id', 'r1')).length, 1);
  assert.equal(calls.at(-1).method, 'PATCH');
  await assert.rejects(M.db.from('lunches').delete(), /needs a filter/);
  assert.deepEqual(await M.db.from('lunches').select().single(), { id: 'r1', dish: 'falafel' });
  assert.throws(() => M.db.from('Lunches; drop'), /lowercase/);
});

test('one table object can be reused: each step is a new query', async () => {
  onMinilop = false;
  const M = load();
  const notes = M.db.from('notes');
  await notes.insert({ text: 'a' });
  await notes.select().eq('text', 'nope');
  await notes.insert({ text: 'b' });
  assert.deepEqual((await notes.select().order('text')).map(n => n.text), ['a', 'b'], 'each insert ran once, and no filter stuck');
  await notes.delete().eq('text', 'a');
  assert.deepEqual((await notes.select()).map(n => n.text), ['b']);
});

test('on Minilop: the database\'s refusals come back as plain errors', async () => {
  const M = load();
  apiReply = () => Response.json({ code: '42501', message: 'new row violates row-level security policy for table "places"' }, { status: 403 });
  await assert.rejects(M.db.from('places').insert({ name: 'x' }), e => e.code === 'not_allowed' && /can't change that row of "places"/.test(e.message));
  apiReply = () => Response.json({ code: 'PGRST205', message: 'Could not find the table' }, { status: 404 });
  await assert.rejects(M.db.from('nope').select(), /declare it under "tables" in minilop.json/);
});

test('anywhere else: a pretend user and tables kept in this browser', async () => {
  onMinilop = false;
  const M = load();
  assert.equal(await M.online(), false);
  assert.equal((await M.user()).name, 'You (local)');
  const [a] = await M.db.from('lunches').insert({ dish: 'falafel', price: 6.5 });
  await M.db.from('lunches').insert([{ dish: 'ramen', price: 9 }, { dish: 'bao', price: 5 }]);
  assert.ok(a.id && a.created_at && a.user_id);
  assert.deepEqual((await M.db.from('lunches').select('dish').lt('price', 7).order('price')).map(r => r.dish), ['bao', 'falafel']);
  assert.deepEqual((await M.db.from('lunches').select().ilike('dish', 'RA%')).map(r => r.price), [9]);
  await M.db.from('lunches').update({ price: 7, id: 'hijack' }).eq('id', a.id);
  assert.equal((await M.db.from('lunches').select().eq('id', a.id).single()).price, 7);
  await M.db.from('lunches').delete().eq('dish', 'bao');
  assert.equal((await M.db.from('lunches').select()).length, 2);
  assert.equal(calls.filter(c => c.url !== '/_minilop/client').length, 0, 'nothing leaves the browser');
  await M.logout(false);
  await assert.rejects(M.db.from('lunches').insert({ dish: 'x' }), e => e.code === 'not_signed_in');
});
