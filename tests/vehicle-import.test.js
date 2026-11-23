'use strict';
// Bulk vehicle import: the uploaded CSV must reach Firestore for the logged-in
// admin's society, skip vehicles that already exist, and report exactly how many
// were added, updated, repeated and rejected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createLocalStore } = require('../server/lib/local-store');

const root = path.join(__dirname, '..');

async function startApi(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-import-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file });
    await db.collection('societies').doc('aangan').set({ name: 'Aangan', flatList: ['A1-103', 'A1-104', 'B-201'] });
    await db.collection('societies').doc('other').set({ name: 'Other', flatList: ['C-1'] });
    await db.collection('vehicles').doc('existing-1').set({
        societyId: 'aangan', societyName: 'Aangan', flatNumber: 'A1-103', mobileNumber: '9033406816',
        residentType: 'Tenant', vehicleNumber: 'GJ06PA6591', vehicleType: '4-Wheeler', deviceId: null
    });
    await db.collection('vehicles').doc('device-linked').set({
        societyId: 'aangan', societyName: 'Aangan', flatNumber: 'A1-104', mobileNumber: '9000000000',
        residentType: 'Owner', vehicleNumber: 'GJ05DL1111', vehicleType: '2-Wheeler', deviceId: 'dev-1'
    });
    await db.collection('vehicles').doc('other-1').set({
        societyName: 'Other', flatNumber: 'C-1', mobileNumber: '9111111111',
        residentType: 'Owner', vehicleNumber: 'GJ02XY0001', vehicleType: '2-Wheeler'
    });
    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'vehicle-import-secret-'.repeat(3),
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
    // Each test gets its own server and store, so drop the cached modules.
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
        db,
        async import(rows, society = 'Aangan') {
            const res = await fetch(base + '/api/vehicles/import', {
                method: 'POST', headers, body: JSON.stringify({ society, rows })
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        },
        async vehicles(society = 'Aangan') {
            const res = await fetch(`${base}/api/vehicles?societyName=${encodeURIComponent(society)}`, { headers });
            return res.json();
        }
    };
}

const row = (vehicleNumber, flatNumber, extra = {}) => ({ vehicleNumber, flatNumber, ...extra });

test('import adds new vehicles, updates changed ones and skips existing ones with a report', async (t) => {
    const api = await startApi(t);

    const imports = await api.import([
        // already stored with identical data -> repeat
        row('GJ06PA6591', 'A1-103', { residentType: 'Tenant', mobileNumber: '9033406816', vehicleType: '4-Wheeler' }),
        // brand new
        row('GJ01AB1234', 'B-201', { residentType: 'Owner', mobileNumber: '9812345678', vehicleType: '2-Wheeler' }),
        // duplicated inside the same file -> repeat
        row('GJ01AB1234', 'B-201', { residentType: 'Owner' }),
        // another society's existing plate is not this society's -> added here
        row('GJ02XY0001', 'A1-104', { residentType: 'Owner', mobileNumber: '9111111111', vehicleType: '2-Wheeler' }),
        // unknown flat -> rejected
        row('GJ09ZZ9999', 'Z-9', { residentType: 'Owner' }),
        // missing plate -> rejected
        row('', 'A1-103')
    ]);

    assert.equal(imports.status, 200, JSON.stringify(imports.body));
    const summary = imports.body;
    assert.equal(summary.society, 'Aangan');
    assert.equal(summary.total, 6);
    assert.equal(summary.added, 2, 'the new plate and the other society plate are added here');
    assert.equal(summary.updated, 0, 'nothing in this file changes a stored record');
    assert.equal(summary.repeat, 2, 'identical row and in-file duplicate are skipped');
    assert.equal(summary.rejected, 2, 'unknown flat and missing plate are rejected');
    assert.equal(summary.added + summary.updated + summary.repeat + summary.rejected, summary.total, 'every row is accounted for');

    const actionsFor = plate => summary.changes.filter(change => change.plate === plate).map(change => change.action);
    assert.deepEqual(actionsFor('GJ01AB1234'), ['added', 'repeat'], 'the in-file duplicate is reported against that plate');
    assert.deepEqual(actionsFor('GJ02XY0001'), ['added']);
    assert.deepEqual(actionsFor('GJ06PA6591'), ['repeat']);
    assert.ok(summary.errors.some(error => /not registered in Aangan/.test(error.reason)));
    assert.ok(summary.errors.some(error => /Missing vehicle number/.test(error.reason)));

    const vehicles = await api.vehicles('Aangan');
    const plates = vehicles.map(vehicle => vehicle.vehicleNumber).sort();
    assert.deepEqual(plates, ['GJ01AB1234', 'GJ02XY0001', 'GJ05DL1111', 'GJ06PA6591'].sort());
    // The existing record kept its data and id.
    const unchanged = vehicles.find(vehicle => vehicle.vehicleNumber === 'GJ06PA6591');
    assert.equal(unchanged.id, 'existing-1');
    assert.equal(unchanged.mobileNumber, '9033406816', 'the duplicate row was left alone');
    // The other society is untouched.
    const other = await api.vehicles('Other');
    assert.deepEqual(other.map(v => v.vehicleNumber), ['GJ02XY0001']);
});

