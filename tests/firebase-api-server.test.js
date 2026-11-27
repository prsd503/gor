'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createLocalStore, createFieldValue } = require('../server/lib/local-store');

test('full Firebase entry enables staff login and gift-code routes with auth, quota and exact CORS intact', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-cloud-full-api-'));
    const db = createLocalStore({ file: path.join(dir, 'db.json') });
    await db.collection('ads').doc('global').set({ items: [{ imageUrl: 'https://example.com/ad.jpg' }] });
    await db.collection('societies').doc('aangan').set({ name: 'Aangan', flatList: ['A-1'] });
    await db.collection('admins').doc('master@example.test').set({
        email: 'master@example.test', uid: 'master-uid', isMaster: true, active: true
    });
    await db.collection('guards').doc('guard@example.test').set({
        email: 'guard@example.test', uid: 'guard-uid', societyId: 'aangan', active: true
    });

    const env = {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'cloud-full-api-secret-'.repeat(3),
        API_RELEASE_PROFILE: 'full', NODE_ENV: 'production', DATA_BACKEND: 'firestore', AUTH_MODE: 'firebase',
        APP_CHECK_MODE: 'monitor', QUOTA_ACTION: 'stop', QUOTA_SOURCE: 'monitoring',
        QUOTA_THRESHOLD: '0.8', QUOTA_STATE_FILE: '', QUOTA_REFRESH_MS: '1', TUNNEL_PREVIEW: '0',
        SERVE_STATIC: '0', ENABLE_CRON: '0', FIREBASE_READ_ONLY: '0',
        OWL_FIREBASE_PROJECT_ID: 'finder-owl', FUNCTION_TARGET: 'api',
        API_RUNTIME_SERVICE_ACCOUNT: 'owl-api-runtime@finder-owl.iam.gserviceaccount.com',
        ALLOWED_ORIGINS: 'https://prsd503.github.io,https://app.owlwatcher.tech,https://localhost,http://localhost,capacitor://localhost'
    };
    const envKeys = [...new Set([...Object.keys(env), 'GOOGLE_APPLICATION_CREDENTIALS', 'SERVICE_ACCOUNT_JSON'])];
    const priorEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.SERVICE_ACCOUNT_JSON;

    const identities = {
        'master-id-token': { uid: 'master-uid', email: 'master@example.test', email_verified: true },
        'guard-id-token': { uid: 'guard-uid', email: 'guard@example.test', email_verified: true },
        'unverified-id-token': { uid: 'unverified-uid', email: 'master@example.test', email_verified: false }
    };
    let authChecks = 0;
    let monitoringChecks = 0;
    let globalOptions;
    const Module = require('node:module');
    const originalLoad = Module._load;
    let app;
    let server;

    Module._load = function (name, ...args) {
        if (name === 'firebase-functions/v2') return { setGlobalOptions: options => { globalOptions = options; } };
        if (name === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
        if (name === 'firebase-admin/app') return { initializeApp: () => ({}), applicationDefault: () => ({ getAccessToken: async () => ({ access_token: 'mock' }) }) };
        if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: createFieldValue() };
        if (name === 'firebase-admin/auth') return { getAuth: () => ({
            verifyIdToken: async token => {
                authChecks++;
                if (!identities[token]) throw Object.assign(new Error('Invalid test ID token.'), { code: 'auth/invalid-id-token' });
                return identities[token];
            }
        }) };
        if (name === './lib/gcp-monitoring') return { createMonitoringUsageFetcher: () => async () => {
            monitoringChecks++;
            return { reads: 0, writes: 0, deletes: 0, invocations: 0, egressBytes: 0 };
        } };
        return originalLoad.call(this, name, ...args);
    };

    try {
        const entry = require('../server/firebase');
        app = require('../server/index');
        assert.deepEqual(Object.keys(entry), ['api'], 'no scheduled Function is exported; jobs are master-triggered');
        assert.equal(process.env.ENABLE_CRON, '0');
        assert.equal(process.env.FIREBASE_READ_ONLY, '0');
        assert.equal(globalOptions.serviceAccount, process.env.API_RUNTIME_SERVICE_ACCOUNT);
        assert.equal(globalOptions.minInstances, 0);
        assert.equal(globalOptions.maxInstances, 2);
        assert.equal(globalOptions.region, 'us-central1');

        server = http.createServer(entry.api).listen(0, '0.0.0.0');
        await new Promise(resolve => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const json = { 'Content-Type': 'application/json' };

        // No scheduled job persists the rollover anymore; the public GET only
        // computes the effective notice and leaves the stored document alone
        // until the master admin triggers POST /api/maintenance/notices.
        const { noticeCycle, istDate } = require('../server/lib/notices');
        const previousCycle = noticeCycle(new Date(Date.now() - 86400000));
        const noticeRef = db.collection('notices').doc('aangan');
        await noticeRef.set({ societyId: 'aangan', date: previousCycle, todayMessage: 'old', tomorrowMessage: 'next' });
        const noticeResponse = await fetch(base + '/api/notices/Aangan');
        const notice = await noticeResponse.json();
        assert.equal(notice.date, istDate());
        assert.equal(notice.todayMessage, 'next');
        assert.equal(notice.tomorrowMessage, '');
        assert.equal((await noticeRef.get()).data().tomorrowMessage, 'next');

        const health = await fetch(base + '/api/health', { headers: { Origin: 'https://prsd503.github.io' } });
        assert.equal(health.status, 200);
        assert.equal(health.headers.get('access-control-allow-origin'), 'https://prsd503.github.io');
        assert.equal((await health.json()).accessMode, 'firebase-full');

        const ads = await fetch(base + '/api/ads/global');
        assert.equal(ads.status, 200);
        assert.deepEqual(await ads.json(), [{ imageUrl: 'https://example.com/ad.jpg' }]);

        const noStaff = await fetch(base + '/api/admins');
        assert.equal(noStaff.status, 401, 'private routes still require a verified staff identity');

        const adminLogin = await fetch(base + '/api/auth/token', {
            method: 'POST', headers: json, body: JSON.stringify({ idToken: 'master-id-token' })
        });
        assert.equal(adminLogin.status, 200, 'Firebase ID-token exchange is not globally blocked');
        const adminToken = (await adminLogin.json()).token;

        // Maintenance jobs are master-triggered on demand (no scheduled Function).
        const rolloverNoAuth = await fetch(base + '/api/maintenance/notices', { method: 'POST' });
        assert.equal(rolloverNoAuth.status, 401, 'maintenance jobs require a verified identity');
        const rollover = await fetch(base + '/api/maintenance/notices', {
            method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(rollover.status, 200, 'master can trigger the notice rollover');
        assert.ok((await rollover.json()).shifted >= 1);
        assert.equal((await noticeRef.get()).data().tomorrowMessage, '');
        assert.equal((await noticeRef.get()).data().todayMessage, 'next');

        await db.collection('bookings').doc('old-booking').set({
            societyId: 'aangan', facility: 'Gym',
            end: new Date(Date.now() - 8 * 86400000).toISOString()
        });
        const cleanup = await fetch(base + '/api/maintenance/bookings', {
            method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(cleanup.status, 200, 'master can trigger the expired-booking cleanup');
        assert.ok((await cleanup.json()).deleted >= 1);
        assert.equal((await db.collection('bookings').doc('old-booking').get()).exists, false);

        const adminProfile = await fetch(base + '/api/admins', { headers: { Authorization: `Bearer ${adminToken}` } });
        assert.equal(adminProfile.status, 200);
        assert.equal((await adminProfile.json()).isMaster, true);

        const guardLogin = await fetch(base + '/api/auth/token', {
            method: 'POST', headers: json, body: JSON.stringify({ idToken: 'guard-id-token' })
        });
        assert.equal(guardLogin.status, 200, 'guard identity can exchange a Firebase ID token');
        const guardToken = (await guardLogin.json()).token;
        const guardDirectory = await fetch(base + '/api/guards', { headers: { Authorization: `Bearer ${guardToken}` } });
        assert.equal(guardDirectory.status, 200);
        assert.equal((await guardDirectory.json()).length, 1);
        const guardRollover = await fetch(base + '/api/maintenance/notices', {
            method: 'POST', headers: { Authorization: `Bearer ${guardToken}` }
        });
        assert.equal(guardRollover.status, 403, 'non-master staff cannot trigger maintenance jobs');

        const unverifiedLogin = await fetch(base + '/api/auth/token', {
            method: 'POST', headers: json, body: JSON.stringify({ idToken: 'unverified-id-token' })
        });
        assert.equal(unverifiedLogin.status, 200, 'token exchange may identify but does not grant staff membership');
        const unverifiedToken = (await unverifiedLogin.json()).token;
        const unverifiedProfile = await fetch(base + '/api/admins', { headers: { Authorization: `Bearer ${unverifiedToken}` } });
        assert.equal(unverifiedProfile.status, 403, 'unverified email cannot use staff routes');

        const forbiddenMint = await fetch(base + '/api/gift-codes', {
            method: 'POST', headers: { ...json, Authorization: `Bearer ${guardToken}` }, body: JSON.stringify({ count: 1 })
        });
        assert.equal(forbiddenMint.status, 403, 'guards cannot mint master-only gift codes');

        const mint = await fetch(base + '/api/gift-codes', {
            method: 'POST', headers: { ...json, Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ count: 1 })
        });
        assert.equal(mint.status, 200, 'master admins can use the authenticated gift-code route');
        const minted = await mint.json();
        assert.equal(minted.count, 1);
        const code = minted.created[0];

        const validation = await fetch(base + '/api/gift-codes/validate', {
            method: 'POST', headers: json, body: JSON.stringify({ code })
        });
        assert.equal(validation.status, 200);
        assert.equal((await validation.json()).unlocked, true);
        const redemption = await fetch(base + '/api/gift-codes/redeem', {
            method: 'POST', headers: json, body: JSON.stringify({ code })
        });
        assert.equal(redemption.status, 200);
        assert.equal((await redemption.json()).consumed, true);

        const badOrigin = await fetch(base + '/api/ads/global', { headers: { Origin: 'https://attacker.ngrok-free.dev' } });
        assert.notEqual(badOrigin.headers.get('access-control-allow-origin'), 'https://attacker.ngrok-free.dev');
        assert.ok(authChecks >= 3, 'Firebase ID tokens are verified through the Admin SDK');
        assert.ok(monitoringChecks >= 1, 'quota monitoring remains active');
    } finally {
        Module._load = originalLoad;
        if (app && app.quota) app.quota.close();
        if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [key, value] of priorEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
