'use strict';
// Society spin counts in the master login.
//
// Regression: live spinStats documents look like
//   spinStats/aangan_2026-11-04 = { createdAt, date: "2026-11-04",
//                                   societyName: "Aangan", spinCount: 1 }
// i.e. they have NO societyId field. The endpoint used to query
// `where('societyId', '==', id)`, so those documents were invisible and the
// master page reported "Society data not found or invalid response." The scan
// must find them, and the repair endpoint must stamp the missing field.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createLocalStore } = require('../server/lib/local-store');

const root = path.join(__dirname, '..');

function dayKey(offsetDays = 0) {
    return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

async function startApi(t, seed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-spins-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file });
    await db.collection('societies').doc('aangan').set({ name: 'Aangan', flatList: ['A1-103'], spintodayNumber: 3 });
    await db.collection('societies').doc('other').set({ name: 'Other Society', flatList: ['C-1'] });
    if (seed) await seed(db);

    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'spin-stats-secret-'.repeat(4),
        DATA_BACKEND: 'local', AUTH_MODE: 'local',
        LOCAL_ADMIN_EMAIL: 'admin@local.test', LOCAL_ADMIN_PASSWORD: 'a-long-testing-password',
        LOCAL_ADMIN_ROLE: 'master',
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
        async stats(society = 'Aangan') {
            const res = await fetch(`${base}/api/contest/spinstats?societyName=${encodeURIComponent(society)}`, { headers });
            return { status: res.status, body: await res.json().catch(() => null) };
        },
        async backfill(society = 'Aangan') {
            const res = await fetch(base + '/api/contest/spinstats/backfill', {
                method: 'POST', headers, body: JSON.stringify({ societyName: society })
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        }
    };
}

test('legacy spin documents without societyId are counted (the live shape)', async (t) => {
    const api = await startApi(t, async (db) => {
        // Exactly the shapes visible in the Firebase console.
        await db.collection('spinStats').doc(`aangan_${dayKey(-30)}`).set({
            createdAt: new Date().toISOString(), date: dayKey(-30), societyName: 'Aangan', spinCount: 4
        });
        await db.collection('spinStats').doc(`aangan_${dayKey(0)}`).set({
            createdAt: new Date().toISOString(), date: dayKey(0), societyName: 'Aangan', spinCount: 2
        });
        await db.collection('spinStats').doc(`other society_${dayKey(0)}`).set({
            createdAt: new Date().toISOString(), date: dayKey(0), societyName: 'Other Society', spinCount: 9
        });
    });

    const result = await api.stats('Aangan');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.totalLifetimeSpins, 6, 'lifetime sums both days for Aangan only');
    assert.equal(result.body.totalDaySpins, 2);
    assert.equal(result.body.daysRecorded, 2);
    assert.equal(result.body.documentsMatched, 2);
    assert.ok(result.body.lastSpinDate, 'the last recorded day is reported');

    const other = await api.stats('Other Society');
    assert.equal(other.body.totalLifetimeSpins, 9, "another society's spins stay separate");
});

test('documents keyed by id only (no societyName, no societyId) still match', async (t) => {
    const api = await startApi(t, async (db) => {
        await db.collection('spinStats').doc(`aangan_${dayKey(-2)}`).set({ spinCount: 3 });
        await db.collection('spinStats').doc(`aangan_${dayKey(-1)}`).set({ spinCount: 1, date: dayKey(-1) });
    });
    const result = await api.stats('Aangan');
    assert.equal(result.body.totalLifetimeSpins, 4, 'the date is read back from the document id');
    assert.equal(result.body.daysRecorded, 2);
});

test('a society with no spins reports zeros instead of failing', async (t) => {
    const api = await startApi(t);
    const result = await api.stats('Aangan');
    assert.equal(result.status, 200);
    assert.equal(result.body.totalLifetimeSpins, 0);
    assert.equal(result.body.totalDaySpins, 0);
    assert.equal(result.body.daysRecorded, 0);
    assert.equal(result.body.winnerFlat, 'None yet');
});

test('a month total only counts the current month', async (t) => {
    const today = new Date();
    const inMonth = dayKey(0);
    const maybeLastMonth = dayKey(-40);
    const api = await startApi(t, async (db) => {
        await db.collection('spinStats').doc(`aangan_${inMonth}`).set({ date: inMonth, societyName: 'Aangan', spinCount: 5 });
        await db.collection('spinStats').doc(`aangan_${maybeLastMonth}`).set({ date: maybeLastMonth, societyName: 'Aangan', spinCount: 7 });
    });
    const result = await api.stats('Aangan');
    assert.equal(result.body.totalLifetimeSpins, 12);
    assert.equal(result.body.totalMonthSpins, 5);
    assert.equal(result.body.totalDaySpins, today.toISOString().slice(0, 10) === inMonth ? 5 : 0);
});

