'use strict';
// Master-login controls: bulk delete / export-all visibility, per-flat vehicle
// allowance limits on admin edits, the flat-number combobox and society spin
// counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createLocalStore } = require('../server/lib/local-store');

const root = path.join(__dirname, '..');

async function startApi(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-master-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file });
    await db.collection('societies').doc('aangan').set({
        name: 'Aangan', flatList: ['A1-103', 'A1-104', 'B2-201'],
        max4Wheeler: options.max4 === undefined ? 1 : options.max4,
        max2Wheeler: options.max2 === undefined ? 2 : options.max2
    });
    const vehicle = (id, plate, flat, type) => db.collection('vehicles').doc(id).set({
        societyId: 'aangan', societyName: 'Aangan', flatNumber: flat, mobileNumber: '9000000000',
        residentType: 'Owner', vehicleNumber: plate, vehicleType: type, deviceId: null
    });
    await vehicle('v-1', 'GJ01AA1111', 'A1-103', '4-Wheeler');
    await vehicle('v-2', 'GJ01BB2222', 'A1-103', '2-Wheeler');
    await vehicle('v-3', 'GJ01CC3333', 'A1-104', '2-Wheeler');
    if (options.seedSpins) await options.seedSpins(db);

    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'master-login-secret-'.repeat(4),
        DATA_BACKEND: 'local', AUTH_MODE: 'local',
        LOCAL_ADMIN_EMAIL: 'admin@local.test', LOCAL_ADMIN_PASSWORD: 'a-long-testing-password',
        LOCAL_ADMIN_ROLE: options.role || 'admin',
        LOCAL_DB_FILE: file, QUOTA_STATE_FILE: '', QUOTA_ACTION: 'off', QUOTA_SOURCE: 'local',
        APP_CHECK_MODE: 'off', SERVE_STATIC: '0', ENABLE_CRON: '0', READ_CACHE_TTL_MS: '0'
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
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    return {
        db, headers, base,
        async get(pathname) {
            const res = await fetch(base + pathname, { headers });
            return { status: res.status, body: await res.json().catch(() => null) };
        },
        async post(pathname, body) {
            const res = await fetch(base + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
            return { status: res.status, body: await res.json().catch(() => null) };
        }
    };
}

test('the flat list endpoint returns registered flats in natural order with per-flat counts', async (t) => {
    const api = await startApi(t);
    const result = await api.get('/api/societies/Aangan/flats');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.flats, ['A1-103', 'A1-104', 'B2-201']);
    assert.equal(result.body.max4Wheeler, 1);
    assert.equal(result.body.max2Wheeler, 2);
    assert.equal(result.body.counts['A1-103']['4-Wheeler'], 1);
    assert.equal(result.body.counts['A1-103']['2-Wheeler'], 1);
    assert.equal(result.body.counts['A1-104']['2-Wheeler'], 1);
});

