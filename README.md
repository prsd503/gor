# gor
gor

## Optional mobile update popup

Android/iOS builds show a dismissible Firestore-controlled update popup when the
installed version is lower than the configured version. See
[the setup and release checklist](docs/update-popup.md). Users can choose Later and
keep using the app; the ordinary browser website is unaffected.

Native debug/release App Check setup: [docs/app-check.md](docs/app-check.md).

Backend API (version endpoint, auth, App Check enforcement): [docs/backend-api.md](docs/backend-api.md).
The server lives in `server/` and is deployed separately from the static frontend.

Run `npm ci`, `npm test`, and `npm run check` to validate the shared web app.

## E-Bouquet

`bouquet.html` — reachable from the button under Owl Jump on the home page — lets a
visitor pick 6–10 blooms from a set of ten watercolour flowers, nudge the arrangement,
switch the greenery, write a short note and share the result as an animated GIF
(*E-Bouquet by Owl Watcher*) over WhatsApp.

Everything runs in the browser:

| File | Purpose |
| --- | --- |
| `bouquet.html` | page markup + page-specific styles |
| `bouquet-app.js` | picker, arrangement state, GIF export, sharing |
| `bouquet-engine.js` | seeded bouquet/card renderer (canvas 2D) |
| `gif-encoder.js` | dependency-free GIF89a writer (median-cut palette, LZW, delta frames) |
| `assets/flowers/*.png` | the ten bloom cut-outs (320 px, transparent) |

The page shares the finished GIF as a real image, never as a link: it hands the file to
the OS share sheet (`navigator.share` with files) so WhatsApp receives the animation
itself. Nothing is uploaded - the GIF is encoded locally. Browsers without file sharing
download the GIF and open a text-only chat as a fallback. A compact
`bouquet.html?b=rose,lily&m=…&f=…` link is still available for anyone who prefers it.
