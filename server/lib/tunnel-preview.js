'use strict';

// Intentionally NOT a full public deployment. Legacy sensitive reads and public
// mutations still need a society-level authorization review. Never use a broad
// '/api/*' allowlist here: some legacy GET routes perform database writes.
const PREVIEW_READS = [
    /^\/health\/?$/,
    /^\/api\/health\/?$/,
    /^\/api\/app-version\/?$/,
    /^\/api\/ads\/global\/?$/,
    /^\/api\/ads\/(?:local|greeting)\/[A-Za-z0-9_-]{1,128}\/?$/
];

function validatePreviewConfig(env) {
    const required = {
        DATA_BACKEND: 'firestore',
        AUTH_MODE: 'firebase',
        QUOTA_SOURCE: 'monitoring',
        QUOTA_ACTION: 'stop',
        SERVE_STATIC: '0',
        ENABLE_CRON: '0',
        TRUST_PROXY_HOPS: '1'
    };
    for (const [key, value] of Object.entries(required)) {
        if (env[key] !== value) throw new Error(`Tunnel preview requires ${key}=${value}.`);
    }
    if (!['monitor', 'enforce'].includes(env.APP_CHECK_MODE)) {
        throw new Error('Tunnel preview requires APP_CHECK_MODE=monitor or enforce.');
    }
    const threshold = Number(env.QUOTA_THRESHOLD || 0.8);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 0.8) {
        throw new Error('Tunnel preview requires QUOTA_THRESHOLD greater than 0 and at most 0.8.');
    }
}

function previewAllowed(method, path) {
    // Match raw paths, not decoded paths; reject encoded/slash ambiguity.
    if (!['GET', 'HEAD'].includes(method)) return false;
    return PREVIEW_READS.some(pattern => pattern.test(String(path || '').split('?')[0]));
}

function createPreviewGate() {
    return (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (previewAllowed(req.method, req.originalUrl || req.url)) return next();
        return res.status(403).json({
            code: 'tunnel-preview-restricted',
            error: 'Read-only tunnel preview: this endpoint is disabled. Private data, login and writes are not exposed.'
        });
    };
}

module.exports = { validatePreviewConfig, previewAllowed, createPreviewGate };
