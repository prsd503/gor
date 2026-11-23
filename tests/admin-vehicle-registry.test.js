'use strict';
// Admin portal: vehicle search must show the Firestore record (flat, mobile)
// with edit/delete, and add/edit must update the existing document when the
// plate already exists in the assigned society, otherwise create a new one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

function loadAdmin(t, { society = 'Aangan', vehicles = [], searchResult } = {}) {
    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/admin.html',
        runScripts: 'outside-only',
        beforeParse(win) {
            win.confirm = () => true;
            win.__modal = [];
            win.HTMLCanvasElement.prototype.getContext = () => null;
        }
    });
    const { window } = dom;
    const calls = [];
    window.OWL_API_BASE = 'https://api.test/api';
    window.alert = () => {};
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        calls.push({ url: parsed, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
        if (parsed.pathname.endsWith('/config')) return { ok: true, json: async () => ({ teamPhone: '917567184961' }) };
        if (parsed.pathname.includes('/vehicles/') && (options.method || 'GET') === 'DELETE') {
            return { ok: true, json: async () => ({ success: true }) };
        }
        if (parsed.pathname.endsWith('/vehicles') && (options.method || 'GET') === 'POST') {
            window.__lastVehicleWrite = JSON.parse(options.body);
            return { ok: true, json: async () => ({ success: true }) };
        }
        if (parsed.pathname.endsWith('/vehicles')) {
            const plate = (parsed.searchParams.get('vehicleNumber') || '').toUpperCase();
            const rows = searchResult !== undefined ? searchResult : vehicles.filter(v => !plate || v.vehicleNumber === plate);
            return { ok: true, json: async () => rows };
        }
        if (parsed.pathname.endsWith('/auth/token')) return { ok: true, json: async () => ({ token: 't' }) };
        return { ok: true, json: async () => [] };
    };

    // Strip the browser-only imports and inject the module's dependencies.
    const source = fs.readFileSync(path.join(root, 'admin-logic.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^const API_BASE_URL = .*$/m, 'var API_BASE_URL = window.OWL_API_BASE;')
        .replace(/^const NG_HEADERS = .*$/m, "var NG_HEADERS = { 'ngrok-skip-browser-warning': 'true' };")
        .replace('let assignedSociety = "";', `var assignedSociety = ${JSON.stringify(society)};`);
    window.eval(`
        var authenticatedFetch = window.fetch;
        var signInWithEmailAndPassword = async () => {};
        var signOut = async () => {};
        var onAuthStateChanged = () => {};
        var sendPasswordResetEmail = async () => {};
        var Filesystem = {}; var Directory = {}; var Encoding = {}; var Share = { share: async () => {} };
        ${source}
    `);
    t.after(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        dom.window.close();
    });
    const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
    return { window, doc: window.document, calls, settle };
}

const sample = {
    id: 'yoUtwBhYTKkPJQPMh9ze', vehicleNumber: 'GJ06PA6591', flatNumber: 'A1-103',
    vehicleType: '4-Wheeler', residentType: 'Tenant', mobileNumber: '9033406816', deviceId: null
};

test('searching a plate shows flat number, mobile number and edit/delete actions', async (t) => {
    const view = loadAdmin(t, { vehicles: [sample] });
    view.doc.getElementById('adminSearch').value = 'gj06pa6591';
    view.doc.getElementById('adminSearchBtn').click();
    await view.settle();

    const searchCall = view.calls.find(c => c.method === 'GET' && c.url.pathname.endsWith('/vehicles'));
    assert.ok(searchCall, 'the search hits the vehicle API');
    assert.equal(searchCall.url.searchParams.get('societyName'), 'Aangan', 'scoped to the admin society');
    assert.equal(searchCall.url.searchParams.get('vehicleNumber'), 'GJ06PA6591');

    const html = view.doc.getElementById('admin-results').innerHTML;
    assert.match(html, /GJ06PA6591/);
    assert.match(html, /A1-103/, 'flat number is shown');
    assert.match(html, /9033406816/, 'mobile number is shown');
    assert.match(html, /data-action="edit"/, 'edit action is offered');
    assert.match(html, /data-action="delete"/, 'delete action is offered');
});

test('search results escape record values instead of injecting markup', async (t) => {
    const view = loadAdmin(t, { searchResult: [{ ...sample, flatNumber: '<img src=x onerror=alert(1)>' }] });
    view.doc.getElementById('adminSearch').value = 'GJ06PA6591';
    view.doc.getElementById('adminSearchBtn').click();
    await view.settle();
    const html = view.doc.getElementById('admin-results').innerHTML;
    assert.ok(!html.includes('<img src=x'), 'record text is escaped');
    assert.match(html, /&lt;img/);
});

test('edit fills the form from the searched record, and delete removes that document', async (t) => {
    const view = loadAdmin(t, { vehicles: [sample] });
    view.doc.getElementById('adminSearch').value = 'GJ06PA6591';
    view.doc.getElementById('adminSearchBtn').click();
    await view.settle();

    view.doc.querySelector('[data-action="edit"]').click();
    assert.equal(view.doc.getElementById('vNum').value, 'GJ06PA6591');
    assert.equal(view.doc.getElementById('fNum').value, 'A1-103');
    assert.equal(view.doc.getElementById('rType').value, 'Tenant');
    assert.equal(view.doc.getElementById('vType').value, '4-Wheeler');
    assert.equal(view.doc.getElementById('mNum').value, '9033406816');

    view.doc.querySelector('[data-action="delete"]').click();
    await view.settle();
    const del = view.calls.find(c => c.method === 'DELETE');
    assert.ok(del, 'delete calls the API');
    assert.equal(del.url.pathname, '/api/vehicles/yoUtwBhYTKkPJQPMh9ze', 'the record id is the one from Firestore');
    assert.match(view.doc.getElementById('admin-results').innerHTML, /was deleted/);
});

test('saving an existing plate updates that document, saving a new plate adds one', async (t) => {
    const view = loadAdmin(t, { vehicles: [sample] });

    // Existing plate: edit the existing Firestore document.
    view.doc.getElementById('vNum').value = 'GJ06PA6591';
    view.doc.getElementById('fNum').value = 'A1-103';
    view.doc.getElementById('rType').value = 'Owner';
    view.doc.getElementById('vType').value = '4-Wheeler';
    view.doc.getElementById('mNum').value = '9876543210';
    view.doc.getElementById('saveBtn').click();
    await view.settle();
    const updated = view.window.__lastVehicleWrite;
    assert.equal(updated.id, 'yoUtwBhYTKkPJQPMh9ze', 'the existing record id is reused');
    assert.equal(updated.vehicleNumber, 'GJ06PA6591');
    assert.equal(updated.residentType, 'Owner');
    assert.equal(updated.societyName, 'Aangan', 'never written to another society');
    assert.match(view.doc.getElementById('modalMessage').textContent, /updated/);

    // New plate: create a document instead.
    view.window.__lastVehicleWrite = null;
    view.doc.getElementById('vNum').value = 'GJ01AB1234';
    view.doc.getElementById('fNum').value = 'A1-104';
    view.doc.getElementById('rType').value = 'Owner';
    view.doc.getElementById('vType').value = '2-Wheeler';
    view.doc.getElementById('mNum').value = '9876543210';
    view.doc.getElementById('saveBtn').click();
    await view.settle();
    const created = view.window.__lastVehicleWrite;
    assert.equal(created.id, null, 'no id means the API creates a new record');
    assert.equal(created.vehicleNumber, 'GJ01AB1234');
    assert.match(view.doc.getElementById('modalMessage').textContent, /added to the Aangan registry/);
});

test('the save form rejects bad input before writing', async (t) => {
    const view = loadAdmin(t, { vehicles: [] });
    view.doc.getElementById('vNum').value = 'GJ01AB1234';
    view.doc.getElementById('fNum').value = '';
    view.doc.getElementById('saveBtn').click();
    await view.settle();
    assert.equal(view.window.__lastVehicleWrite, undefined, 'nothing is written without a flat');
    assert.match(view.doc.getElementById('modalMessage').textContent, /required/i);
});

test('the admin vehicle form offers the vehicle types the API accepts', () => {
    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    for (const type of ['2-Wheeler', '3-Wheeler', '4-Wheeler']) {
        assert.match(html, new RegExp(`<option value="${type}">`), `${type} is selectable`);
    }
    const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
    assert.match(server, /const VEHICLE_TYPES = \['2-Wheeler', '3-Wheeler', '4-Wheeler'\]/, 'the API accepts the same types');
});

// --- API level: the registry write the admin form calls ---------------------
const { createLocalStore } = require('../server/lib/local-store');
const os = require('node:os');

async function startApi(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-admin-registry-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file });
    await db.collection('societies').doc('aangan').set({ name: 'Aangan', flatList: ['A1-103', 'A1-104'] });
    await db.collection('societies').doc('other').set({ name: 'Other', flatList: ['B-1'] });
    await db.collection('vehicles').doc('yoUtwBhYTKkPJQPMh9ze').set({
        createdAt: '2026-10-13T11:35:01.000Z', deviceId: null, flatNumber: 'A1-103',
        mobileNumber: '9033406816', residentType: 'Tenant', societyName: 'Aangan',
        updatedAt: '2026-10-15T04:15:51.000Z', vehicleNumber: 'GJ06PA6591', vehicleType: '4-Wheeler'
    });
    await db.collection('vehicles').doc('other-vehicle').set({
        deviceId: null, flatNumber: 'B-1', mobileNumber: '9000000000', residentType: 'Owner',
        societyName: 'Other', vehicleNumber: 'GJ02XY0001', vehicleType: '2-Wheeler'
    });
    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'admin-registry-secret-'.repeat(3),
        DATA_BACKEND: 'local', AUTH_MODE: 'local',
        LOCAL_ADMIN_EMAIL: 'admin@local.test', LOCAL_ADMIN_PASSWORD: 'a-long-testing-password',
        LOCAL_DB_FILE: file, QUOTA_STATE_FILE: '', QUOTA_ACTION: 'off', QUOTA_SOURCE: 'local',
        APP_CHECK_MODE: 'off', SERVE_STATIC: '0', ENABLE_CRON: '0', READ_CACHE_TTL_MS: '0'
    });
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (name, ...args) {
        if (name.startsWith('firebase-admin')) throw new Error('Firebase must not load locally');
        return original.call(this, name, ...args);
    };
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
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    return {
        db,
        async get(url) {
            const res = await fetch(base + url, { headers: auth });
            return { status: res.status, body: await res.json().catch(() => null) };
        },
        async post(body) {
            const res = await fetch(base + '/api/vehicles', { method: 'POST', headers: auth, body: JSON.stringify(body) });
            return { status: res.status, body: await res.json().catch(() => null) };
        }
    };
}

