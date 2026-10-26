// A starter Minilop app: private notes for whoever is signed in, and a guestbook everyone reads.
// The tables are declared in minilop.json; Minilop creates them when the app deploys.
// On Minilop, /_minilop/sdk.js comes with the app. Opened locally, load it from GitHub instead.
if (!window.Minilop) await import('https://cdn.jsdelivr.net/gh/minilop-io/Minilop-SDK@main/minilop.js');
const $ = s => document.querySelector(s);
const notes = Minilop.db.from('notes');
const guestbook = Minilop.db.from('guestbook');
const me = await Minilop.user();

function item(text, onDelete) {
  const li = document.createElement('li');
  li.textContent = text;
  if (onDelete) {
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Delete';
    x.onclick = onDelete;
    li.append(x);
  }
  return li;
}

async function showNotes() {
  const rows = await notes.select().order('created_at', { ascending: false });
  $('#notes').replaceChildren(...rows.map(n => item(n.text, async () => { await notes.delete().eq('id', n.id); showNotes(); })));
}

async function showGuestbook() {
  const rows = await guestbook.select().order('created_at', { ascending: false }).limit(50);
  $('#guestbook').replaceChildren(...rows.map(g => item(`${g.name || 'Someone'}: ${g.message}`,
    me && g.user_id === me.id ? async () => { await guestbook.delete().eq('id', g.id); showGuestbook(); } : null)));
}

if (me) {
  $('#mine').hidden = false;
  $('#sign').hidden = false;
  $('#add').onsubmit = async e => {
    e.preventDefault();
    await notes.insert({ text: e.target.text.value });
    e.target.reset();
    showNotes();
  };
  $('#sign').onsubmit = async e => {
    e.preventDefault();
    await guestbook.insert({ message: e.target.message.value, name: me.name });
    e.target.reset();
    showGuestbook();
  };
  showNotes();
} else {
  $('#signin').hidden = false;
  Minilop.signInButton('#signin');
}
showGuestbook();
