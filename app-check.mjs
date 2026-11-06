/* Native Firebase App Check bridge helpers.
 * Kept separate from app.js so the debug/release decision and token ordering can be tested in Node.
 * Debug mode is enabled only by an explicit native signal; never by URL, user agent, localhost, or storage.
 */

export function detectNativeDebugBuild(win) {
    if (!win || typeof win !== 'object') return false;

    function read(candidate) {
        try {
            if (typeof candidate === 'function') return candidate() === true;
            return candidate === true;
        } catch (_) {
            return false;
        }
    }

    var nativeConfig = win.NativeConfig;
    if (nativeConfig && read(nativeConfig.isDebug)) return true;
    if (nativeConfig && read(nativeConfig.debug)) return true;

    var capacitor = win.Capacitor;
    var plugin = capacitor && capacitor.Plugins && capacitor.Plugins.NativeConfig;
    if (plugin && read(plugin.isDebug)) return true;

    if (win.__OWL_NATIVE_DEBUG__ === true) return true;
    return false;
}

export function createNativeAppCheckBridge(options) {
    var app = options.app;
    var plugin = options.plugin;
    var initializeAppCheck = options.initializeAppCheck;
    var CustomProvider = options.CustomProvider;
    var debug = options.debug === true;
    var logger = options.logger || console;
    var now = typeof options.now === 'function' ? options.now : Date.now;

    if (!plugin || typeof plugin.initialize !== 'function' || typeof plugin.getToken !== 'function') {
        throw new Error('FirebaseAppCheck native plugin is missing initialize/getToken.');
    }
    if (typeof initializeAppCheck !== 'function' || typeof CustomProvider !== 'function') {
        throw new Error('Firebase App Check SDK helpers are required.');
    }

    var initializationError = null;
    // Resolve (rather than reject) after logging so background SDK startup does not create an unhandled rejection.
    var ready = Promise.resolve()
        .then(function () {
            // The Capacitor Firebase plugin selects the native provider from debugToken.
            // `provider` is a web-only option, so do not send the old 'playIntegrity' string here.
            return plugin.initialize({
                debugToken: debug,
                isTokenAutoRefreshEnabled: true
            });
        })
        .then(function () { return true; })
        .catch(function (error) {
            initializationError = error;
            if (logger && typeof logger.error === 'function') {
                logger.error('Native App Check Init Error:', error);
                if (debug && /too many attempts/i.test(String(error && error.message || ''))) {
                    logger.error('DEBUG TIP: App Check is rate-limited. Register the debug token printed by DebugAppCheckProvider in Firebase Console.');
                }
            }
            return false;
        });

    var provider = new CustomProvider({
        getToken: async function () {
            await ready;
            if (initializationError) throw initializationError;
            try {
                var result = await plugin.getToken({ forceRefresh: false });
                if (!result || typeof result.token !== 'string' || !result.token) {
                    throw new Error('Native App Check returned an empty token.');
                }
                var expireTimeMillis = Number.isFinite(result.expireTimeMillis)
                    ? result.expireTimeMillis
                    : now() + 30 * 60 * 1000;
                return { token: result.token, expireTimeMillis: expireTimeMillis };
            } catch (error) {
                if (logger && typeof logger.error === 'function') {
                    logger.error('CustomProvider failed to get native token:', error);
                    if (/attestation failed|403/i.test(String(error && error.message || ''))) {
                        logger.error(debug
                            ? 'DEBUG TIP: Register this build\'s App Check debug token in Firebase Console, then restart the app.'
                            : 'RELEASE TIP: Verify Play Integrity/App Attest setup, Firebase app registration, and signing SHA-256 certificates.');
                    }
                }
                throw error;
            }
        }
    });

    var appCheckInstance = initializeAppCheck(app, {
        provider: provider,
        isTokenAutoRefreshEnabled: true
    });

    return { appCheckInstance: appCheckInstance, ready: ready, isDebug: debug };
}
