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
const { istDate } = require('../server/lib/notices');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');

function dayKey(offsetDays = 0) {
    return istDate(new Date(Date.now() + offsetDays * 86400000));
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
        db, liveDb: app.dataLayer.db, headers, base,
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
    assert.equal(result.body.totalDaySpins, 0, 'legacy UTC aggregates are not claimed as IST-day totals');
    assert.equal(result.body.legacySpins, 6);
    assert.equal(result.body.daysRecorded, 0);
    assert.equal(result.body.legacyDaysRecorded, 2);
    assert.equal(result.body.documentsMatched, 2);
    assert.ok(result.body.lastLegacySpinDate, 'the last historical day is reported');

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
    assert.equal(result.body.legacyDaysRecorded, 2);
    assert.equal(result.body.daysRecorded, 0);
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
        await db.collection('spinStats').doc(`aangan_ist_${inMonth}`).set({ date: inMonth, timeZone: 'Asia/Kolkata', societyName: 'Aangan', spinCount: 5 });
        await db.collection('spinStats').doc(`aangan_ist_${maybeLastMonth}`).set({ date: maybeLastMonth, timeZone: 'Asia/Kolkata', societyName: 'Aangan', spinCount: 7 });
    });
    const result = await api.stats('Aangan');
    assert.equal(result.body.totalLifetimeSpins, 12);
    assert.equal(result.body.totalMonthSpins, 5);
    assert.equal(result.body.totalDaySpins, istDate(today) === inMonth ? 5 : 0);
});

test('a duplicate document for the same day is not double counted', async (t) => {
    const api = await startApi(t, async (db) => {
        await db.collection('spinStats').doc(`aangan_${dayKey(-1)}`).set({ date: dayKey(-1), societyName: 'Aangan', spinCount: 3 });
        // A second doc that resolves to the same date (legacy casing).
        await db.collection('spinStats').doc(`aangan_${dayKey(-1)}_legacy`).set({ date: dayKey(-1), societyName: 'Aangan', spinCount: 2 });
    });
    const result = await api.stats('Aangan');
    assert.equal(result.body.legacyDaysRecorded, 1, 'one historical day, not two');
    assert.equal(result.body.daysRecorded, 0);
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
    assert.equal(result.body.legacyDaysRecorded, 2);
    assert.equal(result.body.daysRecorded, 0);

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
    const saved = await createLocalStore({ file: api.db.file }).collection('spinStats').doc(`aangan_ist_${dayKey()}`).get();
    assert.equal(saved.data().timeZone, 'Asia/Kolkata');
});

// --- Browser side ---------------------------------------------------------
function loadAdminPage(t, responses = {}) {
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
        totalDaySpins: 4, totalMonthSpins: 7, daysRecorded: 3, winnerFlat: 'A1-104', lastIstSpinDate: '2026-11-25', legacySpins: 2, lastLegacySpinDate: '2026-11-04'
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
    assert.match(text, /Spins today \(IST\)/);
    assert.match(text, /This month \(IST\)/);
    assert.match(text, /Last IST spin recorded: 2026-11-25/);
    assert.match(text, /historical spin.*lifetime totals only/);
    assert.doesNotMatch(text, /UTC days/);
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
    for (let i = 0; i < 20 && doc.getElementById('customModal').style.display !== 'block'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(doc.getElementById('customModal').style.display, 'block', 'repairing asks for confirmation in the in-page dialog');
    window.runConfirmAction(); // the dialog's confirm button
    await new Promise(resolve => setTimeout(resolve, 150));

    const repair = calls.find(entry => entry.pathname.endsWith('/contest/spinstats/backfill'));
    assert.ok(repair, 'the repair endpoint was called');
    assert.equal(repair.method, 'POST');
    assert.equal(repair.headers.Authorization, 'Bearer master-token');
    assert.match(doc.getElementById('modalMessage').textContent, /repaired 2 spin document/);
    assert.equal(statsCalls, 1, 'the counts are fetched again afterwards');
});

test('IST day and month counts change at IST midnight, keeping legacy totals separate', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T18:29:59Z') });
    const api = await startApi(t, async db => {
        await db.collection('spinStats').doc('aangan_2026-12-31').set({ date:'2026-12-31', societyName:'Aangan', spinCount:5 });
        await db.collection('spinStats').doc('aangan_ist_2026-12-31').set({ date:'2026-12-31', societyName:'Aangan', timeZone:'Asia/Kolkata', spinCount:3 });
        await db.collection('spinStats').doc('aangan_ist_2027-01-01').set({ date:'2027-01-01', societyName:'Aangan', timeZone:'Asia/Kolkata', spinCount:2 });
    });
    const before = (await api.stats()).body;
    assert.equal(before.totalDaySpins, 3);
    assert.equal(before.totalMonthSpins, 3);
    assert.equal(before.totalLifetimeSpins, 10);
    assert.equal(before.legacySpins, 5);
    t.mock.timers.setTime(new Date('2026-12-31T18:30:00Z').getTime());
    const after = (await api.stats()).body;
    assert.equal(after.totalDaySpins, 2);
    assert.equal(after.totalMonthSpins, 2);
    assert.equal(after.totalLifetimeSpins, 10);
    assert.equal(after.timeZone, 'Asia/Kolkata');
});

