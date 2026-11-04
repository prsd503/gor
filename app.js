import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider, CustomProvider, getToken } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";

const firebaseConfig = {
  apiKey: "AIzaSyBEYKHQpy_VjmgjYIwQOPjXth1bghYsf9M",
  authDomain: "finder-owl.firebaseapp.com", 
  projectId: "finder-owl",
  storageBucket: "finder-owl.firebasestorage.app",
  messagingSenderId: "1011347100861",
  appId: "1:1011347100861:web:24246f9a4eb24d812cd3d4"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

const isNativeApp = window.location.href.includes("capacitor://") || window.Capacitor?.isNativePlatform();

let appCheckInstance;

/**
 * BRIDGING LOGIC:
 * This ensures that when the Firebase JS SDK (Auth/Firestore) needs a token,
 * it correctly asks the Native Capacitor Plugin for the Play Integrity token.
 */
if (isNativeApp) {
  const FirebaseAppCheckPlugin = window.Capacitor?.Plugins?.FirebaseAppCheck;

  if (FirebaseAppCheckPlugin) {
    // Check if we are in a debug environment via the NativeConfig bridge
    const isDebugMode = window.NativeConfig?.isDebug() || false;

    // 1. Initialize the native side first
    FirebaseAppCheckPlugin.initialize({
      provider: 'playIntegrity',
      debugToken: isDebugMode, // Dynamically enable debug token ONLY in debug builds
      isTokenAutoRefreshEnabled: true,
    }).catch(err => {
      console.error("Native App Check Init Error:", err);
      if (isDebugMode && err.message?.includes("Too many attempts")) {
        console.error("DEBUG TIP: App Check is rate-limited. Register your debug token (found in Logcat under DebugAppCheckProvider) in Firebase Console.");
      }
    });

    // 2. Wrap the native plugin in a CustomProvider for the JS SDK
    const provider = new CustomProvider({
      getToken: async () => {
        try {
          const result = await FirebaseAppCheckPlugin.getToken();
          return {
            token: result.token,
            expireTimeMillis: Date.now() + (30 * 60 * 1000) // Estimate 30 mins
          };
        } catch (err) {
          console.error("CustomProvider failed to get native token. Full error details:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
          // This usually happens if the device is not certified or the SHA-256 is missing in Firebase Console
          throw err;
        }
      }
    });

    appCheckInstance = initializeAppCheck(app, {
      provider,
      isTokenAutoRefreshEnabled: true
    });
    console.log("App Check Bridged: JS SDK will now use Native Play Integrity tokens.");
  } else {
    console.warn("FirebaseAppCheck plugin missing. App Check will not work on native.");
  }
} else {
  // Web fallback (Standard reCAPTCHA)
  appCheckInstance = initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider('6LfyzGwtAAAAAPj_AmQ3jjFhjuyYa5P8fxrxTGFI'),
    isTokenAutoRefreshEnabled: true
  });
}

/**
 * SECURE FETCH HELPER:
 * For your own backend API calls (e.g. searching vehicles)
 */
export async function authenticatedFetch(url, options = {}) {
  const headers = options.headers || {};
  headers['ngrok-skip-browser-warning'] = 'true';

  try {
    const currentUser = auth.currentUser;
    if (currentUser) {
      const idToken = await currentUser.getIdToken();
      headers['Authorization'] = `Bearer ${idToken}`;
    }
  } catch (err) {
    console.error("Error getting Auth token:", err);
  }

  try {
    if (appCheckInstance) {
      const result = await getToken(appCheckInstance, false);
      if (result && result.token) {
        headers['X-Firebase-AppCheck'] = result.token;
      }
    }
  } catch (err) {
    console.warn("App Check token acquisition failed for fetch:", err);
  }

  if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(url, { ...options, headers });
}