test('an existing plate with changed details is updated in place', async (t) => {
    const api = await startApi(t);
    const result = await api.import([
        row('GJ06PA6591', 'B-201', { residentType: 'Owner', mobileNumber: '9876543210', vehicleType: '3-Wheeler' })
    ]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.updated, 1);
    assert.equal(result.body.added, 0, 'the plate already exists, so nothing is duplicated');
    assert.equal(result.body.changes[0].action, 'updated');

    const vehicles = await api.vehicles('Aangan');
    const record = vehicles.find(vehicle => vehicle.vehicleNumber === 'GJ06PA6591');
    assert.equal(record.id, 'existing-1', 'the same Firestore document is updated');
    assert.equal(record.flatNumber, 'B-201');
    assert.equal(record.residentType, 'Owner');
    assert.equal(record.mobileNumber, '9876543210');
    assert.equal(record.vehicleType, '3-Wheeler');
});

test('re-importing the same file changes nothing and reports every row as a duplicate', async (t) => {
    const api = await startApi(t);
    const rows = [
        row('GJ01AB1234', 'B-201', { residentType: 'Owner', mobileNumber: '9812345678', vehicleType: '2-Wheeler' }),
        row('GJ06PA6591', 'A1-103', { residentType: 'Tenant', mobileNumber: '9033406816', vehicleType: '4-Wheeler' })
    ];
    const first = await api.import(rows);
    assert.equal(first.body.added, 1, JSON.stringify(first.body));
    assert.equal(first.body.repeat, 1);
    const existing = (await api.vehicles('Aangan')).find(vehicle => vehicle.vehicleNumber === 'GJ06PA6591');
    assert.equal(existing.mobileNumber, '9033406816', 'the duplicate row kept the stored record intact');

    const second = await api.import(rows);
    assert.equal(second.body.added, 0, 'the already imported plate is not duplicated');
    assert.equal(second.body.updated, 0, 'nothing changed, so nothing is written');
    assert.equal(second.body.repeat, 2, 'both rows are reported as duplicates');
    const vehicles = await api.vehicles('Aangan');
    assert.equal(vehicles.filter(vehicle => vehicle.vehicleNumber === 'GJ01AB1234').length, 1);
});

test('import never moves a device-linked vehicle to another flat', async (t) => {
    const api = await startApi(t);
    const result = await api.import([row('GJ05DL1111', 'B-201', { residentType: 'Owner' })]);
    assert.equal(result.body.rejected, 1);
    assert.match(result.body.errors[0].reason, /device-linked/i);
    const vehicles = await api.vehicles('Aangan');
    const linked = vehicles.find(vehicle => vehicle.vehicleNumber === 'GJ05DL1111');
    assert.equal(linked.flatNumber, 'A1-104', 'the resident registration is untouched');
});

test('import rejects a body without rows', async (t) => {
    const api = await startApi(t);
    const empty = await api.import([]);
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /no vehicle rows/i);
});

