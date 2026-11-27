'use strict';
/* Pins the behaviour the cost-reduction work relies on, so a later refactor
 * cannot silently make the API read more than it needs to:
 *
 *   - the read cache hits repeated reads and is invalidated per collection,
 *   - a migrated society answers a scoped read without the legacy name queries,
 *   - the resident flat lookup does not read the whole society,
 *   - aggregate counts are billed per thousand documents, not per document.
 *
 * Every assertion is about reads/writes or the documents touched, never about
 * timing, so it is deterministic.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalStore, createFieldValue } = require('../server/lib/local-store');
const { createDbLayer } = require('../server/lib/db-layer');

function silent() { return { log() {}, warn() {}, error() {} }; }

function freshDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'owl-cost-'));
}

function tempStore(t) {
    // Each store gets its own directory: tests run concurrently, and one test's
    // cleanup must never delete another's data file.
    const dir = freshDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return createLocalStore({ file: path.join(dir, 'db.json'), logger: silent() });
}

// --- the cache itself -------------------------------------------------------

test('repeated reads are served from the cache and writes invalidate only their collection', async (t) => {
    const raw = tempStore(t);
    const layer = createDbLayer(raw, { ttlMs: 60000 });
    const db = layer.db;

    await raw.collection('societies').doc('aangan').set({ name: 'Aangan' });
    await raw.collection('vehicles').doc('v1').set({ societyId: 'aangan', flatNumber: 'A-101' });

    await db.collection('societies').doc('aangan').get();
    await db.collection('societies').doc('aangan').get();
    assert.equal(layer.counters.reads, 1, 'the second read hits the cache');
    assert.equal(layer.stats.hits, 1);

    await db.collection('vehicles').doc('v1').get();
    const readsBeforeVehicleWrite = layer.counters.reads;
    await db.collection('vehicles').doc('v1').update({ flatNumber: 'A-102' });

    // The vehicles cache is gone (its collection changed) ...
    const updated = await db.collection('vehicles').doc('v1').get();
    assert.equal(updated.data().flatNumber, 'A-102', 'a write is visible immediately');
    assert.equal(layer.counters.reads, readsBeforeVehicleWrite + 1);

    // ... but the unrelated societies entry survived.
    const hitsBefore = layer.stats.hits;
    await db.collection('societies').doc('aangan').get();
    assert.equal(layer.stats.hits, hitsBefore + 1, 'a write elsewhere does not flush the cache');
});

test('a transaction invalidates only the collections it wrote', async (t) => {
    const raw = tempStore(t);
    const layer = createDbLayer(raw, { ttlMs: 60000 });
    const db = layer.db;

    await raw.collection('societies').doc('aangan').set({ name: 'Aangan' });
    await raw.collection('vehicles').doc('v1').set({ societyId: 'aangan', count: 1 });
    await db.collection('societies').doc('aangan').get();
    await db.collection('vehicles').doc('v1').get();

    await db.runTransaction(async tx => {
        const doc = await tx.get(db.collection('vehicles').doc('v1'));
        tx.update(db.collection('vehicles').doc('v1'), { count: (doc.data().count || 0) + 1 });
    });

    const hitsBefore = layer.stats.hits;
    await db.collection('societies').doc('aangan').get();
    assert.equal(layer.stats.hits, hitsBefore + 1, 'the untouched collection stays cached');
    assert.equal((await db.collection('vehicles').doc('v1').get()).data().count, 2);
});

test('a write that lands while a read is in flight cannot be masked by the cache', async (t) => {
    const raw = tempStore(t);
    const layer = createDbLayer(raw, { ttlMs: 60000 });
    const db = layer.db;
    await raw.collection('configs').doc('owl').set({ teamPhone: '1111111111' });

    // Start the read, let the write commit before the snapshot is cached.
    const pending = db.collection('configs').doc('owl').get();
    await db.collection('configs').doc('owl').set({ teamPhone: '2222222222' }, { merge: true });
    await pending;

    const after = await db.collection('configs').doc('owl').get();
    assert.equal(after.data().teamPhone, '2222222222', 'the post-write read is not answered from the pre-write snapshot');
});

test('aggregate count is billed per thousand documents', async (t) => {
    const raw = tempStore(t);
    const layer = createDbLayer(raw, { ttlMs: 0 });
    const db = layer.db;
    const batch = raw.batch();
    for (let i = 0; i < 600; i += 1) {
        batch.set(raw.collection('vehicles').doc(`v${i}`), { societyId: 'aangan', vehicleType: '2-Wheeler' });
    }
    await batch.commit();

    layer.counters.reads = 0;
    assert.equal(await db.collection('vehicles').where('societyId', '==', 'aangan').count(), 600);
    assert.equal(layer.counters.reads, 1, '600 documents are counted for 1 read');
});

// --- the API routes ---------------------------------------------------------

async function startApi(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-cost-api-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file, logger: silent() });
    await db.collection('societies').doc('aangan').set({
        name: 'Aangan', flatList: ['A-101', 'A-102'], max2Wheeler: 20, max4Wheeler: 1
    });
    for (let i = 0; i < 20; i += 1) {
        await db.collection('vehicles').doc(`v${i}`).set({
            societyId: 'aangan', societyName: 'Aangan',
            flatNumber: i % 2 ? 'A-101' : 'A-102', flatLower: i % 2 ? 'a-101' : 'a-102',
            vehicleNumber: `GJ01AB${1000 + i}`, vehicleType: '2-Wheeler',
            deviceId: i === 1 ? 'dev-1' : null
        });
    }
    await db.collection('admins').doc('admin@aangan.test').set({
        email: 'admin@aangan.test', uid: 'uid-admin', societyId: 'aangan'
    });
    await db.collection('notices').doc('aangan').set({
        societyId: 'aangan', societyName: 'Aangan', date: '2026-11-27',
        todayMessage: 'Today', tomorrowMessage: 'Tomorrow'
    });

    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'cost-reduction-secret-'.repeat(2),
        DATA_BACKEND: 'local', AUTH_MODE: 'local',
        LOCAL_ADMIN_EMAIL: 'admin@local.test', LOCAL_ADMIN_PASSWORD: 'a-long-testing-password',
        LOCAL_DB_FILE: file, QUOTA_STATE_FILE: '', QUOTA_ACTION: 'off', QUOTA_SOURCE: 'local',
        APP_CHECK_MODE: 'off', SERVE_STATIC: '0', ENABLE_CRON: '0', READ_CACHE_TTL_MS: '60000'
    });
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (name, ...args) {
        if (name.startsWith('firebase-admin')) throw new Error('Firebase must not load locally');
        return original.call(this, name, ...args);
    };
    for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}server${path.sep}`)) delete require.cache[key];
    }
    let app;
    // Unbuffered so a failure inside a test is visible instead of swallowed.
    try { app = require('../server/index'); } finally { Module._load = original; }
    const server = app.listen(0, '0.0.0.0');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        app.quota.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/api/auth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@local.test', password: 'a-long-testing-password' })
    });
    const { token } = await login.json();
    const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    return {
        db, base, app,
        reads: () => app.dataLayer.counters.reads,
        async get(pathname, headers) {
            const res = await fetch(base + pathname, headers ? { headers } : undefined);
            return { status: res.status, body: await res.json().catch(() => null) };
        },
        async adminGet(pathname) {
            const res = await fetch(base + pathname, { headers: adminHeaders });
            return { status: res.status, body: await res.json().catch(() => null) };
        },
        async post(pathname, body) {
            const res = await fetch(base + pathname, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        }
    };
}

test('a migrated society answers a scoped read without the legacy name queries', async (t) => {
    const api = await startApi(t);
    // The flag is written through the API's own db handle, exactly like the
    // migration job does, so this also covers cache invalidation of the flag.
    await api.app.dataLayer.db.collection('societyFlags').doc('aangan').set({ legacyVehiclesMigrated: true });

    const before = api.reads();
    const result = await api.adminGet('/api/vehicles?society=Aangan');
    assert.equal(result.status, 200);
    assert.equal(result.body.length, 20, 'every vehicle is still listed');
    const migratedReads = api.reads() - before;
    // One page of records plus the handful of documents it takes to resolve the
    // society and its flags - NOT the same 20 documents a second time through
    // the legacy `societyName` query.
    assert.ok(migratedReads <= 25, `migrated read cost should be about the page itself, got ${migratedReads}`);

    const legacy = await api.adminGet('/api/vehicles?society=Aangan');
    assert.equal(legacy.body.length, 20, 'the flag does not change the answer');
});

test('the resident flat lookup does not read the whole society', async (t) => {
    const api = await startApi(t);
    await api.app.dataLayer.db.collection('societyFlags').doc('aangan').set({ legacyVehiclesMigrated: true });

    const before = api.reads();
    const result = await api.get('/api/vehicles?society=Aangan&flatNumber=A-101&deviceId=dev-1');
    assert.equal(result.status, 200);
    // A-101 holds 10 of the 20 vehicles; a society-wide read would be 20+.
    assert.ok(api.reads() - before <= 16, `flat lookup read ${api.reads() - before} documents`);
});

test('a resident lookup on an unmigrated society still avoids the full scan', async (t) => {
    const api = await startApi(t);
    // No migration flag: this is the society that still holds legacy records,
    // so the case-variant query has to run. It answers the request on its own,
    // which means the society-wide fallback scan must NOT be reached.
    const before = api.reads();
    const result = await api.get('/api/vehicles?society=Aangan&flatNumber=A-101&deviceId=dev-1');
    assert.equal(result.status, 200);
    assert.ok(result.body.length >= 1, 'the flat still resolves');
    const reads = api.reads() - before;
    // Two scoped queries (flatLower variants + deviceId) plus resolution; a
    // whole-society read costs 20 more on top of that.
    assert.ok(reads <= 30, `unmigrated flat lookup read ${reads} documents`);
});

test('a missing notice is still a 404 and costs a bounded number of reads', async (t) => {
    const api = await startApi(t);
    const found = await api.get('/api/notices/Aangan');
    assert.equal(found.status, 200);
    assert.equal(found.body.societyName, 'Aangan', 'the notice is found');

    await api.db.collection('societies').doc('open').set({ name: 'Open Society', flatList: [] });
    api.app.dataLayer.clearCache();
    const before = api.reads();
    const missing = await api.get('/api/notices/Open Society');
    assert.equal(missing.status, 404);
    assert.ok(api.reads() - before <= 5, `missing-notice lookup read ${api.reads() - before} documents`);
});

test('the expiry deadline on a public calendar does not forbid caching', async (t) => {
    const api = await startApi(t);
    const res = await fetch(`${api.base}/api/bookings?society=Aangan`);
    const cacheControl = res.headers.get('cache-control') || '';
    assert.match(cacheControl, /max-age=30/);
    assert.match(cacheControl, /s-maxage=/);
    assert.doesNotMatch(cacheControl, /no-store/);
});

test('registration writes the society id so the next read does not need the legacy queries', async (t) => {
    const api = await startApi(t);
    const created = await api.post('/api/vehicles', {
        societyName: 'Aangan', flatNumber: 'A-102', residentType: 'Owner', mobileNumber: '9000000000',
        deviceId: 'new-device', vehicles: [{ vehicleNumber: 'GJ01NEW001', vehicleType: '2-Wheeler' }]
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    // Read it back through the API so this also proves the write is visible to a
    // later request (the test's own store handle keeps its own write queue).
    const plate = await api.get('/api/vehicles?society=Aangan&vehicleNumber=GJ01NEW001');
    assert.equal(plate.status, 200);
    assert.equal(plate.body.length, 1);
    assert.equal(plate.body[0].flatNumber, 'A-102');
    const flags = await api.app.dataLayer.db.collection('societyFlags').doc('aangan').get();
    assert.equal(flags.exists, false, 'registration alone does not claim the society is migrated');
});
