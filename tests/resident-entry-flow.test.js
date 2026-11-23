'use strict';
// Resident vehicle entry (entry.html -> POST /api/vehicles).
//
// Regression: "At least one vehicle number is required." appeared while the
// resident had typed one. Two causes, both covered here:
//   1. the API only understood `vehicles: [{ vehicleNumber }]`, so an array of
//      bare plates / `plate` / `vehicle_no` objects was parsed to nothing;
//   2. a society with no configured allowance produced no input fields at all
//      (`max2Wheeler || 0`), so an apparently filled form submitted nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createLocalStore } = require('../server/lib/local-store');

const root = path.join(__dirname, '..');

async function startApi(t, societyDoc = { name: 'Aangan', flatList: ['A1-103'], max2Wheeler: 2, max4Wheeler: 1 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-entry-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file });
    await db.collection('societies').doc('aangan').set(societyDoc);
    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'entry-flow-secret-'.repeat(4),
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
    return {
        base,
        async register(extra, { flat = 'A1-103', deviceId = 'dev-1' } = {}) {
            const res = await fetch(base + '/api/vehicles', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    societyName: 'Aangan', flatNumber: flat, residentType: 'Owner',
                    mobileNumber: '9000000000', deviceId, ...extra
                })
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        },
        async plates() {
            const res = await fetch(`${base}/api/vehicles?societyName=Aangan&flatNumber=A1-103&deviceId=dev-1`);
            const body = await res.json();
            return Array.isArray(body) ? body.map(row => row.vehicleNumber).sort() : body;
        }
    };
}

test('a single plate in any payload shape is accepted', async (t) => {
    // Generous allowances so this test is about payload shapes, not limits.
    const api = await startApi(t, { name: 'Aangan', flatList: ['A1-103'], max2Wheeler: 10, max4Wheeler: 10 });
    const shapes = [
        ['plain object array', { vehicles: [{ vehicleNumber: 'GJ01AB1234', vehicleType: '2-Wheeler' }] }],
        ['array of strings', { vehicles: ['GJ01CD5678'] }],
        ['plate key', { vehicles: [{ plate: 'GJ01EF9012', vehicleType: '2-Wheeler' }] }],
        ['vehicle_no key', { vehicles: [{ vehicle_no: 'GJ01GH3456', vehicleType: '2-Wheeler' }] }],
        ['single object', { vehicles: { vehicleNumber: 'GJ01IJ7890', vehicleType: '2-Wheeler' } }],
        ['JSON string', { vehicles: JSON.stringify([{ vehicleNumber: 'GJ01KL1234' }]) }],
        ['top-level plate', { vehicleNumber: 'GJ01MN5678', vehicleType: '2-Wheeler' }]
    ];
    for (const [label, payload] of shapes) {
        const result = await api.register(payload);
        assert.equal(result.status, 200, `${label} → ${JSON.stringify(result.body)}`);
    }
    assert.deepEqual(await api.plates(), [
        'GJ01AB1234', 'GJ01CD5678', 'GJ01EF9012', 'GJ01GH3456', 'GJ01IJ7890', 'GJ01KL1234', 'GJ01MN5678'
    ]);
});

test('an empty payload still gets the required message, with a code the page can act on', async (t) => {
    const api = await startApi(t);
    for (const payload of [{ vehicles: [] }, { vehicles: '' }, {}, { vehicles: [null, ''] }]) {
        const result = await api.register(payload);
        assert.equal(result.status, 400, JSON.stringify(payload));
        assert.equal(result.body.code, 'vehicle-number-required');
    }
});

