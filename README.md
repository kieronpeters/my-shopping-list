# My Shopping List

A simple, private shopping list that lives on your phone. Add items, edit them, tick them off as you shop, and delete what you no longer need. Everything is saved automatically on the device and still works with no internet connection.

No accounts, no backend, no tracking, no store — just your list.

| Light | Dark |
| --- | --- |
| ![My Shopping List in light mode](docs/screenshot-light.png) | ![My Shopping List in dark mode](docs/screenshot-dark.png) |

## Run it locally

Only [Node.js](https://nodejs.org) 20 or newer is needed (for the tiny static file server). The app itself has **zero dependencies and no build step**.

```bash
npm start
```

Then open <http://localhost:4173>.

`PORT=8080 npm start` changes the port. The server listens on all interfaces so you can open `http://<your-pc-ip>:4173` on a phone on the same Wi-Fi for a quick look; set `HOST=127.0.0.1` to keep it local only.

## Install it on your phone (PWA)

The app is a PWA. Browsers only offer installation over **HTTPS** (localhost is the exception), so put the folder on any free static host. Nothing needs to be built — the files are the app.

1. Deploy the project folder to an HTTPS host:
   - **Netlify Drop** (easiest, no account required): go to <https://app.netlify.com/drop> and drag this folder onto the page.
   - **GitHub Pages**: push this folder to a repository, then enable Pages (Settings → Pages → deploy from branch, root folder).
   - **Cloudflare Pages / Vercel / any web host**: upload the folder as static files.
2. Open the HTTPS URL on your phone.
3. Install it:
   - **Android / Chrome**: menu (⋮) → **Add to Home screen** / **Install app**.
   - **iPhone / Safari**: Share button → **Add to Home Screen**.

The installed app opens full-screen, works offline, and keeps its own copy of the list.

## Using it

- **Add** — type an item and tap **Add** (or press Enter). Focus stays in the box so you can add several items quickly.
- **Mark purchased** — tap the circle. The item moves to **Purchased** with a strikethrough so what is still needed is obvious.
- **Un-tick** — tap the circle again to move it back to **To buy**.
- **Edit** — tap the pencil, change the text, then tap the check (or press Enter). Tap the cross (or press Escape) to cancel.
- **Delete** — tap the bin. A snackbar appears with **Undo** for six seconds.
- Everything is saved as you go; closing and reopening the app keeps your list.

## Where your data lives

- The list is stored in this browser's `localStorage` under the key `my-shopping-list:v1`.
- It is **per browser and per device**. Different phones or browsers have separate lists, and clearing the site's data (or the browser's storage) removes the list. There is no cloud backup by design.
- The app makes no network requests other than loading its own files.

## Offline behaviour and updates

- `sw.js` caches the app shell, so the app opens offline and your list stays available.
- When you change the app files on the host, bump `VERSION` at the top of `sw.js` (for example `v1` → `v2`) so clients refresh their cached copy. Your saved list is never touched by an update.
- The app shows no "update available" prompt; the new version takes over on the next launch.

## Project structure

```
index.html            single screen: header, add form, to-buy and purchased lists
styles.css            mobile-first styles, light and dark themes
app.js                rendering and interactions
store.js              pure list logic + localStorage persistence (unit tested)
sw.js                 service worker: offline app shell
manifest.webmanifest  PWA manifest (name, icons, standalone display)
icons/                generated PNG icons (favicon, 192, 512, maskable, Apple touch)
server.mjs            small static server for local use
tools/generate-icons.mjs  dependency-free icon generator
tests/                node:test suites and the real-browser E2E suite
docs/                 screenshots used above
```

## Development and tests

```bash
npm test          # 22 logic, static-asset, and server checks
npm run test:e2e  # 19 end-to-end checks in real Chrome
npm run test:all  # both suites
```

- `npm test` covers the list logic (add/edit/delete/toggle/undo, corrupt-data recovery, storage failures), manifest/icon validity, service-worker pre-caching, and the static server (content types, headers, traversal protection).
- `npm run test:e2e` launches installed Chrome (or Edge) headless, drives the app on a 390×844 mobile viewport, and verifies adding, editing, Enter/Escape, deleting with undo, purchased grouping, reload persistence, service-worker registration, genuine offline reload, 320/390 px layouts with 44 px tap targets, XSS-safe rendering, and corrupt-storage recovery. Set `CHROME_PATH` to use a specific browser. It also regenerates `docs/screenshot-light.png` and `docs/screenshot-dark.png`.
- `npm run icons` regenerates the icon set.

## Design decisions

- **No framework and no build step.** One screen, about 400 lines of JavaScript and a few hundred lines of CSS. It loads instantly, works on any static host, and will still run in years.
- **Local-first.** `localStorage` is the right size of tool for a personal list: durable, synchronous, no server, no account.
- **One screen.** Items needing purchase and purchased items live on the same screen, so there is nothing to navigate.
- **Mobile details.** 16 px inputs (no iOS zoom-on-focus), 44 px touch targets, safe-area insets, sticky add box, `prefers-color-scheme` dark mode, and `prefers-reduced-motion` support.
- **Safety.** User text is rendered with `textContent` only; stored data is validated and repaired on load.
