/* Optional native-app update prompt. The browser website is intentionally unaffected.
 * Checks are non-blocking: failures hide the prompt and never prevent app use.
 * Pure helpers and the DOM controller are exported for Node tests.
 */
(function () {
    'use strict';

    var CONFIG_PATH = ['app_config', 'appVersion'];
    var CHECK_INTERVAL = 60000;
    var REQUEST_TIMEOUT = 10000;
    var DISMISSAL_KEY_PREFIX = 'owl-update-popup:dismissed:';

    function parseVersion(value) {
        if (typeof value !== 'string' || value.length > 64 || !/^\d+\.\d+\.\d+$/.test(value)) return null;
        var parts = value.split('.').map(Number);
        return parts.every(Number.isSafeInteger) ? parts : null;
    }

    function compareVersions(left, right) {
        var a = parseVersion(left);
        var b = parseVersion(right);
        if (!a || !b) throw new Error('Versions must use three numeric parts, for example 1.2.3.');
        for (var i = 0; i < 3; i++) {
            if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
        }
        return 0;
    }

    function validStoreUrl(value, platform) {
        if (typeof value !== 'string' || !value.trim()) return false;
        try {
            var url = new URL(value);
            if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
            if (platform === 'android') {
                return url.hostname === 'play.google.com' && url.pathname === '/store/apps/details' &&
                    /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(url.searchParams.get('id') || '');
            }
            return platform === 'ios' && url.hostname === 'apps.apple.com' && /\/id\d+(?:\/|$)/.test(url.pathname);
        } catch (_) {
            return false;
        }
    }

    function validatePolicy(data, platform) {
        if (!data || (platform !== 'android' && platform !== 'ios')) throw new Error('Invalid platform policy.');
        var entry = data[platform];
        if (!entry || !parseVersion(entry.minimumVersion)) throw new Error('Invalid minimumVersion.');
        if (!validStoreUrl(entry.storeUrl, platform)) throw new Error('Invalid storeUrl.');
        if (data.message !== undefined && (typeof data.message !== 'string' || data.message.length > 500)) {
            throw new Error('Invalid update message.');
        }
        return Object.freeze({
            platform: platform,
            minimumVersion: entry.minimumVersion,
            storeUrl: entry.storeUrl,
            message: data.message || ''
        });
    }

    function evaluateVersion(policy, installedVersion) {
        if (!parseVersion(installedVersion)) throw new Error('The installed app version is unavailable.');
        return {
            status: compareVersions(installedVersion, policy.minimumVersion) < 0 ? 'available' : 'current',
            installedVersion: installedVersion
        };
    }

    function getNativePlatform(win) {
        var capacitor = win.Capacitor;
        var flag = capacitor && capacitor.isNativePlatform;
        var native = typeof flag === 'function' ? flag.call(capacitor) : flag === true || Boolean(capacitor && capacitor.isNative === true);
        // Capacitor's default iOS scheme also identifies native when the bridge is late.
        // Do NOT classify ordinary http://localhost development as native.
        if (!native && win.location.protocol !== 'capacitor:') return null;
        var platform = capacitor && (typeof capacitor.getPlatform === 'function' ? capacitor.getPlatform() : capacitor.platform);
        return platform === 'android' || platform === 'ios' ? platform : 'unknown';
    }

    var STYLE = `
html[data-owl-update-popup] body { overflow: hidden !important; }
#owl-update-popup { --popup-surface: var(--ow-surface, #fff); --popup-text: var(--ow-text, #1b1613); --popup-muted: var(--ow-muted, #6f645b); --popup-border: var(--ow-border, #e8e2db); --popup-primary: var(--ow-primary, #7b4a29); position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; overflow-y: auto; padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); background: rgba(0, 0, 0, .45); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); color: var(--popup-text); font: 16px/1.5 system-ui, -apple-system, sans-serif; text-align: center; }
#owl-update-popup[hidden] { display: none !important; }
#owl-update-popup * { box-sizing: border-box; }
#owl-update-popup .owl-update-card { position: relative; width: 100%; max-width: 420px; margin: auto 0; padding: 32px 24px 24px; border: 1px solid var(--popup-border); border-radius: 22px; background: var(--popup-surface); box-shadow: 0 16px 48px rgba(0, 0, 0, .24); }
#owl-update-popup .owl-update-close { position: absolute; top: 10px; right: 10px; width: 36px; height: 36px; min-height: 0; margin: 0; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--popup-muted); font-size: 24px; line-height: 1; }
#owl-update-popup .owl-update-symbol { display: grid; place-items: center; width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 18px; background: var(--popup-primary); color: #fff; font-size: 30px; font-weight: 700; }
#owl-update-popup h2 { margin: 0 0 10px; color: var(--popup-text); font-size: 1.5rem; font-weight: 700; line-height: 1.2; letter-spacing: -.02em; }
#owl-update-popup p { margin: 0 0 14px; color: var(--popup-muted); }
#owl-update-popup .owl-update-versions { font-size: 13px; overflow-wrap: anywhere; }
#owl-update-popup .owl-update-status { min-height: 0; margin: 0; font-size: 13px; }
#owl-update-popup .owl-update-status:empty { display: none; }
#owl-update-popup button { display: block; width: 100%; min-height: 48px; margin-top: 12px; padding: 12px 16px; border: 1px solid var(--popup-border); border-radius: 12px; background: transparent; color: var(--popup-text); font: 600 16px system-ui, -apple-system, sans-serif; cursor: pointer; }
#owl-update-popup .owl-update-store { border-color: var(--popup-primary); background: var(--popup-primary); color: #fff; }
#owl-update-popup button:disabled { opacity: .55; cursor: wait; }
#owl-update-popup button:focus-visible { outline: 3px solid var(--popup-primary); outline-offset: 3px; }
@media (prefers-color-scheme: dark) { #owl-update-popup { --popup-surface: var(--ow-surface, #171513); --popup-text: var(--ow-text, #f4efe9); --popup-muted: var(--ow-muted, #a3978d); --popup-border: var(--ow-border, #2a2622); --popup-primary: var(--ow-primary, #9a6539); } }
`;

    function createUpdatePrompt(options) {
        var doc = options.document;
        var win = options.window || doc.defaultView;
        var platform = options.platform;
        var timeoutMs = options.timeoutMs || REQUEST_TIMEOUT;
        var intervalMs = options.checkIntervalMs || CHECK_INTERVAL;
        var visible = false;
        var destroyed = false;
        var started = false;
        var openingStore = false;
        var inFlight = null;
        var interval = null;
        var observer = null;
        var bodyObserver = null;
        var offer = null;
        var lastState = 'idle';
        var lastFocus = null;
        var memoryDismissal = '';
        var originalAttributes = new Map();
        var cleanups = [];

        var style = doc.createElement('style');
        style.id = 'owl-update-popup-style';
        style.textContent = STYLE;
        doc.head.appendChild(style);

        var popup = doc.createElement('div');
        popup.id = 'owl-update-popup';
        popup.hidden = true;
        // Constant markup only. Remote messages/version strings use textContent.
        popup.innerHTML = '<div class="owl-update-card" role="dialog" aria-modal="true" aria-labelledby="owl-update-title" aria-describedby="owl-update-message" tabindex="-1"><button type="button" class="owl-update-close" aria-label="Close update prompt">×</button><div class="owl-update-symbol" aria-hidden="true">↑</div><h2 id="owl-update-title">Update available</h2><p id="owl-update-message"></p><p class="owl-update-versions"></p><p class="owl-update-status" role="status" aria-live="polite"></p><button type="button" class="owl-update-store">Update Now</button><button type="button" class="owl-update-later">Later</button></div>';
        var card = popup.querySelector('.owl-update-card');
        var message = popup.querySelector('#owl-update-message');
        var versions = popup.querySelector('.owl-update-versions');
        var status = popup.querySelector('.owl-update-status');
        var closeButton = popup.querySelector('.owl-update-close');
        var storeButton = popup.querySelector('.owl-update-store');
        var laterButton = popup.querySelector('.owl-update-later');

        function listen(target, name, handler, capture) {
            target.addEventListener(name, handler, capture);
            cleanups.push(function () { target.removeEventListener(name, handler, capture); });
        }

        function dismissalKey() {
            return DISMISSAL_KEY_PREFIX + platform;
        }

        function readDismissal() {
            try {
                return win.sessionStorage.getItem(dismissalKey()) || memoryDismissal;
            } catch (_) {
                return memoryDismissal;
            }
        }

        function rememberDismissal() {
            if (!offer) return;
            memoryDismissal = offer.key;
            try {
                win.sessionStorage.setItem(dismissalKey(), offer.key);
            } catch (_) {
                // Private/embedded contexts may deny storage; keep dismissing for this page session.
            }
        }

        function focusPopup() {
            if (!visible || !popup.isConnected) return;
            storeButton.focus({ preventScroll: true });
        }

        function protectChildren() {
            if (!visible || !doc.body) return;
            Array.from(doc.body.children).forEach(function (child) {
                if (child === popup || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
                if (!originalAttributes.has(child)) {
                    originalAttributes.set(child, { inert: child.getAttribute('inert'), hidden: child.getAttribute('aria-hidden') });
                }
                child.setAttribute('inert', '');
                child.setAttribute('aria-hidden', 'true');
                child.inert = true;
            });
            if (doc.body.lastElementChild !== popup) doc.body.appendChild(popup);
        }

        function mount() {
            if (!visible || destroyed) return;
            if (!doc.body) {
                if (!bodyObserver) {
                    bodyObserver = new win.MutationObserver(function () {
                        if (doc.body) { bodyObserver.disconnect(); bodyObserver = null; mount(); }
                    });
                    bodyObserver.observe(doc.documentElement, { childList: true });
                }
                return;
            }
            doc.body.appendChild(popup);
            if (!observer) {
                observer = new win.MutationObserver(protectChildren);
                observer.observe(doc.body, { childList: true });
            }
            protectChildren();
        }

        function restoreChildren() {
            if (observer) { observer.disconnect(); observer = null; }
            originalAttributes.forEach(function (original, child) {
                if (!child.isConnected) return;
                if (original.inert === null) { child.removeAttribute('inert'); child.inert = false; }
                else child.setAttribute('inert', original.inert);
                if (original.hidden === null) child.removeAttribute('aria-hidden');
                else child.setAttribute('aria-hidden', original.hidden);
            });
            originalAttributes.clear();
        }

        function show() {
            if (destroyed || !offer) return;
            message.textContent = offer.policy.message || 'A newer version of Owl Watcher is available. You can update now or continue using the app.';
            versions.textContent = 'Installed: ' + offer.installedVersion + ' · Available: ' + offer.policy.minimumVersion;
            storeButton.textContent = platform === 'ios' ? 'Update on the App Store' : 'Update on Google Play';
            if (visible) return;
            lastFocus = doc.activeElement;
            visible = true;
            popup.hidden = false;
            popup.dataset.state = 'available';
            status.textContent = '';
            doc.documentElement.setAttribute('data-owl-update-popup', '');
            mount();
            focusPopup();
        }

        function hide() {
            if (!visible) return;
            visible = false;
            popup.hidden = true;
            doc.documentElement.removeAttribute('data-owl-update-popup');
            restoreChildren();
            if (lastFocus && lastFocus.isConnected && (popup.contains(doc.activeElement) || doc.activeElement === doc.body)) {
                lastFocus.focus({ preventScroll: true });
            }
            lastFocus = null;
        }

        function dismiss() {
            if (!visible || destroyed) return;
            rememberDismissal();
            lastState = 'dismissed';
            hide();
        }

        function timeout(promise, ms) {
            return new Promise(function (resolve, reject) {
                var timer = win.setTimeout(function () { reject(new Error('Update check timed out.')); }, ms);
                Promise.resolve(promise).then(function (value) {
                    win.clearTimeout(timer); resolve(value);
                }, function (error) {
                    win.clearTimeout(timer); reject(error);
                });
            });
        }

        function failOpen(error) {
            lastState = 'unavailable';
            offer = null;
            hide();
            if (win.console && typeof win.console.warn === 'function') {
                var detail = error && error.message ? error.message : error;
                if (error && error.code) detail = error.code + ': ' + detail;
                win.console.warn('[update-popup] Check skipped:', detail);
            }
            return 'unavailable';
        }

        function check() {
            if (destroyed) return Promise.resolve('destroyed');
            if (inFlight) return inFlight;
            lastState = 'checking';
            inFlight = Promise.allSettled([
                timeout(Promise.resolve().then(options.loadPolicy), timeoutMs),
                timeout(Promise.resolve().then(options.getInstalledVersion), timeoutMs)
            ]).then(function (results) {
                if (destroyed) return 'destroyed';
                if (results[0].status === 'rejected') return failOpen(results[0].reason);
                if (results[1].status === 'rejected') return failOpen(results[1].reason);
                try {
                    var policy = validatePolicy(results[0].value, platform);
                    var installedVersion = results[1].value;
                    var result = evaluateVersion(policy, installedVersion);
                    if (result.status === 'current') {
                        offer = null;
                        lastState = 'current';
                        hide();
                        return 'current';
                    }
                    offer = { policy: policy, installedVersion: installedVersion, key: policy.minimumVersion + '|' + installedVersion };
                    if (readDismissal() === offer.key) {
                        lastState = 'dismissed';
                        hide();
                        return 'dismissed';
                    }
                    lastState = 'available';
                    show();
                    return 'available';
                } catch (error) {
                    return failOpen(error);
                }
            }).catch(failOpen).finally(function () { inFlight = null; });
            return inFlight;
        }

        function openStore() {
            if (!visible || !offer || openingStore || !options.openStore) return Promise.resolve();
            openingStore = true;
            storeButton.disabled = true;
            status.textContent = '';
            var url = offer.policy.storeUrl;
            return Promise.resolve().then(function () { return options.openStore(url); })
                .catch(function () {
                    if (!destroyed && visible) status.textContent = 'Could not open the store. Please try again or choose Later.';
                })
                .finally(function () {
                    openingStore = false;
                    storeButton.disabled = false;
                });
        }

        function keyHandler(event) {
            if (!visible) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                dismiss();
                return;
            }
            if (event.key !== 'Tab') return;
            var buttons = Array.from(popup.querySelectorAll('button')).filter(function (button) { return !button.disabled && !button.hidden; });
            var first = buttons[0];
            var last = buttons[buttons.length - 1];
            if (!popup.contains(doc.activeElement)) {
                event.preventDefault(); first.focus();
            } else if (event.shiftKey && (doc.activeElement === first || doc.activeElement === card)) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (doc.activeElement === last || doc.activeElement === card)) {
                event.preventDefault(); first.focus();
            }
        }

        function resume() {
            if (!destroyed && win.document.visibilityState !== 'hidden') check();
        }

        function start() {
            if (destroyed || started) return inFlight || Promise.resolve(lastState);
            started = true;
            listen(doc, 'keydown', keyHandler, true);
            listen(popup, 'click', function (event) { if (event.target === popup) dismiss(); });
            listen(closeButton, 'click', dismiss);
            listen(laterButton, 'click', dismiss);
            listen(storeButton, 'click', openStore);
            listen(win, 'pageshow', resume);
            listen(win, 'focus', resume);
            listen(win, 'online', resume);
            listen(win.document, 'visibilitychange', function () {
                if (win.document.visibilityState === 'visible') resume();
            });
            interval = win.setInterval(function () {
                if (win.document.visibilityState !== 'hidden') check();
            }, intervalMs);
            return check();
        }

        function destroy() {
            destroyed = true;
            hide();
            if (interval !== null) win.clearInterval(interval);
            if (bodyObserver) bodyObserver.disconnect();
            cleanups.forEach(function (cleanup) { cleanup(); });
            popup.remove();
            style.remove();
        }

        return {
            start: start, check: check, dismiss: dismiss, openStore: openStore, destroy: destroy,
            getState: function () { return lastState; },
            isVisible: function () { return visible; }
        };
    }

    function createFirestorePolicyLoader(importModule) {
        var clientPromise;
        function client() {
            if (!clientPromise) {
                var pending = Promise.all([
                    importModule('./app.js'),
                    importModule('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js')
                ]).then(function (modules) {
                    // Reuse the existing Firebase app and its native App Check bridge.
                    var sdk = modules[1];
                    return {
                        sdk: sdk,
                        ref: sdk.doc.apply(null, [modules[0].db].concat(CONFIG_PATH)),
                        appCheckReady: modules[0].appCheckReady
                    };
                });
                clientPromise = pending;
                pending.catch(function () { if (clientPromise === pending) clientPromise = null; });
            }
            return clientPromise;
        }
        return function loadPolicy() {
            return client().then(function (firestore) {
                // Wait for native App Check initialization before the first Firestore token request.
                return Promise.resolve(firestore.appCheckReady).then(function () {
                    return firestore.sdk.getDocFromServer(firestore.ref);
                }).then(function (snapshot) {
                    if (!snapshot.exists()) throw new Error('The app version policy has not been configured.');
                    return snapshot.data();
                });
            });
        };
    }

    function startNativeUpdatePrompt(win, importModule) {
        var platform = getNativePlatform(win);
        if (!platform) return null;
        var capacitor = win.Capacitor;
        var appPlugin = capacitor && capacitor.Plugins && capacitor.Plugins.App;
        var prompt = createUpdatePrompt({
            document: win.document,
            window: win,
            platform: platform,
            // Never substitute package.json, a URL parameter or localStorage for the binary's version.
            getInstalledVersion: function () {
                if (!appPlugin || typeof appPlugin.getInfo !== 'function') return Promise.reject(new Error('Capacitor App plugin is missing.'));
                return Promise.resolve(appPlugin.getInfo()).then(function (info) { return info.version; });
            },
            loadPolicy: createFirestorePolicyLoader(importModule),
            openStore: function (url) {
                var browser = capacitor && capacitor.Plugins && capacitor.Plugins.Browser;
                if (browser && typeof browser.open === 'function') return browser.open({ url: url });
                var opened = win.open(url, '_blank');
                if (opened) opened.opener = null;
                else throw new Error('Store navigation was blocked.');
            }
        });
        prompt.start();
        if (appPlugin && typeof appPlugin.addListener === 'function') {
            Promise.resolve(appPlugin.addListener('appStateChange', function (state) {
                if (state.isActive) prompt.check();
            })).catch(function () {});
            Promise.resolve(appPlugin.addListener('backButton', function () {
                if (prompt.isVisible()) { prompt.dismiss(); return; }
                if (win.history.length > 1) win.history.back();
                else if (typeof appPlugin.minimizeApp === 'function') appPlugin.minimizeApp().catch(function () {});
            })).catch(function () {});
        }
        return prompt;
    }

    var api = {
        parseVersion: parseVersion, compareVersions: compareVersions, validStoreUrl: validStoreUrl,
        validatePolicy: validatePolicy, evaluateVersion: evaluateVersion, getNativePlatform: getNativePlatform,
        createUpdatePrompt: createUpdatePrompt, createFirestorePolicyLoader: createFirestorePolicyLoader,
        startNativeUpdatePrompt: startNativeUpdatePrompt
    };
    if (typeof module === 'object' && module.exports) { module.exports = api; return; }
    window.OwlUpdatePrompt = api;
    startNativeUpdatePrompt(window, function (url) { return import(url); });
})();
