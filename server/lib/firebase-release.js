'use strict';

const { normalizeOrigin } = require('./security');

// Full-feature HTTP API release profile. Route-level Firebase identity,
// membership and society authorization remains mandatory; this profile only
// removes the old global read-only release gate.
function prepareFirebaseApi(env) {
    if (env.API_RELEASE_PROFILE !== 'full') {
        throw new Error('Set API_RELEASE_PROFILE=full to opt into the authenticated full API release.');
    }

    const defaults = {
        NODE_ENV: 'production', DATA_BACKEND: 'firestore', AUTH_MODE: 'firebase',
        SERVE_STATIC: '0', ENABLE_CRON: '0', QUOTA_SOURCE: 'monitoring',
        QUOTA_ACTION: 'stop', QUOTA_THRESHOLD: '0.8', APP_CHECK_MODE: 'monitor',
        MAX_INSTANCES: '2', CONCURRENCY: '20', FUNCTIONS_REGION: 'us-central1'
    };
    for (const [key, value] of Object.entries(defaults)) {
        if (env[key] === undefined) env[key] = value;
    }
    for (const key of ['NODE_ENV', 'DATA_BACKEND', 'AUTH_MODE', 'SERVE_STATIC', 'ENABLE_CRON', 'QUOTA_SOURCE', 'QUOTA_ACTION', 'FUNCTIONS_REGION']) {
        if (env[key] !== defaults[key]) throw new Error(`Full Firebase API requires ${key}=${defaults[key]}.`);
    }
    if (['1', 'true', 'yes', 'on'].includes(String(env.FIREBASE_READ_ONLY || '').trim().toLowerCase())) {
        throw new Error('Remove FIREBASE_READ_ONLY; this release enables authenticated full API routes.');
    }
    const threshold = Number(env.QUOTA_THRESHOLD);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 0.8) {
        throw new Error('Full Firebase API requires QUOTA_THRESHOLD greater than 0 and at most 0.8.');
    }
    for (const [key, max] of [['MAX_INSTANCES', 2], ['CONCURRENCY', 20]]) {
        const n = Number(env[key]);
        if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Full Firebase API requires ${key} between 1 and ${max}.`);
    }
    if (!['monitor', 'enforce'].includes(env.APP_CHECK_MODE)) throw new Error('Full Firebase API requires App Check monitor or enforce.');
    if (env.QUOTA_FALLBACK_URLS || (env.TUNNEL_PREVIEW && env.TUNNEL_PREVIEW !== '0')) {
        throw new Error('Full Firebase API must not enable automatic fallback or the MacBook tunnel profile.');
    }
    const origins = String(env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
    if (!origins.length || origins.some(v => normalizeOrigin(v) !== v || v.includes('*') ||
        (!v.startsWith('https://') && !['http://localhost', 'capacitor://localhost', 'ionic://localhost'].includes(v)))) {
        throw new Error('Set ALLOWED_ORIGINS to exact frontend origins (scheme and host only; no wildcards or paths).');
    }
    const project = env.OWL_FIREBASE_PROJECT_ID || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
    if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('Set OWL_FIREBASE_PROJECT_ID to the deployment project.');
    for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
        if (env[key] && env[key] !== project) throw new Error('Configured Firebase project differs from the runtime project.');
    }
    const account = String(env.API_RUNTIME_SERVICE_ACCOUNT || '');
    const suffix = `@${project}.iam.gserviceaccount.com`;
    const accountId = account.slice(0, -suffix.length);
    if (!account.endsWith(suffix) || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(accountId) || /read.?only/i.test(accountId)) {
        throw new Error('Set API_RUNTIME_SERVICE_ACCOUNT to a dedicated non-read-only service account in the deployment project.');
    }

    // Do not start process maintenance in an HTTP Function. There is no
    // scheduled Function either: maintenance jobs run on demand from the
    // master admin portal (POST /api/maintenance/*).
    env.ENABLE_CRON = '0';
    return { serviceAccount: account, origins, project, profile: 'firebase-full' };
}

module.exports = { prepareFirebaseApi };
