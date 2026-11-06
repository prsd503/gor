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
