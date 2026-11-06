import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider, CustomProvider, getToken } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
import { createNativeAppCheckBridge, detectNativeDebugBuild } from "./app-check.mjs";

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
export let appCheckDebug = false;
export let appCheckReady = Promise.resolve(false);

/**
 * BRIDGING LOGIC:
 * The JS SDK asks the native Capacitor plugin for App Check tokens. Native initialization
 * must finish before the first token request, and debug mode must come from the native
 * binary (BuildConfig.DEBUG / DEBUG), never from a URL or browser heuristic.
 */
if (isNativeApp) {
  const FirebaseAppCheckPlugin = window.Capacitor?.Plugins?.FirebaseAppCheck;

  if (FirebaseAppCheckPlugin) {
    appCheckDebug = detectNativeDebugBuild(window);
    const bridge = createNativeAppCheckBridge({
      app,
      plugin: FirebaseAppCheckPlugin,
      initializeAppCheck,
      CustomProvider,
      debug: appCheckDebug,
      logger: console
    });
    appCheckInstance = bridge.appCheckInstance;
    appCheckReady = bridge.ready;
    console.log(
      appCheckDebug
        ? "App Check Bridged: native DEBUG provider; register the printed debug token in Firebase Console."
        : "App Check Bridged: native attestation provider (Play Integrity/App Attest)."
    );
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