test('a duplicate document for the same day is not double counted', async (t) => {
    const api = await startApi(t, async (db) => {
        await db.collection('spinStats').doc(`aangan_${dayKey(-1)}`).set({ date: dayKey(-1), societyName: 'Aangan', spinCount: 3 });
        // A second doc that resolves to the same date (legacy casing).
        await db.collection('spinStats').doc(`aangan_${dayKey(-1)}_legacy`).set({ date: dayKey(-1), societyName: 'Aangan', spinCount: 2 });
    });
    const result = await api.stats('Aangan');
    assert.equal(result.body.daysRecorded, 1, 'one day, not two');
    assert.equal(result.body.totalLifetimeSpins, 3, 'the higher count for that day wins');
});

test('the repair endpoint stamps societyId onto legacy documents', async (t) => {
    const api = await startApi(t, async (db) => {
        await db.collection('spinStats').doc(`aangan_${dayKey(-3)}`).set({ date: dayKey(-3), societyName: 'Aangan', spinCount: 2 });
        await db.collection('spinStats').doc(`aangan_${dayKey(-2)}`).set({ date: dayKey(-2), societyName: 'Aangan', spinCount: 5 });
        await db.collection('spinStats').doc(`other society_${dayKey(-2)}`).set({ date: dayKey(-2), societyName: 'Other Society', spinCount: 8 });
    });

    const repaired = await api.backfill('Aangan');
    assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
    assert.equal(repaired.body.updated, 2, "only this society's legacy documents");

    // Documents that were invisible to the old query are now consistent, and the
    // counts are unchanged.
    const result = await api.stats('Aangan');
    assert.equal(result.body.totalLifetimeSpins, 7);
    assert.equal(result.body.daysRecorded, 2);

    const again = await api.backfill('Aangan');
    assert.equal(again.body.updated, 0, 'running it twice changes nothing');
});

test('the spin endpoint keeps writing the fields the master page needs', async (t) => {
    const api = await startApi(t, async (db) => {
        await db.collection('vehicles').doc('v-1').set({
            societyId: 'aangan', societyName: 'Aangan', flatNumber: 'A1-103',
            vehicleNumber: 'GJ01AB1234', vehicleType: '2-Wheeler', deviceId: 'dev-1'
        });
    });
    // spintodayNumber is 3 in the fixture, so the third spin wins.
    for (let i = 1; i <= 3; i += 1) {
        const res = await fetch(api.base + '/api/contest/spin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ societyName: 'Aangan', deviceId: 'dev-1', flatNumber: 'A1-103', contestId: `c${i}` })
        });
        const body = await res.json();
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.spinCount, i);
        assert.equal(body.won, i === 3, 'the winning ordinal comes from the society document');
    }

    // A fourth spin in the same contest is refused (one per contest per day)...
    const repeat = await fetch(api.base + '/api/contest/spin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ societyName: 'Aangan', deviceId: 'dev-1', flatNumber: 'A1-103', contestId: 'c1' })
    });
    assert.equal(repeat.status, 409);

    const result = await api.stats('Aangan');
    assert.equal(result.body.totalDaySpins, 3, 'the master page sees the live count');
    assert.equal(result.body.totalLifetimeSpins, 3);
    assert.equal(result.body.daysRecorded, 1);
});

