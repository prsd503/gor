'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const jwt = require('jsonwebtoken');
const { createLocalStore, createFieldValue } = require('../server/lib/local-store');

// Exercise the actual Express routes and Firestore wrapper using an isolated
// local store. No production accounts, credentials, or Firestore operations.
test('Firestore membership authorization is verified, society-scoped, revocable, and preserves public resident flows', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-authz-'));
    const db = createLocalStore({ file: path.join(dir, 'db.json') });
    const secret = 'authorization-test-secret-'.repeat(3);
    const identities = {
        'google-master': { uid: 'uid-master', email: 'master@example.test', email_verified: true, role: 'user' },
        'google-admin-a': { uid: 'uid-admin-a', email: 'admin-a@example.test', email_verified: true, role: 'admin', admin: true },
        'google-admin-b': { uid: 'uid-admin-b', email: 'admin-b@example.test', email_verified: true },
        'google-guard-a': { uid: 'uid-guard-a', email: 'guard-a@example.test', email_verified: true },
        'google-unverified': { uid: 'uid-unverified', email: 'admin-a@example.test', email_verified: false },
        'google-mismatched-uid': { uid: 'attacker-uid', email: 'admin-a@example.test', email_verified: true }
    };
    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: secret, NODE_ENV: 'development',
        DATA_BACKEND: 'firestore', AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'finder-owl',
        APP_CHECK_MODE: 'off', QUOTA_ACTION: 'off', QUOTA_SOURCE: 'local', SERVE_STATIC: '0',
        ENABLE_CRON: '0', QUOTA_STATE_FILE: '', TUNNEL_PREVIEW: '0'
    });
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.SERVICE_ACCOUNT_JSON;

    await db.collection('societies').doc('aangan').set({
        name: 'Aangan', flatList: ['A-101', 'A-102', 'A-103'], max2Wheeler: 1, max4Wheeler: 1, spintodayNumber: 1
    });
    await db.collection('societies').doc('open').set({ name: 'Open Society', flatList: [], max2Wheeler: 2, max4Wheeler: 1 });
    await db.collection('societies').doc('bloom').set({
        name: 'Bloom Society', flatList: ['B-101'], max2Wheeler: 2, max4Wheeler: 1, spintodayNumber: 5
    });
    await db.collection('admins').doc('master@example.test').set({
        email: 'master@example.test', uid: 'uid-master', isMaster: true
    });
    await db.collection('admins').doc('admin-a@example.test').set({
        email: 'admin-a@example.test', uid: 'uid-admin-a', society: 'Aangan'
    });
    await db.collection('admins').doc('admin-b@example.test').set({
        email: 'admin-b@example.test', uid: 'uid-admin-b', societyId: 'bloom'
    });
    await db.collection('guards').doc('guard-a@example.test').set({
        email: 'guard-a@example.test', uid: 'uid-guard-a', name: 'Guard A', name_lower: 'guard a', phone: '9876543210', society: 'Aangan'
    });

    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function (name, ...args) {
        if (name === 'firebase-admin/app') return {
            initializeApp: () => ({}),
            applicationDefault: () => ({ getAccessToken: async () => ({ access_token: 'mock-only' }) })
        };
        if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: createFieldValue() };
        if (name === 'firebase-admin/auth') return {
            getAuth: () => ({
                verifyIdToken: async idToken => {
                    if (!identities[idToken]) throw new Error('invalid mocked ID token');
                    return identities[idToken];
                }
            })
        };
        return originalLoad.call(this, name, ...args);
    };
    t.after(() => { Module._load = originalLoad; });
    const app = require('../server/index');
    const server = app.listen(0, '0.0.0.0');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        app.quota.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${server.address().port}`;
    const exchange = async idToken => {
        const response = await fetch(base + '/api/auth/token', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
        });
        assert.equal(response.status, 200);
        return (await response.json()).token;
    };
    const tokens = {
        master: await exchange('google-master'),
        adminA: await exchange('google-admin-a'),
        adminB: await exchange('google-admin-b'),
        guardA: await exchange('google-guard-a'),
        unverified: await exchange('google-unverified'),
        mismatchedUid: await exchange('google-mismatched-uid')
    };
    const request = (url, method = 'GET', body, token) => fetch(base + url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    // Auth exchange never turns token role/custom claims into app-wide authority.
    assert.equal(jwt.verify(tokens.adminA, secret).role, undefined);
    assert.equal((await request('/api/config', 'POST', { teamPhone: '+919033406816' }, tokens.adminA)).status, 403);
    assert.equal((await request('/api/config', 'POST', { teamPhone: '+919033406816' }, tokens.master)).status, 200);
    assert.deepEqual(await (await request('/api/config')).json(), { teamPhone: '+919033406816' });

    // A verified admin may read/write only the canonical society mapped from its membership.
    const ownNotice = await request('/api/notices/Aangan', 'POST', {
        todayMessage: 'Aangan notice', tomorrowMessage: '', date: '2026-11-21'
    }, tokens.adminA);
    assert.equal(ownNotice.status, 200);
    assert.equal((await db.collection('notices').doc('aangan').get()).data().societyId, 'aangan');
    const crossNotice = await request('/api/notices/bloom', 'POST', {
        todayMessage: 'cross-tenant', tomorrowMessage: '', date: '2026-11-21'
    }, tokens.adminA);
    assert.equal(crossNotice.status, 403);
    assert.equal((await crossNotice.json()).code, 'society-scope-forbidden');
    assert.equal((await db.collection('notices').doc('bloom').get()).exists, false);
    assert.equal((await request('/api/vehicles?societyName=Bloom%20Society', 'GET', undefined, tokens.adminA)).status, 403);
    assert.equal((await request('/api/societies/bloom', 'GET', undefined, tokens.adminA)).status, 403);

    // Guards can read their own society data but cannot use admin-only mutation routes.
    const ownGuardDirectory = await request('/api/guards?society=Aangan', 'GET', undefined, tokens.guardA);
    assert.equal(ownGuardDirectory.status, 200);
    assert.equal((await ownGuardDirectory.json()).length, 1);
    assert.equal((await request('/api/notices/Aangan', 'POST', { todayMessage: 'no', date: '2026-11-21' }, tokens.guardA)).status, 403);
    assert.equal((await request('/api/guards?email=admin-b%40example.test', 'GET', undefined, tokens.guardA)).status, 403);

    // Firestore email binding requires a verified email and, if stored, a matching UID.
    assert.equal((await request('/api/notices/Aangan', 'POST', { todayMessage: 'no', date: '2026-11-21' }, tokens.unverified)).status, 403);
    assert.equal((await request('/api/notices/Aangan', 'POST', { todayMessage: 'no', date: '2026-11-21' }, tokens.mismatchedUid)).status, 403);
    const claimSpoof = await exchange('google-admin-a');
    assert.equal((await request('/api/config', 'POST', { teamPhone: '9999999999' }, claimSpoof)).status, 403);

    // Master is the only cross-society role; society admins cannot change master settings.
    assert.equal((await request('/api/societies/bloom/limits', 'PATCH', { max2Wheeler: 3, max4Wheeler: 1 }, tokens.adminA)).status, 403);
    assert.equal((await request('/api/societies/bloom/limits', 'PATCH', { max2Wheeler: 3, max4Wheeler: 1 }, tokens.master)).status, 200);
    assert.equal((await db.collection('societies').doc('bloom').get()).data().max2Wheeler, 3);

    // Device ID preserves the existing resident flow; enrollment constraints are checked transactionally.
    const resident = {
        societyName: 'Aangan', flatNumber: 'A-101', residentType: 'Owner', mobileNumber: '9876543210',
        deviceId: 'device-a', vehicles: [{ vehicleNumber: 'GJ01AB1234', vehicleType: '2-Wheeler' }]
    };
    assert.equal((await request('/api/vehicles', 'POST', resident)).status, 200);
    const savedVehicles = await db.collection('vehicles').get();
    assert.equal(savedVehicles.size, 1);
    assert.equal(savedVehicles.docs[0].data().societyId, 'aangan');
    const adminVehicleList = await request('/api/vehicles?society=Aangan', 'GET', undefined, tokens.adminA);
    const adminVehicleRows = await adminVehicleList.json();
    assert.equal(adminVehicleList.status, 200);
    assert.equal(adminVehicleRows.length, 1);
    assert.ok(adminVehicleRows[0].id);
    assert.equal(adminVehicleRows[0].mobileNumber, '9876543210');
    const guardVehicleLookup = await request('/api/vehicles?society=Aangan&vehicleNumber=GJ01AB1234', 'GET', undefined, tokens.guardA);
    assert.equal((await guardVehicleLookup.json())[0].mobileNumber, '9876543210', 'scoped guards retain lookup fields for their society');
    assert.equal((await request('/api/vehicles?society=Aangan')).status, 400, 'public clients cannot bulk-list a society vehicle collection');
    const flatRead = await request('/api/vehicles?society=Aangan&flatNumber=A-101&deviceId=device-a');
    const flatRows = await flatRead.json();
    assert.equal(flatRows.length, 1);
    assert.equal(flatRows[0].mobileNumber, '9876543210');
    assert.equal(Object.hasOwn(flatRows[0], 'id'), false);
    const wrongDeviceRead = await request('/api/vehicles?society=Aangan&flatNumber=A-101&deviceId=unrelated-device');
    const wrongDeviceRows = await wrongDeviceRead.json();
    assert.deepEqual(wrongDeviceRows, [{ flatNumber: 'A-101', deviceId: { locked: true } }]);
    assert.equal(Object.hasOwn(wrongDeviceRows[0], 'mobileNumber'), false);
    assert.equal(Object.hasOwn(wrongDeviceRows[0], 'vehicleNumber'), false);
    const otherFlatRead = await request('/api/vehicles?society=Aangan&flatNumber=A-102&deviceId=device-a');
    assert.deepEqual(await otherFlatRead.json(), [{ flatNumber: 'A-101', deviceId: 'device-a' }]);
    const plateRead = await request('/api/vehicles?society=Aangan&vehicleNumber=GJ01AB1234');
    assert.deepEqual(await plateRead.json(), [{ vehicleNumber: 'GJ01AB1234', flatNumber: 'A-101' }]);
    const lockedFlat = await request('/api/vehicles', 'POST', { ...resident, flatNumber: 'A-102', vehicles: [{ vehicleNumber: 'GJ02AB1234', vehicleType: '2-Wheeler' }] });
    assert.equal(lockedFlat.status, 409, 'a device cannot register a second flat');
    const lockedDevice = await request('/api/vehicles', 'POST', { ...resident, deviceId: 'device-b', vehicles: [{ vehicleNumber: 'GJ02AB1234', vehicleType: '2-Wheeler' }] });
    assert.equal(lockedDevice.status, 409, 'a flat cannot be claimed from another device');
    const duplicatePlate = await request('/api/vehicles', 'POST', { ...resident, flatNumber: 'A-102', deviceId: 'device-b', vehicles: [{ vehicleNumber: 'GJ01AB1234', vehicleType: '2-Wheeler' }] });
    assert.equal(duplicatePlate.status, 409, 'vehicle numbers are unique in a society');
    const overLimit = await request('/api/vehicles', 'POST', { ...resident, vehicles: [{ vehicleNumber: 'GJ03AB1234', vehicleType: '2-Wheeler' }] });
    assert.equal(overLimit.status, 409, 'vehicle limits are enforced on the server');
    const concurrentRegistrations = await Promise.all(['device-b', 'device-c'].map(deviceId => request('/api/vehicles', 'POST', {
        ...resident, deviceId, flatNumber: 'A-102',
        vehicles: [{ vehicleNumber: 'GJ04AB1234', vehicleType: '4-Wheeler' }]
    })));
    assert.deepEqual(concurrentRegistrations.map(response => response.status).sort(), [200, 409], 'serialized transactions prevent competing flat/device/plate claims');
    const deviceLookup = await request('/api/verify-device/device-a');
    assert.deepEqual(await deviceLookup.json(), { registered: true });
    const deviceSocietyLookup = await request('/api/verify-device/device-a?societyName=Aangan');
    assert.deepEqual(await deviceSocietyLookup.json(), { registered: true, flatNumber: 'A-101' });

    // The contest remains a public resident flow, but server eligibility and one-spin/one-claim rules
    // use the same spoofable device-to-flat registration rather than localStorage alone.
    const spinBody = { societyName: 'Aangan', deviceId: 'device-a', flatNumber: 'A-101', contestId: 'ad-one' };
    const spin = await request('/api/contest/spin', 'POST', spinBody);
    assert.equal(spin.status, 200);
    assert.equal((await spin.json()).won, true);
    assert.equal((await request('/api/contest/spin', 'POST', spinBody)).status, 409);
    const wrongFlat = await request('/api/contest/winner', 'POST', { ...spinBody, flatNumber: 'A-102' });
    assert.equal(wrongFlat.status, 403);
    const claimed = await request('/api/contest/winner', 'POST', spinBody);
    assert.equal(claimed.status, 200);
    assert.deepEqual(await claimed.json(), { success: true, societyName: 'Aangan', flatNumber: 'A-101' });
    assert.equal((await request('/api/contest/winner', 'POST', spinBody)).status, 409);
    const recovered = await request('/api/contest/winner', 'POST', { ...spinBody, recover: true });
    assert.deepEqual(await recovered.json(), { success: true, societyName: 'Aangan', flatNumber: 'A-101' });

    // Legacy rows without a device binding expose only registration counts until enrolled.
    await db.collection('vehicles').doc('legacy-unbound').set({
        societyId: 'aangan', societyName: 'Aangan', flatNumber: 'A-103',
        vehicleNumber: 'GJ05AB1234', vehicleType: '4-Wheeler',
        residentType: 'Owner', mobileNumber: '9123456789'
    });
    app.dataLayer.clearCache();
    const legacyRead = await request('/api/vehicles?society=Aangan&flatNumber=A-103&deviceId=legacy-device');
    const legacyRows = await legacyRead.json();
    assert.deepEqual(legacyRows, [{
        flatNumber: 'A-103', registrationSummary: true, totalRegisteredCount: 1,
        registered2WheelerCount: 0, registered4WheelerCount: 1
    }]);
    const legacyEnroll = await request('/api/vehicles', 'POST', {
        ...resident, deviceId: 'legacy-device', flatNumber: 'A-103',
        vehicles: [{ vehicleNumber: 'GJ06AB1234', vehicleType: '2-Wheeler' }]
    });
    assert.equal(legacyEnroll.status, 200, 'legacy residents can continue enrollment without exposing private fields first');
    const linkedLegacyRead = await request('/api/vehicles?society=Aangan&flatNumber=A-103&deviceId=legacy-device');
    const linkedLegacyRows = await linkedLegacyRead.json();
    assert.equal(linkedLegacyRows.length, 2);
    assert.equal(linkedLegacyRows.some(row => row.mobileNumber === '9123456789'), true);

    // An unconfigured society accepts a typed flat/name in both resident and
    // master-admin flows, persisting the entered name in the Firestore store.
    const residentOpen = await request('/api/vehicles', 'POST', {
        societyName: 'Open Society', flatNumber: 'Shanti Villa', residentType: 'Owner',
        mobileNumber: '9876543210', deviceId: 'open-device',
        vehicles: [{ vehicleNumber: 'GJ01OP1234', vehicleType: '2-Wheeler' }]
    });
    assert.equal(residentOpen.status, 200, await residentOpen.text());
    const masterOpen = await request('/api/vehicles', 'POST', {
        societyName: 'Open Society', flatNumber: 'Lake House', residentType: 'Owner',
        mobileNumber: '9876543210', vehicleNumber: 'GJ01OP5678', vehicleType: '2-Wheeler'
    }, tokens.master);
    assert.equal(masterOpen.status, 200, await masterOpen.text());
    const openVehicles = await db.collection('vehicles').where('societyId', '==', 'open').get();
    assert.deepEqual(openVehicles.docs.map(doc => doc.data().flatNumber).sort(), ['Lake House', 'Shanti Villa']);
    const wrongCaseDevice = await request('/api/vehicles', 'POST', {
        societyName: 'Open Society', flatNumber: 'SHANTI VILLA', residentType: 'Owner',
        mobileNumber: '9876543210', deviceId: 'other-device',
        vehicles: [{ vehicleNumber: 'GJ01ZZ1234', vehicleType: '2-Wheeler' }]
    });
    assert.equal(wrongCaseDevice.status, 409, 'mixed case cannot bypass the flat device lock');
    const otherSocietyAdmin = await request('/api/societies/open/flats', 'PATCH', { flatList: ['A-1'] }, tokens.adminA);
    assert.equal(otherSocietyAdmin.status, 403);
    // The cap is a master-only setting even for an admin in the same society.
    assert.equal((await request('/api/societies/Aangan/vehicle-cap', 'PATCH', { maxTotalVehicles: 10 }, tokens.adminA)).status, 403);
    assert.equal((await request('/api/societies/open/vehicle-cap', 'PATCH', { maxTotalVehicles: 2 }, tokens.master)).status, 200);
    assert.equal((await db.collection('societies').doc('open').get()).data().maxTotalVehicles, 2);
    const capped = await request('/api/vehicles', 'POST', {
        societyName: 'Open Society', flatNumber: 'New Home', residentType: 'Owner', mobileNumber: '9876543210',
        deviceId: 'new-device', vehicles: [{ vehicleNumber: 'GJ01XY9999', vehicleType: '2-Wheeler' }]
    });
    assert.equal(capped.status, 409);
    assert.equal((await capped.json()).code, 'society-vehicle-limit-reached');
    assert.equal((await request('/api/societies/open/vehicle-cap', 'PATCH', { maxTotalVehicles: null }, tokens.master)).status, 200);
    const savedFlats = await request('/api/societies/open/flats', 'PATCH', { flatList: ['A-1', 'Lake House'] }, tokens.master);
    assert.equal(savedFlats.status, 200);
    assert.deepEqual((await db.collection('societies').doc('open').get()).data().flatList, ['A-1', 'Lake House']);
    const denied = await request('/api/vehicles', 'POST', {
        societyName: 'Open Society', flatNumber: 'Not Listed', residentType: 'Owner',
        mobileNumber: '9876543210', deviceId: 'other-device',
        vehicles: [{ vehicleNumber: 'GJ01ZZ1234', vehicleType: '2-Wheeler' }]
    });
    assert.equal(denied.status, 400, 'the configured list is enforced after saving');

    // A master flag cannot override disabled or inactive membership status.
    await db.collection('admins').doc('master@example.test').update({ disabled: true });
    assert.equal((await request('/api/config', 'POST', { teamPhone: '1111111111' }, tokens.master)).status, 403);
    await db.collection('admins').doc('master@example.test').update({ disabled: false, active: false });
    assert.equal((await request('/api/config', 'POST', { teamPhone: '2222222222' }, tokens.master)).status, 403);

    // Membership deletion revokes authority immediately; no cached role/claim survives.
    await db.collection('admins').doc('admin-a@example.test').delete();
    assert.equal((await request('/api/notices/Aangan', 'POST', { todayMessage: 'no', date: '2026-11-21' }, tokens.adminA)).status, 403);

    // Corrupt legacy bindings that place one device on multiple flats fail closed.
    await db.collection('vehicles').doc('conflicting-device').set({
        societyId: 'aangan', societyName: 'Aangan', flatNumber: 'A-103',
        vehicleNumber: 'GJ07AB1234', vehicleType: '2-Wheeler', deviceId: 'device-a'
    });
    app.dataLayer.clearCache();
    const ambiguousDevice = await request('/api/verify-device/device-a?societyName=Aangan');
    assert.deepEqual(await ambiguousDevice.json(), { registered: false });
    const ambiguousFlat = await request('/api/vehicles?society=Aangan&flatNumber=A-101&deviceId=device-a');
    assert.equal((await ambiguousFlat.json())[0].flatNumber, 'A-103');

    const today = require('../server/lib/notices').istDate();
    const contestId = 'manual-winning-contest';
    const attemptId = crypto.createHash('sha256')
        .update(['aangan', today, 'device-a', contestId].join('\\0'))
        .digest('hex');
    await db.collection('contestAttempts').doc(attemptId).set({
        societyId: 'aangan', flatNumber: 'A-101', won: true, claimed: false
    });
    const ambiguousSpin = await request('/api/contest/spin', 'POST', {
        societyName: 'Aangan', deviceId: 'device-a', flatNumber: 'A-101', contestId: 'ambiguous-spin'
    });
    assert.equal(ambiguousSpin.status, 403);
    const ambiguousWinner = await request('/api/contest/winner', 'POST', {
        societyName: 'Aangan', deviceId: 'device-a', flatNumber: 'A-101', contestId
    });
    assert.equal(ambiguousWinner.status, 403);
    assert.equal((await db.collection('contestAttempts').doc(attemptId).get()).data().claimed, false);
});