test('the same plate twice in one request is registered once', async (t) => {
    const api = await startApi(t);
    const result = await api.register({ vehicles: ['GJ01ZZ9999', 'gj01zz9999'] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(await api.plates(), ['GJ01ZZ9999']);
});

test('a plate that is too short is rejected with a message, not a silent drop', async (t) => {
    const api = await startApi(t);
    const result = await api.register({ vehicles: ['GJ01'] });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /exactly 10 letters or digits/);
});

// --- Page ---------------------------------------------------------------
function loadEntry(t, societyDoc = { name: 'Aangan', flatList: ['A1-103'], max2Wheeler: 2, max4Wheeler: 1 }) {
    const html = fs.readFileSync(path.join(root, 'entry.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/entry.html?societyId=Aangan',
        runScripts: 'outside-only',
        beforeParse(win) { win.HTMLCanvasElement.prototype.getContext = () => null; }
    });
    const { window } = dom;
    const posts = [];
    window.OWL_API_BASE = 'https://api.test/api';
    // Minimal stand-in for the API so the page logic can be exercised exactly.
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        const json = body => ({ ok: true, status: 200, json: async () => body });
        if (parsed.pathname.endsWith('/auth/token')) return json({ token: 't' });
        if (parsed.pathname.endsWith('/societies')) {
            return json([{ id: 'aangan', name: 'Aangan', flatList: societyDoc.flatList, ...societyDoc }]);
        }
        if (parsed.pathname.endsWith('/admin-contact')) return { ok: false, status: 404, json: async () => ({}) };
        if (parsed.pathname.endsWith('/vehicles') && options.method === 'POST') {
            posts.push(JSON.parse(options.body));
            return { ok: false, status: 400, json: async () => ({ error: 'At least one vehicle number is required.', code: 'vehicle-number-required' }) };
        }
        if (parsed.pathname.endsWith('/vehicles')) return json([]);
        return json([]);
    };
    window.eval('var Device={getId:async()=>({identifier:"dev-1"})}; var API_BASE_URL=window.OWL_API_BASE; var NG_HEADERS={};');
    const inline = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])
        .filter(source => source.includes('getAuthHeaders'))
        .map(source => source.replace(/^\s*import .*$/gm, ''));
    window.eval(inline.join('\n'));
    t.after(() => { window.close(); });
    return { window, doc: window.document, posts };
}

async function chooseFlat(doc, flat = 'A1-103') {
    const select = doc.getElementById('flatSelect');
    select.value = flat;
    select.dispatchEvent(new doc.defaultView.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 40));
}

const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

test('a society with no configured allowance still offers the default fields', async (t) => {
    const { window, doc } = loadEntry(t, { name: 'Aangan', flatList: ['A1-103'] });
    await settle();
    await chooseFlat(doc);
    const fields = [...doc.querySelectorAll('.dynamic-vehicle-input')];
    assert.equal(fields.length, 3, '2 two-wheelers + 1 four-wheeler by default');
    assert.equal(doc.getElementById('submitBtn').style.display, 'none', 'hidden until something is typed');

    fields[0].value = 'GJ01AB1234';
    fields[0].dispatchEvent(new window.Event('input'));
    assert.equal(doc.getElementById('submitBtn').style.display, 'inline-block');
});

test('typing one plate submits it instead of asking for a vehicle number', async (t) => {
    const { window, doc, posts } = loadEntry(t);
    await settle();
    await chooseFlat(doc);
    doc.getElementById('mobileNumber').value = '9000000000';
    doc.getElementById('residentTypeSelect').value = 'Owner';
    const field = doc.querySelector('.dynamic-vehicle-input');
    field.value = 'GJ01AB1234';
    field.dispatchEvent(new window.Event('input'));
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(120);

    assert.equal(posts.length, 1, 'the form was submitted');
    assert.deepEqual([...posts[0].vehicles].map(v => ({ ...v })), [{ vehicleNumber: 'GJ01AB1234', vehicleType: '2-Wheeler' }]);
    // The stub answers 400/vehicle-number-required; the page must reframe it
    // rather than showing a bare server error.
    assert.match(doc.getElementById('modalMessage').textContent, /enter at least one vehicle number/i);
});

test('a half-typed plate names the plate instead of failing silently', async (t) => {
    const { window, doc, posts } = loadEntry(t);
    await settle();
    await chooseFlat(doc);
    doc.getElementById('mobileNumber').value = '9000000000';
    const field = doc.querySelector('.dynamic-vehicle-input');
    field.value = 'GJ01AB';
    field.dispatchEvent(new window.Event('input'));
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(80);

    assert.equal(posts.length, 0, 'nothing is sent');
    assert.match(doc.getElementById('modalMessage').textContent, /GJ01AB/);
    assert.match(doc.getElementById('modalMessage').textContent, /10 characters/);
});

test('a flat with no allowance left explains itself and cannot submit', async (t) => {
    const { window, doc, posts } = loadEntry(t, { name: 'Aangan', flatList: ['A1-103'], max2Wheeler: 0, max4Wheeler: 0 });
    await settle();
    await chooseFlat(doc);
    assert.equal(doc.querySelectorAll('.dynamic-vehicle-input').length, 0, 'no fields to fill');
    assert.equal(doc.getElementById('submitBtn').style.display, 'none', 'no submit button either');

    doc.getElementById('mobileNumber').value = '9000000000';
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(80);
    assert.equal(posts.length, 0, 'an empty form is not posted');
    assert.match(doc.getElementById('modalMessage').textContent, /no vehicle allowance left/i);
});
