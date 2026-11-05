/* Mandatory native-app updates. The browser website is intentionally unaffected.
 * The pure policy helpers and DOM controller are exported for the Node tests;
 * the bootstrap at the bottom runs only in a browser.
 */
(function () {
    'use strict';

    var CONFIG_PATH = ['app_config', 'appVersion'];
    var CHECK_INTERVAL = 60000;
    var REQUEST_TIMEOUT = 10000;

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
            status: compareVersions(installedVersion, policy.minimumVersion) < 0 ? 'required' : 'allowed',
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

    var STYLE = [
        'html[data-owl-update-gate] body { overflow: hidden !important; }',
        'html[data-owl-update-gate] body > :not(#owl-update-gate) { visibility: hidden !important; pointer-events: none !important; }',
        '#owl-update-gate { --gate-bg: var(--ow-bg, #f4f2ef); --gate-surface: var(--ow-surface, #fff); --gate-text: var(--ow-text, #1b1613); --gate-muted: var(--ow-muted, #6f645b); --gate-border: var(--ow-border, #e8e2db); --gate-primary: var(--ow-primary, #7b4a29); position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; align-items: center; overflow-y: auto; overscroll-behavior: contain; padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left)); background: var(--gate-bg); color: var(--gate-text); font: 16px/1.5 system-ui, -apple-system, sans-serif; text-align: center; visibility: visible; pointer-events: auto; }',
        '#owl-update-gate[hidden] { display: none !important; }',
        '#owl-update-gate * { box-sizing: border-box; }',
        '#owl-update-gate .owl-update-card { width: 100%; max-width: 420px; flex-shrink: 0; margin: auto 0; padding: 32px 24px; border: 1px solid var(--gate-border); border-radius: 22px; background: var(--gate-surface); box-shadow: 0 16px 48px rgba(0,0,0,.12); }',
        '#owl-update-gate .owl-update-symbol { display: grid; place-items: center; width: 60px; height: 60px; margin: 0 auto 20px; border-radius: 18px; background: var(--gate-primary); color: #fff; font-size: 34px; font-weight: 700; }',
        '#owl-update-gate h1 { margin: 0 0 12px; color: var(--gate-text); font-family: inherit; font-size: 1.625rem; font-weight: 700; line-height: 1.2; letter-spacing: -.02em; }',
        '#owl-update-gate p { margin: 0 0 16px; color: var(--gate-muted); }',
        '#owl-update-gate .owl-update-versions { font-size: 13px; overflow-wrap: anywhere; }',
        '#owl-update-gate .owl-update-status { min-height: 20px; margin: 8px 0; font-size: 13px; }',
        '#owl-update-gate button { display: block; width: 100%; min-height: 48px; margin-top: 12px; padding: 12px 16px; border: 1px solid var(--gate-border); border-radius: 12px; background: transparent; color: var(--gate-text); font: 600 16px system-ui, -apple-system, sans-serif; cursor: pointer; }',
        '#owl-update-gate .owl-update-store { border-color: var(--gate-primary); background: var(--gate-primary); color: #fff; }',
        '#owl-update-gate button:disabled { opacity: .55; cursor: wait; }',
        '#owl-update-gate button:focus-visible { outline: 3px solid var(--gate-primary); outline-offset: 4px; }',
        '#owl-update-gate [hidden] { display: none !important; }',
        '@media (prefers-color-scheme: dark) { #owl-update-gate { --gate-bg: var(--ow-bg, #0c0b0a); --gate-surface: var(--ow-surface, #171513); --gate-text: var(--ow-text, #f4efe9); --gate-muted: var(--ow-muted, #a3978d); --gate-border: var(--ow-border, #2a2622); --gate-primary: var(--ow-primary, #9a6539); } }'
    ].join('\n');

    function createGate(options) {
        var doc = options.document;
        var win = options.window || doc.defaultView;
        var platform = options.platform;
        var timeoutMs = options.timeoutMs || REQUEST_TIMEOUT;
        var intervalMs = options.checkIntervalMs || CHECK_INTERVAL;
        var active = false;
        var destroyed = false;
        var mounted = false;
        var inFlight = null;
        var interval = null;
        var observer = null;
        var bodyObserver = null;
        var knownPolicy = null;
        var installedVersion = '';
        var lastState = 'checking';
        var originalAttributes = new Map();
        var cleanups = [];

        var style = doc.createElement('style');
        style.id = 'owl-update-gate-style';
        style.textContent = STYLE;
        doc.head.appendChild(style);
        var gate = doc.createElement('section');
        gate.id = 'owl-update-gate';
        gate.setAttribute('role', 'dialog');
        gate.setAttribute('aria-modal', 'true');
        gate.setAttribute('aria-labelledby', 'owl-update-title');
        gate.setAttribute('aria-describedby', 'owl-update-message');
        gate.tabIndex = -1;
        // Constant markup only. Remote messages/version strings use textContent.
        gate.innerHTML = '<div class="owl-update-card"><div class="owl-update-symbol" aria-hidden="true">↑</div><h1 id="owl-update-title"></h1><p id="owl-update-message"></p><p class="owl-update-versions" hidden></p><p class="owl-update-status" role="status" aria-live="polite"></p><button type="button" class="owl-update-store" hidden></button><button type="button" class="owl-update-retry">Try again</button></div>';
        var title = gate.querySelector('h1');
        var message = gate.querySelector('#owl-update-message');
        var versions = gate.querySelector('.owl-update-versions');
        var status = gate.querySelector('.owl-update-status');
        var storeButton = gate.querySelector('.owl-update-store');
        var retryButton = gate.querySelector('.owl-update-retry');

        function listen(target, name, handler, capture) {
            target.addEventListener(name, handler, capture);
            cleanups.push(function () { target.removeEventListener(name, handler, capture); });
        }

        function focusGate() {
            if (!active || !mounted) return;
            var target = !storeButton.hidden ? storeButton : !retryButton.hidden && !retryButton.disabled ? retryButton : gate;
            target.focus({ preventScroll: true });
        }

        function protectChildren() {
            if (!active || !doc.body) return;
            Array.from(doc.body.children).forEach(function (child) {
                if (child === gate || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
                if (!originalAttributes.has(child)) {
                    originalAttributes.set(child, { inert: child.getAttribute('inert'), hidden: child.getAttribute('aria-hidden') });
                }
                child.setAttribute('inert', '');
                child.setAttribute('aria-hidden', 'true');
                child.inert = true;
            });
            if (doc.body.lastElementChild !== gate) doc.body.appendChild(gate);
            if (doc.activeElement !== gate && !gate.contains(doc.activeElement)) focusGate();
        }

        function mount() {
            if (!active || destroyed) return;
            if (!doc.body) {
                // The script runs in <head>, before the parser has created <body>.
                if (!bodyObserver) {
                    bodyObserver = new win.MutationObserver(function () {
                        if (doc.body) { bodyObserver.disconnect(); bodyObserver = null; mount(); }
                    });
                    bodyObserver.observe(doc.documentElement, { childList: true });
                }
                return;
            }
            doc.body.appendChild(gate);
            mounted = true;
            if (!observer) {
                observer = new win.MutationObserver(protectChildren);
                observer.observe(doc.body, { childList: true });
            }
            protectChildren();
        }

        function pauseMedia() {
            if (!active || !doc.body) return;
            doc.body.querySelectorAll('audio, video').forEach(function (media) {
                if (media !== gate && typeof media.pause === 'function') media.pause();
            });
        }

        function setState(state, detail) {
            lastState = state;
            active = state !== 'allowed';
            gate.dataset.state = state;
            gate.hidden = !active;
            if (active) {
                doc.documentElement.setAttribute('data-owl-update-gate', state);
                mount();
                pauseMedia();
            } else {
                doc.documentElement.removeAttribute('data-owl-update-gate');
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
            retryButton.disabled = state === 'checking';
            retryButton.hidden = state === 'checking';
            storeButton.hidden = !active || !knownPolicy;
            versions.hidden = !active || !knownPolicy;
            status.textContent = state === 'checking' ? 'Checking for updates…' : '';
            if (state === 'checking') {
                title.textContent = 'Checking for updates';
                message.textContent = 'Please wait while we verify your app version.';
            } else if (state === 'required') {
                title.textContent = 'Update required';
                message.textContent = knownPolicy.message || 'A new version of Owl Watcher is required. Please update to continue using the app.';
            } else if (state === 'error') {
                title.textContent = 'Update check unavailable';
                message.textContent = detail || 'Connect to the internet and try again. The app will unlock after its version has been verified.';
            }
            if (knownPolicy) {
                storeButton.textContent = platform === 'ios' ? 'Update on the App Store' : 'Update on Google Play';
                versions.textContent = 'Installed: ' + (parseVersion(installedVersion) ? installedVersion : 'unavailable') +
                    ' · Required: ' + knownPolicy.minimumVersion;
            }
            if (active) focusGate();
        }

        function guardEvent(event) {
            if (!active || gate.contains(event.target)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.type === 'focusin') focusGate();
        }

        function keyHandler(event) {
            if (!active) return;
            if (!gate.contains(event.target) || event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                focusGate();
                return;
            }
            if (event.key !== 'Tab') return;
            var buttons = Array.from(gate.querySelectorAll('button')).filter(function (button) { return !button.hidden && !button.disabled; });
            if (!buttons.length) { event.preventDefault(); gate.focus(); return; }
            var first = buttons[0];
            var last = buttons[buttons.length - 1];
            if (event.shiftKey && (doc.activeElement === first || doc.activeElement === gate)) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (doc.activeElement === last || doc.activeElement === gate)) {
                event.preventDefault(); first.focus();
            }
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

        function check(checkOptions) {
            if (destroyed) return Promise.resolve('destroyed');
            var background = Boolean(checkOptions && checkOptions.background);
            if (inFlight) {
                if (!active && !background) setState('checking');
                return inFlight;
            }
            mount();
            if (!active && !background) setState('checking');
            else if (active) { status.textContent = 'Checking for updates…'; retryButton.disabled = true; }
            inFlight = Promise.allSettled([
                timeout(Promise.resolve().then(options.loadPolicy), timeoutMs),
                timeout(Promise.resolve().then(options.getInstalledVersion), timeoutMs)
            ]).then(function (results) {
                if (destroyed) return 'destroyed';
                // Retain the last store URL for the error screen, but NEVER authorize from a cached policy.
                if (results[0].status === 'rejected') {
                    setState('error');
                    return 'error';
                }
                try {
                    var policy = validatePolicy(results[0].value, platform);
                    var version = results[1].status === 'fulfilled' ? results[1].value : '';
                    knownPolicy = policy;
                    installedVersion = version;
                    var result = evaluateVersion(policy, version);
                    setState(result.status);
                    return result.status;
                } catch (error) {
                    setState('error', 'The update information could not be verified. Please try again later.');
                    return 'error';
                }
            }).catch(function () {
                if (!destroyed) setState('error');
                return 'error';
            }).finally(function () { inFlight = null; });
            return inFlight;
        }

        function retry() {
            if (!active || destroyed) return Promise.resolve(lastState);
            return check();
        }

        function openStore() {
            if (!active || !knownPolicy || !options.openStore) return Promise.resolve();
            storeButton.disabled = true;
            return Promise.resolve().then(function () { return options.openStore(knownPolicy.storeUrl); })
                .catch(function () { status.textContent = 'Could not open the store. Please open it manually and install the update.'; })
                .finally(function () { storeButton.disabled = false; });
        }

        function resume() {
            if (!destroyed && win.document.visibilityState !== 'hidden') check();
        }

        var started = false;
        function start() {
            if (destroyed || started) return inFlight || Promise.resolve(lastState);
            started = true;
            ['pointerdown', 'mousedown', 'touchstart', 'click', 'submit', 'contextmenu', 'wheel', 'focusin'].forEach(function (name) {
                listen(doc, name, guardEvent, { capture: true, passive: false });
            });
            listen(doc, 'keydown', keyHandler, true);
            listen(doc, 'play', function (event) {
                if (active && !gate.contains(event.target)) { event.target.pause(); event.stopImmediatePropagation(); }
            }, true);
            listen(win, 'pageshow', resume);
            listen(win, 'focus', resume);
            listen(win, 'online', resume);
            listen(win.document, 'visibilitychange', function () {
                if (win.document.visibilityState === 'visible') resume();
            });
            listen(retryButton, 'click', retry);
            listen(storeButton, 'click', openStore);
            setState('checking');
            interval = win.setInterval(function () {
                // Background checks don't flash a loading screen over an already verified session.
                if (win.document.visibilityState !== 'hidden') check({ background: !active });
            }, intervalMs);
            return check();
        }

        function destroy() {
            destroyed = true;
            active = false;
            if (interval !== null) win.clearInterval(interval);
            if (observer) observer.disconnect();
            if (bodyObserver) bodyObserver.disconnect();
            cleanups.forEach(function (cleanup) { cleanup(); });
            doc.documentElement.removeAttribute('data-owl-update-gate');
            originalAttributes.forEach(function (original, child) {
                if (original.inert === null) child.removeAttribute('inert'); else child.setAttribute('inert', original.inert);
                if (original.hidden === null) child.removeAttribute('aria-hidden'); else child.setAttribute('aria-hidden', original.hidden);
            });
            originalAttributes.clear();
            gate.remove(); style.remove();
        }

        return { start: start, check: check, retry: retry, openStore: openStore, destroy: destroy,
            getState: function () { return lastState; }, isActive: function () { return active; } };
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
                    return { sdk: sdk, ref: sdk.doc.apply(null, [modules[0].db].concat(CONFIG_PATH)) };
                });
                clientPromise = pending;
                pending.catch(function () { if (clientPromise === pending) clientPromise = null; });
            }
            return clientPromise;
        }
        return function loadPolicy() {
            // Cache only the SDK/client, never a successful version check or document snapshot.
            return client().then(function (firestore) {
                return firestore.sdk.getDocFromServer(firestore.ref).then(function (snapshot) {
                    if (!snapshot.exists()) throw new Error('The app version policy has not been configured.');
                    return snapshot.data();
                });
            });
        };
    }

    function startNativeGate(win, importModule) {
        var platform = getNativePlatform(win);
        if (!platform) return null;
        var capacitor = win.Capacitor;
        var appPlugin = capacitor && capacitor.Plugins && capacitor.Plugins.App;
        var loadPolicy = createFirestorePolicyLoader(importModule);
        var gate = createGate({
            document: win.document,
            window: win,
            platform: platform,
            // Never substitute package.json, a URL parameter or localStorage for the binary's version.
            getInstalledVersion: function () {
                if (!appPlugin || typeof appPlugin.getInfo !== 'function') return Promise.reject(new Error('Capacitor App plugin is missing.'));
                return Promise.resolve(appPlugin.getInfo()).then(function (info) { return info.version; });
            },
            loadPolicy: loadPolicy,
            openStore: function (url) {
                var browser = capacitor && capacitor.Plugins && capacitor.Plugins.Browser;
                if (browser && typeof browser.open === 'function') return browser.open({ url: url });
                // Native Browser plugin is strongly recommended; this fallback keeps the gate locked on failure.
                var opened = win.open(url, '_blank');
                if (opened) opened.opener = null;
                else throw new Error('Store navigation was blocked.');
            }
        });
        gate.start();
        if (appPlugin && typeof appPlugin.addListener === 'function') {
            Promise.resolve(appPlugin.addListener('appStateChange', function (state) {
                if (state.isActive) gate.check();
            })).catch(function () {});
            Promise.resolve(appPlugin.addListener('backButton', function () {
                // Consume Android Back while locked; there is no dismiss/skip action.
                if (gate.isActive()) return;
                if (win.history.length > 1) win.history.back();
                else if (typeof appPlugin.minimizeApp === 'function') appPlugin.minimizeApp().catch(function () {});
            })).catch(function () {});
        }
        return gate;
    }

    var api = { parseVersion: parseVersion, compareVersions: compareVersions, validStoreUrl: validStoreUrl,
        validatePolicy: validatePolicy, evaluateVersion: evaluateVersion, getNativePlatform: getNativePlatform,
        createGate: createGate, createFirestorePolicyLoader: createFirestorePolicyLoader, startNativeGate: startNativeGate };
    if (typeof module === 'object' && module.exports) { module.exports = api; return; }
    window.OwlVersionGate = api;
    startNativeGate(window, function (url) { return import(url); });
})();
