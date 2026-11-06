# Optional update popup for Android and iOS

The shared web app shows a **dismissible** native update popup on every HTML page. It replaces the previous mandatory-update gate. Ordinary browser visitors are unaffected.

## Behavior

- Reads the installed native version through Capacitor `App.getInfo()`.
- Reads `app_config/appVersion` from the existing `finder-owl` Firebase project.
- Shows **Update available** only when the installed version is lower than that platform's `minimumVersion`.
- Provides **Update Now** / platform store button, **Later**, a close button, Escape, backdrop tap, and Android Back dismissal.
- **Later restores normal app use.** The same offer is suppressed for the current WebView session using `sessionStorage`, so navigating between pages does not repeatedly nag. A newer configured version or installed version produces a new offer; a fresh session can show it again.
- Checks on launch, navigation, foreground/resume, connectivity recovery, and every 60 seconds while visible.
- **Fails open:** missing/invalid configuration, App plugin errors, timeouts, offline reads, or denied Firestore access hide the popup and log a console warning. They never block the app.
- Uses the actual native marketing version, not `package.json` or Android `versionCode`.

Implementation: `update-popup.js` and `app-check.mjs`. The popup first reads `GET /api/app-version` from the backend, which uses the Firebase Admin SDK and therefore does not depend on client App Check attestation. If that API is unreachable it falls back to a direct Firestore `getDocFromServer()` read through `app.js`'s native App Check bridge. See [the backend API guide](backend-api.md) and [the native App Check guide](app-check.md).

## Native wrapper setup

The Android/iOS projects are not in this repository. In the wrapper project containing `capacitor.config.*`:

```sh
npm ls @capacitor/core
```

Install matching major versions of the App and Browser plugins if absent. For Core 8:

```sh
npm install @capacitor/app@8 @capacitor/browser@8
npx cap sync
```

Use `@7` for Core 7. Copy the updated web assets, including `app.js`, `app-check.mjs`, `update-popup.js`, and all updated HTML files, into the wrapper's configured `webDir` (`www` in the existing setup), then run:

```sh
npx cap sync android
npx cap sync ios
```

`capacitor.js` is supplied by the native bridge. A 404 for it on the ordinary website does not activate the popup.

## Version format

Use three numeric components consistently, for example `2.7.0`:

- Android: Gradle `versionName`, e.g. `versionName "2.7.0"`. Keep incrementing integer `versionCode` for store uploads.
- iOS: `CFBundleShortVersionString`, e.g. `2.7.0`. Increment `CFBundleVersion` as required by App Store Connect.
- Firestore: `minimumVersion` strings in the same format.

Values such as `18`, `2.7`, `v2.7.0`, and `2.7.0-beta` are invalid for this popup and are skipped without blocking the app.

## Firestore document

Project: **finder-owl**

Path: **`app_config/appVersion`**

Fields:

| Field | Type | Value |
| --- | --- | --- |
| `android` | map | `minimumVersion` string and official Google Play `storeUrl` string |
| `ios` | map | `minimumVersion` string and official App Store `storeUrl` string |
| `message` | string | optional plain-text explanation, at most 500 characters |

Example with your real IDs/version:

```json
{
  "android": {
    "minimumVersion": "2.8.0",
    "storeUrl": "https://play.google.com/store/apps/details?id=io.github.prsd503.owl"
  },
  "ios": {
    "minimumVersion": "2.8.0",
    "storeUrl": "https://apps.apple.com/in/app/your-app/idYOUR_REAL_APPLE_ID"
  },
  "message": "A newer version is available. Update now or continue using the app."
}
```

An installed Android `2.7.0` build would see the popup; `2.8.0` or newer would not. iOS must use an `apps.apple.com` URL, not a Play Store URL. Blank example URLs in `firebase/app-version.example.json` are intentionally invalid until replaced.

Merge this rule into the existing Firestore rules inside `match /databases/{database}/documents` and publish:

```text
match /app_config/appVersion {
  allow read: if true;
  allow write: if false;
}
```

Do not replace unrelated rules. If Firestore App Check enforcement is enabled, the native App Check bridge must still work for the read to succeed; failure simply skips the popup. Debug builds need an explicit native debug signal and a registered Firebase debug token; see [the native App Check guide](app-check.md).

## Release checklist

1. Increment native `versionName` / `CFBundleShortVersionString` and store build number.
2. Include the latest web assets, `app.js`, `app-check.mjs`, and `update-popup.js`.
3. Release to the appropriate store.
4. Set that platform's `minimumVersion` to the version you want older installs to be offered.
5. Test older, equal, and newer installs.

This is a reminder, not enforcement. Users can keep using older versions after Later. Raising the Firestore value does not update bundled HTML in an already-installed binary; ship the popup-enabled web assets once, or load them from a hosted URL.

## Validation

```sh
npm ci
npm test
npm run check
```

Device checks:

- Older version: popup appears; Update opens the correct store; Later/close/Back restores app use.
- Equal/newer version: no popup.
- Offline, denied read, missing document, or missing App plugin: no popup and app remains usable.
- Later then navigate/resume: same offer stays dismissed for the session.
- Raise `minimumVersion`: new offer can appear on the next check.
- Ordinary browser: no popup.

No Firebase document/rules are deployed and no native binary is built by this repository change.
