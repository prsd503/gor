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
        base, db, file,
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
        async raw(contentType, body) {
            const res = await fetch(base + '/api/vehicles', {
                method: 'POST', headers: { 'Content-Type': contentType }, body
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

test('resident can register a typed flat or name when the society has no list, with device and allowance checks intact', async t => {
    const api = await startApi(t, { name: 'Aangan', flatList: [], max2Wheeler: 1, max4Wheeler: 0 });
    const result = await api.register({ vehicles: ['GJ01AB1234'] }, { flat: '  Shanti Villa  ', deviceId: 'dev-1' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const rows = await createLocalStore({file: api.file}).collection('vehicles').get();
    assert.equal(rows.docs[0].data().flatNumber, 'Shanti Villa');
    assert.equal(rows.docs[0].data().societyId, 'aangan');
    const otherDevice = await api.register({ vehicles: ['GJ01CD5678'] }, { flat: 'SHANTI VILLA', deviceId: 'dev-2' });
    assert.notEqual(otherDevice.status, 200, 'device restrictions are still enforced');
    const otherFlat = await api.register({ vehicles: ['GJ01EF5678'] }, { flat: 'Another home', deviceId: 'dev-1' });
    assert.notEqual(otherFlat.status, 200, 'a device cannot register another flat');
    const second = await api.register({ vehicles: ['GJ01GH5678'] }, { flat: 'Shanti Villa', deviceId: 'dev-1' });
    assert.notEqual(second.status, 200, 'the per-flat allowance is enforced');
});

test('resident cannot bypass a configured flat list', async t => {
    const api = await startApi(t);
    const result = await api.register({ vehicles: ['GJ01AB1234'] }, { flat: 'Unknown', deviceId: 'dev-1' });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /not registered/);
    assert.equal((await api.db.collection('vehicles').get()).size, 0);
});

// --- Page ---------------------------------------------------------------
function loadEntry(t, societyDoc = { name: 'Aangan', flatList: ['A1-103'], max2Wheeler: 2, max4Wheeler: 1 }, options = {}) {
    const html = fs.readFileSync(path.join(root, 'entry.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/entry.html?societyId=Aangan',
        runScripts: 'outside-only',
        beforeParse(win) { win.HTMLCanvasElement.prototype.getContext = () => null; }
    });
    const { window } = dom;
    const posts = [];
    const authCalls = [];
    window.OWL_API_BASE = 'https://api.test/api';
    if (options.idToken) window.OWL_GET_ID_TOKEN = async () => options.idToken;
    // Minimal stand-in for the API so the page logic can be exercised exactly.
    window.fetch = async (url, init = {}) => {
        const parsed = new URL(String(url), window.location.href);
        const json = body => ({ ok: true, status: 200, json: async () => body });
        if (parsed.pathname.endsWith('/auth/token')) {
            authCalls.push({ headers: init.headers || {}, body: init.body });
            return options.authRejects
                ? { ok: false, status: 400, json: async () => ({ error: 'Firebase ID token is required' }) }
                : json({ token: 't' });
        }
        if (parsed.pathname.endsWith('/societies')) {
            return json([{ id: 'aangan', name: 'Aangan', flatList: societyDoc.flatList, ...societyDoc }]);
        }
        if (parsed.pathname.endsWith('/admin-contact')) return { ok: false, status: 404, json: async () => ({}) };
        if (parsed.pathname.endsWith('/vehicles') && init.method === 'POST') {
            posts.push({ body: JSON.parse(init.body), headers: init.headers || {} });
            const reply = options.postReply ||
                { status: 400, body: { error: 'At least one vehicle number is required.', code: 'vehicle-number-required' } };
            return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
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
    return { window, doc: window.document, posts, authCalls };
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
    const { window, doc, posts } = loadEntry(t, undefined, {
        postReply: { status: 200, body: { success: true } }
    });
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
    assert.deepEqual([...posts[0].body.vehicles].map(v => ({ ...v })), [{ vehicleNumber: 'GJ01AB1234', vehicleType: '2-Wheeler' }]);
    assert.match(doc.getElementById('modalMessage').textContent, /registered successfully/i);
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

// --- The 2026-11 production report -------------------------------------
// On prsd503.github.io a typed plate still produced "At least one vehicle
// number is required." DevTools showed `POST /api/auth/token` -> 400 and the
// vehicle POST leaving without a Content-Type, so the plate never arrived in a
// form the API could read. These three tests pin that down.

test('a failed token lookup still posts the plate as JSON, with a Content-Type', async (t) => {
    // An ID token provider that throws stands in for a Firebase session that has
    // expired: the exchange fails, and the vehicle POST must still be JSON.
    const { window, doc, posts, authCalls } = loadEntry(t, undefined, {
        idToken: 'stale', authRejects: true
    });
    await settle();
    await chooseFlat(doc);
    doc.getElementById('mobileNumber').value = '9000000000';
    doc.getElementById('residentTypeSelect').value = 'Owner';
    const field = doc.querySelector('.dynamic-vehicle-input');
    field.value = 'GJ01AB1234';
    field.dispatchEvent(new window.Event('input'));
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(120);

    assert.ok(authCalls.length >= 1, 'the token was requested');
    for (const call of authCalls) {
        assert.equal(call.headers['Content-Type'], 'application/json', 'every token call is JSON');
    }
    assert.equal(posts.length, 1);
    assert.equal(posts[0].headers['Content-Type'], 'application/json',
        'a failed token must not change the wire format of the vehicle POST');
    assert.equal(posts[0].headers.Authorization, undefined, 'no token, no bearer header');
    assert.deepEqual([...posts[0].body.vehicles], [{ vehicleNumber: 'GJ01AB1234', vehicleType: '2-Wheeler' }]);
});

test('a Firebase ID token is exchanged for an API token and sent as a bearer header', async (t) => {
    const { window, doc, posts, authCalls } = loadEntry(t, undefined, { idToken: 'firebase-id-token' });
    await settle();
    await chooseFlat(doc);
    doc.getElementById('mobileNumber').value = '9000000000';
    doc.getElementById('residentTypeSelect').value = 'Owner';
    const field = doc.querySelector('.dynamic-vehicle-input');
    field.value = 'GJ01AB1234';
    field.dispatchEvent(new window.Event('input'));
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(120);

    assert.equal(JSON.parse(authCalls[0].body).idToken, 'firebase-id-token', 'the page sent an idToken');
    assert.equal(posts[0].headers.Authorization, 'Bearer t');
});

test('a plate error for a plate the page sent names the plate instead of denying it', async (t) => {
    // Default stub replies 400/vehicle-number-required. The page checked the
    // field itself, so that answer means the body was lost in transit; it must
    // not tell the resident to type a number they already typed.
    const { window, doc } = loadEntry(t);
    await settle();
    await chooseFlat(doc);
    doc.getElementById('mobileNumber').value = '9000000000';
    doc.getElementById('residentTypeSelect').value = 'Owner';
    const field = doc.querySelector('.dynamic-vehicle-input');
    field.value = 'GJ01AB1234';
    field.dispatchEvent(new window.Event('input'));
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(120);

    const message = doc.getElementById('modalMessage').textContent;
    assert.match(message, /GJ01AB1234/, 'the plate the resident typed is echoed back');
    assert.match(message, /could not send|check your connection/i);
    assert.doesNotMatch(message, /enter at least one vehicle number/i);
});

test('a plate sent as a multipart form is not answered with "no vehicle number"', async (t) => {
    // A visitor form (or a client that cannot set JSON headers) posts multipart,
    // which this server does not parse. The plate is missing from `req.body`, so
    // the honest answer is "the details did not reach the server" — not a message
    // accusing the resident of leaving the plate blank.
    const api = await startApi(t);
    const form = new FormData();
    form.set('societyName', 'Aangan');
    form.set('flatNumber', 'A1-103');
    form.set('residentType', 'Owner');
    form.set('mobileNumber', '9000000000');
    form.set('deviceId', 'dev-1');
    form.set('vehicles', JSON.stringify([{ vehicleNumber: 'GJ01MP1111', vehicleType: '2-Wheeler' }]));
    const res = await fetch(api.base + '/api/vehicles', { method: 'POST', body: form });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, 'unreadable-body', JSON.stringify(body));
    assert.doesNotMatch(body.error, /at least one vehicle number/i);
});

test('a JSON plate body is accepted even when the browser labels it text/plain', async (t) => {
    // This is exactly what Safari sends once the page loses its Content-Type
    // header: a JSON string in a text/plain body. It must still register.
    const api = await startApi(t);
    const payload = JSON.stringify({
        societyName: 'Aangan', flatNumber: 'A1-103', residentType: 'Owner',
        mobileNumber: '9000000000', deviceId: 'dev-1',
        vehicles: [{ vehicleNumber: 'GJ01TP2222', vehicleType: '2-Wheeler' }]
    });
    const res = await fetch(api.base + '/api/vehicles', {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: payload
    });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(await api.plates(), ['GJ01TP2222']);
});

test('a truly empty body is a plate error, not a transport error', async (t) => {
    const api = await startApi(t);
    const result = await api.raw('application/json', '');
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'vehicle-number-required');
    assert.equal(result.body.field, 'vehicles');
});

test('a host page with no Firebase session does not call the token endpoint at all', async (t) => {
    // Without an `OWL_GET_ID_TOKEN` provider the exchange can only answer 400,
    // so the page must skip it and rely on the public resident endpoints.
    const { window, doc, posts, authCalls } = loadEntry(t, undefined, {
        postReply: { status: 200, body: { success: true } }
    });
    await settle();
    await chooseFlat(doc);
    assert.equal(authCalls.length, 0, 'flat lookup did not ask for a token');
    doc.getElementById('mobileNumber').value = '9000000000';
    doc.getElementById('residentTypeSelect').value = 'Owner';
    const field = doc.querySelector('.dynamic-vehicle-input');
    field.value = 'GJ01AB1234';
    field.dispatchEvent(new window.Event('input'));
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(120);
    assert.equal(authCalls.length, 0, 'submit did not ask for a token either');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].headers['Content-Type'], 'application/json');
});


test('with no configured flat list, residents type a name and submit it', async t => {
    const { window, doc, posts } = loadEntry(t, { name: 'Aangan', flatList: [] }, { postReply: { status: 200, body: { success: true } } });
    await settle();
    const select = doc.getElementById('flatSelect');
    const input = doc.getElementById('flatInput');
    assert.equal(select.disabled, true);
    assert.equal(select.style.display, 'none');
    assert.equal(input.disabled, false);
    assert.equal(input.required, true);
    input.value = '  Shanti Villa  ';
    input.dispatchEvent(new window.Event('input'));
    await settle(430);
    assert.equal(doc.querySelectorAll('.dynamic-vehicle-input').length, 3);
    doc.getElementById('residentTypeSelect').value = 'Owner';
    doc.getElementById('mobileNumber').value = '9000000000';
    const plate = doc.querySelector('.dynamic-vehicle-input');
    plate.value = 'GJ01AB1234';
    plate.dispatchEvent(new window.Event('input'));
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(120);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.flatNumber, 'Shanti Villa');
});


test('the resident sees the society-wide cap explanation when registration is refused', async t => {
    const { window, doc, posts } = loadEntry(t, undefined, {
        postReply:{status:409, body:{code:'society-vehicle-limit-reached', error:'This society has reached its total vehicle limit of 3. Contact the master administrator.'}}
    });
    await settle();
    await chooseFlat(doc);
    doc.getElementById('mobileNumber').value = '9000000000';
    doc.getElementById('residentTypeSelect').value = 'Owner';
    const plate = doc.querySelector('.dynamic-vehicle-input');
    plate.value = 'GJ01AB1234';
    plate.dispatchEvent(new window.Event('input'));
    doc.getElementById('vehicleForm').dispatchEvent(new window.Event('submit'));
    await settle(120);
    assert.equal(posts.length, 1);
    assert.match(doc.getElementById('modalMessage').textContent, /total vehicle limit of 3/i);
});
