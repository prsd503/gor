/* CORS origin allow-list and App Check enforcement.
 *
 * The original server treated a matching Origin header as authentication. Origin is
 * client-controlled (any script can send `Origin: https://localhost`), so it is used
 * ONLY for CORS here. App Check is verified cryptographically when present.
 *
 * Enforcement is configurable so it can be rolled out safely:
 *   APP_CHECK_MODE=off      - do not inspect tokens (local development)
 *   APP_CHECK_MODE=monitor  - verify when present, log failures, allow the request (default)
 *   APP_CHECK_MODE=enforce  - require a valid App Check token on protected routes
 */
'use strict';

const DEFAULT_ORIGINS = [
    'https://prsd503.github.io',
    'https://app.owlwatcher.tech',
    'https://api.owlwatcher.tech',
    'http://localhost',
    'https://localhost',
    'capacitor://localhost',
    'http://127.0.0.1:5500'
];

function normalizeOrigin(origin) {
    if (typeof origin !== 'string' || !origin) return null;
    try {
        const url = new URL(origin);
        if (!['https:', 'http:', 'capacitor:', 'ionic:'].includes(url.protocol)) return null;
        return `${url.protocol}//${url.host}`;
    } catch (_) {
        return null;
    }
}

function createOriginChecker(extraOrigins = [], options = {}) {
    const allowlist = new Set(
        DEFAULT_ORIGINS.concat(extraOrigins).map(normalizeOrigin).filter(Boolean)
    );
    const ngrokSuffix = '.ngrok-free.dev';
    const allowNgrok = options.allowNgrok !== false;

    return function isAllowedOrigin(origin) {
        // Non-browser clients (curl, native HTTP) send no Origin; CORS does not apply to them.
        if (!origin) return true;
        const normalized = normalizeOrigin(origin);
        if (!normalized) return false;
        if (allowlist.has(normalized)) return true;
        if (allowNgrok) {
            let host;
            try { host = new URL(normalized).hostname; } catch (_) { return false; }
            // Exact suffix match, not substring: blocks ngrok-free.dev.attacker.com
            if (host.endsWith(ngrokSuffix) && host.length > ngrokSuffix.length) return true;
        }
        return false;
    };
}

function createAppCheckMiddleware(options = {}) {
    const mode = ['off', 'monitor', 'enforce'].includes(options.mode) ? options.mode : 'monitor';
    const verifyToken = options.verifyToken;
    const logger = options.logger || console;

    if (mode !== 'off' && typeof verifyToken !== 'function') {
        throw new Error('verifyToken is required unless APP_CHECK_MODE=off.');
    }

    return async function appCheck(req, res, next) {
        if (mode === 'off') return next();
        const token = req.header ? req.header('X-Firebase-AppCheck') : (req.headers || {})['x-firebase-appcheck'];
        if (!token) {
            if (mode === 'enforce') {
                return res.status(401).json({ error: 'App Check token required.', code: 'app-check-missing' });
            }
            return next();
        }
        try {
            const decoded = await verifyToken(token);
            req.appCheck = { appId: decoded.appId || decoded.app_id || null, verified: true };
            return next();
        } catch (error) {
            if (logger && typeof logger.warn === 'function') {
                logger.warn('[app-check] Verification failed:', error.code || '', error.message);
            }
            if (mode === 'enforce') {
                return res.status(401).json({ error: 'Invalid App Check token.', code: 'app-check-invalid' });
            }
            req.appCheck = { verified: false, reason: error.message };
            return next();
        }
    };
}

module.exports = { DEFAULT_ORIGINS, normalizeOrigin, createOriginChecker, createAppCheckMiddleware };
