'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createLocalStore, createFieldValue } = require('../server/lib/local-store');
const { firebaseReadAllowed } = require('../server/lib/firebase-release');

test('actual Firebase entry gates direct/Hosting paths before data/auth/Monitoring, exports no schedule, and fails closed on quota errors', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-cloud-pilot-'));
    const db = createLocalStore({ file: path.join(dir, 'db.json') });
    await db.collection('ads').doc('global').set({ items: [{ imageUrl: 'https://example.com/ad.jpg' }] });
    await db.collection('notices').doc('Test').set({ date: '2000-01-01', todayMessage: 'keep', tomorrowMessage: 'do not shift' });
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'))).collections;
    let collections = 0, checks = 0, authChecks = 0, failMonitoring = false, globalOptions;
    const collection = db.collection;
    db.collection = (...args) => { collections++; return collection(...args); };
    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'cloud-pilot-secret-'.repeat(4),
        NODE_ENV: 'production', DATA_BACKEND: 'firestore', AUTH_MODE: 'firebase',
        APP_CHECK_MODE: 'monitor', QUOTA_ACTION: 'stop', QUOTA_SOURCE: 'monitoring',
        QUOTA_THRESHOLD: '0.8', QUOTA_STATE_FILE: '', QUOTA_REFRESH_MS: '1', TUNNEL_PREVIEW: '0',
        SERVE_STATIC: '0', ENABLE_CRON: '1', FIREBASE_READ_ONLY: '0',
        OWL_FIREBASE_PROJECT_ID: 'finder-owl', FUNCTION_TARGET: 'api',
        API_RUNTIME_SERVICE_ACCOUNT: 'owl-api-readonly@finder-owl.iam.gserviceaccount.com',
        ALLOWED_ORIGINS: 'https://prsd503.github.io,https://app.owlwatcher.tech,https://localhost,capacitor://localhost'
    });
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.SERVICE_ACCOUNT_JSON;
    const Module = require('node:module'), original = Module._load;
    Module._load = function (name, ...args) {
        if (name === 'firebase-functions/v2') return { setGlobalOptions: options => { globalOptions = options; } };
        if (name === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
        if (name.includes('firebase-functions') && name.includes('scheduler')) throw new Error('Must not import Scheduler');
        if (name === 'firebase-admin/app') return { initializeApp: () => ({}), applicationDefault: () => ({ getAccessToken: async () => ({ access_token: 'mock' }) }) };
        if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: createFieldValue() };
        if (name === 'firebase-admin/auth') return { getAuth: () => ({ verifyIdToken: async () => { authChecks++; throw new Error('Auth must not run'); } }) };
        if (name === './lib/gcp-monitoring') return { createMonitoringUsageFetcher: () => async () => {
            checks++;
            if (failMonitoring) throw new Error('Monitoring permission denied');
            return { reads: 0, writes: 0, deletes: 0, invocations: 0, egressBytes: 0 };
        } };
        return original.call(this, name, ...args);
    };
    t.after(() => { Module._load = original; });
    const entry = require('../server/firebase');
    const app = require('../server/index');
    assert.deepEqual(Object.keys(entry), ['api'], 'only HTTP API exported, no maintenance job');
    assert.equal(process.env.ENABLE_CRON, '0');
    assert.equal(process.env.FIREBASE_READ_ONLY, '1');
    assert.equal(globalOptions.serviceAccount, process.env.API_RUNTIME_SERVICE_ACCOUNT);
    assert.equal(globalOptions.minInstances, 0);
    assert.equal(globalOptions.maxInstances, 2);
    assert.equal(globalOptions.region, 'us-central1');
    const server = http.createServer(entry.api).listen(0, '0.0.0.0');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        app.quota.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    // Cover every declared legacy route, including future additions, with the
    // actual gate and underlying app instead of a fake route inventory.
    const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    for (const match of source.matchAll(/app\.(get|post|patch|delete)\('([^']+)'/g)) {
        const method = match[1].toUpperCase();
        const url = match[2].replace(/:[A-Za-z]+/g, 'Test');
        if (firebaseReadAllowed(method, url)) continue;
        const response = await fetch(base + url, { method, headers: { Origin: 'https://prsd503.github.io', Authorization: 'Bearer fake-admin' } });
        assert.equal(response.status, 403, method + ' ' + url);
        assert.equal((await response.json()).code, 'firebase-api-read-only');
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    // Direct Function transport has no /api prefix; it must not bypass the gate.
    for (const url of ['/vehicles', '/notices/Test', '/%61ds/global', '/api/ads/local/a%2fb']) {
        assert.equal((await fetch(base + url)).status, 403, url);
    }
    assert.equal(collections, 0);
    assert.equal(checks, 0);
    assert.equal(authChecks, 0);
    for (const origin of ['https://attacker.ngrok-free.dev', 'https://prsd503.github.io.evil.com']) {
        assert.equal((await fetch(base + '/api/ads/global', { headers: { Origin: origin } })).status, 403);
    }
    const preflight = await fetch(base + '/api/ads/global', { method: 'OPTIONS', headers: { Origin: 'https://prsd503.github.io', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(preflight.status, 204);
    assert.equal(checks, 0);
    for (const origin of ['https://prsd503.github.io', 'https://localhost', 'capacitor://localhost']) {
        const health = await fetch(base + '/health', { headers: { Origin: origin } });
        assert.equal(health.status, 200);
        assert.equal(health.headers.get('access-control-allow-origin'), origin);
        assert.equal((await health.json()).accessMode, 'firebase-read-only');
    }
    const ads = await fetch(base + '/api/ads/global');
    assert.equal(ads.status, 200);
    assert.deepEqual(await ads.json(), [{ imageUrl: 'https://example.com/ad.jpg' }]);
    assert.ok(checks >= 1);
    assert.equal(collections, 1);
    failMonitoring = true;
    await app.quota.refresh(true);
    const drained = await fetch(base + '/ads/global');
    assert.equal(drained.status, 503);
    assert.equal((await drained.json()).code, 'quota-monitoring-unavailable');
    const healthDuringDrain = await fetch(base + '/api/health');
    assert.equal(healthDuringDrain.status, 200);
    const quota = await fetch(base + '/api/quota');
    assert.equal(quota.status, 200);
    assert.equal((await quota.json()).monitoringUnavailable, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'))).collections, before, 'boot and GETs did not mutate data/rotate notices');
    let last;
    for (let i = 0; i < 61; i++) last = await fetch(base + '/api/health');
    assert.equal(last.status, 429, 'limiter applies before database work');
});