// --- Browser side ---------------------------------------------------------
function loadAdmin(t) {
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
        calls.push({ url: parsed, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
        if (parsed.pathname.endsWith('/config')) return { ok: true, json: async () => ({ teamPhone: '917567184961' }) };
        if (parsed.pathname.endsWith('/vehicles/import')) {
            window.__importBody = JSON.parse(options.body);
            return {
                ok: true, json: async () => ({
                    success: true, society: 'Aangan', total: 3, added: 1, updated: 1, repeat: 1, rejected: 0,
                    changes: [
                        { line: 1, plate: 'GJ01AB1234', action: 'added', flat: 'B-201' },
                        { line: 2, plate: 'GJ06PA6591', action: 'updated', flat: 'A1-103' },
                        { line: 3, plate: 'GJ02XY0001', action: 'repeat', reason: 'Already stored with the same details.' }
                    ],
                    errors: []
                })
            };
        }
        return { ok: true, json: async () => [] };
    };
    const source = fs.readFileSync(path.join(root, 'admin-logic.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^const API_BASE_URL = .*$/m, 'var API_BASE_URL = window.OWL_API_BASE;')
        .replace(/^const NG_HEADERS = .*$/m, 'var NG_HEADERS = {};')
        .replace('let assignedSociety = "";', 'var assignedSociety = "Aangan";');
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

const QUOTED_CSV = 'VehicleNumber,FlatNumber/Name,ResidentType,MobileNumber,VehicleType\r\n' +
    '"GJ01AB1234","B-201","Owner","9812345678","2-Wheeler"\r\n' +
    'GJ06PA6591,A1-103,Tenant,9033406816,4-Wheeler\r\n';

test('the CSV reader handles quoted fields, CRLF and any column order', (t) => {
    const { window } = loadAdmin(t);
    const parsed = window.OwAdminVehicles.parseVehicleCsv(QUOTED_CSV);
    assert.equal(parsed.length, 2);
    // Objects come from the page's realm, so compare their shape as plain data.
    assert.deepEqual({ ...parsed[0] }, {
        vehicleNumber: 'GJ01AB1234', flatNumber: 'B-201', residentType: 'Owner',
        mobileNumber: '9812345678', vehicleType: '2-Wheeler'
    });
    assert.equal(parsed[1].vehicleNumber, 'GJ06PA6591');

    const reordered = window.OwAdminVehicles.parseVehicleCsv(
        'MobileNumber,FlatNumber/Name,VehicleType,VehicleNumber,ResidentType\n9812345678,B-201,2-Wheeler,GJ01AB1234,Owner\n'
    );
    assert.deepEqual({ ...reordered[0] }, {
        vehicleNumber: 'GJ01AB1234', flatNumber: 'B-201', residentType: 'Owner',
        mobileNumber: '9812345678', vehicleType: '2-Wheeler'
    });

    // Headerless files keep the documented template order.
    const headerless = window.OwAdminVehicles.parseVehicleCsv('GJ01AB1234,B-201,Owner,9812345678,2-Wheeler\n');
    assert.equal(headerless[0].flatNumber, 'B-201');

    // A quoted comma inside a value is not a column break.
    const comma = window.OwAdminVehicles.parseVehicleCsv('VehicleNumber,FlatNumber/Name\nGJ01AB1234,"B-201, Tower 2"\n');
    assert.equal(comma[0].flatNumber, 'B-201, Tower 2');
});

test('importing sends the parsed rows to the API and shows the counts', async (t) => {
    const { window, doc } = loadAdmin(t);
    const file = new window.File([QUOTED_CSV], 'vehicles.csv', { type: 'text/csv' });
    const input = doc.getElementById('excelInput');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    doc.getElementById('importBtn').click();
    for (let i = 0; i < 60 && !window.__importBody; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.ok(window.__importBody, 'the CSV reaches the API');
    assert.equal(window.__importBody.society, 'Aangan', 'imports into the logged-in admin society');
    assert.equal(window.__importBody.rows.length, 2);
    assert.equal(window.__importBody.rows[0].vehicleNumber, 'GJ01AB1234');

    const report = doc.getElementById('import-report').textContent;
    assert.match(report, /Added 1/);
    assert.match(report, /Updated 1/);
    assert.match(report, /Duplicates skipped 1/);
    assert.match(report, /Rejected 0/);
    assert.match(report, /GJ01AB1234/);
    assert.match(report, /Already stored with the same details/);
    assert.match(doc.getElementById('modalMessage').textContent, /import complete/i);
});
