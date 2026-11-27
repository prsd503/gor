/* API endpoint selection and automatic failover.
 *
 * All pages load this before application scripts. It rewrites API URLs to
 * the configured active base, preserves non-API fetches, and remembers drains
 * for the Retry-After cooldown. Only GET/HEAD retry ambiguous failures; writes
 * retry only explicit pre-handler drains. All targets must be preconfigured
 * trusted bases, including any ?api= page override.
 */
(function (global) {
    'use strict';

    var LEGACY_BASES = ['https://api.owlwatcher.tech/api'];
    // Last resort when a page's api-env.js is missing or invalid: the
    // permanent custom domain, keeping the stable frontend contract even if
    // the backend moves to another cloud provider.
    var DEFAULT_BASE = 'https://api.owlwatcher.tech/api';
    var ACTIVE_KEY = 'owl:api:active';
    var DRAINED_KEY = 'owl:api:drained';
    var DRAIN_COOLDOWN_MS = 10 * 60 * 1000;
    var DEFAULT_TIMEOUT_MS = 15000;
    var RETRY_STATUS = [502, 503, 504];
    var SAFE_BODY_TYPES = ['[object String]', '[object URLSearchParams]', '[object FormData]', '[object Blob]', '[object ArrayBuffer]'];

    function trimSlashes(value) {
        return String(value || '').replace(/\/+$/, '');
    }

    /* Accept only absolute http(s) bases with no credentials. */
    function validBase(value) {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            var url = new URL(value.trim());
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
            if (url.username || url.password) return null;
            return trimSlashes(url.origin + url.pathname);
        } catch (error) {
            return null;
        }
    }

    function storageGet(key) {
        try { return global.localStorage ? global.localStorage.getItem(key) : null; } catch (error) { return null; }
    }

    function storageSet(key, value) {
        try { if (global.localStorage) global.localStorage.setItem(key, value); } catch (error) { /* private mode */ }
    }

    function storageRemove(key) {
        try { if (global.localStorage) global.localStorage.removeItem(key); } catch (error) { /* private mode */ }
    }

    function readJson(key) {
        var raw = storageGet(key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (error) { return null; }
    }

    function overrideFromLocation() {
        try {
            var location = global.location;
            if (!location || !location.href) return null;
            return validBase(new URL(location.href).searchParams.get('api'));
        } catch (error) {
            return null;
        }
    }

    // Never send credentials to an arbitrary endpoint supplied by a URL.
    var requestedOverride = overrideFromLocation();
    var trustedConfig = configured();
    var pageOverride = [trustedConfig.primary].concat(trustedConfig.fallbacks, trustedConfig.testBases).indexOf(requestedOverride) !== -1 ? requestedOverride : null;

    function configured() {
        var config = global.OWL_API_CONFIG || {};
        var primary = validBase(config.primary) || validBase(config.firebase) || DEFAULT_BASE;
        var fallbacks = [];
        var extra = Array.isArray(config.fallbacks) ? config.fallbacks : [];
        extra.concat([config.local, config.fallback, config.firebase]).forEach(function (candidate) {
            var base = validBase(candidate);
            if (base && fallbacks.indexOf(base) === -1) fallbacks.push(base);
        });
        // Test endpoints require explicit opt-in and are not normal candidates.
        var testBases = [];
        (Array.isArray(config.testBases) ? config.testBases : []).forEach(function (candidate) {
            var base = validBase(candidate);
            if (base && testBases.indexOf(base) === -1) testBases.push(base);
        });
        return { primary: primary, fallbacks: fallbacks, testBases: testBases };
    }

    function bases() {
        var config = configured();
        // An explicit page-load override is pinned: a preview failure must not
        // replay operations against the real API, or vice versa.
        if (pageOverride) return [pageOverride];
        var list = [config.primary];
        config.fallbacks.forEach(function (base) { if (list.indexOf(base) === -1) list.push(base); });
        return list;
    }

    function knownBases() {
        var all = LEGACY_BASES.slice();
        var config = configured();
        // Recognize ordinary API literals even when the active page is pinned
        // to a test endpoint. Unselected testBases are not automatic candidates.
        [config.primary].concat(config.fallbacks, bases()).forEach(function (base) {
            if (all.indexOf(base) === -1) all.push(base);
        });
        return all;
    }

    /* Return the API path for a URL this module owns, or null for anything else. */
    function apiPath(url) {
        if (typeof url !== 'string' || !url) return null;
        var candidates = knownBases();
        for (var i = 0; i < candidates.length; i++) {
            var base = candidates[i];
            if (url === base) return '/';
            if (url.indexOf(base + '/') === 0) return url.slice(base.length);
        }
        return null;
    }

    function urlFor(base, path) {
        var suffix = path || '/';
        if (suffix.charAt(0) !== '/') suffix = '/' + suffix;
        return base + suffix;
    }

    function drainedMap() {
        var parsed = readJson(DRAINED_KEY);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }

    function isDrained(base) {
        var until = Number(drainedMap()[base]);
        return Number.isFinite(until) && until > Date.now();
    }

    function markDrained(base, response) {
        if (pageOverride) return; // A one-page test never changes normal routing.
        var retry = response && response.headers && response.headers.get('Retry-After');
        var seconds = Number(retry);
        var until = seconds > 0 ? Date.now() + seconds * 1000 : Date.parse(retry);
        var map = drainedMap();
        map[base] = Number.isFinite(until) ? Math.min(until, Date.now() + 86400000) : Date.now() + DRAIN_COOLDOWN_MS;
        storageSet(DRAINED_KEY, JSON.stringify(map));
    }

    function clearDrained(base) {
        var map = drainedMap();
        if (map[base]) {
            delete map[base];
            storageSet(DRAINED_KEY, JSON.stringify(map));
        }
    }

    function activeBase() {
        if (pageOverride) return pageOverride;
        var list = bases();
        var stored = readJson(ACTIVE_KEY);
        if (stored && typeof stored === 'object' && list.indexOf(stored.base) !== -1 &&
            Date.now() - Number(stored.at || 0) < DRAIN_COOLDOWN_MS && !isDrained(stored.base)) {
            return stored.base;
        }
        for (var i = 0; i < list.length; i++) {
            if (!isDrained(list[i])) return list[i];
        }
        return list[0];
    }

    function rememberActive(base) {
        if (pageOverride) return;
        var stored = readJson(ACTIVE_KEY);
        // Don't extend stickiness on every success: periodically retry primary.
        if (!stored || stored.base !== base || Date.now() - Number(stored.at) >= DRAIN_COOLDOWN_MS) {
            storageSet(ACTIVE_KEY, JSON.stringify({ base: base, at: Date.now() }));
        }
        clearDrained(base);
    }

    function orderedBases() {
        var list = bases();
        var first = activeBase();
        var ordered = [first];
        list.forEach(function (base) { if (ordered.indexOf(base) === -1) ordered.push(base); });
        return ordered;
    }

    function retryableBody(body) {
        if (body === undefined || body === null) return true;
        var tag = Object.prototype.toString.call(body);
        return SAFE_BODY_TYPES.indexOf(tag) !== -1;
    }

    async function isDrain(response) {
        if (response.headers && response.headers.get('x-owl-drain') === '1') return true;
        if (response.status >= 400 && typeof response.clone === 'function') {
            try {
                var body = await response.clone().json();
                return body.code === 'quota-threshold-reached' || body.code === 'quota-monitoring-unavailable';
            } catch (_) { /* not JSON */ }
        }
        return false;
    }

    function withTimeout(init) {
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (!controller) return { init: init, cleanup: function () {} };
        var timer = setTimeout(function () { controller.abort(); }, DEFAULT_TIMEOUT_MS);
        var requestInit = Object.assign({}, init || {});
        requestInit.signal = controller.signal;
        var external = init && init.signal;
        var onAbort = function () { controller.abort(); };
        if (external) {
            if (external.aborted) controller.abort();
            else if (typeof external.addEventListener === 'function') external.addEventListener('abort', onAbort);
        }
        return {
            init: requestInit,
            cleanup: function () {
                clearTimeout(timer);
                if (external && typeof external.removeEventListener === 'function') {
                    external.removeEventListener('abort', onAbort);
                }
            }
        };
    }

    function owlFetch(input, init) {
        var rawUrl = typeof input === 'string' ? input : (input && (input.url || input.href));
        var path = apiPath(rawUrl);
        if (path === null) return nativeFetch(input, init);

        var requestInit = init || {};
        var method = String(requestInit.method || (input && input.method) || 'GET').toUpperCase();
        var safeRead = method === 'GET' || method === 'HEAD';
        var ordered = orderedBases();
        var attempts = retryableBody(requestInit.body) ? ordered : ordered.slice(0, 1);
        var lastError = null;
        var lastResponse = null;
        var index = 0;

        function attempt() {
            var base = attempts[index];
            var timed = withTimeout(requestInit);
            // ngrok's free-tier interstitial is HTML, not our API JSON. Set the
            // documented bypass header only for our configured ngrok API base.
            var host = new URL(base).hostname;
            if (/(?:^|\.)(?:ngrok-free\.(?:dev|app)|ngrok\.(?:app|io|dev))$/.test(host) && typeof global.Headers === 'function') {
                var headers = new global.Headers(requestInit.headers || (input && input.headers));
                headers.set('ngrok-skip-browser-warning', 'true');
                timed.init.headers = headers;
            }
            var target = urlFor(base, path);
            if (input && typeof input.clone === 'function') target = new global.Request(target, input.clone());
            return nativeFetch(target, timed.init).then(async function (response) {
                timed.cleanup();
                var drain = await isDrain(response);
                // A timed-out write might already have committed. Retry writes ONLY
                // on our explicit pre-handler drain, never on generic 5xx/network.
                if (drain || (safeRead && RETRY_STATUS.indexOf(response.status) !== -1)) {
                    markDrained(base, response);
                    lastResponse = response;
                    index += 1;
                    if (!(requestInit.signal && requestInit.signal.aborted) && index < attempts.length) return attempt();
                    return response;
                }
                rememberActive(base);
                return response;
            }, function (error) {
                timed.cleanup();
                lastError = error;
                markDrained(base);
                index += 1;
                if (safeRead && !(requestInit.signal && requestInit.signal.aborted) && index < attempts.length) return attempt();
                throw error;
            });
        }

        return attempt().catch(function (error) {
            if (lastResponse) return lastResponse;
            throw lastError || error;
        });
    }

    function baseUrl() {
        return activeBase();
    }

    function status() {
        return {
            bases: bases(),
            active: activeBase(),
            drained: drainedMap(),
            pageOverride: pageOverride,
            testBases: configured().testBases
        };
    }

    function reset() {
        storageRemove(ACTIVE_KEY);
        storageRemove(DRAINED_KEY);
    }

    var nativeFetch = typeof global.fetch === 'function' ? global.fetch.bind(global) : null;

    global.OWL_API_BASE = activeBase();
    global.OWL_API = {
        bases: bases,
        base: baseUrl,
        url: function (path) { return urlFor(activeBase(), path); },
        fetch: owlFetch,
        isApiUrl: function (url) { return apiPath(url) !== null; },
        status: status,
        reset: reset
    };

    if (nativeFetch) {
        global.fetch = function (input, init) {
            try {
                var url = typeof input === 'string' ? input : (input && (input.url || input.href));
                var path = apiPath(url);
                if (path !== null) return owlFetch(input, init);
            } catch (error) {
                /* fall through to the untouched fetch */
            }
            return nativeFetch(input, init);
        };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { apiPath: apiPath, validBase: validBase, urlFor: urlFor, LEGACY_BASES: LEGACY_BASES };
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
