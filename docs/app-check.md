# Native App Check bridge for the update popup

The optional update popup reads `app_config/appVersion` from Firestore. If Firestore App Check enforcement is enabled, a public Firestore rule (`allow read: if true`) is **not enough**: the native app must also present a valid App Check token.

The device log that motivated this fix was:

```text
FirebaseAppCheck.getToken: Error returned from API. code: 403 body: App attestation failed.
CustomProvider failed to get native token
[update-popup] Check skipped: permission-denied: Missing or insufficient permissions.
```

The popup intentionally fails open, so the denied read hides it. The version comparison was not the problem.

## What the shared web app now does

- `app-check.mjs` initializes the native `@capacitor-firebase/app-check` plugin before the Firebase JS SDK can request a token.
- Native initialization uses `debugToken: true` or `debugToken: false`. It does **not** send the web-only `provider: 'playIntegrity'` option.
- Debug mode is enabled only by an explicit native signal:
  - `window.NativeConfig.isDebug()` returning `true`
  - `window.NativeConfig.isDebug === true` or `window.NativeConfig.debug === true`
  - a synchronous `window.Capacitor.Plugins.NativeConfig.isDebug()` returning `true`
  - `window.__OWL_NATIVE_DEBUG__ === true`
- URL parameters, localhost, user-agent strings, and storage values never enable debug mode.
- `app.js` exports `appCheckReady`; the Firestore policy loader waits for it before the first read.
- Fail-open warnings now include Firebase error codes such as `permission-denied`.
- Browser visitors still use the existing reCAPTCHA v3 App Check path.

## Android debug bridge

In the native wrapper project, expose the binary's debug flag to the WebView. Example `MainActivity.java`:

```java
package io.github.prsd503.owl;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = bridge.getWebView();
        webView.addJavascriptInterface(new NativeConfig(), "NativeConfig");
    }

    public static class NativeConfig {
        @JavascriptInterface
        public boolean isDebug() {
            return BuildConfig.DEBUG;
        }
    }
}
```

Kotlin equivalent:

```kotlin
bridge.webView.addJavascriptInterface(object {
    @JavascriptInterface
    fun isDebug(): Boolean = BuildConfig.DEBUG
}, "NativeConfig")
```

Use the wrapper's real `applicationId`/`BuildConfig` import. The interface must be added before the web app runs.

## iOS debug bridge

Inject a boolean into the Capacitor `WKWebView` before the first page load. Example Swift user script:

```swift
var isDebug = false
#if DEBUG
isDebug = true
#endif

let source = "window.__OWL_NATIVE_DEBUG__ = \(isDebug);"
let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
webView.configuration.userContentController.addUserScript(script)
```

Add this to the wrapper's Capacitor WebView configuration/startup path. Do not hard-code `true` for release builds.

## Register the debug token in Firebase Console

For a debug build:

1. Run the app on the device/emulator.
2. Android: filter Logcat for `DebugAppCheckProvider`. iOS: check the Xcode console.
3. Copy the debug secret printed by the Firebase App Check debug provider.
4. In Firebase Console: **App Check → Apps → your Android/iOS app → Manage debug tokens → Add debug token**.
5. Restart the app.

The shared web app cannot register this secret for you. Without it, debug builds can still receive `403 App attestation failed` or rate-limit errors.

## Release builds

Debug tokens are only for development. For release:

- Android: register the release signing certificate SHA-256 in the Firebase Android app, use the matching `google-services.json`, and enable/configure Play Integrity.
- iOS: use the matching Firebase iOS app and App Attest configuration.
- Ensure `BuildConfig.DEBUG` / `DEBUG` is false so the bridge sends `debugToken: false`.
- Keep Firestore App Check enforcement enabled only after the native providers are verified.

## Sync the updated web assets

The native projects are not in this repository. Copy the updated files into the wrapper's `webDir` (`www` in the existing setup), including:

- `app.js`
- `app-check.mjs`
- `update-popup.js`
- all updated HTML files

Then run:

```sh
npx cap sync android
npx cap sync ios
```

Rebuild and reinstall the native app. Changing Firestore alone does not update an already-installed binary.

## Verify on the device

Expected debug log:

```text
App Check Bridged: native DEBUG provider; register the printed debug token in Firebase Console.
```

Then, with installed Android `2.7.0` and Firestore android `minimumVersion: "2.8.0"`, the dismissible update popup should appear.

If it still does not:

- `403 App attestation failed`: debug token not registered, wrong Firebase app, or release attestation misconfigured.
- `permission-denied`: Firestore read denied or App Check enforcement rejecting the token.
- `Invalid storeUrl`: iOS `storeUrl` must be an official `https://apps.apple.com/.../id...` URL, not `www`.
- No popup after **Later**: the same offer is suppressed for the current WebView session; restart the session or raise the configured version.

See also [the optional update popup guide](update-popup.md).
