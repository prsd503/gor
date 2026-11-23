'use strict';
// Bulk vehicle delete from a CSV: the admin (including the master login) picks a
// file, confirms, and every vehicle in the file that belongs to the assigned
// society is deleted with a per-vehicle report.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createLocalStore } = require('../server/lib/local-store');

const root = path.join(__dirname, '..');

async function startApi(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-bulk-delete-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file });
    await db.collection('societies').doc('aangan').set({ name: 'Aangan', flatList: ['A1-103', 'A1-104'] });
    await db.collection('societies').doc('other').set({ name: 'Other', flatList: ['C-1'] });
    const vehicle = (id, plate, society, societyId, flat, extra = {}) =>
        db.collection('vehicles').doc(id).set({
            societyName: society, ...(societyId ? { societyId } : {}), flatNumber: flat,
            mobileNumber: '9000000000', residentType: 'Owner', vehicleNumber: plate,
            vehicleType: '2-Wheeler', deviceId: null, ...extra
        });
    await vehicle('a-1', 'GJ01AB1234', 'Aangan', 'aangan', 'A1-103');
    await vehicle('a-2', 'GJ01CD5678', 'Aangan', 'aangan', 'A1-104');
    await vehicle('a-3', 'GJ01EF9012', 'Aangan', 'aangan', 'A1-104');
    await vehicle('o-1', 'GJ02XY0001', 'Other', 'other', 'C-1');

    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'vehicle-bulk-delete-secret-'.repeat(3),
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
        async bulkDelete(plates, society = 'Aangan') {
            const res = await fetch(base + '/api/vehicles/bulk-delete', {
                method: 'POST', headers, body: JSON.stringify({ society, plates })
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        },
        async vehicles(society = 'Aangan') {
            const res = await fetch(`${base}/api/vehicles?societyName=${encodeURIComponent(society)}`, { headers });
            return res.json();
        }
    };
}

test('bulk delete removes the listed vehicles and reports deleted and not-found plates', async (t) => {
    const api = await startApi(t);
    const result = await api.bulkDelete(['gj01ab1234', 'GJ01CD5678', 'GJ99ZZ0000', '']);

    assert.equal(result.status, 200, JSON.stringify(result.body));
    const summary = result.body;
    assert.equal(summary.society, 'Aangan');
    assert.equal(summary.requested, 3, 'blank cells are not counted as requests');
    assert.equal(summary.deleted, 2);
    assert.equal(summary.notFound, 1);
    assert.equal(summary.skipped, 1);
    assert.deepEqual(summary.missing, ['GJ99ZZ0000']);

    const actionFor = plate => summary.plates.find(row => row.plate === plate);
    assert.equal(actionFor('GJ01AB1234').action, 'deleted');
    assert.equal(actionFor('GJ01CD5678').action, 'deleted');
    assert.equal(actionFor('GJ99ZZ0000').action, 'notFound');
    assert.match(actionFor('GJ99ZZ0000').reason, /Not registered in Aangan/);

    const remaining = await api.vehicles('Aangan');
    assert.deepEqual(remaining.map(v => v.vehicleNumber), ['GJ01EF9012'], 'only the unlisted vehicle stays');

    // Another society's record was never touched.
    const other = await api.vehicles('Other');
    assert.deepEqual(other.map(v => v.vehicleNumber), ['GJ02XY0001']);

    // Deleting the same list again is safe and reports everything as missing.
    const again = await api.bulkDelete(['GJ01AB1234', 'GJ01CD5678']);
    assert.equal(again.body.deleted, 0);
    assert.equal(again.body.notFound, 2);
});

test('a plate listed twice is reported once, and duplicates are skipped', async (t) => {
    const api = await startApi(t);
    const result = await api.bulkDelete(['GJ01EF9012', 'GJ01EF9012', 'GJ01EF9012']);
    assert.equal(result.body.deleted, 1);
    assert.equal(result.body.skipped, 2);
    assert.equal(result.body.plates.filter(row => row.action === 'deleted').length, 1);
    assert.equal((await api.vehicles('Aangan')).some(v => v.vehicleNumber === 'GJ01EF9012'), false);
});

test('bulk delete refuses an empty list', async (t) => {
    const api = await startApi(t);
    const empty = await api.bulkDelete([]);
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /no vehicle numbers/i);
});