test('the API search returns the Firestore record fields the admin UI shows', async (t) => {
    const api = await startApi(t);
    const found = await api.get('/api/vehicles?societyName=Aangan&vehicleNumber=GJ06PA6591');
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, [{
        id: 'yoUtwBhYTKkPJQPMh9ze', vehicleNumber: 'GJ06PA6591', flatNumber: 'A1-103',
        vehicleType: '4-Wheeler', residentType: 'Tenant', mobileNumber: '9033406816', deviceId: null
    }]);
    // Another society's record is never returned.
    const other = await api.get('/api/vehicles?societyName=Aangan&vehicleNumber=GJ02XY0001');
    assert.deepEqual(other.body, []);
});

test('the API updates an existing vehicle and adds a new one in the assigned society', async (t) => {
    const api = await startApi(t);

    const edited = await api.post({
        id: 'yoUtwBhYTKkPJQPMh9ze', vehicleNumber: 'GJ06PA6591', flatNumber: 'A1-103',
        residentType: 'Owner', mobileNumber: '9876543210', vehicleType: '3-Wheeler', societyName: 'Aangan'
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    // Read back through the API: the same document id must carry the edit.
    const afterEdit = await api.get('/api/vehicles?societyName=Aangan&vehicleNumber=GJ06PA6591');
    assert.equal(afterEdit.body.length, 1, 'the edit updated the record, it did not duplicate it');
    const doc = afterEdit.body[0];
    assert.equal(doc.id, 'yoUtwBhYTKkPJQPMh9ze');
    assert.equal(doc.residentType, 'Owner');
    assert.equal(doc.mobileNumber, '9876543210');
    assert.equal(doc.vehicleType, '3-Wheeler', 'the form offers 3-Wheeler and the API accepts it');
    assert.equal(doc.vehicleNumber, 'GJ06PA6591');

    const added = await api.post({
        id: null, vehicleNumber: 'GJ01AB1234', flatNumber: 'A1-104',
        residentType: 'Owner', mobileNumber: '9876543210', vehicleType: '2-Wheeler', societyName: 'Aangan'
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const all = await api.get('/api/vehicles?societyName=Aangan');
    assert.equal(all.body.length, 2, 'the new plate became a second record in this society');
    assert.ok(all.body.some(v => v.vehicleNumber === 'GJ01AB1234' && v.flatNumber === 'A1-104'));
});

test('the API refuses a flat that is not registered in the society', async (t) => {
    const api = await startApi(t);
    const rejected = await api.post({
        id: null, vehicleNumber: 'GJ01AB9999', flatNumber: 'Z9-999',
        residentType: 'Owner', mobileNumber: '9876543210', vehicleType: '2-Wheeler', societyName: 'Aangan'
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /Flat is not registered/);
});
