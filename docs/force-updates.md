# Mandatory updates for Android and iOS

The shared web app now includes a native-only update gate on every HTML page. Ordinary browser visitors are not gated.

## What it does

- Reads the installed **native** version through Capacitor's `App.getInfo()` API.
- Reads `app_config/appVersion` from the existing `finder-owl` Firebase project.
- Compares the installed version with the platform's `minimumVersion` numerically: `1.10.0` is newer than `1.9.9`.
- Blocks the whole page while checking and whenever an update is required. There is no Continue, Later, close button, or Escape/Android Back dismissal.
- Opens the configured Google Play or App Store listing. Returning to the app triggers another check; opening the store does not unlock the app.
- Rechecks on launch, navigation, foreground/resume, connectivity recovery, and every 60 seconds while visible.
- Fails closed: missing/invalid configuration, an unavailable App plugin, a timeout, or a failed server read leaves the app locked with a Retry action. A previous successful check is never reused as an offline pass. Consequently, native users need connectivity to pass the check, including after resume.
- Leaves the browser website usable independently of this Firestore document.

The implementation is in `force-update.js`. It reuses `app.js`'s Firebase app and native App Check bridge, but always requests the policy with `getDocFromServer()`.

## One-time setup before releasing

### 1. Add the native plugins in the Capacitor wrapper project

The Android/iOS projects are **not in this repository**. In the separate project containing `capacitor.config.*` and the native projects, check your Capacitor major version:

```sh
npm ls @capacitor/core
```

Install **matching major versions** of the App and Browser plugins. For example, if Core is version 7:

```sh
npm install @capacitor/app@7 @capacitor/browser@7
npx cap sync
```

Use `@8` instead if Core is version 8. Do not blindly install the latest major alongside an older Core.

`App.getInfo()` must be available on both native platforms. Browser is the recommended way to open the store; the gate also attempts a browser-window fallback and stays locked if navigation fails.

Deploy these updated HTML files **and** `force-update.js` using your existing web-to-Capacitor asset pipeline, then run `npx cap sync` again. `capacitor.js` is supplied by the native Capacitor bridge; it is intentionally not a source file in this repository. A 404 for that file on the ordinary website does not activate the gate.

### 2. Set the native version numbers

Use three numeric components, such as `1.2.0`, consistently:

- Android: `versionName` in the native app's Gradle configuration. Also increment `versionCode` for each store upload.
- iOS: `CFBundleShortVersionString` in the native target's build settings/Info.plist. Also increment `CFBundleVersion` as required by App Store Connect.
- Keep this web project's `package.json` version aligned for clarity, but **the gate does not use package.json**. It uses the actual installed native version.

Pre-release suffixes, `v` prefixes, two-component versions, and four-component versions are rejected. Use the same format for Firestore's `minimumVersion`.

### 3. Create the Firestore document

In Firebase Console for **finder-owl**, create:

- Collection: `app_config`
- Document: `appVersion`

Fields:

| Field | Type | Value |
| --- | --- | --- |
| `android` | map | contains `minimumVersion` and `storeUrl`, both strings |
| `ios` | map | contains `minimumVersion` and `storeUrl`, both strings |
| `message` | string | optional plain-text update explanation, at most 500 characters |

Use `firebase/app-version.example.json` as the shape reference. Its version is only an example and its blank store URLs are intentional: replace both before publishing.

Example **after replacing the package ID, Apple ID, and versions with your real values**:

```json
{
  "android": {
    "minimumVersion": "1.2.0",
    "storeUrl": "https://play.google.com/store/apps/details?id=YOUR.REAL.PACKAGE"
  },
  "ios": {
    "minimumVersion": "1.2.0",
    "storeUrl": "https://apps.apple.com/in/app/your-app/idYOUR_REAL_APPLE_ID"
  },
  "message": "Please install the latest version to continue."
}
```

Only official HTTPS `play.google.com/store/apps/details?id=...` and `apps.apple.com/.../id...` URLs are accepted. Android and iOS are configured independently, so you can wait for each store's approval before raising its minimum.

For the first gate-enabled release, set each minimum to that release's native version (or an agreed older baseline if you intentionally want to allow it). Do not publish the example unchanged.

### 4. Merge the public-read rule

Merge the match block from `firebase/app-version.rules.example` into your **existing** Firestore rules, inside `match /databases/{database}/documents`:

```text
match /app_config/appVersion {
  allow read: if true;
  allow write: if false;
}
```

Do not replace the rest of your rules with this fragment. The document contains no private data. Console and Admin SDK writes bypass client security rules; client SDK writes remain forbidden unless another broader rule explicitly allows them.

Publish the rules and create the document before distributing the gate-enabled binary. If Firestore App Check enforcement is enabled, ensure the existing native App Check bridge works on **both** platforms; a public read rule does not exempt a request from App Check enforcement.

## Every subsequent release

1. Increment the native version and store build number.
2. Include the latest web assets and gate in the native build.
3. Upload and obtain approval/availability in the appropriate store.
4. Set that platform's `minimumVersion` to the newly released version.
5. Verify an older install is blocked, the store button opens the correct listing, and the updated install passes.

**Raise `minimumVersion` on every release to make every update mandatory.** Merely publishing a new store version does not change this setting. Raising it before the store release is available can leave users unable to update, so wait for availability. Lowering the minimum is the explicit rollback control.

## Important deployment limitation

A gates-enabled build is a **one-time bootstrap release**. An already-installed binary that bundles old HTML cannot acquire this new client code merely because a Firestore document changes. Those users must receive this build once, or the native wrapper must already load these pages from a hosted URL that you update. From then on, the gate enforces future minimum versions.

This is a client-side UI gate, not a security boundary: a modified client or direct API caller can bypass JavaScript. The backend is not in this checkout. For security-sensitive enforcement, also require a native app-version header at the API and reject versions below the server-side minimum. Never trust a version supplied only in a request body or query parameter as proof of the binary version.

## Validation

```sh
npm ci
npm test
npm run check
```

The automated tests cover both platforms, numeric comparison, malformed policies, safe store links, startup/resume/periodic checks, fail-closed network and plugin errors, retries, UI/focus blocking, Android Back, plain-text messages, and inclusion on all 11 pages.

Before store submission, also test real Android and iOS builds:

- Current version: enters normally.
- Older version: Update required; no way into the app.
- Newer version: enters normally.
- Airplane mode on launch/resume: locked with Retry, not an offline pass.
- Missing document or denied read: locked with Retry.
- Store button: correct platform listing; returning still checks the installed version.
- Raise the minimum while the app is open: locks within the next check.
- Ordinary browser: no update dialog.

No Firebase document/rules were deployed and no native binary was built by this repository change.