test('spin buckets and repeat prevention roll over exactly at midnight IST', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-24T18:29:59Z') });
    const api = await startApi(t, async db => {
        await db.collection('vehicles').doc('v').set({ societyId:'aangan', flatNumber:'A1-103', deviceId:'dev-1' });
    });
    const spin = () => fetch(api.base + '/api/contest/spin', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ societyName:'Aangan', deviceId:'dev-1', flatNumber:'A1-103', contestId:'midnight-test' })
    });
    const before = await spin();
    assert.equal(before.status, 200, await before.text());
    assert.equal((await spin()).status, 409);
    t.mock.timers.setTime(new Date('2026-11-24T18:30:00Z').getTime());
    const after = await spin();
    assert.equal(after.status, 200, await after.text());
    assert.equal((await spin()).status, 409);
    const db = createLocalStore({file:api.db.file});
    assert.equal((await db.collection('spinStats').doc('aangan_ist_2026-11-24').get()).data().spinCount, 1);
    assert.equal((await db.collection('spinStats').doc('aangan_ist_2026-11-25').get()).data().spinCount, 1);
    const stats = (await api.stats()).body;
    assert.equal(stats.totalDaySpins, 1);
    assert.equal(stats.totalLifetimeSpins, 2);
});

test('legacy UTC attempts still prevent duplicate spins and winning attempts can be claimed', async t => {
    t.mock.timers.enable({ apis:['Date'], now:new Date('2026-11-24T19:00:00Z') });
    const hash = contest => crypto.createHash('sha256').update(['aangan','2026-11-24','dev-1',contest].join('\\0')).digest('hex');
    const api = await startApi(t, async db => {
        await db.collection('vehicles').doc('v').set({ societyId:'aangan', flatNumber:'A1-103', deviceId:'dev-1' });
        await db.collection('contestAttempts').doc(hash('same-day')).set({ date:'2026-11-24', createdAt:'2026-11-24T18:45:00Z', flatNumber:'A1-103', won:false });
        await db.collection('contestAttempts').doc(hash('prior-day')).set({ date:'2026-11-24', createdAt:'2026-11-24T18:00:00Z', flatNumber:'A1-103', won:false });
        await db.collection('contestAttempts').doc(hash('win')).set({ date:'2026-11-24', createdAt:'2026-11-24T18:45:00Z', flatNumber:'A1-103', won:true, claimed:false });
    });
    const post = (route, contestId) => fetch(api.base + route, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ societyName:'Aangan', deviceId:'dev-1', flatNumber:'A1-103', contestId })
    });
    assert.equal((await post('/api/contest/spin', 'same-day')).status, 409);
    assert.equal((await post('/api/contest/spin', 'prior-day')).status, 200, 'a previous IST-day attempt does not block today');
    assert.equal((await post('/api/contest/winner', 'win')).status, 200);
    assert.equal((await post('/api/contest/winner', 'win')).status, 409);
});

test('legacy attempt timestamp handling fails closed if time is unknown', () => {
    const { isSameIstDay } = require('../server/lib/spin-dates');
    assert.equal(isSameIstDay({}, '2026-11-25'), true);
    assert.equal(isSameIstDay({ createdAt: '2026-11-24T18:29:59Z' }, '2026-11-25'), false);
    assert.equal(isSameIstDay({ createdAt: { toDate: () => new Date('2026-11-24T18:30:00Z') } }, '2026-11-25'), true);
    assert.equal(isSameIstDay({ timeZone:'Asia/Kolkata', date:'2026-11-24' }, '2026-11-25'), false);
});

test('guest spin stores only latest code and preserves daily retry behavior', async t => {
    const api = await startApi(t, async db => {
        await db.collection('societies').doc('Guest').set({ spintodayNumber: 1, uniqueCode: '100000000' });
        await db.collection('configs').doc('owlwatcher').set({ teamPhone: '+91 90334 06816' });
        await db.collection('vehicles').doc('registered').set({ societyId: 'aangan', flatNumber: 'A1-103', deviceId: 'registered-device' });
    });
    const call = async (body) => {
        const res = await fetch(api.base + '/api/contest/guest/spin', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    const player = { deviceId: 'guest-1', contestId: 'contest' };
    const random = t.mock.method(crypto, 'randomInt', (() => { const codes = [100000000, 200000000]; return () => codes.shift(); })());
    const win = await call(player);
    random.mock.restore();
    assert.equal(win.status, 200, JSON.stringify(win.body));
    assert.equal(win.body.won, true);
    assert.equal(win.body.winningCode, '200000000', 'latest existing code is not reused');
    const repeat = await call(player);
    assert.equal(repeat.body.winningCode, win.body.winningCode);
    assert.equal(repeat.body.spinCount, 1);
    assert.equal(repeat.body.alreadyPlayed, true);
    assert.equal((await api.liveDb.collection('societies').doc('Guest').get()).data().uniqueCode, win.body.winningCode);
    const attempt = (await api.liveDb.collection('contestAttempts').doc(win.body.attemptId).get()).data();
    assert.equal(Object.hasOwn(attempt, 'winningCode'), false, 'attempt record does not retain code');
    assert.equal((await api.liveDb.collection('guestWinners').get()).size, 0);
    assert.equal((await api.liveDb.collection('contestQuizAttempts').get()).size, 0);
    const rejected = await call({ deviceId: 'registered-device', contestId: 'contest' });
    assert.equal(rejected.status, 403);
    assert.match(rejected.body.error, /registered/i);

    await api.liveDb.collection('societies').doc('Guest').set({ spintodayNumber: 2 }, { merge: true });
    const player2 = { deviceId: 'guest-2', contestId: 'contest' };
    const concurrent = await Promise.all([call(player2), call(player2)]);
    assert.equal(concurrent[0].body.winningCode, concurrent[1].body.winningCode);
    assert.notEqual(concurrent[0].body.winningCode, win.body.winningCode);
    assert.equal((await api.liveDb.collection('societies').doc('Guest').get()).data().uniqueCode, concurrent[0].body.winningCode);
    assert.equal((await call(player)).body.winningCode, null, 'old spin never returns a newer guest’s code');
    assert.equal((await api.liveDb.collection('guestWinners').get()).size, 0);
});