// --- Browser side ---------------------------------------------------------
function loadAdmin(t) {
    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/admin.html',
        runScripts: 'outside-only',
        beforeParse(win) {
            win.HTMLCanvasElement.prototype.getContext = () => null;
            win.__confirms = [];
            win.confirm = message => { win.__confirms.push(String(message)); return true; };
        }
    });
    const { window } = dom;
    const calls = [];
    window.OWL_API_BASE = 'https://api.test/api';
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        calls.push({ url: parsed, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
        if (parsed.pathname.endsWith('/config')) return { ok: true, json: async () => ({ teamPhone: '917567184961' }) };
        if (parsed.pathname.endsWith('/vehicles/bulk-delete')) {
            window.__deleteBody = JSON.parse(options.body);
            return {
                ok: true, json: async () => ({
                    success: true, society: 'Aangan', requested: 3, deleted: 2, notFound: 1, skipped: 0, failed: 0,
                    plates: [
                        { plate: 'GJ01AB1234', action: 'deleted' },
                        { plate: 'GJ01CD5678', action: 'deleted' },
                        { plate: 'GJ99ZZ0000', action: 'notFound', reason: 'Not registered in Aangan.' }
                    ],
                    missing: ['GJ99ZZ0000'], errors: []
                })
            };
        }
        return { ok: true, json: async () => [] };
    };
    const source = fs.readFileSync(path.join(root, 'admin-logic.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^const API_BASE_URL = .*$/m, 'var API_BASE_URL = window.OWL_API_BASE;')
        .replace(/^const NG_HEADERS = .*$/m, 'var NG_HEADERS = {};')
        .replace('let assignedSociety = "";', 'var assignedSociety = "Aangan";')
        .replace('let isMasterAdminUser = false;', 'var isMasterAdminUser = true;');
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

const DELETE_CSV = 'VehicleNumber\nGJ01AB1234\ngj01cd5678\nGJ99ZZ0000\n';

test('the template/export CSV first column is read as the plate list', (t) => {
    const { window } = loadAdmin(t);
    const plates = window.OwAdminVehicles.parseVehiclePlateCsv(
        'VehicleNumber,FlatNumber/Name\r\n"GJ01AB1234","A1-103"\r\nGJ01CD5678,A1-104\r\n\r\nGJ01AB1234,A1-103\r\n'
    );
    assert.deepEqual([...plates], ['GJ01AB1234', 'GJ01CD5678'], 'header, blanks and repeats are dropped');
});

test('bulk delete confirms, deletes once through the API and shows the result', async (t) => {
    const { window, doc } = loadAdmin(t);
    const file = new window.File([DELETE_CSV], 'delete.csv', { type: 'text/csv' });
    Object.defineProperty(doc.getElementById('excelInput'), 'files', { value: [file], configurable: true });

    doc.getElementById('bulkDeleteTopBtn').click();
    for (let i = 0; i < 60 && !window.__deleteBody; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.ok(window.__deleteBody, 'the plates reach the API');
    assert.equal(window.__deleteBody.society, 'Aangan');
    assert.deepEqual([...window.__deleteBody.plates], ['GJ01AB1234', 'GJ01CD5678', 'GJ99ZZ0000']);
    assert.match(window.__confirms[0], /Delete every vehicle listed in "delete\.csv" from Aangan/);

    const report = doc.getElementById('bulk-delete-report').textContent;
    assert.match(report, /Deleted 2/);
    assert.match(report, /Not found 1/);
    assert.match(report, /GJ01AB1234/);
    assert.match(report, /GJ99ZZ0000/);

    const modal = doc.getElementById('modalMessage').textContent;
    assert.match(modal, /bulk delete complete/i);
    assert.match(modal, /Deleted 2 of 3 vehicle\(s\)/);
    assert.match(modal, /not found 1/);
});

test('the master danger-zone button uses the same working flow', async (t) => {
    const { window, doc } = loadAdmin(t);
    // The master login reveals this section; confirm it is wired at all.
    const source = fs.readFileSync(path.join(root, 'admin-logic.js'), 'utf8');
    assert.match(source, /getElementById\('bulkDeleteBtn'\)\?\.addEventListener\('click', runBulkVehicleDelete\)/);
    assert.match(source, /getElementById\('bulkDeleteTopBtn'\)\?\.addEventListener\('click', runBulkVehicleDelete\)/);
    assert.equal(doc.getElementById('bulkDeleteBtn').getAttribute('onclick'), null, 'no broken inline handler');

    const file = new window.File([DELETE_CSV], 'delete.csv', { type: 'text/csv' });
    Object.defineProperty(doc.getElementById('excelInput'), 'files', { value: [file], configurable: true });
    doc.getElementById('bulkDeleteBtn').click();
    for (let i = 0; i < 60 && !window.__deleteBody; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(window.__deleteBody, 'the danger-zone button also reaches the API');
});

test('cancelling the confirmation deletes nothing', async (t) => {
    const { window, doc } = loadAdmin(t);
    window.confirm = () => false;
    const file = new window.File([DELETE_CSV], 'delete.csv', { type: 'text/csv' });
    Object.defineProperty(doc.getElementById('excelInput'), 'files', { value: [file], configurable: true });
    doc.getElementById('bulkDeleteTopBtn').click();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(window.__deleteBody, undefined, 'nothing is sent');
});

test('a missing file is reported instead of silently doing nothing', async (t) => {
    const { window, doc } = loadAdmin(t);
    Object.defineProperty(doc.getElementById('excelInput'), 'files', { value: [], configurable: true });
    doc.getElementById('bulkDeleteTopBtn').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(doc.getElementById('modalMessage').textContent, /Choose the CSV file/i);
});