test('an admin add is refused when the flat is already at its 4-wheeler limit', async (t) => {
    const api = await startApi(t, { max4: 1, max2: 2 });
    const blocked = await api.post('/api/vehicles', {
        societyName: 'Aangan', vehicleNumber: 'GJ01DD4444', flatNumber: 'A1-103',
        residentType: 'Owner', mobileNumber: '9000000000', vehicleType: '4-Wheeler'
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.code, 'vehicle-limit-reached');
    assert.match(blocked.body.error, /allowance in Aangan/);

    // A different flat / type with room is still allowed.
    const allowed = await api.post('/api/vehicles', {
        societyName: 'Aangan', vehicleNumber: 'GJ01DD4444', flatNumber: 'B2-201',
        residentType: 'Owner', mobileNumber: '9000000000', vehicleType: '4-Wheeler'
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

    // ...and the flat that just filled up refuses the next 2-wheeler beyond 2.
    await api.post('/api/vehicles', {
        societyName: 'Aangan', vehicleNumber: 'GJ01EE5555', flatNumber: 'B2-201',
        residentType: 'Owner', mobileNumber: '9000000000', vehicleType: '2-Wheeler'
    });
    await api.post('/api/vehicles', {
        societyName: 'Aangan', vehicleNumber: 'GJ01FF6666', flatNumber: 'B2-201',
        residentType: 'Owner', mobileNumber: '9000000000', vehicleType: '2-Wheeler'
    });
    const thirdBike = await api.post('/api/vehicles', {
        societyName: 'Aangan', vehicleNumber: 'GJ01GG7777', flatNumber: 'B2-201',
        residentType: 'Owner', mobileNumber: '9000000000', vehicleType: '2-Wheeler'
    });
    assert.equal(thirdBike.status, 409);
    assert.match(thirdBike.body.error, /2-Wheeler/);
});

test('raising the allowance lets the next vehicle in, and lowering it blocks it again', async (t) => {
    const api = await startApi(t, { max4: 2, max2: 2 });
    const add = plate => api.post('/api/vehicles', {
        societyName: 'Aangan', vehicleNumber: plate, flatNumber: 'A1-104',
        residentType: 'Owner', mobileNumber: '9000000000', vehicleType: '4-Wheeler'
    });
    assert.equal((await add('GJ01HH8888')).status, 200);
    assert.equal((await add('GJ01II9999')).status, 200, 'two cars fit under a limit of 2');
    assert.equal((await add('GJ01JJ0000')).status, 409, 'the third does not');

    const lowered = await (await fetch(`${api.base}/api/societies/aangan/limits`, {
        method: 'PATCH', headers: api.headers, body: JSON.stringify({ max4Wheeler: 1, max2Wheeler: 2 })
    })).json();
    assert.equal(lowered.success, true);
    assert.equal((await add('GJ01KK1111')).status, 409);
});

test('editing a vehicle that keeps its slot is not blocked by a full flat', async (t) => {
    const api = await startApi(t, { max4: 1, max2: 2 });
    // v-1 is the flat's only car and the allowance is 1: changing just the mobile
    // number must still work.
    const edited = await api.post('/api/vehicles', {
        id: 'v-1', societyName: 'Aangan', vehicleNumber: 'GJ01AA1111', flatNumber: 'A1-103',
        residentType: 'Owner', mobileNumber: '9812345678', vehicleType: '4-Wheeler'
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    // Moving a 4-wheeler into a flat that already holds one is still refused.
    const moved = await api.post('/api/vehicles', {
        id: 'v-2', societyName: 'Aangan', vehicleNumber: 'GJ01BB2222', flatNumber: 'A1-103',
        residentType: 'Owner', mobileNumber: '9000000000', vehicleType: '4-Wheeler'
    });
    assert.equal(moved.status, 409);
});

test('an unknown flat is refused so the dropdown is the source of truth', async (t) => {
    const api = await startApi(t);
    const result = await api.post('/api/vehicles', {
        societyName: 'Aangan', vehicleNumber: 'GJ01LL2222', flatNumber: 'Z-999',
        residentType: 'Owner', mobileNumber: '9000000000', vehicleType: '2-Wheeler'
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /Flat is not registered/);
});

test('spin counts report lifetime, today and month totals for the society', async (t) => {
    const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const api = await startApi(t, {
        role: 'master',
        seedSpins: async (db) => {
            await db.collection('spinStats').doc(`aangan_${day(-40)}`).set({ societyId: 'aangan', societyName: 'Aangan', spinCount: 5, date: day(-40) });
            await db.collection('spinStats').doc(`aangan_${day(-1)}`).set({ societyId: 'aangan', societyName: 'Aangan', spinCount: 3, date: day(-1) });
            await db.collection('spinStats').doc(`aangan_${day(0)}`).set({ societyId: 'aangan', societyName: 'Aangan', spinCount: 4, date: day(0) });
            await db.collection('winners').doc('w-1').set({
                societyId: 'aangan', societyName: 'Aangan', flatNumber: 'A1-104', winnerFlatnumber: 'A1-104',
                createdAt: new Date().toISOString()
            });
        }
    });
    const result = await api.get('/api/contest/spinstats?societyName=Aangan');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.totalLifetimeSpins, 12, 'lifetime sums every day');
    assert.equal(result.body.totalSpins, 12);
    assert.equal(result.body.totalDaySpins, 4, "today's count only");
    assert.equal(result.body.totalMonthSpins, 0 + (day(-1).slice(0, 7) === day(0).slice(0, 7) ? 3 : 0) + 4);
    assert.equal(result.body.winnerFlat, 'A1-104');
});

// --- Browser side ---------------------------------------------------------
function loadAdmin(t, { isMaster = true, flats = ['A1-103', 'A1-104', 'B2-201'] } = {}) {
    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/admin.html',
        runScripts: 'outside-only',
        beforeParse(win) { win.HTMLCanvasElement.prototype.getContext = () => null; }
    });
    const { window } = dom;
    const calls = [];
    window.OWL_API_BASE = 'https://api.test/api';
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        calls.push({ pathname: parsed.pathname, body: options.body ? JSON.parse(options.body) : null, method: options.method || 'GET' });
        if (parsed.pathname.endsWith('/config')) return { ok: true, json: async () => ({ teamPhone: '917567184961' }) };
        if (parsed.pathname.endsWith('/flats')) return { ok: true, json: async () => ({ society: 'Aangan', flats, max4Wheeler: 1, max2Wheeler: 2, counts: {} }) };
        if (parsed.pathname.endsWith('/vehicles') && (options.method || 'GET') === 'POST') {
            if (window.__saveReject) return { ok: false, status: 409, json: async () => window.__saveReject };
            return { ok: true, json: async () => ({ success: true }) };
        }
        if (parsed.pathname.endsWith('/vehicles')) return { ok: true, json: async () => [] };
        return { ok: true, json: async () => [] };
    };
    const source = fs.readFileSync(path.join(root, 'admin-logic.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^const API_BASE_URL = .*$/m, 'var API_BASE_URL = window.OWL_API_BASE;')
        .replace(/^const NG_HEADERS = .*$/m, 'var NG_HEADERS = {};')
        .replace('let assignedSociety = "";', 'var assignedSociety = "Aangan";')
        .replace('let isMasterAdminUser = false;', `var isMasterAdminUser = ${isMaster};`);
    window.eval(`
        var authenticatedFetch = window.fetch;
        var auth = { currentUser: { getIdToken: async () => 't' } };
        var signInWithEmailAndPassword = async () => {};
        var signOut = async () => {};
        var onAuthStateChanged = () => {};
        var sendPasswordResetEmail = async () => {};
        var Filesystem = {}; var Directory = {}; var Encoding = {}; var Share = { share: async () => {} };
        ${source}
    `);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    t.after(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        dom.window.close();
    });
    return { window, doc: window.document, calls };
}

test('bulk delete and export all data are hidden until the master login reveals them', (t) => {
    const { window, doc } = loadAdmin(t);
    const bulkDelete = doc.getElementById('bulkDeleteTopBtn');
    const exportBtn = doc.getElementById('exportBtn');
    const bulkSection = doc.getElementById('bulk-section');

    // Every master tool starts hidden in the markup itself, so a society admin's
    // page never flashes them.
    assert.match(bulkDelete.getAttribute('style') || '', /display:\s*none/);
    assert.equal(bulkDelete.hasAttribute('data-master-only'), true);
    assert.equal(exportBtn.hasAttribute('data-master-only'), true);
    assert.match(bulkSection.getAttribute('style') || '', /display:\s*none/);

    window.OwAdminMasterTools.applyMasterOnlyVisibility(false);
    assert.equal(bulkDelete.style.display, 'none', 'society admin never sees bulk delete');
    assert.equal(exportBtn.style.display, 'none', 'society admin never sees export all data');

    window.OwAdminMasterTools.applyMasterOnlyVisibility(true);
    assert.notEqual(bulkDelete.style.display, 'none', 'master sees bulk delete');
    assert.notEqual(exportBtn.style.display, 'none', 'master sees export all data');
    assert.equal(bulkSection.style.display, 'block');
});

test('the flat field is a dropdown filled from the society flat numbers', async (t) => {
    const { window, doc, calls } = loadAdmin(t, { flats: ['A1-103', 'A1-104', 'B2-201'] });
    const input = doc.getElementById('fNum');
    assert.equal(input.getAttribute('list'), 'flatNumberOptions');
    assert.equal(calls.length, 0, 'nothing is fetched before a login resolves');

    await window.OwAdminFlats.loadSocietyFlats();
    assert.ok(calls.some(call => call.pathname.endsWith('/societies/Aangan/flats')), 'the flat list is fetched');
    const options = [...doc.querySelectorAll('#flatNumberOptions option')].map(option => option.value);
    assert.deepEqual(options, ['A1-103', 'A1-104', 'B2-201']);
    assert.match(doc.getElementById('fNumHint').textContent, /3 registered flat number/);
});

test('a typed flat that is not registered is refused before saving', async (t) => {
    const { window, doc, calls } = loadAdmin(t);
    await window.OwAdminFlats.loadSocietyFlats();
    doc.getElementById('vNum').value = 'GJ01XY1234';
    doc.getElementById('fNum').value = 'Z-999';
    doc.getElementById('mNum').value = '9000000000';
    doc.getElementById('saveBtn').click();
    await new Promise(resolve => setTimeout(resolve, 80));

    assert.match(doc.getElementById('modalMessage').textContent, /Z-999 is not a registered flat in Aangan/);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, 'nothing is written');
});

test('a limit error from the API is shown with the allowance explanation', async (t) => {
    const { window, doc } = loadAdmin(t);
    await window.OwAdminFlats.loadSocietyFlats();
    window.__saveReject = {
        error: 'This flat already has 1 4-Wheeler(s), the allowance in Aangan. Increase the limit under vehicle allowance limits first.',
        code: 'vehicle-limit-reached'
    };
    doc.getElementById('vNum').value = 'GJ01XY1234';
    doc.getElementById('fNum').value = 'a1-104'; // case/space tolerant match
    doc.getElementById('vType').value = '4-Wheeler';
    doc.getElementById('mNum').value = '9000000000';
    doc.getElementById('saveBtn').click();
    await new Promise(resolve => setTimeout(resolve, 120));

    const message = doc.getElementById('modalMessage').textContent;
    assert.match(message, /allowance in Aangan/);
    assert.match(message, /vehicle allowance limits/i);
    assert.equal(message.match(/allowance in Aangan/g).length, 1, 'the reason is not repeated');
    assert.doesNotMatch(message, /^Failed to save vehicle/);
});

test('saving with a flat from the dropdown goes through', async (t) => {
    const { window, doc, calls } = loadAdmin(t);
    await window.OwAdminFlats.loadSocietyFlats();
    doc.getElementById('vNum').value = 'gj01xy1234';
    doc.getElementById('fNum').value = 'b2-201';
    doc.getElementById('mNum').value = '9000000000';
    doc.getElementById('saveBtn').click();
    await new Promise(resolve => setTimeout(resolve, 120));

    const save = calls.find(call => call.method === 'POST');
    assert.ok(save, 'the vehicle is saved');
    assert.equal(save.body.flatNumber, 'B2-201', 'the stored casing of the flat is used');
});