// --- Browser side ---------------------------------------------------------
function loadAdminPage(t, responses = {}) {
    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/admin.html',
        runScripts: 'outside-only',
        beforeParse(win) { win.HTMLCanvasElement.prototype.getContext = () => null; win.confirm = () => true; }
    });
    const { window } = dom;
    const calls = [];
    window.OWL_API_BASE = 'https://api.test/api';
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        calls.push({ pathname: parsed.pathname, search: parsed.search, method: options.method || 'GET', headers: options.headers || {} });
        const key = Object.keys(responses).find(name => parsed.pathname.endsWith(name));
        if (key) return responses[key](parsed, options);
        return { ok: true, status: 200, json: async () => [] };
    };
    const source = fs.readFileSync(path.join(root, 'admin-logic.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^const API_BASE_URL = .*$/m, 'var API_BASE_URL = window.OWL_API_BASE;')
        .replace(/^const NG_HEADERS = .*$/m, 'var NG_HEADERS = {};')
        .replace('let assignedSociety = "";', 'var assignedSociety = "Aangan";')
        .replace('let isMasterAdminUser = false;', 'var isMasterAdminUser = true;');
    window.eval(`
        // Mirrors app.js: authenticatedFetch adds the ID token to every call.
        var authenticatedFetch = function (url, options) {
            var next = Object.assign({}, options || {});
            next.headers = Object.assign({}, next.headers, { Authorization: 'Bearer master-token' });
            return window.fetch(url, next);
        };
        var auth = { currentUser: { getIdToken: async () => 'master-token' } };
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

test('the Check spins button sends an authenticated request and renders the counts', async (t) => {
    const payload = {
        societyName: 'Aangan', totalLifetimeSpins: 12, totalSpins: 12,
        totalDaySpins: 4, totalMonthSpins: 7, daysRecorded: 3, winnerFlat: 'A1-104'
    };
    const { window, doc, calls } = loadAdminPage(t, {
        '/contest/spinstats': () => ({ ok: true, status: 200, json: async () => payload })
    });

    // No inline handler left behind: this used to throw ReferenceError.
    assert.equal(doc.getElementById('checkSpinsBtn').getAttribute('onclick'), null);
    assert.equal(typeof window.fetchSocietySpins, 'function', 'exposed for the page');

    doc.getElementById('adminSocietyQuery').value = 'Aangan';
    doc.getElementById('checkSpinsBtn').click();
    await new Promise(resolve => setTimeout(resolve, 120));

    const call = calls.find(entry => entry.pathname.endsWith('/contest/spinstats'));
    assert.ok(call, 'the endpoint was called');
    assert.match(call.search, /societyName=Aangan/);
    assert.equal(call.headers.Authorization, 'Bearer master-token', 'requireMaster needs the ID token');

    const text = doc.getElementById('spinStatsResult').textContent;
    assert.match(text, /12/, 'lifetime');
    assert.match(text, /Days recorded/);
    assert.match(text, /A1-104/);
    assert.match(text, /Latest winner flat/);
});

test('the page explains a rejected lookup instead of "invalid response"', async (t) => {
    for (const [status, expected] of [[401, /session expired/i], [403, /master administrator/i], [404, /No society named/i]]) {
        const { window, doc } = loadAdminPage(t, {
            '/contest/spinstats': () => ({ ok: false, status, json: async () => ({ error: 'nope' }) })
        });
        doc.getElementById('adminSocietyQuery').value = 'Aangan';
        window.fetchSocietySpins();
        await new Promise(resolve => setTimeout(resolve, 80));
        const text = doc.getElementById('spinStatsResult').textContent;
        assert.match(text, expected, `status ${status} → ${text}`);
        assert.doesNotMatch(text, /invalid response/);
    }
});

test('a society that has no spins says so', async (t) => {
    const { window, doc } = loadAdminPage(t, {
        '/contest/spinstats': () => ({
            ok: true, status: 200,
            json: async () => ({ societyName: 'Aangan', totalLifetimeSpins: 0, totalDaySpins: 0, totalMonthSpins: 0, daysRecorded: 0, winnerFlat: 'None yet' })
        })
    });
    doc.getElementById('adminSocietyQuery').value = 'Aangan';
    window.fetchSocietySpins();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.match(doc.getElementById('spinStatsResult').textContent, /No spins are recorded/);
});

test('Repair spin data posts the society and reloads the counts', async (t) => {
    let statsCalls = 0;
    const { window, doc, calls } = loadAdminPage(t, {
        '/contest/spinstats/backfill': () => ({ ok: true, status: 200, json: async () => ({ success: true, society: 'Aangan', updated: 2 }) }),
        '/contest/spinstats': () => {
            statsCalls += 1;
            return { ok: true, status: 200, json: async () => ({ societyName: 'Aangan', totalLifetimeSpins: 6, totalDaySpins: 0, totalMonthSpins: 0, daysRecorded: 2, winnerFlat: 'None yet' }) };
        }
    });
    doc.getElementById('adminSocietyQuery').value = 'Aangan';
    doc.getElementById('repairSpinsBtn').click();
    await new Promise(resolve => setTimeout(resolve, 150));

    const repair = calls.find(entry => entry.pathname.endsWith('/contest/spinstats/backfill'));
    assert.ok(repair, 'the repair endpoint was called');
    assert.equal(repair.method, 'POST');
    assert.equal(repair.headers.Authorization, 'Bearer master-token');
    assert.match(doc.getElementById('modalMessage').textContent, /repaired 2 spin document/);
    assert.equal(statsCalls, 1, 'the counts are fetched again afterwards');
});
