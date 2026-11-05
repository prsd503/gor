# gor
gor

## Mandatory mobile updates

Android/iOS builds use a Firestore-controlled update gate on every page. See
[the setup and release checklist](docs/force-updates.md) before distributing a build.
The ordinary browser website is not gated.

Run `npm ci`, `npm test`, and `npm run check` to validate the shared web app.
