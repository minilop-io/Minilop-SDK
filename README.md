# Minilop SDK

Sign-in and a database for apps on [Minilop](https://minilop.io). Your app is a static site;
the SDK gives it signed-in users and tables, with no server of your own.

```html
<script src="/_minilop/sdk.js"></script>
```

Every Minilop app serves the SDK at `/_minilop/sdk.js`. With a bundler, install it from here
instead:

```bash
npm install github:minilop-io/Minilop-SDK
```

```js
import Minilop from 'minilop';
```

Starting from nothing? Copy the [`starter`](starter) folder: a page, a script and a
`minilop.json`, with sign-in, private notes and a public guestbook.

## Publishing

1. Put your site in a GitHub repo: plain HTML, or anything with a `build` script that outputs
   a static site (Vite, Astro, Next.js with `output: 'export'`, Create React App…).
2. Add a `minilop.json` if your app keeps data (below).
3. On [minilop.io](https://minilop.io), press **Create**, pick the repo, and launch. Every push
   deploys again.

Minilop only hosts static files. Anything you'd have used a server for goes in your tables.

## Signing in

```js
const me = await Minilop.user();   // { id, username, name, avatar, isOwner } or null
Minilop.login();                   // to minilop.io and back, signed in
Minilop.signInButton('#signin');   // the official button, or ('#signin', { theme: 'light' })
await Minilop.logout();
```

Someone already signed in on minilop.io arrives signed in. Apps get a person's id, username,
name and picture, never their email.

## Tables

Declare them in `minilop.json` at the root of your site (or the folder you deploy):

```json
{
  "tables": {
    "lunches": { "access": "private", "columns": { "dish": "text", "price": "number", "eaten": "date" } },
    "places":  { "access": "maker",   "columns": { "name": "text", "healthy": "int" } },
    "tips":    { "access": "public",  "columns": { "body": "text" } }
  }
}
```

Minilop creates them in your app's own Postgres schema when it deploys.

| `access` | Who reads | Who writes |
|---|---|---|
| `private` (default) | each person their own rows | each person their own rows |
| `public` | everyone | signed-in people add rows and change only their own |
| `maker` | everyone | only you, the app's maker |

Column types: `text`, `int`, `number`, `bool`, `date`, `time` (a date and time), `json`, `uuid`.
Every table also has `id`, `user_id` (who added the row, filled in for you), `created_at` and
`updated_at`. Deploys only add tables and columns, never drop or change them, so a push can't
lose data. A private or sign-in-only app's tables follow the app: strangers can't read them.

```js
const lunches = Minilop.db.from('lunches');

await lunches.insert({ dish: 'falafel', price: 6.5, eaten: '2026-10-26' });
await lunches.insert([{ dish: 'ramen' }, { dish: 'bao' }]);

const recent = await lunches.select().order('created_at', { ascending: false }).limit(20);
const cheap = await lunches.select('dish, price').lt('price', 7);
const one = await lunches.select().eq('id', id).single();   // a row or null

await lunches.update({ price: 7 }).eq('id', id);
await lunches.delete().eq('id', id);
```

Filters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike` (`%` matches anything), `in`
(an array), `is` (`null`, `true`, `false`). Also `order`, `limit`, `offset` and `single`.
`update` and `delete` need a filter. Every call returns the rows it read or changed, and throws
a `Minilop.Error` when it can't: `err.code` is `'not_signed_in'` or `'not_allowed'` when the
table's rules said no.

Your pages talk to your tables directly, over Supabase's Data API, so reads and writes are as
fast as the database. Minilop wrote each table's rules, and the visitor's session (which only
works for your app) tells the database who's asking.

## Files

Per-person files, for the signed-in visitor in your app only (25 MB each):

```js
await Minilop.files.upload(input.files[0], 'photos/lunch.jpg');
const url = await Minilop.files.url('photos/lunch.jpg');   // a short-lived link
await Minilop.files.list('photos/');
await Minilop.files.delete('photos/lunch.jpg');
```

## Trying it before it's on Minilop

Opened anywhere but Minilop (`localhost`, a file), the SDK keeps tables in the browser's
localStorage and signs you in as a pretend user, so you can build the whole app first.
`await Minilop.online()` tells you which it is. Files only work on Minilop.

```bash
npx serve starter
```

## Also

```js
await Minilop.app();    // { slug, name, url, shareUrl }
await Minilop.share();  // the share sheet, or copies the link
```

If your pages send a `Content-Security-Policy`, allow `connect-src` to
`https://ivqmklaqutradnbrdgxo.supabase.co` for tables and files.
